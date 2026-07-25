import { nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient } from './chain/types'
import { closePool, getPool } from './db/pool'
import { type Alerts, createAlerts, errorMessage, throttled } from './services/alerts'
import { reconcile } from './services/solvency'
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
 * Task 12 wires `sweepExpiry` + `settleTerminal` + draft GC into the same loop.
 */

export const TICK_INTERVAL_MS = 2_000
export const SOLVENCY_RECONCILE_INTERVAL_MS = 60_000
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1_000

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
    // Order matters: refresh the custody balance FIRST, otherwise every
    // `lockControls` call fails closed as stale and the worker can do nothing.
    await reconcile(pool, chain)
    // Then resolve every attempt whose outcome is unknown, BEFORE signing any
    // new work (design §8.3).
    await reconcileOnStartup(pool, chain, alerts)
    log('startup_reconciled')

    let lastSolvencyAt = Date.now()
    let lastHeartbeatAt = 0

    while (!stopping) {
      const now = Date.now()

      if (now - lastSolvencyAt >= SOLVENCY_RECONCILE_INTERVAL_MS) {
        lastSolvencyAt = now
        try {
          await reconcile(pool, chain)
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

      try {
        await runWorkerTick(pool, chain, alerts)
      } catch (err) {
        // A tick never gives up: the database is the queue, so the next tick
        // retries from committed state.
        console.warn(JSON.stringify({ event: 'tick_failed', error: errorMessage(err) }))
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

const invokedDirectly = process.argv[1]?.endsWith('worker.ts') === true

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ event: 'worker_fatal', error: errorMessage(err) }))
    process.exitCode = 1
  })
}
