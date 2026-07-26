import type { Pool, PoolClient } from 'pg'
import { errorMessage } from '../config'
import { logInfo, logWarn } from '../http/redact'
import type { Alerts } from './alerts'
import { PausedError, StaleReconciliationError, lockControls } from './solvency'

/**
 * Expiry, exact refunds, settlement and draft garbage collection (design §9,
 * §6.1).
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
 */

/** Design §6.1: an unfunded draft may be collected after this long. */
export const DRAFT_GC_AFTER_HOURS = 24

/** Upper bound on drops closed per sweep, so one tick stays short. */
export const SWEEP_BATCH = 50

interface ExpiringDropRow {
  id: string
  public_id: string
  state: string
  claim_count: number
  amount_each_luna: string
  refund_address: string | null
  expired: boolean
}

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
      const outcome = await closeExpiredDrop(client, alerts, candidate.id)
      if (outcome === 'closed') closed++
      if (outcome === 'deferred') return closed
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

type CloseOutcome = 'closed' | 'skipped' | 'deferred'

async function closeExpiredDrop(
  client: PoolClient,
  alerts: Alerts,
  dropId: string,
): Promise<CloseOutcome> {
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
        await alerts.notify('paused', { stage: 'expiry_sweep', message: err.message })
        return 'deferred'
      }
      if (err instanceof StaleReconciliationError) {
        await alerts.notify('stale_reconciliation', {
          stage: 'expiry_sweep',
          message: err.message,
        })
        return 'deferred'
      }
      throw err
    }

    const { rows } = await client.query<ExpiringDropRow>(
      `SELECT id, public_id, state, claim_count, amount_each_luna, refund_address,
              (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM drops WHERE id = $1 FOR UPDATE`,
      [dropId],
    )
    const drop = rows[0]
    // Re-read under the lock. A claim may have taken the last slot and closed
    // the drop as `exhausted` while this sweep was waiting for the lock — in
    // which case there is nothing unallocated and nothing to do.
    if (!drop || drop.state !== 'live' || !drop.expired) {
      await client.query('ROLLBACK')
      return 'skipped'
    }

    const { rows: counted } = await client.query<{ reserved: number }>(
      'SELECT count(*)::int AS reserved FROM claims WHERE drop_id = $1',
      [dropId],
    )
    const unclaimed = drop.claim_count - counted[0].reserved
    const unallocatedLuna = BigInt(Math.max(0, unclaimed)) * BigInt(drop.amount_each_luna)

    if (unallocatedLuna > 0n && !drop.refund_address) {
      // A live drop always has the verified funding sender recorded, so this is
      // a corrupted invariant, not a routine case. Do not close it into a state
      // where the money has nowhere to go: hand it to a human.
      await client.query(`UPDATE drops SET state = 'manual_review' WHERE id = $1`, [dropId])
      await client.query('COMMIT')
      await alerts.notify('manual_review', {
        stage: 'expiry_sweep',
        dropId,
        reason: 'missing_refund_address',
        unallocatedLuna: unallocatedLuna.toString(),
      })
      return 'skipped'
    }

    await client.query(
      `UPDATE drops SET state = 'closing', closing_reason = 'expired' WHERE id = $1`,
      [dropId],
    )

    if (unallocatedLuna > 0n) {
      // `ON CONFLICT DO NOTHING` covers BOTH unique paths (`idempotency_key`
      // and the `one_refund_per_drop` partial index) without naming either:
      // a second refund must be an impossible no-op, never an aborted sweep.
      await client.query(
        `INSERT INTO outgoing_transfers (
           idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state
         ) VALUES ($1, 'refund', $2, NULL, $3, $4, 'queued')
         ON CONFLICT DO NOTHING`,
        [`refund:${dropId}`, dropId, drop.refund_address, unallocatedLuna.toString()],
      )
    }

    await client.query('COMMIT')
    logInfo('drop_expired', {
      dropId,
      unclaimedSlots: Math.max(0, unclaimed),
      refundLuna: unallocatedLuna.toString(),
    })
    return 'closed'
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
