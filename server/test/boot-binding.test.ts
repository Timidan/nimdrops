import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyPair, PrivateKey } from '@nimiq/core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'

/**
 * round-4 review S1 — the API and the worker cannot disagree about the custody
 * address, proven the only way it means anything: by booting the REAL
 * entrypoints as child processes and reading what they do.
 *
 * The bug was structural rather than arithmetic. `index.ts` took the custody
 * address from `CUSTODY_ADDRESS`; `worker.ts` derived it from
 * `CUSTODY_PRIVATE_KEY_HEX`. Only the NETWORK was bound to the database, so a
 * `CUSTODY_ADDRESS` that was a perfectly valid Nimiq address but not the
 * worker's wallet passed every check at boot. The API then published it as
 * funding instructions, `submitFunding` verified deposits against it, and
 * `activate()` credited them to the ledger — money sitting in a wallet the
 * worker holds no key for, and every claimant of that drop unpayable.
 *
 * A unit test of `ensureChainBinding` proves the function refuses. It does NOT
 * prove that both entrypoints call it before they do anything, which is the
 * actual claim, so both are spawned here for real. Neither child needs the
 * network: the binding is settled before any chain method is awaited, so an
 * offline run exercises exactly the same path.
 */

const hasDb = Boolean(process.env.DATABASE_URL)

const SCHEMA = 'boot_binding_test'
const HERE = dirname(fileURLToPath(import.meta.url))
const API_ENTRY = resolve(HERE, '..', 'src', 'index.ts')
const WORKER_ENTRY = resolve(HERE, '..', 'src', 'worker.ts')
const NODE_MODULES = join(resolve(HERE, '..', '..'), 'node_modules')

/** Deterministic, non-secret, never funded. The wallet the database gets bound to. */
const CUSTODY_KEY_HEX = '7'.repeat(64)
const CUSTODY_ADDRESS = KeyPair.derive(PrivateKey.fromHex(CUSTODY_KEY_HEX))
  .toAddress()
  .toUserFriendlyAddress()

/** A different, equally valid wallet. That it PARSES is the whole failure mode. */
const OTHER_KEY_HEX = '9'.repeat(64)
const OTHER_ADDRESS = KeyPair.derive(PrivateKey.fromHex(OTHER_KEY_HEX))
  .toAddress()
  .toUserFriendlyAddress()

/** Generous: each child pays for a cold `tsx` start plus the WASM module load. */
const BOOT_BUDGET_MS = 60_000
const CASE_BUDGET_MS = 120_000

describe.skipIf(!hasDb)('boot-time custody address binding (real child processes)', () => {
  let pool: pg.Pool

  function schemaUrl(): string {
    const url = new URL(process.env.DATABASE_URL as string)
    url.searchParams.set('options', `-c search_path=${SCHEMA},public`)
    return url.toString()
  }

  /**
   * Every variable both entrypoints need, and NEITHER custody variable. Each
   * test states exactly what its process is given, because "which of these two
   * is set, and do they agree" is the thing under test.
   */
  function baseEnv(port: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DATABASE_URL: schemaUrl(),
      NIMIQ_NETWORK: 'TestAlbatross',
      STATUS_TOKEN_SECRET: 'boot-binding-test-secret',
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      SIG_SCHEME: 'raw',
      PORT: String(port),
      NODE_PATH: NODE_MODULES,
      CUSTODY_ADDRESS: undefined,
      CUSTODY_PRIVATE_KEY_HEX: undefined,
      NIMDROPS_CONFIRM_CUSTODY_ADDRESS: undefined,
    }
  }

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

  async function boundAddress(): Promise<string | null> {
    const { rows } = await pool.query<{ custody_address: string | null }>(
      'SELECT custody_address FROM custody_controls WHERE singleton',
    )
    return rows[0].custody_address
  }

  interface Run {
    /** Exit status, or `null` when the child was stopped because it got far enough. */
    status: number | null
    out: string
  }

  /**
   * Run an entrypoint and wait for it to either exit or print `stopWhen`.
   *
   * A process that BOOTS does not exit — it serves, or it blocks on consensus —
   * so the pass condition for the accepting cases is a log line, and the child
   * is killed once it appears. The refusing cases exit on their own and are
   * asserted on their status.
   */
  function run(entry: string, env: NodeJS.ProcessEnv, stopWhen?: string): Promise<Run> {
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
      cwd: resolve(HERE, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return new Promise((res) => {
      let out = ''
      let settled = false
      const finish = (r: Run): void => {
        if (settled) return
        settled = true
        clearTimeout(overdue)
        res(r)
      }
      const overdue = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ status: null, out: `${out}\n[TIMEOUT after ${BOOT_BUDGET_MS}ms]` })
      }, BOOT_BUDGET_MS)
      const collect = (chunk: Buffer): void => {
        out += chunk.toString()
        if (stopWhen !== undefined && out.includes(stopWhen)) {
          child.kill('SIGKILL')
          finish({ status: null, out })
        }
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('exit', (status) => finish({ status, out }))
    })
  }

  it(
    'the first boot stamps the address and a matching boot is accepted',
    async () => {
      expect(await boundAddress(), 'a fresh database is unbound').toBeNull()

      // The worker boots first, as a deployment does: it holds the key, so its
      // derived address is the only one that can actually spend.
      const worker = await run(
        WORKER_ENTRY,
        { ...baseEnv(8141), CUSTODY_PRIVATE_KEY_HEX: CUSTODY_KEY_HEX },
        'chain_binding_verified',
      )
      expect(worker.out).toContain('custody_address_bound')
      expect(await boundAddress()).toBe(CUSTODY_ADDRESS)

      // The API, configured with the same wallet, agrees and opens its socket.
      const api = await run(API_ENTRY, { ...baseEnv(8142), CUSTODY_ADDRESS }, 'api_listening')
      expect(api.out, api.out).toContain('chain_binding_verified')
      expect(await boundAddress(), 'a matching boot changes nothing').toBe(CUSTODY_ADDRESS)
    },
    CASE_BUDGET_MS,
  )

  it(
    'the API refuses to open its socket on a custody address mismatch',
    async () => {
      // The exact deployment slip: `CUSTODY_ADDRESS` is a real, valid, parseable
      // Nimiq address — just not the one the worker's key derives. Before S1
      // this process served funding instructions for it.
      const api = await run(API_ENTRY, { ...baseEnv(8143), CUSTODY_ADDRESS: OTHER_ADDRESS })
      expect(api.status, api.out).toBe(1)
      expect(api.out).toContain('api_fatal')
      expect(api.out).toContain('custody database is bound to')
      expect(api.out, 'the socket must never open').not.toContain('api_listening')
      expect(await boundAddress(), 'a refused boot rewrites nothing').toBe(CUSTODY_ADDRESS)
    },
    CASE_BUDGET_MS,
  )

  it(
    'the worker refuses to run with a key that derives a different address',
    async () => {
      const worker = await run(WORKER_ENTRY, {
        ...baseEnv(8144),
        CUSTODY_PRIVATE_KEY_HEX: OTHER_KEY_HEX,
      })
      expect(worker.status, worker.out).toBe(1)
      expect(worker.out).toContain('worker_fatal')
      expect(worker.out).toContain('custody database is bound to')
      expect(worker.out, 'nothing may be reconciled or signed').not.toContain('startup_reconciled')
      expect(await boundAddress()).toBe(CUSTODY_ADDRESS)
    },
    CASE_BUDGET_MS,
  )

  it(
    'an explicit confirmation turns the refusal into a deliberate rotation',
    async () => {
      // The escape hatch exists because rotating the custody wallet is a real
      // operation. It is an operator action rather than a fallback: the old
      // wallet still holds every deposit that has not been paid out, and only a
      // human can sweep it.
      const api = await run(
        API_ENTRY,
        {
          ...baseEnv(8145),
          CUSTODY_ADDRESS: OTHER_ADDRESS,
          NIMDROPS_CONFIRM_CUSTODY_ADDRESS: OTHER_ADDRESS,
        },
        'api_listening',
      )
      expect(api.out).toContain('custody_address_rotated')
      expect(api.out).not.toContain('custody database is bound to')
      expect(await boundAddress()).toBe(OTHER_ADDRESS)

      // …and the confirmation must name the address this process is ACTUALLY
      // using. A stale value in the environment confirms nothing.
      const stale = await run(WORKER_ENTRY, {
        ...baseEnv(8146),
        CUSTODY_PRIVATE_KEY_HEX: CUSTODY_KEY_HEX,
        NIMDROPS_CONFIRM_CUSTODY_ADDRESS: OTHER_ADDRESS,
      })
      expect(stale.status, stale.out).toBe(1)
      expect(stale.out).toContain('custody database is bound to')
      expect(await boundAddress()).toBe(OTHER_ADDRESS)
    },
    CASE_BUDGET_MS,
  )
})
