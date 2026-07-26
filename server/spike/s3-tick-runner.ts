/**
 * S3 kill/restart child runner — the worker loop as a SEPARATE OS PROCESS so
 * the harness can `kill -9` it at an exact instruction boundary.
 *
 *   pnpm tsx spike/s3-tick-runner.ts <mode> <transferId>
 *
 * Modes (each is one process; the parent `s3-settlement-e2e.ts` spawns them in
 * order and asserts on the database and the chain between them):
 *
 *   sign-then-crash       Reconcile, then tick until the worker signs and
 *                         COMMITS an attempt for <transferId>. The instant the
 *                         production path calls `chain.broadcast`, SIGKILL this
 *                         process — so the `signed` row is durable and the
 *                         bytes have provably never left it. Crash window (a).
 *
 *   broadcast-then-crash  Restart. `reconcileOnStartup` finds that `signed`
 *                         attempt, cannot see it on chain, and rebroadcasts THE
 *                         SAME BYTES. The instant the real broadcast RETURNS,
 *                         SIGKILL — before `markBroadcast` can record it. The
 *                         database still says `signed` while the network has
 *                         the transaction. Crash window (b), the ambiguous one.
 *
 *   finish                Restart again and let `reconcileOnStartup` plus the
 *                         ordinary tick loop resolve the attempt by hash, to
 *                         finality. Exits 0 once the intent is `confirmed`.
 *
 * Nothing here re-implements money logic. The crash hook wraps ONE method on
 * the chain client — `broadcast` — and every state transition around it is
 * produced by `services/transfers.ts` exactly as it runs in `worker.ts`.
 *
 * The kill is `process.kill(pid, 'SIGKILL')` on itself: SIGKILL cannot be
 * blocked, caught or deferred, so no `finally`, no shutdown hook and no pending
 * microtask gets to run. That is the difference between this and a
 * `process.exit(1)` — an exit is still the program deciding to stop.
 *
 * TestAlbatross only.
 */

import { writeSync } from 'node:fs'
import pg from 'pg'
import { NimiqChain, type NimiqNetwork } from '../src/chain/nimiq'
import { consoleAlerts } from '../src/services/alerts'
import { reconcile } from '../src/services/solvency'
import { reconcileOnStartup, runWorkerTick } from '../src/services/transfers'
// Side-effect import: int8-as-string, so BIGINT luna never becomes a JS number.
import '../src/db/pool'

const MODES = ['sign-then-crash', 'broadcast-then-crash', 'finish'] as const
type Mode = (typeof MODES)[number]

/** A crash mode that never reaches its crash point is a harness failure. */
const CRASH_DEADLINE_MS = 5 * 60_000
/** `finish` gets a full finality budget (64 blocks ≈ 64s) plus slack. */
const FINISH_DEADLINE_MS = 15 * 60_000
const TICK_SLEEP_MS = 3_000

/** Distinct exit codes so the parent can say WHICH way the child went wrong. */
const EXIT_USAGE = 2
const EXIT_NO_CRASH = 3
const EXIT_NOT_FINISHED = 4
const EXIT_PRECONDITION = 5

const t0 = Date.now()
function say(...parts: unknown[]): void {
  // writeSync, not console.log: with stdio 'inherit' onto a pipe, console.log
  // is asynchronous and SIGKILL discards whatever is still queued. The line
  // that says a crash is about to happen must survive the crash.
  writeSync(1, `[runner ${((Date.now() - t0) / 1000).toFixed(1)}s] ${parts.join(' ')}\n`)
}

function bail(code: number, message: string): never {
  writeSync(2, `\n✗ s3-tick-runner: ${message}\n`)
  process.exit(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Die where a crash really can happen: between two production statements, with
 * no chance to tidy up. Returns `never` and genuinely never returns — a
 * self-directed SIGKILL is delivered before `kill(2)` comes back.
 */
function sigkillSelf(reason: string): never {
  say(`CRASH POINT (${reason}) — sending SIGKILL to self, pid ${process.pid}`)
  process.kill(process.pid, 'SIGKILL')
  // Only reachable if the platform refused to deliver SIGKILL, which would make
  // every assertion downstream meaningless. Say so instead of carrying on.
  bail(EXIT_NO_CRASH, `SIGKILL did not kill this process (${reason})`)
}

// ---------------------------------------------------------------------------

const mode = process.argv[2] as Mode | undefined
const transferId = process.argv[3]

if (!mode || !MODES.includes(mode) || !transferId) {
  bail(EXIT_USAGE, `usage: s3-tick-runner.ts <${MODES.join('|')}> <transferId>`)
}

const NETWORK = (process.env.NIMIQ_NETWORK ?? 'TestAlbatross') as NimiqNetwork
if (NETWORK !== 'TestAlbatross') bail(EXIT_USAGE, 'S3 is TestAlbatross only')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) bail(EXIT_USAGE, 'DATABASE_URL is not set')
const SCHEMA = process.env.S3_SCHEMA
if (!SCHEMA || !/^[a-z0-9_]+$/.test(SCHEMA)) {
  bail(EXIT_USAGE, `S3_SCHEMA must be a plain identifier (got ${SCHEMA ?? 'unset'})`)
}
const CUSTODY_KEY = process.env.CUSTODY_PRIVATE_KEY_HEX
if (!CUSTODY_KEY) bail(EXIT_USAGE, 'CUSTODY_PRIVATE_KEY_HEX is not set')

async function main(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${SCHEMA},public`,
    max: 4,
  })
  const chain = new NimiqChain({
    network: NETWORK,
    custodyPrivateKeyHex: CUSTODY_KEY as string,
    logLevel: 'warn',
  })
  const alerts = consoleAlerts()

  // ---- preconditions -------------------------------------------------------
  // A crash child that signs the WRONG intent would still "pass" its own crash
  // assertion and quietly wreck the parent's conservation maths, so refuse
  // unless the queue holds exactly the one intent we were pointed at.
  const { rows: target } = await pool.query<{ state: string }>(
    'SELECT state FROM outgoing_transfers WHERE id = $1',
    [transferId],
  )
  if (!target[0]) bail(EXIT_PRECONDITION, `no outgoing transfer ${transferId}`)

  const { rows: queued } = await pool.query<{ id: string }>(
    `SELECT id FROM outgoing_transfers
     WHERE state = 'queued' OR EXISTS (
       SELECT 1 FROM transaction_attempts a
       WHERE a.transfer_id = outgoing_transfers.id AND a.state IN ('signed', 'broadcast')
     )`,
  )
  const strays = queued.filter((r) => r.id !== transferId)
  if (strays.length > 0) {
    bail(
      EXIT_PRECONDITION,
      `${strays.length} other transfer(s) are queued or open; this runner must be the only work`,
    )
  }
  if (mode === 'sign-then-crash' && target[0].state !== 'queued') {
    bail(EXIT_PRECONDITION, `expected ${transferId} to be queued, found '${target[0].state}'`)
  }

  say(`mode=${mode} transfer=${transferId} schema=${SCHEMA}`)

  // ---- crash hook ----------------------------------------------------------
  // The ONLY thing this file changes about the production path.
  const realBroadcast = chain.broadcast.bind(chain)
  chain.broadcast = async (rawTxHex: string): Promise<void> => {
    if (mode === 'sign-then-crash') {
      // The `signed` attempt row is committed (`signNextQueued` commits before
      // it calls this) and the bytes have not been handed to anyone.
      sigkillSelf('after signed attempt committed, BEFORE broadcast')
    }
    await realBroadcast(rawTxHex)
    if (mode === 'broadcast-then-crash') {
      // The network has the transaction; `markBroadcast` has not run, so the
      // database still says `signed`. This is the window where a naive worker
      // would sign a second payment on restart.
      sigkillSelf('immediately AFTER broadcast returned, before markBroadcast')
    }
  }

  const connectStarted = Date.now()
  await chain.connect()
  say(`consensus in ${((Date.now() - connectStarted) / 1000).toFixed(1)}s, head ${await chain.headHeight()}`)

  // ---- the worker's own startup sequence, in this order (worker.ts) ---------
  await reconcile(pool, chain, alerts)
  await reconcileOnStartup(pool, chain, alerts)
  say('startup reconciled')

  const deadline = Date.now() + (mode === 'finish' ? FINISH_DEADLINE_MS : CRASH_DEADLINE_MS)
  let ticks = 0
  while (Date.now() < deadline) {
    if (mode === 'finish') {
      const { rows } = await pool.query<{ done: boolean }>(
        `SELECT (t.state = 'confirmed' AND EXISTS (
            SELECT 1 FROM transaction_attempts a
            WHERE a.transfer_id = t.id AND a.state = 'confirmed'
          )) AS done
         FROM outgoing_transfers t WHERE t.id = $1`,
        [transferId],
      )
      if (rows[0]?.done) {
        say(`transfer ${transferId} CONFIRMED after ${ticks} ticks`)
        await pool.end()
        await chain.close()
        process.exit(0)
      }
    }
    const outcome = await runWorkerTick(pool, chain, alerts)
    ticks += 1
    if (ticks % 10 === 0) say(`${ticks} ticks, last=${outcome}`)
    await sleep(TICK_SLEEP_MS)
  }

  if (mode === 'finish') {
    bail(EXIT_NOT_FINISHED, `transfer ${transferId} never confirmed within the budget`)
  }
  bail(EXIT_NO_CRASH, `crash point for mode ${mode} was never reached — nothing was proven`)
}

main().catch((err: unknown) => {
  console.error(err)
  bail(1, String(err))
})
