import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChainCallTimeoutError } from '../src/chain/deadline'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient, ChainTx } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import { DropShapeError } from '../src/money'
import {
  DropNotFoundError,
  ExpiryWindowError,
  FundingRejectedError,
  MAX_EXPIRY_HOURS,
  MIN_EXPIRY_HOURS,
  createDraft,
  createOperatorFundedDrop,
  getPublic,
  submitFunding,
} from '../src/services/drops'
import { gcDrafts } from '../src/services/expiry'
import {
  CapExceededError,
  DropTooLargeError,
  InsolventError,
  NoHeadroomError,
  PausedError,
  outstandingPrincipalLuna,
  readControls,
  reconcile,
  reservedPrincipalLuna,
} from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Activation consults `outstandingPrincipalLuna`, a GLOBAL aggregate over every
 * drop, so this suite cannot share tables with the other `*.race.test.ts` files
 * vitest runs in parallel. It migrates a private Postgres schema and points its
 * own pool's `search_path` at it; the service uses unqualified table names, so
 * it lands in the private schema unchanged.
 */
const SCHEMA = 'drops_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
const PRINCIPAL = AMOUNT_EACH * BigInt(CLAIM_COUNT)
/** Operator's pre-funded fee float, matching `configured_fee_reserve_luna`. */
const FEE_FLOAT = 100_000n

let pool: pg.Pool
let chain: FakeChain

function newChain(o: { network?: 'TestAlbatross' | 'MainAlbatross' } = {}): FakeChain {
  const c = new FakeChain({
    custody: CUSTODY,
    finalityDepth: FINALITY_DEPTH,
    headHeight: FUND_HEIGHT,
    ...(o.network ? { network: o.network } : {}),
  })
  // The operator pre-funds the fee reserve; without it invariant 1
  // (balance >= outstanding + fee reserve) can never hold.
  c.deposit({
    hash: 'operator-fee-float',
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: FEE_FLOAT,
    includedHeight: 1,
  })
  return c
}

async function draft(
  o: {
    amountEachLuna?: bigint
    claimCount?: number
    message?: string
    expiryHours?: number
  } = {},
) {
  return createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: o.amountEachLuna ?? AMOUNT_EACH,
    claimCount: o.claimCount ?? CLAIM_COUNT,
    ...(o.message === undefined ? {} : { message: o.message }),
    ...(o.expiryHours === undefined ? {} : { expiryHours: o.expiryHours }),
  })
}

/** Deposit a funding tx that satisfies every predicate for `publicId`. */
function fund(
  publicId: string,
  o: {
    hash?: string
    sender?: string
    recipient?: string
    valueLuna?: bigint
    memo?: string | null
    includedHeight?: number
    executionOk?: boolean
    on?: FakeChain
  } = {},
): string {
  const hash = o.hash ?? `tx-${publicId}`
  ;(o.on ?? chain).deposit({
    hash,
    sender: o.sender ?? SPONSOR,
    recipient: o.recipient ?? CUSTODY,
    valueLuna: o.valueLuna ?? PRINCIPAL,
    dataUtf8: o.memo === undefined ? `ND1:${publicId}` : o.memo,
    includedHeight: o.includedHeight ?? FUND_HEIGHT,
    ...(o.executionOk === undefined ? {} : { executionOk: o.executionOk }),
  })
  return hash
}

/** Move the head past finality for a tx included at `FUND_HEIGHT`. */
function finalize(c: FakeChain = chain): void {
  c.setHead(FUND_HEIGHT + FINALITY_DEPTH)
}

async function readDrop(publicId: string) {
  const { rows } = await pool.query<{
    state: string
    creator_address: string | null
    refund_address: string | null
    funding_tx_hash: string | null
    activated_height: string | null
    expiry_hours: number
    expires_at: Date | null
    funding_source: string
  }>(
    `SELECT state, creator_address, refund_address, funding_tx_hash, activated_height,
            expiry_hours, expires_at, funding_source
     FROM drops WHERE public_id = $1`,
    [publicId],
  )
  return rows[0]
}

async function setControls(o: {
  paused?: boolean
  /** Migration 015: the optional kill switch. `null`/omitted means no ceiling. */
  capLuna?: bigint | null
  feeReserveLuna?: bigint
  /** Operator-attested float; the ledger credit the fee reserve is spent from. */
  operatorFloatLuna?: bigint
  /** Migration 014: ceiling on live + reserved drops. `null` means no limit. */
  maxLiveDrops?: number | null
}) {
  await pool.query(
    `UPDATE custody_controls
     SET paused = $1, max_live_principal_luna = $2, configured_fee_reserve_luna = $3,
         operator_float_luna = $4, max_live_drops = $5
     WHERE singleton`,
    [
      o.paused ?? false,
      o.capLuna === undefined || o.capLuna === null ? null : o.capLuna.toString(),
      (o.feeReserveLuna ?? FEE_FLOAT).toString(),
      (o.operatorFloatLuna ?? FEE_FLOAT).toString(),
      o.maxLiveDrops ?? null,
    ],
  )
}

async function draftCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM drops')
  return rows[0].n
}

/** Expect a rejection carrying an exact `FundingRejectedError.code`. */
async function expectRejection(p: Promise<unknown>, code: string): Promise<FundingRejectedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected FundingRejectedError(${code}), got success`).toBeInstanceOf(
    FundingRejectedError,
  )
  expect((err as FundingRejectedError).code).toBe(code)
  return err as FundingRejectedError
}

describe.skipIf(!hasDb)('drop drafts and exact funding activation (real Postgres)', () => {
  const savedNetwork = process.env.NIMIQ_NETWORK

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
    if (savedNetwork === undefined) delete process.env.NIMIQ_NETWORK
    else process.env.NIMIQ_NETWORK = savedNetwork
  })

  beforeEach(async () => {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
    // Deliberately leave custody_controls unreconciled (last_reconciled_at NULL):
    // activation may only succeed because submitFunding reconciles first.
    await pool.query(
      `UPDATE custody_controls
       SET reconciled_confirmed_balance_luna = NULL,
           last_reconciled_height = NULL,
           last_reconciled_at = NULL
       WHERE singleton`,
    )
    await setControls({})
    chain = newChain()
  })

  afterEach(() => {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
  })

  // ---- drafts ---------------------------------------------------------------

  it('creates a draft with an exact expected funding total and an ND1 memo', async () => {
    const d = await draft({ message: 'happy new year' })

    expect(d.publicId).toHaveLength(22)
    expect(d.fundingAddress).toBe(CUSTODY)
    expect(d.fundingMemo).toBe(`ND1:${d.publicId}`)
    expect(Buffer.byteLength(d.fundingMemo, 'utf8')).toBeLessThanOrEqual(64)
    expect(d.expectedFundingLuna).toBe(PRINCIPAL)

    const row = await readDrop(d.publicId)
    expect(row.state).toBe('awaiting_funding')
    expect(row.creator_address).toBeNull()
    expect(row.activated_height).toBeNull()

    const pub = await getPublic(pool, d.publicId)
    expect(pub).toMatchObject({
      publicId: d.publicId,
      sponsorLabel: 'Sponsor',
      message: 'happy new year',
      amountEach: '1',
      claimCount: CLAIM_COUNT,
      remaining: CLAIM_COUNT,
      state: 'awaiting_funding',
    })
    expect(pub.expiresAt).toBeNull()
  })

  it('enforces the one shape rule at draft time, and no size ceiling', async () => {
    await expect(draft({ claimCount: 1 })).rejects.toBeInstanceOf(DropShapeError)
    await expect(draft({ amountEachLuna: 0n })).rejects.toBeInstanceOf(DropShapeError)
    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM drops')
    expect(rows[0].count).toBe('0')

    // Both of these were refused before the caps came out: 21 people, and a
    // 200 NIM total. Neither is anyone's business but the sponsor's now.
    await expect(draft({ claimCount: 21 })).resolves.toBeDefined()
    await expect(draft({ amountEachLuna: 1_000_000n, claimCount: 20 })).resolves.toBeDefined()
  })

  it('rejects funding for an unknown drop', async () => {
    await expect(
      submitFunding(pool, chain, { publicId: 'nope-nope-nope-nope-no', txHash: 'x' }),
    ).rejects.toBeInstanceOf(DropNotFoundError)
  })

  // ---- §7 activation predicate matrix ---------------------------------------

  it('rejects funding observed on the wrong network', async () => {
    const d = await draft()
    const mainnet = newChain({ network: 'MainAlbatross' })
    const hash = fund(d.publicId, { on: mainnet })
    finalize(mainnet)

    await expectRejection(
      submitFunding(pool, mainnet, { publicId: d.publicId, txHash: hash }),
      'wrong_network',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)
  })

  it('rejects funding sent to the wrong recipient', async () => {
    const d = await draft()
    const hash = fund(d.publicId, { recipient: 'NQ07 SOMEONE ELSE' })
    finalize()

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: hash }),
      'wrong_recipient',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
  })

  it('rejects underfunding by a single luna', async () => {
    const d = await draft()
    const hash = fund(d.publicId, { valueLuna: PRINCIPAL - 1n })
    finalize()

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: hash }),
      'wrong_amount',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
  })

  it('rejects overfunding by a single luna', async () => {
    const d = await draft()
    const hash = fund(d.publicId, { valueLuna: PRINCIPAL + 1n })
    finalize()

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: hash }),
      'wrong_amount',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
  })

  it('rejects a wrong or missing memo', async () => {
    const a = await draft()
    const b = await draft()

    const noMemo = fund(a.publicId, { hash: 'tx-no-memo', memo: null })
    const junk = fund(a.publicId, { hash: 'tx-junk-memo', memo: 'gm' })
    // Another drop's exact memo must not fund this drop.
    const otherDrop = fund(a.publicId, { hash: 'tx-other-memo', memo: `ND1:${b.publicId}` })
    finalize()

    for (const hash of [noMemo, junk, otherDrop]) {
      await expectRejection(submitFunding(pool, chain, { publicId: a.publicId, txHash: hash }), 'wrong_memo')
    }
    expect((await readDrop(a.publicId)).state).toBe('awaiting_funding')
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)
  })

  it('never activates on a memo that merely CONTAINS the drop id', async () => {
    const a = await draft()
    const b = await draft()

    const suffixed = fund(a.publicId, { hash: 'tx-suffix', memo: `ND1:${a.publicId}${b.publicId}` })
    const prefixed = fund(a.publicId, { hash: 'tx-prefix', memo: `pay ND1:${a.publicId}` })
    const truncated = fund(a.publicId, { hash: 'tx-trunc', memo: `ND1:${a.publicId.slice(0, 10)}` })
    finalize()

    for (const hash of [suffixed, prefixed, truncated]) {
      await expectRejection(submitFunding(pool, chain, { publicId: a.publicId, txHash: hash }), 'wrong_memo')
    }
    expect((await readDrop(a.publicId)).state).toBe('awaiting_funding')
  })

  it('rejects a transaction whose execution failed', async () => {
    const d = await draft()
    const hash = fund(d.publicId, { executionOk: false })
    finalize()

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: hash }),
      'execution_failed',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
  })

  it('refuses to reuse one funding hash across two drops', async () => {
    const a = await draft()
    const b = await draft()
    const hash = fund(a.publicId)
    finalize()

    const live = await submitFunding(pool, chain, { publicId: a.publicId, txHash: hash })
    expect(live.state).toBe('live')

    await expectRejection(submitFunding(pool, chain, { publicId: b.publicId, txHash: hash }), 'reused_hash')
    expect((await readDrop(b.publicId)).state).toBe('awaiting_funding')
    // Only drop A's principal is outstanding — the reused hash created no capacity.
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('refuses to fund a drop with a deposit already attested as operator float', async () => {
    // Round-3 R2. The operator attested a memo-less deposit as float — the
    // ledger already counts it once. Activating a drop with the same hash would
    // count it a second time, as principal owed to claimants, out of money that
    // was only ever in custody once.
    const d = await draft()
    const hash = fund(d.publicId, { memo: null })
    finalize()
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, $2, $3, 'TestAlbatross')`,
      [hash, PRINCIPAL.toString(), String(FUND_HEIGHT)],
    )

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: hash }),
      'attested_as_float',
    )
    expect((await readDrop(d.publicId)).state).toBe('awaiting_funding')
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)
  })

  it('the database refuses it too, even if the service check is bypassed', async () => {
    // The same rule as a schema constraint (migration 008): the pre-check above
    // is a better error message, not the guarantee.
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, $2, $3, 'TestAlbatross')`,
      [hash, PRINCIPAL.toString(), String(FUND_HEIGHT)],
    )

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM drops WHERE public_id = $1', [
      d.publicId,
    ])
    await expect(
      pool.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [rows[0].id, hash]),
    ).rejects.toThrow(/attested as operator float/i)
  })

  // ---- S4: the exclusion is a unique key, not two lookups --------------------

  it('S4: two CONCURRENT writers cannot both claim the same deposit hash', async () => {
    // Round-3 R2 enforced exclusivity with a trigger on each table doing an
    // EXISTS lookup against the other, and argued the custody lock serialized
    // the two write paths. `recordPending` does not take that lock, and — more
    // fundamentally — an uncommitted row is invisible to an EXISTS check by
    // definition. So both writers looked, both saw nothing, both committed, and
    // the same luna was credited to the ledger twice.
    //
    // Nothing about that is reproducible with sequential writes, which is why
    // it survived round 3. Here both transactions are genuinely open at once.
    const d = await draft()
    const hash = fund(d.publicId, { memo: null })
    finalize()
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM drops WHERE public_id = $1', [
      d.publicId,
    ])
    const dropId = rows[0].id

    const a = await pool.connect()
    const b = await pool.connect()
    let results: PromiseSettledResult<unknown>[]
    try {
      // Both BEGIN before either writes: neither can see the other's row, which
      // is exactly the state the old EXISTS checks were evaluated in.
      await a.query('BEGIN')
      await b.query('BEGIN')
      results = await Promise.allSettled([
        (async () => {
          await a.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [dropId, hash])
          await a.query('COMMIT')
        })().catch(async (err: unknown) => {
          await a.query('ROLLBACK').catch(() => {})
          throw err
        }),
        (async () => {
          await b.query(
            `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
             VALUES ($1, $2, $3, 'TestAlbatross')`,
            [hash, PRINCIPAL.toString(), String(FUND_HEIGHT)],
          )
          await b.query('COMMIT')
        })().catch(async (err: unknown) => {
          await b.query('ROLLBACK').catch(() => {})
          throw err
        }),
      ])
    } finally {
      a.release()
      b.release()
    }

    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won, 'exactly one owner, whichever got there first').toHaveLength(1)

    // And the books agree: the hash is credited once, on one side only.
    const { rows: owners } = await pool.query<{ owner: string }>(
      'SELECT owner FROM custody_deposit_owners WHERE tx_hash = $1',
      [hash],
    )
    expect(owners).toHaveLength(1)
    const asFunding = await pool.query('SELECT 1 FROM drops WHERE funding_tx_hash = $1', [hash])
    const asFloat = await pool.query('SELECT 1 FROM operator_float_deposits WHERE tx_hash = $1', [
      hash,
    ])
    expect(
      asFunding.rows.length + asFloat.rows.length,
      'the same deposit may be credited exactly once',
    ).toBe(1)
    expect(owners[0].owner).toBe(asFunding.rows.length === 1 ? 'drop' : 'float')
  })

  it('S4: the registry is written by the ordinary activation path', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()
    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe(
      'live',
    )

    const { rows } = await pool.query<{ owner: string; drop_id: string }>(
      'SELECT owner, drop_id FROM custody_deposit_owners WHERE tx_hash = $1',
      [hash],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].owner).toBe('drop')
    // Re-stamping the same hash (recordPending then activate) is not a conflict.
    const { rows: drop } = await pool.query<{ id: string }>(
      'SELECT id FROM drops WHERE public_id = $1',
      [d.publicId],
    )
    expect(rows[0].drop_id).toBe(drop[0].id)
    await expect(
      pool.query('UPDATE drops SET funding_tx_hash = $2 WHERE id = $1', [drop[0].id, hash]),
    ).resolves.toBeDefined()
  })

  it('S4: migration 012 ABORTS rather than migrate an existing double-credit', async () => {
    // The other half of R2's residue: 008 added its triggers and checked
    // nothing, so a database that already had a hash on both sides was migrated
    // into a state its own invariant forbids, silently. 012 refuses.
    //
    // The guard is executed here as the SHIPPED TEXT, read out of the migration
    // file, against a schema doctored into the forbidden state — anything else
    // would be testing a copy of the SQL rather than the SQL.
    const guard = (
      await readFile(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '012_deposit_ownership_registry.sql'),
        'utf8',
      )
    ).split(/^\$\$;$/m)[0].concat('$$;')
    expect(guard, 'the guard must be the first statement in the migration').toContain(
      'refusing to install the deposit ownership registry',
    )

    const d = await draft()
    const hash = fund(d.publicId)
    finalize()
    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe(
      'live',
    )
    // Forge the intersection the migration must refuse. Only possible with the
    // registry's own trigger switched off, which is itself the proof that the
    // live system cannot reach this state any more.
    await pool.query('ALTER TABLE operator_float_deposits DISABLE TRIGGER operator_float_deposits_claim_deposit')
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, $2, $3, 'TestAlbatross')`,
      [hash, PRINCIPAL.toString(), String(FUND_HEIGHT)],
    )
    await pool.query('ALTER TABLE operator_float_deposits ENABLE TRIGGER operator_float_deposits_claim_deposit')

    await expect(pool.query(guard)).rejects.toThrow(/already counted[\s\S]*both as a drop/i)
    // …and it names the hash, so the operator knows what to decide about.
    await expect(pool.query(guard)).rejects.toThrow(new RegExp(hash))
  })

  // ---- finality -------------------------------------------------------------

  it('holds a not-yet-final funding in funding_pending, then activates when the head crosses finality', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    chain.setHead(FUND_HEIGHT + FINALITY_DEPTH - 1)

    const pending = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(pending.state).toBe('funding_pending')
    expect(pending.fundingTxHash).toBe(hash)
    const before = await readDrop(d.publicId)
    expect(before.activated_height).toBeNull()
    expect(before.creator_address).toBeNull()
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)

    finalize()
    const live = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(live.state).toBe('live')
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('freezes a funding_pending drop whose funding tx disappears in a reorg', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    chain.setHead(FUND_HEIGHT + FINALITY_DEPTH - 1)
    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe(
      'funding_pending',
    )

    // The block carrying the funding is reorged away before it ever finalized.
    expect(chain.removeTx(hash)).toBe(true)
    finalize()

    const after = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(after.state).toBe('funding_pending')
    const row = await readDrop(d.publicId)
    expect(row.activated_height).toBeNull()
    expect(row.creator_address).toBeNull()
    expect(row.expires_at).toBeNull()
    // The frozen drop must never create payout capacity.
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)
  })

  it('never tells the user to fund again when a submitted hash is not visible yet', async () => {
    const d = await draft()

    // FakeChain resolves null; the real @nimiq/core client REJECTS with
    // "Transaction not found". Both must read as "not detected yet".
    const rejecting: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: () => chain.headHeight(),
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: async () => {
        throw new Error('Transaction not found')
      },
      confirmedBalanceLuna: (a: string) => chain.confirmedBalanceLuna(a),
      buildSignedBasic: (o) => chain.buildSignedBasic(o),
      broadcast: (raw: string) => chain.broadcast(raw),
    }

    const viaNull = await submitFunding(pool, chain, { publicId: d.publicId, txHash: 'ghost' })
    expect(viaNull.state).toBe('awaiting_funding')
    const viaThrow = await submitFunding(pool, rejecting, { publicId: d.publicId, txHash: 'ghost' })
    expect(viaThrow.state).toBe('awaiting_funding')

    // An unverified hash is never recorded, so it can never squat the unique index.
    expect((await readDrop(d.publicId)).funding_tx_hash).toBeNull()
  })

  // ---- a node that never answers -------------------------------------------------

  /**
   * The worker got the money engine's chain deadline first; this is the same
   * bound on the SPONSOR-facing call. A node that accepts the lookup and never
   * answers used to park the HTTP request forever, on the one call that decides
   * whether the money the sponsor has already sent was seen.
   *
   * The property that matters is not the ten seconds. It is that a timeout is
   * "we could not ask" and never "the chain does not have it": absence here
   * answers 200 with the drop unchanged, which tells a sponsor whose funding
   * HAS landed that it has not been seen, and leaves the drop frozen with no
   * error recorded anywhere for an operator to find.
   */
  it('bounds the funding lookup, and never reads the bound as "not found"', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()

    let release: (() => void) | undefined
    const neverAnswers: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: () => chain.headHeight(),
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: () =>
        new Promise<ChainTx | null>((resolve) => {
          release = () => resolve(null)
        }),
      confirmedBalanceLuna: (a: string) => chain.confirmedBalanceLuna(a),
      buildSignedBasic: (o) => chain.buildSignedBasic(o),
      broadcast: (raw: string) => chain.broadcast(raw),
    }

    const startedAt = Date.now()
    const err = await submitFunding(pool, neverAnswers, {
      publicId: d.publicId,
      txHash: hash,
      chainTimeoutMs: 50,
    }).then(
      (pub) => pub,
      (e: unknown) => e,
    )
    const elapsedMs = Date.now() - startedAt
    release?.()

    // It RETURNED, on the order of the deadline rather than of the node's
    // patience — and it returned a failure, not a drop. A resolved `DropPublic`
    // here would BE the bug: that is the shape "not detected yet" has.
    expect(elapsedMs).toBeLessThan(5_000)
    expect(err, 'a hung lookup must not resolve as a drop').toBeInstanceOf(ChainCallTimeoutError)

    const message = (err as Error).message
    // Not by luck of wording: the timeout is re-thrown before any message is
    // matched. These assertions are the belt — the phrase lists are the ones in
    // `services/drops.ts` (`findTx`) and `chain/nimiq.ts` (`NOT_FOUND_PATTERNS`).
    expect(/not found|unknown transaction|no such transaction/i.test(message)).toBe(false)
    for (const phrase of ['not found', 'no transaction', 'unknown transaction', 'does not exist', 'transaction not yet']) {
      expect(message.toLowerCase(), `a timeout must not read as "${phrase}"`).not.toContain(phrase)
    }

    // Nothing was concluded about the transaction: no hash recorded, no state
    // moved, no capacity created. The sponsor's next poll asks again.
    const row = await readDrop(d.publicId)
    expect(row.state).toBe('awaiting_funding')
    expect(row.funding_tx_hash).toBeNull()
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)

    // And the same submission against a node that answers still activates.
    const live = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(live.state).toBe('live')
  })

  it('remembers a verified funding when the HEIGHT read is the call that hangs', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()

    let release: (() => void) | undefined
    const headHangs: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(FUND_HEIGHT)
        }),
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: (h: string) => chain.getTransaction(h),
      confirmedBalanceLuna: (a: string) => chain.confirmedBalanceLuna(a),
      buildSignedBasic: (o) => chain.buildSignedBasic(o),
      broadcast: (raw: string) => chain.broadcast(raw),
    }

    await expect(
      submitFunding(pool, headHangs, { publicId: d.publicId, txHash: hash, chainTimeoutMs: 50 }),
    ).rejects.toBeInstanceOf(ChainCallTimeoutError)
    release?.()

    // Every §7 predicate had already passed, so the hash is on the drop before
    // the height is asked for. That is what takes the row out of draft GC's
    // reach and lets the money be counted while the node is unreachable.
    const row = await readDrop(d.publicId)
    expect(row.state).toBe('funding_pending')
    expect(row.funding_tx_hash).toBe(hash)

    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe('live')
  })

  // ---- activation -----------------------------------------------------------

  it('activates a valid funding: live, immutable creator/refund address, 24h expiry, height', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()

    const before = Date.now()
    const pub = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    const after = Date.now()

    expect(pub.state).toBe('live')
    expect(pub.remaining).toBe(CLAIM_COUNT)
    expect(pub.fundingTxHash).toBe(hash)

    const row = await readDrop(d.publicId)
    expect(row.creator_address).toBe(SPONSOR)
    expect(row.refund_address).toBe(SPONSOR)
    expect(row.funding_tx_hash).toBe(hash)
    expect(BigInt(row.activated_height!)).toBe(BigInt(FUND_HEIGHT))
    // migration 024 regression: an ordinary sponsor drop still defaults to
    // funding_source = 'sponsor' and still needed a verified funding
    // transaction — nothing about operator-funded drops changed this path.
    expect(row.funding_source).toBe('sponsor')

    const expires = row.expires_at!.getTime()
    expect(expires).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 5_000)
    expect(expires).toBeLessThanOrEqual(after + 24 * 3600_000 + 5_000)
    expect(pub.expiresAt?.getTime()).toBe(expires)

    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('records the verified funding authorizer instead of a temporary contract sender', async () => {
    const d = await draft()
    const hash = fund(d.publicId, { sender: 'NQ07 HTLC' })
    finalize()
    const contractFunding: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: () => chain.headHeight(),
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: async (txHash: string) => {
        const tx = await chain.getTransaction(txHash)
        return tx ? { ...tx, fundingOwner: SPONSOR } : null
      },
      confirmedBalanceLuna: (address: string) => chain.confirmedBalanceLuna(address),
      buildSignedBasic: (options) => chain.buildSignedBasic(options),
      broadcast: (raw: string) => chain.broadcast(raw),
    }

    await submitFunding(pool, contractFunding, { publicId: d.publicId, txHash: hash })

    const row = await readDrop(d.publicId)
    expect(row.creator_address).toBe(SPONSOR)
    expect(row.refund_address).toBe(SPONSOR)
  })

  // ---- the sponsor's claim window -----------------------------------------------

  it('stamps the sponsor-chosen window at activation, measured from activation', async () => {
    const d = await draft({ expiryHours: 168 })
    expect(d.expiryHours).toBe(168)
    // The draft carries the window but no deadline: the clock has not started.
    expect((await readDrop(d.publicId)).expires_at).toBeNull()
    expect((await readDrop(d.publicId)).expiry_hours).toBe(168)

    const hash = fund(d.publicId)
    finalize()
    const before = Date.now()
    await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    const after = Date.now()

    const row = await readDrop(d.publicId)
    const expires = row.expires_at!.getTime()
    expect(expires).toBeGreaterThanOrEqual(before + 168 * 3600_000 - 5_000)
    expect(expires).toBeLessThanOrEqual(after + 168 * 3600_000 + 5_000)
  })

  it('defaults to 24 hours when the caller does not choose', async () => {
    const d = await draft()
    expect(d.expiryHours).toBe(24)
    expect((await readDrop(d.publicId)).expiry_hours).toBe(24)
    expect((await getPublic(pool, d.publicId)).expiryHours).toBe(24)
  })

  it('refuses a window outside the bounds, in the service and in the schema', async () => {
    for (const expiryHours of [0, -3, MAX_EXPIRY_HOURS + 1, 2.5, Number.NaN]) {
      await expect(draft({ expiryHours }), `expiryHours=${expiryHours}`).rejects.toBeInstanceOf(
        ExpiryWindowError,
      )
    }
    // Both ends of the range are real, so the refusals above bound a range
    // rather than rejecting everything.
    expect((await draft({ expiryHours: MIN_EXPIRY_HOURS })).expiryHours).toBe(1)
    expect((await draft({ expiryHours: MAX_EXPIRY_HOURS })).expiryHours).toBe(336)

    // And the schema is the backstop: a write that bypassed the service still
    // cannot store a window outside the bounds.
    const d = await draft()
    await expect(
      pool.query('UPDATE drops SET expiry_hours = 1000 WHERE public_id = $1', [d.publicId]),
    ).rejects.toMatchObject({ constraint: 'drops_expiry_hours_range' })
  })

  it('never recomputes the deadline once a drop is live', async () => {
    const d = await draft({ expiryHours: 6 })
    const hash = fund(d.publicId)
    finalize()
    await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    const stamped = (await readDrop(d.publicId)).expires_at!.getTime()

    // The idempotent replay re-enters `activate()` — the ONLY writer of
    // `expires_at` — so if the deadline could drift, it would drift here.
    await new Promise((resolve) => setTimeout(resolve, 25))
    const again = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(again.state).toBe('live')
    expect((await readDrop(d.publicId)).expires_at!.getTime()).toBe(stamped)
    expect(again.expiresAt!.getTime()).toBe(stamped)
  })

  // ---- GC / activation race (G1 review finding 7) ------------------------------

  it('activates a draft that draft GC cancelled while its funding was being verified', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()

    // The exact race: the sponsor's transaction is on chain and final, and the
    // 24-hour collector fires on the draft before `submitFunding` reaches its
    // activation transaction. GC's own guards are intact — the drop is still
    // `awaiting_funding` with no recorded hash — so nothing here is a GC bug.
    await pool.query(`UPDATE drops SET created_at = now() - interval '25 hours' WHERE public_id = $1`, [
      d.publicId,
    ])
    expect(await gcDrafts(pool)).toBe(1)
    expect((await readDrop(d.publicId)).state).toBe('cancelled')

    // Verified money must not be stranded in a cancelled drop: the full §7
    // predicate still passes, so the drop comes back to life.
    const pub = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })

    expect(pub.state).toBe('live')
    const row = await readDrop(d.publicId)
    expect(row.funding_tx_hash).toBe(hash)
    expect(row.creator_address).toBe(SPONSOR)
    expect(row.expires_at).not.toBeNull()
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('does not resurrect a cancelled drop for a transaction that fails any predicate', async () => {
    const d = await draft()
    // Right drop, one luna short: reactivation is not a second chance to be
    // approximately right.
    chain.deposit({
      hash: 'short-funding',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: PRINCIPAL - 1n,
      dataUtf8: `ND1:${d.publicId}`,
      includedHeight: FUND_HEIGHT,
    })
    finalize()
    await pool.query(`UPDATE drops SET created_at = now() - interval '25 hours' WHERE public_id = $1`, [
      d.publicId,
    ])
    expect(await gcDrafts(pool)).toBe(1)

    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: 'short-funding' }),
      'wrong_amount',
    )
    expect((await readDrop(d.publicId)).state).toBe('cancelled')
    expect(await outstandingPrincipalLuna(pool)).toBe(0n)
  })

  it('is idempotent: the same submitFunding call twice returns the same result', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()

    const first = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    const second = await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })
    expect(second).toEqual(first)

    const row = await readDrop(d.publicId)
    expect(row.state).toBe('live')
    // Re-submission must not re-activate: one principal, one expiry, one height.
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
    expect(second.expiresAt?.getTime()).toBe(row.expires_at!.getTime())
  })

  it('rejects a second, different funding transaction for the same drop', async () => {
    const d = await draft()
    const first = fund(d.publicId)
    const second = fund(d.publicId, { hash: 'tx-duplicate-deposit' })
    finalize()

    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: first })).state).toBe('live')
    await expectRejection(
      submitFunding(pool, chain, { publicId: d.publicId, txHash: second }),
      'drop_not_fundable',
    )
    // The accidental second deposit is an operator reconciliation item, never
    // extra payout capacity.
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('serializes concurrent activations so the global principal cap cannot be breached', async () => {
    // Both drafts are created while the cap is wide, and the cap is narrowed
    // afterwards. Since migration 014 a draft RESERVES its principal, so two
    // drafts that cannot both fit are refused at creation — which is the point
    // of that change and is covered by its own tests below. This test is about
    // the other end: activation is still the last line of defence, and it has
    // to hold when the reservation could not have known. An operator lowering
    // the cap between the draft and the deposit is exactly that case.
    const a = await draft()
    const b = await draft()
    // Either drop fits alone; together they exceed the cap.
    await setControls({ capLuna: PRINCIPAL + PRINCIPAL / 2n })
    const ha = fund(a.publicId)
    const hb = fund(b.publicId)
    finalize()

    const results = await Promise.allSettled([
      submitFunding(pool, chain, { publicId: a.publicId, txHash: ha }),
      submitFunding(pool, chain, { publicId: b.publicId, txHash: hb }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CapExceededError)

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drops WHERE state = 'live'`,
    )
    expect(rows[0].count).toBe('1')
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  // ---- migration 014: capacity is reserved when instructions are issued -------
  //
  // The hole: `createDraft` handed out the custody address and an exact amount
  // with no reference to `max_live_principal_luna`, which was checked only in
  // `activate()` — after the sponsor's transaction was on chain and final. Any
  // number of sponsors could be promised room that one of them had.

  it('refuses a second draft once the cap is spoken for, before anyone has paid', async () => {
    await setControls({ capLuna: PRINCIPAL })

    const first = await draft()
    expect(first.fundingAddress).toBe(CUSTODY)
    expect(first.capacity.remainingLuna, 'the first draft consumed the whole cap').toBe(0n)
    expect(first.capacity.reservedLuna).toBe(PRINCIPAL)
    expect(first.capacity.outstandingLuna, 'nothing is outstanding until money lands').toBe(0n)

    const refused = await draft().then(
      () => null,
      (e: unknown) => e,
    )
    expect(refused).toBeInstanceOf(NoHeadroomError)
    expect((refused as NoHeadroomError).requestedLuna).toBe(PRINCIPAL)
    expect((refused as NoHeadroomError).capacity.remainingLuna).toBe(0n)
    // …and the refused draft left no row behind to hold room of its own.
    expect(await draftCount()).toBe(1)
  })

  it('with headroom for exactly one drop, two CONCURRENT drafts do not both get funding instructions', async () => {
    // The scenario the reservation exists for. Sequential refusal is easy; the
    // question is whether two requests that are genuinely in flight at the same
    // time can both read "there is room for one" and both answer a sponsor.
    // They cannot, because the reservation is taken inside the singleton
    // `custody_controls` lock — the same choke point activation uses.
    await setControls({ capLuna: PRINCIPAL })

    const results = await Promise.allSettled([draft(), draft()])
    const issued = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected')

    expect(issued, 'exactly one sponsor may be told where to send money').toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(NoHeadroomError)
    expect(await draftCount()).toBe(1)

    // The winner really can fund: the promise it was given is good.
    const winner = (issued[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof draft>>>).value
    const hash = fund(winner.publicId)
    finalize()
    expect((await submitFunding(pool, chain, { publicId: winner.publicId, txHash: hash })).state).toBe(
      'live',
    )
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
  })

  it('tells a sponsor that a drop bigger than the whole cap can never run, not to retry', async () => {
    await setControls({ capLuna: PRINCIPAL - 1n })
    const err = await draft().then(
      () => null,
      (e: unknown) => e,
    )
    // A distinct type, because the two refusals have different answers: one is
    // "come back later" and this one is "ask for less".
    expect(err).toBeInstanceOf(DropTooLargeError)
    expect(err).not.toBeInstanceOf(NoHeadroomError)
    expect(await draftCount()).toBe(0)
  })

  it('returns the headroom when an abandoned draft’s reservation expires', async () => {
    await setControls({ capLuna: PRINCIPAL })
    const abandoned = await draft()
    await expect(draft()).rejects.toBeInstanceOf(NoHeadroomError)

    // The sponsor closed the tab. Nothing collects the row for 24 hours, but
    // the promise is only good for `FUNDING_RESERVATION_MINUTES`.
    await pool.query(
      `UPDATE drops SET funding_reservation_expires_at = now() - interval '1 minute'
       WHERE public_id = $1`,
      [abandoned.publicId],
    )
    expect((await reservedPrincipalLuna(pool)).luna).toBe(0n)

    const next = await draft()
    expect(next.capacity.reservedLuna).toBe(PRINCIPAL)
  })

  it('keeps a draft’s room past the window once its funding transaction is recorded', async () => {
    // The sponsor has paid. Releasing their headroom now would let a later
    // draft take the room their activation needs, which is the same bug in a
    // new place.
    await setControls({ capLuna: PRINCIPAL })
    const d = await draft()
    const hash = fund(d.publicId)
    chain.setHead(FUND_HEIGHT + FINALITY_DEPTH - 1)
    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe(
      'funding_pending',
    )

    await pool.query(
      `UPDATE drops SET funding_reservation_expires_at = now() - interval '1 hour'
       WHERE public_id = $1`,
      [d.publicId],
    )
    expect((await reservedPrincipalLuna(pool)).luna).toBe(PRINCIPAL)
    await expect(draft()).rejects.toBeInstanceOf(NoHeadroomError)

    // …and it activates, on the room it never gave up.
    finalize()
    expect((await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })).state).toBe(
      'live',
    )
  })

  it('moves principal from reserved to outstanding on activation, counting it once', async () => {
    await setControls({ capLuna: PRINCIPAL })
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()
    await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })

    expect((await reservedPrincipalLuna(pool)).luna, 'the reservation is released').toBe(0n)
    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
    const row = await pool.query<{ funding_reservation_expires_at: Date | null }>(
      'SELECT funding_reservation_expires_at FROM drops WHERE public_id = $1',
      [d.publicId],
    )
    expect(row.rows[0].funding_reservation_expires_at).toBeNull()

    // The cap is still full — it is just full of a live drop now.
    await expect(draft()).rejects.toBeInstanceOf(NoHeadroomError)
  })

  it('returns the headroom when draft GC collects an unfunded draft', async () => {
    await setControls({ capLuna: PRINCIPAL })
    const d = await draft()
    await pool.query(`UPDATE drops SET created_at = now() - interval '25 hours' WHERE public_id = $1`, [
      d.publicId,
    ])
    expect(await gcDrafts(pool)).toBe(1)

    expect((await reservedPrincipalLuna(pool)).luna).toBe(0n)
    await expect(draft()).resolves.toBeDefined()
  })

  it('caps the NUMBER of drops as well as their total value', async () => {
    // Two 5 NIM drops fit inside a 12 NIM cap. On the first mainnet run that is
    // one drop too many, and a principal cap alone cannot say so.
    await setControls({ capLuna: PRINCIPAL * 3n, maxLiveDrops: 1 })
    const first = await draft()
    expect(first.capacity.remainingDrops).toBe(0)
    expect(first.capacity.remainingLuna, 'value headroom is not the binding limit here').toBe(
      PRINCIPAL * 2n,
    )

    const err = await draft().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NoHeadroomError)
    expect((err as NoHeadroomError).capacity.remainingDrops).toBe(0)
  })

  it('refuses to issue funding instructions while custody is paused', async () => {
    // Being told where to send money is a promise it will be accepted. Nothing
    // can be activated while custody is paused, so the money would sit in the
    // wallet waiting for an operator.
    await setControls({ paused: true })
    await expect(draft()).rejects.toBeInstanceOf(PausedError)
    expect(await draftCount()).toBe(0)
  })

  it('still issues funding instructions when reconciliation is stale', async () => {
    // A reservation spends nothing, so it does not need a trustworthy balance.
    // `submitFunding` reconciles before it activates, and `lockControls` is
    // still what refuses to move money on a stale one.
    await pool.query(
      `UPDATE custody_controls SET last_reconciled_at = now() - interval '1 day' WHERE singleton`,
    )
    await expect(draft()).resolves.toBeDefined()
  })

  // ---- migration 024: operator-funded drops ----------------------------------
  //
  // Created directly `live`, no draft, no funding transaction. The float has
  // to be attested AND actually on chain for `reconcile()` to stay clean, so
  // `floatOperator` deposits real chain money before attesting it — an
  // operator drop's own creation adds no chain transaction at all.

  describe('operator-funded drops (operator-funded drops design doc)', () => {
    const GATE = {
      kind: 'passphrase' as const,
      listed: false,
      config: { hash: 'operator-test-hash', hint: 'operator test hint' },
    }

    /** Attest AND deposit a float of exactly `totalFloatLuna`, then reconcile
     * so it is clean before the caller spends it against `assertSolvent`. */
    async function floatOperator(totalFloatLuna: bigint): Promise<void> {
      const already = await chain.confirmedBalanceLuna(CUSTODY)
      const extra = totalFloatLuna - already
      if (extra > 0n) {
        chain.deposit({
          hash: `operator-float-top-up-${randomUUID()}`,
          sender: 'NQ07 OPERATOR',
          recipient: CUSTODY,
          valueLuna: extra,
          includedHeight: 1,
        })
      }
      await setControls({ operatorFloatLuna: totalFloatLuna })
      finalize()
      await reconcile(pool, chain)
    }

    function operatorDrop(o: { amountEachLuna?: bigint; claimCount?: number } = {}) {
      return createOperatorFundedDrop(pool, {
        sponsorLabel: 'Operator',
        amountEachLuna: o.amountEachLuna ?? AMOUNT_EACH,
        claimCount: o.claimCount ?? CLAIM_COUNT,
        gate: GATE,
      })
    }

    it('creates a drop directly live and gated, with no activation and no refund address', async () => {
      await floatOperator(PRINCIPAL + FEE_FLOAT)

      const created = await operatorDrop()

      const row = await readDrop(created.publicId)
      expect(row.state).toBe('live')
      expect(row.activated_height).toBeNull()
      expect(row.refund_address).toBeNull()
      expect(row.funding_tx_hash).toBeNull()
      expect(row.funding_source).toBe('operator')
      expect(row.expires_at).not.toBeNull()

      const { rows: gateRows } = await pool.query<{ kind: string; listed: boolean }>(
        `SELECT g.kind, g.listed FROM drop_gates g JOIN drops d ON d.id = g.drop_id
         WHERE d.public_id = $1`,
        [created.publicId],
      )
      expect(gateRows).toHaveLength(1)
      expect(gateRows[0]).toMatchObject({ kind: 'passphrase', listed: false })

      expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
    })

    it('is refused when headroom is one luna short of the principal, accepted at exactly enough', async () => {
      await floatOperator(PRINCIPAL + FEE_FLOAT - 1n)
      await expect(operatorDrop()).rejects.toBeInstanceOf(InsolventError)
      expect(await outstandingPrincipalLuna(pool)).toBe(0n)
      expect(await draftCount()).toBe(0)

      await floatOperator(PRINCIPAL + FEE_FLOAT)
      await expect(operatorDrop()).resolves.toBeDefined()
      expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
    })

    it('reconcile finds no shortfall after creation: the ledger still equals the chain', async () => {
      await floatOperator(PRINCIPAL + FEE_FLOAT)
      await operatorDrop()

      const result = await reconcile(pool, chain)
      expect(result.short).toBe(false)
      const controls = await readControls(pool)
      expect(controls.paused).toBe(false)
      expect(controls.shortfallDetectedAt).toBeNull()
    })

    it('refuses to run while custody is paused, unlike a draft', async () => {
      await floatOperator(PRINCIPAL + FEE_FLOAT)
      await setControls({ paused: true, operatorFloatLuna: PRINCIPAL + FEE_FLOAT })
      await expect(operatorDrop()).rejects.toBeInstanceOf(PausedError)
      expect(await outstandingPrincipalLuna(pool)).toBe(0n)
    })

    // Regression for a review finding: `assertSolvent` deliberately does not
    // weigh a sponsor's draft reservation (`reservedPrincipalLuna`) — by
    // design, because it decides whether to honour money that has ALREADY
    // arrived (see its own docstring). An operator drop is a NEW promise, not
    // money that has arrived, so it must be checked against the same cap
    // `createDraft` is checked against — including reservations a sponsor is
    // already holding — via `assertCapacityFor`. Without that call, an
    // operator drop could commit principal a concurrent sponsor's reservation
    // was counting on, and that sponsor's real, finalized on-chain deposit
    // would then fail `activate()`'s cap check with nowhere for the NIM to go.
    it('is refused when a concurrent sponsor draft reservation already holds the cap', async () => {
      // The ledger balance is generous on its own — assertSolvent alone would
      // allow this drop — so this only fails if the policy cap also weighs
      // the sponsor's reservation.
      await floatOperator(PRINCIPAL * 2n + FEE_FLOAT)
      await pool.query('UPDATE custody_controls SET max_live_principal_luna = $1 WHERE singleton', [
        (PRINCIPAL + PRINCIPAL / 2n).toString(),
      ])

      const sponsorDraft = await draft()
      expect(sponsorDraft.capacity.reservedLuna).toBe(PRINCIPAL)

      await expect(operatorDrop()).rejects.toBeInstanceOf(CapExceededError)
      expect(await outstandingPrincipalLuna(pool)).toBe(0n)

      // The sponsor's reservation lapses (they never paid) and the identical
      // operator drop now fits.
      await pool.query(
        `UPDATE drops SET funding_reservation_expires_at = now() - interval '1 minute'
         WHERE public_id = $1`,
        [sponsorDraft.publicId],
      )
      await expect(operatorDrop()).resolves.toBeDefined()
    })

    // ---- migration 025: uncapped operator drops ------------------------------

    function uncappedOperatorDrop(o: { amountEachLuna?: bigint } = {}) {
      return createOperatorFundedDrop(pool, {
        sponsorLabel: 'Operator',
        amountEachLuna: o.amountEachLuna ?? AMOUNT_EACH,
        claimCount: null,
        gate: GATE,
      })
    }

    it('creates an uncapped drop with claim_count and expected_funding_luna both NULL', async () => {
      await floatOperator(FEE_FLOAT)

      const created = await uncappedOperatorDrop()

      const { rows } = await pool.query<{ claim_count: number | null; expected_funding_luna: string | null }>(
        'SELECT claim_count, expected_funding_luna FROM drops WHERE public_id = $1',
        [created.publicId],
      )
      expect(rows[0].claim_count).toBeNull()
      expect(rows[0].expected_funding_luna).toBeNull()
      // No claims yet, so this drop owes nothing — an uncapped drop's
      // liability is its unfinalized payouts, and there are none.
      expect(await outstandingPrincipalLuna(pool)).toBe(0n)
    })

    it('projects remaining and claimCount as null for an uncapped drop', async () => {
      await floatOperator(FEE_FLOAT)
      const created = await uncappedOperatorDrop()

      const pub = await getPublic(pool, created.publicId)
      expect(pub.claimCount).toBeNull()
      expect(pub.remaining).toBeNull()
      expect(pub.state).toBe('live')
    })
  })

  // ---- public projection ----------------------------------------------------

  it('never exposes claimant data in the public projection', async () => {
    const d = await draft()
    const hash = fund(d.publicId)
    finalize()
    await submitFunding(pool, chain, { publicId: d.publicId, txHash: hash })

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM drops WHERE public_id = $1', [
      d.publicId,
    ])
    await pool.query(
      `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
       VALUES ($1, 0, 'NQ07 CLAIMANT SECRET', 'hash-0', 'reserved'),
              ($1, 1, 'NQ07 OTHER CLAIMANT', 'hash-1', 'paid')`,
      [rows[0].id],
    )

    const pub = await getPublic(pool, d.publicId)
    expect(pub.remaining).toBe(CLAIM_COUNT - 2)
    const serialized = JSON.stringify(pub)
    expect(serialized).not.toContain('CLAIMANT')
    expect(serialized).not.toContain(rows[0].id)
    // `expiryHours` is on this list deliberately: it is the sponsor's own
    // published choice, already derivable from `expiresAt`, and it says nothing
    // about any claimant. `closingReason` is here on the same terms: it says
    // only why the holder of the link cannot claim, and names no address, no
    // amount and no time. Every other addition has to be argued for here too.
    expect(pub.closingReason, 'an open drop reports no reason, not a default').toBeNull()
    // `gateKind` joins on the same terms: the sponsor's own published choice
    // of condition, one word from a closed set, naming no claimant and no gate
    // content — served so a scored gate's claim screen can say "up to".
    expect(Object.keys(pub).sort()).toEqual(
      [
        'amountEach',
        'claimCount',
        'closingReason',
        'expiresAt',
        'expiryHours',
        'fundingTxHash',
        'gateKind',
        'message',
        'publicId',
        'remaining',
        'sponsorLabel',
        'state',
      ].sort(),
    )
  })

  it('reports an unknown public id as not found', async () => {
    await expect(getPublic(pool, 'aaaaaaaaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(DropNotFoundError)
  })
})
