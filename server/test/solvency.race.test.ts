import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import {
  CapExceededError,
  InsolventError,
  PausedError,
  StaleReconciliationError,
  assertSolvent,
  ledgerBalanceLuna,
  ledgerMovementsLuna,
  lockControls,
  outstandingPrincipalLuna,
  pause,
  reconcile,
} from '../src/services/solvency'
// Side-effect import: installs the int8-as-string type parser so BIGINT luna
// never passes through a lossy JS number. This test builds its own pool, so it
// still depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * `outstandingPrincipalLuna` is a GLOBAL aggregate over every drop in the
 * database, so this suite cannot share tables with the other `*.race.test.ts`
 * files vitest may be running in parallel. It migrates a private Postgres
 * schema and points its own pool's `search_path` at it; the service code uses
 * unqualified table names, so it lands in the private schema unchanged.
 */
const SCHEMA = 'solvency_race_test'

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

let pool: pg.Pool

const CUSTODY = 'NQ07 CUSTODY'

// ---- fixtures ---------------------------------------------------------------

interface DropInput {
  claimCount: number
  amountEachLuna: bigint
  state?: string
  activated?: boolean
}

async function insertDrop(db: Queryable, o: DropInput): Promise<{ id: string }> {
  const activated = o.activated ?? true
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO drops (
       public_id, sponsor_label, claim_count, amount_each_luna, expected_funding_luna,
       state, funding_tx_hash, activated_height, creator_address, refund_address, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
     RETURNING id`,
    [
      randomUUID(),
      'Sponsor',
      o.claimCount,
      o.amountEachLuna.toString(),
      (o.amountEachLuna * BigInt(o.claimCount)).toString(),
      o.state ?? 'live',
      activated ? randomUUID() : null,
      activated ? '1000' : null,
      activated ? 'NQ07 CREATOR' : null,
      activated ? new Date(Date.now() + 86_400_000) : null,
    ],
  )
  return rows[0]
}

async function insertClaim(db: Queryable, dropId: string, slotIndex: number): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
     VALUES ($1, $2, $3, $4, 'reserved')
     RETURNING id`,
    [dropId, slotIndex, `NQ07 CLAIMANT ${randomUUID()}`, randomUUID()],
  )
  return rows[0]
}

async function insertTransfer(
  db: Queryable,
  o: {
    purpose: 'payout' | 'refund'
    dropId: string
    claimId?: string | null
    amountLuna: bigint
    state: 'queued' | 'in_progress' | 'confirmed' | 'manual_review'
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO outgoing_transfers (
       idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      o.purpose === 'payout' ? `payout:${o.claimId}` : `refund:${o.dropId}`,
      o.purpose,
      o.dropId,
      o.claimId ?? null,
      'NQ07 RECIPIENT',
      o.amountLuna.toString(),
      o.state,
    ],
  )
  return rows[0]
}

async function insertAttempt(
  db: Queryable,
  o: {
    transferId: string
    state: 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
    feeLuna?: bigint
  },
): Promise<void> {
  await db.query(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height
     ) VALUES ($1, 1, $2, $3, $4, $5, 1)`,
    [
      o.transferId,
      o.state,
      Buffer.from('00ff', 'hex'),
      randomUUID(),
      (o.feeLuna ?? 0n).toString(),
    ],
  )
}

async function setControls(o: {
  paused?: boolean
  capLuna?: bigint
  feeReserveLuna?: bigint
  /**
   * Operator-attested float: custody money that is not any drop's funding.
   * Since finding 4 this — not the chain balance — is what the invariant can
   * spend, so it is the knob these tests turn to make custody rich or poor.
   */
  operatorFloatLuna?: bigint
  /** Chain cross-check value only; `null` = never reconciled. */
  balanceLuna?: bigint | null
  /** how long ago the last reconciliation happened; `null` = never reconciled */
  reconciledAgoMs?: number | null
}): Promise<void> {
  const balance = o.balanceLuna === undefined ? 10_000_000n : o.balanceLuna
  const agoMs = o.reconciledAgoMs === undefined ? 0 : o.reconciledAgoMs
  await pool.query(
    `UPDATE custody_controls SET
       paused = $1,
       max_live_principal_luna = $2,
       configured_fee_reserve_luna = $3,
       reconciled_confirmed_balance_luna = $4,
       operator_float_luna = $6,
       last_reconciled_height = CASE WHEN $5::float8 IS NULL THEN NULL ELSE 1000 END,
       last_reconciled_at = CASE WHEN $5::float8 IS NULL THEN NULL
                                 ELSE now() - make_interval(secs => $5::float8 / 1000) END
     WHERE singleton`,
    [
      o.paused ?? false,
      (o.capLuna ?? 10_000_000n).toString(),
      (o.feeReserveLuna ?? 100_000n).toString(),
      balance === null ? null : balance.toString(),
      agoMs,
      (o.operatorFloatLuna ?? 10_000_000n).toString(),
    ],
  )
}

/** One caller's "check then reserve" path, exactly as Task 9 activation will do it. */
async function checkThenReserve(client: pg.PoolClient, addLuna: bigint): Promise<void> {
  try {
    const controls = await lockControls(client)
    await assertSolvent(client, controls, addLuna)
    await insertDrop(client, { claimCount: 5, amountEachLuna: addLuna / 5n })
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

// ---- suite ------------------------------------------------------------------

describe.skipIf(!hasDb)('solvency and custody controls (real Postgres)', () => {
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

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       http_idempotency RESTART IDENTITY CASCADE`,
    )
    await setControls({})
  })

  it('counts the entire principal of a fully unclaimed live drop', async () => {
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    // A draft that never received accepted funding owes nothing...
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, state: 'awaiting_funding', activated: false })
    // ...and neither does a terminal drop.
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, state: 'settled' })

    expect(await outstandingPrincipalLuna(pool)).toBe(500n)
  })

  it('reduces outstanding principal only once a payout is finalized', async () => {
    const d = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    const c = await insertClaim(pool, d.id, 0)
    const t = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: d.id,
      claimId: c.id,
      amountLuna: 100n,
      state: 'confirmed',
    })
    await insertAttempt(pool, { transferId: t.id, state: 'confirmed' })

    expect(await outstandingPrincipalLuna(pool)).toBe(400n)
  })

  it('keeps principal outstanding while an attempt is only broadcast', async () => {
    const d = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    const c = await insertClaim(pool, d.id, 0)
    const t = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: d.id,
      claimId: c.id,
      amountLuna: 100n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: t.id, state: 'broadcast' })

    expect(await outstandingPrincipalLuna(pool)).toBe(500n)

    // Even a transfer row optimistically marked confirmed stays outstanding
    // until the ATTEMPT is confirmed: broadcast is not paid.
    await pool.query(`UPDATE outgoing_transfers SET state = 'confirmed' WHERE id = $1`, [t.id])
    expect(await outstandingPrincipalLuna(pool)).toBe(500n)
  })

  it('rejects an activation whose principal would exceed the live cap', async () => {
    await setControls({ capLuna: 900n })
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      await expect(assertSolvent(client, controls, 500n)).rejects.toBeInstanceOf(CapExceededError)
      await expect(assertSolvent(client, controls, 400n)).resolves.toBeUndefined()
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('rejects when the ledger balance cannot cover principal plus the fee reserve', async () => {
    // Float 50 backs a reserve of 100: the drop's own 500 of principal is
    // matched exactly by its funding credit, so the shortfall is the reserve.
    await setControls({ operatorFloatLuna: 50n, feeReserveLuna: 100n })
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      await expect(assertSolvent(client, controls, 0n)).rejects.toBeInstanceOf(InsolventError)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    // Top the float up to the reserve and the same check passes.
    await setControls({ operatorFloatLuna: 100n, feeReserveLuna: 100n })
    const ok = await pool.connect()
    try {
      await ok.query('BEGIN')
      const controls = await lockControls(ok)
      await expect(assertSolvent(ok, controls, 0n)).resolves.toBeUndefined()
      await ok.query('ROLLBACK')
    } finally {
      ok.release()
    }
  })

  // ---- G1 review finding 3: addLuna belongs in the balance requirement --------

  it('refuses an activation whose new principal is not covered once prior fees are spent', async () => {
    // The exact the reviewer scenario. The operator float is exactly the fee reserve,
    // one earlier payout consumed a fee of f out of it, and a sponsor's new
    // principal F is now verified and being activated.
    const FEE = 30n
    const RESERVE = 100n
    await setControls({ operatorFloatLuna: RESERVE, feeReserveLuna: RESERVE })

    // A prior drop that paid out in full, consuming FEE of custody money.
    const prior = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, state: 'settled' })
    const claim = await insertClaim(pool, prior.id, 0)
    const paid = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: prior.id,
      claimId: claim.id,
      amountLuna: 500n,
      state: 'confirmed',
    })
    await insertAttempt(pool, { transferId: paid.id, state: 'confirmed', feeLuna: FEE })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)

      // Before the fix this passed: the check only asked whether the balance
      // covered the CURRENT outstanding principal plus the reserve, never the
      // principal the activation was about to add. The fee that was already
      // spent out of the reserve is the whole gap.
      await expect(assertSolvent(client, controls, 500n)).rejects.toBeInstanceOf(InsolventError)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    // Replace exactly what the fee took and the activation is allowed again.
    await setControls({ operatorFloatLuna: RESERVE + FEE, feeReserveLuna: RESERVE })
    const after = await pool.connect()
    try {
      await after.query('BEGIN')
      const controls = await lockControls(after)
      await expect(assertSolvent(after, controls, 500n)).resolves.toBeUndefined()
      await after.query('ROLLBACK')
    } finally {
      after.release()
    }
  })

  // ---- G1 review finding 4: the invariant runs on the ledger, not the chain ---

  it('derives the balance from finalized funding, payouts and fees', async () => {
    await setControls({ operatorFloatLuna: 1_000n })
    expect(await ledgerMovementsLuna(pool)).toBe(0n)

    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    expect(await ledgerMovementsLuna(pool)).toBe(500n)

    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 100n,
      state: 'in_progress',
    })
    // Broadcast is not paid: neither the principal nor its fee has left the
    // ledger yet, exactly as `outstandingPrincipalLuna` still owes it.
    await insertAttempt(pool, { transferId: transfer.id, state: 'broadcast', feeLuna: 7n })
    expect(await ledgerMovementsLuna(pool)).toBe(500n)

    await pool.query(`UPDATE transaction_attempts SET state = 'confirmed' WHERE transfer_id = $1`, [
      transfer.id,
    ])
    await pool.query(`UPDATE outgoing_transfers SET state = 'confirmed' WHERE id = $1`, [
      transfer.id,
    ])
    expect(await ledgerMovementsLuna(pool)).toBe(500n - 100n - 7n)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      expect(await ledgerBalanceLuna(client, controls)).toBe(1_000n + 393n)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('cannot be made solvent by a chain credit the books never accepted', async () => {
    // Custody is genuinely short: the operator never funded the fee float, so
    // nothing covers the configured reserve.
    await setControls({
      operatorFloatLuna: 0n,
      feeReserveLuna: 100n,
      balanceLuna: null,
      reconciledAgoMs: null,
    })
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })

    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'operator-float',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 100n,
      includedHeight: 1,
    })
    chain.deposit({
      hash: 'accepted-funding',
      sender: 'NQ07 SPONSOR',
      recipient: CUSTODY,
      valueLuna: 500n,
      includedHeight: 2,
    })
    // A stranger's deposit that funds no drop. The old invariant read the chain
    // balance, so this money counted as capacity for anyone.
    chain.deposit({
      hash: 'unrelated-deposit',
      sender: 'NQ07 STRANGER',
      recipient: CUSTODY,
      valueLuna: 10_000n,
      includedHeight: 3,
    })
    chain.setHead(50)
    await reconcile(pool, chain)

    const { rows } = await pool.query<{ balance: string }>(
      'SELECT reconciled_confirmed_balance_luna AS balance FROM custody_controls',
    )
    expect(BigInt(rows[0].balance), 'the chain balance is still recorded').toBe(10_600n)

    // That recorded balance is what the old invariant compared against, and
    // 10_600 >= 500 + 100 would have passed. The ledger knows better: it counts
    // one accepted funding transaction and an operator float of zero, so every
    // money path stays closed.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      await expect(assertSolvent(client, controls, 0n)).rejects.toBeInstanceOf(InsolventError)
      await expect(assertSolvent(client, controls, 500n)).rejects.toBeInstanceOf(InsolventError)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    // The reorg that takes the phantom credit away changes nothing at all —
    // which is the point: it was never spendable, so it cannot be lost, and the
    // chain sitting above the ledger is normal rather than an alarm.
    expect(chain.removeTx('unrelated-deposit')).toBe(true)
    await reconcile(pool, chain)
    const again = await pool.connect()
    try {
      await again.query('BEGIN')
      const controls = await lockControls(again)
      expect(controls.paused).toBe(false)
      await expect(assertSolvent(again, controls, 0n)).rejects.toBeInstanceOf(InsolventError)
      await again.query('ROLLBACK')
    } finally {
      again.release()
    }
  })

  it('pauses and alerts when the chain holds LESS than the books claim', async () => {
    const alerted: { alert: string; detail: Record<string, unknown> }[] = []
    const alerts = {
      async notify(alert: string, detail: Record<string, unknown>) {
        alerted.push({ alert, detail })
      },
    }

    // The books say 5000 of operator float; the chain has 600.
    await setControls({ operatorFloatLuna: 5_000n })
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'short-float',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n,
      includedHeight: 1,
    })
    chain.setHead(20)

    await reconcile(pool, chain, alerts)

    const { rows } = await pool.query<{ paused: boolean; balance: string }>(
      'SELECT paused, reconciled_confirmed_balance_luna AS balance FROM custody_controls',
    )
    expect(rows[0].paused, 'a shortfall must fail every money path closed').toBe(true)
    expect(BigInt(rows[0].balance)).toBe(600n)

    const insolvent = alerted.filter((a) => a.alert === 'insolvent')
    expect(insolvent).toHaveLength(1)
    // Both numbers, so the operator can see the size of the hole immediately.
    expect(insolvent[0].detail).toMatchObject({
      reason: 'chain_below_ledger',
      chainBalanceLuna: '600',
      ledgerBalanceLuna: '5000',
      shortfallLuna: '4400',
    })
  })

  it('does not mistake an in-flight payout for a shortfall', async () => {
    await setControls({ operatorFloatLuna: 100n })
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 100n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: transfer.id, state: 'broadcast', feeLuna: 5n })

    // The chain has already debited the payment and its fee; our ledger waits
    // for finality. That gap is expected, not a shortfall.
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'float-and-funding',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n - 105n,
      includedHeight: 1,
    })
    chain.setHead(20)

    await reconcile(pool, chain)

    const { rows } = await pool.query<{ paused: boolean }>('SELECT paused FROM custody_controls')
    expect(rows[0].paused).toBe(false)
  })

  it('serializes two concurrent check-then-reserve paths on the controls lock', async () => {
    await setControls({ capLuna: 500n })
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const results = await Promise.allSettled([checkThenReserve(a, 500n), checkThenReserve(b, 500n)])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CapExceededError)
    } finally {
      a.release()
      b.release()
    }

    // Exactly one reservation survived; the cap was never breached.
    expect(await outstandingPrincipalLuna(pool)).toBe(500n)
    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM drops')
    expect(rows[0].count).toBe('1')
  })

  it('refuses to operate on a stale reconciliation', async () => {
    await setControls({ reconciledAgoMs: 11 * 60 * 1000 })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(lockControls(client)).rejects.toBeInstanceOf(StaleReconciliationError)
      await client.query('ROLLBACK')

      await setControls({ reconciledAgoMs: null, balanceLuna: null })
      await client.query('BEGIN')
      await expect(lockControls(client)).rejects.toBeInstanceOf(StaleReconciliationError)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('refuses to operate while paused', async () => {
    await pause(pool, 'operator drill')
    const { rows } = await pool.query<{ paused: boolean }>('SELECT paused FROM custody_controls')
    expect(rows[0].paused).toBe(true)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(lockControls(client)).rejects.toBeInstanceOf(PausedError)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('reconciles chain balance and height, clearing staleness', async () => {
    await setControls({ reconciledAgoMs: null, balanceLuna: null, operatorFloatLuna: 0n })
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'f1',
      sender: 'NQ07 ALICE',
      recipient: CUSTODY,
      valueLuna: 750n,
      dataUtf8: 'ND1:abc',
      includedHeight: 3,
    })
    chain.setHead(42)

    await reconcile(pool, chain)

    const { rows } = await pool.query<{
      reconciled_confirmed_balance_luna: string
      last_reconciled_height: string
      age_seconds: string
    }>(
      `SELECT reconciled_confirmed_balance_luna, last_reconciled_height,
              extract(epoch from now() - last_reconciled_at)::text AS age_seconds
       FROM custody_controls`,
    )
    expect(BigInt(rows[0].reconciled_confirmed_balance_luna)).toBe(750n)
    expect(BigInt(rows[0].last_reconciled_height)).toBe(42n)
    expect(Number(rows[0].age_seconds)).toBeLessThan(5)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      expect(controls.reconciledConfirmedBalanceLuna).toBe(750n)
      expect(controls.lastReconciledHeight).toBe(42)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
