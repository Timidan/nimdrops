import { serve } from '@hono/node-server'
import { readOnlyNimiqChainFromEnv } from './chain/nimiq'
import { errorMessage, requireNetwork } from './config'
import { closePool, getPool } from './db/pool'
import { exitAfterFlush, exitAfterTeardown } from './exit'
import { makeApp } from './http/app'
import { logError, logInfo, logWarn } from './http/redact'
import { createAlerts } from './services/alerts'
import { ensureNetworkBinding } from './services/solvency'

/**
 * API entrypoint (design §11).
 *
 * Deliberately thin: it validates configuration, builds the real dependencies
 * and serves `makeApp`. Two invariants live here and nowhere else:
 *
 *  1. **Only the real chain client is ever constructed.** `FakeChain` is a
 *     displaced path and must stay unreachable from this file (PLAN.md kill
 *     criteria), exactly as in `worker.ts`.
 *  2. **Configuration fails at boot, not at the first claim.** Every secret the
 *     request path needs is asserted before the socket is opened, so a missing
 *     `STATUS_TOKEN_SECRET` is a startup crash the deploy notices rather than a
 *     500 the first claimant discovers.
 *
 * This process does NOT sign or broadcast anything — `worker.ts` holds advisory
 * lock 42 and is the only writer to the chain. It still constructs a
 * `NimiqChain` because the custody ADDRESS (funding instructions), the head
 * height (`/health`) and funding verification all read through `ChainClient`.
 *
 * That last paragraph used to be a promise. It is now enforced: the client is
 * built by `readOnlyNimiqChainFromEnv`, from `CUSTODY_ADDRESS`, and there is no
 * key in this process to sign with. Previously `CUSTODY_PRIVATE_KEY_HEX` was
 * required here for one reason — deriving the address — which meant the hot key
 * lived in the memory and the environment of the only internet-facing process
 * in the deployment, in exchange for a string. `buildSignedBasic` and
 * `broadcast` throw `ReadOnlyChainError` if anything ever tries.
 */

export const DEFAULT_PORT = 8080

/**
 * How long a stopping API waits for requests that are still running.
 *
 * Well under Docker's 10 s stop grace, and well over any request this service
 * answers from the database. See `closeServer` for what happens after it.
 */
export const IN_FLIGHT_GRACE_MS = 2_000

/**
 * Every variable the request path dereferences, checked before we listen.
 *
 * `CUSTODY_ADDRESS`, NOT `CUSTODY_PRIVATE_KEY_HEX`: see the module note. The
 * key is the worker's, and this list is the enforcement point — an API process
 * given only the key now refuses to boot instead of quietly deriving from it.
 */
const REQUIRED_ENV = [
  'DATABASE_URL',
  'STATUS_TOKEN_SECRET',
  'PUBLIC_ORIGIN',
  'CUSTODY_ADDRESS',
] as const

function requireEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name])
  if (missing.length > 0) throw new Error(`missing required environment: ${missing.join(', ')}`)

  requireNetwork()

  const scheme = process.env.SIG_SCHEME
  if (scheme !== 'raw' && scheme !== 'nimiq-signed-message') {
    throw new Error(`SIG_SCHEME must be raw or nimiq-signed-message (got ${scheme ?? 'unset'})`)
  }
}

function port(): number {
  const raw = process.env.PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`PORT must be a valid port number (got ${raw})`)
  }
  return value
}

/** Redacting writer (§10.3). Same line shape it always had, now filtered. */
const log = logInfo

async function main(): Promise<void> {
  requireEnv()

  const pool = getPool()
  const chain = readOnlyNimiqChainFromEnv()

  // Fail at boot, not at the first funding submission (G1 review finding 6): an
  // API process talking to a different chain than the database is bound to
  // would verify funding against the wrong network. The first boot of a fresh
  // database stamps the binding; every later boot must match it.
  const network = await ensureNetworkBinding(pool, chain)
  log('network_binding_verified', { network })

  const alerts = createAlerts({ source: 'nimdrops-api' })
  const app = makeApp({ pool, chain, alerts })

  const server = serve({ fetch: app.fetch, port: port(), hostname: '0.0.0.0' }, (info) => {
    log('api_listening', {
      port: info.port,
      network: chain.network(),
      // Stated at boot so the posture is a fact in the log, not an assumption.
      readOnlyChain: chain.isReadOnly(),
    })
  })

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('api_stopping', { signal })

    // Why `exitAfterTeardown` and not "close the server and let Node drain":
    // the second one does not work here, and used not to. `/health` calls
    // `chain.headHeight()`, which spawns the `@nimiq/core` consensus WORKER
    // THREAD, and its handles keep the event loop alive for as long as the
    // process exists — `chain.close()` disconnects the network without tearing
    // them down. So SIGTERM ran the whole teardown, logged `api_stopped`, and
    // then sat there until `docker compose stop` gave up on its 10 s grace
    // period and SIGKILLed the container. Measured before this change against a
    // real testnet client: `api_stopped` at +5 ms, process STILL ALIVE at +30 s
    // when the harness gave up and SIGKILLed it. After: exit 0 at +0.106 s. Same
    // fault `worker.ts` had, same fix; `src/exit.ts` is the shared reasoning,
    // and `test/api-shutdown.test.ts` is the regression.
    //
    // The exit code is 0 because a requested stop SUCCEEDED. A WASM fault
    // raised during teardown is logged and must not turn an ordinary deploy
    // restart into something an operator has to read as a crash.
    exitAfterTeardown(
      0,
      async () => {
        // Stop accepting connections first, then release the chain client and
        // the pool. In-flight requests finish; none of them hold money locks
        // that the worker cannot recover from anyway.
        await closeServer()
        await chain.close()
        await closePool()
        log('api_stopped')
      },
      (message) => logWarn('api_teardown_fault', { message }),
    )
  }

  /**
   * Resolve when the listener is closed and in-flight requests have finished —
   * or when they have had long enough.
   *
   * Two mechanisms, both needed:
   *
   *  - `closeIdleConnections()` because `close()` alone waits on keep-alive
   *    sockets that are holding no request at all, and Caddy keeps several
   *    open. Idle only: a socket in the middle of a request is untouched, which
   *    is the whole difference from `closeAllConnections()`.
   *  - the grace timer, because one route can block indefinitely. `/health`
   *    awaits `chain.headHeight()`, which awaits consensus, which does not
   *    return while the network is unreachable — exactly the condition under
   *    which someone is restarting the box. Waiting for that request would put
   *    us back over Docker's 10 s stop grace with a SIGKILL at the end of it.
   *    A claimant whose request is cut here retries; a SIGKILLed container
   *    takes the pool and the log with it.
   */
  function closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(overdue)
        resolve()
      }
      const overdue = setTimeout(() => {
        logWarn('api_forcing_connections_closed', { afterMs: IN_FLIGHT_GRACE_MS })
        ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
        finish()
      }, IN_FLIGHT_GRACE_MS)

      server.close(finish)
      ;(server as { closeIdleConnections?: () => void }).closeIdleConnections?.()
    })
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

const invokedDirectly = process.argv[1]?.endsWith('index.ts') === true

if (invokedDirectly) {
  // Reached only when the API could not be BUILT (bad configuration, port in
  // use): once `main` has returned, the signal handlers end the process.
  main().catch((err: unknown) => {
    logError('api_fatal', { error: errorMessage(err) })
    exitAfterFlush(1)
  })
}
