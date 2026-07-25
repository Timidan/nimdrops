import { pathToFileURL } from 'node:url'
import { nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient } from './chain/types'
import { closePool, getPool } from './db/pool'
import { errorMessage } from './config'
import { type Alerts, createAlerts, throttled } from './services/alerts'
import { gcDrafts, settleTerminal, sweepExpiry } from './services/expiry'
import { ensureNetworkBinding, reconcile } from './services/solvency'
import {
  acquireWorkerLock,
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

export const TICK_INTERVAL_MS = 2_000
export const SOLVENCY_RECONCILE_INTERVAL_MS = 60_000
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1_000
/** Drafts are collected on a 24h horizon; checking every 10 min is ample. */
export const DRAFT_GC_INTERVAL_MS = 10 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, at: new Date().toISOString(), ...detail }))
}

export async function runWorker(chain: ChainClient, alerts: Alerts): Promise<void> {
  const pool = getPool()

  // One dedicated connection holds the lock for the whole process lifetime.
  const lockClient = await pool.connect()
  if (!(await acquireWorkerLock(lockClient))) {
    lockClient.release()
    throw new Error('another transfer worker holds advisory lock 42 — refusing to start a second')
  }
  log('worker_lock_acquired')

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('worker_stopping', { signal })
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    // Before anything touches money: bind this database to this chain, or
    // refuse to run at all (G1 review finding 6). A worker pointed at the wrong
    // network would sign payouts with the wrong network id and reconcile
    // against a chain that has never seen this custody wallet.
    const network = await ensureNetworkBinding(pool, chain)
    log('network_binding_verified', { network })

    // Order matters: refresh the custody balance FIRST, otherwise every
    // `lockControls` call fails closed as stale and the worker can do nothing.
    await reconcile(pool, chain, alerts)
    // Then resolve every attempt whose outcome is unknown, BEFORE signing any
    // new work (design §8.3).
    await reconcileOnStartup(pool, chain, alerts)
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
          console.warn(JSON.stringify({ event: 'reconcile_failed', error: errorMessage(err) }))
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
        console.warn(JSON.stringify({ event: 'expiry_failed', error: errorMessage(err) }))
      }

      try {
        await runWorkerTick(pool, chain, alerts)
      } catch (err) {
        // A tick never gives up: the database is the queue, so the next tick
        // retries from committed state.
        console.warn(JSON.stringify({ event: 'tick_failed', error: errorMessage(err) }))
      }

      // …and settle AFTER, so a drop whose last liability confirmed in this
      // tick reaches its terminal state without waiting for the next one.
      try {
        await settleTerminal(pool)
      } catch (err) {
        console.warn(JSON.stringify({ event: 'settle_failed', error: errorMessage(err) }))
      }

      if (now - lastDraftGcAt >= DRAFT_GC_INTERVAL_MS) {
        lastDraftGcAt = now
        try {
          await gcDrafts(pool)
        } catch (err) {
          console.warn(JSON.stringify({ event: 'draft_gc_failed', error: errorMessage(err) }))
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

async function main(): Promise<void> {
  // Production entrypoint: only the real chain client is ever constructed here.
  // FakeChain is a displaced path and must stay unreachable from this file.
  const chain = nimiqChainFromEnv()
  // Throttled so a paused system cannot page the operator every two seconds.
  const alerts = throttled(createAlerts({ source: 'nimdrops-worker' }))

  try {
    await runWorker(chain, alerts)
  } finally {
    await chain.close().catch(() => {})
    await closePool().catch(() => {})
  }
}

// Exact-path comparison, matching `recover.ts`: `endsWith('worker.ts')` also
// fires for any other file whose name happens to end that way.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ event: 'worker_fatal', error: errorMessage(err) }))
    process.exitCode = 1
  })
}
