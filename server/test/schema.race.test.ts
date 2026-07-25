import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import { getPool } from '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/** Default drop shape that satisfies every CHECK. */
function ok() {
  return { claimCount: 5, amountEachLuna: 100n, expectedFundingLuna: 500n }
}

async function insertDrop(
  pool: Pool,
  o: { claimCount: number; amountEachLuna: bigint; expectedFundingLuna: bigint; state?: string },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO drops (public_id, sponsor_label, claim_count, amount_each_luna, expected_funding_luna, state)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      randomUUID(),
      'Sponsor',
      o.claimCount,
      o.amountEachLuna.toString(),
      o.expectedFundingLuna.toString(),
      o.state ?? 'live',
    ],
  )
  return rows[0]
}

async function insertClaim(
  pool: Pool,
  dropId: string,
  slotIndex: number,
  recipientAddress: string,
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [dropId, slotIndex, recipientAddress, randomUUID(), 'reserved'],
  )
  return rows[0]
}

async function insertTransfer(
  pool: Pool,
  o: { purpose: 'payout' | 'refund'; dropId: string; claimId?: string | null; amountLuna?: bigint },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outgoing_transfers (idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      `${o.purpose}:${randomUUID()}`,
      o.purpose,
      o.dropId,
      o.claimId ?? null,
      'NQ07 RECIPIENT',
      (o.amountLuna ?? 100n).toString(),
      'queued',
    ],
  )
  return rows[0]
}

async function insertAttempt(
  pool: Pool,
  o: { transferId: string; sequence: number; state: string },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height
     ) VALUES ($1, $2, $3, $4, $5, $6, 1)
     RETURNING id`,
    [o.transferId, o.sequence, o.state, Buffer.from('00ff', 'hex'), randomUUID(), '0'],
  )
  return rows[0]
}

describe.skipIf(!hasDb)('schema invariants (real Postgres)', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = getPool()
    await migrate(pool)
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops, http_idempotency RESTART IDENTITY CASCADE`,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('seeds exactly one custody_controls row with launch caps', async () => {
    const { rows } = await pool.query(
      `SELECT paused, max_live_principal_luna, configured_fee_reserve_luna FROM custody_controls`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].paused).toBe(false)
    expect(BigInt(rows[0].max_live_principal_luna)).toBe(10_000_000n)
    expect(BigInt(rows[0].configured_fee_reserve_luna)).toBe(100_000n)
  })

  it('rejects a drop whose expected funding mismatches count*amount', async () => {
    await expect(
      insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, expectedFundingLuna: 400n }),
    ).rejects.toThrow(/expected_funding|check/i)
  })

  it('forbids two payouts for one claim', async () => {
    const d = await insertDrop(pool, ok())
    const c = await insertClaim(pool, d.id, 0, 'NQ07 X')
    await insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id })
    await expect(
      insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id }),
    ).rejects.toThrow(/one_payout_per_claim|duplicate/i)
  })

  it('forbids two refunds for one drop', async () => {
    const d = await insertDrop(pool, ok())
    await insertTransfer(pool, { purpose: 'refund', dropId: d.id })
    await expect(insertTransfer(pool, { purpose: 'refund', dropId: d.id })).rejects.toThrow(
      /one_refund_per_drop|duplicate/i,
    )
  })

  it('forbids a second open attempt per transfer', async () => {
    const d = await insertDrop(pool, ok())
    const c = await insertClaim(pool, d.id, 0, 'NQ07 OPEN')
    const t = await insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id })
    await insertAttempt(pool, { transferId: t.id, sequence: 1, state: 'signed' })
    await expect(
      insertAttempt(pool, { transferId: t.id, sequence: 2, state: 'broadcast' }),
    ).rejects.toThrow(/one_open_attempt|duplicate/i)

    // A replacement is only allowed once the prior attempt is proven_dead.
    await pool.query(`UPDATE transaction_attempts SET state = 'proven_dead' WHERE transfer_id = $1`, [
      t.id,
    ])
    await expect(
      insertAttempt(pool, { transferId: t.id, sequence: 2, state: 'signed' }),
    ).resolves.toBeDefined()
  })

  it('forbids two claims for one wallet in one drop and two claims in one slot', async () => {
    const d = await insertDrop(pool, ok())
    await insertClaim(pool, d.id, 0, 'NQ07 WALLET')
    await expect(insertClaim(pool, d.id, 1, 'NQ07 WALLET')).rejects.toThrow(
      /drop_id.*recipient_address|claims_drop_id_recipient_address_key|duplicate/i,
    )
    await expect(insertClaim(pool, d.id, 0, 'NQ07 OTHER')).rejects.toThrow(
      /drop_id.*slot_index|claims_drop_id_slot_index_key|duplicate/i,
    )
  })
})
