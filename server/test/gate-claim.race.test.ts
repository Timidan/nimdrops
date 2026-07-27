import { randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { ClaimRejectedError, issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, submitFunding } from '../src/services/drops'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The gate lives inside the allocation transaction, which serializes every
 * claimer on the singleton `custody_controls` row and reads a GLOBAL principal
 * aggregate. Neither can be shared with the other `*.race.test.ts` files vitest
 * runs in parallel, so this suite migrates a private schema and points its own
 * pool at it.
 */
const SCHEMA = 'gate_claim_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
const FEE_FLOAT = 100_000n

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
    sign: (message: string) => keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
  }
}

function newChain(): FakeChain {
  const c = new FakeChain({
    custody: CUSTODY,
    finalityDepth: FINALITY_DEPTH,
    headHeight: FUND_HEIGHT,
  })
  c.deposit({
    hash: 'operator-fee-float',
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: FEE_FLOAT,
    includedHeight: 1,
  })
  return c
}

/** Create, fund and activate a drop. Returns its public id and internal id. */
async function liveDrop(): Promise<{ publicId: string; dropId: string }> {
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount: CLAIM_COUNT,
  })
  const hash = `tx-${draft.publicId}`
  chain.deposit({
    hash,
    sender: SPONSOR,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(CLAIM_COUNT),
    dataUtf8: draft.fundingMemo,
    includedHeight: FUND_HEIGHT,
  })
  chain.setHead(FUND_HEIGHT + FINALITY_DEPTH)
  const pub = await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  expect(pub.state).toBe('live')
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM drops WHERE public_id = $1',
    [draft.publicId],
  )
  return { publicId: draft.publicId, dropId: rows[0].id }
}

/** Attach a condition to a drop. The kind is irrelevant to the claim path. */
async function attachGate(dropId: string, kind = 'passphrase'): Promise<void> {
  await pool.query(
    `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, $2, '{}'::jsonb)`,
    [dropId, kind],
  )
}

async function grantTo(dropId: string, walletAddress: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO gate_grants (drop_id, wallet_address, kind)
     VALUES ($1, $2, 'passphrase') RETURNING id`,
    [dropId, walletAddress],
  )
  return rows[0].id
}

// `idemKey` is annotated rather than inferred: `randomUUID()` returns the
// template-literal type `${string}-${string}-...`, which would reject the plain
// readable keys the race cases pass in.
async function claim(publicId: string, wallet: Wallet, idemKey: string = randomUUID()) {
  const issued = await issueChallenge(pool, publicId)
  return reserveClaim(pool, {
    publicId,
    challengeId: issued.challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: wallet.sign(issued.message),
    idemKey,
    requestHash: 'request-hash-a',
  })
}

async function expectRejection(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected ClaimRejectedError(${code}), got success`).toBeInstanceOf(
    ClaimRejectedError,
  )
  expect((err as ClaimRejectedError).code).toBe(code)
}

/** Counted from the tables of record, never from a return value. */
async function counts(publicId: string) {
  const { rows } = await pool.query<{ claims: string; transfers: string }>(
    `SELECT (SELECT count(*) FROM claims c JOIN drops d ON d.id = c.drop_id
             WHERE d.public_id = $1) AS claims,
            (SELECT count(*) FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
             WHERE d.public_id = $1) AS transfers`,
    [publicId],
  )
  return rows[0]
}

async function grantRow(grantId: string) {
  const { rows } = await pool.query<{ consumed_claim_id: string | null }>(
    'SELECT consumed_claim_id FROM gate_grants WHERE id = $1',
    [grantId],
  )
  return rows[0]
}

describe.skipIf(!hasDb)('gated claim reservation (real Postgres)', () => {
  const saved = {
    network: process.env.NIMIQ_NETWORK,
    origin: process.env.PUBLIC_ORIGIN,
    scheme: process.env.SIG_SCHEME,
    secret: process.env.STATUS_TOKEN_SECRET,
    custody: process.env.CUSTODY_ADDRESS,
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
      max: 16,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    for (const [key, value] of [
      ['NIMIQ_NETWORK', saved.network],
      ['PUBLIC_ORIGIN', saved.origin],
      ['SIG_SCHEME', saved.scheme],
      ['STATUS_TOKEN_SECRET', saved.secret],
      ['CUSTODY_ADDRESS', saved.custody],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  beforeEach(async () => {
    setEnv()
    await pool.query(
      `TRUNCATE gate_grants, trivia_answers, trivia_sessions, passphrase_attempts,
       attestation_nonces, drop_gates, transaction_attempts, outgoing_transfers,
       wallet_challenges, claims, drops, operator_float_deposits,
       custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
    // Activation checks the solvency invariant, so a drop cannot go live without
    // an attested operator float covering the fee reserve. Same shape as
    // `claims.race.test.ts`: this suite is about the gate, not about float.
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
    process.env.STATUS_TOKEN_SECRET = 'gate-race-secret'
    process.env.CUSTODY_ADDRESS = CUSTODY
  }

  // ---- the gate refuses ------------------------------------------------------

  it('refuses a gated claim with no grant, and consumes nothing', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)

    await expectRejection(claim(publicId, newWallet()), 'gate_required')

    // No slot taken, no payout intent written — the refusal is total.
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0' })
  })

  it('does not spend the claimant’s challenge when it refuses', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()

    await expectRejection(claim(publicId, wallet), 'gate_required')

    // The whole allocation rolled back, challenge consume included, so a
    // claimant who then satisfies the condition is not stuck.
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM wallet_challenges WHERE consumed_at IS NOT NULL',
    )
    expect(rows[0].count).toBe('0')
  })

  /**
   * THE substitution attack, and the reason no kind needs a signature to attempt
   * a condition. A grant names an address but does not prove its holder asked
   * for it, so it must be worthless to every other address.
   */
  it('refuses a claim whose grant belongs to a different address', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const earner = newWallet()
    const thief = newWallet()
    await grantTo(dropId, earner.address)

    await expectRejection(claim(publicId, thief), 'gate_required')
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0' })
  })

  /**
   * A spent grant is not a grant. Isolating this needs care: the obvious setup —
   * claim once, delete the claim row, claim again — cannot work, because
   * `gate_grants.consumed_claim_id` has a foreign key to `claims`, so the delete
   * is refused. That FK is the point, so instead the grant is pointed at a claim
   * belonging to ANOTHER drop, which leaves this wallet with a consumed grant and
   * no claim on the drop under test.
   */
  it('refuses a claim whose grant is already consumed', async () => {
    const elsewhere = await liveDrop()
    const wallet = newWallet()
    const unrelated = await claim(elsewhere.publicId, wallet)

    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const grantId = await grantTo(dropId, wallet.address)
    await pool.query('UPDATE gate_grants SET consumed_claim_id = $2 WHERE id = $1', [
      grantId,
      unrelated.claimId,
    ])

    await expectRejection(claim(publicId, wallet), 'gate_required')
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0' })
    // Untouched: a refusal must not repoint someone else's spend.
    expect((await grantRow(grantId)).consumed_claim_id).toBe(unrelated.claimId)
  })

  // ---- the gate allows ------------------------------------------------------

  it('allows a claim whose grant matches the derived address, and spends it', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    const grantId = await grantTo(dropId, wallet.address)

    const result = await claim(publicId, wallet)
    expect(result.state).toBe('reserved')
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1' })
    expect((await grantRow(grantId)).consumed_claim_id).toBe(result.claimId)
  })

  it('matches on the address derived from the key, not one supplied anywhere', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    await grantTo(dropId, wallet.address)

    const result = await claim(publicId, wallet)
    const { rows } = await pool.query<{ recipient_address: string }>(
      'SELECT recipient_address FROM claims WHERE id = $1',
      [result.claimId],
    )
    // The payout address and the granted address are the same string, and that
    // string came from the public key the claimant signed with.
    expect(rows[0].recipient_address).toBe(wallet.address)
  })

  it('lets each of several granted wallets take one slot', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallets = [newWallet(), newWallet(), newWallet()]
    for (const w of wallets) await grantTo(dropId, w.address)

    for (const w of wallets) expect((await claim(publicId, w)).state).toBe('reserved')
    expect(await counts(publicId)).toEqual({ claims: '3', transfers: '3' })
  })

  // ---- one grant, one slot, under concurrency --------------------------------

  it('will not let one grant fund two slots', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    await grantTo(dropId, wallet.address)

    await claim(publicId, wallet, 'idem-first')
    // A different idempotency key: the retry path must return the existing claim
    // rather than reserving a second slot.
    await claim(publicId, wallet, 'idem-second')
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1' })
  })

  /**
   * SCOPE, stated because this test is weaker than it looks.
   *
   * Eight concurrent claims for ONE wallet cannot prove the gate's own `FOR
   * UPDATE` does anything, because `UNIQUE (drop_id, recipient_address)` on
   * `claims` already permits one claim per wallet per drop and would stop a
   * second slot on its own. The gate lock is defence in depth here, and a grant
   * is per wallet, so there is no way to have two DIFFERENT claimants race one
   * grant. What this does prove is that the gate does not BREAK the existing
   * guarantee under concurrency — no duplicate slot, no duplicate payout, and
   * the grant ends up spent exactly once.
   *
   * The pool is warmed first. `pg` creates clients lazily, so without it the
   * first caller completes its whole round trip while the others are still doing
   * TCP and auth, which silently serialises the "race" and makes any assertion
   * here vacuous.
   */
  it('lets exactly one of many concurrent claims spend one grant', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    const grantId = await grantTo(dropId, wallet.address)

    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')))

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => claim(publicId, wallet, `race-${i}`)),
    )

    // Several may "succeed" by returning the SAME claim through the retry path.
    // The tables of record are the authority: one slot, one payout, one spend.
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1' })
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true)
    expect((await grantRow(grantId)).consumed_claim_id).not.toBeNull()
  })

  it('lets two granted wallets race a drop without cross-spending', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const a = newWallet()
    const b = newWallet()
    const grantA = await grantTo(dropId, a.address)
    const grantB = await grantTo(dropId, b.address)

    await Promise.all([claim(publicId, a, 'race-a'), claim(publicId, b, 'race-b')])

    const [rowA, rowB] = [await grantRow(grantA), await grantRow(grantB)]
    expect(rowA.consumed_claim_id).not.toBeNull()
    expect(rowB.consumed_claim_id).not.toBeNull()
    expect(rowA.consumed_claim_id).not.toBe(rowB.consumed_claim_id)
    expect(await counts(publicId)).toEqual({ claims: '2', transfers: '2' })
  })

  // ---- a refusal for any other reason must not spend the grant ---------------

  it('leaves the grant unspent when the drop has expired', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    const grantId = await grantTo(dropId, wallet.address)

    await pool.query(
      `UPDATE drops SET expires_at = now() - interval '1 second' WHERE public_id = $1`,
      [publicId],
    )
    await expectRejection(claim(publicId, wallet), 'drop_expired')

    // The claimant must be able to come back if an operator reopens anything.
    expect((await grantRow(grantId)).consumed_claim_id).toBeNull()
  })

  it('leaves the grant unspent when custody is paused', async () => {
    const { publicId, dropId } = await liveDrop()
    await attachGate(dropId)
    const wallet = newWallet()
    const grantId = await grantTo(dropId, wallet.address)

    await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')
    await expect(claim(publicId, wallet)).rejects.toThrow()

    expect((await grantRow(grantId)).consumed_claim_id).toBeNull()
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0' })
  })

  // ---- ungated drops are untouched ------------------------------------------

  it('leaves an ungated drop behaving exactly as before', async () => {
    const { publicId } = await liveDrop()
    const result = await claim(publicId, newWallet())
    expect(result.state).toBe('reserved')
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1' })
  })

  it('does not require a grant on an ungated drop even when one exists elsewhere', async () => {
    const gated = await liveDrop()
    await attachGate(gated.dropId)
    const open = await liveDrop()
    const wallet = newWallet()

    // A grant on the gated drop is irrelevant to the open one, and its absence
    // on the open one is equally irrelevant.
    await grantTo(gated.dropId, wallet.address)
    expect((await claim(open.publicId, wallet)).state).toBe('reserved')
    expect(await counts(open.publicId)).toEqual({ claims: '1', transfers: '1' })
  })

  it('gates every kind identically, because the claim path cannot tell them apart', async () => {
    for (const kind of ['trivia', 'passphrase', 'attested']) {
      const { publicId, dropId } = await liveDrop()
      await attachGate(dropId, kind)
      await expectRejection(claim(publicId, newWallet()), 'gate_required')

      const wallet = newWallet()
      await grantTo(dropId, wallet.address)
      expect((await claim(publicId, wallet)).state).toBe('reserved')
    }
  })
})
