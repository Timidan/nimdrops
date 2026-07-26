import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import {
  ChainUnavailableError,
  InvalidLunaError,
  OverAttestationError,
  USAGE,
  floatShow,
  main,
  setOperatorFloat,
  statusReport,
} from '../src/recover'
import { InsolventError, assertSolvent, lockControls, readControls } from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * `float` and `status` read GLOBAL aggregates (`ledgerMovementsLuna`,
 * `outstandingPrincipalLuna`, per-table state counts) and take the singleton
 * `custody_controls` row, so this suite cannot share tables with the other
 * `*.race.test.ts` files vitest runs in parallel. It migrates a private
 * Postgres schema and points its own pool's `search_path` at it; the service
 * code uses unqualified table names, so it lands in the private schema
 * unchanged.
 */
const SCHEMA = 'recover_ops_race_test'

const CUSTODY = 'NQ07 CUSTODY'

let pool: pg.Pool
let chain: FakeChain

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

// ---- chain doubles -------------------------------------------------------------

/** Delegating ChainClient so a single method can be made to fail. */
function chainWith(base: FakeChain, over: Partial<ChainClient>): ChainClient {
  const delegate: ChainClient = {
    network: () => base.network(),
    custodyAddress: () => base.custodyAddress(),
    headHeight: () => base.headHeight(),
    isFinal: (tx, head) => base.isFinal(tx, head),
    getTransaction: (hash) => base.getTransaction(hash),
    confirmedBalanceLuna: (address) => base.confirmedBalanceLuna(address),
    buildSignedBasic: (o) => base.buildSignedBasic(o),
    broadcast: (raw) => base.broadcast(raw),
  }
  return { ...delegate, ...over }
}

/** Put `luna` into custody on the fake chain (an operator top-up). */
function topUpCustody(luna: bigint): void {
  chain.deposit({
    hash: `topup-${randomUUID()}`,
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: luna,
    includedHeight: 1,
  })
}

// ---- fixtures ------------------------------------------------------------------

interface DropInput {
  claimCount?: number
  amountEachLuna?: bigint
  state?: string
  activated?: boolean
}

async function insertDrop(db: Queryable, o: DropInput = {}): Promise<{ id: string }> {
  const activated = o.activated ?? true
  const claimCount = o.claimCount ?? 5
  const amountEach = o.amountEachLuna ?? 100n
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO drops (
       public_id, sponsor_label, claim_count, amount_each_luna, expected_funding_luna,
       state, funding_tx_hash, activated_height, creator_address, refund_address, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
     RETURNING id`,
    [
      randomUUID(),
      'Sponsor',
      claimCount,
      amountEach.toString(),
      (amountEach * BigInt(claimCount)).toString(),
      o.state ?? 'live',
      activated ? randomUUID() : null,
      activated ? '1000' : null,
      activated ? 'NQ07 CREATOR' : null,
      activated ? new Date(Date.now() + 86_400_000) : null,
    ],
  )
  return rows[0]
}

async function insertClaim(
  db: Queryable,
  dropId: string,
  slotIndex: number,
  state = 'reserved',
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [dropId, slotIndex, `NQ07 CLAIMANT ${randomUUID()}`, randomUUID(), state],
  )
  return rows[0]
}

async function insertTransfer(
  db: Queryable,
  o: {
    purpose: 'payout' | 'refund'
    dropId: string
    claimId?: string | null
    amountLuna?: bigint
    state: 'queued' | 'in_progress' | 'confirmed' | 'manual_review'
    createdAgoSeconds?: number
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO outgoing_transfers (
       idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       now() - make_interval(secs => $8::float8))
     RETURNING id`,
    [
      o.purpose === 'payout' ? `payout:${o.claimId}` : `refund:${o.dropId}`,
      o.purpose,
      o.dropId,
      o.claimId ?? null,
      'NQ07 RECIPIENT',
      (o.amountLuna ?? 100n).toString(),
      o.state,
      o.createdAgoSeconds ?? 0,
    ],
  )
  return rows[0]
}

async function insertAttempt(
  db: Queryable,
  o: {
    transferId: string
    sequence?: number
    state: 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
    feeLuna?: bigint
    createdAgoSeconds?: number
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, now() - make_interval(secs => $7::float8))
     RETURNING id`,
    [
      o.transferId,
      o.sequence ?? 1,
      o.state,
      Buffer.from('00ff', 'hex'),
      randomUUID(),
      (o.feeLuna ?? 0n).toString(),
      o.createdAgoSeconds ?? 0,
    ],
  )
  return rows[0]
}

async function setControls(o: {
  paused?: boolean
  capLuna?: bigint
  feeReserveLuna?: bigint
  operatorFloatLuna?: bigint
  balanceLuna?: bigint | null
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
      (o.operatorFloatLuna ?? 0n).toString(),
    ],
  )
}

/** The activation path's solvency gate, exactly as `activate()` runs it. */
async function activationWouldPass(addLuna: bigint): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const controls = await lockControls(client)
    await assertSolvent(client, controls, addLuna)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---- help (no database needed) --------------------------------------------------

describe('recover CLI help', () => {
  const SUBCOMMANDS = [
    'status',
    'resume',
    'replace',
    'deposits',
    'float show',
    'float set',
    'pause',
    'unpause',
  ]

  it('names every subcommand, with a description and an example for each', () => {
    for (const name of SUBCOMMANDS) {
      expect(USAGE).toContain(name)
    }
    // One worked example per subcommand, plus the `--help` line itself.
    const examples = USAGE.match(/^ {6}example: /gm) ?? []
    expect(examples.length).toBe(SUBCOMMANDS.length)
    expect(USAGE).toContain('--help')
  })

  it('prints the full usage block on --help and exits 0', async () => {
    const printed: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    try {
      expect(await main(['--help'])).toBe(0)
    } finally {
      console.log = original
    }
    const out = printed.join('\n')
    for (const name of SUBCOMMANDS) expect(out).toContain(name)
  })

  it('prints usage to stderr and exits 2 when given no command', async () => {
    const printed: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    try {
      expect(await main([])).toBe(2)
      expect(await main(['float'])).toBe(2)
      expect(await main(['float', 'nonsense'])).toBe(2)
      expect(await main(['float', 'set'])).toBe(2)
    } finally {
      console.error = original
    }
    expect(printed.join('\n')).toContain('float set <luna>')
  })
})

// ---- database-backed suite ------------------------------------------------------

describe.skipIf(!hasDb)('operator float and status (real Postgres)', () => {
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
    await pool.query('UPDATE custody_controls SET network = NULL WHERE singleton')
    await setControls({})
    chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5 })
  })

  // ---- float set --------------------------------------------------------------

  it('refuses a float that would attest more than the chain actually holds', async () => {
    topUpCustody(200_000n)
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n }) // +500 ledger movements

    await expect(setOperatorFloat(pool, chain, '300000')).rejects.toBeInstanceOf(
      OverAttestationError,
    )

    // The refusal must not have written anything.
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('names the numbers it refused on', async () => {
    topUpCustody(200_000n)
    await expect(setOperatorFloat(pool, chain, '200001')).rejects.toThrow(/200001/)
    await expect(setOperatorFloat(pool, chain, '200001')).rejects.toThrow(/200000/)
  })

  it('accepts a float the chain balance covers, and unblocks a stuck activation', async () => {
    topUpCustody(200_000n)
    // One activated drop: 500 luna of principal and 500 luna of ledger movement.
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })

    // Ledger = float(0) + 500 < outstanding(500) + fee reserve(100_000): the
    // deployment note in EXECUTION-LOG.md — a fresh database fails closed until
    // the operator attests their fee float.
    await expect(activationWouldPass(500n)).rejects.toBeInstanceOf(InsolventError)

    const result = await setOperatorFloat(pool, chain, '100000')

    expect(result.operatorFloatLuna).toEqual({ before: '0', after: '100000' })
    expect(result.ledgerBalanceLuna).toEqual({ before: '500', after: '100500' })
    // headroom = ledger - outstanding - fee reserve
    expect(result.solvencyHeadroomLuna).toEqual({ before: '-100000', after: '0' })
    expect(result.chainConfirmedBalanceLuna).toBe('200000')
    expect(result.ledgerMinusChainLuna.after).toBe('-99500')

    expect((await readControls(pool)).operatorFloatLuna).toBe(100_000n)
    await expect(activationWouldPass(500n)).resolves.toBeUndefined()
  })

  it('rejects a float that is not a positive integer number of luna', async () => {
    topUpCustody(1_000_000n)
    for (const bad of ['0', '-1', '1.5', '1e5', 'abc', '', ' ', '1_000', '+7']) {
      await expect(setOperatorFloat(pool, chain, bad)).rejects.toBeInstanceOf(InvalidLunaError)
    }
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses to guess when the chain cannot be reached', async () => {
    const down = chainWith(chain, {
      confirmedBalanceLuna: async () => {
        throw new Error('no peers')
      },
    })
    await expect(setOperatorFloat(pool, down, '100')).rejects.toBeInstanceOf(
      ChainUnavailableError,
    )
    expect((await readControls(pool)).operatorFloatLuna).toBe(0n)
  })

  it('refuses every float command when the database is bound to another network', async () => {
    await pool.query(`UPDATE custody_controls SET network = 'MainAlbatross' WHERE singleton`)
    await expect(setOperatorFloat(pool, chain, '100')).rejects.toThrow(/MainAlbatross/)

    // The read-only report still renders — it just labels the chain section.
    const shown = await floatShow(pool, chain)
    expect(shown.chain.available).toBe(false)
    if (!shown.chain.available) expect(shown.chain.reason).toMatch(/MainAlbatross/)
  })

  // ---- float show -------------------------------------------------------------

  it('shows the float beside the ledger, the chain and the caps', async () => {
    topUpCustody(200_000n)
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await setControls({ operatorFloatLuna: 100_000n })

    const shown = await floatShow(pool, chain)

    expect(shown.solvency.operatorFloatLuna).toBe('100000')
    expect(shown.solvency.ledgerBalanceLuna).toBe('100500')
    expect(shown.solvency.outstandingPrincipalLuna).toBe('500')
    expect(shown.solvency.feeReserveLuna).toBe('100000')
    expect(shown.solvency.maxLivePrincipalLuna).toBe('10000000')
    expect(shown.solvency.paused).toBe(false)
    expect(shown.solvency.network).toBe('TestAlbatross')
    expect(shown.solvency.lastReconciledAt).not.toBeNull()
    expect(shown.solvency.lastReconciledHeight).toBe(1000)

    expect(shown.chain.available).toBe(true)
    if (shown.chain.available) {
      expect(shown.chain.confirmedBalanceLuna).toBe('200000')
      expect(shown.chain.ledgerMinusChainLuna).toBe('-99500')
    }
  })

  it('renders without a chain client, clearly labelled as degraded', async () => {
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await setControls({ operatorFloatLuna: 100_000n })

    const shown = await floatShow(pool, null)

    expect(shown.solvency.ledgerBalanceLuna).toBe('100500')
    expect(shown.chain).toMatchObject({ available: false, degraded: true })
    if (!shown.chain.available) {
      expect(shown.chain.reason).toMatch(/no chain client/i)
    }
    // Nothing pretends to know the on-chain number.
    expect(shown.chain).not.toHaveProperty('confirmedBalanceLuna')
    expect(shown.chain).not.toHaveProperty('ledgerMinusChainLuna')
  })

  // ---- status -----------------------------------------------------------------

  it('counts every state and lists manual_review transfers with their ages', async () => {
    topUpCustody(500_000n)
    await setControls({ operatorFloatLuna: 100_000n, paused: true })

    const live = await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await insertDrop(pool, { claimCount: 5, amountEachLuna: 100n })
    await insertDrop(pool, { state: 'settled' })
    await insertDrop(pool, { state: 'awaiting_funding', activated: false })

    const paid = await insertClaim(pool, live.id, 0, 'paid')
    const stuck = await insertClaim(pool, live.id, 1, 'manual_review')
    await insertClaim(pool, live.id, 2, 'reserved')
    await insertClaim(pool, live.id, 3, 'reserved')

    const done = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: live.id,
      claimId: paid.id,
      state: 'confirmed',
    })
    await insertAttempt(pool, { transferId: done.id, state: 'confirmed', feeLuna: 1n })

    const flagged = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: live.id,
      claimId: stuck.id,
      state: 'manual_review',
      createdAgoSeconds: 7200,
    })
    await insertAttempt(pool, { transferId: flagged.id, state: 'proven_dead' })

    const flaggedRefund = await insertTransfer(pool, {
      purpose: 'refund',
      dropId: live.id,
      state: 'manual_review',
      createdAgoSeconds: 60,
    })

    const queuedDrop = await insertDrop(pool, { claimCount: 2, amountEachLuna: 50n })
    const queuedClaim = await insertClaim(pool, queuedDrop.id, 0)
    const inFlight = await insertTransfer(pool, {
      purpose: 'payout',
      dropId: queuedDrop.id,
      claimId: queuedClaim.id,
      state: 'in_progress',
    })
    const oldestOpen = await insertAttempt(pool, {
      transferId: inFlight.id,
      state: 'broadcast',
      createdAgoSeconds: 3600,
    })
    const refundIntent = await insertTransfer(pool, {
      purpose: 'refund',
      dropId: queuedDrop.id,
      state: 'queued',
    })
    await insertAttempt(pool, {
      transferId: refundIntent.id,
      state: 'signed',
      createdAgoSeconds: 30,
    })

    const report = await statusReport(pool, chain)

    expect(report.paused).toBe(true)
    expect(report.network).toBe('TestAlbatross')
    expect(report.solvency.operatorFloatLuna).toBe('100000')
    // open drops 500 + 500 + 100, less the one finalized 100-luna payout
    expect(report.solvency.outstandingPrincipalLuna).toBe('1000')

    expect(report.counts.drops).toEqual({
      live: 3,
      settled: 1,
      awaiting_funding: 1,
    })
    expect(report.counts.claims).toEqual({ paid: 1, manual_review: 1, reserved: 3 })
    expect(report.counts.outgoingTransfers).toEqual({
      confirmed: 1,
      manual_review: 2,
      in_progress: 1,
      queued: 1,
    })
    expect(report.counts.transactionAttempts).toEqual({
      confirmed: 1,
      proven_dead: 1,
      broadcast: 1,
      signed: 1,
    })

    expect(report.manualReviewTransfers).toHaveLength(2)
    const ids = report.manualReviewTransfers.map((t) => t.transferId)
    expect(ids).toContain(flagged.id)
    expect(ids).toContain(flaggedRefund.id)
    // Oldest first: an on-call operator triages by age.
    expect(ids[0]).toBe(flagged.id)
    expect(report.manualReviewTransfers[0].ageSeconds).toBeGreaterThanOrEqual(7000)
    expect(report.manualReviewTransfers[1].ageSeconds).toBeLessThan(7000)

    expect(report.oldestOpenAttempt?.attemptId).toBe(oldestOpen.id)
    expect(report.oldestOpenAttempt?.state).toBe('broadcast')
    expect(report.oldestOpenAttempt?.ageSeconds).toBeGreaterThanOrEqual(3500)
  })

  it('renders an empty, unpaused system without a chain client', async () => {
    const report = await statusReport(pool, null)

    expect(report.paused).toBe(false)
    expect(report.counts.drops).toEqual({})
    expect(report.counts.claims).toEqual({})
    expect(report.counts.outgoingTransfers).toEqual({})
    expect(report.manualReviewTransfers).toEqual([])
    expect(report.oldestOpenAttempt).toBeNull()
    expect(report.chain).toMatchObject({ available: false, degraded: true })
  })

  it('is JSON-printable: no bigint escapes into the report', async () => {
    topUpCustody(1_000n)
    await insertDrop(pool)
    const shown = await floatShow(pool, chain)
    const report = await statusReport(pool, chain)
    expect(() => JSON.stringify(shown)).not.toThrow()
    expect(() => JSON.stringify(report)).not.toThrow()
  })
})
