import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ChainClient } from '../src/chain/types'
import { broadcastStored, type StoredAttempt } from '../src/services/transfers'

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

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toContain('broadcast_attempted_at')
    expect(query.mock.calls[1]?.[0]).toContain('last_error')
    expect(query.mock.calls[1]?.[1]?.[1]).toMatch(/chain call "broadcast" timed out/i)
  })
})
