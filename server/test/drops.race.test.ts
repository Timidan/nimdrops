import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient, ChainTx } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import { CapError } from '../src/money'
import {
  DropNotFoundError,
  FundingRejectedError,
  createDraft,
  getPublic,
  submitFunding,
} from '../src/services/drops'
import { CapExceededError, outstandingPrincipalLuna } from '../src/services/solvency'
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

async function draft(o: { amountEachLuna?: bigint; claimCount?: number; message?: string } = {}) {
  return createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: o.amountEachLuna ?? AMOUNT_EACH,
    claimCount: o.claimCount ?? CLAIM_COUNT,
    ...(o.message === undefined ? {} : { message: o.message }),
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
    expires_at: Date | null
  }>(
    `SELECT state, creator_address, refund_address, funding_tx_hash, activated_height, expires_at
     FROM drops WHERE public_id = $1`,
    [publicId],
  )
  return rows[0]
}

async function setControls(o: { paused?: boolean; capLuna?: bigint; feeReserveLuna?: bigint }) {
  await pool.query(
    `UPDATE custody_controls
     SET paused = $1, max_live_principal_luna = $2, configured_fee_reserve_luna = $3
     WHERE singleton`,
    [o.paused ?? false, (o.capLuna ?? 10_000_000n).toString(), (o.feeReserveLuna ?? FEE_FLOAT).toString()],
  )
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
       http_idempotency RESTART IDENTITY CASCADE`,
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

  it('enforces the launch caps at draft time', async () => {
    await expect(draft({ claimCount: 1 })).rejects.toBeInstanceOf(CapError)
    await expect(draft({ claimCount: 21 })).rejects.toBeInstanceOf(CapError)
    await expect(draft({ amountEachLuna: 1_000_000n, claimCount: 20 })).rejects.toBeInstanceOf(CapError)
    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM drops')
    expect(rows[0].count).toBe('0')
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

    const expires = row.expires_at!.getTime()
    expect(expires).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 5_000)
    expect(expires).toBeLessThanOrEqual(after + 24 * 3600_000 + 5_000)
    expect(pub.expiresAt?.getTime()).toBe(expires)

    expect(await outstandingPrincipalLuna(pool)).toBe(PRINCIPAL)
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
    // Either drop fits alone; together they exceed the cap.
    await setControls({ capLuna: PRINCIPAL + PRINCIPAL / 2n })
    const a = await draft()
    const b = await draft()
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
    expect(Object.keys(pub).sort()).toEqual(
      [
        'amountEach',
        'claimCount',
        'expiresAt',
        'fundingTxHash',
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
