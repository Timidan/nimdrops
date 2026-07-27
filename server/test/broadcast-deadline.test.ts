import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ChainClient } from '../src/chain/types'
import {
  broadcastStored,
  REBROADCAST_COOLDOWN_MS,
  type StoredAttempt,
} from '../src/services/transfers'

const ATTEMPT: StoredAttempt = {
  attemptId: 'attempt-1',
  transferId: 'transfer-1',
  claimId: 'claim-1',
  sequence: 1,
  rawTxHex: 'deadbeef',
  txHash: 'a'.repeat(64),
  validityStartHeight: 100,
}

describe('broadcastStored deadline', () => {
  it('records an unanswered broadcast as ambiguous and returns', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }))
    const pool = { query } as unknown as Pool
    const chain = {
      broadcast: () => new Promise<void>(() => {}),
    } as unknown as ChainClient

    await expect(broadcastStored(pool, chain, ATTEMPT, { chainTimeoutMs: 10 })).resolves.toBe(
      'unknown',
    )

    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0]?.[0]).toContain('broadcast_attempted_at')
    expect(query.mock.calls[1]?.[0]).toContain('last_error')
    expect(query.mock.calls[1]?.[1]?.[1]).toMatch(/chain call "broadcast" timed out/i)
  })

  /**
   * `withChainDeadline` abandons a broadcast; it cannot cancel one. So a
   * timed-out broadcast is still running inside the SDK when the money engine
   * walks away — and without a cooldown the next tick, two seconds later, gets
   * `null` from `getTransaction` and starts another one. Identical bytes, so
   * nobody can be paid twice; unbounded in-flight sends, so a node that comes
   * back has to dig itself out from under them first.
   */
  it('holds off the next identical send after a timeout, not only after an ack', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }))
    const pool = { query } as unknown as Pool
    const chain = {
      broadcast: () => new Promise<void>(() => {}),
    } as unknown as ChainClient

    await broadcastStored(pool, chain, ATTEMPT, { chainTimeoutMs: 10 })

    const cooldown = query.mock.calls[2]
    expect(cooldown?.[0]).toContain('next_attempt_at')
    expect(cooldown?.[0]).toContain('outgoing_transfers')
    // Never onto a finished intent: a schedule on a confirmed transfer is a
    // schedule for work that must not happen.
    expect(cooldown?.[0]).toContain("state <> 'confirmed'")
    expect(cooldown?.[1]).toEqual([ATTEMPT.transferId, REBROADCAST_COOLDOWN_MS])
  })

  /**
   * The cooldown must slow the retries down without costing the transaction its
   * validity window. `NIMIQ_VALIDITY_WINDOW_BLOCKS` is floored at 7200 blocks,
   * ~1 s each, so a legitimate rebroadcast of bytes whose first send was truly
   * lost still gets hundreds of attempts inside the window.
   */
  it('is far shorter than the validity window and longer than the chain deadline', async () => {
    const { CHAIN_CALL_TIMEOUT_MS } = await import('../src/chain/deadline')
    const windowMs = 7_200 * 1_000

    expect(REBROADCAST_COOLDOWN_MS).toBeGreaterThan(CHAIN_CALL_TIMEOUT_MS)
    expect(windowMs / REBROADCAST_COOLDOWN_MS).toBeGreaterThan(100)
  })
})
