import type { Pool, PoolClient } from 'pg'
import {
  assertChallengeFresh,
  buildChallengeMessage,
  ChallengeError,
  issueChallenge as mintChallenge,
  nonceHash,
  requireAudience,
  type Challenge,
} from '../auth/challenge'
import {
  addressFromPublicKey,
  checkWalletSignature,
  otherScheme,
  requireSigScheme,
  WALLET_SIG_SCHEME,
} from '../auth/verify'
import { requireNetwork } from '../config'
import type { Queryable } from '../db/pool'
import type { AlertKind, Alerts } from './alerts'
import { DropNotFoundError } from './drops'
import { closeLiveDrop, type ClosableDropRow } from './expiry'

/**
 * The sponsor's way out: close a drop you funded, and take back what nobody
 * claimed.
 *
 * **This file adds no money path.** The whole transition — leave `live`, honour
 * every reserved claim, write exactly one refund for the unallocated value to
 * the verified funding sender — is `closeLiveDrop` in `services/expiry.ts`, the
 * same function the expiry sweeper calls when the clock fires. What lives here
 * is only the answer to a different question: *may this caller trigger it now?*
 *
 * The sweeper's authority is the clock. The sponsor's authority is a wallet
 * signature from the address that funded the drop, and three properties make
 * that safe to act on:
 *
 *  1. **The signature is bound to this drop AND this action.** The canonical
 *     message carries `{"action":"close","drop":"<publicId>",...}` and the
 *     wallet signs those exact bytes, so a signature harvested from a claim
 *     cannot be replayed as a close, and a close approved for one drop cannot
 *     close another. Both facts are re-derived from the STORED message and
 *     re-checked here; migration 017 records the action on the row as well, so
 *     the UPDATE that consumes the nonce filters on it too.
 *  2. **It is single-use and short-lived.** The nonce row is consumed by the
 *     same UPDATE that reads it, inside the close transaction, under the close's
 *     locks. Two requests carrying one nonce cannot both find it unconsumed, and
 *     a close that is refused for any other reason rolls the consumption back
 *     rather than burning the sponsor's approval.
 *  3. **The signer must equal the address on the locked row.** Not the connected
 *     wallet, not a field in the request body: `drops.refund_address`, written
 *     once by `activate()` from the verified funding transaction's sender, and
 *     the only address a refund can ever be paid to. The comparison happens
 *     inside the close transaction, against the row that transaction holds.
 *
 * **No minimum age.** A sponsor may close seconds after funding. A cooling-off
 * period would protect nobody — reserved claims are honoured regardless, and
 * nobody who has not claimed is owed anything yet — while trapping exactly the
 * sponsor this feature exists for: the one who funded the wrong drop a moment
 * ago.
 *
 * **No `Idempotency-Key`.** The nonce IS the single-use token, `drops.state`
 * gates the transition, and `one_refund_per_drop` is the schema-level backstop.
 * A retry cannot produce a second refund; it produces `challenge_consumed` or
 * `already_closed`, both of which are honest answers.
 */

/** Why a close was refused. Callers map these to client-facing messages. */
export type CloseRejectionCode =
  | 'unknown_challenge'
  | 'cross_drop_challenge'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'invalid_signature'
  | 'message_mismatch'
  /** A good signature from a wallet that is not the one that funded the drop. */
  | 'not_the_funder'
  /** Live, but its funding was never verified — there is nothing to refund. */
  | 'drop_not_funded'
  /** Already closing, settled, refunded: the transition has happened once. */
  | 'already_closed'
  /** Cancelled, paused, or held for an operator. Not a sponsor's to resolve. */
  | 'drop_not_live'

/**
 * An operator-facing finding attached to a refusal the caller must not be told
 * apart from any other refusal. Same contract as `ClaimDiagnostic`: today it
 * exists only for a `SIG_SCHEME` that does not describe the signer, which is a
 * deployment fault that would otherwise refuse every sponsor in silence.
 */
export interface CloseDiagnostic {
  alert: AlertKind
  detail: Record<string, unknown>
}

export class CloseRejectedError extends Error {
  constructor(
    readonly code: CloseRejectionCode,
    message: string,
    /** Never reaches the client. `http/app.ts` turns it into an operator alert. */
    readonly diagnostic?: CloseDiagnostic,
  ) {
    super(message)
  }
}

export interface IssuedCloseChallenge {
  challengeId: string
  /** The canonical message the wallet must sign, byte for byte. */
  message: string
  expiresAt: Date
}

export interface CloseDropInput {
  publicId: string
  challengeId: string
  publicKeyHex: string
  signatureHex: string
}

export interface CloseDropResult {
  /** Claims that were already reserved and will still be paid. */
  reservedClaims: number
  /** Shares nobody took. Zero means the drop was full and nothing is refunded. */
  unclaimedSlots: number
  /**
   * The funded principal minus every payout this drop has committed to
   * (`claim_count × amount_each_luna − SUM(payout amounts)`), heading back to
   * the funding address. Equals `unclaimedSlots × amount_each_luna` when every
   * reserved claim paid its full share; on a scored (sub-full-share) claim it
   * also returns that slot's unpaid remainder.
   */
  refundLuna: bigint
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface CloseDropRow {
  id: string
  state: string
}

async function loadDropForClose(db: Queryable, publicId: string): Promise<CloseDropRow> {
  const { rows } = await db.query<CloseDropRow>(
    'SELECT id, state FROM drops WHERE public_id = $1',
    [publicId],
  )
  const row = rows[0]
  if (!row) throw new DropNotFoundError(publicId)
  return row
}

/**
 * Mint a short-lived, single-use challenge authorizing ONE close of ONE drop.
 *
 * Takes no locks and moves no money, and deliberately proves nothing about who
 * is asking: a challenge is worthless without a signature from the funding
 * address, so refusing to issue one to a stranger would only tell the stranger
 * who the funder is not.
 */
export async function issueCloseChallenge(
  pool: Pool,
  publicId: string,
): Promise<IssuedCloseChallenge> {
  const drop = await loadDropForClose(pool, publicId)
  // Only a live drop can be closed, so only a live drop can be asked about.
  // The authoritative check is under the lock in `closeLiveDrop`; this one keeps
  // a sponsor from being sent to their wallet for a request that cannot succeed.
  if (drop.state !== 'live') throw notLiveRejection(drop.state)

  const challenge = mintChallenge({
    origin: requireAudience(),
    network: requireNetwork(),
    dropPublicId: publicId,
    action: 'close',
  })
  const message = buildChallengeMessage(challenge)
  const expiresAt = new Date(challenge.exp * 1000)

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO wallet_challenges (drop_id, action, nonce_hash, canonical_message, expires_at)
     VALUES ($1, 'close', $2, $3, $4)
     RETURNING id`,
    [drop.id, nonceHash(challenge.nonce), message, expiresAt],
  )

  return { challengeId: rows[0].id, message, expiresAt }
}

interface ChallengeRow {
  id: string
  drop_id: string
  action: string
  canonical_message: string
  consumed_at: Date | null
}

async function loadChallenge(db: Queryable, challengeId: string): Promise<ChallengeRow | null> {
  if (!UUID_RE.test(challengeId)) return null
  const { rows } = await db.query<ChallengeRow>(
    `SELECT id, drop_id, action, canonical_message, consumed_at
     FROM wallet_challenges WHERE id = $1`,
    [challengeId],
  )
  return rows[0] ?? null
}

/**
 * Parse and re-canonicalize the stored message: it must be one we could have
 * issued, for THIS drop, for THIS action, on THIS deployment.
 *
 * Re-serializing and comparing byte for byte is what stops a stored message with
 * extra or reordered fields from verifying — the wallet signed those exact
 * bytes, so anything the parser would accept but the builder would not produce
 * is not a message this server ever minted.
 */
function parseCloseChallenge(message: string, publicId: string): Challenge {
  let parsed: Challenge
  try {
    parsed = JSON.parse(message) as Challenge
  } catch {
    throw new CloseRejectedError('message_mismatch', 'challenge message is not valid')
  }
  let mismatch: boolean
  try {
    mismatch =
      buildChallengeMessage(parsed) !== message ||
      parsed.drop !== publicId ||
      parsed.action !== 'close' ||
      parsed.aud !== requireAudience() ||
      parsed.net !== requireNetwork()
  } catch (err) {
    // `buildChallengeMessage` refuses to serialise a challenge it could not
    // have issued — an unknown version, an unknown action, a non-integer
    // timestamp. That is a stored row this server did not write, which is a
    // refusal and not a server fault, so it must not surface as a 500.
    if (err instanceof ChallengeError) {
      throw new CloseRejectedError('message_mismatch', 'challenge message is not valid')
    }
    throw err
  }
  if (mismatch) {
    throw new CloseRejectedError('message_mismatch', 'challenge message is not valid for this close')
  }
  return parsed
}

/**
 * Close a live drop on the sponsor's instruction, and refund the remainder.
 *
 * Signature verification and address derivation happen BEFORE any transaction is
 * opened — Ed25519 is slow relative to a row lock, and no cryptography may run
 * while the singleton custody lock is held (the same rule `reserveClaim` follows,
 * for the same reason). What runs under the locks is only the pair of checks
 * that must be decided against the committed row: the signer IS the funder, and
 * the nonce is still unspent.
 */
export async function closeDropBySponsor(
  pool: Pool,
  alerts: Alerts,
  o: CloseDropInput,
): Promise<CloseDropResult> {
  const scheme = requireSigScheme()
  const drop = await loadDropForClose(pool, o.publicId)

  // ---- authorization, OUTSIDE any transaction ---------------------------------

  const challenge = await loadChallenge(pool, o.challengeId)
  if (!challenge) throw new CloseRejectedError('unknown_challenge', 'challenge not found')
  if (challenge.drop_id !== drop.id) {
    throw new CloseRejectedError('cross_drop_challenge', 'challenge belongs to another drop')
  }
  if (challenge.action !== 'close') {
    // A claim challenge presented as a close authorization. The signed bytes
    // would fail `parseCloseChallenge` anyway; this names it accurately.
    throw new CloseRejectedError('message_mismatch', 'challenge does not authorize a close')
  }

  const message = challenge.canonical_message
  const parsed = parseCloseChallenge(message, o.publicId)

  const check = checkWalletSignature({
    message,
    publicKeyHex: o.publicKeyHex,
    signatureHex: o.signatureHex,
    scheme,
  })
  if (!check.ok) {
    if (check.schemeMismatch) {
      throw new CloseRejectedError(
        'invalid_signature',
        `signature does not verify under SIG_SCHEME=${scheme}`,
        {
          alert: 'sig_scheme_mismatch',
          detail: {
            dropId: drop.id,
            stage: 'sponsor_close',
            configured: scheme,
            verifiesUnder: otherScheme(scheme),
            walletScheme: WALLET_SIG_SCHEME,
          },
        },
      )
    }
    throw new CloseRejectedError('invalid_signature', 'signature does not verify')
  }

  // The acting address is DERIVED from the verified key. The request body never
  // nominates one, and neither does the browser session.
  let signer: string
  try {
    signer = addressFromPublicKey(o.publicKeyHex)
  } catch {
    throw new CloseRejectedError('invalid_signature', 'public key is not usable')
  }

  // Freshness of the signed message, before the locks. The stored row's own
  // `expires_at` is re-checked inside the consuming UPDATE, which is authority.
  try {
    assertChallengeFresh(parsed)
  } catch (err) {
    if (err instanceof ChallengeError) {
      throw new CloseRejectedError('challenge_expired', 'challenge expired')
    }
    throw err
  }

  // A spent nonce cannot become a close, so there is no point taking the custody
  // lock for it. The atomic consume below remains the authority.
  if (challenge.consumed_at !== null) {
    throw new CloseRejectedError('challenge_consumed', 'challenge already used')
  }

  // ---- the close: the sweeper's transaction, with a signature for a clock -----

  const client: PoolClient = await pool.connect()
  try {
    const result = await closeLiveDrop(client, alerts, {
      dropId: drop.id,
      reason: 'closed_by_sponsor',
      stage: 'sponsor_close',
      // The clock is not this caller's authority, and requiring it would defeat
      // the entire feature: a sponsor closes early or not at all.
      requireExpired: false,
      authorize: (tx, locked) => authorizeSponsor(tx, locked, { signer, challenge, message }),
    })

    if (result.outcome === 'deferred') {
      // Paused, or reconciliation too stale to move money. The close writes a
      // new outgoing liability, so it obeys the same controls as every other
      // money mutation. Rethrown unchanged so `http/app.ts` maps it to the 503
      // it already maps for claims and funding.
      throw result.error
    }
    if (result.outcome === 'skipped') throw skipRejection(o.publicId, result.reason, result.state)

    if (result.unclaimedSlots === null) {
      // Unreachable: `authorizeSponsor` above already refused any drop whose
      // `refund_address` is NULL, which is every operator (capped or
      // uncapped, migration 025) drop for its whole life — the only kind
      // `closeLiveDrop` ever reports a null slot count for.
      throw new CloseRejectedError('not_the_funder', 'only the funding wallet can close this drop')
    }

    return {
      reservedClaims: result.reservedClaims,
      unclaimedSlots: result.unclaimedSlots,
      refundLuna: result.refundLuna,
    }
  } finally {
    client.release()
  }
}

/**
 * The two checks that can only be answered under the locks, run in that order.
 *
 * Ownership first, then the nonce: a wallet that is not the funder must not be
 * able to burn the real sponsor's challenge by racing them with it.
 */
async function authorizeSponsor(
  client: PoolClient,
  drop: ClosableDropRow,
  o: { signer: string; challenge: ChallengeRow; message: string },
): Promise<void> {
  // `refund_address` is the sender of the verified funding transaction and the
  // only address this drop can ever pay a refund to, so requiring the signature
  // to come from it means an early close can only ever return money to the
  // person who put it in. A live drop with no recorded funder is a corrupted
  // invariant; refuse rather than close it on somebody's say-so.
  if (!drop.refund_address || drop.refund_address !== o.signer) {
    throw new CloseRejectedError('not_the_funder', 'only the funding wallet can close this drop')
  }

  // Single-use, in one statement, bound to this drop and this action. A second
  // request carrying the same nonce matches nothing and is refused; this whole
  // transaction rolls back if anything after it throws, so a failed close does
  // not spend the sponsor's approval.
  const { rows } = await client.query<{ canonical_message: string }>(
    `UPDATE wallet_challenges
     SET consumed_at = now()
     WHERE id = $1 AND drop_id = $2 AND action = 'close'
       AND consumed_at IS NULL AND expires_at > now()
     RETURNING canonical_message`,
    [o.challenge.id, drop.id],
  )
  if (!rows[0]) throw await challengeRejection(client, o.challenge.id)
  if (rows[0].canonical_message !== o.message) {
    // The row changed under us: what we verified is not what we consumed.
    throw new CloseRejectedError('message_mismatch', 'challenge message changed')
  }
}

/**
 * Why the atomic consume matched nothing: already spent, or past its window.
 * Read after the failed UPDATE so the answer reflects the same transaction.
 */
async function challengeRejection(
  db: Queryable,
  challengeId: string,
): Promise<CloseRejectedError> {
  const { rows } = await db.query<{ consumed: boolean; expired: boolean }>(
    `SELECT consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired
     FROM wallet_challenges WHERE id = $1`,
    [challengeId],
  )
  const row = rows[0]
  if (!row) return new CloseRejectedError('unknown_challenge', 'challenge not found')
  if (row.consumed) return new CloseRejectedError('challenge_consumed', 'challenge already used')
  return new CloseRejectedError('challenge_expired', 'challenge expired')
}

/** Turn a skipped close into the reason the sponsor's screen has to render. */
function skipRejection(publicId: string, reason: string, state: string | null): Error {
  if (reason === 'not_found') return new DropNotFoundError(publicId)
  if (reason === 'missing_refund_address') {
    // The close already handed the drop to an operator and alerted. Telling the
    // sponsor "not the funder" would be a lie, and "try again" would be worse.
    return new CloseRejectedError(
      'drop_not_live',
      'this drop is being reviewed by the operator and cannot be closed here',
    )
  }
  return notLiveRejection(state)
}

/**
 * One vocabulary for "this drop cannot be closed", split the way a sponsor
 * actually needs it.
 *
 * An unfunded draft is deliberately its own answer: it holds no money, so there
 * is nothing to refund and nothing was lost — abandoning it is the right advice,
 * and `gcDrafts` collects it. Saying "already closed" there would be false.
 */
function notLiveRejection(state: string | null): CloseRejectedError {
  if (state === 'awaiting_funding' || state === 'funding_pending') {
    return new CloseRejectedError('drop_not_funded', 'this drop was never funded')
  }
  if (state === 'closing' || state === 'settled' || state === 'refunded') {
    return new CloseRejectedError('already_closed', 'this drop is already closed')
  }
  return new CloseRejectedError('drop_not_live', 'this drop cannot be closed')
}
