import { pathToFileURL } from 'node:url'
import { nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient } from './chain/types'
import { closePool, getPool } from './db/pool'
import { errorMessage } from './config'
import { exitAfterFlush, exitAfterTeardown } from './exit'
import { logError, logInfo, logWarn } from './http/redact'
import { type Alerts, createAlerts, throttled } from './services/alerts'
import { gcDrafts, settleTerminal, sweepExpiry } from './services/expiry'
import { assertFloatAttestationIntact, ensureChainBinding, reconcile } from './services/solvency'
import {
  acquireWorkerLock,
  assertMemoDerivable,
  reconcileOnStartup,
  releaseWorkerLock,
  runWorkerTick,
} from './services/transfers'

/**
 * The single outgoing worker process (design §8.3, PLAN.md: "a second worker
 * path or serverless cron for transfers → reject").
 *
 * Deliberately thin — every decision lives in `services/transfers.ts`, which is
 * where the crash-window tests point. This file only owns the schedule and the
 * advisory lock, held for the life of the process on one dedicated connection:
 * if this process dies the session ends, Postgres drops the lock, and a
 * restarted worker picks the money back up from the database.
 *
 * Expiry, settlement and draft GC run in this same loop, and only here: they
 * write outgoing liabilities, so they belong behind the single-worker advisory
 * lock alongside signing, not in a second scheduler (PLAN.md kill criterion).
 */

/**
 * THROUGHPUT, since a drop may now have any number of claims.
 *
 * `runWorkerTick` signs at most ONE queued transfer per tick, and only when no
 * open attempt changed state in that same tick — so signing and progressing
 * alternate. Measured against real Postgres (`claims.race.test.ts`, the
 * 100-person drop): 100 payouts take 200 ticks, i.e. almost exactly two ticks
 * per payout, which at this interval is about four seconds of settlement per
 * claimant. A 100-person drop therefore takes roughly seven minutes to pay out
 * in full, plus one finality tail; a 20-person drop takes under two.
 *
 * This is a scheduling property, not a correctness one: the database is the
 * queue, every invariant is re-checked per signature, and a restart resumes.
 * It is written down because a sponsor funding a large drop is entitled to
 * know the shape of the wait, and because lowering this number is the obvious
 * lever if the wait ever matters more than the load on the RPC node — each
 * tick also polls every open attempt, so a large drop mid-settlement makes one
 * `getTransaction` call per unconfirmed payout per tick.
 */
export const TICK_INTERVAL_MS = 2_000
export const SOLVENCY_RECONCILE_INTERVAL_MS = 60_000
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1_000
/** Drafts are collected on a 24h horizon; checking every 10 min is ample. */
export const DRAFT_GC_INTERVAL_MS = 10 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Redacting writer (§10.3). Same line shape it always had, now filtered. */
const log = logInfo

export async function runWorker(chain: ChainClient, alerts: Alerts): Promise<void> {
  const pool = getPool()

  // One dedicated connection holds the lock for the whole process lifetime.
  const lockClient = await pool.connect()
  if (!(await acquireWorkerLock(lockClient))) {
    lockClient.release()
    throw new Error('another transfer worker holds advisory lock 42 — refusing to start a second')
  }
  // Stamped into the image at build time (server/Dockerfile ARG GIT_COMMIT).
  // The worker is the only process that signs, so "which code is signing" is
  // the single most important thing to be able to read off a log line.
  log('worker_lock_acquired', { commit: process.env.NIMDROPS_COMMIT ?? 'unknown' })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('worker_stopping', { signal })
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    // Before anything touches money: bind this database to this chain AND to
    // this custody wallet, or refuse to run at all (G1 review finding 6, round-4
    // review S1). A worker pointed at the wrong network would sign payouts with the
    // wrong network id and reconcile against a chain that has never seen this
    // custody wallet. A worker whose KEY derives a different address than the
    // one the API is publishing as funding instructions is the same failure
    // seen from the other side: sponsors pay a wallet this process cannot
    // spend. The database is the single authority both are checked against.
    const { network, custodyAddress } = await ensureChainBinding(pool, chain)
    log('chain_binding_verified', { network, custodyAddress })

    // Cheap, local, and before any money moves: a worker that cannot derive a
    // transfer memo cannot build a payout, and the failure would otherwise
    // appear only as a repeating tick warning with no payments behind it.
    assertMemoDerivable()

    // And the float attestation has to belong to that chain. A database carried
    // between networks would keep counting the other chain's deposits as
    // spendable custody money, and this is the process that spends it.
    await assertFloatAttestationIntact(pool, network)

    // Order matters, and round-3 R4 REVERSED it. Attempts first:
    //
    //  - resolving open attempts takes no custody lock and needs no fresh
    //    reconciliation, so nothing about it depends on the cross-check having
    //    run; but
    //  - the cross-check's verdict very much depends on the attempts. A
    //    restart after crash window (b) — the network has the transaction, the
    //    database still says `signed` — leaves an attempt whose money the chain
    //    has already debited. Reconciling that attempt first turns it into the
    //    `broadcast` row the cross-check can account for. Reconciling solvency
    //    first meant comparing a debited chain balance against books that had
    //    not yet learned about the debit, which pauses custody on a restart
    //    that is behaving exactly as designed — and confirming the attempt
    //    afterwards does not unpause anything.
    //
    // No new work can be signed before both are done: signing happens in the
    // tick loop below, and `lockControls` fails closed on staleness until the
    // reconciliation on the next line succeeds.
    await reconcileOnStartup(pool, chain, alerts)
    await reconcile(pool, chain, alerts)
    log('startup_reconciled')

    let lastSolvencyAt = Date.now()
    let lastHeartbeatAt = 0
    let lastDraftGcAt = 0

    while (!stopping) {
      const now = Date.now()

      if (now - lastSolvencyAt >= SOLVENCY_RECONCILE_INTERVAL_MS) {
        lastSolvencyAt = now
        try {
          await reconcile(pool, chain, alerts)
        } catch (err) {
          // Leaving the balance stale fails closed on its own: `lockControls`
          // refuses new signatures until a reconcile succeeds.
          logWarn('reconcile_failed', { error: errorMessage(err) })
        }
      }

      if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatAt = now
        await alerts.notify('heartbeat', { network: chain.network(), pid: process.pid })
      }

      // Close expired drops BEFORE signing: a refund created this tick is then
      // just another queued intent the same tick can pick up.
      try {
        await sweepExpiry(pool, alerts)
      } catch (err) {
        logWarn('expiry_failed', { error: errorMessage(err) })
      }

      try {
        await runWorkerTick(pool, chain, alerts)
      } catch (err) {
        // A tick never gives up: the database is the queue, so the next tick
        // retries from committed state.
        logWarn('tick_failed', { error: errorMessage(err) })
      }

      // …and settle AFTER, so a drop whose last liability confirmed in this
      // tick reaches its terminal state without waiting for the next one.
      try {
        await settleTerminal(pool)
      } catch (err) {
        logWarn('settle_failed', { error: errorMessage(err) })
      }

      if (now - lastDraftGcAt >= DRAFT_GC_INTERVAL_MS) {
        lastDraftGcAt = now
        try {
          await gcDrafts(pool)
        } catch (err) {
          logWarn('draft_gc_failed', { error: errorMessage(err) })
        }
      }

      await sleep(TICK_INTERVAL_MS)
    }
  } finally {
    await releaseWorkerLock(lockClient).catch(() => {})
    lockClient.release()
    log('worker_stopped')
  }
}

/**
 * Run the loop, then END — deliberately, with a code that reports the RUN.
 *
 * Both halves of that are the `@nimiq/core` teardown hazard `src/exit.ts`
 * documents, and this process had both:
 *
 *  - it never exited. `runWorker` returns as soon as SIGTERM stops the loop and
 *    the advisory lock is released, and then nothing happened: the consensus
 *    worker thread keeps the event loop alive, so `docker compose stop` waited
 *    out its whole grace period and SIGKILLed the container. A graceful stop
 *    that always degrades into a kill is not a graceful stop, and the log line
 *    that says so (`worker_stopped`) was the last honest thing about it;
 *  - and if the WASM layer raised during `chain.close()`, that uncaught
 *    exception ended the process at 1 — before `closePool()` — turning an
 *    ordinary deploy restart into something an operator has to read as a crash.
 *
 * The loop itself is NOT guarded. A fault while the worker is working must
 * still kill it non-zero so the restart policy picks the money back up from the
 * database; only the stop is protected, and only after the stop is decided.
 */
async function main(): Promise<void> {
  // Production entrypoint: only the real chain client is ever constructed here.
  // FakeChain is a displaced path and must stay unreachable from this file.
  const chain = nimiqChainFromEnv()
  // Throttled so a paused system cannot page the operator every two seconds.
  const alerts = throttled(createAlerts({ source: 'nimdrops-worker' }))

  let code = 0
  try {
    await runWorker(chain, alerts)
  } catch (err) {
    logError('worker_fatal', { error: errorMessage(err) })
    code = 1
  }

  // The verdict on this run is now fixed. Everything after it is cleanup.
  exitAfterTeardown(
    code,
    async () => {
      await chain.close()
      await closePool()
    },
    (message) => logWarn('worker_teardown_fault', { message }),
  )
}

// Exact-path comparison, matching `recover.ts`: `endsWith('worker.ts')` also
// fires for any other file whose name happens to end that way.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  // Reached only when the worker could not be BUILT (bad configuration): once
  // `main` is running, it ends the process itself.
  main().catch((err: unknown) => {
    logError('worker_fatal', { error: errorMessage(err) })
    exitAfterFlush(1)
  })
}
