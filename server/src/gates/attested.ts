/**
 * Kind `attested`: a third party signs that a wallet met THEIR condition.
 *
 * A fitness app, a course platform, a door-check app. NimDrops verifies a
 * signature and issues a grant, and never learns what the condition was. That is
 * what makes this a distribution layer rather than a quiz app: health,
 * education and bounty use cases become integrations instead of features.
 *
 * The canonical message is a fixed line order, not a parsed object, so there is
 * exactly one byte sequence to sign — the same discipline as the claim challenge
 * in `src/auth/challenge.ts`.
 *
 * Threat boundary: a compromised attester can grant every slot of the drop that
 * named it. Blast radius is that one drop's funding, because the key is
 * registered per drop and never globally. Same shape as trusting a sponsor with
 * their own campaign, which is why there is no global attester registry.
 *
 * Dependency direction: this module imports from `gates/` and `auth/` only.
 * `assertGameLive` deliberately comes from `./types` rather than
 * `../services/gates`, because a kind importing from `services/` would turn the
 * one-way arrow documented in `gates/types.ts` into a cycle.
 */
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { checkWalletSignature } from '../auth/verify'
import { requireNetwork, requireSigScheme } from '../config'
import { normaliseNimiqAddress } from '../nimiq-address'
import { issueGrant } from './grants'
import { assertGameLive, GateRejectedError, type GateRow } from './types'

export const ATTESTATION_PREFIX = 'nimdrops-attestation'

/** Tolerance for a signer whose clock runs ahead of ours. */
export const CLOCK_SKEW_SECONDS = 60

export interface Attestation {
  network: string
  origin: string
  drop: string
  wallet: string
  issuedAt: number
  nonce: string
}

/**
 * What an integrator learns from a successful submission.
 *
 * `granted` alone was not enough, and the end-to-end test is what showed it. A
 * wallet that has ALREADY claimed still gets `granted: true` — `issueGrant` hits
 * its conflict clause, reads the existing row back and never looks at
 * `consumed_claim_id` — so a partner retrying until "the grant took" would loop
 * forever against success. `alreadyClaimed` is the missing bit.
 *
 * `slotsRemaining` is back-pressure. Nothing stops an attester minting more
 * grants than a drop has slots, and without this the surplus wallets discover it
 * only at claim time, as `exhausted`. It is a snapshot, not a reservation: a
 * concurrent claim can consume the last slot immediately afterwards, so it tells
 * an integrator when to stop rather than promising anyone a share.
 */
export interface AttestationResult {
  granted: true
  /** The wallet named in the signed message. Never one from a request body. */
  walletAddress: string
  /** This wallet already spent its grant on a claim. A further one is pointless. */
  alreadyClaimed: boolean
  /** Unreserved slots at the moment of this call. Advisory. */
  slotsRemaining: number
}

export interface AttestedConfig {
  attesterPublicKey: string
  maxAgeSeconds: number
}

/** The six `key=value` lines that follow the prefix, in the only order allowed. */
const KEYS = ['network', 'origin', 'drop', 'wallet', 'issuedAt', 'nonce'] as const

/** Prefix line plus one line per key. */
const LINE_COUNT = KEYS.length + 1

/**
 * Unix seconds, written the one way that round-trips: no sign, no leading zero,
 * no exponent, no decimal point, no surrounding space. Ten digits keeps the
 * value inside the safe-integer range without a second check.
 */
const ISSUED_AT_PATTERN = /^[1-9][0-9]{0,9}$/

/** 128 bits, lowercase, so one nonce has exactly one spelling. */
const NONCE_PATTERN = /^[0-9a-f]{32}$/

/** An Ed25519 public key as `PublicKey.fromHex` accepts it. */
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/i

export function buildAttestationMessage(a: Attestation): string {
  return [
    ATTESTATION_PREFIX,
    `network=${a.network}`,
    `origin=${a.origin}`,
    `drop=${a.drop}`,
    `wallet=${a.wallet}`,
    `issuedAt=${a.issuedAt}`,
    `nonce=${a.nonce}`,
  ].join('\n')
}

function bad(what: string): never {
  throw new GateRejectedError('bad_attestation', what)
}

/**
 * Parse strictly: exact line count, exact order, exact keys.
 *
 * Anything looser and two different byte sequences could mean the same
 * attestation, which is the shape of bug that lets a replay through under a
 * message the nonce check never saw.
 */
export function parseAttestationMessage(message: string): Attestation {
  const lines = message.split('\n')
  if (lines.length !== LINE_COUNT) bad(`attestation must be exactly ${LINE_COUNT} lines`)
  if (lines[0] !== ATTESTATION_PREFIX) bad('wrong attestation prefix')

  const values: Record<string, string> = {}
  for (let i = 0; i < KEYS.length; i += 1) {
    const key = KEYS[i]
    const expected = `${key}=`
    const line = lines[i + 1]
    if (!line.startsWith(expected)) bad(`line ${i + 2} must start with ${expected}`)
    values[key] = line.slice(expected.length)
  }

  // Both remaining fields are checked against a pattern rather than coerced.
  // `Number(' 1000')`, `Number('1e3')` and `Number('1000.0')` all produce a
  // valid-looking integer from a message no honest signer would emit, which
  // would leave several byte sequences meaning one attestation.
  if (!ISSUED_AT_PATTERN.test(values.issuedAt)) bad('issuedAt must be unix seconds')
  if (!NONCE_PATTERN.test(values.nonce)) bad('nonce must be 32 lowercase hex characters')

  // The beneficiary must be an address a wallet can actually hold, and it is
  // returned in ONE spelling. Neither was checked here, and both matter: this
  // field is the only thing that decides who a grant names, so `wallet=hello`
  // signed by a correctly configured attester used to write a grant nothing could
  // ever claim, and a spaced or lowercased spelling of a real address wrote one
  // `reserveClaim` could never match. The signature covers the bytes the attester
  // sent, so canonicalising afterwards changes nothing about verification — it
  // only means an integrator may paste an address the way a wallet displays it.
  const wallet = normaliseNimiqAddress(values.wallet)
  if (wallet === null) bad('wallet is not a valid Nimiq address')

  return {
    network: values.network,
    origin: values.origin,
    drop: values.drop,
    wallet,
    issuedAt: Number(values.issuedAt),
    nonce: values.nonce,
  }
}

/**
 * Validate one `attested` gate's config.
 *
 * Raises `misconfigured`, not `bad_attestation`. The two were deliberately
 * conflated so a submitter could not tell a broken drop from a bad signature —
 * but the cost of that was telling an honest integrator their attestation failed
 * to verify when it verified perfectly and the SPONSOR had typed the key wrong.
 * Nothing about the key leaks either way: the client-facing sentence for
 * `misconfigured` names no field, and it is the operator who gets paged.
 */
export function parseAttestedConfig(config: Record<string, unknown>): AttestedConfig {
  const { attesterPublicKey, maxAgeSeconds } = config
  if (typeof attesterPublicKey !== 'string' || !PUBLIC_KEY_PATTERN.test(attesterPublicKey)) {
    throw new GateRejectedError('misconfigured', 'attested gate has no usable attester key')
  }
  if (typeof maxAgeSeconds !== 'number' || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new GateRejectedError('misconfigured', 'attested gate has no usable maxAgeSeconds')
  }
  return { attesterPublicKey, maxAgeSeconds }
}

/**
 * Verify a third-party attestation and grant the wallet it names.
 *
 * Check order is load-bearing. Everything that can be decided from the message
 * and the sponsor's configured key runs BEFORE the nonce is spent, so a forged
 * signature over an intercepted message cannot burn the nonce of an attestation
 * its rightful holder has not submitted yet.
 */
export async function submitAttestation(
  pool: Pool,
  o: { gate: GateRow; message: string; signatureHex: string },
): Promise<AttestationResult> {
  if (o.gate.kind !== 'attested') {
    throw new GateRejectedError('wrong_kind', 'this drop does not accept attestations')
  }
  assertGameLive(o.gate)

  const config = parseAttestedConfig(o.gate.config)
  const attestation = parseAttestationMessage(o.message)

  if (attestation.network !== requireNetwork()) bad('attestation is for another network')
  if (attestation.origin !== process.env.PUBLIC_ORIGIN) bad('attestation is for another origin')
  if (attestation.drop !== o.gate.publicId) bad('attestation is for another drop')

  const check = checkWalletSignature({
    message: o.message,
    publicKeyHex: config.attesterPublicKey,
    signatureHex: o.signatureHex,
    scheme: requireSigScheme(),
  })
  if (!check.ok) bad('attestation signature does not verify')

  const now = Math.floor(Date.now() / 1000)
  if (attestation.issuedAt > now + CLOCK_SKEW_SECONDS) bad('attestation is issued in the future')
  if (attestation.issuedAt < now - config.maxAgeSeconds) bad('attestation is too old')

  const nonceHash = createHash('sha256').update(attestation.nonce).digest('hex')
  let alreadyClaimed = false
  let slotsRemaining = 0

  // Burning the nonce and issuing the grant are ONE transaction.
  //
  // As two autocommit statements they were a real availability footgun: if
  // `issueGrant` failed after the nonce landed, the nonce was spent and that
  // attestation was dead forever, so the beneficiary had to go back to the
  // attester for a fresh one. Nothing was at risk financially — it fails closed —
  // but the whole point of an integration is that the third party signs once.
  //
  // The INSERT is still the single-use check rather than a read followed by a
  // write. A read-then-write lets two copies of one attestation both pass the
  // read before either writes; under a warm connection pool that is not a
  // theoretical race, it is the common case.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: claimed } = await client.query<{ nonce_hash: string }>(
      `INSERT INTO attestation_nonces (drop_id, nonce_hash)
       VALUES ($1, $2)
       ON CONFLICT (drop_id, nonce_hash) DO NOTHING
       RETURNING nonce_hash`,
      [o.gate.dropId, nonceHash],
    )
    if (!claimed[0]) {
      await client.query('ROLLBACK')
      throw new GateRejectedError('attestation_replayed', 'this attestation was already used')
    }

    // The beneficiary is the wallet the ATTESTER named, covered by the signature.
    // Nothing in a request body can substitute it, which is why this function
    // takes no address argument at all.
    await issueGrant(client, {
      dropId: o.gate.dropId,
      walletAddress: attestation.wallet,
      kind: 'attested',
    })

    // Read inside the same transaction, so neither figure can be from a moment
    // that never coexisted with the grant just written.
    const { rows: status } = await client.query<{
      already_claimed: boolean
      slots_remaining: number
    }>(
      `SELECT (g.consumed_claim_id IS NOT NULL) AS already_claimed,
              d.claim_count - (SELECT count(*)::int FROM claims c WHERE c.drop_id = d.id)
                AS slots_remaining
       FROM gate_grants g
       JOIN drops d ON d.id = g.drop_id
       WHERE g.drop_id = $1 AND g.wallet_address = $2`,
      [o.gate.dropId, attestation.wallet],
    )
    alreadyClaimed = status[0]?.already_claimed ?? false
    slotsRemaining = status[0]?.slots_remaining ?? 0

    await client.query('COMMIT')
  } catch (err) {
    // A replay has already rolled back; rolling back twice is harmless and
    // catching here is what keeps a genuine failure from leaking a client.
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  return { granted: true, walletAddress: attestation.wallet, alreadyClaimed, slotsRemaining }
}
