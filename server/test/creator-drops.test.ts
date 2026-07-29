import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { listCreatorDrops } from '../src/services/drops'

function row(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    public_id: `drop-${index}`,
    sponsor_label: `Sponsor ${index}`,
    message: null,
    claim_count: 5,
    amount_each_luna: '250000',
    expected_funding_luna: '1250000',
    state: 'live',
    funding_tx_hash: 'a'.repeat(64),
    activated_height: '100',
    expiry_hours: 24,
    expires_at: new Date('2026-07-30T12:00:00.000Z'),
    closing_reason: null,
    claims_reserved: '2',
    gate_kind: null,
    created_at: new Date(`2026-07-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`),
  }
}

describe('listCreatorDrops', () => {
  it('queries only the signature-derived creator and returns public management fields', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row(1)] }))
    const result = await listCreatorDrops({ query } as unknown as Pool, 'NQ00 CREATOR')

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual(['NQ00 CREATOR', 101])
    expect(String(query.mock.calls[0]?.[0])).toMatch(/WHERE d\.creator_address = \$1/)
    expect(result.truncated).toBe(false)
    expect(result.drops[0]).toMatchObject({
      publicId: 'drop-1',
      amountEach: '2.5',
      claimCount: 5,
      remaining: 3,
      createdAt: row(1).created_at,
    })
    expect(result.drops[0]).not.toHaveProperty('creatorAddress')
  })

  it('caps a response at the 100 most recent rows', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: Array.from({ length: 101 }, (_, index) => row(index)),
    }))
    const result = await listCreatorDrops({ query } as unknown as Pool, 'NQ00 CREATOR')
    expect(result.drops).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })
})
