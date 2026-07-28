import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testAddress } from './fixtures/address'
import { migrate } from '../src/db/migrate'
import { issueGrant } from '../src/gates/grants'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Private schema, private pool. `gate_grants` is keyed on drops, and the other
 * `*.race.test.ts` suites vitest runs in parallel truncate `drops` freely.
 */
const SCHEMA = 'gate_grants_test'

const WALLET = testAddress('WALLET')

describe.skipIf(!hasDb)('issueGrant', () => {
  let pool: pg.Pool
  let dropId: string

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** A live drop carrying a gate. Only the columns the CHECKs require are set. */
  async function gatedDrop(kind = 'passphrase'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'g', 20, 100000, 2000000, 'live')
       RETURNING id`,
      [`g-${Math.random().toString(36).slice(2, 14)}`],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, $2, '{}'::jsonb)`,
      [rows[0].id, kind],
    )
    return rows[0].id
  }

  beforeEach(async () => {
    await pool.query('DELETE FROM gate_grants')
    await pool.query('DELETE FROM drop_gates')
    await pool.query('DELETE FROM drops')
    dropId = await gatedDrop()
  })

  const grant = (walletAddress = WALLET, kind: 'trivia' | 'passphrase' = 'passphrase') =>
    issueGrant(pool, { dropId, walletAddress, kind })

  const countGrants = async () =>
    (await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')).rows[0].count

  it('creates a grant and reports it fresh', async () => {
    await expect(grant()).resolves.toMatchObject({ fresh: true })
    expect(await countGrants()).toBe('1')
  })

  it('records the kind that issued it', async () => {
    await grant(WALLET, 'trivia')
    const { rows } = await pool.query<{ kind: string }>('SELECT kind FROM gate_grants')
    expect(rows[0].kind).toBe('trivia')
  })

  // A double-tapped button and a retried request both land here. A unique
  // violation escaping as a 500 would read to a player as the condition they
  // just satisfied not counting.
  it('is idempotent, and reports the second call not fresh', async () => {
    const first = await grant()
    const again = await grant()
    expect(again.grantId).toBe(first.grantId)
    expect(again.fresh).toBe(false)
    expect(await countGrants()).toBe('1')
  })

  it('survives concurrent callers without throwing', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => grant()))
    expect(new Set(results.map((r) => r.grantId)).size).toBe(1)
    // Exactly one caller may claim to have created it, or the caller that did
    // not create it could report success it did not earn.
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    expect(await countGrants()).toBe('1')
  })

  it('keeps wallets independent on one drop', async () => {
    await grant(testAddress('ALICE'))
    await grant(testAddress('BOB'))
    expect(await countGrants()).toBe('2')
  })

  it('keeps drops independent for one wallet', async () => {
    const other = await gatedDrop()
    await grant()
    await issueGrant(pool, { dropId: other, walletAddress: WALLET, kind: 'passphrase' })
    expect(await countGrants()).toBe('2')
  })

  it('leaves a fresh grant unconsumed, so the claim path can spend it', async () => {
    const { grantId } = await grant()
    const { rows } = await pool.query<{ consumed_claim_id: string | null }>(
      'SELECT consumed_claim_id FROM gate_grants WHERE id = $1',
      [grantId],
    )
    expect(rows[0].consumed_claim_id).toBeNull()
  })

  it('stores the payout fraction when given one', async () => {
    await issueGrant(pool, { dropId, walletAddress: WALLET, kind: 'trivia', payoutPermille: 600 })
    const { rows } = await pool.query<{ payout_permille: number | null }>(
      'SELECT payout_permille FROM gate_grants WHERE wallet_address = $1',
      [WALLET],
    )
    expect(rows[0].payout_permille).toBe(600)
  })

  it('leaves the payout fraction null when omitted', async () => {
    await grant()
    const { rows } = await pool.query<{ payout_permille: number | null }>(
      'SELECT payout_permille FROM gate_grants WHERE wallet_address = $1',
      [WALLET],
    )
    expect(rows[0].payout_permille).toBeNull()
  })

  // The CHECK is `> 0 AND <= 1000`, not merely "looks like a fraction": zero
  // would be a grant for nothing, which a failed session never issues, and a
  // failed insert here is preferable to a slot silently consumed for no share.
  it('rejects a payout fraction outside the valid range', async () => {
    await expect(
      issueGrant(pool, { dropId, walletAddress: WALLET, kind: 'trivia', payoutPermille: 0 }),
    ).rejects.toThrow(/payout_permille/)
    await expect(
      issueGrant(pool, { dropId, walletAddress: WALLET, kind: 'trivia', payoutPermille: 1001 }),
    ).rejects.toThrow(/payout_permille/)
  })

  it('returns the existing grant even after it has been consumed', async () => {
    // A wallet that already claimed may still re-submit the condition — the
    // page it is on does not know the claim happened. It must not get a second
    // grant, and it must not get an error either.
    const first = await grant()
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
       VALUES ($1, 0, $2, $3, 'reserved') RETURNING id`,
      [dropId, WALLET, `hash-${Math.random()}`],
    )
    await pool.query('UPDATE gate_grants SET consumed_claim_id = $2 WHERE id = $1', [
      first.grantId,
      rows[0].id,
    ])

    const again = await grant()
    expect(again).toEqual({ grantId: first.grantId, fresh: false })
    expect(await countGrants()).toBe('1')
  })
})
