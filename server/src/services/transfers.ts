import type { Pool, PoolClient } from 'pg'
import { MEMO_MAX_BYTES, type ChainClient } from '../chain/types'
import { errorMessage, validityWindowBlocks } from '../config'
import type { Queryable } from '../db/pool'
import type { AlertKind, Alerts } from './alerts'
import {
  PausedError,
  SolvencyError,
  StaleReconciliationError,
  assertSolvent,
  lockControls,
} from './solvency'

/**
 * The outgoing money path (design §8.3): sign → persist → broadcast → confirm,
 * with reconciliation of every open attempt on startup and on every tick.
 *
 * The whole module exists to make ONE guarantee: a process killed at any point
 * cannot pay twice and cannot silently lose a payment. Three rules produce it,
 * and every function below is written to preserve them.
 *
 * 1. **Nothing is broadcast that is not already committed.** The signed bytes
 *    and their hash are persisted and COMMITTED before `broadcast` is called,
 *    outside the database transaction. A crash between commit and broadcast
 *    leaves a `signed` attempt that reconciliation rebroadcasts verbatim —
 *    idempotent by hash, so it cannot become a second payment. (PLAN.md kill
 *    criterion: no code path pays without a persisted signed attempt row.)
 *
 * 2. **A broadcast error is an unknown outcome, not a failure.** The
 *    transaction may already be in the mempool. The only way to learn the truth
 *    is to ask the chain for the hash, and the only safe action meanwhile is
 *    rebroadcasting the same bytes.
 *
 * 3. **`proven_dead` needs proof, and only an operator may act on it.**
 *    Measured on TestAlbatross (`server/spike/g0-evidence.md` §5A): a
 *    just-broadcast hash reads "not found" for ~16 seconds because
 *    `getTransaction` does not see the mempool. Treating that as absence and
 *    building replacement bytes would double-pay. So `proven_dead` requires
 *    BOTH a sustained absence AND the attempt's validity window
 *    (`validity_start_height + NIMIQ_VALIDITY_WINDOW_BLOCKS`) provably past the
 *    head — and even then this worker only flags the intent for
 *    `manual_review`. The transition itself happens in `recover.ts replace`,
 *    under an operator's hand.
 *
 * And one rule about finality (g0-evidence.md §5B): the library's own
 * `confirmed` arrives long before ours. `chain.isFinal(tx, head)` is the ONLY
 * authority for `confirmed`/`paid`. Nothing else may set them.
 */

// ---- configuration -----------------------------------------------------------

/**
 * Postgres advisory lock guarding the single outgoing worker (PLAN.md: a second
 * worker path is a kill criterion). Session-scoped, so holding it for the life
 * of the worker process is what makes "one worker" true even across restarts.
 */
export const WORKER_LOCK_ID = 42

/** Claim payout memo, per Global Constraints. 12 UTF-8 bytes (measured G0). */
export const CLAIM_MEMO = '🧧 NimDrop'

if (Buffer.byteLength(CLAIM_MEMO, 'utf8') > MEMO_MAX_BYTES) {
  throw new Error(`claim memo exceeds ${MEMO_MAX_BYTES} UTF-8 bytes`)
}

/**
 * TEST SEAM (G1 review finding 1). Every function here that needs the validity
 * window takes it as `opts.windowBlocks`, defaulting to `config.validityWindowBlocks()`
 * — which is HARD FLOORED at 7200 and can only be raised by the environment.
 *
 * Production callers (`worker.ts`, `index.ts`, `recover.ts`) never pass the
 * option, so a deployment cannot run with a window below the protocol constant
 * no matter what its environment says. Tests that need a short window pass it
 * explicitly through this parameter, which is unreachable from any entrypoint.
 */
export interface WindowOptions {
  /** @internal test-only override; production reads the floored config. */
  windowBlocks?: number
}

function windowOf(opts?: WindowOptions): number {
  return opts?.windowBlocks ?? validityWindowBlocks()
}

/**
 * Sustained-absence rule for `proven_dead` (G1 review finding 2).
 *
 * A single not-found answer is one node's momentary opinion. Two of them, at
 * least `ABSENCE_MIN_SPAN_MS` apart, with no sighting in between, is evidence.
 * `recover.ts replace` requires both AND a validity window past AND a fresh
 * live lookup that is still absent.
 */
export const ABSENCE_MIN_OBSERVATIONS = 2
export const ABSENCE_MIN_SPAN_MS = 5 * 60_000

/**
 * Do not rebroadcast the same bytes more often than this after an acknowledged
 * broadcast. The chain needs 5-40 s to include a transaction and cannot answer
 * `getTransaction` for it meanwhile; hammering it would add nothing.
 */
export const REBROADCAST_COOLDOWN_MS = 30_000

/** Backoff after a control/solvency refusal, so a stuck tick is not a hot loop. */
export const RETRY_BACKOFF_MS = 30_000

/**
 * How long an attempt may stay unresolvable — the chain answering neither
 * "here it is" nor "not found", but erroring — before an operator is called in.
 * Age-based rather than a persisted counter: a restart must not reset the
 * budget, and `created_at` already survives one.
 */
export const UNRESOLVED_BUDGET_MS = 15 * 60_000

// ---- advisory lock -------------------------------------------------------------

/**
 * Try to become THE outgoing worker. Returns false if another process already
 * is; the caller must then do nothing at all — not tick, not sign, not
 * broadcast. Session-scoped: the lock is released by `releaseWorkerLock` or by
 * the connection dying, which is what makes a crashed worker recoverable.
 */
export async function acquireWorkerLock(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [WORKER_LOCK_ID],
  )
  return rows[0].locked
}

export async function releaseWorkerLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_ID])
}

/**
 * Run `fn` only if this process can hold the worker lock; otherwise return
 * `'locked'` and do nothing. Used by `worker.ts` for every tick so a second
 * accidental worker is inert rather than dangerous.
 */
export async function withWorkerLock<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | 'locked'> {
  const client = await pool.connect()
  try {
    if (!(await acquireWorkerLock(client))) return 'locked'
    try {
      return await fn(client)
    } finally {
      await releaseWorkerLock(client).catch(() => {})
    }
  } finally {
    client.release()
  }
}

// ---- rows ------------------------------------------------------------------------

export interface TransferIntent {
  id: string
  purpose: 'payout' | 'refund'
  dropId: string
  claimId: string | null
  recipientAddress: string
  amountLuna: bigint
  state: string
}

export interface StoredAttempt {
  attemptId: string
  transferId: string
  claimId: string | null
  sequence: number
  rawTxHex: string
  txHash: string
  validityStartHeight: number
}

/** An attempt still in flight: `signed` (maybe broadcast) or `broadcast`. */
export interface OpenAttempt extends StoredAttempt {
  state: 'signed' | 'broadcast'
  observedHeight: number | null
  createdAt: Date
  transferState: string
  nextAttemptAt: Date | null
  /** Consecutive not-found lookups; any sighting resets it to 0. */
  absentChecks: number
  /** When the current unbroken absence series started; `null` when not absent. */
  firstAbsentAt: Date | null
}

interface OpenAttemptRow {
  id: string
  transfer_id: string
  sequence: number
  state: 'signed' | 'broadcast'
  raw_hex: string
  tx_hash: string
  validity_start_height: string
  observed_height: string | null
  created_at: Date
  claim_id: string | null
  transfer_state: string
  next_attempt_at: Date | null
  absent_checks: number
  first_absent_at: Date | null
}

const OPEN_ATTEMPT_SELECT = `
  SELECT a.id,
         a.transfer_id,
         a.sequence,
         a.state,
         encode(a.raw_signed_tx, 'hex') AS raw_hex,
         a.tx_hash,
         a.validity_start_height,
         a.observed_height,
         a.created_at,
         a.absent_checks,
         a.first_absent_at,
         t.claim_id,
         t.state AS transfer_state,
         t.next_attempt_at
  FROM transaction_attempts a
  JOIN outgoing_transfers t ON t.id = a.transfer_id
  WHERE a.state IN ('signed', 'broadcast')
`

function toOpenAttempt(row: OpenAttemptRow): OpenAttempt {
  return {
    attemptId: row.id,
    transferId: row.transfer_id,
    claimId: row.claim_id,
    sequence: row.sequence,
    state: row.state,
    rawTxHex: row.raw_hex,
    txHash: row.tx_hash,
    validityStartHeight: Number(row.validity_start_height),
    observedHeight: row.observed_height === null ? null : Number(row.observed_height),
    createdAt: row.created_at,
    transferState: row.transfer_state,
    nextAttemptAt: row.next_attempt_at,
    absentChecks: Number(row.absent_checks),
    firstAbsentAt: row.first_absent_at,
  }
}

/**
 * Record one "the chain does not have this hash" observation (finding 2).
 *
 * `first_absent_at` is stamped ONCE per series (`COALESCE`), so the age of the
 * series is the age of its first observation, not of its latest. That is what
 * makes "two observations five minutes apart" mean five minutes of real time
 * rather than two lookups in the same tick.
 */
async function recordAbsence(db: Queryable, attemptId: string): Promise<void> {
  await db.query(
    `UPDATE transaction_attempts
     SET absent_checks = absent_checks + 1,
         first_absent_at = COALESCE(first_absent_at, now())
     WHERE id = $1`,
    [attemptId],
  )
}

/**
 * The chain showed us the transaction: the absence series is broken and must
 * start over. Without this a transaction that was invisible for a while and
 * then appeared would keep its stale absence evidence and stay replaceable.
 *
 * Exported because EVERY code path that sees a transaction on chain owes this
 * write, not just the worker's (round-2 review F2). `recover.ts replace` looks
 * the hash up itself and used to refuse without recording what it had just
 * learned, so the stale series survived its own refutation and one later
 * transient not-found answer was enough to reach the observation threshold and
 * authorise a replacement for a transaction that was on chain all along.
 *
 * Takes a {@link Queryable} so a caller already holding the attempt row lock can
 * do it inside that transaction.
 */
export async function clearAbsenceSeries(db: Queryable, attemptId: string): Promise<void> {
  await db.query(
    `UPDATE transaction_attempts
     SET absent_checks = 0, first_absent_at = NULL
     WHERE id = $1 AND (absent_checks <> 0 OR first_absent_at IS NOT NULL)`,
    [attemptId],
  )
}

/** Every attempt whose outcome is not yet known. Startup reconciles all of them. */
export async function loadOpenAttempts(pool: Pool, transferId?: string): Promise<OpenAttempt[]> {
  const { rows } = transferId
    ? await pool.query<OpenAttemptRow>(
        `${OPEN_ATTEMPT_SELECT} AND a.transfer_id = $1 ORDER BY a.created_at, a.sequence`,
        [transferId],
      )
    : await pool.query<OpenAttemptRow>(`${OPEN_ATTEMPT_SELECT} ORDER BY a.created_at, a.sequence`)
  return rows.map(toOpenAttempt)
}

// ---- proven-dead evidence ---------------------------------------------------------

export interface ProvenDeadInput {
  txHash: string
  validityStartHeight: number
}

export interface ProvenDeadEvidence {
  /** `absent && windowPast` — the ONLY combination that permits a replacement. */
  provenDead: boolean
  /** The chain answered "no such transaction". NOT the same as `!found`. */
  absent: boolean
  /** Head is strictly past `validityStartHeight + window`: it can never land now. */
  windowPast: boolean
  /** The lookup itself failed: we could not ask, so we know nothing. */
  unknown: boolean
  head: number
  deadlineHeight: number
  lookupError?: string
}

/**
 * Decide whether an attempt is provably, permanently dead.
 *
 * Both halves are required and neither is sufficient:
 *
 * - **absent** alone is worthless — `getTransaction` is mempool-blind, so a
 *   perfectly healthy just-broadcast payment reads absent for ~16 s (G0 §5A).
 * - **windowPast** alone is worthless — the transaction may have been included
 *   long ago and simply not been looked up yet.
 *
 * A lookup error yields `unknown: true` and `provenDead: false`: "we could not
 * ask" must never reach the money engine as "it is not there".
 */
export async function evaluateProvenDead(
  chain: ChainClient,
  attempt: ProvenDeadInput,
  headHeight?: number,
  opts?: WindowOptions,
): Promise<ProvenDeadEvidence> {
  const head = headHeight ?? (await chain.headHeight())
  const deadlineHeight = attempt.validityStartHeight + windowOf(opts)
  const windowPast = head > deadlineHeight

  try {
    const tx = await chain.getTransaction(attempt.txHash)
    const absent = tx === null
    return { provenDead: absent && windowPast, absent, windowPast, unknown: false, head, deadlineHeight }
  } catch (err) {
    return {
      provenDead: false,
      absent: false,
      windowPast,
      unknown: true,
      head,
      deadlineHeight,
      lookupError: errorMessage(err),
    }
  }
}

// ---- signing -----------------------------------------------------------------------

/**
 * Step 2 and 3 of design §8.3: construct and sign ONE attempt without
 * broadcasting, then persist the exact serialized bytes, hash, fee and validity
 * window base, moving the intent to `in_progress`.
 *
 * Must be called inside a transaction that already holds the custody lock. The
 * caller commits; only after that may the bytes be broadcast. `one_open_attempt`
 * makes a second open attempt for the same intent impossible at the database
 * level, so even a logic bug here cannot produce two live payments.
 *
 * `validityStartHeight` is persisted because it is the only durable record of
 * when this attempt stops being includable — the input to every later
 * `proven_dead` decision (see the 002 migration).
 */
export async function signAndPersistAttempt(
  client: PoolClient,
  chain: ChainClient,
  intent: TransferIntent,
  validityStartHeight: number,
): Promise<StoredAttempt> {
  const built = await chain.buildSignedBasic({
    to: intent.recipientAddress,
    valueLuna: intent.amountLuna,
    dataUtf8: CLAIM_MEMO,
    validityStartHeight,
  })

  const { rows: seqRows } = await client.query<{ next_sequence: number }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM transaction_attempts WHERE transfer_id = $1`,
    [intent.id],
  )
  const sequence = Number(seqRows[0].next_sequence)

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height
     ) VALUES ($1, $2, 'signed', decode($3, 'hex'), $4, $5, $6)
     RETURNING id`,
    [
      intent.id,
      sequence,
      built.rawTxHex,
      built.txHash,
      built.feeLuna.toString(),
      validityStartHeight.toString(),
    ],
  )

  await client.query(
    `UPDATE outgoing_transfers
     SET state = 'in_progress', last_error = NULL, next_attempt_at = NULL
     WHERE id = $1`,
    [intent.id],
  )
  if (intent.claimId) {
    await client.query(
      `UPDATE claims SET state = 'sending' WHERE id = $1 AND state IN ('reserved', 'manual_review')`,
      [intent.claimId],
    )
  }

  return {
    attemptId: rows[0].id,
    transferId: intent.id,
    claimId: intent.claimId,
    sequence,
    rawTxHex: built.rawTxHex,
    txHash: built.txHash,
    validityStartHeight,
  }
}

/**
 * Step 4 and 5 of design §8.3: broadcast ONLY the stored bytes, outside any
 * database transaction, and record the acknowledgement.
 *
 * A throw here is deliberately not propagated. The transaction may have landed
 * anyway (the ambiguous-broadcast case), so the attempt stays `signed` with the
 * error recorded and reconciliation resolves it by hash. Rethrowing would tempt
 * a caller into treating "we did not hear back" as "it did not happen".
 *
 * **Round-3 R4 — the attempt is marked as BROADCAST-ATTEMPTED first**, in its
 * own committed statement, before the bytes leave. From that moment the
 * attempt's `signed` state no longer means "the chain cannot have debited
 * this": the solvency cross-check reads the marker instead of guessing from
 * the state, so an ambiguous broadcast explains the money the chain took
 * rather than looking like a shortfall. The write must precede the call — a
 * process killed the instant the network accepts the transaction is exactly
 * the case the marker exists for.
 */
export async function broadcastStored(
  pool: Pool,
  chain: ChainClient,
  attempt: StoredAttempt,
): Promise<'acknowledged' | 'unknown'> {
  await pool.query(
    `UPDATE transaction_attempts
     SET broadcast_attempted_at = COALESCE(broadcast_attempted_at, now())
     WHERE id = $1`,
    [attempt.attemptId],
  )
  try {
    await chain.broadcast(attempt.rawTxHex)
  } catch (err) {
    await pool.query('UPDATE transaction_attempts SET last_error = $2 WHERE id = $1', [
      attempt.attemptId,
      errorMessage(err),
    ])
    return 'unknown'
  }
  await markBroadcast(pool, attempt)
  return 'acknowledged'
}

/**
 * The three writes that record an acknowledged broadcast. Takes a
 * {@link Queryable} so a caller that already holds the attempt row lock can do
 * them inside that transaction (R1) instead of opening a second one.
 *
 * Write order is attempt → transfer → claim, the order every path in this file
 * and in `recover.ts prepareReplacement` uses. Do not reorder.
 */
async function applyBroadcastMark(db: Queryable, attempt: StoredAttempt): Promise<void> {
  await db.query(
    `UPDATE transaction_attempts
     SET state = 'broadcast', last_error = NULL
     WHERE id = $1 AND state = 'signed'`,
    [attempt.attemptId],
  )
  // Hold off the next rebroadcast: the chain needs time to include it and is
  // mempool-blind until it does.
  await db.query(
    `UPDATE outgoing_transfers
     SET next_attempt_at = now() + make_interval(secs => $2::float8 / 1000)
     WHERE id = $1 AND state <> 'confirmed'`,
    [attempt.transferId, REBROADCAST_COOLDOWN_MS],
  )
  if (attempt.claimId) {
    // `manual_review` is in the list on purpose: once an operator's recovery
    // gets a payment broadcast, the claimant should see `confirming` again
    // rather than stay on a flag that no longer describes their money. The
    // only state deliberately left alone is `paid` — never walk that back.
    await db.query(
      `UPDATE claims SET state = 'confirming'
       WHERE id = $1 AND state IN ('reserved', 'sending', 'manual_review')`,
      [attempt.claimId],
    )
  }
}

async function markBroadcast(pool: Pool, attempt: StoredAttempt): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyBroadcastMark(client, attempt)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---- reconciliation -------------------------------------------------------------------

type Progress = 'changed' | 'unchanged'

/** What one locked pass over an attempt decided, to be acted on after COMMIT. */
interface AttemptOutcome {
  progress: Progress
  /** Rebroadcast the same bytes once the lock is released. */
  rebroadcast?: boolean
  /** Fired after COMMIT, so an alert can never describe a rolled-back write. */
  alert?: { kind: AlertKind; detail: Record<string, unknown> }
  /** Set when this pass finalized the payment; logged after COMMIT. */
  confirmedHeight?: number
}

/** The attempt row and its intent, as they stand under the row lock. */
interface LockedAttempt {
  state: 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
  observedHeight: number | null
  transferState: string
  nextAttemptAt: Date | null
}

/**
 * Pin the attempt row for the rest of the caller's transaction.
 *
 * `FOR UPDATE OF a` locks ONLY the attempt row: the intent row is joined for
 * its state and is locked later, by the UPDATEs, which keeps the write order
 * attempt → transfer that `recover.ts prepareReplacement` also uses.
 */
async function lockAttemptRow(
  client: PoolClient,
  attemptId: string,
): Promise<LockedAttempt | null> {
  const { rows } = await client.query<{
    state: LockedAttempt['state']
    observed_height: string | null
    transfer_state: string
    next_attempt_at: Date | null
  }>(
    `SELECT a.state, a.observed_height, t.state AS transfer_state, t.next_attempt_at
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE a.id = $1
     FOR UPDATE OF a`,
    [attemptId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    state: row.state,
    observedHeight: row.observed_height === null ? null : Number(row.observed_height),
    transferState: row.transfer_state,
    nextAttemptAt: row.next_attempt_at,
  }
}

/**
 * Resolve one open attempt against the chain — the heart of restart safety.
 *
 * Called for every `signed`/`broadcast` attempt on startup and on each tick.
 * Every branch is a decision about an unknown outcome, so each one is spelled
 * out below rather than collapsed into cleverness.
 *
 * **Round-3 R1 — the attempt row is LOCKED before the chain is asked, and the
 * answer is persisted inside that same transaction.** The lookup and the write
 * it justifies used to be two unsynchronized steps, which left this window:
 *
 *   1. this function gets a positive lookup — the payment is on chain;
 *   2. before it can clear the absence series, it is descheduled;
 *   3. `recover.ts replace` takes the attempt row lock, makes its own lookup,
 *      gets a transient not-found (the chain is mempool-blind and one node's
 *      answer is one node's opinion), reads the STILL-STALE absence series as
 *      corroboration, marks the attempt `proven_dead` and signs a replacement;
 *   4. this function resumes and clears a series that no longer matters, for an
 *      attempt that is now dead on paper and alive on chain.
 *
 * Both payments then land. Holding the row lock across the lookup closes it
 * structurally: a sighting either commits before `replace` takes the lock (and
 * `replace` reads the cleared series) or `replace` waits behind it (and its own
 * lookup, made under the lock, sees what this one saw). The cost is one chain
 * round trip per open attempt per tick with a row lock held — a row nothing
 * else contends for except the operator command this is being serialized
 * against.
 *
 * Lock order is unchanged and consistent: `recover.ts` takes
 * custody_controls → attempt → transfer; this path takes a SUBSET of that tail
 * (attempt → transfer) and never reaches for custody_controls, so no cycle
 * exists.
 */
export async function progressAttempt(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
  attempt: OpenAttempt,
  headHeight?: number,
  opts?: WindowOptions,
): Promise<Progress> {
  const head = headHeight ?? (await chain.headHeight())

  const client = await pool.connect()
  let outcome: AttemptOutcome
  try {
    await client.query('BEGIN')
    outcome = await progressLocked(client, chain, attempt, head, opts)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (outcome.confirmedHeight !== undefined) {
    // The one line that says money finished moving. Emitted after COMMIT, so it
    // can never claim a payment the database did not keep.
    console.info(
      JSON.stringify({
        event: 'transfer_confirmed',
        transferId: attempt.transferId,
        attemptId: attempt.attemptId,
        txHash: attempt.txHash,
        sequence: attempt.sequence,
        claimId: attempt.claimId,
        includedHeight: outcome.confirmedHeight,
      }),
    )
  }
  if (outcome.alert) await alerts.notify(outcome.alert.kind, outcome.alert.detail)

  if (outcome.rebroadcast) {
    // Deliberately OUTSIDE the lock. Rebroadcasting the stored bytes is
    // idempotent by hash and cannot become a second payment, so it does not
    // need the serialization the decision above does — and it must not hold a
    // row lock across a network write that may hang.
    return (await broadcastStored(pool, chain, attempt)) === 'acknowledged'
      ? 'changed'
      : 'unchanged'
  }
  return outcome.progress
}

/** The decision half of {@link progressAttempt}, inside the caller's transaction. */
async function progressLocked(
  client: PoolClient,
  chain: ChainClient,
  attempt: OpenAttempt,
  head: number,
  opts?: WindowOptions,
): Promise<AttemptOutcome> {
  const locked = await lockAttemptRow(client, attempt.attemptId)
  // The row cannot vanish (nothing deletes attempts), but if it ever did, doing
  // nothing is the only safe answer.
  if (!locked) return { progress: 'unchanged' }
  // Already finalized by another pass while we waited for the lock.
  if (locked.state === 'confirmed') return { progress: 'unchanged' }

  const alreadyFlagged = locked.transferState === 'manual_review'

  let tx
  try {
    tx = await chain.getTransaction(attempt.txHash)
  } catch (err) {
    // "We could not ask." Not absence, not failure — just no information.
    const message = errorMessage(err)
    await client.query('UPDATE transaction_attempts SET last_error = $2 WHERE id = $1', [
      attempt.attemptId,
      message,
    ])
    const age = Date.now() - attempt.createdAt.getTime()
    if (age >= UNRESOLVED_BUDGET_MS && !alreadyFlagged) {
      return {
        progress: 'changed',
        alert: await applyManualReview(client, attempt, {
          reason: 'unresolvable_lookup',
          message,
          ageMs: age,
        }),
      }
    }
    return { progress: 'unchanged' }
  }

  if (tx) {
    if (locked.state === 'proven_dead') {
      // RECONCILIATION EMERGENCY (R1). An operator proved this attempt dead and
      // signed a replacement for the same intent — and here it is, on chain.
      // Confirming it would mark the intent paid while a second payment is
      // still live; ignoring it would leave a payment nobody is accounting for.
      // Neither is survivable automatically, so the intent goes to a human with
      // both hashes named.
      return {
        progress: 'changed',
        alert: await applyManualReview(client, attempt, {
          reason: 'proven_dead_attempt_landed',
          includedHeight: tx.includedHeight,
          executionOk: tx.executionOk,
          head,
          hint:
            'this attempt was marked proven_dead and REPLACED, but the chain shows it landed. ' +
            'A second payment for the same intent may also be live: reconcile both hashes on ' +
            'the explorer before anything else, and pause custody if both paid.',
        }),
      }
    }

    // A sighting breaks any absence series (finding 2). This runs before every
    // other branch on purpose: even an execution-failed or not-yet-final
    // sighting is proof the hash reached the chain, and stale absence evidence
    // is exactly what would let `replace` build a second payment.
    await clearAbsenceSeries(client, attempt.attemptId)

    if (!tx.executionOk) {
      // On chain and failed: no amount of waiting changes this.
      if (alreadyFlagged) return { progress: 'unchanged' }
      return {
        progress: 'changed',
        alert: await applyManualReview(client, attempt, {
          reason: 'execution_failed',
          includedHeight: tx.includedHeight,
        }),
      }
    }

    if (chain.isFinal(tx, head)) {
      // The single authority for "paid". Never the library's own `confirmed`.
      const confirmed = await applyConfirm(client, attempt, tx.includedHeight)
      return confirmed
        ? { progress: 'changed', confirmedHeight: tx.includedHeight }
        : { progress: 'unchanged' }
    }

    // Included but not final yet: record the sighting and keep waiting.
    const promoted = locked.state === 'signed'
    const newSighting = locked.observedHeight !== tx.includedHeight
    if (promoted || newSighting) {
      await applyBroadcastMark(client, attempt)
      await client.query('UPDATE transaction_attempts SET observed_height = $2 WHERE id = $1', [
        attempt.attemptId,
        tx.includedHeight.toString(),
      ])
      return { progress: 'changed' }
    }
    return { progress: 'unchanged' }
  }

  // ---- not found -------------------------------------------------------------
  // A dead attempt that the chain also cannot see is simply dead: its
  // replacement is the live payment now, and adding absence evidence to a row
  // nothing reads would say nothing.
  if (locked.state === 'proven_dead') return { progress: 'unchanged' }

  // Mempool blindness (G0 §5A): absence is NOT evidence of death. It is one
  // observation, recorded BEFORE any early return below so that an intent
  // already in `manual_review` keeps accumulating the evidence an operator
  // needs — `recover.ts replace` reads this series and refuses without it.
  await recordAbsence(client, attempt.attemptId)

  const deadlineHeight = attempt.validityStartHeight + windowOf(opts)
  if (head > deadlineHeight) {
    // Absent AND unincludable: this is the only shape a dead attempt can take.
    // The worker still does not mark it `proven_dead` — that transition creates
    // the right to spend the money again, so it belongs to an operator running
    // `recover.ts replace`, which re-proves both halves for itself.
    if (alreadyFlagged) return { progress: 'unchanged' }
    return {
      progress: 'changed',
      alert: await applyManualReview(client, attempt, {
        reason: 'validity_window_expired',
        validityStartHeight: attempt.validityStartHeight,
        deadlineHeight,
        head,
        hint: 'proven_dead + replacement requires: pnpm tsx src/recover.ts replace <transferId>',
      }),
    }
  }

  if (alreadyFlagged) return { progress: 'unchanged' }

  // Still includable and we cannot see it: rebroadcast the SAME bytes. This is
  // idempotent by hash, so it can never become a second payment, and it is the
  // only action that helps if the first broadcast never reached the network.
  if (locked.nextAttemptAt !== null && locked.nextAttemptAt.getTime() > Date.now()) {
    return { progress: 'unchanged' }
  }
  return { progress: 'unchanged', rebroadcast: true }
}

/**
 * Atomically finalize attempt, intent and claim inside the caller's
 * transaction. Returns false if the attempt was no longer open.
 */
async function applyConfirm(
  db: Queryable,
  attempt: OpenAttempt,
  includedHeight: number,
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE transaction_attempts
     SET state = 'confirmed',
         confirmed_height = $2,
         observed_height = COALESCE(observed_height, $2),
         last_error = NULL
     WHERE id = $1 AND state IN ('signed', 'broadcast')`,
    [attempt.attemptId, includedHeight.toString()],
  )
  // Unreachable: the caller holds the row lock and has already read a state
  // this UPDATE matches. Kept because the cost of being wrong is a claim marked
  // paid by a transaction we did not actually confirm.
  if (updated.rowCount === 0) return false

  await db.query(
    `UPDATE outgoing_transfers
     SET state = 'confirmed', last_error = NULL, next_attempt_at = NULL
     WHERE id = $1`,
    [attempt.transferId],
  )
  if (attempt.claimId) {
    await db.query(`UPDATE claims SET state = 'paid' WHERE id = $1 AND state <> 'paid'`, [
      attempt.claimId,
    ])
  }
  return true
}

/**
 * Hand an intent to a human, inside the caller's transaction, and return the
 * alert for the caller to fire AFTER it commits.
 *
 * The attempt row is deliberately left open (`signed`/`broadcast`): while it is
 * open, `one_open_attempt` physically prevents any replacement from being
 * signed. A drop with a `manual_review` payout stays non-terminal (design §9),
 * so nothing settles or refunds around the stuck money.
 */
async function applyManualReview(
  db: Queryable,
  attempt: OpenAttempt,
  detail: Record<string, unknown>,
): Promise<{ kind: AlertKind; detail: Record<string, unknown> }> {
  await db.query(
    `UPDATE outgoing_transfers
     SET state = 'manual_review', last_error = $2
     WHERE id = $1 AND state <> 'confirmed'`,
    [attempt.transferId, JSON.stringify(detail)],
  )
  if (attempt.claimId) {
    await db.query(
      `UPDATE claims SET state = 'manual_review' WHERE id = $1 AND state <> 'paid'`,
      [attempt.claimId],
    )
  }
  return {
    kind: 'manual_review',
    detail: {
      transferId: attempt.transferId,
      attemptId: attempt.attemptId,
      txHash: attempt.txHash,
      sequence: attempt.sequence,
      ...detail,
    },
  }
}

/**
 * Design §8.3: "On startup, reconcile every `signed` and `broadcast` attempt
 * before signing new work."
 *
 * One bad attempt must not stop the others from being resolved, so each is
 * isolated; a failure here leaves that attempt open for the next tick, which is
 * the safe direction.
 */
export async function reconcileOnStartup(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
): Promise<void> {
  const attempts = await loadOpenAttempts(pool)
  if (attempts.length === 0) return
  const head = await chain.headHeight()
  for (const attempt of attempts) {
    try {
      await progressAttempt(pool, chain, alerts, attempt, head)
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'reconcile_attempt_failed',
          transferId: attempt.transferId,
          attemptId: attempt.attemptId,
          error: errorMessage(err),
        }),
      )
    }
  }
}

// ---- the tick ---------------------------------------------------------------------

/**
 * One unit of worker work. Called every ~2s by `worker.ts` while holding the
 * advisory lock.
 *
 * Open attempts are resolved before new work is signed — an unresolved payment
 * is always more urgent than an unstarted one, and signing while a prior
 * outcome is unknown is exactly what design §8.3 forbids.
 */
export async function runWorkerTick(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
): Promise<'idle' | 'worked'> {
  let worked = false

  const attempts = await loadOpenAttempts(pool)
  if (attempts.length > 0) {
    const head = await chain.headHeight()
    for (const attempt of attempts) {
      if ((await progressAttempt(pool, chain, alerts, attempt, head)) === 'changed') worked = true
    }
  }
  if (worked) return 'worked'

  return (await signNextQueued(pool, chain, alerts)) ? 'worked' : 'idle'
}

/**
 * Design §8.3 steps 1-4 for exactly one queued intent.
 *
 * The chain round trip for the head happens BEFORE the transaction opens: the
 * singleton custody lock is also taken by every claim reservation and funding
 * activation, so holding it across a network call would stall the whole app.
 * A head that is a block or two stale is harmless — it only shortens a 7200
 * block validity window.
 */
async function signNextQueued(pool: Pool, chain: ChainClient, alerts: Alerts): Promise<boolean> {
  // Unlocked pre-check. Without it a paused system with nothing to pay would
  // still take the custody lock and alert every two seconds.
  const { rows: pending } = await pool.query(
    `SELECT 1 FROM outgoing_transfers
     WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     LIMIT 1`,
  )
  if (pending.length === 0) return false

  const head = await chain.headHeight()
  const client = await pool.connect()
  let stored: StoredAttempt | null = null

  try {
    await client.query('BEGIN')

    let controls
    try {
      controls = await lockControls(client)
    } catch (err) {
      await client.query('ROLLBACK')
      if (err instanceof PausedError) {
        await alerts.notify('paused', { stage: 'transfer_worker', message: err.message })
        return false
      }
      if (err instanceof StaleReconciliationError) {
        await alerts.notify('stale_reconciliation', {
          stage: 'transfer_worker',
          message: err.message,
        })
        return false
      }
      throw err
    }

    const { rows } = await client.query<{
      id: string
      purpose: 'payout' | 'refund'
      drop_id: string
      claim_id: string | null
      recipient_address: string
      amount_luna: string
      state: string
    }>(
      `SELECT id, purpose, drop_id, claim_id, recipient_address, amount_luna, state
       FROM outgoing_transfers
       WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    )
    const row = rows[0]
    if (!row) {
      await client.query('COMMIT')
      return false
    }
    const intent: TransferIntent = {
      id: row.id,
      purpose: row.purpose,
      dropId: row.drop_id,
      claimId: row.claim_id,
      recipientAddress: row.recipient_address,
      amountLuna: BigInt(row.amount_luna),
      state: row.state,
    }

    // Design §10.2: every outgoing signature re-checks the invariant. The
    // principal is already outstanding, so nothing new is added — this call is
    // the fee-reserve and cap guard, not an allocation.
    try {
      await assertSolvent(client, controls, 0n)
    } catch (err) {
      if (err instanceof SolvencyError) {
        await client.query(
          `UPDATE outgoing_transfers
           SET last_error = $2,
               next_attempt_at = now() + make_interval(secs => $3::float8 / 1000)
           WHERE id = $1`,
          [intent.id, errorMessage(err), RETRY_BACKOFF_MS],
        )
        await client.query('COMMIT')
        console.warn(
          JSON.stringify({
            event: 'transfer_deferred',
            transferId: intent.id,
            reason: errorMessage(err),
          }),
        )
        // Money is owed and the invariant refuses to sign for it. Silence here
        // would look exactly like an idle worker, so page the operator; the
        // caller's throttling keeps a stuck queue from alerting every 2s.
        await alerts.notify('insolvent', {
          stage: 'transfer_worker',
          transferId: intent.id,
          purpose: intent.purpose,
          message: errorMessage(err),
        })
        return false
      }
      throw err
    }

    stored = await signAndPersistAttempt(client, chain, intent, head)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // COMMITTED. Only now do the bytes leave the process.
  await broadcastStored(pool, chain, stored)
  return true
}
