import type { Pool, PoolClient } from 'pg'
import type { ChainClient } from '../chain/types'
import { type NetworkName, validityWindowBlocks } from '../config'
import type { Queryable } from '../db/pool'
import { logWarn } from '../http/redact'
import { type Alerts, consoleAlerts } from './alerts'

/**
 * Solvency invariant and custody runtime controls (design §10.2, §10.3).
 *
 * Every money-moving path — funding activation, claim allocation, and each
 * outgoing signature — must run inside ONE database transaction that starts by
 * calling `lockControls`. The mandated lock order is ALWAYS
 * `custody_controls` → drop row; taking them in the other order deadlocks.
 *
 * Since the G1 review review the invariant runs on a LEDGER-DERIVED balance
 * (`ledgerBalanceLuna`: operator float + accepted finalized funding − finalized
 * outgoing principal − recorded fees), not on the chain's head-state balance.
 * The chain balance is still fetched every `reconcile()`, but only as a
 * cross-check that pauses custody when the chain holds LESS than the books
 * claim. Books decide what may be spent; the chain decides whether the books
 * are still true.
 *
 * All amounts are BIGINT luna. `db/pool.ts` keeps int8 as a string on the wire,
 * so every value read here is parsed with `BigInt(...)` at this boundary and a
 * JS `number` never touches money.
 */

/** Reconciliation older than this is not trustworthy enough to move money. */
export const RECONCILIATION_MAX_AGE_MS = 10 * 60 * 1000

export class SolvencyError extends Error {}

/** Operator pause switch is engaged: fail closed on every new money path. */
export class PausedError extends SolvencyError {
  constructor(message = 'custody is paused') {
    super(message)
  }
}

/** Custody balance has not been reconciled recently enough to be trusted. */
export class StaleReconciliationError extends SolvencyError {}

/** Ledger balance cannot cover outstanding principal plus the fee reserve. */
export class InsolventError extends SolvencyError {}

/**
 * A reconciliation observed the chain holding LESS than the books claim, and no
 * reconciliation has succeeded since (round-2 review N3).
 *
 * Deliberately a subclass of {@link InsolventError}: every existing handler —
 * the worker's deferral path, the HTTP 503 mapping — already treats an
 * insolvency as "money is owed and we will not sign for it", which is exactly
 * the right behaviour here. What the distinct type adds is an operator-facing
 * name for a condition `unpause` cannot clear.
 */
export class UnreconciledShortfallError extends InsolventError {}

/**
 * An attempt was handed to the network — or may have been — and nobody has been
 * able to say whether the chain took the money (round-4 review S3).
 *
 * `broadcast_attempted_at` is committed BEFORE `chain.broadcast` is called, so a
 * process killed in between leaves a row that claims a broadcast was attempted
 * for bytes that never left. Until the hash is looked up, custody's true balance
 * is unknown by up to that attempt's principal plus its fee — so this is not
 * "money in flight" and it is certainly not an explanation for a chain balance
 * below the books. It is an OPEN QUESTION, and no new signature may be taken
 * against a balance nobody can pin down.
 *
 * Cleared by an answer, never by time: either the chain shows the hash (the
 * attempt becomes `broadcast` — see {@link resolveIndeterminateBroadcasts},
 * which every `reconcile()` runs) or an operator proves it dead and replaces it
 * (`recover.ts replace`, which makes it `proven_dead`).
 *
 * A subclass of {@link InsolventError} for the same reason
 * {@link UnreconciledShortfallError} is: every existing handler already treats
 * that as "we will not sign for this", which is exactly right here.
 */
export class IndeterminateBroadcastError extends InsolventError {}

/** The requested addition would push live principal past `max_live_principal_luna`. */
export class CapExceededError extends SolvencyError {}

export interface Controls {
  paused: boolean
  maxLivePrincipalLuna: bigint
  configuredFeeReserveLuna: bigint
  /**
   * Operator-attested custody money that is not any drop's funding — the
   * pre-funded float the fee reserve is spent out of. The ONLY ledger credit
   * the drops themselves cannot supply (see 004 migration, finding 4).
   */
  operatorFloatLuna: bigint
  lastReconciledHeight: number | null
  lastReconciledAt: Date | null
  /**
   * Chain balance observed at the last `reconcile()`. A CROSS-CHECK ONLY since
   * finding 4: it is head-state, so it can include credits a reorg later takes
   * away. The invariant runs on `ledgerBalanceLuna` instead. `null` before the
   * first successful `reconcile()`.
   */
  reconciledConfirmedBalanceLuna: bigint | null
  /** `null` until the first boot stamps it (finding 6). */
  network: NetworkName | null
  /**
   * When `reconcile()` last saw the chain below the ledger, `null` once a
   * reconciliation has succeeded since (N3). While this is set every money path
   * fails closed with {@link UnreconciledShortfallError}, and `unpause` does
   * NOT clear it — only a clean reconcile does.
   */
  shortfallDetectedAt: Date | null
}

interface ControlsRow {
  paused: boolean
  max_live_principal_luna: string
  configured_fee_reserve_luna: string
  operator_float_luna: string
  last_reconciled_height: string | null
  last_reconciled_at: Date | null
  reconciled_confirmed_balance_luna: string | null
  network: NetworkName | null
  shortfall_detected_at: Date | null
  stale: boolean
}

function toControls(row: ControlsRow): Controls {
  return {
    paused: row.paused,
    maxLivePrincipalLuna: BigInt(row.max_live_principal_luna),
    configuredFeeReserveLuna: BigInt(row.configured_fee_reserve_luna),
    operatorFloatLuna: BigInt(row.operator_float_luna),
    lastReconciledHeight: row.last_reconciled_height === null ? null : Number(row.last_reconciled_height),
    lastReconciledAt: row.last_reconciled_at,
    reconciledConfirmedBalanceLuna:
      row.reconciled_confirmed_balance_luna === null
        ? null
        : BigInt(row.reconciled_confirmed_balance_luna),
    network: row.network,
    shortfallDetectedAt: row.shortfall_detected_at,
  }
}

const SELECT_CONTROLS = `
  SELECT paused,
         max_live_principal_luna,
         configured_fee_reserve_luna,
         operator_float_luna,
         last_reconciled_height,
         last_reconciled_at,
         reconciled_confirmed_balance_luna,
         network,
         shortfall_detected_at,
         (last_reconciled_at IS NULL
          OR now() - last_reconciled_at > make_interval(secs => $1::float8 / 1000)) AS stale
  FROM custody_controls
  WHERE singleton
`

/**
 * Take the singleton custody lock and return the controls.
 *
 * MUST be called inside an explicit transaction (`BEGIN` already issued):
 * `FOR UPDATE` outside one is released immediately and serializes nothing.
 * This is the single choke point that makes two concurrent activations or
 * allocations impossible to both pass a cap that only fits one.
 *
 * Fails closed: `PausedError` when the operator switch is on,
 * `StaleReconciliationError` when the reconciled balance is older than
 * `RECONCILIATION_MAX_AGE_MS` (or has never been taken). Recovery paths that
 * must run while paused or stale — `reconcile()` and `pause()` — deliberately
 * do NOT go through here, otherwise the system could never unstick itself.
 */
export async function lockControls(client: PoolClient): Promise<Controls> {
  const { rows } = await client.query<ControlsRow>(`${SELECT_CONTROLS} FOR UPDATE`, [
    RECONCILIATION_MAX_AGE_MS,
  ])
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')
  if (row.paused) throw new PausedError()
  if (row.stale) {
    throw new StaleReconciliationError(
      row.last_reconciled_at === null
        ? 'custody balance has never been reconciled'
        : `custody balance last reconciled at ${row.last_reconciled_at.toISOString()}`,
    )
  }
  return toControls(row)
}

/** Read the controls without locking. Reporting and health checks only. */
export async function readControls(db: Queryable): Promise<Controls> {
  const { rows } = await db.query<ControlsRow>(SELECT_CONTROLS, [RECONCILIATION_MAX_AGE_MS])
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')
  return toControls(row)
}

/**
 * Outstanding customer principal, per design §10.2:
 *
 *     sum(all accepted finalized funding principal)
 *   - sum(all finalized outgoing payout/refund principal)
 *
 * Deliberately NOT derived from claim/refund rows: a fully unclaimed live drop
 * still owes its entire principal to future claimants or to its creator, so the
 * funding side is `expected_funding_luna` of every drop whose funding was
 * accepted and finalized (`activated_height IS NOT NULL`) and which has not yet
 * reached a terminal state.
 *
 * The outgoing side subtracts only FINALIZED principal, and only for drops in
 * that same set, so a drop's funding and its payouts leave the sum together
 * when it settles. "Finalized" requires both the intent row to be `confirmed`
 * AND a `confirmed` on-chain attempt: `broadcast` is not `paid`, and principal
 * sent in an unconfirmed attempt stays outstanding until that attempt
 * finalizes. Both conditions err toward over-reporting liability, which is the
 * safe direction for a solvency check.
 *
 * Network fees are excluded on purpose — the operator pre-funds them
 * separately, and they are covered by `configured_fee_reserve_luna`.
 */
export async function outstandingPrincipalLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ outstanding_luna: string }>(`
    WITH open_drops AS (
      SELECT id, expected_funding_luna
      FROM drops
      WHERE activated_height IS NOT NULL
        AND state NOT IN ('settled', 'refunded', 'cancelled')
    ),
    finalized_out AS (
      SELECT t.amount_luna
      FROM outgoing_transfers t
      JOIN open_drops d ON d.id = t.drop_id
      WHERE t.state = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM transaction_attempts a
          WHERE a.transfer_id = t.id AND a.state = 'confirmed'
        )
    )
    SELECT (
      COALESCE((SELECT SUM(expected_funding_luna) FROM open_drops), 0)
      - COALESCE((SELECT SUM(amount_luna) FROM finalized_out), 0)
    )::BIGINT AS outstanding_luna
  `)
  return BigInt(rows[0].outstanding_luna)
}

/**
 * The custody balance the invariant is allowed to trust, derived from the
 * LEDGER rather than from the chain's head state (G1 review finding 4):
 *
 *     operator float
 *   + sum(accepted finalized funding)
 *   - sum(finalized outgoing principal)
 *   - sum(recorded fees on confirmed attempts)
 *
 * Why not the chain balance: `chain.confirmedBalanceLuna` answers about the
 * head, which includes credits that are not final and can be reorged away, and
 * credits that belong to nobody's drop. Spending either as capacity is spending
 * money that may not be there — the failure mode is a stranded campaign whose
 * claimants cannot be paid.
 *
 * Every term here is money this system verified for itself:
 *
 *  - funding counts only drops with `activated_height IS NOT NULL`, i.e. a
 *    transaction that passed every design §7 predicate AND our own finality
 *    depth. Terminal drops stay in the sum: their money entered custody and
 *    only the payout side removes it again.
 *  - outgoing counts only intents that are `confirmed` WITH a `confirmed`
 *    attempt — the same "finalized" definition `outstandingPrincipalLuna` uses,
 *    so in-flight payments are absent from BOTH sides and can never
 *    double-count against the invariant.
 *  - fees are real, already-spent custody money that no drop's principal
 *    covers; leaving them out would let the reserve drain invisibly.
 *
 * The operator float is the one term the drops cannot supply — see the 004
 * migration. It is an attestation, and `reconcile()`'s chain cross-check is
 * what catches an attestation that is too high.
 */
export async function ledgerMovementsLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ movements_luna: string }>(`
    WITH funded AS (
      SELECT COALESCE(SUM(expected_funding_luna), 0) AS luna
      FROM drops
      WHERE activated_height IS NOT NULL
    ),
    paid_out AS (
      SELECT COALESCE(SUM(t.amount_luna), 0) AS luna
      FROM outgoing_transfers t
      WHERE t.state = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM transaction_attempts a
          WHERE a.transfer_id = t.id AND a.state = 'confirmed'
        )
    ),
    fees AS (
      SELECT COALESCE(SUM(fee_luna), 0) AS luna
      FROM transaction_attempts
      WHERE state = 'confirmed'
    )
    SELECT (
      (SELECT luna FROM funded)
      - (SELECT luna FROM paid_out)
      - (SELECT luna FROM fees)
    )::BIGINT AS movements_luna
  `)
  return BigInt(rows[0].movements_luna)
}

/** `operator float + ledger movements`: the balance the invariant may spend. */
export async function ledgerBalanceLuna(db: Queryable, controls: Controls): Promise<bigint> {
  return controls.operatorFloatLuna + (await ledgerMovementsLuna(db))
}

/**
 * Observation an in-flight query is made against.
 *
 * `head` is the chain head the caller has just read; `windowBlocks` is the
 * validity window (`@internal` test-only override — production reads the
 * floored config).
 */
export interface InFlightOptions {
  windowBlocks?: number
}

/**
 * SQL predicate for "this attempt could still legitimately debit custody".
 *
 * Two halves, and both are about PROVABILITY rather than about elapsed time:
 *
 *  - the network acknowledged the bytes (`broadcast`) — see the round-4 note
 *    below for why an unresolved `signed` row no longer qualifies; and
 *  - the chain can still include them: `head <= validity_start_height +
 *    window`. This is the chain's own deadline, read from the height the
 *    attempt was signed against, which is why it is compared against a HEAD
 *    and not against wall-clock age (round-3 R4). A slow or stalled chain used
 *    to age a still-includable transaction out of the offset, and the payment
 *    it then failed to explain false-paused custody.
 *
 * **Round-4 S3 — `broadcast_attempted_at` is not evidence of anything having
 * been broadcast.** R4 added `(signed AND broadcast_attempted_at IS NOT NULL)`
 * to this predicate so that an ambiguous broadcast could explain the money the
 * chain had taken. But the marker is written BEFORE the network call and
 * committed on its own, so the state it actually names is "a broadcast was
 * about to be attempted". A process killed in that window — or a call that
 * never reached the socket — leaves a row that subtracts its full amount from
 * the explainable minimum for the rest of its validity window, on behalf of
 * bytes that never left. An unrelated custody deficit of exactly that size then
 * reconciles CLEAN.
 *
 * So the marker no longer buys an offset. It marks an INDETERMINATE attempt
 * (below), which `reconcile()` resolves by asking the chain for the hash before
 * the cross-check is computed: an attempt the chain can show is promoted to
 * `broadcast` and lands back in this predicate on its own merits. That
 * resolution is exact rather than approximate, because `confirmedBalanceLuna`
 * and `getTransaction` share one visibility horizon — the chain debits an
 * account when the transaction is INCLUDED, which is precisely when a lookup
 * can find it. An attempt sitting unseen in a mempool has not moved the balance
 * either, so it needs no offset.
 *
 * `$1` is the head, `$2` the window in blocks.
 */
const STILL_IN_FLIGHT = `
  a.state = 'broadcast'
  AND a.validity_start_height + $2::bigint >= $1::bigint
`

/**
 * SQL predicate for "a broadcast was attempted for this attempt and nobody
 * knows whether the chain took it" (round-4 S3). Alias `a`, no parameters.
 *
 * Deliberately independent of the validity window. An attempt past its deadline
 * that the chain has never shown us is *probably* dead, but "probably" is not
 * an answer, and the answer is cheap: look the hash up. Until something does,
 * this attempt is a question mark over custody's balance and
 * {@link assertSolvent} refuses to sign against it.
 */
const INDETERMINATE_BROADCAST = `
  a.state = 'signed' AND a.broadcast_attempted_at IS NOT NULL
`

/**
 * Money that has been committed to leaving custody but is not yet finalized in
 * the ledger, and that can still plausibly explain a chain balance below the
 * books: an attempt whose bytes reached the network and that the chain can
 * still include, plus that attempt's fee.
 *
 * Used ONLY by the chain cross-check. The chain debits a payment the moment it
 * lands, while the ledger waits for our own finality depth, so during that
 * window the chain legitimately shows LESS than the books do. Without this term
 * every in-flight payout would look like a shortfall and pause custody.
 *
 * Two exclusions, both from round-2 review N1. The offset used to cover every
 * `signed`/`broadcast` attempt with no bound at all, which turned it into a
 * permanent alibi: ONE stale attempt sitting open forever subtracted its amount
 * from the cross-check for as long as it existed, so a real custody shortfall
 * of the same size never showed up.
 *
 *  - **Never handed to the network.** The bytes never left this process, so the
 *    chain cannot possibly have debited them. Counting them as an explanation
 *    for missing money is counting a payment that was never made.
 *  - **Past the validity window.** Past its deadline a transaction is
 *    unincludable, so custody will never be debited for it either.
 *
 * Round-3 R4 fixed how the first exclusion was MEASURED. It keyed on the
 * attempt's state, and `signed` covers two different facts: bytes that were
 * never broadcast, and bytes whose broadcast outcome is unknown because the
 * call threw or the process died between the network accepting them and
 * `markBroadcast` committing. The second kind really can have debited custody.
 * `broadcast_attempted_at` (migration 010) records which is which, written
 * before the call so a crash cannot lose it.
 *
 * Anything excluded here is money the books think is leaving and the chain will
 * never take. That is an operator condition in its own right — see
 * {@link staleInFlightOutgoing}, which `reconcile()` alerts on.
 */
export async function inFlightOutgoingLuna(
  db: Queryable,
  head: number,
  opts?: InFlightOptions,
): Promise<bigint> {
  const { rows } = await db.query<{ in_flight_luna: string }>(
    `SELECT COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS in_flight_luna
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE ${STILL_IN_FLIGHT}`,
    [head.toString(), (opts?.windowBlocks ?? validityWindowBlocks()).toString()],
  )
  return BigInt(rows[0].in_flight_luna)
}

export interface StaleInFlight {
  /** Open attempts that no longer offset the cross-check. */
  count: number
  /** Their principal plus fees — money the books expect to leave and the chain will not take. */
  lunaTotal: bigint
  /** Never handed to the network at all: `signed`, with no recorded broadcast attempt. */
  neverBroadcastCount: number
}

/**
 * Open attempts that {@link inFlightOutgoingLuna} deliberately refuses to count
 * (N1). Non-empty means an intent is stuck in a state only a human resolves:
 * either the worker never got its bytes out, or they aged out of the chain's
 * validity window without landing.
 */
export async function staleInFlightOutgoing(
  db: Queryable,
  head: number,
  opts?: InFlightOptions,
): Promise<StaleInFlight> {
  const { rows } = await db.query<{
    n: number
    luna_total: string
    never_broadcast: number
  }>(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS luna_total,
            count(*) FILTER (
              WHERE a.state = 'signed' AND a.broadcast_attempted_at IS NULL
            )::int AS never_broadcast
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE a.state IN ('signed', 'broadcast')
       AND NOT (${STILL_IN_FLIGHT})
       AND NOT (${INDETERMINATE_BROADCAST})`,
    [head.toString(), (opts?.windowBlocks ?? validityWindowBlocks()).toString()],
  )
  return {
    count: rows[0].n,
    lunaTotal: BigInt(rows[0].luna_total),
    neverBroadcastCount: rows[0].never_broadcast,
  }
}

export interface IndeterminateBroadcasts {
  /** Attempts whose broadcast outcome is unknown. */
  count: number
  /** Their principal plus fees: the width of the uncertainty about custody's balance. */
  lunaTotal: bigint
}

/**
 * Attempts a broadcast was attempted for whose outcome nobody knows (S3).
 *
 * Reported by `reconcile()`, and — more importantly — checked by
 * {@link assertSolvent}, which refuses to add any new liability while one
 * exists. They are deliberately NOT in {@link staleInFlightOutgoing}: "the
 * chain will never take this" and "we have not asked" are different operator
 * conditions with different fixes.
 */
export async function indeterminateBroadcasts(db: Queryable): Promise<IndeterminateBroadcasts> {
  const { rows } = await db.query<{ n: number; luna_total: string }>(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS luna_total
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE ${INDETERMINATE_BROADCAST}`,
  )
  return { count: rows[0].n, lunaTotal: BigInt(rows[0].luna_total) }
}

/**
 * Ask the chain about every indeterminate attempt and settle the ones it can
 * answer for (S3). Called by `reconcile()` before the cross-check is computed,
 * so the cross-check never has to guess.
 *
 * An attempt the chain can show is promoted `signed` → `broadcast`: that is a
 * statement of observed fact, not a money movement, and it is the state the
 * rest of the system already knows how to reason about. Nothing else is
 * decided here — finality, confirmation and the claim's own state belong to
 * `transfers.progressAttempt`, which will see the row on its next pass. The
 * absence series is cleared for the same reason it is cleared there: a sighting
 * refutes it, and stale absence evidence is what lets `recover.ts replace`
 * build a second payment (round-3 R1).
 *
 * The lookup is made INSIDE the attempt's row lock, exactly as `progressLocked`
 * does, so a sighting cannot be discarded while `replace` reads a series this
 * pass was about to clear.
 *
 * LOCK ORDER: this takes only the attempt row, and takes it in its own
 * transaction that ends before `writeReconciliation` reaches for
 * `custody_controls`. The mandated order `custody_controls → drop →
 * attempt/transfer` is therefore never inverted — nothing here holds an attempt
 * lock while asking for anything above it.
 *
 * Failures are not fatal: an unreachable node leaves the attempt indeterminate,
 * which is the fail-closed state it was already in.
 */
export async function resolveIndeterminateBroadcasts(
  pool: Pool,
  chain: ChainClient,
): Promise<{ scanned: number; promoted: number }> {
  const { rows } = await pool.query<{ id: string; tx_hash: string }>(
    `SELECT a.id, a.tx_hash
     FROM transaction_attempts a
     WHERE ${INDETERMINATE_BROADCAST}
     ORDER BY a.created_at`,
  )
  let promoted = 0
  for (const row of rows) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query<{ state: string }>(
        'SELECT state FROM transaction_attempts WHERE id = $1 FOR UPDATE',
        [row.id],
      )
      // Resolved by another pass while we waited for the lock.
      if (locked.rows[0]?.state !== 'signed') {
        await client.query('ROLLBACK')
        continue
      }
      const tx = await chain.getTransaction(row.tx_hash)
      if (tx === null) {
        // "The chain does not have it" is not an answer either — it is
        // mempool-blind (G0 §5A). No absence is recorded here: the absence
        // SERIES is `progressAttempt`'s evidence chain for `proven_dead`, and
        // reconciliation must not accelerate a replacement.
        await client.query('ROLLBACK')
        continue
      }
      await client.query(
        `UPDATE transaction_attempts
         SET state = 'broadcast', last_error = NULL, absent_checks = 0, first_absent_at = NULL
         WHERE id = $1 AND state = 'signed'`,
        [row.id],
      )
      await client.query('COMMIT')
      promoted += 1
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      logWarn('indeterminate_broadcast_unresolved', {
        attemptId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      client.release()
    }
  }
  return { scanned: rows.length, promoted }
}

/**
 * Enforce both design §10.2 invariants before adding `addLuna` of new principal
 * (a funding activation passes the drop's expected funding; allocation and
 * outgoing signatures pass `0n`, since that principal is already outstanding):
 *
 *   ledger balance + addLuna        >= outstanding principal + addLuna + fee reserve
 *   outstanding principal + addLuna <= max_live_principal_luna
 *
 * `addLuna` appears in the balance requirement because of G1 review finding 3:
 * checking only `balance >= outstanding + reserve` let an activation pass while
 * leaving the POST-activation state short — the new principal became a
 * liability that the balance was never asked to cover. It also appears on the
 * available side, because a ledger balance credits accepted funding at the same
 * instant it becomes a liability: the drop's funding transaction is verified
 * and final before `activate()` runs, and `activated_height` is stamped in the
 * very transaction this check guards. Writing both terms out is deliberate —
 * they cancel to `ledger >= outstanding + reserve`, and that cancellation IS
 * the structural reason finding 3 cannot recur under a ledger-derived balance.
 * Under the old head-state chain balance they did not cancel, which is exactly
 * how the gap appeared.
 *
 * `controls` must come from `lockControls` on the SAME client/transaction —
 * the lock is what stops two callers from each passing a cap that fits one.
 */
export async function assertSolvent(
  client: Queryable,
  controls: Controls,
  addLuna: bigint,
): Promise<void> {
  if (addLuna < 0n) throw new SolvencyError('addLuna must be non-negative')

  // The chain cross-check must have run at least once. The invariant no longer
  // spends this number, but a system that has never compared its books against
  // the chain has no business creating new liabilities.
  if (controls.reconciledConfirmedBalanceLuna === null) {
    throw new StaleReconciliationError('custody balance has never been reconciled')
  }

  // N3: a reconciliation saw the chain below the books and no reconciliation
  // has succeeded since. `paused` may well have been cleared by an operator —
  // that is permission to resume, not evidence that custody holds the money.
  // Only a clean `reconcile()` clears this, which forces the right order:
  // re-establish that the books are true, THEN sign against them.
  if (controls.shortfallDetectedAt !== null) {
    throw new UnreconciledShortfallError(
      `custody was observed holding less than the ledger at ` +
        `${controls.shortfallDetectedAt.toISOString()} and no reconciliation has succeeded since. ` +
        'Unpausing does not clear this: a clean reconcile must.',
    )
  }

  // S3: a broadcast was attempted for some attempt and nobody knows whether the
  // chain took the money. Custody's real balance is unknown by up to that
  // amount, so there is no number here to check anything against. This blocks
  // every new liability — a signature, an activation, an allocation — until the
  // hash is resolved, which the next `reconcile()` (or the worker's next pass
  // over the attempt) does automatically.
  const indeterminate = await indeterminateBroadcasts(client)
  if (indeterminate.count > 0) {
    throw new IndeterminateBroadcastError(
      `${indeterminate.count} attempt(s) worth ${indeterminate.lunaTotal} luna had a broadcast ` +
        'attempted whose outcome is still unknown, so custody’s balance cannot be pinned down. ' +
        'Refusing to add new liability until the chain is asked for those hashes.',
    )
  }

  const outstanding = await outstandingPrincipalLuna(client)
  const ledger = await ledgerBalanceLuna(client, controls)

  const available = ledger + addLuna
  const required = outstanding + addLuna + controls.configuredFeeReserveLuna
  if (available < required) {
    throw new InsolventError(
      `ledger balance ${ledger} (operator float ${controls.operatorFloatLuna}) < outstanding principal ` +
        `${outstanding} + added ${addLuna} + fee reserve ${controls.configuredFeeReserveLuna}`,
    )
  }

  const projected = outstanding + addLuna
  if (projected > controls.maxLivePrincipalLuna) {
    throw new CapExceededError(
      `projected live principal ${projected} exceeds cap ${controls.maxLivePrincipalLuna}`,
    )
  }
}

/**
 * How far the chain may sit below the books before custody is paused. Zero for
 * now: the ledger only counts finalized movements and the in-flight term below
 * already explains every legitimate difference, so any shortfall is real.
 */
export const CROSS_CHECK_EPSILON_LUNA = 0n

/**
 * Refresh the chain cross-check and the reconciliation timestamp (design §10.3:
 * startup and periodic reconciliation).
 *
 * Since G1 review finding 4 this no longer feeds the invariant — it AUDITS it.
 * The chain balance is stored, then compared against the smallest balance the
 * books can explain (`ledger − in-flight outgoing`). Custody having MORE than
 * the books say is normal and harmless (an operator top-up, a stray deposit,
 * a not-yet-activated funding transaction); custody having LESS means either
 * money left without a ledger entry or a credit the books trusted was reorged
 * away. Neither is survivable by carrying on, so it pauses and pages.
 *
 * Chain reads happen outside any transaction, then one UPDATE stamps the row.
 * This intentionally bypasses `lockControls`: reconciliation is exactly the
 * operation that must still work while the system is paused or stale.
 *
 * The three database reads run inside ONE `REPEATABLE READ, READ ONLY` snapshot
 * (round-2 review N4). Taken in autocommit they came from three different
 * instants, and a confirmation committing between the ledger read and the
 * in-flight read produced a pair that no single instant could have produced —
 * a payout still counted as unpaid by the ledger AND already gone from the
 * in-flight offset. That difference is not a shortfall, it is a seam, and it
 * false-paused custody. One snapshot, one instant, no seam. READ ONLY makes
 * that structural, and no lock is taken: reconciliation must never block a
 * payout it is trying to account for.
 */
export interface ReconcileOptions extends InFlightOptions {
  /**
   * TEST SEAM (R3): awaited once the observation is complete, immediately
   * BEFORE the write. It is the stall that makes the interleaving reachable,
   * and nothing in production passes it.
   * @internal
   */
  onObserved?: () => Promise<void>
}

export interface ReconcileResult {
  /** The chain held less than the books could explain at this observation. */
  short: boolean
  /** Whether this observation was newer than the recorded one and therefore stamped. */
  accepted: boolean
  height: number
  observationSeq: bigint
  /** Indeterminate attempts this pass asked the chain about, and how many it settled. */
  resolved: { scanned: number; promoted: number }
}

export async function reconcile(
  pool: Pool,
  chain: ChainClient,
  alerts?: Alerts,
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  // ROUND-4 S2 — the generation is drawn BEFORE anything is observed.
  //
  // R3 drew it after the observation completed, reasoning that this orders
  // passes by when they finished LOOKING. The reasoning was right and the
  // placement was still wrong, because "finished looking" is not an instant the
  // process can name: between the last read and the `nextval` there is a gap,
  // and a pass that stalls in that gap collects a number issued after a pass
  // that observed later than it did. The exact interleaving:
  //
  //   1. pass A completes a CLEAN observation at height H and stalls before
  //      `nextval`;
  //   2. money leaves custody;
  //   3. pass B observes the shortfall at height H, takes generation 1, stamps
  //      the verdict and pauses;
  //   4. pass A wakes, takes generation 2 — newer than B's — and, being clean
  //      at the same height, clears the verdict B just stamped.
  //
  // Drawn first, the number orders passes by when they STARTED, which is a
  // moment each process actually controls. That is a weaker order (a pass can
  // start earlier and still observe fresher data), so it is paired below with
  // two guards that make the weakness harmless: a clean pass may only clear a
  // standing shortfall from a strictly HIGHER chain head, and a short
  // observation is stamped whatever its generation. Being wrongly ordered can
  // therefore only ever refuse to clear a verdict, never invent a clean one.
  const { rows: seqRows } = await pool.query<{ seq: string }>(
    "SELECT nextval('reconcile_observation_seq')::BIGINT AS seq",
  )
  const observationSeq = BigInt(seqRows[0].seq)

  const height = await chain.headHeight()
  const chainBalanceLuna = await chain.confirmedBalanceLuna(chain.custodyAddress())

  // ROUND-4 S3 — resolve indeterminate broadcasts, and do it AFTER the balance
  // read, never before.
  //
  // The order is the whole safety argument. If an attempt is included between
  // these two steps, the balance (older) does not show the debit and the offset
  // (newer) does: the explainable minimum comes out too LOW, which can only
  // make this pass more forgiving. Resolving first inverts that — the offset
  // would miss a debit the balance already shows, and an ordinary payment
  // would read as a shortfall and pause custody.
  const resolved = await resolveIndeterminateBroadcasts(pool, chain)

  const client = await pool.connect()
  let ledgerLuna: bigint
  let inFlightLuna: bigint
  let stale: StaleInFlight
  let unresolved: IndeterminateBroadcasts
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const controls = await readControls(client)
    ledgerLuna = await ledgerBalanceLuna(client, controls)
    inFlightLuna = await inFlightOutgoingLuna(client, height, opts)
    stale = await staleInFlightOutgoing(client, height, opts)
    unresolved = await indeterminateBroadcasts(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (opts?.onObserved) await opts.onObserved()

  const explainableMinimumLuna = ledgerLuna - inFlightLuna
  const short = chainBalanceLuna < explainableMinimumLuna - CROSS_CHECK_EPSILON_LUNA

  const accepted = await writeReconciliation(pool, {
    chainBalanceLuna,
    height,
    observationSeq,
    short,
  })

  const notify = alerts ?? consoleAlerts()

  if (short) {
    const detail = {
      stage: 'reconcile',
      reason: 'chain_below_ledger',
      chainBalanceLuna: chainBalanceLuna.toString(),
      ledgerBalanceLuna: ledgerLuna.toString(),
      inFlightOutgoingLuna: inFlightLuna.toString(),
      shortfallLuna: (explainableMinimumLuna - chainBalanceLuna).toString(),
      height,
    }
    // Unconditional, whatever this observation's generation: the shortfall
    // stamp itself is written by `writeReconciliation` outside the generation
    // guard, because a wrongly-ordered SHORT observation must still fail
    // closed. Only the cross-check NUMBERS are newest-wins.
    await pause(pool, `chain balance ${chainBalanceLuna} below ledger balance ${ledgerLuna}`)
    await notify.notify('insolvent', detail)
    if (!accepted) {
      // A newer observation already owns the recorded numbers. The verdict
      // still stands (it is the fail-closed one), but an operator should know
      // it was formed from a view something else has already superseded.
      await notify.notify('manual_review', {
        ...detail,
        reason: 'superseded_shortfall_observation',
        observationSeq: observationSeq.toString(),
      })
    }
  }

  // N1: attempts excluded from the offset above. Money the books have committed
  // to sending that the chain will never take — silent until now, because the
  // old unbounded offset made each one look like an ordinary payment in flight.
  if (stale.count > 0) {
    await notify.notify('manual_review', {
      stage: 'reconcile',
      reason: 'stale_in_flight_attempt',
      staleAttempts: stale.count,
      neverBroadcast: stale.neverBroadcastCount,
      lunaTotal: stale.lunaTotal.toString(),
      height,
    })
  }

  // S3: attempts we asked about and still cannot account for. Every money path
  // is closed while these exist (`assertSolvent`), so an operator has to see
  // them.
  if (unresolved.count > 0) {
    await notify.notify('manual_review', {
      stage: 'reconcile',
      reason: 'indeterminate_broadcast',
      indeterminateAttempts: unresolved.count,
      lunaTotal: unresolved.lunaTotal.toString(),
      scanned: resolved.scanned,
      promoted: resolved.promoted,
      height,
    })
  }

  return { short, accepted, height, observationSeq, resolved }
}

/**
 * Stamp the cross-check and the durable shortfall verdict — under the controls
 * lock, and only from an observation that is not out of date (R3, S2).
 *
 * Two statements, because the two facts have opposite failure directions.
 *
 *  1. **A shortfall is recorded unconditionally.** Whatever this observation's
 *     generation, if it saw the chain below the books then the chain WAS below
 *     the books at some point, and that is not a fact a later reading gets to
 *     un-see. `COALESCE` keeps the first sighting and its height across
 *     repeated failing passes. Making this conditional on the generation is
 *     what would turn S2's earlier `nextval` into a new hole: a short pass
 *     wrongly ordered behind a clean one would silently drop its verdict.
 *
 *  2. **The cross-check numbers are newest-wins, and only a strictly newer
 *     observation may CLEAR a standing shortfall.** Two guards on that:
 *
 *      - *Generation.* Refused unless strictly greater than the one on record,
 *        so a stalled pass cannot land its numbers on top of a later pass's.
 *      - *Shortfall height.* A clean pass may always refresh the numbers
 *        (refusing that would let a node lagging by a block stall activations
 *        on staleness), but it may only clear a standing shortfall from a
 *        STRICTLY HIGHER chain head. Round-3 allowed an equal head, which is
 *        wrong for the reason S2 names: money that left at height H is visible
 *        at height H, so a "healthy" reading of the same height is a reading
 *        taken before the debit — the two observations are not comparable and
 *        the older-looking one must not win. Strictly higher is the only
 *        comparison that proves the clean pass saw the chain AFTER whatever the
 *        shortfall pass saw.
 *
 * Head and balance are read back-to-back rather than atomically: the client
 * exposes `getHeadHeight()` and `getAccount()` as separate calls and has no
 * "balance as of height H" query, so there is no way to capture the pair in one
 * shot. The head is read FIRST, which makes the recorded height a LOWER bound
 * on the state the balance actually reflects — the conservative direction for
 * the strict-height rule, since it can only delay a clear, never permit one
 * that the chain does not support.
 *
 * Returns whether the OBSERVATION was accepted. `false` is not an error: a
 * newer pass has already stamped the row, so the freshness `lockControls`
 * demands is satisfied and the numbers on record are the better-informed ones.
 */
async function writeReconciliation(
  pool: Pool,
  o: { chainBalanceLuna: bigint; height: number; observationSeq: bigint; short: boolean },
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serializes two passes that would otherwise both read the recorded
    // generation, both decide they are newer, and both write.
    await client.query('SELECT 1 FROM custody_controls WHERE singleton FOR UPDATE')
    // (1) fail closed, whatever the generation says about who looked last.
    if (o.short) {
      await client.query(
        `UPDATE custody_controls
         SET shortfall_detected_at = COALESCE(shortfall_detected_at, now()),
             shortfall_observed_height = COALESCE(shortfall_observed_height, $1::bigint)
         WHERE singleton`,
        [o.height.toString()],
      )
    }
    // (2) the observation itself.
    const { rowCount } = await client.query(
      `UPDATE custody_controls
       SET reconciled_confirmed_balance_luna = $1,
           last_reconciled_height = $2,
           last_reconciled_at = now(),
           reconcile_observed_seq = $3,
           shortfall_detected_at = CASE
             WHEN $4::bool THEN COALESCE(shortfall_detected_at, now())
             WHEN shortfall_observed_height IS NOT NULL
                  AND $2::bigint > shortfall_observed_height THEN NULL
             ELSE shortfall_detected_at
           END,
           shortfall_observed_height = CASE
             WHEN $4::bool THEN COALESCE(shortfall_observed_height, $2::bigint)
             WHEN shortfall_observed_height IS NOT NULL
                  AND $2::bigint > shortfall_observed_height THEN NULL
             ELSE shortfall_observed_height
           END
       WHERE singleton
         AND $3::bigint > reconcile_observed_seq`,
      [o.chainBalanceLuna.toString(), o.height.toString(), o.observationSeq.toString(), o.short],
    )
    await client.query('COMMIT')
    if (rowCount === 0) {
      logWarn('reconcile_observation_superseded', {
        observationSeq: o.observationSeq.toString(),
        height: o.height,
        short: o.short,
      })
    }
    return rowCount !== 0
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** The database is bound to a different chain than this process is talking to. */
export class NetworkMismatchError extends Error {}

/**
 * An unbound database that already holds money history: the operator must say
 * which chain it belongs to before anything is stamped (round-2 review F6).
 */
export class NetworkBindingUnconfirmedError extends Error {}

/** Env var an operator sets to confirm the network of a pre-existing database. */
export const CONFIRM_NETWORK_ENV = 'NIMDROPS_CONFIRM_NETWORK'

/**
 * The database is bound to a different custody wallet than this process is
 * using (round-4 review S1).
 */
export class CustodyAddressMismatchError extends Error {}

/**
 * An unbound database that already holds money history: the operator must say
 * which wallet it belongs to before anything is stamped. Same shape, and the
 * same reasoning, as {@link NetworkBindingUnconfirmedError}.
 */
export class CustodyAddressBindingUnconfirmedError extends Error {}

/**
 * Env var an operator sets to confirm a custody address the database does not
 * already agree with — either because it has never been stamped on a database
 * that already holds payments, or because the wallet is being deliberately
 * ROTATED. Must equal the address this process is actually using.
 */
export const CONFIRM_CUSTODY_ADDRESS_ENV = 'NIMDROPS_CONFIRM_CUSTODY_ADDRESS'

/** What a booted process has proven about the database it is attached to. */
export interface ChainBinding {
  network: NetworkName
  custodyAddress: string
}

/**
 * Bind this database to a chain, or refuse to run (G1 review finding 6).
 *
 * Nothing in the schema used to say which network the money in it lives on. An
 * operator whose shell still had `NIMIQ_NETWORK=TestAlbatross` could point the
 * recovery CLI at the mainnet database and have it prove a mainnet payout
 * "absent" — by looking for it on testnet — and then sign a replacement. The
 * first boot stamps the network; every later boot and every chain-touching
 * recovery command calls this first and throws before any chain action.
 *
 * Deliberately not idempotent in the loose sense: the stamp is written once and
 * never updated. Moving a custody database between networks is not an operation
 * this system supports.
 *
 * **Round-2 F6.** "Stamp whatever the first process says" is only safe on a
 * database with no money in it. Migration 004 added the column NULL to
 * databases that already had a payment history, so the very deployment the
 * guard was written for — a live mainnet database, an operator with a stale
 * testnet shell — would have had its binding invented by the wrong process and
 * the guard would then have agreed with itself forever. So an unbound database
 * that ALREADY HAS attempt rows fails closed: the operator must state the
 * network in `NIMDROPS_CONFIRM_NETWORK`, and it must match what this process is
 * actually talking to. A genuinely fresh database (no attempts) still stamps on
 * first boot, because there is no history for a wrong guess to endanger.
 */
export async function ensureNetworkBinding(pool: Pool, chain: ChainClient): Promise<NetworkName> {
  return (await ensureChainBinding(pool, chain)).network
}

/**
 * Bind this database to a chain AND to a custody wallet, or refuse to run.
 *
 * The network half is {@link ensureNetworkBinding}'s original job (finding 6).
 * The address half is round-4 review S1, and it exists because the two processes
 * that need the custody address get it from different places and nothing
 * compared them:
 *
 *   * `index.ts` takes `CUSTODY_ADDRESS` from the environment — that string is
 *     what a sponsor is told to pay and what `submitFunding` checks
 *     `tx.recipient` against;
 *   * `worker.ts` DERIVES the address from `CUSTODY_PRIVATE_KEY_HEX` — that key
 *     is what every payout is signed with.
 *
 * A `CUSTODY_ADDRESS` that is a valid Nimiq address but not the worker's wallet
 * therefore passed every check at boot: the API published it, sponsors paid it,
 * `activate()` credited the deposits as custody capacity, and the worker could
 * never spend a luna of it. The database is now the single authority both
 * processes are measured against, so the two cannot disagree without one of
 * them refusing to start.
 *
 * The order is deliberate: the NETWORK is settled first. A process on the wrong
 * chain would be comparing addresses across chains, and "wrong network" is the
 * more fundamental thing to be told.
 *
 * Escape hatch, for a rotation that is genuinely intended: set
 * `NIMDROPS_CONFIRM_CUSTODY_ADDRESS` to the address this process is actually
 * using. It re-stamps the binding and logs it loudly. It is a deliberate
 * operator action because rotating custody strands every deposit still sitting
 * in the old wallet — the old key must be kept and the balance swept, and no
 * environment variable can do that for you.
 */
export async function ensureChainBinding(pool: Pool, chain: ChainClient): Promise<ChainBinding> {
  const network = await bindNetwork(pool, chain)
  const custodyAddress = await bindCustodyAddress(pool, chain)
  return { network, custodyAddress }
}

/**
 * Whether this database already holds payment history that a wrong binding
 * could endanger. Same probe the network binding uses (round-2 F6): a
 * transaction attempt is the mark of money this system has moved or tried to.
 */
async function hasPaymentHistory(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM transaction_attempts',
  )
  return rows[0].n
}

async function bindCustodyAddress(pool: Pool, chain: ChainClient): Promise<string> {
  const running = chain.custodyAddress()
  const { rows } = await pool.query<{ custody_address: string | null }>(
    'SELECT custody_address FROM custody_controls WHERE singleton',
  )
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')
  const confirmed = process.env[CONFIRM_CUSTODY_ADDRESS_ENV]?.trim()

  if (row.custody_address === null) {
    const attempts = await hasPaymentHistory(pool)
    if (attempts > 0 && confirmed !== running) {
      throw new CustodyAddressBindingUnconfirmedError(
        `this custody database has ${attempts} transaction attempt(s) but no recorded custody ` +
          `address, and this process is using ${running}. Refusing to stamp it: if that is not ` +
          'the wallet the money is actually in, every deposit here is unspendable and every ' +
          `payout is drawn on the wrong account. Confirm with ${CONFIRM_CUSTODY_ADDRESS_ENV}=` +
          `<address> (got ${confirmed ?? 'unset'}); it must match this process. Check one of the ` +
          'stored funding hashes on a block explorer and read off the recipient first.',
      )
    }
    // Conditional UPDATE: two processes booting at once must not disagree, and
    // the loser of the race re-reads rather than overwrites.
    const { rows: stamped } = await pool.query<{ custody_address: string }>(
      `UPDATE custody_controls SET custody_address = $1
       WHERE singleton AND custody_address IS NULL
       RETURNING custody_address`,
      [running],
    )
    if (stamped[0]) {
      logWarn('custody_address_bound', { custodyAddress: running })
      return stamped[0].custody_address
    }
    return bindCustodyAddress(pool, chain)
  }

  if (row.custody_address !== running) {
    if (confirmed === running) {
      await pool.query('UPDATE custody_controls SET custody_address = $1 WHERE singleton', [running])
      logWarn('custody_address_rotated', { from: row.custody_address, to: running })
      return running
    }
    throw new CustodyAddressMismatchError(
      `custody database is bound to ${row.custody_address} but this process is using ${running}. ` +
        'Refusing to start: the API publishes this address as funding instructions and the ' +
        'worker signs payouts from it, so two processes that disagree accept money into a ' +
        'wallet nothing can spend. If this is a deliberate rotation, set ' +
        `${CONFIRM_CUSTODY_ADDRESS_ENV}=${running} — and sweep the old wallet first.`,
    )
  }
  return row.custody_address
}

async function bindNetwork(pool: Pool, chain: ChainClient): Promise<NetworkName> {
  const running = chain.network()
  const { rows } = await pool.query<{ network: NetworkName | null }>(
    'SELECT network FROM custody_controls WHERE singleton',
  )
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')

  if (row.network === null) {
    const { rows: counted } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM transaction_attempts',
    )
    const attempts = counted[0].n
    if (attempts > 0) {
      const confirmed = process.env[CONFIRM_NETWORK_ENV]
      if (confirmed !== running) {
        throw new NetworkBindingUnconfirmedError(
          `this custody database has ${attempts} transaction attempt(s) but no recorded network, ` +
            `and this process is running against ${running}. Refusing to stamp it: if that guess ` +
            'is wrong, every payment in here can be proven "absent" on the wrong chain and paid ' +
            `again. Confirm the network the money actually lives on with ${CONFIRM_NETWORK_ENV}=` +
            `<TestAlbatross|MainAlbatross> (got ${confirmed ?? 'unset'}); it must match this ` +
            'process. Verify one of the stored tx hashes on a block explorer first.',
        )
      }
    }
    // Conditional UPDATE: two processes booting at once must not disagree, and
    // the loser of the race re-reads rather than overwrites.
    const { rows: stamped } = await pool.query<{ network: NetworkName }>(
      `UPDATE custody_controls SET network = $1 WHERE singleton AND network IS NULL
       RETURNING network`,
      [running],
    )
    if (stamped[0]) {
      logWarn('network_bound', { network: running })
      return stamped[0].network
    }
    return bindNetwork(pool, chain)
  }

  if (row.network !== running) {
    throw new NetworkMismatchError(
      `custody database is bound to ${row.network} but this process is running against ${running}. ` +
        'Refusing every chain action: a payout signed on the wrong network can pay twice.',
    )
  }
  return row.network
}

/**
 * Engage the operator pause switch. Fail-closed kill switch: after this every
 * `lockControls` caller throws `PausedError`, so no new activation, allocation,
 * or outgoing signature can start.
 *
 * The schema has no column for the reason (see 001_core.sql), so it is logged
 * rather than persisted; `alerts.ts` (Task 11) is the durable operator record.
 */
export async function pause(pool: Pool, reason: string): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')
  logWarn('custody_paused', { reason })
}

/**
 * Release the operator pause switch.
 *
 * The mirror image of `pause`, and deliberately as dumb: it clears the flag and
 * says so. It does NOT reconcile — a system that was paused long enough for the
 * balance to go stale must still fail closed on staleness until the worker's
 * next `reconcile()`, which is the correct order (know the balance, then move
 * money). Idempotent: unpausing a running system is a no-op.
 *
 * In particular it does NOT clear `shortfall_detected_at` (N3). A pause the
 * system engaged on itself because the chain held less than the books claim is
 * not an operator's to overrule; only a reconciliation that finds the two in
 * agreement again reopens the money paths.
 */
export async function unpause(pool: Pool): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = false WHERE singleton')
  logWarn('custody_unpaused')
}
