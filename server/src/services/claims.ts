import { randomUUID } from 'node:crypto'
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
import { ConflictError, bindIdem, idemKeyHash, lookupIdem } from '../http/idempotency'
import { statusToken, hashToken } from '../ids'
import { formatNim } from '../money'
// Dependency-free and NOT from `gates/`: the one-way arrow in `gates/types.ts`
// says the money path imports no kind, and this is a 36-character checksum, not
// a kind.
import { normaliseNimiqAddress } from '../nimiq-address'
import type { AlertKind } from './alerts'
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
  /**
   * The sponsor closed their drop early (`services/close.ts`). Distinct from
   * `drop_expired` because it is a different thing to have happened to a
   * claimant: no deadline passed, a person decided. Anyone who had already
   * reserved a share still gets paid — the close honours every reservation — so
   * this code is only ever shown to someone who had not.
   */
  | 'closed_by_sponsor'
  | 'exhausted'
  /**
   * This drop carries a condition and this wallet has not satisfied it.
   *
   * Deliberately kind-agnostic: this module does not know whether the condition
   * was a quiz, a passphrase or a third party's signature, and must not learn.
   */
  | 'gate_required'

/**
 * An operator-facing finding attached to a refusal that the claimant must not
 * be told apart from any other refusal.
 *
 * It exists for exactly one situation so far: a signature that verifies under
 * the scheme we are NOT configured for. That is a deployment fault — every
 * claimant of every drop is being turned away — and it is invisible from the
 * outside, because a rejected claim looks the same either way. The claim is
 * still refused; the alert is how the fault stops being silent.
 */
export interface ClaimDiagnostic {
  alert: AlertKind
  detail: Record<string, unknown>
}

export class ClaimRejectedError extends ClaimError {
  constructor(
    readonly code: ClaimRejectionCode,
    message: string,
    /** Never reaches the client. `http/app.ts` turns it into an operator alert. */
    readonly diagnostic?: ClaimDiagnostic,
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
  /**
   * Called once, by the ONE request that is actually committing a new
   * reservation. The HTTP layer charges its per-drop rate-limit bucket here.
   * Throwing from this hook aborts the reservation: it runs inside the
   * allocation transaction, immediately before the claim row is inserted, so a
   * throw rolls back everything including the consumed challenge.
   *
   * G1 review finding 8 moved this behind signature verification, so an
   * unauthenticated flood — malformed bodies, unknown challenges, forged
   * signatures — could not spend a drop's claim budget. Round-2 F8 moved it
   * behind the retry checks as well: a signature proves who is asking, not that
   * they are asking for anything NEW, so a claimant retrying their own request
   * (the exact thing the idempotency contract invites them to do) was still
   * charged.
   *
   * Round-3 R5 moved it inside the transaction, which is the only place the
   * question can actually be answered. The pre-lock retry check runs before any
   * claim exists, so ten CONCURRENT copies of one retry all saw no claim, all
   * charged the bucket, and nine of them then discovered under the lock that
   * they were duplicates and returned the winner's claim — ten tokens spent on
   * one reservation, a self-inflicted lockout from a claimant pressing a button
   * ten times. Sequential retries were free and concurrent ones were not, which
   * is not a distinction the idempotency contract lets a client control.
   * Charging after the under-lock recheck makes duplicates free in both
   * orderings: they never reach this line.
   */
  onAuthenticated?: () => void | Promise<void>
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
  /**
   * The CLAIM's amount, as a decimal NIM string, e.g. `"2.5"`. Equal to the
   * drop's per-person share, except on a scored grant, where it is the
   * committed payout — the amount actually written to `outgoing_transfers`,
   * not the drop's full share.
   */
  amountEach: string
}

// ---- challenge issuance ------------------------------------------------------

/**
 * `PUBLIC_ORIGIN` and `SIG_SCHEME` are read through `auth/` (`requireAudience`,
 * `requireSigScheme`) rather than here, so that this path and the sponsor's
 * close path cannot end up bound to different audiences or verifying different
 * bytes. Both still fail closed on an unset or unknown value.
 */

/**
 * The claim path's slice of a drop row — deliberately narrower than the one
 * `drops.ts` reads, and named apart from it so the two never get confused.
 */
interface ClaimDropRow {
  id: string
  state: string
  closing_reason: string | null
  /** `null` means uncapped (migration 025): no slot ceiling. */
  claim_count: number | null
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
    origin: requireAudience(),
    network: requireNetwork(),
    dropPublicId: publicId,
    action: 'claim',
  })
  const message = buildChallengeMessage(challenge)
  const expiresAt = new Date(challenge.exp * 1000)

  // `action` is written explicitly rather than left to the column default: the
  // consuming UPDATE filters on it, and a row whose action came from a default
  // is a row whose authorization nobody chose.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO wallet_challenges (drop_id, action, nonce_hash, canonical_message, expires_at)
     VALUES ($1, 'claim', $2, $3, $4)
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
  consumed_at: Date | null
}

async function loadChallenge(db: Queryable, challengeId: string): Promise<ChallengeRow | null> {
  if (!UUID_RE.test(challengeId)) return null
  const { rows } = await db.query<ChallengeRow>(
    'SELECT id, drop_id, canonical_message, consumed_at FROM wallet_challenges WHERE id = $1',
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
    parsed.aud !== requireAudience() ||
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
 * recorded, or this wallet has no fresh grant and already holds a slot.
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

  // A fresh grant outranks an older claim. This is what makes trivia replay
  // payouts possible without teaching the money path what a trivia game is:
  // every condition still presents the same consumable row.
  const canonicalRecipient = normaliseNimiqAddress(o.recipient) ?? o.recipient
  const { rows: spendable } = await db.query<{ exists: boolean }>(
    `SELECT true AS exists FROM gate_grants
     WHERE drop_id = $1 AND wallet_address = $2 AND consumed_claim_id IS NULL
     LIMIT 1`,
    [o.dropId, canonicalRecipient],
  )
  if (spendable[0]) return null

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM claims
     WHERE drop_id = $1 AND recipient_address = $2
     ORDER BY reserved_at DESC, id DESC
     LIMIT 1`,
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

  const check = checkWalletSignature({
    message,
    publicKeyHex: o.publicKeyHex,
    signatureHex: o.signatureHex,
    scheme,
  })
  if (!check.ok) {
    // A mismatch is OUR fault, not the claimant's, and it refuses everyone
    // silently: the claim still fails, but an operator gets told why. Accepting
    // the other scheme here instead would mean the running server verifies
    // bytes nobody configured it to verify, which is not a fix, it is a second
    // undocumented scheme.
    if (check.schemeMismatch) {
      throw new ClaimRejectedError(
        'invalid_signature',
        `signature does not verify under SIG_SCHEME=${scheme}`,
        {
          alert: 'sig_scheme_mismatch',
          detail: {
            dropId: drop.id,
            configured: scheme,
            verifiesUnder: otherScheme(scheme),
            walletScheme: WALLET_SIG_SCHEME,
          },
        },
      )
    }
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

  // A challenge that has already been spent cannot become a reservation, so a
  // replay of one is not a new claim attempt either. The atomic consume inside
  // the transaction remains the authority — this read only saves the pointless
  // work of taking the custody lock for a request that cannot succeed.
  if (challenge.consumed_at !== null) {
    throw new ClaimRejectedError('challenge_consumed', 'challenge already used')
  }

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
      // `action = 'claim'` is the database's copy of the binding the signed
      // bytes already carry (`parseChallenge` refuses any other action). A
      // challenge minted to authorize a sponsor's close can therefore never be
      // spent here even if a future edit drops the message check.
      `UPDATE wallet_challenges
       SET consumed_at = now()
       WHERE id = $1 AND action = 'claim' AND consumed_at IS NULL AND expires_at > now()
       RETURNING canonical_message`,
      [challenge.id],
    )
    if (!consumed[0]) throw await challengeRejection(client, challenge.id)
    if (consumed[0].canonical_message !== message) {
      throw new ClaimRejectedError('message_mismatch', 'challenge message changed')
    }

    // 4b. The gate, if this drop carries one. An ungated drop finds no row and
    //     proceeds exactly as it always has.
    //
    //     KIND-AGNOSTIC BY DESIGN. This asks one question — does this wallet
    //     hold an unconsumed grant for this drop — and imports nothing from
    //     `src/gates/`. That is what keeps the question bank, the selection salt
    //     and the attester keys out of the money path, and it is why adding a
    //     fourth kind of condition will not touch this file. There is a grep in
    //     the plan's verification list that fails if this module ever imports a
    //     kind.
    //
    //     IT HAS TO BE HERE, for two independent reasons. `issueChallenge` takes
    //     only a public id, so it cannot bind a grant to a wallet even in
    //     principle — challenge-time gating is a UX courtesy with no security
    //     weight. And the grant must be consumed in the SAME transaction that
    //     inserts the claim, or two concurrent claims could each see it
    //     unconsumed and both reserve a slot against one satisfied condition.
    //
    //     `recipient` is DERIVED from the verified public key (see step 3), never
    //     nominated by a request body. That is the whole reason a condition may
    //     be attempted with no wallet signature at all: a grant issued under
    //     someone else's address is worthless to whoever issued it, because the
    //     comparison below is against a key the claimant proved they hold.
    //
    //     Lock order is custody_controls -> drops -> gate_grants. This is the
    //     last lock taken and nothing else in the system locks it earlier.
    const { rows: gate } = await client.query<{ drop_id: string }>(
      'SELECT drop_id FROM drop_gates WHERE drop_id = $1',
      [drop.id],
    )
    let grantId: string | null = null
    // Read off the grant ROW at the same lock that spends it, never from a kind:
    // that is what keeps this file able to pay a scored amount while still
    // importing nothing from `src/gates/`. NULL for every ungated drop and every
    // grant issued before scoring existed.
    let payoutPermille: number | null = null
    if (gate.length > 0) {
      // Compared in the spelling `gate_grants` stores, which is the compact one.
      //
      // The two columns genuinely hold different spellings of the same address,
      // and that is a decision rather than an oversight. `recipient` comes from
      // `addressFromPublicKey`, which returns the grouped form a wallet displays
      // — and `claims.recipient_address` keeps it, because it is what a person
      // reads off a receipt and because changing it would restate every row this
      // system has already written. Grants are canonicalised on the way in
      // instead, since a grant's address arrives from a CLIENT and can be spelled
      // any of several ways, while a derived one cannot.
      //
      // This line is the only place the two meet, so it is the only place that
      // has to bridge them. Comparing the raw `recipient` against a canonical
      // grant matches nothing, and every gated claim is refused with
      // `gate_required` — the condition satisfied, the money unreachable.
      const canonicalRecipient = normaliseNimiqAddress(recipient) ?? recipient
      const { rows: held } = await client.query<{ id: string; payout_permille: number | null }>(
        `SELECT id, payout_permille FROM gate_grants
         WHERE drop_id = $1 AND wallet_address = $2 AND consumed_claim_id IS NULL
         ORDER BY granted_at, id
         LIMIT 1
         FOR UPDATE`,
        [drop.id, canonicalRecipient],
      )
      if (!held[0]) {
        throw new ClaimRejectedError(
          'gate_required',
          'this drop requires its condition to be satisfied by this wallet first',
        )
      }
      grantId = held[0].id
      payoutPermille = held[0].payout_permille
    }

    // The scored amount, floored to whole luna. NULL permille — every grant
    // issued before scoring existed, and every kind without partial success —
    // pays the full share. The number comes off the grant ROW, so this file
    // still knows nothing about what a score is. Computed here, ahead of slot
    // reservation, because an uncapped drop's solvency check below needs it.
    const payoutLuna =
      grantId !== null && payoutPermille !== null
        ? (BigInt(locked.amount_each_luna) * BigInt(payoutPermille)) / 1000n
        : BigInt(locked.amount_each_luna)

    // 5. Reserve the next slot. A capped drop refuses at its ceiling and the
    //    last slot closes the drop in this same transaction, so no later
    //    claimer can ever see capacity again. An uncapped drop (migration 025,
    //    `claim_count IS NULL`) has neither ceiling nor closing transition —
    //    see step 7b below for what gates it instead.
    const { rows: counted } = await client.query<{ reserved: number }>(
      'SELECT count(*)::int AS reserved FROM claims WHERE drop_id = $1',
      [drop.id],
    )
    const slotIndex = counted[0].reserved
    if (locked.claim_count !== null) {
      if (slotIndex >= locked.claim_count) {
        throw new ClaimRejectedError('exhausted', 'every slot in this drop is taken')
      }
      if (slotIndex + 1 === locked.claim_count) {
        await client.query(
          `UPDATE drops SET state = 'closing', closing_reason = 'exhausted' WHERE id = $1`,
          [drop.id],
        )
      }
    }

    // 6. This request — and only this request — is now committing a NEW slot,
    //    so this is where it pays for one (R5). Everything that could have made
    //    it a duplicate, a replay or a refusal is behind us, and every other
    //    concurrent copy of it is either still waiting for the custody lock or
    //    has already left through the raced-claim branch above without paying.
    //    A throw here rolls the whole allocation back, challenge included.
    if (o.onAuthenticated) await o.onAuthenticated()

    // 7. Claim, payout intent and idempotency record: one commit or none.
    //    The id is generated here, not by the database, so the bearer token can
    //    be derived before the row that stores its hash is written.
    const claimId = randomUUID()
    const token = statusToken(claimId)
    await client.query(
      `INSERT INTO claims (
         id, drop_id, slot_index, recipient_address, status_token_hash, state, gate_grant_id
       ) VALUES ($1, $2, $3, $4, $5, 'reserved', $6)`,
      [claimId, drop.id, slotIndex, recipient, hashToken(token), grantId],
    )
    await client.query(
      `INSERT INTO outgoing_transfers (
         idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
       ) VALUES ($1, 'payout', $2, $3, $4, $5, 'queued')`,
      [`payout:${claimId}`, drop.id, claimId, recipient, payoutLuna.toString()],
    )

    // 7b. Uncapped drops (migration 025) have no `expected_funding_luna` that
    //     already counts this payout as outstanding, unlike a capped drop's —
    //     so this is where solvency for it is asserted, exactly the way
    //     `createOperatorFundedDrop` asserts a drop's own principal: with
    //     `0n`, because the row just inserted above is ALREADY counted by
    //     `outstandingPrincipalLuna` (same client, same open transaction —
    //     Postgres always sees a session's own uncommitted writes), not
    //     because nothing is owed. A throw here rolls back everything this
    //     transaction has written so far — the claim row, the transfer row,
    //     the consumed challenge, the spent grant — via the catch below, so a
    //     refusal leaves neither the claim nor the transfer behind.
    //
    //     Deliberately NOT `assertSolvent(client, controls, payoutLuna)`
    //     BEFORE this insert. `assertSolvent`'s `addLuna` is added to both
    //     sides of its comparison (`ledger + addLuna >= outstanding + addLuna
    //     + reserve`), so it cancels out algebraically — correct ONLY when
    //     `addLuna` is credited to the ledger at the same instant it becomes
    //     a liability, which is true for a sponsor's activation
    //     (`ledgerMovementsLuna` counts it) and false for an uncapped payout
    //     (nothing enters custody). Passing `payoutLuna` before this row
    //     existed would have checked pre-existing solvency only, regardless
    //     of the payout's size, and let the true post-claim liability run
    //     past the float by exactly one share every time.
    if (locked.claim_count === null) {
      await assertSolvent(client, controls, 0n)
    }

    // The grant is spent HERE, in the transaction that created the claim it paid
    // for. A rollback un-spends it, so a claim refused after this point — by the
    // limiter hook, by a constraint — leaves the claimant free to try again. A
    // commit binds the two together, so it can never fund a second slot.
    if (grantId !== null) {
      const spent = await client.query(
        `UPDATE gate_grants SET consumed_claim_id = $2
         WHERE id = $1 AND consumed_claim_id IS NULL`,
        [grantId, claimId],
      )
      if (spent.rowCount !== 1) throw new Error('locked grant was not consumed exactly once')
    }
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
  if (drop.state === 'closing' && drop.closing_reason === 'closed_by_sponsor') {
    return new ClaimRejectedError('closed_by_sponsor', 'the sponsor closed this drop')
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
    amount_luna: string
    tx_hash: string | null
  }>(
    `SELECT c.state,
            COALESCE((SELECT t.amount_luna FROM outgoing_transfers t
                       WHERE t.claim_id = c.id AND t.purpose = 'payout'
                       LIMIT 1),
                     d.amount_each_luna) AS amount_luna,
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
    amountEach: formatNim(BigInt(row.amount_luna)),
    ...(row.tx_hash === null ? {} : { txHash: row.tx_hash }),
  }
}

/** Re-exported so HTTP callers map one conflict type, not two. */
export { ConflictError } from '../http/idempotency'
