import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyPair, PrivateKey } from '@nimiq/core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import '../src/db/pool'

/**
 * SIGTERM must END the API process, and quickly.
 *
 * This is `src/exit.ts`'s hazard on the HTTP side. `/health` calls
 * `chain.headHeight()`, which spawns the `@nimiq/core` consensus WORKER THREAD,
 * and that thread's handles keep the event loop alive for the rest of the
 * process's life. `chain.close()` disconnects the network; it does not take
 * those handles down. So the old shutdown ran to completion — server closed,
 * pool closed, `api_stopped` logged in about 5 ms — and then the process simply
 * stayed, until `docker compose stop` gave up on its 10 s grace period and
 * SIGKILLed the container. Measured on this machine before the fix: still alive
 * after 30 s.
 *
 * So the assertion here is not "the handlers ran" — the handlers always ran.
 * It is "the process is gone, with status 0, in seconds", which is only
 * observable from OUTSIDE the process. Hence a real child, a real signal and a
 * real exit code, the same way `exit.test.ts` proves the worker's.
 *
 * Needs Postgres (`ensureNetworkBinding` runs before the socket opens). It does
 * NOT need the network to be reachable: `Client.create` spawns the worker
 * thread — the thing that causes the hang — long before consensus is
 * established, so an offline run still exercises the fault, via the in-flight
 * grace path instead of the fast one.
 */

const hasDb = Boolean(process.env.DATABASE_URL)

const SCHEMA = 'api_shutdown_test'
const PORT = 8134
const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, '..', 'src', 'index.ts')
const TSX = resolve(HERE, '..', 'node_modules', '.bin', 'tsx')

/** Deterministic, non-secret, never funded. */
const CUSTODY_ADDRESS = KeyPair.derive(PrivateKey.fromHex('3'.repeat(64)))
  .toAddress()
  .toUserFriendlyAddress()

/** Longest a graceful stop may take before we call it a hang. */
const SHUTDOWN_BUDGET_MS = 8_000

function schemaUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string)
  url.searchParams.set('options', `-c search_path=${SCHEMA},public`)
  return url.toString()
}

describe.skipIf(!hasDb)('API graceful shutdown (real child process)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
  })

  it(
    'exits 0 within seconds of SIGTERM, after the consensus worker has started',
    async () => {
      // `tsx` runs the script in a CHILD of itself, so a signal sent to the
      // wrapper is not a signal sent to the app. Node is invoked directly with
      // tsx's loader to keep the process we measure the process we signalled.
      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx/esm', ENTRY],
        {
          cwd: resolve(HERE, '..'),
          env: {
            ...process.env,
            DATABASE_URL: schemaUrl(),
            NIMIQ_NETWORK: 'TestAlbatross',
            STATUS_TOKEN_SECRET: 'api-shutdown-test-secret',
            PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
            SIG_SCHEME: 'raw',
            CUSTODY_ADDRESS,
            PORT: String(PORT),
            // Never inherited into the API: the point of the read-only client.
            CUSTODY_PRIVATE_KEY_HEX: undefined,
            NODE_PATH: join(resolve(HERE, '..', '..'), 'node_modules'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )

      const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
        child.on('exit', (code, signal) => res({ code, signal }))
      })

      let output = ''
      const collect = (chunk: Buffer): void => {
        output += chunk.toString()
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)

      const listening = await waitFor(() => output.includes('api_listening'), 60_000)
      expect(listening, `never listened:\n${output}`).toBe(true)
      // The read-only posture is asserted here too: this is the only place the
      // real entrypoint is booted, so it is the only place that can prove it.
      expect(output).toContain('"readOnlyChain":true')

      // THE reproduction step. Without a request that reaches the chain client
      // there is no consensus worker, and both the old and the new code exit
      // fine. The response is irrelevant — issuing it is the point — so the
      // request is deliberately not awaited.
      void fetch(`http://127.0.0.1:${PORT}/health`).catch(() => {})
      await waitFor(() => false, 3_000)

      const start = Date.now()
      child.kill('SIGTERM')
      const result = await Promise.race([
        exited,
        sleep(SHUTDOWN_BUDGET_MS).then(() => 'timeout' as const),
      ])
      const elapsed = Date.now() - start

      if (result === 'timeout') {
        child.kill('SIGKILL')
        throw new Error(
          `API still alive ${elapsed}ms after SIGTERM — docker would SIGKILL it.\n${output}`,
        )
      }

      expect(output).toContain('api_stopping')
      expect(result.signal, 'died by signal instead of exiting').toBe(null)
      expect(result.code).toBe(0)
      expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS)
    },
    120_000,
  )
})

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(100)
  }
  return condition()
}
