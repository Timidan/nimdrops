import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  assertChallengeFresh,
  buildChallengeMessage,
  ChallengeError,
  issueChallenge as mintChallenge,
  type Challenge,
} from '../auth/challenge'
import { addressFromPublicKey, verifyWalletSignature, type SigScheme } from '../auth/verify'
import { requireNetwork } from '../config'
import type { Queryable } from '../db/pool'
import { ConflictError, bindIdem, idemKeyHash, lookupIdem } from '../http/idempotency'
import { statusToken, hashToken } from '../ids'
import { formatNim } from '../money'
import { DropNotFoundError } from './drops'
import { assertSolvent, lockControls } from './solvency'

/**
 * Claim authorization and atomic allocation (design §8).
 *
 * The order of operations in {@link reserveClaim} is the design, not a
 * preference, and every line of it is load-bearing:
 *
 *  1. **Verify the signature and derive the recipient BEFORE opening the
 *     transaction.** Ed25519 verification is slow relative to a row lock; doing
 *     it under the singleton custody lock would serialize every claimant behind
 *     it. No chain call and no cryptography happens while a lock is held.
 *  2. **The retry path runs BEFORE the safety checks.** A matching idempotency
 *     record, or an already-committed claim for this wallet, is answered even
 *     while the system is paused: returning a receipt for money already owed
 *     creates no new liability, and safety controls exist to stop new money
 *     mutations, not status recovery.
 *  3. **Lock order is ALWAYS `custody_controls` → drop row.** Funding
 *     activation (`drops.ts`) and expiry (Task 12) take the same two locks in
 *     the same order; reversing them here would deadlock against both.
 *  4. **The challenge is consumed by the UPDATE itself**, not by a read
 *     followed by a write, so two requests carrying the same nonce cannot both
 *     see it unconsumed.
 *
 * The bearer token is derived as `HMAC(status_secret, claimId)` and never
 * stored: the database holds only `hashToken(token)`, so an exact retry can
 * reproduce the plaintext token while a database leak cannot.
 */

/** Claim lifecycle (design §6.2). A projection of its immutable transfer intent. */
export type ClaimState = 'reserved' | 'sending' | 'confirming' | 'paid' | 'manual_review'

/** Idempotency scope: one route + one drop. Keys never collide across drops. */
export function claimIdemScope(publicId: string): string {
  return `POST /api/drops/${publicId}/claims`
}

export class ClaimError extends Error {}

/** Uniform not-found for status reads: a wrong token is indistinguishable from a wrong id. */
export class ClaimNotFoundError extends ClaimError {
  constructor() {
    super('claim not found')
  }
}

/** Why a claim was refused. Callers map these to generic client-facing messages. */
export type ClaimRejectionCode =
  | 'unknown_challenge'
  | 'cross_drop_challenge'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'invalid_signature'
  | 'message_mismatch'
  | 'drop_not_live'
  | 'drop_expired'
  | 'exhausted'

export class ClaimRejectedError extends ClaimError {
  constructor(
    readonly code: ClaimRejectionCode,
    message: string,
  ) {
    super(message)
  }
}

export interface IssuedChallenge {
  challengeId: string
  /** The canonical message the wallet must sign, byte for byte. */
  message: string
  expiresAt: Date
}

export interface ReserveClaimInput {
  publicId: string
  challengeId: string
  publicKeyHex: string
  signatureHex: string
  /** Caller-supplied HTTP idempotency key (design §11). */
  idemKey: string
  /** Canonical hash of the request the key was used for. */
  requestHash: string
}

export interface ClaimResult {
  claimId: string
  /** Plaintext bearer token — reproducible, never persisted. */
  statusToken: string
  state: ClaimState
}

export interface ClaimStatus {
  state: ClaimState
  /** Present only once an on-chain attempt is confirmed. `broadcast` is not `paid`. */
  txHash?: string
  /** Decimal NIM string, e.g. `"2.5"`. */
  amountEach: string
}

// ---- configuration (fail closed) --------------------------------------------

function requireOrigin(): string {
  const origin = process.env.PUBLIC_ORIGIN
  if (!origin) throw new ClaimError('PUBLIC_ORIGIN is not set')
  return origin
}

/**
 * Which bytes the wallet signs. Locked by the Task 7 device fixture and supplied
 * as config; an unset or unknown value fails closed rather than guessing, since
 * guessing wrong would either reject every real claimant or accept a signature
 * over bytes we never authored.
 */
function requireSigScheme(): SigScheme {
  const scheme = process.env.SIG_SCHEME
  if (scheme !== 'raw' && scheme !== 'nimiq-signed-message') {
    throw new ClaimError(
      `SIG_SCHEME must be raw or nimiq-signed-message (got ${scheme ?? 'unset'})`,
    )
  }
  return scheme
}

// ---- challenge issuance ------------------------------------------------------

/** Only the hash of the nonce is stored, so a database read cannot forge a challenge. */
function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

/**
 * The claim path's slice of a drop row — deliberately narrower than the one
 * `drops.ts` reads, and named apart from it so the two never get confused.
 */
interface ClaimDropRow {
  id: string
  state: string
  closing_reason: string | null
  claim_count: number
  amount_each_luna: string
  expires_at: Date | null
}

const SELECT_DROP_COLUMNS =
  'id, state, closing_reason, claim_count, amount_each_luna, expires_at'

async function loadDropForClaim(db: Queryable, publicId: string): Promise<ClaimDropRow> {
  const { rows } = await db.query<ClaimDropRow>(
    `SELECT ${SELECT_DROP_COLUMNS} FROM drops WHERE public_id = $1`,
    [publicId],
  )
  const row = rows[0]
  if (!row) throw new DropNotFoundError(publicId)
  return row
}

/**
 * Mint a short-lived, single-use claim challenge for one drop (design §8.1).
 *
 * Takes no locks and moves no money: the reservation transaction is the only
 * place a challenge can be spent, and it re-validates everything.
 */
export async function issueChallenge(pool: Pool, publicId: string): Promise<IssuedChallenge> {
  const drop = await loadDropForClaim(pool, publicId)
  if (drop.state !== 'live') {
    throw new ClaimRejectedError('drop_not_live', 'drop is not accepting claims')
  }

  const challenge = mintChallenge({
    origin: requireOrigin(),
    network: requireNetwork(),
    dropPublicId: publicId,
  })
  const message = buildChallengeMessage(challenge)
  const expiresAt = new Date(challenge.exp * 1000)

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO wallet_challenges (drop_id, nonce_hash, canonical_message, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [drop.id, nonceHash(challenge.nonce), message, expiresAt],
  )

  return { challengeId: rows[0].id, message, expiresAt }
}

// ---- reservation --------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ChallengeRow {
  id: string
  drop_id: string
  canonical_message: string
}

async function loadChallenge(db: Queryable, challengeId: string): Promise<ChallengeRow | null> {
  if (!UUID_RE.test(challengeId)) return null
  const { rows } = await db.query<ChallengeRow>(
    'SELECT id, drop_id, canonical_message FROM wallet_challenges WHERE id = $1',
    [challengeId],
  )
  return rows[0] ?? null
}

/** Parse and re-canonicalize the stored message: it must be one we could have issued. */
function parseChallenge(message: string, publicId: string): Challenge {
  let parsed: Challenge
  try {
    parsed = JSON.parse(message) as Challenge
  } catch {
    throw new ClaimRejectedError('message_mismatch', 'challenge message is not valid')
  }
  const mismatch =
    buildChallengeMessage(parsed) !== message ||
    parsed.drop !== publicId ||
    parsed.action !== 'claim' ||
    parsed.aud !== requireOrigin() ||
    parsed.net !== requireNetwork()
  if (mismatch) {
    throw new ClaimRejectedError('message_mismatch', 'challenge message is not valid for this drop')
  }
  return parsed
}

async function claimResult(db: Queryable, claimId: string): Promise<ClaimResult | null> {
  const { rows } = await db.query<{ state: ClaimState }>(
    'SELECT state FROM claims WHERE id = $1',
    [claimId],
  )
  if (!rows[0]) return null
  return { claimId, statusToken: statusToken(claimId), state: rows[0].state }
}

/**
 * The two ways a request can already have a claim: the exact idempotency key was
 * recorded, or this wallet already holds a slot in this drop.
 *
 * Runs twice per reservation — once before any lock (cheap, and the only path
 * open while paused) and once after the locks are taken, which is what closes
 * the race against a concurrent duplicate of the same request.
 */
async function findExistingClaim(
  db: Queryable,
  o: { scope: string; keyHash: string; requestHash: string; dropId: string; recipient: string },
): Promise<ClaimResult | null> {
  const recorded = await lookupIdem(db, o.scope, o.keyHash)
  if (recorded) {
    if (recorded.requestHash !== o.requestHash) {
      // Surfaced by bindIdem's own check too; raising here keeps the pure-read
      // retry path from silently returning another request's resource.
      throw new ConflictError()
    }
    if (recorded.resourceId) {
      const existing = await claimResult(db, recorded.resourceId)
      if (existing) return existing
    }
  }

  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM claims WHERE drop_id = $1 AND recipient_address = $2',
    [o.dropId, o.recipient],
  )
  if (!rows[0]) return null

  // A new key for a wallet that already claimed: bind it to the existing claim
  // so this key is answerable too. Metadata only — no new financial liability,
  // which is why it is allowed to run while the system is paused.
  await bindIdem(db, {
    scope: o.scope,
    keyHash: o.keyHash,
    requestHash: o.requestHash,
    resourceType: 'claim',
    resourceId: rows[0].id,
    responseStatus: 202,
  })
  return claimResult(db, rows[0].id)
}

/**
 * Reserve one fixed slot for the wallet that signed the challenge (design §8.2).
 *
 * Returns the caller's existing claim — with the same reproducible token — for
 * an exact retry, for a repeated idempotency key, and for a wallet that already
 * holds a slot, even if that wallet's original nonce is long gone.
 */
export async function reserveClaim(pool: Pool, o: ReserveClaimInput): Promise<ClaimResult> {
  const scheme = requireSigScheme()
  const drop = await loadDropForClaim(pool, o.publicId)

  // ---- authorization, OUTSIDE any transaction --------------------------------

  const challenge = await loadChallenge(pool, o.challengeId)
  if (!challenge) throw new ClaimRejectedError('unknown_challenge', 'challenge not found')
  if (challenge.drop_id !== drop.id) {
    throw new ClaimRejectedError('cross_drop_challenge', 'challenge belongs to another drop')
  }

  const message = challenge.canonical_message
  const parsed = parseChallenge(message, o.publicId)

  if (
    !verifyWalletSignature({
      message,
      publicKeyHex: o.publicKeyHex,
      signatureHex: o.signatureHex,
      scheme,
    })
  ) {
    throw new ClaimRejectedError('invalid_signature', 'signature does not verify')
  }

  // The recipient is DERIVED from the verified key. The request body never
  // nominates a payout address (design §8.1).
  let recipient: string
  try {
    recipient = addressFromPublicKey(o.publicKeyHex)
  } catch {
    throw new ClaimRejectedError('invalid_signature', 'public key is not usable')
  }

  const scope = claimIdemScope(o.publicId)
  const keyHash = idemKeyHash(scope, o.idemKey)
  const lookup = { scope, keyHash, requestHash: o.requestHash, dropId: drop.id, recipient }

  // ---- retry path: BEFORE the safety checks, by design -----------------------

  const alreadyClaimed = await findExistingClaim(pool, lookup)
  if (alreadyClaimed) return alreadyClaimed

  // ---- allocation: one transaction, locks in the mandated order ---------------

  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. custody_controls first (throws PausedError / StaleReconciliationError),
    //    then the drop row. Never the other way round.
    const controls = await lockControls(client)
    const { rows: lockedRows } = await client.query<ClaimDropRow>(
      `SELECT ${SELECT_DROP_COLUMNS} FROM drops WHERE id = $1 FOR UPDATE`,
      [drop.id],
    )
    const locked = lockedRows[0]
    if (!locked) throw new DropNotFoundError(o.publicId)

    // 2. Recheck under the locks: a concurrent duplicate may have committed
    //    between the pre-lock read and here.
    const raced = await findExistingClaim(client, lookup)
    if (raced) {
      await client.query('COMMIT')
      return raced
    }

    // 3. Only a live, unexpired drop can allocate. A closed drop reports WHY —
    //    the claimant who lost the race for the last slot must be told the drop
    //    is exhausted, not merely "not live" (design §6.2: exhausted is the UI
    //    projection of closing + closing_reason).
    if (locked.state !== 'live') throw closedRejection(locked)
    if (locked.expires_at !== null && locked.expires_at.getTime() <= Date.now()) {
      throw new ClaimRejectedError('drop_expired', 'drop has expired')
    }

    // Allocation moves no new principal into custody — the sponsor's funding is
    // already outstanding — so it adds 0. The check still runs: an insolvent or
    // over-cap system must not hand out new liabilities.
    await assertSolvent(client, controls, 0n)

    // 4. The signed message must still be inside its own validity window, and
    //    the stored row must still be unconsumed and unexpired. The message
    //    check is defence in depth; the row is the authority, and consuming it
    //    in the UPDATE itself is what makes the nonce single-use under load.
    try {
      assertChallengeFresh(parsed)
    } catch (err) {
      if (err instanceof ChallengeError) {
        throw new ClaimRejectedError('challenge_expired', 'challenge expired')
      }
      throw err
    }
    const { rows: consumed } = await client.query<{ canonical_message: string }>(
      `UPDATE wallet_challenges
       SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING canonical_message`,
      [challenge.id],
    )
    if (!consumed[0]) throw await challengeRejection(client, challenge.id)
    if (consumed[0].canonical_message !== message) {
      throw new ClaimRejectedError('message_mismatch', 'challenge message changed')
    }

    // 5. Reserve the next slot; the last one closes the drop in this same
    //    transaction, so no later claimer can ever see capacity again.
    const { rows: counted } = await client.query<{ reserved: number }>(
      'SELECT count(*)::int AS reserved FROM claims WHERE drop_id = $1',
      [drop.id],
    )
    const slotIndex = counted[0].reserved
    if (slotIndex >= locked.claim_count) {
      throw new ClaimRejectedError('exhausted', 'every slot in this drop is taken')
    }
    if (slotIndex + 1 === locked.claim_count) {
      await client.query(
        `UPDATE drops SET state = 'closing', closing_reason = 'exhausted' WHERE id = $1`,
        [drop.id],
      )
    }

    // 6. Claim, payout intent and idempotency record: one commit or none.
    //    The id is generated here, not by the database, so the bearer token can
    //    be derived before the row that stores its hash is written.
    const claimId = randomUUID()
    const token = statusToken(claimId)
    await client.query(
      `INSERT INTO claims (id, drop_id, slot_index, recipient_address, status_token_hash, state)
       VALUES ($1, $2, $3, $4, $5, 'reserved')`,
      [claimId, drop.id, slotIndex, recipient, hashToken(token)],
    )
    await client.query(
      `INSERT INTO outgoing_transfers (
         idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
       ) VALUES ($1, 'payout', $2, $3, $4, $5, 'queued')`,
      [`payout:${claimId}`, drop.id, claimId, recipient, locked.amount_each_luna],
    )
    await bindIdem(client, {
      scope,
      keyHash,
      requestHash: o.requestHash,
      resourceType: 'claim',
      resourceId: claimId,
      responseStatus: 202,
    })

    await client.query('COMMIT')
    return { claimId, statusToken: token, state: 'reserved' }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Turn a non-live drop into the code the claimant's UI needs to render. */
function closedRejection(drop: ClaimDropRow): ClaimRejectedError {
  if (drop.state === 'closing' && drop.closing_reason === 'exhausted') {
    return new ClaimRejectedError('exhausted', 'every slot in this drop is taken')
  }
  if (drop.state === 'closing' && drop.closing_reason === 'expired') {
    return new ClaimRejectedError('drop_expired', 'drop has expired')
  }
  return new ClaimRejectedError('drop_not_live', 'drop is not accepting claims')
}

/**
 * Why the atomic consume matched nothing: already spent, or past its window.
 * Read after the failed UPDATE so the answer reflects the same transaction.
 */
async function challengeRejection(db: Queryable, challengeId: string): Promise<ClaimRejectedError> {
  const { rows } = await db.query<{ consumed: boolean; expired: boolean }>(
    `SELECT consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired
     FROM wallet_challenges WHERE id = $1`,
    [challengeId],
  )
  const row = rows[0]
  if (!row) return new ClaimRejectedError('unknown_challenge', 'challenge not found')
  if (row.consumed) return new ClaimRejectedError('challenge_consumed', 'challenge already used')
  return new ClaimRejectedError('challenge_expired', 'challenge expired')
}

// ---- status ------------------------------------------------------------------

/**
 * Claim status for the bearer-token holder (design §11).
 *
 * The token is matched by its hash inside the query, so a wrong token and a
 * wrong id produce the identical {@link ClaimNotFoundError} — no oracle that
 * confirms a claim exists. A receipt hash appears only for a CONFIRMED attempt:
 * `broadcast` is not `paid`.
 */
export async function claimStatus(
  pool: Pool,
  claimId: string,
  bearerToken: string,
): Promise<ClaimStatus> {
  if (!UUID_RE.test(claimId)) throw new ClaimNotFoundError()

  const { rows } = await pool.query<{
    state: ClaimState
    amount_each_luna: string
    tx_hash: string | null
  }>(
    `SELECT c.state,
            d.amount_each_luna,
            (SELECT a.tx_hash
               FROM transaction_attempts a
               JOIN outgoing_transfers t ON t.id = a.transfer_id
              WHERE t.claim_id = c.id AND t.purpose = 'payout' AND a.state = 'confirmed'
              ORDER BY a.sequence DESC
              LIMIT 1) AS tx_hash
     FROM claims c
     JOIN drops d ON d.id = c.drop_id
     WHERE c.id = $1 AND c.status_token_hash = $2`,
    [claimId, hashToken(bearerToken)],
  )
  const row = rows[0]
  if (!row) throw new ClaimNotFoundError()

  return {
    state: row.state,
    amountEach: formatNim(BigInt(row.amount_each_luna)),
    ...(row.tx_hash === null ? {} : { txHash: row.tx_hash }),
  }
}

/** Re-exported so HTTP callers map one conflict type, not two. */
export { ConflictError } from '../http/idempotency'
