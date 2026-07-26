import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { type NimiqChain, nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient, ChainTx } from './chain/types'
import { type Queryable, closePool, getPool } from './db/pool'
import { type NetworkName, errorMessage } from './config'
import { exitAfterTeardown } from './exit'
import { type Alerts, consoleAlerts } from './services/alerts'
import { MEMO_PREFIX } from './services/drops'
import {
  type Controls,
  RECONCILIATION_MAX_AGE_MS,
  ensureNetworkBinding,
  inFlightOutgoingLuna,
  ledgerMovementsLuna,
  outstandingPrincipalLuna,
  pause,
  readControls,
  unpause,
} from './services/solvency'
import {
  ABSENCE_MIN_OBSERVATIONS,
  ABSENCE_MIN_SPAN_MS,
  type StoredAttempt,
  type TransferIntent,
  type WindowOptions,
  broadcastStored,
  clearAbsenceSeries,
  evaluateProvenDead,
  loadOpenAttempts,
  progressAttempt,
  signAndPersistAttempt,
} from './services/transfers'

/**
 * Operator recovery commands (design §10.3).
 *
 *   pnpm tsx src/recover.ts status
 *   pnpm tsx src/recover.ts resume <transferId>
 *   pnpm tsx src/recover.ts replace <transferId>
 *   pnpm tsx src/recover.ts deposits
 *   pnpm tsx src/recover.ts float show
 *   pnpm tsx src/recover.ts float set <luna>
 *   pnpm tsx src/recover.ts pause <reason>
 *   pnpm tsx src/recover.ts unpause
 *
 * The design's constraint on this file is one sentence: "a recovery command
 * that resumes an existing transfer intent or creates a replacement attempt
 * only after the prior one is `proven_dead`; no command may alter its recipient
 * or amount."
 *
 * That is enforced structurally, not by discipline: neither command accepts a
 * recipient or an amount. `replace` reads both off the immutable
 * `outgoing_transfers` row and hands them to the same signing function the
 * worker uses. There is no code path in this file through which an operator
 * could redirect a payment.
 */

/**
 * Base class for every deliberate refusal this file can raise.
 *
 * `name` is set from the concrete subclass rather than left as `"Error"`: the
 * machine-readable outcome line carries it, and "this was a
 * `ReplaceRefusedError`" is a materially different fact for an operator (and
 * for {@link failed}, which classifies on it) than "this was an error".
 */
export class RecoverError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The prior attempt might still land, so building a new one could double-pay. */
export class ReplaceRefusedError extends RecoverError {}

export class TransferNotFoundError extends RecoverError {
  constructor(transferId: string) {
    super(`no outgoing transfer with id ${transferId}`)
  }
}

// ---- shared reads ---------------------------------------------------------------

interface IntentRow {
  id: string
  purpose: 'payout' | 'refund'
  drop_id: string
  claim_id: string | null
  recipient_address: string
  amount_luna: string
  state: string
}

const INTENT_COLUMNS =
  'id, purpose, drop_id, claim_id, recipient_address, amount_luna, state'

function toIntent(row: IntentRow): TransferIntent {
  return {
    id: row.id,
    purpose: row.purpose,
    dropId: row.drop_id,
    claimId: row.claim_id,
    recipientAddress: row.recipient_address,
    amountLuna: BigInt(row.amount_luna),
    state: row.state,
  }
}

async function loadIntent(db: Pool | PoolClient, transferId: string): Promise<TransferIntent> {
  const { rows } = await db.query<IntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM outgoing_transfers WHERE id = $1`,
    [transferId],
  )
  if (!rows[0]) throw new TransferNotFoundError(transferId)
  return toIntent(rows[0])
}

interface LatestAttempt {
  id: string
  sequence: number
  state: 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
  txHash: string
  validityStartHeight: number
  rawTxHex: string
  /** Consecutive not-found lookups recorded by the worker (finding 2). */
  absentChecks: number
  /** When the current absence series started; `null` when the series is broken. */
  firstAbsentAt: Date | null
}

async function loadLatestAttempt(
  db: Pool | PoolClient,
  transferId: string,
  forUpdate = false,
): Promise<LatestAttempt | null> {
  const { rows } = await db.query<{
    id: string
    sequence: number
    state: LatestAttempt['state']
    tx_hash: string
    validity_start_height: string
    raw_hex: string
    absent_checks: number
    first_absent_at: Date | null
  }>(
    `SELECT id, sequence, state, tx_hash, validity_start_height,
            encode(raw_signed_tx, 'hex') AS raw_hex, absent_checks, first_absent_at
     FROM transaction_attempts
     WHERE transfer_id = $1
     ORDER BY sequence DESC
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [transferId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    sequence: row.sequence,
    state: row.state,
    txHash: row.tx_hash,
    validityStartHeight: Number(row.validity_start_height),
    rawTxHex: row.raw_hex,
    absentChecks: Number(row.absent_checks),
    firstAbsentAt: row.first_absent_at,
  }
}

/**
 * Network of a stored signed transaction, when the chain client can tell us
 * (finding 6). Not part of the frozen `ChainClient` interface: `NimiqChain`
 * reads it off the deserialized transaction and `FakeChain` off its payload,
 * but a client that cannot answer at all must not block recovery — the primary
 * guard is `custody_controls.network`, which every command checks
 * unconditionally.
 */
interface NetworkDecoder {
  rawTxNetwork(rawTxHex: string): NetworkName | null
}

function asNetworkDecoder(chain: ChainClient): NetworkDecoder | null {
  const candidate = chain as ChainClient & Partial<NetworkDecoder>
  return typeof candidate.rawTxNetwork === 'function' ? (candidate as NetworkDecoder) : null
}

/**
 * Refuse unless the bytes we are about to declare dead were signed for the
 * chain we are looking at. Returns the refusal rather than throwing it, so the
 * caller can decide what else to persist first.
 *
 * **Round-2 F6.** A decoder that answers `null` — bytes that do not parse, or
 * that carry a network id this build does not map — used to be treated as
 * "carry on". That is fail-OPEN on the exact question this check exists to
 * answer: if we cannot tell which chain the bytes belong to, we cannot claim
 * their absence from this one means anything. A corrupted or foreign attempt
 * row now blocks the replacement instead of waving it through, and the
 * operator's next move is to look the hash up on an explorer, not to sign.
 *
 * A client with no decoder AT ALL is different and still allowed through: that
 * is a capability the client never claimed, not an answer it failed to give.
 */
function refuseForeignBytes(chain: ChainClient, attempt: LatestAttempt): ReplaceRefusedError | null {
  const decoder = asNetworkDecoder(chain)
  if (!decoder) return null

  const signedFor = decoder.rawTxNetwork(attempt.rawTxHex)
  if (signedFor === null) {
    return new ReplaceRefusedError(
      `cannot decode which network attempt ${attempt.txHash} was signed for. Its absence here ` +
        'proves nothing unless the bytes belong here, so this refuses rather than assumes. ' +
        'Check the hash on a block explorer for both networks before doing anything else.',
    )
  }
  if (signedFor !== chain.network()) {
    return new ReplaceRefusedError(
      `attempt ${attempt.txHash} was signed for ${signedFor} but this process runs against ` +
        `${chain.network()}: its absence here proves nothing.`,
    )
  }
  return null
}

// ---- resume -----------------------------------------------------------------------

export type ResumeAction = 'confirmed' | 'rebroadcast' | 'waiting' | 'requeued' | 'noop'

export interface ResumeResult {
  transferId: string
  action: ResumeAction
  attemptState?: string
  intentState: string
}

/**
 * Put a stalled intent back into the normal pipeline.
 *
 * This creates no new financial liability and signs nothing: it either
 * reconciles the existing attempt against the chain (the same code the worker
 * runs) or, when there is no open attempt at all, returns the intent to
 * `queued` so the worker signs it on the next tick. Safe to run repeatedly.
 */
export async function resumeTransfer(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
  transferId: string,
): Promise<ResumeResult> {
  // Every chain-touching command binds first (finding 6): reconciling a mainnet
  // attempt against a testnet node would rebroadcast bytes into the void and
  // report "waiting" forever.
  await ensureNetworkBinding(pool, chain)

  const intent = await loadIntent(pool, transferId)
  if (intent.state === 'confirmed') {
    return { transferId, action: 'noop', intentState: intent.state }
  }

  const [open] = await loadOpenAttempts(pool, transferId)

  if (!open) {
    await pool.query(
      `UPDATE outgoing_transfers
       SET state = 'queued', last_error = NULL, next_attempt_at = NULL
       WHERE id = $1 AND state <> 'confirmed'`,
      [transferId],
    )
    return { transferId, action: 'requeued', intentState: 'queued' }
  }

  // Clear the operator flag first: `progressAttempt` deliberately does nothing
  // to an intent already in `manual_review` so it cannot spam alerts, and the
  // whole point of `resume` is to un-flag it. The rebroadcast cooldown is
  // cleared too — an operator asking now means now.
  await pool.query(
    `UPDATE outgoing_transfers
     SET state = 'in_progress', last_error = NULL, next_attempt_at = NULL
     WHERE id = $1 AND state <> 'confirmed'`,
    [transferId],
  )
  const [refreshed] = await loadOpenAttempts(pool, transferId)
  const target = refreshed ?? open

  await progressAttempt(pool, chain, alerts, target)

  const after = await loadLatestAttempt(pool, transferId)
  const intentAfter = await loadIntent(pool, transferId)

  let action: ResumeAction = 'waiting'
  if (after?.state === 'confirmed') action = 'confirmed'
  else if (target.state === 'signed' && after?.state === 'broadcast') action = 'rebroadcast'

  return {
    transferId,
    action,
    ...(after ? { attemptState: after.state } : {}),
    intentState: intentAfter.state,
  }
}

// ---- replace ------------------------------------------------------------------------

export interface ReplaceResult {
  transferId: string
  sequence: number
  txHash: string
  deadAttemptHash: string
  recipientAddress: string
  amountLuna: string
}

/**
 * Mark a provably dead attempt `proven_dead` and sign ONE replacement for the
 * same immutable intent.
 *
 * This is the only function in the codebase that may spend the same intent's
 * money twice, so it refuses unless EVERY part of the proof holds right now,
 * re-checked against the chain rather than trusted from an earlier reconcile:
 *
 *   - the database is bound to the network this process is talking to, and the
 *     dead attempt's own bytes were signed for that same network — and are
 *     decodable enough to say so (finding 6, round-2 F6),
 *   - the head is strictly past `validity_start_height + window`, so the signed
 *     bytes can never be included by anyone, ever again,
 *   - the worker recorded a SUSTAINED absence — at least
 *     `ABSENCE_MIN_OBSERVATIONS` consecutive not-found lookups whose series is
 *     at least `ABSENCE_MIN_SPAN_MS` old (finding 2), and
 *   - a fresh live lookup, right now, is ALSO absent (a lookup error is not
 *     absence — it refuses).
 *
 * The sustained-absence requirement is what a single not-found answer cannot
 * give: one node behind by a block, or one pico-client that lost consensus
 * mid-call, answers "not found" about a transaction that is on chain. Acting on
 * one such answer pays twice.
 *
 * **Round-2 F2 — the whole proof is evaluated UNDER THE ROW LOCKS.** Two things
 * were wrong with proving first and locking second:
 *
 *  1. *The sighting was thrown away.* When the fresh lookup found the
 *     transaction, this refused and returned — leaving the recorded absence
 *     series exactly as it was. The series had just been refuted by the chain
 *     itself and survived anyway, so it kept counting toward the observation
 *     threshold, and ONE later transient not-found answer was enough to
 *     authorise a replacement for a transaction that had been on chain the
 *     whole time. Every path here that SEES the transaction now clears the
 *     series and commits that, refusal or not.
 *  2. *The race went the wrong way.* Proof outside the lock and a re-read
 *     inside it meant a worker tick that sighted the transaction could be
 *     blocked on the very row lock this transaction held, land its
 *     `clearAbsence` immediately after the commit, and leave a landed payment
 *     marked `proven_dead` with a replacement already signed. Taking the locks
 *     BEFORE the chain lookup inverts that: a concurrent sighting either
 *     commits before we take the lock (and we read the cleared series) or waits
 *     behind us (and our own lookup, made under the lock, sees the same
 *     transaction it did).
 *
 * The cost is one chain round trip while the singleton lock is held. `replace`
 * is a rare, hand-run operator command and this is the one place in the system
 * where being wrong means paying a claimant twice, so the trade is not close.
 *
 * `signed`, `broadcast`, ambiguous, or already-confirmed prior attempts are all
 * refused. Both attempts stay in the table afterwards: the audit trail keeps
 * every hash and byte string (design §8.3).
 */
export async function replaceTransfer(
  pool: Pool,
  chain: ChainClient,
  alerts: Alerts,
  transferId: string,
  opts?: WindowOptions,
): Promise<ReplaceResult> {
  // Before ANY chain action: a testnet process must not be able to reason about
  // mainnet money (finding 6). Throws NetworkMismatchError.
  await ensureNetworkBinding(pool, chain)

  // Unlocked pre-checks. These only ever produce a REFUSAL — nothing here is
  // trusted by the decision below, which re-reads everything under the locks.
  const intent = await loadIntent(pool, transferId)
  if (intent.state === 'confirmed') {
    throw new ReplaceRefusedError(`transfer ${transferId} is already confirmed`)
  }
  if (!(await loadLatestAttempt(pool, transferId))) {
    throw new ReplaceRefusedError(
      `transfer ${transferId} has no attempt to replace — use "resume" to queue a first one`,
    )
  }

  // Read outside the transaction: holding the singleton lock across this is
  // avoidable, and a head one or two blocks stale only SHORTENS a 7200-block
  // window, which is the safe direction.
  const head = await chain.headHeight()

  const client = await pool.connect()
  let outcome: PreparedReplacement
  try {
    await client.query('BEGIN')
    outcome = await prepareReplacement(client, chain, transferId, head, opts)
    // Committed even when the answer is "no": a refusal that watched the chain
    // show us the transaction has LEARNED something, and rolling that back is
    // how the stale absence series used to survive its own refutation (F2).
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (outcome.kind === 'refuse') throw outcome.error

  // COMMITTED. Only now do the bytes leave the process.
  await broadcastStored(pool, chain, outcome.stored)

  return {
    transferId,
    sequence: outcome.stored.sequence,
    txHash: outcome.stored.txHash,
    deadAttemptHash: outcome.deadAttemptHash,
    recipientAddress: outcome.intent.recipientAddress,
    amountLuna: outcome.intent.amountLuna.toString(),
  }
}

type PreparedReplacement =
  | { kind: 'replace'; stored: StoredAttempt; deadAttemptHash: string; intent: TransferIntent }
  | { kind: 'refuse'; error: ReplaceRefusedError }

/**
 * The locked half of {@link replaceTransfer}: everything from taking the custody
 * lock to persisting the replacement, inside the caller's transaction.
 *
 * Returns refusals instead of throwing them, because a refusal may still have
 * writes worth keeping (the cleared absence series). Genuine faults — a missing
 * intent, a database error — still throw and roll the transaction back.
 */
async function prepareReplacement(
  client: PoolClient,
  chain: ChainClient,
  transferId: string,
  head: number,
  opts?: WindowOptions,
): Promise<PreparedReplacement> {
  // LOCK ORDER: custody_controls → transaction_attempts → outgoing_transfers.
  //
  // custody_controls first, like every money path, so an operator command can
  // never interleave with a worker SIGNATURE (`signNextQueued` holds the same
  // row). This deliberately does NOT use `lockControls`: pause and stale
  // reconciliation must not block recovery — they are exactly when it is needed.
  //
  // Then the ATTEMPT before the INTENT, which is the order the worker's
  // reconciliation path uses (`markBroadcast`, `confirmAttempt`: attempt row,
  // then transfer row, then claim). Recovery used to take them the other way
  // round, and once F2 made it hold both across a chain lookup that inversion
  // became a reproducible `deadlock detected` between a worker tick confirming
  // a payment and an operator running `replace` — caught by the race test
  // below. Postgres resolves a deadlock by killing one side at random, which on
  // this path is a coin flip over whether the operator or the payment survives.
  // Same order everywhere, no deadlock to resolve.
  await client.query('SELECT 1 FROM custody_controls WHERE singleton FOR UPDATE')

  // FOR UPDATE on the attempt row. From here a concurrent worker cannot write
  // to it — not its state, not its absence series — until this transaction ends.
  // Nothing can insert a NEWER attempt meanwhile either: the only two writers
  // that do (`signNextQueued` and this function) both hold custody_controls.
  const attempt = await loadLatestAttempt(client, transferId, true)
  if (!attempt) {
    return {
      kind: 'refuse',
      error: new ReplaceRefusedError(
        `transfer ${transferId} has no attempt to replace — use "resume" to queue a first one`,
      ),
    }
  }

  const { rows } = await client.query<IntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM outgoing_transfers WHERE id = $1 FOR UPDATE`,
    [transferId],
  )
  if (!rows[0]) throw new TransferNotFoundError(transferId)
  // Recipient and amount come from THIS row and nowhere else.
  const intent = toIntent(rows[0])
  if (intent.state === 'confirmed') {
    return {
      kind: 'refuse',
      error: new ReplaceRefusedError(`transfer ${transferId} was confirmed while we prepared`),
    }
  }
  if (attempt.state === 'confirmed') {
    // Confirmed IS a sighting: whatever absence was recorded before it is void.
    await clearAbsenceSeries(client, attempt.id)
    return {
      kind: 'refuse',
      error: new ReplaceRefusedError(
        `attempt ${attempt.txHash} is confirmed on chain — replacing it would pay twice`,
      ),
    }
  }

  // The bytes we are about to declare dead must themselves belong to this
  // network, and must be decodable enough to prove it (round-2 F6).
  const foreign = refuseForeignBytes(chain, attempt)
  if (foreign) return { kind: 'refuse', error: foreign }

  let evidence: Record<string, unknown> = { alreadyProvenDead: true }

  if (attempt.state !== 'proven_dead') {
    // The fresh live lookup, made while we hold the row lock (F2).
    const proof = await evaluateProvenDead(chain, attempt, head, opts)

    if (proof.unknown) {
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError(
          `cannot prove attempt ${attempt.txHash} is dead: chain lookup failed (${proof.lookupError}). ` +
            'An inconclusive lookup is not permission to replace.',
        ),
      }
    }
    if (!proof.absent) {
      // We just watched the chain hand us this transaction. Record it: the
      // series is refuted and must start again from zero (F2).
      await clearAbsenceSeries(client, attempt.id)
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError(
          `attempt ${attempt.txHash} is on chain — wait for finality or use "resume"`,
        ),
      }
    }
    if (!proof.windowPast) {
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError(
          `attempt ${attempt.txHash} can still be included: head ${proof.head} has not passed ` +
            `validity deadline ${proof.deadlineHeight}. Absence alone is never proof of death.`,
        ),
      }
    }

    // Sustained absence (finding 2). `proof.absent` above is ONE lookup, taken
    // just now under the lock; these two checks are the recorded series behind
    // it, read from the row this transaction has pinned.
    const absenceAgeMs =
      attempt.firstAbsentAt === null ? 0 : Date.now() - attempt.firstAbsentAt.getTime()
    if (attempt.absentChecks < ABSENCE_MIN_OBSERVATIONS || attempt.firstAbsentAt === null) {
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError(
          `attempt ${attempt.txHash} has only ${attempt.absentChecks} recorded absence observation(s); ` +
            `${ABSENCE_MIN_OBSERVATIONS} are required. One not-found answer is one node's opinion, ` +
            'not proof. Let the worker keep reconciling and re-run.',
        ),
      }
    }
    if (absenceAgeMs < ABSENCE_MIN_SPAN_MS) {
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError(
          `attempt ${attempt.txHash} has been absent for only ${Math.round(absenceAgeMs / 1000)}s; ` +
            `${ABSENCE_MIN_SPAN_MS / 1000}s of unbroken absence are required before it may be replaced.`,
        ),
      }
    }

    evidence = {
      ...proof,
      absentChecks: attempt.absentChecks,
      firstAbsentAt: attempt.firstAbsentAt.toISOString(),
      absenceAgeMs,
    }
  }

  if (attempt.state === 'signed' || attempt.state === 'broadcast') {
    const updated = await client.query(
      `UPDATE transaction_attempts
       SET state = 'proven_dead', last_error = $2
       WHERE id = $1 AND state IN ('signed', 'broadcast')`,
      [attempt.id, JSON.stringify({ provenDeadBy: 'recover.ts replace', ...evidence })],
    )
    if (updated.rowCount === 0) {
      // Unreachable while we hold FOR UPDATE on the row; kept because the cost
      // of being wrong about that is a second payment.
      return {
        kind: 'refuse',
        error: new ReplaceRefusedError('attempt state changed while we prepared — re-run'),
      }
    }
  }

  const stored = await signAndPersistAttempt(client, chain, intent, head)
  return { kind: 'replace', stored, deadAttemptHash: attempt.txHash, intent }
}

// ---- pause / unpause -----------------------------------------------------------------

/**
 * Engage the global kill switch and report what it left behind.
 *
 * Delegates the write to `solvency.pause` — that function is the one every
 * money path's `lockControls` is written against, and a second implementation
 * here would be a second thing to keep true. This wrapper exists only so the
 * operator sees the resulting controls rather than silence.
 *
 * Needs no `ChainClient`: pausing must work when the node is exactly the thing
 * that is broken.
 */
export async function pauseCustody(pool: Pool, reason: string): Promise<Controls> {
  await pause(pool, reason)
  return readControls(pool)
}

/**
 * Release the kill switch and report the resulting controls.
 *
 * Note what this does NOT do: it does not reconcile. If custody sat paused long
 * enough for the balance to go stale, `lockControls` keeps failing closed until
 * the worker's next `reconcile()` succeeds — unpausing is permission to resume,
 * not an assertion that the balance is known.
 */
export async function unpauseCustody(pool: Pool): Promise<Controls> {
  await unpause(pool)
  return readControls(pool)
}

// ---- deposit reconciliation report --------------------------------------------------

/**
 * Chain enumeration is NOT part of the frozen `ChainClient` interface, which
 * only answers about a hash you already know. `FakeChain` satisfies this
 * structurally; `NimiqChain` does not yet.
 *
 * TODO(Task 18, before mainnet launch): add a non-interface
 * `NimiqChain.accountTransactions(address, limit)` — the same extension shape
 * as the existing `getTransactionDetails` — most likely backed by the explorer
 * API measured in `server/spike/g0-evidence.md` §2
 * (`GET /api/v1/account-transactions/<address>/<limit>`), since the pico client
 * indexes by hash rather than by address. Until then this report is proven
 * against FakeChain only; mainnet enumeration is pending.
 */
export interface DepositSource {
  allTxs(): ChainTx[] | Promise<ChainTx[]>
}

export class DepositEnumerationUnavailableError extends RecoverError {
  constructor() {
    super(
      'deposit enumeration unavailable for this chain client: ChainClient answers by hash only. ' +
        'See the TODO in src/recover.ts — NimiqChain needs an accountTransactions() extension.',
    )
  }
}

function asDepositSource(chain: ChainClient): DepositSource | null {
  const candidate = chain as ChainClient & Partial<DepositSource>
  return typeof candidate.allTxs === 'function' ? (candidate as DepositSource) : null
}

export type DepositReason =
  /** No memo at all: an operator top-up or a stray transfer. */
  | 'no_memo'
  /** Well-formed memo naming a drop that does not exist. */
  | 'unknown_memo'
  /** Right drop, too little money — never activates (design §7). */
  | 'partial'
  /** Right drop, too much money — never activates. */
  | 'excess'
  /** Right drop and amount, but the drop is already funded by another hash. */
  | 'duplicate'
  /** Right drop and amount, but this hash was never accepted as its funding. */
  | 'late'

export interface UnmatchedDeposit {
  txHash: string
  sender: string
  valueLuna: string
  memo: string | null
  includedHeight: number
  reason: DepositReason
  dropPublicId?: string
  expectedFundingLuna?: string
}

export interface DepositReportResult {
  custodyAddress: string
  /** Deposits that ARE some drop's accepted funding transaction. */
  matchedCount: number
  unmatched: UnmatchedDeposit[]
}

/**
 * Every deposit into custody that is not some drop's accepted funding
 * transaction (design §7: "Late or accidental deposits go to a manual
 * reconciliation report").
 *
 * Matching is by ACCEPTED HASH, never by memo — a memo scan is explicitly
 * banned as an activation mechanism, and this report must not imply otherwise.
 * The reasons are diagnostic only; nothing here moves money or activates
 * anything. Refunding any of these is a deliberate operator act.
 */
export async function depositReport(
  pool: Pool,
  chain: ChainClient,
): Promise<DepositReportResult> {
  await ensureNetworkBinding(pool, chain)

  const source = asDepositSource(chain)
  if (!source) throw new DepositEnumerationUnavailableError()

  const custody = chain.custodyAddress()
  const txs = await source.allTxs()

  const { rows } = await pool.query<{
    public_id: string
    expected_funding_luna: string
    funding_tx_hash: string | null
  }>('SELECT public_id, expected_funding_luna, funding_tx_hash FROM drops')

  const byPublicId = new Map(rows.map((r) => [r.public_id, r]))
  const acceptedHashes = new Set(
    rows.filter((r) => r.funding_tx_hash !== null).map((r) => r.funding_tx_hash as string),
  )

  const unmatched: UnmatchedDeposit[] = []
  let matchedCount = 0

  for (const tx of txs) {
    if (tx.recipient !== custody) continue // outgoing payments are not deposits
    if (tx.sender === custody) continue
    if (!tx.executionOk) continue

    if (acceptedHashes.has(tx.hash)) {
      matchedCount += 1
      continue
    }

    const base = {
      txHash: tx.hash,
      sender: tx.sender,
      valueLuna: tx.valueLuna.toString(),
      memo: tx.dataUtf8,
      includedHeight: tx.includedHeight,
    }

    if (!tx.dataUtf8 || !tx.dataUtf8.startsWith(MEMO_PREFIX)) {
      unmatched.push({ ...base, reason: 'no_memo' })
      continue
    }

    const publicId = tx.dataUtf8.slice(MEMO_PREFIX.length)
    const drop = byPublicId.get(publicId)
    if (!drop) {
      unmatched.push({ ...base, reason: 'unknown_memo' })
      continue
    }

    const expected = BigInt(drop.expected_funding_luna)
    const withDrop = {
      ...base,
      dropPublicId: publicId,
      expectedFundingLuna: expected.toString(),
    }
    if (tx.valueLuna < expected) unmatched.push({ ...withDrop, reason: 'partial' })
    else if (tx.valueLuna > expected) unmatched.push({ ...withDrop, reason: 'excess' })
    else if (drop.funding_tx_hash !== null) unmatched.push({ ...withDrop, reason: 'duplicate' })
    else unmatched.push({ ...withDrop, reason: 'late' })
  }

  return { custodyAddress: custody, matchedCount, unmatched }
}

// ---- solvency snapshot (shared by `float show` and `status`) -----------------------------

/**
 * The chain half of an operator report.
 *
 * Reads NEVER fail on a chain problem — an on-call operator asking what is
 * going on must always get a screen, and the reason the chain half is missing
 * is itself the most interesting line on it. The reason is printed verbatim
 * (including a `NetworkMismatchError`, which is exactly what you want to see
 * spelled out), so a degraded report is never mistaken for a healthy one.
 *
 * `float set` takes the opposite stance: see `ChainUnavailableError`.
 */
export type ChainView =
  | {
      available: true
      network: NetworkName
      custodyAddress: string
      headHeight: number
      confirmedBalanceLuna: string
      /**
       * `ledger − chain`. Positive means the books claim MORE than custody
       * holds — the direction `reconcile()` pauses on. Negative is normal:
       * operator top-ups and not-yet-activated funding both sit in custody
       * without a ledger entry.
       */
      ledgerMinusChainLuna: string
    }
  | { available: false; degraded: true; reason: string }

/** Every solvency number an operator needs, all from one consistent read. */
export interface SolvencyView {
  paused: boolean
  network: NetworkName | null
  operatorFloatLuna: string
  ledgerMovementsLuna: string
  ledgerBalanceLuna: string
  outstandingPrincipalLuna: string
  inFlightOutgoingLuna: string
  feeReserveLuna: string
  maxLivePrincipalLuna: string
  /** `ledger − outstanding − fee reserve`. Negative = every money path fails closed. */
  solvencyHeadroomLuna: string
  /** `cap − outstanding`. New principal beyond this is refused by the cap. */
  livePrincipalHeadroomLuna: string
  lastReconciledAt: string | null
  lastReconciledHeight: number | null
  /** Chain balance as of the last `reconcile()`; `null` before the first one. */
  lastReconciledChainBalanceLuna: string | null
  /** True when `lockControls` would refuse on staleness right now. */
  reconciliationStale: boolean
  /**
   * Sum of the finalized deposits the float is attributed to (round-2 F4).
   * `float set` keeps this equal to `operatorFloatLuna`.
   */
  attestedFloatDepositsLuna: string
  /**
   * False when the float does not equal the deposits backing it — money the
   * books credit that nothing on chain has been pointed at. Only a
   * hand-written UPDATE, or migration 006's fail-closed zeroing of a float
   * attested under the old unattributable rule, can produce it.
   */
  floatAttributed: boolean
  /**
   * When the chain was last seen holding less than the ledger, `null` once a
   * reconciliation has succeeded since (round-2 N3). Non-null means every money
   * path is failing closed and `unpause` will NOT change that.
   */
  shortfallDetectedAt: string | null
}

interface LedgerSnapshot {
  controls: Controls
  ledgerLuna: bigint
  view: SolvencyView
}

/**
 * Run `read` inside one REPEATABLE READ, READ ONLY transaction.
 *
 * The float, the movements and the outstanding principal are three separate
 * aggregates over tables the worker is writing to. Read in autocommit they can
 * come from three different instants, and a report that shows a payout removed
 * from one side but not yet from the other invents a shortfall that never
 * existed. One snapshot, one instant. READ ONLY makes that structural rather
 * than a promise, and no lock is taken: reporting must never block a payout.
 */
async function inSnapshot<T>(pool: Pool, read: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const value = await read(client)
    await client.query('COMMIT')
    return value
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Every derived solvency figure, from an already-consistent read. */
function toSolvencyView(o: {
  controls: Controls
  movementsLuna: bigint
  outstandingLuna: bigint
  inFlightLuna: bigint
  attestedDepositsLuna: bigint
}): SolvencyView {
  const { controls } = o
  const ledgerLuna = controls.operatorFloatLuna + o.movementsLuna
  return {
    paused: controls.paused,
    network: controls.network,
    operatorFloatLuna: controls.operatorFloatLuna.toString(),
    ledgerMovementsLuna: o.movementsLuna.toString(),
    ledgerBalanceLuna: ledgerLuna.toString(),
    outstandingPrincipalLuna: o.outstandingLuna.toString(),
    inFlightOutgoingLuna: o.inFlightLuna.toString(),
    feeReserveLuna: controls.configuredFeeReserveLuna.toString(),
    maxLivePrincipalLuna: controls.maxLivePrincipalLuna.toString(),
    solvencyHeadroomLuna: (
      ledgerLuna -
      o.outstandingLuna -
      controls.configuredFeeReserveLuna
    ).toString(),
    livePrincipalHeadroomLuna: (controls.maxLivePrincipalLuna - o.outstandingLuna).toString(),
    lastReconciledAt: controls.lastReconciledAt?.toISOString() ?? null,
    lastReconciledHeight: controls.lastReconciledHeight,
    lastReconciledChainBalanceLuna: controls.reconciledConfirmedBalanceLuna?.toString() ?? null,
    reconciliationStale:
      controls.lastReconciledAt === null ||
      Date.now() - controls.lastReconciledAt.getTime() > RECONCILIATION_MAX_AGE_MS,
    attestedFloatDepositsLuna: o.attestedDepositsLuna.toString(),
    floatAttributed: o.attestedDepositsLuna === controls.operatorFloatLuna,
    shortfallDetectedAt: controls.shortfallDetectedAt?.toISOString() ?? null,
  }
}

/**
 * Principal plus fee of every outgoing attempt whose money could still leave
 * custody — anything not yet `confirmed` and not yet `proven_dead` (round-3 R6).
 *
 * Deliberately broader than `inFlightOutgoingLuna`: that function answers "what
 * can EXPLAIN a chain balance below the books", so it only counts attempts
 * whose bytes provably reached the network and are still includable. This one
 * answers a different and stricter question — "what could still be taken out of
 * the balance I am about to attest against" — and for that, an attempt whose
 * bytes may or may not have been broadcast must be assumed broadcast, and an
 * attempt near its validity deadline must be assumed includable. Over-counting
 * makes the float smaller, which is the only direction an attestation is
 * allowed to be wrong in.
 */
async function committedOutflowLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ luna: string }>(
    `SELECT COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS luna
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE a.state IN ('signed', 'broadcast')`,
  )
  return BigInt(rows[0].luna)
}

/** Total of the finalized deposits `float set` has attributed the float to. */
export async function attestedFloatDepositsLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ luna: string }>(
    'SELECT COALESCE(SUM(value_luna), 0)::BIGINT AS luna FROM operator_float_deposits',
  )
  return BigInt(rows[0].luna)
}

async function readSolvency(db: PoolClient): Promise<LedgerSnapshot> {
  const controls = await readControls(db)
  const movementsLuna = await ledgerMovementsLuna(db)
  const outstandingLuna = await outstandingPrincipalLuna(db)
  // Reported against the last reconciled head rather than a fresh chain read:
  // this snapshot is READ ONLY and must not depend on a reachable node (round-3
  // R4 made the in-flight window a height comparison). `0` before the first
  // reconciliation is the inclusive end of that scale — every attempt still
  // counts as in flight, which over-reports rather than under-reports.
  const inFlightLuna = await inFlightOutgoingLuna(db, controls.lastReconciledHeight ?? 0)
  const attestedDepositsLuna = await attestedFloatDepositsLuna(db)
  return {
    controls,
    ledgerLuna: controls.operatorFloatLuna + movementsLuna,
    view: toSolvencyView({
      controls,
      movementsLuna,
      outstandingLuna,
      inFlightLuna,
      attestedDepositsLuna,
    }),
  }
}

const NO_CHAIN_CLIENT =
  'no chain client: this command was run without one (set NIMIQ_NETWORK and ' +
  'CUSTODY_PRIVATE_KEY_HEX to include the on-chain custody balance)'

/** A chain client that has passed `ensureNetworkBinding`, or the reason it has not. */
type BoundChain = { chain: ChainClient } | { chain: null; reason: string }

/**
 * Bind the chain BEFORE the report's database snapshot is taken — the same
 * first move every other chain-touching command makes (finding 6), and the
 * reason `network` is populated on the very first run against a fresh database.
 *
 * A binding failure degrades the report rather than aborting it: a mismatch
 * message is the single most useful line an operator can be shown, and
 * withholding the rest of the screen would help nobody.
 */
async function bindChainForReport(
  pool: Pool,
  chain: ChainClient | null,
  unavailableReason?: string,
): Promise<BoundChain> {
  if (!chain) return { chain: null, reason: unavailableReason ?? NO_CHAIN_CLIENT }
  try {
    await ensureNetworkBinding(pool, chain)
    return { chain }
  } catch (err) {
    return { chain: null, reason: errorMessage(err) }
  }
}

/** Chain figures for a read-only report. Degrades, never throws. */
async function readChainView(bound: BoundChain, ledgerLuna: bigint): Promise<ChainView> {
  if (bound.chain === null) {
    return { available: false, degraded: true, reason: bound.reason }
  }
  const { chain } = bound
  try {
    const custodyAddress = chain.custodyAddress()
    const headHeight = await chain.headHeight()
    const confirmedLuna = await chain.confirmedBalanceLuna(custodyAddress)
    return {
      available: true,
      network: chain.network(),
      custodyAddress,
      headHeight,
      confirmedBalanceLuna: confirmedLuna.toString(),
      ledgerMinusChainLuna: (ledgerLuna - confirmedLuna).toString(),
    }
  } catch (err) {
    return { available: false, degraded: true, reason: errorMessage(err) }
  }
}

// ---- float show / float set ---------------------------------------------------------------

/** The operator float argument was not a positive whole number of luna. */
export class InvalidLunaError extends RecoverError {}

/** The attestation would claim custody holds more than the chain says it does. */
export class OverAttestationError extends RecoverError {}

/** The float may not be written from a guess about the chain. */
export class ChainUnavailableError extends RecoverError {}

/** Why a `--tx` hash cannot back the operator float (round-2 F4). */
export type DepositRejectionCode =
  /** No `--tx <hash>` was supplied at all. */
  | 'missing_tx'
  /** The chain does not have that hash as an included transaction. */
  | 'not_found'
  /** Included, but not yet behind this deployment's finality depth. */
  | 'not_final'
  /** Included and failed: it moved nothing. */
  | 'execution_failed'
  /** Paid to somewhere other than the custody address. */
  | 'wrong_recipient'
  /** Custody paying itself is a fee, not an inbound float. */
  | 'self_transfer'
  /** Already counted as some drop's funding: that money belongs to claimants. */
  | 'drop_funding'
  /**
   * Carries a `ND1:` funding memo. A memo-bearing deposit is drop funding by
   * construction, whether or not the drop it names has been activated yet
   * (round-3 R2).
   */
  | 'drop_memo'
  /** Already backs the float: counting it twice would double the attestation. */
  | 'already_attested'
  /** The requested float is not the sum of the deposits backing it. */
  | 'float_mismatch'

/**
 * The float may not be attested against this transaction.
 *
 * Every rejection below is a way of saying the same thing: the operator asked
 * the books to credit money that this specific transaction does not put into
 * custody, and an attestation that cannot be refused is not an attestation.
 */
export class DepositAttestationError extends RecoverError {
  constructor(
    readonly code: DepositRejectionCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Parse an operator-supplied luna amount.
 *
 * Digits only, and strictly positive. `BigInt('0x10')`, `BigInt(' 12 ')` and
 * `BigInt('1_000')` all succeed and all mean something the operator did not
 * type, so the regex — not the constructor — is the gate. `1.5` and `1e5` are
 * refused rather than rounded: luna is the atomic unit and there is nothing
 * below it to round to.
 */
export function parsePositiveLuna(text: string): bigint {
  if (!/^[0-9]+$/.test(text)) {
    throw new InvalidLunaError(
      `operator float must be a whole positive number of luna (got ${JSON.stringify(text)}). ` +
        '1 NIM = 100000 luna; no decimals, no separators, no sign.',
    )
  }
  const luna = BigInt(text)
  if (luna <= 0n) {
    throw new InvalidLunaError('operator float must be greater than zero luna')
  }
  return luna
}

export interface FloatShowResult {
  command: 'float show'
  solvency: SolvencyView
  chain: ChainView
}

/**
 * Read-only: the float attestation next to everything that judges it.
 *
 * Takes no lock. The DB numbers come from one REPEATABLE READ snapshot so they
 * agree with each other; the chain number is fetched after it and is therefore
 * a moment younger, which is stated by `headHeight` rather than hidden.
 */
export async function floatShow(
  pool: Pool,
  chain: ChainClient | null,
  chainUnavailableReason?: string,
): Promise<FloatShowResult> {
  const bound = await bindChainForReport(pool, chain, chainUnavailableReason)
  const snapshot = await inSnapshot(pool, readSolvency)
  return {
    command: 'float show',
    solvency: snapshot.view,
    chain: await readChainView(bound, snapshot.ledgerLuna),
  }
}

export interface AttestedDeposit {
  txHash: string
  valueLuna: string
  includedHeight: number
}

export interface FloatSetResult {
  command: 'float set'
  network: NetworkName
  headHeight: number
  /** The deposit this run attributed the float to. */
  deposit: AttestedDeposit
  /** Sum of every deposit backing the float afterwards; equals `operatorFloatLuna.after`. */
  attestedFloatDepositsLuna: string
  operatorFloatLuna: { before: string; after: string }
  ledgerBalanceLuna: { before: string; after: string }
  /** `ledger − outstanding − fee reserve`: negative means money paths stay closed. */
  solvencyHeadroomLuna: { before: string; after: string }
  outstandingPrincipalLuna: string
  feeReserveLuna: string
  chainConfirmedBalanceLuna: string
  ledgerMinusChainLuna: { before: string; after: string }
}

/**
 * Prove that `txHash` is a finalized deposit that really put money into custody.
 *
 * Every predicate here is one way the old, hash-less attestation could be
 * wrong. `getAccount`'s head-state balance — the only thing the float used to
 * be checked against — answers "custody holds this much RIGHT NOW", which
 * includes credits that are not final, credits a reorg can remove, and the
 * drops' own funding sitting in the same wallet. None of those are the
 * operator's float, and all of them made a larger float look honest.
 *
 * A lookup that ERRORS is a `ChainUnavailableError`, not a rejection: "we could
 * not ask" must never reach a money decision as "the answer is no" — nor, more
 * dangerously, as "the answer is yes".
 */
async function proveFloatDeposit(
  chain: ChainClient,
  txHash: string,
  head: number,
): Promise<ChainTx> {
  let tx: ChainTx | null
  try {
    tx = await chain.getTransaction(txHash)
  } catch (err) {
    throw new ChainUnavailableError(
      `refusing to attest the operator float: could not look up deposit ${txHash} ` +
        `(${errorMessage(err)}). An inconclusive lookup is not evidence of a deposit.`,
    )
  }

  if (!tx) {
    throw new DepositAttestationError(
      'not_found',
      `no included transaction ${txHash} on ${chain.network()}. A deposit that the chain cannot ` +
        'show us is not money in custody — wait for it to be included, then re-run.',
    )
  }
  if (!tx.executionOk) {
    throw new DepositAttestationError(
      'execution_failed',
      `transaction ${txHash} is on chain but did not execute: it moved nothing into custody.`,
    )
  }
  if (tx.recipient !== chain.custodyAddress()) {
    throw new DepositAttestationError(
      'wrong_recipient',
      `transaction ${txHash} paid ${tx.recipient}, not the custody address ` +
        `${chain.custodyAddress()}. The float may only be attested against money paid INTO custody.`,
    )
  }
  if (tx.sender === chain.custodyAddress()) {
    throw new DepositAttestationError(
      'self_transfer',
      `transaction ${txHash} was sent BY custody: it moves no new money in, it only spends fees.`,
    )
  }
  if (!chain.isFinal(tx, head)) {
    throw new DepositAttestationError(
      'not_final',
      `deposit ${txHash} was included at height ${tx.includedHeight} and is not yet final at head ` +
        `${head}. A credit that a reorg can still remove must not become spendable capacity.`,
    )
  }
  // Round-3 R2. A deposit carrying a funding memo is drop money by
  // construction: the sponsor addressed it to a drop, and `submitFunding` will
  // credit it to that drop's principal the moment the hash is submitted —
  // which can happen long after this command runs, because activation is driven
  // by the client. Attesting it as float credits the same luna twice, and the
  // drop-funding check below cannot catch it because `funding_tx_hash` is not
  // set yet. The memo does not even have to name a drop that exists: an
  // operator's own float is sent WITHOUT a memo, so a memo here means the money
  // was not the operator's to claim.
  if (tx.dataUtf8 !== null && tx.dataUtf8.startsWith(MEMO_PREFIX)) {
    throw new DepositAttestationError(
      'drop_memo',
      `transaction ${txHash} carries the funding memo "${tx.dataUtf8}": it was sent to fund a drop, ` +
        'not as operator float, and crediting it here would count the same luna twice once the ' +
        'drop is activated. Operator float is deposited with NO memo.',
    )
  }
  return tx
}

/**
 * Re-attest the operator float — the one ledger credit the drops cannot supply
 * (migration 004, G1 review finding 4) — and ATTRIBUTE it to a named, finalized
 * deposit (migration 006, round-2 review F4). A fresh database fails closed as
 * insolvent until this runs, because the fee reserve is spent out of money no
 * drop ever deposited.
 *
 * The float is an ATTESTATION, and the only thing that makes an attestation
 * worth anything is that it can be refused. So:
 *
 *  - **a deposit hash is mandatory.** Round 1 checked the requested float only
 *    against `getAccount`'s head-state balance, which is not finality-proven,
 *    is not attributable to anything, and contains the drops' own funding.
 *    Every luna of the float now points at a transaction an auditor can open on
 *    a block explorer, and `operator_float_luna` must equal the sum of those
 *    transactions — see {@link proveFloatDeposit} for what each one must prove;
 *  - **a chain client is mandatory**, and an unreachable node is a refusal
 *    rather than a guess. Writing a float against a balance we could not read
 *    is exactly the failure the attestation exists to prevent;
 *  - **the resulting LEDGER balance may not exceed the chain's confirmed
 *    custody balance.** Over-attesting invents spendable capacity, and the
 *    invariant would then authorise payouts against money that is not there — a
 *    stranded campaign whose claimants cannot be paid;
 *  - **the write happens under the singleton `custody_controls` lock**, in the
 *    same lock order as every money path, so it cannot interleave with an
 *    activation or a signature that is reading the float it is about to change.
 *
 * The over-attestation bound is deliberately STRICTER than `reconcile()`'s
 * cross-check, which tolerates `chain >= ledger − in-flight`. In-flight money is
 * money already committed to leaving; treating it as headroom for a fresh
 * attestation would let the float ratchet up on payments that have not settled.
 * An operator who genuinely has more in custody can re-run once they confirm.
 *
 * **Round-2 N2 — the bound is applied to a balance read INSIDE the lock.** The
 * chain balance used to be read before the lock was taken, and the comment
 * arguing that was safe was wrong: between the read and the write, an in-flight
 * payout could CONFIRM, dropping the real custody balance below the number the
 * bound was checked against, and the over-attestation the bound exists to
 * refuse went through. There are now two reads and they do different jobs. The
 * first is a probe: it fails fast on an unreachable node so a dead RPC cannot
 * stall every payout behind the singleton lock for a timeout. The second, taken
 * after the lock is held, is the only one the money decision uses.
 *
 * Deliberately NOT via `lockControls`: attesting the float is precisely what an
 * operator does while the system is paused, insolvent or stale, so a
 * fail-closed read here would make the system unable to unstick itself.
 */
export async function setOperatorFloat(
  pool: Pool,
  chain: ChainClient,
  lunaArgument: string,
  depositTxHash?: string,
): Promise<FloatSetResult> {
  await ensureNetworkBinding(pool, chain)
  const nextFloatLuna = parsePositiveLuna(lunaArgument)

  const txHash = depositTxHash?.trim()
  if (!txHash) {
    throw new DepositAttestationError(
      'missing_tx',
      'refusing to set the operator float without --tx <deposit hash>. The float is a claim that ' +
        'specific money is in custody; it may only be attested against a finalized deposit this ' +
        'system can verify for itself. Usage: float set <luna> --tx <hash>.',
    )
  }

  // Probe, OUTSIDE the lock: an unreachable node must not be discovered while
  // holding the row every payout needs. Nothing decided here is trusted below.
  try {
    await chain.headHeight()
  } catch (err) {
    throw new ChainUnavailableError(
      `refusing to set the operator float: the chain is unreachable (${errorMessage(err)}). ` +
        'The float attests to money that is really in custody; it may not be written from a guess.',
    )
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // custody_controls first — the mandated lock order for every money path.
    await client.query('SELECT 1 FROM custody_controls WHERE singleton FOR UPDATE')

    // N2: the authoritative chain reads, taken with the lock held. A payout that
    // confirms from here on cannot land between them and the write.
    let headHeight: number
    let chainConfirmedLuna: bigint
    try {
      headHeight = await chain.headHeight()
      chainConfirmedLuna = await chain.confirmedBalanceLuna(chain.custodyAddress())
    } catch (err) {
      throw new ChainUnavailableError(
        `refusing to set the operator float: the chain is unreachable (${errorMessage(err)}). ` +
          'The float attests to money that is really in custody; it may not be written from a guess.',
      )
    }

    const deposit = await proveFloatDeposit(chain, txHash, headHeight)

    // That money must not already be spoken for. A drop's funding belongs to
    // its claimants and is already credited to the ledger by `activate()`;
    // counting it again as float would credit the same luna twice.
    const { rows: funding } = await client.query<{ public_id: string }>(
      'SELECT public_id FROM drops WHERE funding_tx_hash = $1',
      [txHash],
    )
    if (funding[0]) {
      throw new DepositAttestationError(
        'drop_funding',
        `transaction ${txHash} is the accepted funding of drop ${funding[0].public_id}: that money ` +
          'is owed to its claimants and is already in the ledger. It cannot also be operator float.',
      )
    }

    const before = await readControls(client)
    const movementsLuna = await ledgerMovementsLuna(client)
    const outstandingLuna = await outstandingPrincipalLuna(client)

    const beforeLedgerLuna = before.operatorFloatLuna + movementsLuna
    const afterLedgerLuna = nextFloatLuna + movementsLuna

    // ROUND-3 R6 — the bound is made CONSERVATIVE rather than raced.
    //
    // Round 2 moved the chain read inside the lock, which was necessary and not
    // sufficient: the lock cannot stop an already-broadcast transaction from
    // being included by the network. Between this read and the write, a payout
    // that was in flight can land, custody's real balance drops, and a float
    // that was honest against the number we read is over-attested against the
    // number that is now true. No amount of locking fixes that — the other
    // party to the race is the chain.
    //
    // So the bound stops racing and starts assuming the worst: every attempt
    // that could still land is subtracted from the usable balance IN FULL,
    // principal and fee, whether or not it has landed yet.
    //
    //  - if it has NOT landed, the chain balance still holds that money and we
    //    are refusing to count money that is about to leave;
    //  - if it HAS landed, the chain balance no longer holds it and we subtract
    //    it a second time — a strictly tighter bound.
    //
    // Either way a landing transaction can only make this attestation MORE
    // conservative, never less, which is the property the lock could not
    // provide. `confirmed` attempts are excluded because both sides already
    // account for them (the chain has debited them and `ledgerMovements`
    // subtracts them); `proven_dead` attempts are excluded because an operator
    // has already proven they can never be included.
    const pendingOutflowLuna = await committedOutflowLuna(client)
    const usableChainLuna = chainConfirmedLuna - pendingOutflowLuna

    if (afterLedgerLuna > usableChainLuna) {
      const largestHonest = usableChainLuna - movementsLuna
      throw new OverAttestationError(
        `refusing to attest an operator float of ${nextFloatLuna} luna: it would put the ledger ` +
          `balance at ${afterLedgerLuna} luna while the chain confirms only ${chainConfirmedLuna} ` +
          `luna in custody ${chain.custodyAddress()} at height ${headHeight}, of which ` +
          `${pendingOutflowLuna} luna is committed to outgoing attempts that can still land. The ` +
          `largest honest float right now is ${largestHonest > 0n ? largestHonest : 0n} luna. ` +
          'Deposit the money first, or wait for the open attempts to settle, then attest it.',
      )
    }

    // One row per hash (migration 006's primary key). `ON CONFLICT DO NOTHING`
    // makes "already counted" a rowCount, not a race.
    const inserted = await client.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [txHash, deposit.valueLuna.toString(), deposit.includedHeight.toString(), chain.network()],
    )
    if (inserted.rowCount === 0) {
      throw new DepositAttestationError(
        'already_attested',
        `deposit ${txHash} already backs the operator float. Attesting it twice would credit the ` +
          'same luna twice. Run "float show" to see the deposits currently counted.',
      )
    }

    const attestedLuna = await attestedFloatDepositsLuna(client)
    if (nextFloatLuna !== attestedLuna) {
      throw new DepositAttestationError(
        'float_mismatch',
        `refusing a float of ${nextFloatLuna} luna: the deposits backing it total ${attestedLuna} ` +
          `luna (this deposit contributes ${deposit.valueLuna}). The float must be exactly the sum ` +
          'of the deposits it is attributed to — attest each deposit and pass the running total.',
      )
    }

    await client.query('UPDATE custody_controls SET operator_float_luna = $1 WHERE singleton', [
      nextFloatLuna.toString(),
    ])
    await client.query('COMMIT')

    const headroom = (ledger: bigint): string =>
      (ledger - outstandingLuna - before.configuredFeeReserveLuna).toString()

    return {
      command: 'float set',
      network: chain.network(),
      headHeight,
      deposit: {
        txHash,
        valueLuna: deposit.valueLuna.toString(),
        includedHeight: deposit.includedHeight,
      },
      attestedFloatDepositsLuna: attestedLuna.toString(),
      operatorFloatLuna: {
        before: before.operatorFloatLuna.toString(),
        after: nextFloatLuna.toString(),
      },
      ledgerBalanceLuna: {
        before: beforeLedgerLuna.toString(),
        after: afterLedgerLuna.toString(),
      },
      solvencyHeadroomLuna: {
        before: headroom(beforeLedgerLuna),
        after: headroom(afterLedgerLuna),
      },
      outstandingPrincipalLuna: outstandingLuna.toString(),
      feeReserveLuna: before.configuredFeeReserveLuna.toString(),
      chainConfirmedBalanceLuna: chainConfirmedLuna.toString(),
      ledgerMinusChainLuna: {
        before: (beforeLedgerLuna - chainConfirmedLuna).toString(),
        after: (afterLedgerLuna - chainConfirmedLuna).toString(),
      },
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---- status ---------------------------------------------------------------------------

/** `state -> row count` for one table. States with no rows are absent. */
export type StateCounts = Record<string, number>

export interface ManualReviewTransfer {
  transferId: string
  purpose: 'payout' | 'refund'
  dropId: string
  claimId: string | null
  amountLuna: string
  createdAt: string
  ageSeconds: number
  lastError: string | null
}

export interface OpenAttemptSummary {
  attemptId: string
  transferId: string
  sequence: number
  state: 'signed' | 'broadcast'
  txHash: string
  validityStartHeight: number
  absentChecks: number
  createdAt: string
  ageSeconds: number
}

export interface StatusResult {
  command: 'status'
  paused: boolean
  network: NetworkName | null
  solvency: SolvencyView
  chain: ChainView
  counts: {
    drops: StateCounts
    claims: StateCounts
    outgoingTransfers: StateCounts
    transactionAttempts: StateCounts
  }
  /** Oldest first: an on-call operator triages by age. */
  manualReviewTransfers: ManualReviewTransfer[]
  /** Oldest `signed`/`broadcast` attempt, i.e. the longest-unsettled payment. */
  oldestOpenAttempt: OpenAttemptSummary | null
}

/**
 * `count(*)` is int8, and `db/pool.ts` keeps int8 as a string so luna can never
 * become a float. Cast to int4 in SQL so a COUNT comes back as a number without
 * weakening that parser for the values that matter.
 */
async function stateCounts(db: PoolClient, table: string): Promise<StateCounts> {
  const { rows } = await db.query<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM ${table} GROUP BY state ORDER BY state`,
  )
  return Object.fromEntries(rows.map((r) => [r.state, r.n]))
}

/**
 * The first thing an on-call operator runs (HACKATHON.md §8).
 *
 * One read-only screen: is custody paused, which chain is it bound to, does the
 * ledger still cover its liabilities, how much work is in each state, what has
 * been flagged for a human, and what has been stuck the longest. Never throws
 * on a chain problem — a node that is down is a fact to print, not a reason to
 * withhold the whole report.
 *
 * Recipient addresses are deliberately omitted from the manual-review list
 * (§8: "logs omit ... full wallet addresses"). The ids are what an operator
 * feeds to `resume` or `replace`, and those two read the address themselves,
 * from the immutable intent row.
 */
export async function statusReport(
  pool: Pool,
  chain: ChainClient | null,
  chainUnavailableReason?: string,
): Promise<StatusResult> {
  const bound = await bindChainForReport(pool, chain, chainUnavailableReason)
  const snapshot = await inSnapshot(pool, async (db) => {
    const solvency = await readSolvency(db)

    const counts = {
      drops: await stateCounts(db, 'drops'),
      claims: await stateCounts(db, 'claims'),
      outgoingTransfers: await stateCounts(db, 'outgoing_transfers'),
      transactionAttempts: await stateCounts(db, 'transaction_attempts'),
    }

    const { rows: flagged } = await db.query<{
      id: string
      purpose: 'payout' | 'refund'
      drop_id: string
      claim_id: string | null
      amount_luna: string
      last_error: string | null
      created_at: Date
      age_seconds: number
    }>(
      `SELECT id, purpose, drop_id, claim_id, amount_luna, last_error, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
       FROM outgoing_transfers
       WHERE state = 'manual_review'
       ORDER BY created_at ASC`,
    )

    const { rows: open } = await db.query<{
      id: string
      transfer_id: string
      sequence: number
      state: 'signed' | 'broadcast'
      tx_hash: string
      validity_start_height: string
      absent_checks: number
      created_at: Date
      age_seconds: number
    }>(
      `SELECT id, transfer_id, sequence, state, tx_hash, validity_start_height, absent_checks,
              created_at, EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
       FROM transaction_attempts
       WHERE state IN ('signed', 'broadcast')
       ORDER BY created_at ASC
       LIMIT 1`,
    )

    return { solvency, counts, flagged, open: open[0] ?? null }
  })

  return {
    command: 'status',
    paused: snapshot.solvency.view.paused,
    network: snapshot.solvency.view.network,
    solvency: snapshot.solvency.view,
    chain: await readChainView(bound, snapshot.solvency.ledgerLuna),
    counts: snapshot.counts,
    manualReviewTransfers: snapshot.flagged.map((r) => ({
      transferId: r.id,
      purpose: r.purpose,
      dropId: r.drop_id,
      claimId: r.claim_id,
      amountLuna: r.amount_luna,
      createdAt: r.created_at.toISOString(),
      ageSeconds: r.age_seconds,
      lastError: r.last_error,
    })),
    oldestOpenAttempt: snapshot.open && {
      attemptId: snapshot.open.id,
      transferId: snapshot.open.transfer_id,
      sequence: snapshot.open.sequence,
      state: snapshot.open.state,
      txHash: snapshot.open.tx_hash,
      validityStartHeight: Number(snapshot.open.validity_start_height),
      absentChecks: snapshot.open.absent_checks,
      createdAt: snapshot.open.created_at.toISOString(),
      ageSeconds: snapshot.open.age_seconds,
    },
  }
}

// ---- CLI -------------------------------------------------------------------------------

export const USAGE = `NimDrops operator recovery CLI (design §10.3).

usage:
  pnpm tsx src/recover.ts <command> [argument]

commands:
  status
      One-screen incident snapshot: pause switch, bound network, solvency
      numbers, per-state row counts, manual_review transfers and the oldest
      unsettled attempt. Read-only; run this one first.
      example: pnpm tsx src/recover.ts status

  resume <transferId>
      Reconcile an existing intent against the chain, or re-queue it when it has
      no open attempt. Signs nothing new; cannot change recipient or amount.
      example: pnpm tsx src/recover.ts resume 3f0c9a3e-7b1e-4c2a-9c1a-2b7d5e8f0a11

  replace <transferId>
      Sign ONE replacement for a PROVEN DEAD attempt, same recipient and amount.
      Refuses unless sustained absence and a passed validity window both hold.
      example: pnpm tsx src/recover.ts replace 3f0c9a3e-7b1e-4c2a-9c1a-2b7d5e8f0a11

  deposits
      Custody deposits that are no drop's accepted funding transaction: late,
      partial, excess, duplicate, unknown-memo and no-memo (design §7).
      example: pnpm tsx src/recover.ts deposits

  float show
      Print the operator float attestation beside the ledger balance, the
      outstanding principal, the fee reserve, the caps and the on-chain custody
      balance. Read-only.
      example: pnpm tsx src/recover.ts float show

  float set <luna> --tx <hash>
      Re-attest the operator float, in whole positive luna, ATTRIBUTED to a
      finalized custody deposit. --tx is mandatory: the hash must be final, paid
      to custody, not any drop's funding and not already attested, and <luna>
      must equal the sum of every deposit backing the float. Also refuses any
      value that would push the ledger balance above the on-chain custody
      balance, and refuses outright when the chain cannot be read.
      example: pnpm tsx src/recover.ts float set 100000 --tx 9f3c...e1

  pause <reason>
      Engage the global kill switch: every new money path fails closed. Needs no
      chain node — pausing must work when the node is the thing that broke.
      example: pnpm tsx src/recover.ts pause "node desync during payout batch"

  unpause
      Release the kill switch. Does not reconcile: a stale balance keeps failing
      closed until the worker's next successful reconcile.
      example: pnpm tsx src/recover.ts unpause

  --help
      Print this block. Also printed, to stderr, on an unrecognised command.

exit codes:
  0   the command did its work. For a money command that means the change is
      COMMITTED — do not re-run it.
  1   the command ran and REFUSED, or failed cleanly. It signed and broadcast
      nothing; re-running will refuse the same way until the reason changes.
  2   usage error. Nothing was contacted at all.
  3   the run stopped BEFORE the work started — no database, no chain client, or
      consensus was not established in time. Nothing was read and nothing was
      written; it is safe to re-run.
  4   the outcome is UNKNOWN: the process was killed by a fault while the work
      was in flight. Run "status" and check the effect before re-running.

Whatever happens, the LAST line on stdout is one JSON object
{"event":"recover_result", ...} carrying an explicit "ok" boolean, the "effect"
this run had ("applied" / "read_only" / "none" / "unknown") and one line of
"advice". Automation should read that line and never infer success from the exit
code alone:

  ... | grep '"event":"recover_result"' | tail -1 | jq -e .ok`

const COMMANDS = [
  'status',
  'resume',
  'replace',
  'deposits',
  'float',
  'pause',
  'unpause',
] as const
const HELP_FLAGS = new Set<string>(['--help', '-h', 'help'])
/** Commands whose second word is required. `pause` takes a reason, not an id. */
const NEEDS_ARGUMENT = new Set<string>(['resume', 'replace', 'pause'])
/** Commands that cannot run without a chain client. Pause must work with the node down. */
const NEEDS_CHAIN = new Set<string>(['resume', 'replace', 'deposits'])
/**
 * Read-only commands that USE a chain client when one can be built and say so
 * when one cannot. An operator diagnosing an outage must still get a report.
 */
const OPTIONAL_CHAIN = new Set<string>(['status'])

/**
 * Value of a `--flag value` / `--flag=value` pair, or `undefined`.
 *
 * Positional-only parsing would have been enough for round 1, but `float set`
 * now carries a deposit hash whose omission must be a REFUSAL rather than a
 * shifted positional argument silently read as an amount.
 */
export function flagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === flag) return argv[i + 1]
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}

// ---- what a run REPORTS ------------------------------------------------------------------

/**
 * Exit codes, named because their whole purpose is to be read by somebody else.
 *
 * The distinction that matters is 3 versus everything else. `unpause` is
 * idempotent, but `replace` signs a replacement transaction and `float set`
 * attests a deposit, and an operator or script that retries one of those
 * because it could not tell "nothing happened" from "it worked" is the exact
 * double-spend the rest of this system is built to refuse. So "the run stopped
 * before it did anything" gets a code of its own, and so does "we do not know".
 */
export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2
export const EXIT_BEFORE_WORK = 3
export const EXIT_UNKNOWN = 4

/** How far a run got. Decides which of the codes above it may report. */
export type RecoverPhase =
  /** Argument parsing. Nothing has been opened. */
  | 'usage'
  /** Building the pool and the chain client, and establishing consensus. */
  | 'startup'
  /** The command's own function is running. */
  | 'work'
  /** The work returned. Everything from here on is teardown. */
  | 'done'

/** What this run DID to the system — the question a retry decision turns on. */
export type RecoverEffect =
  /** Something changed, and it is committed. */
  | 'applied'
  /** The command only read. */
  | 'read_only'
  /** Nothing changed. Safe to re-run. */
  | 'none'
  /** We cannot say. Look before re-running. */
  | 'unknown'

/**
 * The single machine-readable line every run ends with.
 *
 * The exit code alone is not enough for a money command, for two reasons this
 * file has already been bitten by: a status can be clobbered by a library fault
 * that has nothing to do with the work (see `src/exit.ts`), and "non-zero" does
 * not say whether the money moved. So the ground truth is a line on stdout that
 * states the answer outright, and the exit code merely agrees with it.
 *
 * `event` matches the `{event, at, ...}` shape the rest of the system logs in,
 * so a collector already parsing those picks this up unchanged.
 */
export interface RecoverOutcome {
  event: 'recover_result'
  at: string
  ok: boolean
  /** `status`, `float set`, `unpause`, … — the subcommand, not the argv. */
  command: string
  phase: RecoverPhase
  effect: RecoverEffect
  exitCode: number
  /** One sentence telling an operator whether to re-run. */
  advice: string
  /**
   * Set when the run was ended by something NOBODY could catch — the
   * `@nimiq/core` rethrow. Its absence means the error below was raised and
   * caught on a stack this file owns, which is a materially calmer fact.
   */
  fault?: 'uncaught exception' | 'unhandled rejection' | 'internal error'
  /** The command's own report, for a mutating command that succeeded. */
  result?: unknown
  error?: { name: string; message: string }
}

/**
 * Commands that can change something. Everything else only reads, and a failed
 * read is never a retry hazard.
 */
const MUTATING = new Set<string>(['resume', 'replace', 'float set', 'pause', 'unpause'])

const ADVICE = {
  applied:
    'the change reported above is committed — do NOT re-run this command; run "status" if you ' +
    'want to see it.',
  readOnly: 'read-only: nothing was changed.',
  beforeWork:
    'this run stopped BEFORE it did any work: nothing was read and nothing was written, so it is ' +
    'safe to re-run once the reason above is fixed.',
  refused:
    'the command ran and refused: it signed nothing and broadcast nothing. Re-running will refuse ' +
    'the same way until the reason above changes.',
  unknown:
    'the OUTCOME IS UNKNOWN — the process was killed by a fault while the work was in flight. Run ' +
    '"recover.ts status" and check the effect before re-running anything that moves money.',
  usage: 'nothing was contacted: the arguments were rejected before any connection was opened.',
} as const

function errorDetail(err: unknown): { name: string; message: string } {
  return {
    name: err instanceof Error ? err.name : typeof err,
    message: errorMessage(err),
  }
}

function outcome(o: Omit<RecoverOutcome, 'event' | 'at'>): RecoverOutcome {
  return { event: 'recover_result', at: new Date().toISOString(), ...o }
}

/** The work finished. */
export function succeeded(command: string, result: unknown): RecoverOutcome {
  const applied = MUTATING.has(command)
  return outcome({
    ok: true,
    command,
    phase: 'done',
    effect: applied ? 'applied' : 'read_only',
    exitCode: EXIT_OK,
    advice: applied ? ADVICE.applied : ADVICE.readOnly,
    ...(applied ? { result } : {}),
  })
}

/**
 * A run that ended on an error we CAUGHT — so control came back to us and we
 * know where it stopped.
 *
 * A `RecoverError` is a deliberate refusal: every one of them is raised before
 * anything is signed, and the two that commit anything at all
 * ({@link replaceTransfer}'s cleared absence series) commit only the fact that
 * the chain contradicted us. Anything else thrown out of a MUTATING command is
 * unclassified, and an unclassified fault on a money path is `unknown` — the
 * conservative answer, because the only cost of being wrong about it is that an
 * operator reads one more `status`.
 */
export function failed(command: string, phase: RecoverPhase, err: unknown): RecoverOutcome {
  if (phase === 'startup') {
    return outcome({
      ok: false,
      command,
      phase,
      effect: 'none',
      exitCode: EXIT_BEFORE_WORK,
      advice: ADVICE.beforeWork,
      error: errorDetail(err),
    })
  }
  const unclassified = !(err instanceof RecoverError) && MUTATING.has(command)
  return outcome({
    ok: false,
    command,
    phase,
    effect: unclassified ? 'unknown' : 'none',
    exitCode: unclassified ? EXIT_UNKNOWN : EXIT_REFUSED,
    advice: unclassified ? ADVICE.unknown : ADVICE.refused,
    error: errorDetail(err),
  })
}

/**
 * A run that was ended by a fault NOBODY could catch.
 *
 * This is the `@nimiq/core` hazard `src/exit.ts` documents, arriving on the
 * other side of the work: the nodejs client talks to its consensus worker over
 * message listeners that are async, and a rejection from one of those is
 * re-raised as an uncaught exception (`called Result::unwrap_throw() on an Err
 * value`) on a tick of its own. No `try`/`catch` around anything this file
 * awaits can see it, and Node's default handler prints a WASM stack trace and
 * ends the process at 1 — with no indication of whether the work had happened.
 *
 * Observed on the mainnet cutover: `float set` died this way during client
 * startup, having done nothing, and an identical re-run then succeeded. That is
 * the RIGHT exit direction and the wrong report: an operator staring at a WASM
 * backtrace cannot tell it from the same backtrace arriving one second later,
 * after the deposit had been attested. The phase is the only thing that can
 * tell them apart, so the phase is what this reports.
 */
export function faulted(
  command: string,
  phase: RecoverPhase,
  fault: NonNullable<RecoverOutcome['fault']>,
  err: unknown,
): RecoverOutcome {
  const detail = errorDetail(err)
  if (phase === 'startup' || phase === 'usage') {
    return outcome({
      ok: false,
      command,
      phase,
      effect: 'none',
      exitCode: EXIT_BEFORE_WORK,
      advice: ADVICE.beforeWork,
      fault,
      error: detail,
    })
  }
  return outcome({
    ok: false,
    command,
    phase,
    effect: 'unknown',
    exitCode: EXIT_UNKNOWN,
    advice: ADVICE.unknown,
    fault,
    error: detail,
  })
}

function rejectedUsage(command: string): RecoverOutcome {
  console.error(USAGE)
  return outcome({
    ok: false,
    command,
    phase: 'usage',
    effect: 'none',
    exitCode: EXIT_USAGE,
    advice: ADVICE.usage,
  })
}

// ---- printing ------------------------------------------------------------------------------

/**
 * `JSON.stringify` replacer for a codebase whose money is `bigint`.
 *
 * THIS is what exited 1 after a successful `unpause` on the mainnet cutover.
 * `Controls` carries five bigint fields, `JSON.stringify` throws
 * `TypeError: Do not know how to serialize a BigInt` on the first one, and the
 * throw happened in `print()` — AFTER the row was updated and
 * `custody_unpaused` was logged. So the kill switch was released, the operator
 * was shown a stack-free one-line error and a status of 1, and the only honest
 * reading of that pair is "the unpause failed", which it had not.
 *
 * Every other command dodged it by hand-building string DTOs. Fixing those
 * two call sites would have left the next command one `bigint` away from the
 * same bug, so the fix is here, where reporting can no longer fail on the shape
 * of what it was asked to report.
 */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** The human report: the command's own result, indented, on stdout. */
function print(value: unknown): void {
  console.log(JSON.stringify(value, jsonSafe, 2))
}

/**
 * Announce an outcome: the human sentence on stderr, then the machine line.
 *
 * Both live HERE rather than at the point the error was caught, so a run that
 * has already been concluded by a fault cannot go on narrating. That is not
 * hypothetical — the guard tears the pool down under a `main` that is still
 * awaiting a query on it, and the "Cannot use a pool after calling end on the
 * pool" that comes back must not be printed BELOW a line that already told the
 * operator what happened.
 *
 * The machine line is wrapped in its own `try` for the same reason `safeLog`
 * is: the line whose job is to report the outcome must never become the reason
 * the outcome is wrong.
 */
function report(o: RecoverOutcome): void {
  if (o.error) {
    console.error(o.fault ? `${o.fault} during ${o.phase}: ${o.error.message}` : o.error.message)
  }
  try {
    console.log(JSON.stringify(o, jsonSafe))
  } catch {
    console.log(
      JSON.stringify({
        event: 'recover_result',
        at: o.at,
        ok: o.ok,
        command: o.command,
        phase: o.phase,
        effect: o.effect,
        exitCode: o.exitCode,
        advice: o.advice,
        note: 'result not serializable; see the report above',
      }),
    )
  }
}

// ---- startup ---------------------------------------------------------------------------------

/** The chain client could not be brought up. By definition, nothing has happened. */
export class ChainStartupError extends RecoverError {}

/**
 * How long a command will wait for consensus before giving up.
 *
 * `waitForConsensusEstablished()` has no timeout of its own and no failure
 * mode: a client that cannot reach its seeds sits in `connecting` with zero
 * peers forever (API-DIVERGENCE 15). An operator command that hangs is worse
 * than one that fails, because a hang has to be interrupted by hand and then
 * carries the same question a crash does — did it get far enough to do
 * anything? A bounded wait that fails in the STARTUP phase answers that
 * question for them.
 *
 * Two minutes: mainnet pico consensus measured 5.5–10.3 s over fourteen runs
 * from a developer machine, so this is an order of magnitude of headroom for a
 * loaded VPS rather than a guess at the typical case.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000

/**
 * The shorter budget a DEGRADABLE command gets.
 *
 * `status` and `float show` do not need the chain to be useful — an unreachable
 * node becomes a `reason` string in the report rather than a failure, and that
 * string is often the most interesting line on the screen. `status` is also the
 * first thing an on-call operator runs, so making them sit through the full
 * budget before seeing anything would be withholding the report by another
 * name. The commands that MUST have a chain keep the full budget: for them a
 * short one is just an early refusal.
 */
const DEGRADED_STARTUP_TIMEOUT_MS = 30_000

function startupTimeoutMs(): number {
  const raw = process.env.RECOVER_STARTUP_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_STARTUP_TIMEOUT_MS
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new ChainStartupError(
      `RECOVER_STARTUP_TIMEOUT_MS must be a positive whole number of milliseconds (got ${JSON.stringify(raw)})`,
    )
  }
  return ms
}

/**
 * Bring the consensus client up HERE, in the startup phase, rather than letting
 * the first `headHeight()` do it inside the work.
 *
 * Connecting is the slow, network-dependent, WASM-heavy part of every
 * chain-touching command, and it is where the mainnet cutover's `float set`
 * died. Lazily connecting put that failure inside the work, where it is
 * indistinguishable from the command refusing — or worse, from it half
 * succeeding. Connecting eagerly puts it in the one phase where "nothing
 * happened" is a fact rather than an inference.
 *
 * `NimiqChain.connect()` is idempotent, so the work's own calls are unaffected.
 */
async function connectWithin(chain: NimiqChain, capMs = Number.POSITIVE_INFINITY): Promise<void> {
  const ms = Math.min(startupTimeoutMs(), capMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // `Promise.race` subscribes to BOTH, so a `connect()` that rejects after
    // the timeout has already won is still handled and cannot resurface as an
    // unhandled rejection.
    await Promise.race([
      chain.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ChainStartupError(
                `consensus was not established on ${chain.network()} within ${ms}ms. Nothing has ` +
                  'been read or written by this command. Check the node\'s outbound access to the ' +
                  'seed nodes and re-run; raise RECOVER_STARTUP_TIMEOUT_MS if the node is simply slow.',
              ),
            ),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ---- the run ---------------------------------------------------------------------------------

/**
 * How far the current run has got.
 *
 * Module scope, and deliberately: the only consumer is the uncaught-fault guard
 * {@link runCli} installs, which by construction runs outside every call stack
 * this file controls and so cannot be passed anything.
 */
let phase: RecoverPhase = 'usage'

/**
 * Whether an outcome has already been published for this process.
 *
 * Module scope for the same reason {@link phase} is: {@link runCli}'s guard can
 * conclude a run from outside `main`'s call stack, and `main` — which may still
 * be mid-`await` when that happens — has to stop narrating.
 */
let concluded = false

/**
 * The live chain client, held at module scope so {@link teardown} can reach it
 * after {@link main} has returned its outcome.
 *
 * It used to be a local torn down in `main`'s `finally`, which put the whole of
 * teardown INSIDE the window whose exit code reports the work. That is the
 * arrangement `src/exit.ts` exists to forbid.
 */
let openChain: NimiqChain | null = null

/**
 * Everything the process holds, released after the outcome is already fixed.
 *
 * Faults are NOT swallowed here (the old code's `.catch(() => {})`): they are
 * left to `exitAfterTeardown`, which logs them and then refuses to let them
 * change the exit code. A WASM error nobody ever sees is its own bug.
 */
async function teardown(): Promise<void> {
  const chain = openChain
  openChain = null
  await chain?.close()
  await closePool()
}

/**
 * Run one command and report what it did. Opens resources; does NOT close them.
 *
 * The split is the point. Teardown is the caller's job precisely so the
 * outcome this returns is decided before a `@nimiq/core` shutdown fault gets a
 * chance to weigh in — see {@link runCli} and `src/exit.ts`.
 */
export async function main(argv: string[]): Promise<RecoverOutcome> {
  const [command, argument, third] = argv
  const name = commandName(argv)

  phase = 'usage'

  if (command && HELP_FLAGS.has(command)) {
    console.log(USAGE)
    return succeeded('--help', undefined)
  }
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    return rejectedUsage(name)
  }
  if (NEEDS_ARGUMENT.has(command) && !argument) {
    return rejectedUsage(name)
  }
  if (command === 'float' && argument !== 'show' && argument !== 'set') {
    return rejectedUsage(name)
  }
  // The amount is positional and must not be a flag: `float set --tx <hash>`
  // with no amount would otherwise read "--tx" as the luna value.
  if (command === 'float' && argument === 'set' && (third === undefined || third.startsWith('-'))) {
    return rejectedUsage(name)
  }

  const wantsChain = NEEDS_CHAIN.has(command) || (command === 'float' && argument === 'set')
  const mayUseChain = OPTIONAL_CHAIN.has(command) || (command === 'float' && argument === 'show')

  let pool: Pool
  let chain: NimiqChain | null = null
  /** Why there is no chain client, for the degraded section of a read-only report. */
  let chainUnavailableReason: string | undefined

  phase = 'startup'
  try {
    pool = getPool()
    // Prove the database answers before the work starts. `getPool()` is lazy,
    // so without this an unreachable database surfaces on the command's first
    // query — inside the work, where "nothing happened" stops being provable
    // even though it is still true.
    await pool.query('SELECT 1')
    if (wantsChain) {
      openChain = chain = nimiqChainFromEnv()
      await connectWithin(chain)
    } else if (mayUseChain) {
      try {
        // `openChain` is assigned even on the degraded path so a half-built
        // client is still torn down.
        openChain = chain = nimiqChainFromEnv()
        await connectWithin(chain, DEGRADED_STARTUP_TIMEOUT_MS)
      } catch (err) {
        chain = null
        chainUnavailableReason = `no chain client: ${errorMessage(err)}`
      }
    }
  } catch (err) {
    return failed(name, 'startup', err)
  }

  const needChain = (): NimiqChain => {
    if (!chain) throw new RecoverError(`command ${command} requires a chain client`)
    return chain
  }

  phase = 'work'
  let result: unknown
  try {
    const alerts = consoleAlerts()

    if (command === 'status') {
      result = await statusReport(pool, chain, chainUnavailableReason)
    } else if (command === 'float') {
      result =
        argument === 'show'
          ? await floatShow(pool, chain, chainUnavailableReason)
          : await setOperatorFloat(pool, needChain(), third as string, flagValue(argv, '--tx'))
    } else if (command === 'resume') {
      result = await resumeTransfer(pool, needChain(), alerts, argument)
    } else if (command === 'replace') {
      result = await replaceTransfer(pool, needChain(), alerts, argument)
    } else if (command === 'deposits') {
      result = await depositReport(pool, needChain())
    } else if (command === 'pause') {
      result = await pauseCustody(pool, argument)
    } else {
      result = await unpauseCustody(pool)
    }
  } catch (err) {
    return failed(name, 'work', err)
  }

  // The work is over. Reporting it cannot change that: `print` can no longer
  // throw on a bigint, and if it somehow did, `report` still states the truth
  // on its own line.
  phase = 'done'
  // Not printed when a fault has already concluded this run: a full, healthy
  // report arriving after an "outcome unknown" line would contradict it.
  if (!concluded) print(result)
  return succeeded(name, result)
}

/** The subcommand an outcome is about. `float` carries its second word. */
function commandName(argv: string[]): string {
  const [command, argument] = argv
  if (!command) return '(none)'
  if (command === 'float' && (argument === 'show' || argument === 'set')) {
    return `float ${argument}`
  }
  return command
}

/**
 * The CLI: run the command, publish the outcome, then — and only then — let go.
 *
 * Three things have to be true at once and none of them were:
 *
 *  1. **The exit code reports the WORK.** Teardown now happens under
 *     `exitAfterTeardown`, after the outcome is fixed, so a `@nimiq/core`
 *     shutdown fault is logged and discarded instead of overwriting a 0 with a
 *     1. The old code tore down inside `main` and then called `exitAfterFlush`,
 *     which fixes no code at all — it installs no handlers, so any uncaught
 *     exception in the whole teardown-and-flush window reached Node's default
 *     handler.
 *  2. **A fault that lands BEFORE the work says so.** The guard below is
 *     installed before anything is constructed, and it reads {@link phase}, so
 *     the WASM rethrow that killed the cutover's first `float set` now prints
 *     "nothing was read and nothing was written" and exits 3 instead of dumping
 *     a backtrace and exiting 1.
 *  3. **The answer is machine-readable.** {@link report} runs on every path,
 *     including the fault paths, so automation reads `ok` rather than guessing
 *     from a status.
 *
 * The guard is removed the moment the outcome is fixed, because from there
 * `exitAfterTeardown` owns those two events and two owners would race.
 */
export function runCli(argv: string[]): void {
  let release = (): void => {}

  const finish = (o: RecoverOutcome): void => {
    if (concluded) return
    concluded = true
    release()
    report(o)
    exitAfterTeardown(o.exitCode, teardown, (message) =>
      console.error(JSON.stringify({ event: 'recover_teardown_fault', message })),
    )
  }

  const guard = (kind: 'uncaught exception' | 'unhandled rejection') => (err: unknown) => {
    finish(faulted(commandName(argv), phase, kind, err))
  }
  const onException = guard('uncaught exception')
  const onRejection = guard('unhandled rejection')
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  release = (): void => {
    process.off('uncaughtException', onException)
    process.off('unhandledRejection', onRejection)
  }

  main(argv).then(finish, (err: unknown) => {
    // `main` catches its own errors, so this is a bug in `main` rather than in
    // a command — but it is still an outcome and it still has a phase.
    finish(faulted(commandName(argv), phase, 'internal error', err))
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  runCli(process.argv.slice(2))
}
