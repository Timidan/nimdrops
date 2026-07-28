import { randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { issueGrant } from '../src/gates/grants'
import type { AlertKind, Alerts } from '../src/services/alerts'
import { ClaimRejectedError, issueChallenge, reserveClaim } from '../src/services/claims'
import { CloseRejectedError, closeDropBySponsor, issueCloseChallenge } from '../src/services/close'
import { createDraft, getPublic, submitFunding } from '../src/services/drops'
import { settleTerminal, sweepExpiry } from '../src/services/expiry'
import { PausedError } from '../src/services/solvency'
import { runWorkerTick } from '../src/services/transfers'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The sponsor's early close (`services/close.ts`), which is the expiry sweeper's
 * transition triggered by a signature instead of by the clock.
 *
 * Everything here is written against ONE question: can closing a drop ever take
 * a share away from somebody who had already reserved it? The answer has to be
 * no in both orderings, under real concurrency, with the sum of every payout
 * plus the refund equal to the funded principal exactly — which is what the
 * conservation assertion in each race checks, and why it is repeated rather than
 * factored down to a single happy-path case.
 *
 * The suite serializes on the singleton `custody_controls` row and reads global
 * aggregates, so it cannot share a schema with the other `*.race.test.ts` files:
 * it migrates a private schema and points its own pool's `search_path` at it.
 */
const SCHEMA = 'close_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
/** Operator's pre-funded fee float, matching `configured_fee_reserve_luna`. */
const FEE_FLOAT = 100_000n

/** Iterations of the claim-versus-close race. */
const RACE_ITERATIONS = 20
/**
 * How far one contender is started ahead of the other in the staggered
 * iterations. Large enough that the leader always commits first on any machine,
 * so BOTH branches of the race are exercised deterministically rather than by
 * timing luck — the un-staggered iterations in between are the genuine coin
 * flip, and every iteration asserts the same invariant either way.
 */
const HEADSTART_MS = 40

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
  c.deposit({
    hash: 'operator-fee-float',
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: FEE_FLOAT,
    includedHeight: 1,
  })
  return c
}

interface LiveDrop {
  publicId: string
  /** The internal id, needed only to attach a gate/grant straight to the row. */
  dropId: string
  /** The wallet that sent the funding transaction — the ONLY one that may close. */
  sponsor: Wallet
}

/**
 * Create, fund, finalize and activate a drop.
 *
 * The funding sender is a real wallet rather than a string, because the whole
 * authorization argument is that the closer's signature must derive to the
 * address `activate()` recorded from the funding transaction.
 */
async function liveDrop(o: { claimCount?: number } = {}): Promise<LiveDrop> {
  const claimCount = o.claimCount ?? CLAIM_COUNT
  const sponsor = newWallet()
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount,
  })
  const hash = `tx-${draft.publicId}`
  const height = Math.max(await chain.headHeight(), FUND_HEIGHT)
  chain.deposit({
    hash,
    sender: sponsor.address,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(claimCount),
    dataUtf8: draft.fundingMemo,
    includedHeight: height,
  })
  chain.setHead(height + FINALITY_DEPTH)
  const pub = await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  expect(pub.state).toBe('live')
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM drops WHERE public_id = $1', [
    draft.publicId,
  ])
  return { publicId: draft.publicId, dropId: rows[0].id, sponsor }
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
    requestHash: `request-${randomUUID()}`,
  })
  return claim.claimId
}

/** Attach a gate to a drop so a claim needs a grant to go through. */
async function attachGate(dropId: string, kind = 'passphrase'): Promise<void> {
  await pool.query(`INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, $2, '{}'::jsonb)`, [
    dropId,
    kind,
  ])
}

/** Issue a grant the way a real kind does — through `issueGrant`, not raw SQL. */
async function grantTo(dropId: string, walletAddress: string, payoutPermille?: number): Promise<void> {
  await issueGrant(pool, { dropId, walletAddress, kind: 'passphrase', payoutPermille })
}

/** Reserve one slot for a SPECIFIC wallet — needed once a grant names an address. */
async function reserveAs(publicId: string, wallet: Wallet): Promise<string> {
  const issued = await issueChallenge(pool, publicId)
  const claim = await reserveClaim(pool, {
    publicId,
    challengeId: issued.challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: wallet.sign(issued.message),
    idemKey: randomUUID(),
    requestHash: `request-${randomUUID()}`,
  })
  return claim.claimId
}

interface SignedClose {
  challengeId: string
  publicKeyHex: string
  signatureHex: string
}

/** Mint a close challenge and sign it with `wallet` — nothing is sent yet. */
async function signClose(publicId: string, wallet: Wallet): Promise<SignedClose> {
  const issued = await issueCloseChallenge(pool, publicId)
  return {
    challengeId: issued.challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: wallet.sign(issued.message),
  }
}

function sendClose(publicId: string, signed: SignedClose) {
  return closeDropBySponsor(pool, alerts, { publicId, ...signed })
}

/** Mint, sign and send in one step, for the cases that are not about timing. */
async function closeAs(publicId: string, wallet: Wallet) {
  return sendClose(publicId, await signClose(publicId, wallet))
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
  purpose: string
  claim_id: string | null
  recipient_address: string
  amount_luna: string
  state: string
}

async function readTransfers(publicId: string): Promise<TransferRow[]> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT t.purpose, t.claim_id, t.recipient_address, t.amount_luna, t.state
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

async function readPayouts(publicId: string): Promise<TransferRow[]> {
  return (await readTransfers(publicId)).filter((t) => t.purpose === 'payout')
}

/**
 * Payouts + refund, in luna. The one number every race in this file checks: it
 * must equal the funded principal exactly, whichever way the race resolved.
 */
async function allocatedLuna(publicId: string): Promise<bigint> {
  return (await readTransfers(publicId)).reduce((sum, t) => sum + BigInt(t.amount_luna), 0n)
}

async function challengeConsumed(challengeId: string): Promise<boolean> {
  const { rows } = await pool.query<{ consumed: boolean }>(
    'SELECT consumed_at IS NOT NULL AS consumed FROM wallet_challenges WHERE id = $1',
    [challengeId],
  )
  return rows[0].consumed
}

async function setState(publicId: string, state: string, reason: string | null = null): Promise<void> {
  await pool.query('UPDATE drops SET state = $2, closing_reason = $3 WHERE public_id = $1', [
    publicId,
    state,
    reason,
  ])
}

async function expireNow(publicId: string): Promise<void> {
  await pool.query(`UPDATE drops SET expires_at = now() - interval '1 second' WHERE public_id = $1`, [
    publicId,
  ])
}

async function setPaused(paused: boolean): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = $1 WHERE singleton', [paused])
}

async function drainWorker(maxTicks = 60): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outgoing_transfers WHERE state NOT IN ('confirmed', 'manual_review')`,
    )
    if (rows[0].n === '0') return
    await runWorkerTick(pool, chain, alerts)
    chain.setHead((await chain.headHeight()) + FINALITY_DEPTH)
    await pool.query(`UPDATE outgoing_transfers SET next_attempt_at = NULL WHERE state = 'queued'`)
  }
  throw new Error('worker did not drain within the tick budget')
}

// ---- suite -------------------------------------------------------------------

describe.skipIf(!hasDb)('sponsor-initiated early close (real Postgres)', () => {
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
       operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
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
    process.env.STATUS_TOKEN_SECRET = 'close-race-test-secret'
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

  // ---- the transition ---------------------------------------------------------

  it('refunds ONLY the unclaimed shares, to the funding address, and pays the rest', async () => {
    const { publicId, sponsor } = await liveDrop() // 5 slots
    await reserveOne(publicId)
    await reserveOne(publicId)

    const result = await closeAs(publicId, sponsor)
    expect(result).toEqual({
      reservedClaims: 2,
      unclaimedSlots: 3,
      refundLuna: AMOUNT_EACH * 3n,
    })

    const drop = await readDrop(publicId)
    expect(drop).toMatchObject({ state: 'closing', closing_reason: 'closed_by_sponsor' })

    const refunds = await readRefunds(publicId)
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({
      claim_id: null,
      amount_luna: (AMOUNT_EACH * 3n).toString(),
      // The funding sender, and nobody else — not a request field, not the
      // connected wallet, not the signer as such.
      recipient_address: sponsor.address,
      state: 'queued',
    })
    expect(await readPayouts(publicId)).toHaveLength(2)

    // Every luna accounted for exactly once.
    expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * BigInt(CLAIM_COUNT))
  })

  /**
   * A scored (sub-full-share) claim leaves an unpaid remainder on its own slot —
   * a slot that IS reserved, so `unclaimedSlots × amountEach` cannot see it. The
   * refund has to be the funded principal minus every payout actually committed,
   * or that remainder vanishes instead of returning to the sponsor.
   */
  it('refunds the funded principal minus committed payouts, not unclaimed slots × share', async () => {
    const { publicId, dropId, sponsor } = await liveDrop({ claimCount: 3 })
    const claimant = newWallet()
    await attachGate(dropId)
    await grantTo(dropId, claimant.address, 600)
    await reserveAs(publicId, claimant)

    const result = await closeAs(publicId, sponsor)

    const scoredPayout = (AMOUNT_EACH * 600n) / 1000n
    // `unclaimedSlots × amountEach` would say `AMOUNT_EACH * 2n` (200_000):
    // wrong, because it ignores the 40_000 luna unpaid on the reserved slot.
    expect(result).toMatchObject({
      reservedClaims: 1,
      unclaimedSlots: 2,
      refundLuna: AMOUNT_EACH * 3n - scoredPayout,
    })

    const payouts = await readPayouts(publicId)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].amount_luna).toBe(scoredPayout.toString())

    const refunds = await readRefunds(publicId)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].amount_luna).toBe((AMOUNT_EACH * 3n - scoredPayout).toString())

    // Every luna accounted for exactly once, including the unpaid remainder.
    expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * 3n)
  })

  /**
   * The claimant's screen says "the sponsor ended this early" on the strength
   * of this field, and it used to say it on the strength of a client-side
   * guess: left `live`, shares still showing, deadline still ahead. The guess
   * failed in the case it existed for — a sponsor closing in the last minutes
   * of the window reads as an ordinary expiry — so the reason is served.
   */
  it('publishes WHY the drop closed, and publishes nothing while it is open', async () => {
    const { publicId, sponsor } = await liveDrop()

    // Open: no reason at all. Not `expired` by default, not an omitted field.
    expect((await getPublic(pool, publicId)).closingReason).toBeNull()

    await closeAs(publicId, sponsor)
    expect((await getPublic(pool, publicId)).closingReason).toBe('closed_by_sponsor')

    // And it survives the refund: the claimant who opens the link tomorrow is
    // owed the same sentence as the one who opened it a second after the close.
    await drainWorker()
    await settleTerminal(pool)
    const after = await getPublic(pool, publicId)
    expect(after.state).toBe('refunded')
    expect(after.closingReason).toBe('closed_by_sponsor')
  })

  it('publishes `expired` for the sweeper\'s close, which is a different sentence', async () => {
    const { publicId } = await liveDrop()
    await expireNow(publicId)
    await sweepExpiry(pool, alerts)

    // Same shape as an early close from the outside — a drop that left `live`
    // with shares unclaimed — and the reader is told the truth about which.
    const pub = await getPublic(pool, publicId)
    expect(pub.remaining).toBeGreaterThan(0)
    expect(pub.closingReason).toBe('expired')
  })

  it('honours a claim reserved a millisecond earlier: closing never takes it back', async () => {
    const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
    const claimId = await reserveOne(publicId)
    // The close is signed BEFORE the claim would have been visible to a caller
    // holding a stale read, and sent immediately after the reservation commits.
    const signed = await signClose(publicId, sponsor)
    const result = await sendClose(publicId, signed)

    expect(result.reservedClaims).toBe(1)
    expect(result.refundLuna).toBe(AMOUNT_EACH)

    const payouts = await readPayouts(publicId)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].claim_id).toBe(claimId)
    expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * 2n)

    // And the claimant is still paid, all the way to a confirmed transfer.
    await drainWorker()
    const { rows } = await pool.query<{ state: string }>('SELECT state FROM claims WHERE id = $1', [
      claimId,
    ])
    expect(rows[0].state).toBe('paid')
  })

  it('creates no refund when every share was already reserved, and settles', async () => {
    const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
    await reserveOne(publicId)
    // The second reservation takes the last slot and closes the drop itself.
    await reserveOne(publicId)

    await expect(closeAs(publicId, sponsor)).rejects.toMatchObject({ code: 'already_closed' })
    expect(await readRefunds(publicId)).toHaveLength(0)

    await drainWorker()
    expect(await settleTerminal(pool)).toBe(1)
    expect((await readDrop(publicId)).state).toBe('settled')
  })

  it('closes a drop nobody claimed, and refunds the whole principal', async () => {
    const { publicId, sponsor } = await liveDrop({ claimCount: 2 })

    const result = await closeAs(publicId, sponsor)
    expect(result.refundLuna).toBe(AMOUNT_EACH * 2n)

    await drainWorker()
    expect(await settleTerminal(pool)).toBe(1)
    expect((await readDrop(publicId)).state).toBe('refunded')
    const refunds = await readRefunds(publicId)
    expect(refunds[0]).toMatchObject({ state: 'confirmed', recipient_address: sponsor.address })
  })

  it('allows a close seconds after funding: there is no minimum age', async () => {
    const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
    // No claims, no elapsed time, no expiry reached. This is the exact case the
    // feature exists for — a sponsor who funded the wrong drop a moment ago.
    const result = await closeAs(publicId, sponsor)
    expect(result.unclaimedSlots).toBe(2)
    expect((await readDrop(publicId)).closing_reason).toBe('closed_by_sponsor')
  })

  // ---- authorization ----------------------------------------------------------

  it('refuses a close signed by any wallet that is not the funder', async () => {
    const { publicId } = await liveDrop()
    const stranger = newWallet()

    const signed = await signClose(publicId, stranger)
    await expect(sendClose(publicId, signed)).rejects.toMatchObject({ code: 'not_the_funder' })

    // Nothing moved, and the stranger did not even spend the nonce: ownership is
    // checked BEFORE the challenge is consumed, so an attacker cannot burn a
    // sponsor's approval by racing them with it.
    expect(await challengeConsumed(signed.challengeId)).toBe(false)
    expect((await readDrop(publicId)).state).toBe('live')
    expect(await readRefunds(publicId)).toHaveLength(0)
  })

  it('refuses a forged signature, and a signature over someone else’s message', async () => {
    const { publicId, sponsor } = await liveDrop()
    const issued = await issueCloseChallenge(pool, publicId)

    // Right key, wrong bytes.
    await expect(
      closeDropBySponsor(pool, alerts, {
        publicId,
        challengeId: issued.challengeId,
        publicKeyHex: sponsor.publicKeyHex,
        signatureHex: sponsor.sign(`${issued.message} `),
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })

    // Right bytes, wrong key: the signature verifies for the stranger's key, but
    // the address it derives to is not the funder's.
    const stranger = newWallet()
    await expect(
      closeDropBySponsor(pool, alerts, {
        publicId,
        challengeId: issued.challengeId,
        publicKeyHex: stranger.publicKeyHex,
        signatureHex: sponsor.sign(issued.message),
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })

    expect((await readDrop(publicId)).state).toBe('live')
    expect(await challengeConsumed(issued.challengeId)).toBe(false)
  })

  it('refuses a close challenge minted for a different drop', async () => {
    const a = await liveDrop()
    const b = await liveDrop()

    const issued = await issueCloseChallenge(pool, a.publicId)
    await expect(
      closeDropBySponsor(pool, alerts, {
        publicId: b.publicId,
        challengeId: issued.challengeId,
        publicKeyHex: b.sponsor.publicKeyHex,
        signatureHex: b.sponsor.sign(issued.message),
      }),
    ).rejects.toMatchObject({ code: 'cross_drop_challenge' })

    expect((await readDrop(b.publicId)).state).toBe('live')
  })

  it('refuses a CLAIM challenge presented as a close, and the reverse', async () => {
    const { publicId, sponsor } = await liveDrop()

    // A signature harvested for a claim is not a close authorization.
    const claimChallenge = await issueChallenge(pool, publicId)
    await expect(
      closeDropBySponsor(pool, alerts, {
        publicId,
        challengeId: claimChallenge.challengeId,
        publicKeyHex: sponsor.publicKeyHex,
        signatureHex: sponsor.sign(claimChallenge.message),
      }),
    ).rejects.toMatchObject({ code: 'message_mismatch' })

    // And a close approval is not a claim.
    const closeChallenge = await issueCloseChallenge(pool, publicId)
    const claimant = newWallet()
    await expect(
      reserveClaim(pool, {
        publicId,
        challengeId: closeChallenge.challengeId,
        publicKeyHex: claimant.publicKeyHex,
        signatureHex: claimant.sign(closeChallenge.message),
        idemKey: randomUUID(),
        requestHash: 'cross-action',
      }),
    ).rejects.toMatchObject({ code: 'message_mismatch' })

    expect((await readDrop(publicId)).state).toBe('live')
    expect(await readTransfers(publicId)).toHaveLength(0)
  })

  it('spends a close challenge exactly once', async () => {
    const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
    const signed = await signClose(publicId, sponsor)
    await sendClose(publicId, signed)
    expect(await challengeConsumed(signed.challengeId)).toBe(true)

    // Reopen the drop by hand — no product path does this — so the SECOND
    // request meets the nonce check rather than stopping at the state check.
    // Single-use has to hold on its own, not only because the drop moved on.
    await setState(publicId, 'live')
    await expect(sendClose(publicId, signed)).rejects.toMatchObject({
      code: 'challenge_consumed',
    })
    expect(await readRefunds(publicId)).toHaveLength(1)
  })

  it('refuses a stored challenge this server could not have issued', async () => {
    const { publicId, sponsor } = await liveDrop()
    const signed = await signClose(publicId, sponsor)
    // A row rewritten to carry an action no verifier knows. It is a refusal,
    // not a server fault: nothing here may reach the client as a 500.
    await pool.query(
      `UPDATE wallet_challenges SET canonical_message = replace(canonical_message, '"close"', '"transfer"')
       WHERE id = $1`,
      [signed.challengeId],
    )
    await expect(sendClose(publicId, signed)).rejects.toMatchObject({ code: 'message_mismatch' })
    expect((await readDrop(publicId)).state).toBe('live')
  })

  it('refuses an expired challenge even with a good signature', async () => {
    const { publicId, sponsor } = await liveDrop()
    const signed = await signClose(publicId, sponsor)
    await pool.query(
      `UPDATE wallet_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [signed.challengeId],
    )

    await expect(sendClose(publicId, signed)).rejects.toMatchObject({ code: 'challenge_expired' })
    expect((await readDrop(publicId)).state).toBe('live')
  })

  // ---- one refund, ever -------------------------------------------------------

  it('creates exactly one refund when the same drop is closed twice', async () => {
    const { publicId, sponsor } = await liveDrop()
    const first = await signClose(publicId, sponsor)
    const second = await signClose(publicId, sponsor)

    await sendClose(publicId, first)
    await expect(sendClose(publicId, second)).rejects.toMatchObject({ code: 'already_closed' })
    expect(await readRefunds(publicId)).toHaveLength(1)
    expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * BigInt(CLAIM_COUNT))
  })

  it('creates exactly one refund when two closes are sent concurrently', async () => {
    const { publicId, sponsor } = await liveDrop()
    await reserveOne(publicId)
    const a = await signClose(publicId, sponsor)
    const b = await signClose(publicId, sponsor)

    const outcomes = await Promise.allSettled([sendClose(publicId, a), sendClose(publicId, b)])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    expect(await readRefunds(publicId)).toHaveLength(1)
    expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * BigInt(CLAIM_COUNT))
  })

  it('creates exactly one refund when the sweeper expires the drop at the same moment', async () => {
    for (const closeFirst of [true, false]) {
      const { publicId, sponsor } = await liveDrop()
      await reserveOne(publicId)
      const signed = await signClose(publicId, sponsor)
      await expireNow(publicId)

      const close = async () => {
        if (!closeFirst) await sleep(HEADSTART_MS)
        return sendClose(publicId, signed)
      }
      const sweep = async () => {
        if (closeFirst) await sleep(HEADSTART_MS)
        return sweepExpiry(pool, alerts)
      }
      const [closeOutcome] = await Promise.allSettled([close(), sweep()])

      // Whoever lost, the drop closed once and refunded once.
      const drop = await readDrop(publicId)
      expect(drop.state, `closeFirst=${closeFirst}`).toBe('closing')
      expect(['expired', 'closed_by_sponsor']).toContain(drop.closing_reason)
      if (closeOutcome.status === 'rejected') {
        expect(closeOutcome.reason).toBeInstanceOf(CloseRejectedError)
        expect((closeOutcome.reason as CloseRejectedError).code).toBe('already_closed')
      }

      const refunds = await readRefunds(publicId)
      expect(refunds, `closeFirst=${closeFirst}`).toHaveLength(1)
      expect(refunds[0].amount_luna).toBe((AMOUNT_EACH * 4n).toString())
      expect(await allocatedLuna(publicId)).toBe(AMOUNT_EACH * BigInt(CLAIM_COUNT))

      // A later sweep cannot add a second refund on top.
      await sweepExpiry(pool, alerts)
      expect(await readRefunds(publicId)).toHaveLength(1)
    }
  })

  // ---- only from live ---------------------------------------------------------

  it('refuses to close a drop in every non-live state, with a reason that fits', async () => {
    // A draft has nothing to refund, and says so in its own words.
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'Sponsor',
      amountEachLuna: AMOUNT_EACH,
      claimCount: 2,
    })
    await expect(issueCloseChallenge(pool, draft.publicId)).rejects.toMatchObject({
      code: 'drop_not_funded',
    })

    const cases: [string, string | null, string][] = [
      ['awaiting_funding', null, 'drop_not_funded'],
      ['funding_pending', null, 'drop_not_funded'],
      ['closing', 'expired', 'already_closed'],
      ['closing', 'exhausted', 'already_closed'],
      ['closing', 'closed_by_sponsor', 'already_closed'],
      ['settled', null, 'already_closed'],
      ['refunded', null, 'already_closed'],
      ['cancelled', null, 'drop_not_live'],
      ['paused', null, 'drop_not_live'],
      ['manual_review', null, 'drop_not_live'],
    ]

    for (const [state, reason, code] of cases) {
      const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
      // Signed while live, so the refusal comes from the state check under the
      // lock rather than from the challenge being unmintable.
      const signed = await signClose(publicId, sponsor)
      await setState(publicId, state, reason)

      await expect(sendClose(publicId, signed), `${state}/${reason}`).rejects.toMatchObject({ code })
      expect(await readRefunds(publicId), `${state}/${reason}`).toHaveLength(0)
      // A refused close spends nothing: the sponsor's approval survives.
      expect(await challengeConsumed(signed.challengeId), `${state}/${reason}`).toBe(false)
    }
  })

  it('refuses an unknown drop and an unknown challenge without saying which', async () => {
    const { publicId, sponsor } = await liveDrop()
    await expect(
      closeDropBySponsor(pool, alerts, {
        publicId,
        challengeId: randomUUID(),
        publicKeyHex: sponsor.publicKeyHex,
        signatureHex: sponsor.sign('anything'),
      }),
    ).rejects.toMatchObject({ code: 'unknown_challenge' })
  })

  // ---- fail closed ------------------------------------------------------------

  it('refuses to close while custody is paused, and alerts', async () => {
    const { publicId, sponsor } = await liveDrop()
    await reserveOne(publicId)
    const signed = await signClose(publicId, sponsor)
    await setPaused(true)

    await expect(sendClose(publicId, signed)).rejects.toBeInstanceOf(PausedError)
    expect(alerts.alertNames()).toContain('paused')
    expect(alerts.sent.some((a) => a.detail.stage === 'sponsor_close')).toBe(true)
    expect((await readDrop(publicId)).state).toBe('live')
    expect(await readRefunds(publicId)).toHaveLength(0)
    // The approval was not spent, so the sponsor can simply try again after.
    expect(await challengeConsumed(signed.challengeId)).toBe(false)

    await setPaused(false)
    await sendClose(publicId, signed)
    expect(await readRefunds(publicId)).toHaveLength(1)
  })

  // ---- THE RACE: a claim landing at the exact moment of the close --------------

  it(`resolves claim-versus-close one way or the other, ${RACE_ITERATIONS} times`, async () => {
    const outcomes = { claimWon: 0, closeWon: 0 }

    for (let i = 0; i < RACE_ITERATIONS; i++) {
      // Two slots, one already taken: exactly one slot is in dispute, so the two
      // contenders cannot both succeed and the invariant is sharp.
      const { publicId, sponsor } = await liveDrop({ claimCount: 2 })
      await reserveOne(publicId)

      const claimant = newWallet()
      const claimChallenge = await issueChallenge(pool, publicId)
      const signed = await signClose(publicId, sponsor)

      // Both orderings, deterministically, plus genuinely simultaneous ones.
      const stagger = [-HEADSTART_MS, 0, 0, HEADSTART_MS][i % 4]
      const claimDelay = stagger > 0 ? 0 : -stagger
      const closeDelay = stagger > 0 ? stagger : 0

      const [claimOutcome, closeOutcome] = await Promise.allSettled([
        (async () => {
          if (claimDelay) await sleep(claimDelay)
          return reserveClaim(pool, {
            publicId,
            challengeId: claimChallenge.challengeId,
            publicKeyHex: claimant.publicKeyHex,
            signatureHex: claimant.sign(claimChallenge.message),
            idemKey: `race-${i}`,
            requestHash: `race-${i}`,
          })
        })(),
        (async () => {
          if (closeDelay) await sleep(closeDelay)
          return sendClose(publicId, signed)
        })(),
      ])

      const drop = await readDrop(publicId)
      const payouts = await readPayouts(publicId)
      const refunds = await readRefunds(publicId)
      const where = `iteration ${i} (stagger ${stagger}ms)`

      // Exactly one of them committed. Never both, never neither.
      expect(
        [claimOutcome.status, closeOutcome.status].filter((s) => s === 'fulfilled'),
        where,
      ).toHaveLength(1)

      if (claimOutcome.status === 'fulfilled') {
        // The claim took the disputed slot: both slots are payouts, nothing is
        // refunded, and the close is told the drop already closed itself.
        outcomes.claimWon++
        expect(payouts, where).toHaveLength(2)
        expect(refunds, where).toHaveLength(0)
        expect(drop.closing_reason, where).toBe('exhausted')
        const reason = (closeOutcome as PromiseRejectedResult).reason as CloseRejectedError
        expect(reason, where).toBeInstanceOf(CloseRejectedError)
        expect(reason.code, where).toBe('already_closed')
      } else {
        // The close committed first: the reserved slot is still a payout, only
        // the free one is refunded, and the claimant is told what happened.
        outcomes.closeWon++
        expect(payouts, where).toHaveLength(1)
        expect(refunds, where).toHaveLength(1)
        expect(refunds[0].amount_luna, where).toBe(AMOUNT_EACH.toString())
        expect(refunds[0].recipient_address, where).toBe(sponsor.address)
        expect(drop.closing_reason, where).toBe('closed_by_sponsor')
        const reason = claimOutcome.reason as ClaimRejectedError
        expect(reason, where).toBeInstanceOf(ClaimRejectedError)
        expect(['closed_by_sponsor', 'exhausted'], where).toContain(reason.code)
      }

      expect(drop.state, where).toBe('closing')
      // The whole point: payouts + refund = the funded principal, exactly, in
      // both orderings. A reserved share can never become the sponsor's refund.
      expect(await allocatedLuna(publicId), `${where}: conservation`).toBe(AMOUNT_EACH * 2n)
    }

    console.info(JSON.stringify({ event: 'claim_vs_close_race', ...outcomes }))
    expect(outcomes.claimWon + outcomes.closeWon).toBe(RACE_ITERATIONS)
    // Both directions must actually have occurred, or the invariant above was
    // only ever checked against half the state space.
    expect(outcomes.claimWon).toBeGreaterThan(0)
    expect(outcomes.closeWon).toBeGreaterThan(0)
  })

  it('conserves the principal when several claimants race one close', async () => {
    // Five slots and four concurrent claimants, so BOTH sides can succeed and
    // the refund has to be exactly what is left over — not a fixed number.
    for (let i = 0; i < 5; i++) {
      const { publicId, sponsor } = await liveDrop() // 5 slots
      const signed = await signClose(publicId, sponsor)

      const claimants = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const wallet = newWallet()
          const issued = await issueChallenge(pool, publicId)
          return { wallet, issued }
        }),
      )

      await Promise.allSettled([
        ...claimants.map(({ wallet, issued }) =>
          reserveClaim(pool, {
            publicId,
            challengeId: issued.challengeId,
            publicKeyHex: wallet.publicKeyHex,
            signatureHex: wallet.sign(issued.message),
            idemKey: randomUUID(),
            requestHash: `multi-${randomUUID()}`,
          }),
        ),
        sendClose(publicId, signed),
      ])

      const payouts = await readPayouts(publicId)
      const refunds = await readRefunds(publicId)
      const where = `iteration ${i}: ${payouts.length} payouts, ${refunds.length} refunds`

      expect(refunds.length, where).toBeLessThanOrEqual(1)
      if (refunds.length === 1) {
        expect(refunds[0].amount_luna, where).toBe(
          (AMOUNT_EACH * BigInt(CLAIM_COUNT - payouts.length)).toString(),
        )
        expect(refunds[0].recipient_address, where).toBe(sponsor.address)
      } else {
        // No refund is only correct when every share found a claimant.
        expect(payouts.length, where).toBe(CLAIM_COUNT)
      }
      expect(await allocatedLuna(publicId), `${where}: conservation`).toBe(
        AMOUNT_EACH * BigInt(CLAIM_COUNT),
      )
    }
  })
})
