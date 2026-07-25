import { randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { hashToken, statusToken } from '../src/ids'
import {
  ClaimNotFoundError,
  ClaimRejectedError,
  claimStatus,
  issueChallenge,
  reserveClaim,
} from '../src/services/claims'
import { ConflictError } from '../src/http/idempotency'
import { DropNotFoundError, createDraft, submitFunding } from '../src/services/drops'
import { PausedError } from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Allocation consults `outstandingPrincipalLuna`, a GLOBAL aggregate over every
 * drop, and serializes every claimer on the singleton `custody_controls` row.
 * Neither can be shared with the other `*.race.test.ts` files vitest runs in
 * parallel, so this suite migrates a private Postgres schema and points its own
 * pool's `search_path` at it.
 */
const SCHEMA = 'claims_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
const PRINCIPAL = AMOUNT_EACH * BigInt(CLAIM_COUNT)
/** Operator's pre-funded fee float, matching `configured_fee_reserve_luna`. */
const FEE_FLOAT = 100_000n

/** The concurrency the race test throws at a 5-slot drop. */
const RACERS = 30

let pool: pg.Pool
let chain: FakeChain

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
    sign: (message: string) =>
      keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
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

/** Create, fund, finalize and activate a drop; returns its public id. */
async function liveDrop(o: { claimCount?: number } = {}): Promise<string> {
  const claimCount = o.claimCount ?? CLAIM_COUNT
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount,
  })
  const hash = `tx-${draft.publicId}`
  chain.deposit({
    hash,
    sender: SPONSOR,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(claimCount),
    dataUtf8: draft.fundingMemo,
    includedHeight: FUND_HEIGHT,
  })
  chain.setHead(FUND_HEIGHT + FINALITY_DEPTH)
  const pub = await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  expect(pub.state).toBe('live')
  return draft.publicId
}

interface ClaimOverrides {
  challengeId?: string
  message?: string
  signatureHex?: string
  idemKey?: string
  requestHash?: string
}

/** Issue a fresh challenge (unless one is supplied), sign it, and reserve. */
async function claim(publicId: string, wallet: Wallet, o: ClaimOverrides = {}) {
  let challengeId = o.challengeId
  let message = o.message
  if (challengeId === undefined || message === undefined) {
    const issued = await issueChallenge(pool, publicId)
    challengeId = issued.challengeId
    message = issued.message
  }
  return reserveClaim(pool, {
    publicId,
    challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: o.signatureHex ?? wallet.sign(message),
    idemKey: o.idemKey ?? randomUUID(),
    requestHash: o.requestHash ?? 'request-hash-a',
  })
}

/** Expect a rejection carrying an exact `ClaimRejectedError.code`. */
async function expectRejection(p: Promise<unknown>, code: string): Promise<ClaimRejectedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected ClaimRejectedError(${code}), got success`).toBeInstanceOf(ClaimRejectedError)
  expect((err as ClaimRejectedError).code).toBe(code)
  return err as ClaimRejectedError
}

async function readDrop(publicId: string) {
  const { rows } = await pool.query<{ id: string; state: string; closing_reason: string | null }>(
    'SELECT id, state, closing_reason FROM drops WHERE public_id = $1',
    [publicId],
  )
  return rows[0]
}

async function readClaims(publicId: string) {
  const { rows } = await pool.query<{
    id: string
    slot_index: number
    recipient_address: string
    state: string
    status_token_hash: string
  }>(
    `SELECT c.id, c.slot_index, c.recipient_address, c.state, c.status_token_hash
     FROM claims c JOIN drops d ON d.id = c.drop_id
     WHERE d.public_id = $1
     ORDER BY c.slot_index`,
    [publicId],
  )
  return rows
}

async function readPayouts(publicId: string) {
  const { rows } = await pool.query<{
    idempotency_key: string
    purpose: string
    claim_id: string
    recipient_address: string
    amount_luna: string
    state: string
  }>(
    `SELECT t.idempotency_key, t.purpose, t.claim_id, t.recipient_address, t.amount_luna, t.state
     FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
     WHERE d.public_id = $1
     ORDER BY t.created_at`,
    [publicId],
  )
  return rows
}

async function setPaused(paused: boolean): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = $1 WHERE singleton', [paused])
}

describe.skipIf(!hasDb)('claim reservation, idempotency and races (real Postgres)', () => {
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
      // The race test opens up to RACERS reservations at once; each holds one
      // client for the length of its transaction and never nests another.
      max: 16,
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
  })

  afterEach(setEnv)

  function setEnv(): void {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'claims-race-test-secret'
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

  // ---- challenges -----------------------------------------------------------

  it('issues a domain-separated challenge bound to the drop and persists its nonce hash', async () => {
    const publicId = await liveDrop()
    const issued = await issueChallenge(pool, publicId)

    const message = JSON.parse(issued.message) as Record<string, unknown>
    expect(message).toMatchObject({
      v: 1,
      aud: ORIGIN,
      net: 'TestAlbatross',
      action: 'claim',
      drop: publicId,
    })
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const { rows } = await pool.query<{
      nonce_hash: string
      canonical_message: string
      consumed_at: Date | null
    }>('SELECT nonce_hash, canonical_message, consumed_at FROM wallet_challenges WHERE id = $1', [
      issued.challengeId,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].canonical_message).toBe(issued.message)
    expect(rows[0].consumed_at).toBeNull()
    // The nonce itself is never stored, only its hash.
    expect(rows[0].nonce_hash).not.toBe(message.nonce)
    expect(rows[0].nonce_hash).toHaveLength(64)
  })

  it('rejects a challenge request for an unknown drop', async () => {
    await expect(issueChallenge(pool, 'nope-nope-nope-nope-no')).rejects.toBeInstanceOf(
      DropNotFoundError,
    )
  })

  // ---- happy path -----------------------------------------------------------

  it('reserves a claim, returns a reproducible token, and queues one payout intent', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()

    const result = await claim(publicId, wallet)

    expect(result.state).toBe('reserved')
    expect(result.statusToken).toBe(statusToken(result.claimId))

    const claims = await readClaims(publicId)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      id: result.claimId,
      slot_index: 0,
      recipient_address: wallet.address,
      state: 'reserved',
      // The DB stores only the hash; the plaintext token is derived, never persisted.
      status_token_hash: hashToken(result.statusToken),
    })

    const payouts = await readPayouts(publicId)
    expect(payouts).toHaveLength(1)
    expect(payouts[0]).toMatchObject({
      idempotency_key: `payout:${result.claimId}`,
      purpose: 'payout',
      claim_id: result.claimId,
      recipient_address: wallet.address,
      amount_luna: AMOUNT_EACH.toString(),
      state: 'queued',
    })

    // The drop still has capacity, so it stays live.
    expect(await readDrop(publicId)).toMatchObject({ state: 'live', closing_reason: null })

    // The challenge is single-use: consumed in the same transaction.
    const { rows } = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM wallet_challenges',
    )
    expect(rows[0].consumed_at).not.toBeNull()
  })

  // ---- HTTP idempotency -----------------------------------------------------

  it('returns the same claim for the same idempotency key and request hash', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const idemKey = randomUUID()

    const first = await claim(publicId, wallet, { idemKey })
    const second = await claim(publicId, wallet, { idemKey })

    expect(second).toEqual(first)
    expect(await readClaims(publicId)).toHaveLength(1)
    expect(await readPayouts(publicId)).toHaveLength(1)
  })

  it('conflicts when the same idempotency key carries a different request', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const idemKey = randomUUID()

    await claim(publicId, wallet, { idemKey, requestHash: 'request-hash-a' })
    await expect(
      claim(publicId, wallet, { idemKey, requestHash: 'request-hash-b' }),
    ).rejects.toBeInstanceOf(ConflictError)

    expect(await readClaims(publicId)).toHaveLength(1)
  })

  it('returns the existing claim for a wallet that signs a brand-new challenge', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()

    const first = await claim(publicId, wallet, { idemKey: 'key-1' })
    const second = await claim(publicId, wallet, { idemKey: 'key-2', requestHash: 'request-hash-b' })

    expect(second.claimId).toBe(first.claimId)
    expect(second.statusToken).toBe(first.statusToken)
    expect(await readClaims(publicId)).toHaveLength(1)
    expect(await readPayouts(publicId)).toHaveLength(1)

    // The new key was atomically bound to the existing claim, so replaying it
    // with a different request is a conflict from now on.
    const { rows } = await pool.query<{ resource_id: string; request_hash: string }>(
      'SELECT resource_id, request_hash FROM http_idempotency ORDER BY created_at',
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.resource_id)).toEqual([first.claimId, first.claimId])
    expect(rows[1].request_hash).toBe('request-hash-b')
  })

  // ---- challenge rejection matrix -------------------------------------------

  it('rejects an expired challenge', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const issued = await issueChallenge(pool, publicId)
    await pool.query(
      `UPDATE wallet_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [issued.challengeId],
    )

    await expectRejection(
      claim(publicId, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'challenge_expired',
    )
    expect(await readClaims(publicId)).toHaveLength(0)
  })

  it('rejects a challenge that another wallet already consumed', async () => {
    const publicId = await liveDrop()
    const first = newWallet()
    const replayer = newWallet()
    const issued = await issueChallenge(pool, publicId)

    await claim(publicId, first, { challengeId: issued.challengeId, message: issued.message })
    await expectRejection(
      claim(publicId, replayer, { challengeId: issued.challengeId, message: issued.message }),
      'challenge_consumed',
    )
    expect(await readClaims(publicId)).toHaveLength(1)
  })

  it('rejects a challenge issued for a different drop', async () => {
    const target = await liveDrop()
    const other = await liveDrop()
    const wallet = newWallet()
    const issued = await issueChallenge(pool, other)

    await expectRejection(
      claim(target, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'cross_drop_challenge',
    )
    expect(await readClaims(target)).toHaveLength(0)
    // The cross-drop challenge is untouched: a rejected replay never consumes it.
    const { rows } = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM wallet_challenges WHERE id = $1',
      [issued.challengeId],
    )
    expect(rows[0].consumed_at).toBeNull()
  })

  it('rejects an unknown challenge id', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    await expectRejection(
      claim(publicId, wallet, { challengeId: randomUUID(), message: '{"tampered":true}' }),
      'unknown_challenge',
    )
  })

  it('rejects a tampered signature', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const issued = await issueChallenge(pool, publicId)
    const good = wallet.sign(issued.message)
    const tampered = `${good.slice(0, -2)}${good.slice(-2) === 'aa' ? 'bb' : 'aa'}`

    await expectRejection(
      claim(publicId, wallet, {
        challengeId: issued.challengeId,
        message: issued.message,
        signatureHex: tampered,
      }),
      'invalid_signature',
    )
    expect(await readClaims(publicId)).toHaveLength(0)
  })

  it('rejects a signature made by a different wallet than the one presented', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const impostor = newWallet()
    const issued = await issueChallenge(pool, publicId)

    await expectRejection(
      claim(publicId, wallet, {
        challengeId: issued.challengeId,
        message: issued.message,
        signatureHex: impostor.sign(issued.message),
      }),
      'invalid_signature',
    )
  })

  // ---- THE RACE -------------------------------------------------------------

  it(`gives exactly ${CLAIM_COUNT} slots to ${RACERS} concurrent distinct wallets`, async () => {
    const publicId = await liveDrop()
    const wallets = Array.from({ length: RACERS }, newWallet)
    const challenges = await Promise.all(wallets.map(() => issueChallenge(pool, publicId)))

    const results = await Promise.allSettled(
      wallets.map((wallet, i) =>
        reserveClaim(pool, {
          publicId,
          challengeId: challenges[i].challengeId,
          publicKeyHex: wallet.publicKeyHex,
          signatureHex: wallet.sign(challenges[i].message),
          idemKey: `racer-${i}`,
          requestHash: `racer-${i}`,
        }),
      ),
    )

    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(CLAIM_COUNT)
    expect(lost).toHaveLength(RACERS - CLAIM_COUNT)
    for (const l of lost) {
      expect((l as PromiseRejectedResult).reason).toBeInstanceOf(ClaimRejectedError)
      expect(((l as PromiseRejectedResult).reason as ClaimRejectedError).code).toBe('exhausted')
    }

    const claims = await readClaims(publicId)
    expect(claims).toHaveLength(CLAIM_COUNT)
    expect(claims.map((c) => c.slot_index)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(claims.map((c) => c.recipient_address)).size).toBe(CLAIM_COUNT)

    const payouts = await readPayouts(publicId)
    expect(payouts).toHaveLength(CLAIM_COUNT)
    expect(new Set(payouts.map((p) => p.idempotency_key)).size).toBe(CLAIM_COUNT)
    expect(payouts.every((p) => p.amount_luna === AMOUNT_EACH.toString())).toBe(true)

    // The last slot flips the drop closed inside the same transaction.
    expect(await readDrop(publicId)).toMatchObject({
      state: 'closing',
      closing_reason: 'exhausted',
    })

    // Total reserved liability never exceeds what the sponsor funded.
    const reservedLuna = BigInt(payouts.length) * AMOUNT_EACH
    expect(reservedLuna).toBe(PRINCIPAL)
  })

  it('rejects a claim once the drop is closing, reporting why', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const issued = await issueChallenge(pool, publicId)
    await pool.query(
      `UPDATE drops SET state = 'closing', closing_reason = 'exhausted' WHERE public_id = $1`,
      [publicId],
    )

    await expectRejection(
      claim(publicId, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'exhausted',
    )
    expect(await readClaims(publicId)).toHaveLength(0)

    await pool.query(`UPDATE drops SET closing_reason = 'expired' WHERE public_id = $1`, [publicId])
    await expectRejection(
      claim(publicId, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'drop_expired',
    )

    await pool.query(`UPDATE drops SET state = 'manual_review', closing_reason = NULL WHERE public_id = $1`, [
      publicId,
    ])
    await expectRejection(
      claim(publicId, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'drop_not_live',
    )
  })

  it('refuses to issue a challenge for a drop that is not live', async () => {
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'Sponsor',
      amountEachLuna: AMOUNT_EACH,
      claimCount: CLAIM_COUNT,
    })
    await expectRejection(issueChallenge(pool, draft.publicId), 'drop_not_live')
  })

  it('rejects a claim once the drop is past its expiry', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const issued = await issueChallenge(pool, publicId)
    await pool.query(`UPDATE drops SET expires_at = now() - interval '1 hour' WHERE public_id = $1`, [
      publicId,
    ])

    await expectRejection(
      claim(publicId, wallet, { challengeId: issued.challengeId, message: issued.message }),
      'drop_expired',
    )
    expect(await readClaims(publicId)).toHaveLength(0)
  })

  it('rejects a claim for an unknown drop', async () => {
    const wallet = newWallet()
    await expect(
      reserveClaim(pool, {
        publicId: 'nope-nope-nope-nope-no',
        challengeId: randomUUID(),
        publicKeyHex: wallet.publicKeyHex,
        signatureHex: wallet.sign('{}'),
        idemKey: randomUUID(),
        requestHash: 'request-hash-a',
      }),
    ).rejects.toBeInstanceOf(DropNotFoundError)
  })

  // ---- pause fails closed for money, stays open for reads --------------------

  it('keeps answering retries and status while paused, but rejects new claims', async () => {
    const publicId = await liveDrop()
    const claimant = newWallet()
    const newcomer = newWallet()
    const idemKey = randomUUID()

    const reserved = await claim(publicId, claimant, { idemKey })
    const newcomerChallenge = await issueChallenge(pool, publicId)
    await setPaused(true)

    // Retry by idempotency key: pure metadata read, no new liability.
    await expect(claim(publicId, claimant, { idemKey })).resolves.toEqual(reserved)
    // Retry by wallet with a fresh challenge and a fresh key: also allowed.
    await expect(
      claim(publicId, claimant, { idemKey: randomUUID(), requestHash: 'request-hash-c' }),
    ).resolves.toMatchObject({ claimId: reserved.claimId })
    // Status reads keep working.
    await expect(claimStatus(pool, reserved.claimId, reserved.statusToken)).resolves.toMatchObject({
      state: 'reserved',
    })

    // A genuinely new claim is money movement: fail closed.
    await expect(
      claim(publicId, newcomer, {
        challengeId: newcomerChallenge.challengeId,
        message: newcomerChallenge.message,
      }),
    ).rejects.toBeInstanceOf(PausedError)

    expect(await readClaims(publicId)).toHaveLength(1)
    // The rejected claim never consumed its challenge.
    const { rows } = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM wallet_challenges WHERE id = $1',
      [newcomerChallenge.challengeId],
    )
    expect(rows[0].consumed_at).toBeNull()

    await setPaused(false)
  })

  // ---- status ---------------------------------------------------------------

  it('serves claim status to the bearer token holder only', async () => {
    const publicId = await liveDrop()
    const wallet = newWallet()
    const reserved = await claim(publicId, wallet)

    await expect(claimStatus(pool, reserved.claimId, reserved.statusToken)).resolves.toEqual({
      state: 'reserved',
      amountEach: '1',
    })

    // A wrong token is indistinguishable from a wrong id: uniform not-found.
    const wrong = statusToken(randomUUID())
    await expect(claimStatus(pool, reserved.claimId, wrong)).rejects.toBeInstanceOf(
      ClaimNotFoundError,
    )
    await expect(claimStatus(pool, randomUUID(), reserved.statusToken)).rejects.toBeInstanceOf(
      ClaimNotFoundError,
    )
  })
})
