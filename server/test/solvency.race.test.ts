import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import type { Alerts } from '../src/services/alerts'
import {
  CapExceededError,
  InsolventError,
  PausedError,
  StaleReconciliationError,
  UnreconciledShortfallError,
  assertSolvent,
  inFlightOutgoingLuna,
  ledgerBalanceLuna,
  ledgerMovementsLuna,
  lockControls,
  outstandingPrincipalLuna,
  pause,
  readControls,
  reconcile,
  unpause,
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
    /** Wall-clock age. Since round-3 R4 the in-flight bound no longer reads it. */
    createdAgoSeconds?: number
    /** The height the bytes were signed against; the in-flight bound reads THIS. */
    validityStartHeight?: number
    /**
     * Whether a broadcast was ever attempted (migration 010). A `signed`
     * attempt with this set is the ambiguous case: the bytes may be on the
     * network and the chain may already have debited them.
     */
    broadcastAttempted?: boolean
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height,
       created_at, broadcast_attempted_at
     ) VALUES ($1, 1, $2, $3, $4, $5, $7, now() - make_interval(secs => $6::float8),
       CASE WHEN $8::bool THEN now() ELSE NULL END)
     RETURNING id`,
    [
      o.transferId,
      o.state,
      Buffer.from('00ff', 'hex'),
      randomUUID(),
      (o.feeLuna ?? 0n).toString(),
      o.createdAgoSeconds ?? 0,
      (o.validityStartHeight ?? 1).toString(),
      o.broadcastAttempted ?? o.state !== 'signed',
    ],
  )
  return rows[0].id
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
                                 ELSE now() - make_interval(secs => $5::float8 / 1000) END,
       -- Round-3 R3: the shortfall verdict and the observation generation are
       -- part of the controls row every test starts from.
       reconcile_observed_seq = 0,
       shortfall_detected_at = NULL,
       shortfall_observed_height = NULL
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
       operator_float_deposits, http_idempotency RESTART IDENTITY CASCADE`,
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

  // ---- N1: a stale attempt is not an alibi for a missing balance -----------------

  /**
   * Recording alerts so a test can assert not only that custody paused but that
   * an operator was told why.
   */
  function spyAlerts(): { alerts: Alerts; seen: { alert: string; detail: Record<string, unknown> }[] } {
    const seen: { alert: string; detail: Record<string, unknown> }[] = []
    return {
      seen,
      alerts: {
        async notify(alert, detail) {
          seen.push({ alert, detail })
        },
      },
    }
  }

  it('an ancient signed-but-never-broadcast attempt no longer hides a chain shortfall', async () => {
    // Books: 5000 luna of operator float and nothing else (the drop is a draft,
    // so it contributes no funding movement and no outstanding principal).
    await setControls({ operatorFloatLuna: 5_000n })
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, activated: false })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 4_395n,
      state: 'in_progress',
    })
    // Signed three hours ago and never acknowledged by the network: the bytes
    // never left this process, and their validity window is long past.
    await insertAttempt(pool, {
      transferId: transfer.id,
      state: 'signed',
      feeLuna: 5n,
      createdAgoSeconds: 3 * 3600,
    })

    // The chain holds 600. Under the old unbounded offset this attempt's 4400
    // "explained" the gap exactly (5000 − 4400 = 600) and the shortfall was
    // invisible for as long as the attempt stayed open — forever, in practice.
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'short-with-stale-attempt',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n,
      includedHeight: 1,
    })
    chain.setHead(20)

    const spy = spyAlerts()
    await reconcile(pool, chain, spy.alerts)

    const { rows } = await pool.query<{ paused: boolean; shortfall_at: Date | null }>(
      'SELECT paused, shortfall_detected_at AS shortfall_at FROM custody_controls',
    )
    expect(rows[0].paused, 'the shortfall is real and must fail every money path closed').toBe(true)
    expect(rows[0].shortfall_at).not.toBeNull()

    const insolvent = spy.seen.filter((a) => a.alert === 'insolvent')
    expect(insolvent).toHaveLength(1)
    expect(insolvent[0].detail).toMatchObject({
      reason: 'chain_below_ledger',
      chainBalanceLuna: '600',
      ledgerBalanceLuna: '5000',
      inFlightOutgoingLuna: '0',
      shortfallLuna: '4400',
    })

    // And the excluded attempt is itself reported: money the books have
    // committed to sending that the chain will never take.
    const flagged = spy.seen.filter((a) => a.detail.reason === 'stale_in_flight_attempt')
    expect(flagged).toHaveLength(1)
    expect(flagged[0].alert).toBe('manual_review')
    expect(flagged[0].detail).toMatchObject({
      staleAttempts: 1,
      neverBroadcast: 1,
      lunaTotal: '4400',
    })
  })

  it('still counts a freshly broadcast attempt as the explanation it is', async () => {
    await setControls({ operatorFloatLuna: 5_000n })
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, activated: false })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 4_395n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: transfer.id, state: 'broadcast', feeLuna: 5n })

    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'in-flight-explains-it',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n,
      includedHeight: 1,
    })
    chain.setHead(20)

    const spy = spyAlerts()
    await reconcile(pool, chain, spy.alerts)

    const { rows } = await pool.query<{ paused: boolean }>('SELECT paused FROM custody_controls')
    expect(rows[0].paused, 'a payment the chain has genuinely taken is not a shortfall').toBe(false)
    expect(spy.seen).toHaveLength(0)
  })

  // ---- R4: ambiguous broadcasts, and a height-based in-flight bound ---------------

  /**
   * A 4_395-luna payout plus a 5-luna fee against 5_000 of float, with the
   * chain holding the 600 that leaves. Whether that reads as a shortfall is
   * entirely a question of whether the attempt is allowed to explain it.
   */
  async function payoutAgainstDebitedChain(o: {
    state: 'signed' | 'broadcast'
    broadcastAttempted?: boolean
    validityStartHeight?: number
    createdAgoSeconds?: number
  }): Promise<FakeChain> {
    await setControls({ operatorFloatLuna: 5_000n })
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, activated: false })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 4_395n,
      state: 'in_progress',
    })
    await insertAttempt(pool, { transferId: transfer.id, feeLuna: 5n, ...o })

    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: `custody-${randomUUID()}`,
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n,
      includedHeight: 1,
    })
    chain.setHead(1_000)
    return chain
  }

  it('an AMBIGUOUS broadcast explains the money the chain took, and does not pause custody', async () => {
    // Crash window (b), which the G1 harness produces on purpose: the network
    // accepted the transaction and the process died before `markBroadcast`. The
    // row still says `signed`, but `broadcast_attempted_at` is set, so the
    // chain really can have debited it — and on restart the cross-check must
    // not read its own payment as a hole in custody.
    const chain = await payoutAgainstDebitedChain({
      state: 'signed',
      broadcastAttempted: true,
      validityStartHeight: 990,
    })

    const spy = spyAlerts()
    await reconcile(pool, chain, spy.alerts, { windowBlocks: 100 })

    const controls = await readControls(pool)
    expect(controls.paused, 'an ambiguous broadcast is a payment, not a shortfall').toBe(false)
    expect(controls.shortfallDetectedAt).toBeNull()
    expect(spy.seen).toHaveLength(0)
  })

  it('…while an attempt whose bytes never left still does not', async () => {
    // The control. Same numbers, same state on the row, one difference: nothing
    // ever tried to broadcast it, so it cannot be where the money went.
    const chain = await payoutAgainstDebitedChain({
      state: 'signed',
      broadcastAttempted: false,
      validityStartHeight: 990,
    })

    const spy = spyAlerts()
    await reconcile(pool, chain, spy.alerts, { windowBlocks: 100 })

    const controls = await readControls(pool)
    expect(controls.paused).toBe(true)
    expect(controls.shortfallDetectedAt).not.toBeNull()
    expect(spy.seen.filter((a) => a.detail.neverBroadcast === 1)).toHaveLength(1)
  })

  it('bounds the in-flight offset by the validity HEIGHT, not by wall-clock age', async () => {
    // Signed three hours ago against a height the head has not passed. On a
    // chain that stalled, or under any clock skew, the old age bound dropped
    // this from the offset while the transaction was still perfectly
    // includable — and the payment it then could not explain false-paused
    // custody.
    const chain = await payoutAgainstDebitedChain({
      state: 'broadcast',
      createdAgoSeconds: 3 * 3600,
      validityStartHeight: 990,
    })

    await reconcile(pool, chain, spyAlerts().alerts, { windowBlocks: 100 })

    const controls = await readControls(pool)
    expect(controls.paused, 'a still-includable transaction explains the debit').toBe(false)
  })

  it('…and drops it the moment the head passes that height', async () => {
    // The other side of the same bound: past `validity_start_height + window`
    // nobody can include these bytes, so they can never explain missing money
    // however recently they were signed.
    const chain = await payoutAgainstDebitedChain({
      state: 'broadcast',
      createdAgoSeconds: 0,
      validityStartHeight: 100,
    })

    await reconcile(pool, chain, spyAlerts().alerts, { windowBlocks: 100 })

    const controls = await readControls(pool)
    expect(controls.paused, 'an unincludable transaction is not an alibi').toBe(true)
  })

  // ---- R3: a reconciliation verdict is owned by the newest observation -------------

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {}
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('a stalled clean pass cannot erase a shortfall stamped from a later observation', async () => {
    await setControls({ operatorFloatLuna: 5_000n })
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'custody-healthy',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 5_000n,
      includedHeight: 1,
    })
    chain.setHead(20)

    // 1. Pass A observes a healthy chain, then stalls before its write. The
    //    worker runs one of these every 60s and every activation runs another,
    //    so two in flight at once is ordinary, not exotic.
    const observed = deferred()
    const release = deferred()
    const passA = reconcile(pool, chain, spyAlerts().alerts, {
      onObserved: async () => {
        observed.resolve()
        await release.promise
      },
    })
    await observed.promise

    // 2. Money leaves custody out of band — the condition the cross-check exists
    //    for.
    chain.deposit({
      hash: 'out-of-band-debit',
      sender: CUSTODY,
      recipient: 'NQ07 ELSEWHERE',
      valueLuna: 4_000n,
      includedHeight: 2,
    })

    // 3. Pass B sees it, stamps the verdict and pauses.
    const passB = await reconcile(pool, chain, spyAlerts().alerts)
    expect(passB.short).toBe(true)
    expect(passB.accepted).toBe(true)
    const afterB = await readControls(pool)
    expect(afterB.shortfallDetectedAt).not.toBeNull()

    // 4. Pass A finally writes. Its `ELSE NULL` used to clear B's verdict, and
    //    an operator's `unpause` then reopened every money path against a
    //    wallet already observed short.
    release.resolve()
    const resultA = await passA
    expect(resultA.accepted, 'an older observation must not overwrite a newer one').toBe(false)

    const afterA = await readControls(pool)
    expect(afterA.shortfallDetectedAt, 'the newer shortfall verdict must stand').not.toBeNull()
    expect(afterA.shortfallDetectedAt?.getTime()).toBe(afterB.shortfallDetectedAt?.getTime())
    expect(afterA.paused).toBe(true)
    // And the verdict still outlives an operator's `unpause` (N3), which is
    // the whole reason erasing it mattered.
    await unpause(pool)
    await expect(moneyPathWouldPass()).rejects.toBeInstanceOf(UnreconciledShortfallError)
  })

  it('a clean pass from an OLDER chain head cannot clear a standing shortfall', async () => {
    await setControls({ operatorFloatLuna: 5_000n })

    // The shortfall is observed at head 1000.
    const short = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    short.deposit({
      hash: 'custody-partial',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 1_000n,
      includedHeight: 1,
    })
    short.setHead(1_000)
    expect((await reconcile(pool, short, spyAlerts().alerts)).short).toBe(true)
    const stamped = (await readControls(pool)).shortfallDetectedAt
    expect(stamped).not.toBeNull()

    // A second process, whose node is behind, finishes an observation later and
    // reports a healthy wallet — as of a view of the chain that predates the
    // money leaving. It may refresh the numbers; it may not overrule a verdict
    // formed from a later view.
    const lagging = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    lagging.deposit({
      hash: 'custody-full',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 5_000n,
      includedHeight: 1,
    })
    lagging.setHead(500)
    const stale = await reconcile(pool, lagging, spyAlerts().alerts)
    expect(stale.accepted, 'the numbers are refreshed').toBe(true)

    const after = await readControls(pool)
    expect(after.shortfallDetectedAt?.getTime()).toBe(stamped?.getTime())

    // Caught up, the same healthy reading does clear it.
    lagging.setHead(1_100)
    await reconcile(pool, lagging, spyAlerts().alerts)
    expect((await readControls(pool)).shortfallDetectedAt).toBeNull()
  })

  // ---- N3: a shortfall outlives `unpause` -----------------------------------------

  /** Take the controls and run the invariant, exactly as every money path does. */
  async function moneyPathWouldPass(): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const controls = await lockControls(client)
      await assertSolvent(client, controls, 0n)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  it('unpause alone cannot resume signing after a shortfall — only a clean reconcile can', async () => {
    await setControls({ operatorFloatLuna: 5_000n, feeReserveLuna: 0n })
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'not-enough',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 600n,
      includedHeight: 1,
    })
    chain.setHead(20)

    await reconcile(pool, chain)
    expect((await readControls(pool)).paused).toBe(true)
    expect((await readControls(pool)).shortfallDetectedAt).not.toBeNull()

    // The operator clears the switch. The reconciliation behind the pause was
    // FAILED but it is also FRESH, so staleness will not save us here — this is
    // exactly the window in which signing used to resume.
    await unpause(pool)
    expect((await readControls(pool)).paused).toBe(false)
    await expect(moneyPathWouldPass()).rejects.toBeInstanceOf(UnreconciledShortfallError)
    // …and it is still an insolvency to every existing handler.
    await expect(moneyPathWouldPass()).rejects.toBeInstanceOf(InsolventError)

    // Reconciling while the hole is still there keeps it closed AND re-pauses.
    await reconcile(pool, chain)
    expect((await readControls(pool)).paused).toBe(true)
    await unpause(pool)
    await expect(moneyPathWouldPass()).rejects.toBeInstanceOf(UnreconciledShortfallError)

    // The operator tops custody up for real. Now — and only now — a clean
    // reconcile clears the flag and the money paths reopen.
    chain.deposit({
      hash: 'topped-up',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 4_400n,
      includedHeight: 2,
    })
    await reconcile(pool, chain)

    expect((await readControls(pool)).shortfallDetectedAt).toBeNull()
    await expect(moneyPathWouldPass()).resolves.toBeUndefined()
  })

  it('keeps the first sighting time across repeated failing reconciles', async () => {
    await setControls({ operatorFloatLuna: 5_000n })
    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.setHead(20)

    await reconcile(pool, chain)
    const first = (await readControls(pool)).shortfallDetectedAt
    expect(first).not.toBeNull()

    await reconcile(pool, chain)
    expect((await readControls(pool)).shortfallDetectedAt?.getTime()).toBe(first?.getTime())
  })

  // ---- N4: one snapshot, one instant ------------------------------------------------

  /**
   * A `Pool` that runs `after(sql)` once, immediately after the first query on a
   * pooled client whose text matches `marker`.
   *
   * Used to commit a confirmation from a SECOND connection in the middle of
   * `reconcile()`'s reads. The patch is removed when the client goes back to the
   * pool, so no other caller ever sees it.
   */
  function poolInterleaving(marker: string, after: () => Promise<void>): pg.Pool {
    let fired = false
    const wrapper = {
      connect: async () => {
        const client = await pool.connect()
        const query = client.query.bind(client)
        const release = client.release.bind(client)
        const patched = {
          query: async (...args: unknown[]) => {
            const result = await (query as (...a: unknown[]) => Promise<unknown>)(...args)
            const sql = typeof args[0] === 'string' ? args[0] : ''
            if (!fired && sql.includes(marker)) {
              fired = true
              await after()
            }
            return result
          },
          release: (...args: unknown[]) => {
            Object.assign(client, { query, release })
            return (release as (...a: unknown[]) => unknown)(...args)
          },
        }
        Object.assign(client, patched)
        return client
      },
      query: (...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args),
    }
    return wrapper as unknown as pg.Pool
  }

  /**
   * Float 5000, one activated 500-luna drop, one 400-luna payout with a 5-luna
   * fee that the chain has already taken. Whatever instant you look at, the
   * smallest balance the books can explain is 5000 + 500 − 400 − 5 = 5095, and
   * the chain holds exactly that. Nothing here is a shortfall.
   */
  async function aboutToConfirm(): Promise<{ chain: FakeChain; transferId: string; attemptId: string }> {
    await setControls({ operatorFloatLuna: 5_000n })
    const drop = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    const claim = await insertClaim(pool, drop.id, 0)
    const transfer = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: drop.id,
      claimId: claim.id,
      amountLuna: 400n,
      state: 'in_progress',
    })
    const attemptId = await insertAttempt(pool, {
      transferId: transfer.id,
      state: 'broadcast',
      feeLuna: 5n,
    })

    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
    chain.deposit({
      hash: 'custody-holdings',
      sender: 'NQ07 OPERATOR',
      recipient: CUSTODY,
      valueLuna: 5_095n,
      includedHeight: 1,
    })
    chain.setHead(20)
    return { chain, transferId: transfer.id, attemptId }
  }

  /**
   * The head `aboutToConfirm`'s chain sits at. The in-flight offset is bounded
   * by the attempt's own validity height against the head (round-3 R4), so the
   * direct calls below must be made against the same head `reconcile()` uses.
   */
  const SNAPSHOT_HEAD = 20

  /** The worker's confirmation, committed atomically from another connection. */
  async function confirmPayment(transferId: string, attemptId: string): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE transaction_attempts SET state = 'confirmed', confirmed_height = 10 WHERE id = $1`,
        [attemptId],
      )
      await client.query(`UPDATE outgoing_transfers SET state = 'confirmed' WHERE id = $1`, [
        transferId,
      ])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  }

  it('a confirmation landing between the reads is a seam, not a shortfall', async () => {
    const { chain, transferId, attemptId } = await aboutToConfirm()

    // The confirmation commits after the ledger read and before the in-flight
    // read. In autocommit that pair says: 5500 of ledger (the payout not yet
    // deducted) and 0 in flight (the attempt no longer open) — an explainable
    // minimum of 5500 against a chain holding 5095, i.e. a 405-luna hole that
    // never existed at any single instant.
    const interleaved = poolInterleaving('movements_luna', () =>
      confirmPayment(transferId, attemptId),
    )
    await reconcile(interleaved, chain)

    const controls = await readControls(pool)
    expect(controls.paused, 'an interleaved confirmation must not invent a shortfall').toBe(false)
    expect(controls.shortfallDetectedAt).toBeNull()
  })

  it('the interleaving the snapshot defends against is real', async () => {
    // The control for the test above: taken as three autocommit reads, the same
    // interleaving genuinely does produce a pair no instant could produce.
    const { transferId, attemptId } = await aboutToConfirm()

    const controls = await readControls(pool)
    const ledgerBefore = await ledgerBalanceLuna(pool, controls)
    await confirmPayment(transferId, attemptId)
    const inFlightAfter = await inFlightOutgoingLuna(pool, SNAPSHOT_HEAD)

    expect(ledgerBefore).toBe(5_500n)
    expect(inFlightAfter).toBe(0n)
    // 5500 − 0 = 5500 > 5095: the false shortfall, reproduced.
    expect(ledgerBefore - inFlightAfter).toBeGreaterThan(5_095n)

    // Read as one snapshot instead, the same two numbers agree.
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      const snapControls = await readControls(client)
      const ledger = await ledgerBalanceLuna(client, snapControls)
      const inFlight = await inFlightOutgoingLuna(client, SNAPSHOT_HEAD)
      await client.query('COMMIT')
      expect(ledger - inFlight).toBe(5_095n)
    } finally {
      client.release()
    }
  })
})
