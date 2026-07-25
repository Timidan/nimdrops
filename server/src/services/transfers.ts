import type { Pool, PoolClient } from 'pg'
import { MEMO_MAX_BYTES, type ChainClient } from '../chain/types'
import { errorMessage } from '../config'
import type { Alerts } from './alerts'
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

/** `Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS` on both Albatross networks (~2h). */
export const DEFAULT_VALIDITY_WINDOW_BLOCKS = 7_200

/**
 * How long a transaction stays includable after its validity start height.
 * Read from the environment rather than hardcoded so a mainnet re-measurement
 * can change it without touching this logic.
 */
export function validityWindowBlocks(): number {
  const raw = process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS
  if (raw === undefined || raw === '') return DEFAULT_VALIDITY_WINDOW_BLOCKS
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('NIMIQ_VALIDITY_WINDOW_BLOCKS must be a positive integer')
  }
  return n
}

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
  }
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
): Promise<ProvenDeadEvidence> {
  const head = headHeight ?? (await chain.headHeight())
  const deadlineHeight = attempt.validityStartHeight + validityWindowBlocks()
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
 */
export async function broadcastStored(
  pool: Pool,
  chain: ChainClient,
  attempt: StoredAttempt,
): Promise<'acknowledged' | 'unknown'> {
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

async function markBroadcast(pool: Pool, attempt: StoredAttempt): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE transaction_attempts
       SET state = 'broadcast', last_error = NULL
       WHERE id = $1 AND state = 'signed'`,
      [attempt.attemptId],
    )
    // Hold off the next rebroadcast: the chain needs time to include it and is
    // mempool-blind until it does.
    await client.query(
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
      await client.query(
        `UPDATE claims SET state = 'confirming'
         WHERE id = $1 AND state IN ('reserved', 'sending', 'manual_review')`,
        [attempt.claimId],
      )
    }
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

/**
 * Resolve one open attempt against the chain — the heart of restart safety.
 *
 * Called for every `signed`/`broadcast` attempt on startup and on each tick.
 * Every branch is a decision about an unknown outcome, so each one is spelled
 * out below rather than collapsed into cleverness.
 */
export async function progressAttempt(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
  attempt: OpenAttempt,
  headHeight?: number,
): Promise<Progress> {
  const head = headHeight ?? (await chain.headHeight())
  const alreadyFlagged = attempt.transferState === 'manual_review'

  let tx
  try {
    tx = await chain.getTransaction(attempt.txHash)
  } catch (err) {
    // "We could not ask." Not absence, not failure — just no information.
    const message = errorMessage(err)
    await pool.query('UPDATE transaction_attempts SET last_error = $2 WHERE id = $1', [
      attempt.attemptId,
      message,
    ])
    const age = Date.now() - attempt.createdAt.getTime()
    if (age >= UNRESOLVED_BUDGET_MS && !alreadyFlagged) {
      await flagManualReview(pool, alerts, attempt, {
        reason: 'unresolvable_lookup',
        message,
        ageMs: age,
      })
      return 'changed'
    }
    return 'unchanged'
  }

  if (tx) {
    if (!tx.executionOk) {
      // On chain and failed: no amount of waiting changes this.
      if (alreadyFlagged) return 'unchanged'
      await flagManualReview(pool, alerts, attempt, {
        reason: 'execution_failed',
        includedHeight: tx.includedHeight,
      })
      return 'changed'
    }

    if (chain.isFinal(tx, head)) {
      // The single authority for "paid". Never the library's own `confirmed`.
      return (await confirmAttempt(pool, attempt, tx.includedHeight)) ? 'changed' : 'unchanged'
    }

    // Included but not final yet: record the sighting and keep waiting.
    const promoted = attempt.state === 'signed'
    const newSighting = attempt.observedHeight !== tx.includedHeight
    if (promoted || newSighting) {
      await markBroadcast(pool, attempt)
      await pool.query(
        'UPDATE transaction_attempts SET observed_height = $2 WHERE id = $1',
        [attempt.attemptId, tx.includedHeight.toString()],
      )
      return 'changed'
    }
    return 'unchanged'
  }

  // ---- not found -------------------------------------------------------------
  // Mempool blindness (G0 §5A): absence is NOT evidence of death.
  const deadlineHeight = attempt.validityStartHeight + validityWindowBlocks()
  if (head > deadlineHeight) {
    // Absent AND unincludable: this is the only shape a dead attempt can take.
    // The worker still does not mark it `proven_dead` — that transition creates
    // the right to spend the money again, so it belongs to an operator running
    // `recover.ts replace`, which re-proves both halves for itself.
    if (alreadyFlagged) return 'unchanged'
    await flagManualReview(pool, alerts, attempt, {
      reason: 'validity_window_expired',
      validityStartHeight: attempt.validityStartHeight,
      deadlineHeight,
      head,
      hint: 'proven_dead + replacement requires: pnpm tsx src/recover.ts replace <transferId>',
    })
    return 'changed'
  }

  if (alreadyFlagged) return 'unchanged'

  // Still includable and we cannot see it: rebroadcast the SAME bytes. This is
  // idempotent by hash, so it can never become a second payment, and it is the
  // only action that helps if the first broadcast never reached the network.
  if (attempt.nextAttemptAt !== null && attempt.nextAttemptAt.getTime() > Date.now()) {
    return 'unchanged'
  }
  return (await broadcastStored(pool, chain, attempt)) === 'acknowledged' ? 'changed' : 'unchanged'
}

/** Atomically finalize attempt, intent and claim. Returns false if already done. */
async function confirmAttempt(
  pool: Pool,
  attempt: OpenAttempt,
  includedHeight: number,
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(
      `UPDATE transaction_attempts
       SET state = 'confirmed',
           confirmed_height = $2,
           observed_height = COALESCE(observed_height, $2),
           last_error = NULL
       WHERE id = $1 AND state IN ('signed', 'broadcast')`,
      [attempt.attemptId, includedHeight.toString()],
    )
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(
      `UPDATE outgoing_transfers
       SET state = 'confirmed', last_error = NULL, next_attempt_at = NULL
       WHERE id = $1`,
      [attempt.transferId],
    )
    if (attempt.claimId) {
      await client.query(`UPDATE claims SET state = 'paid' WHERE id = $1 AND state <> 'paid'`, [
        attempt.claimId,
      ])
    }
    await client.query('COMMIT')
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
        includedHeight,
      }),
    )
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Hand an intent to a human and tell them about it.
 *
 * The attempt row is deliberately left open (`signed`/`broadcast`): while it is
 * open, `one_open_attempt` physically prevents any replacement from being
 * signed. A drop with a `manual_review` payout stays non-terminal (design §9),
 * so nothing settles or refunds around the stuck money.
 */
async function flagManualReview(
  pool: Pool,
  alerts: Alerts,
  attempt: OpenAttempt,
  detail: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE outgoing_transfers
       SET state = 'manual_review', last_error = $2
       WHERE id = $1 AND state <> 'confirmed'`,
      [attempt.transferId, JSON.stringify(detail)],
    )
    if (attempt.claimId) {
      await client.query(
        `UPDATE claims SET state = 'manual_review' WHERE id = $1 AND state <> 'paid'`,
        [attempt.claimId],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  await alerts.notify('manual_review', {
    transferId: attempt.transferId,
    attemptId: attempt.attemptId,
    txHash: attempt.txHash,
    sequence: attempt.sequence,
    ...detail,
  })
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
