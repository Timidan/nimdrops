import { serve } from '@hono/node-server'
import { nimiqChainFromEnv } from './chain/nimiq'
import { errorMessage, requireNetwork } from './config'
import { closePool, getPool } from './db/pool'
import { makeApp } from './http/app'
import { createAlerts } from './services/alerts'

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
 */

export const DEFAULT_PORT = 8080

/** Every variable the request path dereferences, checked before we listen. */
const REQUIRED_ENV = [
  'DATABASE_URL',
  'STATUS_TOKEN_SECRET',
  'PUBLIC_ORIGIN',
  'CUSTODY_PRIVATE_KEY_HEX',
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

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, at: new Date().toISOString(), ...detail }))
}

async function main(): Promise<void> {
  requireEnv()

  const pool = getPool()
  const chain = nimiqChainFromEnv()
  const alerts = createAlerts({ source: 'nimdrops-api' })
  const app = makeApp({ pool, chain, alerts })

  const server = serve({ fetch: app.fetch, port: port(), hostname: '0.0.0.0' }, (info) => {
    log('api_listening', { port: info.port, network: chain.network() })
  })

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('api_stopping', { signal })
    // Stop accepting connections first, then release the chain client and the
    // pool. In-flight requests finish; none of them hold money locks that the
    // worker cannot recover from anyway.
    server.close(() => {
      void (async () => {
        await chain.close().catch(() => {})
        await closePool().catch(() => {})
        log('api_stopped')
      })()
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

const invokedDirectly = process.argv[1]?.endsWith('index.ts') === true

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ event: 'api_fatal', error: errorMessage(err) }))
    process.exitCode = 1
  })
}
