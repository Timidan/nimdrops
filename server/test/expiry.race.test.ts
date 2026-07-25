import { randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import type { AlertKind, Alerts } from '../src/services/alerts'
import { ClaimRejectedError, issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, submitFunding } from '../src/services/drops'
import { DRAFT_GC_AFTER_HOURS, gcDrafts, settleTerminal, sweepExpiry } from '../src/services/expiry'
import { runWorkerTick } from '../src/services/transfers'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Expiry serializes on the singleton `custody_controls` row and settlement reads
 * `outstandingPrincipalLuna`, a GLOBAL aggregate over every drop. Neither can be
 * shared with the other `*.race.test.ts` files vitest runs in parallel, so this
 * suite migrates a private Postgres schema and points its own pool's
 * `search_path` at it.
 */
const SCHEMA = 'expiry_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
/** Operator's pre-funded fee float, matching `configured_fee_reserve_luna`. */
const FEE_FLOAT = 100_000n

/** Iterations of the claim-versus-expiry race (design §9 step 1). */
const RACE_ITERATIONS = 20
/**
 * How far ahead of expiry the "claim gets there first" iterations start. Large
 * enough that a reservation always commits inside it on any machine, so the
 * claim-wins branch is exercised deterministically rather than by timing chance.
 */
const CLAIM_HEADSTART_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let pool: pg.Pool
let chain: FakeChain

// ---- alert spy ---------------------------------------------------------------

interface SentAlert {
  alert: AlertKind
  detail: Record<string, unknown>
}

interface SpyAlerts extends Alerts {
  sent: SentAlert[]
  alertNames(): AlertKind[]
}

function spyAlerts(): SpyAlerts {
  const sent: SentAlert[] = []
  return {
    sent,
    alertNames: () => sent.map((a) => a.alert),
    async notify(alert, detail) {
      sent.push({ alert, detail })
    },
  }
}

let alerts: SpyAlerts

// ---- chain doubles -----------------------------------------------------------

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

/** The node is up but cannot answer: "we could not ask" is NOT "absent". */
function lookupsFail(base: FakeChain): ChainClient {
  return chainWith(base, {
    getTransaction: async () => {
      throw new Error('rpc down')
    },
  })
}

// ---- fixtures ----------------------------------------------------------------

interface Wallet {
  publicKeyHex: string
  address: string
  sign(message: string): string
}

/** A real Ed25519 wallet: the suite never fakes a signature it then verifies. */
function newWallet(): Wallet {
  const keyPair = KeyPair.generate()
  return {
    publicKeyHex: keyPair.publicKey.toHex(),
    address: keyPair.publicKey.toAddress().toUserFriendlyAddress(),
    sign: (message: string) => keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
  }
}

function newChain(): FakeChain {
  const c = new FakeChain({ custody: CUSTODY, finalityDepth: FINALITY_DEPTH, headHeight: FUND_HEIGHT })
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

/**
 * Create, fund, finalize and activate a drop; returns its public id.
 * Funds at the CURRENT head so a test that already advanced the chain (by
 * draining the worker) can still activate a second drop.
 */
async function liveDrop(o: { claimCount?: number } = {}): Promise<string> {
  const claimCount = o.claimCount ?? CLAIM_COUNT
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount,
  })
  const hash = `tx-${draft.publicId}`
  const height = Math.max(await chain.headHeight(), FUND_HEIGHT)
  chain.deposit({
    hash,
    sender: SPONSOR,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(claimCount),
    dataUtf8: draft.fundingMemo,
    includedHeight: height,
  })
  chain.setHead(height + FINALITY_DEPTH)
  const pub = await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  expect(pub.state).toBe('live')
  return draft.publicId
}

/** Reserve one slot on a live drop with a fresh wallet. */
async function reserveOne(publicId: string): Promise<string> {
  const wallet = newWallet()
  const issued = await issueChallenge(pool, publicId)
  const claim = await reserveClaim(pool, {
    publicId,
    challengeId: issued.challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: wallet.sign(issued.message),
    idemKey: randomUUID(),
    requestHash: 'request-hash-a',
  })
  return claim.claimId
}

// ---- reads -------------------------------------------------------------------

interface DropRow {
  id: string
  state: string
  closing_reason: string | null
  refund_address: string | null
}

async function readDrop(publicId: string): Promise<DropRow> {
  const { rows } = await pool.query<DropRow>(
    'SELECT id, state, closing_reason, refund_address FROM drops WHERE public_id = $1',
    [publicId],
  )
  return rows[0]
}

interface TransferRow {
  id: string
  idempotency_key: string
  purpose: string
  claim_id: string | null
  recipient_address: string
  amount_luna: string
  state: string
}

async function readTransfers(publicId: string): Promise<TransferRow[]> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT t.id, t.idempotency_key, t.purpose, t.claim_id, t.recipient_address,
            t.amount_luna, t.state
     FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
     WHERE d.public_id = $1
     ORDER BY t.purpose, t.created_at`,
    [publicId],
  )
  return rows
}

async function readRefunds(publicId: string): Promise<TransferRow[]> {
  return (await readTransfers(publicId)).filter((t) => t.purpose === 'refund')
}

/** Force a live drop past its expiry without waiting 24 hours. */
async function expireNow(publicId: string, offsetSql = `- interval '1 second'`): Promise<void> {
  await pool.query(`UPDATE drops SET expires_at = now() ${offsetSql} WHERE public_id = $1`, [
    publicId,
  ])
}

/**
 * Run the worker until nothing is left unconfirmed, advancing the head past
 * finality after every tick. The cooldown on `queued` intents is cleared so a
 * deferred retry does not stall a test that has no real clock.
 */
async function drainWorker(maxTicks = 60): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outgoing_transfers WHERE state NOT IN ('confirmed', 'manual_review')`,
    )
    if (rows[0].n === '0') return
    await runWorkerTick(pool, chain, alerts)
    chain.setHead((await chain.headHeight()) + FINALITY_DEPTH)
    await pool.query(
      `UPDATE outgoing_transfers SET next_attempt_at = NULL WHERE state = 'queued'`,
    )
  }
  throw new Error('worker did not drain within the tick budget')
}

async function setPaused(paused: boolean): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = $1 WHERE singleton', [paused])
}

// ---- suite -------------------------------------------------------------------

describe.skipIf(!hasDb)('expiry, exact refunds, settlement and draft GC (real Postgres)', () => {
  const saved = {
    network: process.env.NIMIQ_NETWORK,
    origin: process.env.PUBLIC_ORIGIN,
    scheme: process.env.SIG_SCHEME,
    secret: process.env.STATUS_TOKEN_SECRET,
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
      max: 8,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
    restoreEnv()
  })

  beforeEach(async () => {
    setEnv()
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       http_idempotency RESTART IDENTITY CASCADE`,
    )
    await pool.query(
      `UPDATE custody_controls
       SET paused = false,
           max_live_principal_luna = 10000000,
           configured_fee_reserve_luna = ${FEE_FLOAT},
           operator_float_luna = ${FEE_FLOAT},
           reconciled_confirmed_balance_luna = NULL,
           last_reconciled_height = NULL,
           last_reconciled_at = NULL
       WHERE singleton`,
    )
    chain = newChain()
    alerts = spyAlerts()
  })

  afterEach(setEnv)

  function setEnv(): void {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'expiry-race-test-secret'
  }

  function restoreEnv(): void {
    for (const [key, value] of [
      ['NIMIQ_NETWORK', saved.network],
      ['PUBLIC_ORIGIN', saved.origin],
      ['SIG_SCHEME', saved.scheme],
      ['STATUS_TOKEN_SECRET', saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // ---- exact refunds ----------------------------------------------------------

  it('refunds ONLY the unallocated slots, to the verified funding sender', async () => {
    const publicId = await liveDrop() // 5 slots
    await reserveOne(publicId)
    await reserveOne(publicId)
    await reserveOne(publicId)
    await expireNow(publicId)

    expect(await sweepExpiry(pool, alerts)).toBe(1)

    const drop = await readDrop(publicId)
    expect(drop).toMatchObject({ state: 'closing', closing_reason: 'expired' })

    const refunds = await readRefunds(publicId)
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({
      idempotency_key: `refund:${drop.id}`,
      purpose: 'refund',
      claim_id: null,
      // Only the 2 unclaimed slots. Reserved claimant value is never swept
      // into the creator's refund (design §9).
      amount_luna: (AMOUNT_EACH * 2n).toString(),
      recipient_address: SPONSOR,
      state: 'queued',
    })

    // Every luna is accounted for exactly once: 3 payouts + 1 refund = principal.
    const total = (await readTransfers(publicId)).reduce((sum, t) => sum + BigInt(t.amount_luna), 0n)
    expect(total).toBe(AMOUNT_EACH * BigInt(CLAIM_COUNT))
  })

  it('creates no refund when every slot was claimed, and settles after payouts confirm', async () => {
    const publicId = await liveDrop({ claimCount: 2 })
    await reserveOne(publicId)
    await reserveOne(publicId)

    // The last reservation already closed the drop (design §6.1).
    expect(await readDrop(publicId)).toMatchObject({
      state: 'closing',
      closing_reason: 'exhausted',
    })

    await expireNow(publicId)
    // An exhausted drop is not `live`: expiry has nothing to close and nothing
    // to refund.
    expect(await sweepExpiry(pool, alerts)).toBe(0)
    expect(await readRefunds(publicId)).toHaveLength(0)

    // Non-terminal while the money is still in flight.
    expect(await settleTerminal(pool)).toBe(0)
    expect((await readDrop(publicId)).state).toBe('closing')

    await drainWorker()
    expect((await readTransfers(publicId)).every((t) => t.state === 'confirmed')).toBe(true)

    expect(await settleTerminal(pool)).toBe(1)
    expect((await readDrop(publicId)).state).toBe('settled')
    // Idempotent: a settled drop is terminal and never re-settles.
    expect(await settleTerminal(pool)).toBe(0)
  })

  it('marks refunded only after EVERY payout and the refund are confirmed', async () => {
    const publicId = await liveDrop() // 5 slots
    await reserveOne(publicId)
    await reserveOne(publicId)
    await expireNow(publicId)
    await sweepExpiry(pool, alerts)

    const refundId = (await readRefunds(publicId))[0].id

    // Confirm the two payouts but hold the refund back: the drop must stay
    // non-terminal while any liability is unfinished.
    await pool.query(
      `UPDATE outgoing_transfers SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [refundId],
    )
    for (let i = 0; i < 20; i++) {
      await runWorkerTick(pool, chain, alerts)
      chain.setHead((await chain.headHeight()) + FINALITY_DEPTH)
    }
    const payouts = (await readTransfers(publicId)).filter((t) => t.purpose === 'payout')
    expect(payouts.every((t) => t.state === 'confirmed')).toBe(true)
    expect(await settleTerminal(pool)).toBe(0)
    expect((await readDrop(publicId)).state).toBe('closing')

    await pool.query(`UPDATE outgoing_transfers SET next_attempt_at = NULL WHERE id = $1`, [
      refundId,
    ])
    await drainWorker()

    expect(await settleTerminal(pool)).toBe(1)
    expect((await readDrop(publicId)).state).toBe('refunded')

    // The refund actually left custody, for exactly the unallocated amount.
    const refundTx = chain
      .allTxs()
      .find((tx) => tx.sender === CUSTODY && tx.recipient === SPONSOR)
    expect(refundTx?.valueLuna).toBe(AMOUNT_EACH * 3n)
  })

  it('keeps a drop non-terminal while a payout is in manual_review', async () => {
    const publicId = await liveDrop({ claimCount: 2 })
    await reserveOne(publicId)
    await expireNow(publicId)
    await sweepExpiry(pool, alerts)

    // Sign + broadcast both intents, then make every chain lookup fail and age
    // the attempts past the unresolved budget: transfers.ts flags them for a
    // human (design §8.3).
    await runWorkerTick(pool, chain, alerts)
    await runWorkerTick(pool, chain, alerts)
    await pool.query(`UPDATE transaction_attempts SET created_at = now() - interval '1 hour'`)
    const blind = lookupsFail(chain)
    await runWorkerTick(pool, blind, alerts)
    await runWorkerTick(pool, blind, alerts)

    const transfers = await readTransfers(publicId)
    expect(transfers.some((t) => t.state === 'manual_review')).toBe(true)
    expect(alerts.alertNames()).toContain('manual_review')

    // Neither settled nor refunded: the drop stays open around stuck money.
    expect(await settleTerminal(pool)).toBe(0)
    expect((await readDrop(publicId)).state).toBe('closing')
  })

  // ---- one refund, ever -------------------------------------------------------

  it('creates exactly one refund intent even when the sweep runs twice', async () => {
    const publicId = await liveDrop()
    await reserveOne(publicId)
    await expireNow(publicId)

    expect(await sweepExpiry(pool, alerts)).toBe(1)
    expect(await sweepExpiry(pool, alerts)).toBe(0)
    expect(await readRefunds(publicId)).toHaveLength(1)

    // Two sweeps racing on the same drop still produce one refund: they
    // serialize on the custody lock and the loser sees a non-live drop.
    const other = await liveDrop()
    await reserveOne(other)
    await expireNow(other)
    await Promise.all([sweepExpiry(pool, alerts), sweepExpiry(pool, alerts)])
    expect(await readRefunds(other)).toHaveLength(1)
  })

  it('has a database backstop against a second refund row per drop', async () => {
    const publicId = await liveDrop()
    await expireNow(publicId)
    await sweepExpiry(pool, alerts)
    const drop = await readDrop(publicId)

    await expect(
      pool.query(
        `INSERT INTO outgoing_transfers (
           idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
         ) VALUES ($1, 'refund', $2, NULL, $3, $4, 'queued')`,
        [`refund-dup:${drop.id}`, drop.id, SPONSOR, AMOUNT_EACH.toString()],
      ),
    ).rejects.toThrow(/one_refund_per_drop|duplicate key/i)
  })

  // ---- THE RACE: a claim landing at the exact moment of expiry ----------------

  it(`resolves claim-versus-expiry one way or the other, ${RACE_ITERATIONS} times`, async () => {
    const outcomes = { claimWon: 0, expiryWon: 0 }

    for (let i = 0; i < RACE_ITERATIONS; i++) {
      // Two slots, one already taken: exactly one slot is in dispute.
      const publicId = await liveDrop({ claimCount: 2 })
      await reserveOne(publicId)

      // Vary the instant of expiry relative to the two callers so BOTH branches
      // get exercised. Negative/zero offsets are the contended case: the drop
      // is already expired, so the claim and the sweep genuinely fight over the
      // custody lock and the drop row. A positive offset lets the claim reach
      // the last slot first, which is the case that must never be swept into a
      // refund afterwards.
      const offsetMs = [-2, 0, CLAIM_HEADSTART_MS, CLAIM_HEADSTART_MS][i % 4]
      await expireNow(publicId, `+ make_interval(secs => ${offsetMs} / 1000.0)`)

      const wallet = newWallet()
      const issued = await issueChallenge(pool, publicId)
      const [claimOutcome] = await Promise.allSettled([
        reserveClaim(pool, {
          publicId,
          challengeId: issued.challengeId,
          publicKeyHex: wallet.publicKeyHex,
          signatureHex: wallet.sign(issued.message),
          idemKey: `race-${i}`,
          requestHash: `race-${i}`,
        }),
        sweepExpiry(pool, alerts),
      ])

      // A sweep that started before the expiry instant sees nothing. Wait until
      // the instant has definitely passed and sweep again, so every iteration
      // ends in the drop's final closed shape — and so a slot claimed at the
      // wire gets a full chance to be wrongly refunded.
      if (offsetMs > 0) await sleep(offsetMs + 5)
      await sweepExpiry(pool, alerts)

      const drop = await readDrop(publicId)
      const transfers = await readTransfers(publicId)
      const payouts = transfers.filter((t) => t.purpose === 'payout')
      const refunds = transfers.filter((t) => t.purpose === 'refund')
      const where = `iteration ${i} (offset ${offsetMs}ms)`

      if (claimOutcome.status === 'fulfilled') {
        // The claim won the disputed slot: BOTH slots are payouts and there is
        // nothing left to refund.
        outcomes.claimWon++
        expect(payouts, where).toHaveLength(2)
        expect(refunds, where).toHaveLength(0)
        expect(drop.state, where).toBe('closing')
        expect(drop.closing_reason, where).toBe('exhausted')
      } else {
        // Expiry won: the claim is refused with a reason its UI can render, and
        // the whole remaining slot is refunded.
        outcomes.expiryWon++
        const reason = claimOutcome.reason as ClaimRejectedError
        expect(reason, where).toBeInstanceOf(ClaimRejectedError)
        expect(['drop_expired', 'exhausted'], where).toContain(reason.code)
        expect(payouts, where).toHaveLength(1)
        expect(refunds, where).toHaveLength(1)
        expect(refunds[0].amount_luna, where).toBe(AMOUNT_EACH.toString())
        expect(drop.state, where).toBe('closing')
      }

      // Never both, never neither: the drop's principal is allocated exactly
      // once, whichever way the race resolved.
      const total = transfers.reduce((sum, t) => sum + BigInt(t.amount_luna), 0n)
      expect(total, `${where}: payouts + refund must equal the funded principal`).toBe(
        AMOUNT_EACH * 2n,
      )
      // And a later sweep can never add a refund on top.
      await sweepExpiry(pool, alerts)
      expect((await readRefunds(publicId)).length, where).toBe(refunds.length)
    }

    // Recorded so a run's evidence shows HOW the race actually resolved, not
    // merely that it stayed consistent.
    console.info(JSON.stringify({ event: 'claim_vs_expiry_race', ...outcomes }))
    expect(outcomes.claimWon + outcomes.expiryWon).toBe(RACE_ITERATIONS)
    // Both directions must actually have occurred, or the invariant above was
    // only ever checked against half the state space.
    expect(outcomes.expiryWon).toBeGreaterThan(0)
    expect(outcomes.claimWon).toBeGreaterThan(0)
  })

  // ---- fail closed ------------------------------------------------------------

  it('refuses to sweep while custody is paused, and alerts', async () => {
    const publicId = await liveDrop()
    await reserveOne(publicId)
    await expireNow(publicId)
    await setPaused(true)

    expect(await sweepExpiry(pool, alerts)).toBe(0)
    expect(alerts.alertNames()).toContain('paused')
    expect(await readRefunds(publicId)).toHaveLength(0)
    expect((await readDrop(publicId)).state).toBe('live')

    await setPaused(false)
    expect(await sweepExpiry(pool, alerts)).toBe(1)
    expect(await readRefunds(publicId)).toHaveLength(1)
  })

  it('alerts as insolvent when a tick is deferred by the solvency invariant', async () => {
    const publicId = await liveDrop()
    await reserveOne(publicId)

    // The ledger balance can no longer cover outstanding principal plus the fee
    // reserve — the operator float that backs the reserve is gone — so the
    // worker must sign nothing and page the operator.
    await pool.query('UPDATE custody_controls SET operator_float_luna = 0 WHERE singleton')

    expect(await runWorkerTick(pool, chain, alerts)).toBe('idle')
    expect(alerts.alertNames()).toContain('insolvent')

    const payouts = (await readTransfers(publicId)).filter((t) => t.purpose === 'payout')
    expect(payouts[0].state).toBe('queued')
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM transaction_attempts',
    )
    expect(rows[0].n, 'nothing may be signed while insolvent').toBe('0')
  })

  // ---- draft garbage collection (design §6.1) ---------------------------------

  it('cancels unfunded drafts older than 24h and never touches funded drops', async () => {
    const stale = await createDraft(pool, chain, {
      sponsorLabel: 'Stale',
      amountEachLuna: AMOUNT_EACH,
      claimCount: CLAIM_COUNT,
    })
    const fresh = await createDraft(pool, chain, {
      sponsorLabel: 'Fresh',
      amountEachLuna: AMOUNT_EACH,
      claimCount: CLAIM_COUNT,
    })
    const pending = await createDraft(pool, chain, {
      sponsorLabel: 'Pending',
      amountEachLuna: AMOUNT_EACH,
      claimCount: CLAIM_COUNT,
    })
    const funded = await liveDrop()

    // Age everything past the GC horizon; only the unfunded draft may go.
    await pool.query(
      `UPDATE drops SET created_at = now() - make_interval(hours => $1)`,
      [DRAFT_GC_AFTER_HOURS + 1],
    )
    await pool.query(`UPDATE drops SET created_at = now() WHERE public_id = $1`, [fresh.publicId])
    await pool.query(
      `UPDATE drops SET state = 'funding_pending', funding_tx_hash = 'pending-hash'
       WHERE public_id = $1`,
      [pending.publicId],
    )

    expect(await gcDrafts(pool)).toBe(1)

    expect((await readDrop(stale.publicId)).state).toBe('cancelled')
    expect((await readDrop(fresh.publicId)).state).toBe('awaiting_funding')
    // Money arrived, or may have: GC is not a refund path (design §7).
    expect((await readDrop(pending.publicId)).state).toBe('funding_pending')
    expect((await readDrop(funded)).state).toBe('live')

    // Idempotent.
    expect(await gcDrafts(pool)).toBe(0)
  })
})
