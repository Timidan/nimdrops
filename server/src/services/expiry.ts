import type { Pool, PoolClient } from 'pg'
import { errorMessage } from '../config'
import { logInfo, logWarn } from '../http/redact'
import type { Alerts } from './alerts'
import { PausedError, StaleReconciliationError, lockControls } from './solvency'

/**
 * Expiry, exact refunds, settlement and draft garbage collection (design §9,
 * §6.1) — and, since the sponsor gained a way out, the ONE implementation of
 * "close a live drop and refund what nobody took" that every caller uses.
 *
 * The one sentence this module has to make true:
 *
 *   **A signer outage must never silently move reserved claimant value into a
 *   creator refund, and must never strand an open share indefinitely.**
 *
 * Everything below follows from it:
 *
 *  1. **Closing and refunding are ONE transaction.** The drop leaves `live` and
 *     its single refund intent is written in the same commit, under the same
 *     locks a claim takes, in the same order (`custody_controls` → drop row).
 *     A claim racing the exact instant of expiry therefore either reserves its
 *     slot BEFORE the drop closes — in which case the refund is computed
 *     without that slot — or arrives after and is refused. There is no window
 *     where both, or neither, happen.
 *  2. **The refund is only what nobody claimed.** `(claim_count − reserved) ×
 *     amount_each_luna`, counted inside the locked transaction. Reserved value
 *     stays a claimant liability even if its payout later fails; a failed
 *     payout becomes `manual_review`, never refund capacity.
 *  3. **At most one refund per drop, forever.** The code checks, and
 *     `one_refund_per_drop` (a partial unique index) is the backstop that holds
 *     even if the code is wrong — hence the `ON CONFLICT DO NOTHING`: a
 *     duplicate must be a no-op, not an aborted sweep.
 *  4. **Terminal states require confirmed money, not sent money.** A drop only
 *     becomes `settled`/`refunded` when every intent it owns is `confirmed`
 *     with a `confirmed` on-chain attempt behind it. `broadcast` is not `paid`.
 *
 * Draft GC is the only deletion-shaped path here and it is deliberately narrow:
 * `awaiting_funding` with no funding hash and no activation height. A drop that
 * ever had money pointed at it is an operator reconciliation item (design §7),
 * never a garbage-collected row.
 *
 * ---
 *
 * **Why the sponsor's early close lives in this file.** A sponsor closing their
 * own drop is not a second money path; it is the transition above, triggered on
 * demand instead of by the clock. Every property the sweeper needs — reserved
 * claims honoured, exactly one refund, the same two locks in the same order,
 * the funding sender as the only possible recipient — is a property the close
 * needs, and a second implementation of them would be a second chance to get
 * one of them wrong. So {@link closeLiveDrop} owns the whole transaction, both
 * callers hand it a reason and (for the sponsor) an authorization hook that runs
 * under the locks, and the refund amount is derived in exactly one place: the
 * seven lines below that count reserved claims and multiply the remainder. No
 * other code in this repository computes what a drop owes back.
 */

/** Design §6.1: an unfunded draft may be collected after this long. */
export const DRAFT_GC_AFTER_HOURS = 24

/** Upper bound on drops closed per sweep, so one tick stays short. */
export const SWEEP_BATCH = 50

/**
 * Why a drop left `live`. Stored in `drops.closing_reason` and constrained by
 * `drops_closing_reason_allowed` (migration 017 added the third).
 *
 * `exhausted` is written by `claims.ts` when the last slot is taken, and is not
 * a {@link closeLiveDrop} reason: that close allocates the final slot rather
 * than refunding anything, so it belongs to the allocation transaction.
 */
export type ClosingReason = 'expired' | 'closed_by_sponsor'

/** The columns {@link closeLiveDrop} decides on, read under the row lock. */
export interface ClosableDropRow {
  id: string
  public_id: string
  state: string
  claim_count: number
  amount_each_luna: string
  /** The verified funding sender. The ONLY address a refund can ever go to. */
  refund_address: string | null
  expired: boolean
}

/** Why a close did nothing. Every one of these leaves the drop untouched. */
export type CloseSkipReason =
  | 'not_found'
  | 'not_live'
  | 'not_expired'
  /** A live drop with unallocated value and no recorded funder: for a human. */
  | 'missing_refund_address'

export type CloseResult =
  | {
      outcome: 'closed'
      reservedClaims: number
      unclaimedSlots: number
      /** Zero when every slot was reserved; no intent is written in that case. */
      refundLuna: bigint
    }
  | {
      outcome: 'skipped'
      reason: CloseSkipReason
      /** The state read under the lock, for a caller that must explain itself. */
      state: string | null
    }
  | {
      outcome: 'deferred'
      cause: 'paused' | 'stale_reconciliation'
      /** The original error, so an HTTP caller can map it as it already does. */
      error: Error
    }

/**
 * Authorization, run INSIDE the close transaction with `custody_controls` and
 * the drop row already locked and the drop already confirmed `live`.
 *
 * It is handed the locked row precisely so that the address it checks is the
 * one this transaction will refund to — not a copy read earlier, not a value
 * from a request body. Throwing aborts the whole close, including anything the
 * hook itself wrote (a consumed challenge nonce), which is what lets the hook
 * spend a single-use token without a failed close burning it.
 */
export type CloseAuthorize = (client: PoolClient, drop: ClosableDropRow) => Promise<void>

/** The two fields every close needs, whatever its authority is. */
interface CloseLiveDropCommon {
  dropId: string
  /** Written to `closing_reason`, and named in the alert and the log line. */
  reason: ClosingReason
  /** Names this caller in operator alerts. Unchanged for the sweeper. */
  stage: string
}

/**
 * The authority to close a live drop: the CLOCK or a HOOK, never neither.
 *
 * A union rather than a `requireExpired: boolean` beside an optional hook,
 * because that pair could spell `{ requireExpired: false }` with nothing
 * authorising it — a live drop closed and refunded on nobody's say-so.
 */
export type CloseAuthority =
  | { requireExpired: true; authorize?: undefined }
  | { requireExpired: false; authorize: CloseAuthorize }

export type CloseLiveDropOptions = CloseLiveDropCommon & CloseAuthority

/**
 * Close every `live` drop that is past its expiry and write its refund.
 *
 * Returns the number of drops closed. Each drop is its own transaction: one
 * failure must not hold the rest of the money hostage.
 *
 * Fails closed as a whole when the operator switch is on or reconciliation is
 * stale — expiry writes a new outgoing liability, so it obeys the same controls
 * as every other money mutation. Nothing is lost by deferring: claims are
 * already refused past `expires_at` by `claims.ts`, so a drop that has not been
 * closed yet cannot leak a slot.
 */
export async function sweepExpiry(pool: Pool, alerts: Alerts): Promise<number> {
  const { rows: candidates } = await pool.query<{ id: string }>(
    `SELECT id FROM drops
     WHERE state = 'live' AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at
     LIMIT ${SWEEP_BATCH}`,
  )
  if (candidates.length === 0) return 0

  let closed = 0
  for (const candidate of candidates) {
    const client = await pool.connect()
    try {
      const result = await closeLiveDrop(client, alerts, {
        dropId: candidate.id,
        reason: 'expired',
        stage: 'expiry_sweep',
        // The clock is this caller's entire authority. Re-checked under the
        // row lock, not merely in the SELECT that found the candidate.
        requireExpired: true,
      })
      if (result.outcome === 'closed') closed++
      if (result.outcome === 'deferred') return closed
    } catch (err) {
      // The next tick retries from committed state; one poisoned drop must not
      // stop the others from closing.
      logWarn('expiry_sweep_failed', { dropId: candidate.id, error: errorMessage(err) })
    } finally {
      client.release()
    }
  }
  return closed
}

/**
 * Take a `live` drop out of circulation and write the ONE refund it owes.
 *
 * This is the single implementation of that transition. `sweepExpiry` calls it
 * with the clock as its authority; `services/close.ts` calls it with a sponsor's
 * wallet signature as its authority, through {@link CloseLiveDropOptions.authorize}.
 * There is no other way to close a live drop and no other place a refund amount
 * is computed — which is the point, because the two facts a close must never get
 * wrong are "how much is unallocated" and "who is it unallocated to", and one
 * implementation can only be wrong once.
 *
 * Owns the whole transaction: BEGIN, both locks in the mandated order, the
 * decision, the writes, and COMMIT or ROLLBACK. Callers pass a dedicated client
 * and are responsible only for releasing it.
 *
 * **The three writes are one commit.** The drop leaves `live`, the refund intent
 * appears, and (for the sponsor) the challenge nonce is consumed, atomically. A
 * `reserveClaim` running concurrently takes the same two locks in the same order
 * (`custody_controls` → drop row), so the two transactions serialize: either the
 * claim commits first and is counted here as reserved — its slot is never
 * refunded — or this commits first and the claim's under-lock re-read finds a
 * drop that is no longer `live` and refuses. Neither can see the other half-done.
 */
export async function closeLiveDrop(
  client: PoolClient,
  alerts: Alerts,
  o: CloseLiveDropOptions,
): Promise<CloseResult> {
  const { dropId, reason, stage } = o

  // {@link CloseAuthority} makes this unspellable in TypeScript; this catches a
  // JavaScript caller or a cast. Before `BEGIN`, so nothing is locked or written.
  if (!o.requireExpired && typeof o.authorize !== 'function') {
    throw new Error(
      `closeLiveDrop(${reason}) was asked to close a drop that need not be expired, with no ` +
        'authorize hook. A close that is neither past its deadline nor authorised would refund ' +
        'a live drop on nobody\'s authority.',
    )
  }

  try {
    await client.query('BEGIN')

    // Lock order is ALWAYS custody_controls → drop row. `claims.ts` and
    // `drops.ts` take the same two locks in the same order; reversing them here
    // would deadlock against every claimant.
    try {
      await lockControls(client)
    } catch (err) {
      await client.query('ROLLBACK')
      if (err instanceof PausedError) {
        await alerts.notify('paused', { stage, message: err.message })
        return { outcome: 'deferred', cause: 'paused', error: err }
      }
      if (err instanceof StaleReconciliationError) {
        await alerts.notify('stale_reconciliation', { stage, message: err.message })
        return { outcome: 'deferred', cause: 'stale_reconciliation', error: err }
      }
      throw err
    }

    const { rows } = await client.query<ClosableDropRow>(
      `SELECT id, public_id, state, claim_count, amount_each_luna, refund_address,
              (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM drops WHERE id = $1 FOR UPDATE`,
      [dropId],
    )
    const drop = rows[0]
    // Re-read under the lock. A claim may have taken the last slot and closed
    // the drop as `exhausted` while this caller was waiting for the lock — in
    // which case there is nothing unallocated and nothing to do. The same
    // re-read is what makes a second close, from either caller, a no-op.
    if (!drop) {
      await client.query('ROLLBACK')
      return { outcome: 'skipped', reason: 'not_found', state: null }
    }
    if (drop.state !== 'live') {
      await client.query('ROLLBACK')
      return { outcome: 'skipped', reason: 'not_live', state: drop.state }
    }
    if (o.requireExpired && !drop.expired) {
      await client.query('ROLLBACK')
      return { outcome: 'skipped', reason: 'not_expired', state: drop.state }
    }

    // Authorization runs here and nowhere else: after both locks, after the
    // drop is known to be live, and before anything is written. It sees the
    // same locked row this transaction will refund to. Branching on
    // `requireExpired` rather than on the hook's presence is what makes the
    // "not expired and not authorised" path unreachable.
    if (!o.requireExpired) await o.authorize(client, drop)

    const { rows: counted } = await client.query<{ reserved: number }>(
      'SELECT count(*)::int AS reserved FROM claims WHERE drop_id = $1',
      [dropId],
    )
    const reservedClaims = counted[0].reserved
    // THE refund amount. Counted inside the locked transaction, from the row
    // this transaction holds: every slot nobody reserved, and not one that
    // somebody did. `Math.max` is belt and braces — the claims table cannot
    // hold more rows than `claim_count`, because `reserveClaim` refuses at the
    // ceiling under this same lock — but a negative multiplier here would be an
    // invented refund, so it is not left to that argument alone.
    const unclaimed = Math.max(0, drop.claim_count - reservedClaims)
    const unallocatedLuna = BigInt(unclaimed) * BigInt(drop.amount_each_luna)

    if (unallocatedLuna > 0n && !drop.refund_address) {
      // A live drop always has the verified funding sender recorded, so this is
      // a corrupted invariant, not a routine case. Do not close it into a state
      // where the money has nowhere to go: hand it to a human.
      await client.query(`UPDATE drops SET state = 'manual_review' WHERE id = $1`, [dropId])
      await client.query('COMMIT')
      await alerts.notify('manual_review', {
        stage,
        dropId,
        reason: 'missing_refund_address',
        unallocatedLuna: unallocatedLuna.toString(),
      })
      return { outcome: 'skipped', reason: 'missing_refund_address', state: 'manual_review' }
    }

    await client.query(`UPDATE drops SET state = 'closing', closing_reason = $2 WHERE id = $1`, [
      dropId,
      reason,
    ])

    if (unallocatedLuna > 0n) {
      // `ON CONFLICT DO NOTHING` covers BOTH unique paths (`idempotency_key`
      // and the `one_refund_per_drop` partial index) without naming either:
      // a second refund must be an impossible no-op, never an aborted close.
      //
      // The recipient is `refund_address` off the locked row — the sender of the
      // verified funding transaction, written once by `activate()` and never
      // again. No caller of this function can nominate an address.
      await client.query(
        `INSERT INTO outgoing_transfers (
           idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
         ) VALUES ($1, 'refund', $2, NULL, $3, $4, 'queued')
         ON CONFLICT DO NOTHING`,
        [`refund:${dropId}`, dropId, drop.refund_address, unallocatedLuna.toString()],
      )
    }

    await client.query('COMMIT')
    logInfo('drop_closed', {
      dropId,
      reason,
      reservedClaims,
      unclaimedSlots: unclaimed,
      refundLuna: unallocatedLuna.toString(),
    })
    return { outcome: 'closed', reservedClaims, unclaimedSlots: unclaimed, refundLuna: unallocatedLuna }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/**
 * Move `closing` drops whose every liability is finalized to their terminal
 * state (design §9 step 6): `refunded` if a refund intent exists, `settled` if
 * none was due.
 *
 * Requires, for every intent the drop owns, BOTH the intent row `confirmed` AND
 * a `confirmed` on-chain attempt behind it — the same "finalized" definition
 * `solvency.ts` uses, so a drop's principal and its payouts leave the
 * outstanding-liability sum together and settlement can never change the
 * solvency picture. An intent in `manual_review` fails the predicate, which is
 * exactly design §9's rule that the drop stays non-terminal around stuck money.
 *
 * Takes only the drop row lock and acquires nothing after it, so it cannot form
 * a cycle with the `custody_controls` → drop order taken everywhere else.
 */
export async function settleTerminal(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH ready AS (
       SELECT d.id,
              EXISTS (
                SELECT 1 FROM outgoing_transfers r
                WHERE r.drop_id = d.id AND r.purpose = 'refund'
              ) AS has_refund
       FROM drops d
       WHERE d.state = 'closing'
         AND EXISTS (SELECT 1 FROM outgoing_transfers t WHERE t.drop_id = d.id)
         AND NOT EXISTS (
           SELECT 1 FROM outgoing_transfers t
           WHERE t.drop_id = d.id
             AND (
               t.state <> 'confirmed'
               OR NOT EXISTS (
                 SELECT 1 FROM transaction_attempts a
                 WHERE a.transfer_id = t.id AND a.state = 'confirmed'
               )
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM claims c WHERE c.drop_id = d.id AND c.state <> 'paid'
         )
       FOR UPDATE
     )
     UPDATE drops
     SET state = CASE WHEN ready.has_refund THEN 'refunded' ELSE 'settled' END
     FROM ready
     WHERE drops.id = ready.id`,
  )
  return rowCount ?? 0
}

/**
 * Garbage-collect drafts that were never funded (design §6.1
 * `awaiting_funding → cancelled`).
 *
 * The three guards are the whole safety argument: state is still
 * `awaiting_funding`, no funding hash was ever recorded, and no activation
 * height exists. A drop that fails any of them may have money against it, and
 * "an unfunded draft may be deleted after 24 hours; that is garbage collection,
 * not a refund" (design §7).
 */
export async function gcDrafts(pool: Pool, afterHours = DRAFT_GC_AFTER_HOURS): Promise<number> {
  const { rowCount } = await pool.query(
    // The reservation is cleared with the state: `cancelled` already leaves
    // `reservedPrincipalLuna`, and a collected draft holding a live-looking
    // promise would only mislead whoever reads the row next.
    `UPDATE drops
     SET state = 'cancelled', funding_reservation_expires_at = NULL
     WHERE state = 'awaiting_funding'
       AND funding_tx_hash IS NULL
       AND activated_height IS NULL
       AND created_at <= now() - make_interval(hours => $1)`,
    [afterHours],
  )
  return rowCount ?? 0
}
