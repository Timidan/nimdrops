/**
 * The `attested` kind, end to end: attestation -> grant -> challenge -> signed
 * claim -> reserved slot -> payout intent.
 *
 * `attested.test.ts` proves `submitAttestation` in isolation and
 * `gate-claim.race.test.ts` proves the claim path against a hand-written grant.
 * Neither runs the two halves against each other, so nothing yet proves that the
 * address an attester signs is the address the claim path pays. That join is the
 * whole product promise of an integration, and it is what this file exercises:
 * every grant here is written by a real signature over a real canonical message,
 * and every claim is signed by a real wallet key.
 *
 * Harness copied from `gate-claim.race.test.ts` on purpose. The allocation path
 * serializes on the singleton `custody_controls` row and reads a GLOBAL principal
 * aggregate, so this suite cannot share a schema with the other `*.race` suites
 * vitest runs in parallel: it migrates a private schema and points its own pool
 * at it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { KeyPair, PrivateKey } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { checkWalletSignature } from '../src/auth/verify'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import {
  type Attestation,
  buildAttestationMessage,
  parseAttestationMessage,
  submitAttestation,
} from '../src/gates/attested'
import { GateRejectedError } from '../src/gates/types'
import { ClaimRejectedError, issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, submitFunding } from '../src/services/drops'
import { loadGate } from '../src/services/gates'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

const SCHEMA = 'attested_e2e_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const NETWORK = 'TestAlbatross'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
const FEE_FLOAT = 100_000n
const MAX_AGE_SECONDS = 300

let pool: pg.Pool
let chain: FakeChain

interface Wallet {
  publicKeyHex: string
  address: string
  sign(message: string): string
}

/** A real Ed25519 identity: the suite never fakes a signature it then verifies. */
function newWallet(): Wallet {
  const keyPair = KeyPair.generate()
  return {
    publicKeyHex: keyPair.publicKey.toHex(),
    address: keyPair.publicKey.toAddress().toUserFriendlyAddress(),
    sign: (message: string) => keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The spelling a wallet address is STORED and RETURNED under.
 *
 * `toUserFriendlyAddress()` groups an address in fours, which is how a wallet
 * displays it and how an attester will paste it into a message. Everything past
 * the parser holds one spelling instead, so the grant a claim is matched against
 * can never disagree with the address derived from a claim signature.
 */
const stored = (address: string) => address.replace(/\s/g, '')

/** 128 fresh bits, lowercase hex, as the documented contract requires. */
const freshNonce = () => randomBytes(16).toString('hex')

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

/** Create, fund and activate a real drop through the real services. */
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

/** Register an attester's PUBLIC key on the drop, the way a sponsor would. */
async function attachAttestedGate(dropId: string, attester: Wallet): Promise<void> {
  await pool.query(
    `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, 'attested', $2::jsonb)`,
    [
      dropId,
      JSON.stringify({
        attesterPublicKey: attester.publicKeyHex,
        maxAgeSeconds: MAX_AGE_SECONDS,
      }),
    ],
  )
}

/** The canonical message, built by the implementation's own builder. */
function attestation(over: Partial<Attestation> & { drop: string; wallet: string }): string {
  return buildAttestationMessage({
    network: NETWORK,
    origin: ORIGIN,
    issuedAt: nowSeconds(),
    nonce: freshNonce(),
    ...over,
  })
}

/**
 * Submit through the same door an HTTP handler would: load the gate by public id,
 * then hand `submitAttestation` the message and the signature and nothing else.
 * There is no address argument, here or there.
 */
async function submitAttested(o: {
  submitTo: string
  message: string
  attester: Wallet
}) {
  return submitAttestation(pool, {
    gate: await loadGate(pool, o.submitTo),
    message: o.message,
    signatureHex: o.attester.sign(o.message),
  })
}

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

async function expectClaimRejection(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected ClaimRejectedError(${code}), got success`).toBeInstanceOf(
    ClaimRejectedError,
  )
  expect((err as ClaimRejectedError).code).toBe(code)
}

async function expectGateRejection(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected GateRejectedError(${code}), got success`).toBeInstanceOf(GateRejectedError)
  expect((err as GateRejectedError).code).toBe(code)
}

/** Counted from the tables of record, never from a return value. */
async function counts(publicId: string) {
  const { rows } = await pool.query<{ claims: string; transfers: string; payouts: string }>(
    `SELECT (SELECT count(*) FROM claims c JOIN drops d ON d.id = c.drop_id
             WHERE d.public_id = $1) AS claims,
            (SELECT count(*) FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
             WHERE d.public_id = $1) AS transfers,
            (SELECT count(*) FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
             WHERE d.public_id = $1 AND t.purpose = 'payout') AS payouts`,
    [publicId],
  )
  return rows[0]
}

async function grantsFor(dropId: string) {
  const { rows } = await pool.query<{
    id: string
    wallet_address: string
    kind: string
    consumed_claim_id: string | null
  }>(
    'SELECT id, wallet_address, kind, consumed_claim_id FROM gate_grants WHERE drop_id = $1',
    [dropId],
  )
  return rows
}

async function countAllGrants(): Promise<string> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')
  return rows[0].count
}

describe.skipIf(!hasDb)('attested drop, attestation to payout intent (real Postgres)', () => {
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
    // `gate-claim.race.test.ts`: this suite is about the gate, not about float.
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
    process.env.NIMIQ_NETWORK = NETWORK
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'attested-e2e-secret'
    process.env.CUSTODY_ADDRESS = CUSTODY
  }

  // ---- the whole path, once, asserting at every step --------------------------

  it('carries a third party’s signature all the way to a payout intent', async () => {
    // 1. A real funded, live drop.
    const { publicId, dropId } = await liveDrop()

    // 2. The attester is a separate identity from the claimant, and only its
    //    PUBLIC key is ever recorded on the drop.
    const attester = newWallet()
    const claimant = newWallet()
    expect(attester.address).not.toBe(claimant.address)
    await attachAttestedGate(dropId, attester)

    // Before the attestation the claimant is nobody: the drop refuses them.
    await expectClaimRejection(claim(publicId, claimant), 'gate_required')
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0', payouts: '0' })

    // 3. The attester signs a canonical message naming the CLAIMANT.
    const message = attestation({ drop: publicId, wallet: claimant.address })
    await expect(
      submitAttested({ submitTo: publicId, message, attester }),
    ).resolves.toMatchObject({ granted: true, walletAddress: stored(claimant.address) })

    // The grant exists for the claimant and for nobody else — not for the
    // attester, not for anyone the request body could have named, because there
    // is no request body field for an address.
    const granted = await grantsFor(dropId)
    expect(granted).toHaveLength(1)
    expect(granted[0].wallet_address).toBe(stored(claimant.address))
    expect(granted[0].kind).toBe('attested')
    expect(granted[0].consumed_claim_id).toBeNull()

    // 4. The USER now claims from their own wallet: challenge, signature, slot.
    const result = await claim(publicId, claimant)
    expect(result.state).toBe('reserved')

    // 5. One slot, one payout intent, addressed and priced from the tables of
    //    record rather than from any return value.
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1', payouts: '1' })

    const { rows: claims } = await pool.query<{ id: string; recipient_address: string }>(
      'SELECT id, recipient_address FROM claims WHERE drop_id = $1',
      [dropId],
    )
    expect(claims).toHaveLength(1)
    expect(claims[0].id).toBe(result.claimId)
    expect(claims[0].recipient_address).toBe(claimant.address)

    const { rows: dropRow } = await pool.query<{ amount_each_luna: string }>(
      'SELECT amount_each_luna FROM drops WHERE id = $1',
      [dropId],
    )
    const { rows: transfers } = await pool.query<{
      idempotency_key: string
      purpose: string
      claim_id: string
      recipient_address: string
      amount_luna: string
      state: string
    }>(
      `SELECT idempotency_key, purpose, claim_id, recipient_address, amount_luna, state
       FROM outgoing_transfers WHERE drop_id = $1 AND purpose = 'payout'`,
      [dropId],
    )
    expect(transfers).toHaveLength(1)
    expect(transfers[0].idempotency_key).toBe(`payout:${result.claimId}`)
    expect(transfers[0].claim_id).toBe(result.claimId)
    expect(transfers[0].amount_luna).toBe(dropRow[0].amount_each_luna)
    expect(transfers[0].amount_luna).toBe(AMOUNT_EACH.toString())
    // The money is addressed to the wallet the ATTESTER named, which is the
    // wallet that then proved it holds the key. Those are the same string.
    expect(transfers[0].recipient_address).toBe(claimant.address)

    // 6. The grant is spent, and it points at the claim it paid for.
    const spent = await grantsFor(dropId)
    expect(spent).toHaveLength(1)
    expect(spent[0].id).toBe(granted[0].id)
    expect(spent[0].consumed_claim_id).toBe(result.claimId)
  })

  // ---- the substitution property, from the direction an integrator gets wrong -

  /**
   * A compromised or careless attester can name ITSELF, and then it holds the
   * grant — not the user. The unit tests prove the beneficiary comes from the
   * signed message; this proves the consequence on the money path: the claimant
   * cannot spend a grant that names the attester, because the claim path compares
   * the grant against the address DERIVED from the claim signature.
   */
  it('does not let the attester grant to itself and have someone else claim it', async () => {
    const { publicId, dropId } = await liveDrop()
    const attester = newWallet()
    const claimant = newWallet()
    await attachAttestedGate(dropId, attester)

    const message = attestation({ drop: publicId, wallet: attester.address })
    await expect(
      submitAttested({ submitTo: publicId, message, attester }),
    ).resolves.toMatchObject({ granted: true, walletAddress: stored(attester.address) })

    const granted = await grantsFor(dropId)
    expect(granted).toHaveLength(1)
    expect(granted[0].wallet_address).toBe(stored(attester.address))

    // The claimant holds no grant, so the claim is refused outright.
    await expectClaimRejection(claim(publicId, claimant), 'gate_required')
    expect(await counts(publicId)).toEqual({ claims: '0', transfers: '0', payouts: '0' })
    // And the refusal did not repoint the attester's grant at anything.
    expect((await grantsFor(dropId))[0].consumed_claim_id).toBeNull()
  })

  // ---- one wallet, one slot, however many attestations ------------------------

  it('does not sell a second slot for a second attestation of the same wallet', async () => {
    const { publicId, dropId } = await liveDrop()
    const attester = newWallet()
    const claimant = newWallet()
    await attachAttestedGate(dropId, attester)

    // Two independent, valid attestations: fresh nonce each, same beneficiary.
    for (let i = 0; i < 2; i += 1) {
      const message = attestation({ drop: publicId, wallet: claimant.address })
      await expect(
        submitAttested({ submitTo: publicId, message, attester }),
      ).resolves.toMatchObject({ granted: true, walletAddress: stored(claimant.address) })
    }
    // Both nonces are spent, and there is still exactly one grant.
    const { rows: nonces } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM attestation_nonces WHERE drop_id = $1',
      [dropId],
    )
    expect(nonces[0].count).toBe('2')
    const granted = await grantsFor(dropId)
    expect(granted).toHaveLength(1)

    const result = await claim(publicId, claimant)
    expect(result.state).toBe('reserved')
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1', payouts: '1' })

    // A THIRD attestation, arriving after the slot is taken, must not resurrect
    // the spent grant into a second slot.
    const later = attestation({ drop: publicId, wallet: claimant.address })
    await expect(
      submitAttested({ submitTo: publicId, message: later, attester }),
    ).resolves.toMatchObject({ granted: true, walletAddress: stored(claimant.address) })
    const after = await grantsFor(dropId)
    expect(after).toHaveLength(1)
    expect(after[0].consumed_claim_id).toBe(result.claimId)
    await expect(claim(publicId, claimant)).resolves.toMatchObject({ claimId: result.claimId })
    expect(await counts(publicId)).toEqual({ claims: '1', transfers: '1', payouts: '1' })
  })

  // ---- blast radius is one drop ----------------------------------------------

  /**
   * `docs/ATTESTATIONS.md` §5 states the bound: a key is trusted by the drop that
   * named it and by nothing else. Two live attested drops, two different attester
   * keys, and drop A's attester tries to grant on drop B — refused whichever gate
   * it is posted to, and neither drop grows a grant.
   */
  it('does not let one drop’s attester grant on another drop', async () => {
    const a = await liveDrop()
    const b = await liveDrop()
    const attesterA = newWallet()
    const attesterB = newWallet()
    const claimant = newWallet()
    await attachAttestedGate(a.dropId, attesterA)
    await attachAttestedGate(b.dropId, attesterB)

    // A's attester signs an attestation naming drop B.
    const message = attestation({ drop: b.publicId, wallet: claimant.address })

    // Posted to B, where the `drop` line matches: B does not trust this key.
    await expectGateRejection(
      submitAttested({ submitTo: b.publicId, message, attester: attesterA }),
      'bad_attestation',
    )
    // Posted to A, whose key signed it: the `drop` line names someone else.
    await expectGateRejection(
      submitAttested({ submitTo: a.publicId, message, attester: attesterA }),
      'bad_attestation',
    )

    expect(await grantsFor(a.dropId)).toHaveLength(0)
    expect(await grantsFor(b.dropId)).toHaveLength(0)
    expect(await countAllGrants()).toBe('0')

    // Neither drop can be claimed, so nothing was paid for either.
    await expectClaimRejection(claim(a.publicId, claimant), 'gate_required')
    await expectClaimRejection(claim(b.publicId, claimant), 'gate_required')
    expect(await counts(a.publicId)).toEqual({ claims: '0', transfers: '0', payouts: '0' })
    expect(await counts(b.publicId)).toEqual({ claims: '0', transfers: '0', payouts: '0' })
  })

  /**
   * Both of these were found by running the path end to end, not by reading it,
   * and neither is a money bug. They are contract gaps: an integrator acting on
   * `granted` alone would get them wrong.
   */
  it('tells an attester when the wallet has already claimed', async () => {
    const { publicId, dropId } = await liveDrop()
    const attester = newWallet()
    await attachAttestedGate(dropId, attester)
    const claimant = newWallet()

    const send = () =>
      submitAttested({
        submitTo: publicId,
        message: attestation({ drop: publicId, wallet: claimant.address }),
        attester,
      })

    await send()
    await claim(publicId, claimant)

    // A further attestation still succeeds — issueGrant reads the existing row
    // back and never inspects consumed_claim_id — so without this flag a partner
    // retrying until "the grant took" would loop forever against success.
    expect((await send()).alreadyClaimed).toBe(true)
    expect(await counts(publicId)).toMatchObject({ claims: '1' })
  })

  it('gives an attester back-pressure before it oversubscribes the drop', async () => {
    const { publicId, dropId } = await liveDrop()
    const attester = newWallet()
    await attachAttestedGate(dropId, attester)

    const send = (wallet: string) =>
      submitAttested({
        submitTo: publicId,
        message: attestation({ drop: publicId, wallet }),
        attester,
      })

    const first = await send(newWallet().address)
    expect(first.slotsRemaining).toBeGreaterThan(0)

    // Nothing refuses an attester that mints more grants than there are slots,
    // and refusing would be wrong, since a concurrent claim could take one either
    // way. What the figure buys is knowing when to stop, instead of surplus
    // wallets each discovering `exhausted` at claim time.
    const second = await send(newWallet().address)
    expect(second.slotsRemaining).toBe(first.slotsRemaining)
  })
})

// ---- the documented worked example -------------------------------------------

/**
 * `docs/ATTESTATIONS.md` §6 publishes a throwaway keypair, a message and one
 * signature per `SIG_SCHEME`, and tells an integrator to reproduce them before
 * pointing a signer at a funded drop. If these vectors are wrong, every
 * integrator who follows that instruction concludes their own signer is broken.
 * Needs no database: it is arithmetic over published bytes.
 */
describe('docs/ATTESTATIONS.md §6 worked example', () => {
  const PRIVATE_KEY_HEX = 'd0b4e01b2b0e1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829304'
  const PUBLIC_KEY_HEX = '5cf2855581bfaec85405b6e411f353826fafbe5b2dfa0e48ede2e92488b124f8'

  // Copied from the document's JavaScript string literal, which it prints exactly
  // so that the line endings are unambiguous.
  const MESSAGE =
    'nimdrops-attestation\n' +
    'network=TestAlbatross\n' +
    'origin=https://nimdrops.example\n' +
    'drop=k3nq7t2mv9x4\n' +
    'wallet=NQ71 CAAV SDGU D6YE 5M54 M6QX UBJ2 TMS0 6SPA\n' +
    'issuedAt=1785000000\n' +
    'nonce=7f3a1c9e2b48d05617ae3c8f2d194b60'

  const RAW_SIGNATURE_HEX =
    'fef21feb156f8ed07906b17666d0f2d0e3723254ada87bcd1a2651fbe4f854df' +
    '3d2bb6e2890c158d7ddcd4fbbbd4f225570d9317053525abfedfad4570bf050b'
  const SIGNED_MESSAGE_SIGNATURE_HEX =
    '2eec20729a1c94a0c59e4f341291c576bcee83b9e43de21bf49098e37196045b' +
    'e6d9ff7873b58bc06c6371f3a420ba0dcb91945e34bc720e0309ea8e4a4e2202'

  it('publishes a private key that derives the published public key', () => {
    const kp = KeyPair.derive(PrivateKey.fromHex(PRIVATE_KEY_HEX))
    expect(kp.publicKey.toHex()).toBe(PUBLIC_KEY_HEX)
  })

  it('publishes a message the strict parser accepts, of the stated byte length', () => {
    // The document says 203 UTF-8 bytes, and the `nimiq-signed-message` scheme
    // hashes that number as decimal digits — a wrong count would break the second
    // vector and only the second vector.
    expect(Buffer.from(MESSAGE, 'utf8').byteLength).toBe(203)
    expect(parseAttestationMessage(MESSAGE)).toEqual({
      network: 'TestAlbatross',
      origin: 'https://nimdrops.example',
      drop: 'k3nq7t2mv9x4',
      // Canonical, not as written. The document's line carries the address the
      // way a wallet DISPLAYS it, and parsing returns the one spelling the grant
      // is stored under. Verification is unaffected — a signature covers the
      // bytes the attester sent, which are still exactly the 203 counted above.
      wallet: 'NQ71CAAVSDGUD6YE5M54M6QXUBJ2TMS06SPA',
      issuedAt: 1_785_000_000,
      nonce: '7f3a1c9e2b48d05617ae3c8f2d194b60',
    })
    // The document also claims the two are the same bytes: the seven lines it
    // prints are what `buildAttestationMessage` emits for the fields an attester
    // holds — the wallet among them spelled as their wallet shows it.
    expect(
      buildAttestationMessage({
        ...parseAttestationMessage(MESSAGE),
        wallet: 'NQ71 CAAV SDGU D6YE 5M54 M6QX UBJ2 TMS0 6SPA',
      }),
    ).toBe(MESSAGE)
  })

  it('publishes a raw signature that verifies under SIG_SCHEME=raw', () => {
    expect(
      checkWalletSignature({
        message: MESSAGE,
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex: RAW_SIGNATURE_HEX,
        scheme: 'raw',
      }),
    ).toEqual({ ok: true, schemeMismatch: false })
  })

  it('publishes a wallet-scheme signature that verifies under SIG_SCHEME=nimiq-signed-message', () => {
    expect(
      checkWalletSignature({
        message: MESSAGE,
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex: SIGNED_MESSAGE_SIGNATURE_HEX,
        scheme: 'nimiq-signed-message',
      }),
    ).toEqual({ ok: true, schemeMismatch: false })
  })

  it('publishes two vectors that are each refused under the other scheme', () => {
    // The document states this outright, and tells the integrator it is the
    // scheme check working rather than a bug in their signer.
    expect(
      checkWalletSignature({
        message: MESSAGE,
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex: RAW_SIGNATURE_HEX,
        scheme: 'nimiq-signed-message',
      }),
    ).toEqual({ ok: false, schemeMismatch: true })
    expect(
      checkWalletSignature({
        message: MESSAGE,
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex: SIGNED_MESSAGE_SIGNATURE_HEX,
        scheme: 'raw',
      }),
    ).toEqual({ ok: false, schemeMismatch: true })
  })

  it('reproduces both signatures from the private key it publishes', () => {
    // The document's instruction is "confirm you reproduce the signature byte for
    // byte", so that is the assertion. Ed25519 is deterministic, which is the only
    // reason this is a legitimate check rather than a flaky one.
    const kp = KeyPair.derive(PrivateKey.fromHex(PRIVATE_KEY_HEX))
    const body = Buffer.from(MESSAGE, 'utf8')
    expect(kp.sign(new Uint8Array(body)).toHex()).toBe(RAW_SIGNATURE_HEX)
    const digest = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
          Buffer.from(String(body.byteLength), 'utf8'),
          body,
        ]),
      )
      .digest()
    expect(kp.sign(new Uint8Array(digest)).toHex()).toBe(SIGNED_MESSAGE_SIGNATURE_HEX)
  })

})
