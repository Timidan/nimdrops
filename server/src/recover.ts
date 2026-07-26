import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { type NimiqChain, nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient, ChainTx } from './chain/types'
import { closePool, getPool } from './db/pool'
import { type NetworkName, errorMessage } from './config'
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

export class RecoverError extends Error {}

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
 * but a client that cannot answer must not block recovery — the primary guard
 * is `custody_controls.network`, which every command checks unconditionally.
 */
interface NetworkDecoder {
  rawTxNetwork(rawTxHex: string): NetworkName | null
}

function asNetworkDecoder(chain: ChainClient): NetworkDecoder | null {
  const candidate = chain as ChainClient & Partial<NetworkDecoder>
  return typeof candidate.rawTxNetwork === 'function' ? (candidate as NetworkDecoder) : null
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
 *     dead attempt's own bytes were signed for that same network (finding 6),
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

  const intent = await loadIntent(pool, transferId)
  if (intent.state === 'confirmed') {
    throw new ReplaceRefusedError(`transfer ${transferId} is already confirmed`)
  }

  const latest = await loadLatestAttempt(pool, transferId)
  if (!latest) {
    throw new ReplaceRefusedError(
      `transfer ${transferId} has no attempt to replace — use "resume" to queue a first one`,
    )
  }
  if (latest.state === 'confirmed') {
    throw new ReplaceRefusedError(
      `attempt ${latest.txHash} is confirmed on chain — replacing it would pay twice`,
    )
  }

  // The bytes we are about to declare dead must themselves belong to this
  // network. A stored attempt signed with another network id could never have
  // been included here, so "absent" would be trivially and misleadingly true.
  const decoder = asNetworkDecoder(chain)
  const signedFor = decoder ? decoder.rawTxNetwork(latest.rawTxHex) : null
  if (signedFor !== null && signedFor !== chain.network()) {
    throw new ReplaceRefusedError(
      `attempt ${latest.txHash} was signed for ${signedFor} but this process runs against ` +
        `${chain.network()}: its absence here proves nothing.`,
    )
  }

  const head = await chain.headHeight()
  let evidence: Record<string, unknown> = { alreadyProvenDead: true }

  if (latest.state !== 'proven_dead') {
    const proof = await evaluateProvenDead(chain, latest, head, opts)
    if (proof.unknown) {
      throw new ReplaceRefusedError(
        `cannot prove attempt ${latest.txHash} is dead: chain lookup failed (${proof.lookupError}). ` +
          'An inconclusive lookup is not permission to replace.',
      )
    }
    if (!proof.absent) {
      throw new ReplaceRefusedError(
        `attempt ${latest.txHash} is on chain — wait for finality or use "resume"`,
      )
    }
    if (!proof.windowPast) {
      throw new ReplaceRefusedError(
        `attempt ${latest.txHash} can still be included: head ${proof.head} has not passed ` +
          `validity deadline ${proof.deadlineHeight}. Absence alone is never proof of death.`,
      )
    }

    // Sustained absence (finding 2). `proof.absent` above is ONE lookup, taken
    // just now; these two checks are the recorded series behind it.
    const absenceAgeMs =
      latest.firstAbsentAt === null ? 0 : Date.now() - latest.firstAbsentAt.getTime()
    if (latest.absentChecks < ABSENCE_MIN_OBSERVATIONS || latest.firstAbsentAt === null) {
      throw new ReplaceRefusedError(
        `attempt ${latest.txHash} has only ${latest.absentChecks} recorded absence observation(s); ` +
          `${ABSENCE_MIN_OBSERVATIONS} are required. One not-found answer is one node's opinion, ` +
          'not proof. Let the worker keep reconciling and re-run.',
      )
    }
    if (absenceAgeMs < ABSENCE_MIN_SPAN_MS) {
      throw new ReplaceRefusedError(
        `attempt ${latest.txHash} has been absent for only ${Math.round(absenceAgeMs / 1000)}s; ` +
          `${ABSENCE_MIN_SPAN_MS / 1000}s of unbroken absence are required before it may be replaced.`,
      )
    }

    evidence = {
      ...proof,
      absentChecks: latest.absentChecks,
      firstAbsentAt: latest.firstAbsentAt.toISOString(),
      absenceAgeMs,
    }
  }

  const client = await pool.connect()
  let stored: StoredAttempt
  try {
    await client.query('BEGIN')

    // Same lock order as every money path (custody_controls first), so an
    // operator command can never interleave with a worker signature. This
    // deliberately does NOT use `lockControls`: pause and stale reconciliation
    // must not block recovery — they are exactly when it is needed.
    await client.query('SELECT 1 FROM custody_controls WHERE singleton FOR UPDATE')

    const { rows } = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM outgoing_transfers WHERE id = $1 FOR UPDATE`,
      [transferId],
    )
    if (!rows[0]) throw new TransferNotFoundError(transferId)
    // Recipient and amount come from THIS row and nowhere else.
    const locked = toIntent(rows[0])
    if (locked.state === 'confirmed') {
      throw new ReplaceRefusedError(`transfer ${transferId} was confirmed while we prepared`)
    }

    const current = await loadLatestAttempt(client, transferId, true)
    if (!current || current.id !== latest.id) {
      throw new ReplaceRefusedError('a newer attempt appeared while we prepared — re-run')
    }
    // Re-read under the lock: a worker tick that SAW the transaction between our
    // proof and this transaction resets the absence series, and that sighting
    // outranks everything we decided a moment ago.
    if (
      current.state !== 'proven_dead' &&
      (current.absentChecks < ABSENCE_MIN_OBSERVATIONS || current.firstAbsentAt === null)
    ) {
      throw new ReplaceRefusedError(
        'the absence series was reset while we prepared — the chain has seen this attempt. Re-run.',
      )
    }
    if (current.state === 'signed' || current.state === 'broadcast') {
      const updated = await client.query(
        `UPDATE transaction_attempts
         SET state = 'proven_dead', last_error = $2
         WHERE id = $1 AND state IN ('signed', 'broadcast')`,
        [current.id, JSON.stringify({ provenDeadBy: 'recover.ts replace', ...evidence })],
      )
      if (updated.rowCount === 0) {
        throw new ReplaceRefusedError('attempt state changed while we prepared — re-run')
      }
    }

    stored = await signAndPersistAttempt(client, chain, locked, head)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  await broadcastStored(pool, chain, stored)

  return {
    transferId,
    sequence: stored.sequence,
    txHash: stored.txHash,
    deadAttemptHash: latest.txHash,
    recipientAddress: intent.recipientAddress,
    amountLuna: intent.amountLuna.toString(),
  }
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
  }
}

async function readSolvency(db: PoolClient): Promise<LedgerSnapshot> {
  const controls = await readControls(db)
  const movementsLuna = await ledgerMovementsLuna(db)
  const outstandingLuna = await outstandingPrincipalLuna(db)
  const inFlightLuna = await inFlightOutgoingLuna(db)
  return {
    controls,
    ledgerLuna: controls.operatorFloatLuna + movementsLuna,
    view: toSolvencyView({ controls, movementsLuna, outstandingLuna, inFlightLuna }),
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

export interface FloatSetResult {
  command: 'float set'
  network: NetworkName
  headHeight: number
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
 * Re-attest the operator float — the one ledger credit the drops cannot supply
 * (migration 004, G1 review finding 4). A fresh database fails closed as
 * insolvent until this runs, because the fee reserve is spent out of money no
 * drop ever deposited.
 *
 * The float is an ATTESTATION, and the only thing that makes an attestation
 * worth anything is that it can be refused. So:
 *
 *  - a chain client is mandatory, and an unreachable node is a refusal rather
 *    than a guess. Writing a float against a balance we could not read is
 *    exactly the failure the attestation exists to prevent;
 *  - the resulting LEDGER balance may not exceed the chain's confirmed custody
 *    balance. Over-attesting invents spendable capacity, and the invariant
 *    would then authorise payouts against money that is not there — a stranded
 *    campaign whose claimants cannot be paid;
 *  - the write happens under the singleton `custody_controls` lock, in the same
 *    lock order as every money path, so it cannot interleave with an activation
 *    or a signature that is reading the float it is about to change.
 *
 * This bound is deliberately STRICTER than `reconcile()`'s cross-check, which
 * tolerates `chain >= ledger − in-flight`. In-flight money is money already
 * committed to leaving; treating it as headroom for a fresh attestation would
 * let the float ratchet up on payments that have not settled. An operator who
 * genuinely has more in custody can re-run this once the transfers confirm.
 *
 * Deliberately NOT via `lockControls`: attesting the float is precisely what an
 * operator does while the system is paused, insolvent or stale, so a
 * fail-closed read here would make the system unable to unstick itself.
 */
export async function setOperatorFloat(
  pool: Pool,
  chain: ChainClient,
  lunaArgument: string,
): Promise<FloatSetResult> {
  await ensureNetworkBinding(pool, chain)
  const nextFloatLuna = parsePositiveLuna(lunaArgument)

  // Chain reads happen BEFORE the lock, like `reconcile()`: holding the
  // singleton row across an RPC would stall every payout for as long as the
  // node takes to answer. The staleness that buys is one-sided — a balance read
  // a moment ago can only have been reduced by our own in-flight spending,
  // which the stricter-than-reconcile bound above already refuses to count.
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

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // custody_controls first — the mandated lock order for every money path.
    await client.query('SELECT 1 FROM custody_controls WHERE singleton FOR UPDATE')

    const before = await readControls(client)
    const movementsLuna = await ledgerMovementsLuna(client)
    const outstandingLuna = await outstandingPrincipalLuna(client)

    const beforeLedgerLuna = before.operatorFloatLuna + movementsLuna
    const afterLedgerLuna = nextFloatLuna + movementsLuna

    if (afterLedgerLuna > chainConfirmedLuna) {
      throw new OverAttestationError(
        `refusing to attest an operator float of ${nextFloatLuna} luna: it would put the ledger ` +
          `balance at ${afterLedgerLuna} luna while the chain confirms only ${chainConfirmedLuna} ` +
          `luna in custody ${chain.custodyAddress()} at height ${headHeight}. The largest honest ` +
          `float right now is ${
            chainConfirmedLuna - movementsLuna > 0n ? chainConfirmedLuna - movementsLuna : 0n
          } luna. Deposit the money first, then attest it.`,
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

  float set <luna>
      Re-attest the operator float, in whole positive luna. Refuses any value
      that would push the ledger balance above the on-chain custody balance, and
      refuses outright when the chain cannot be read.
      example: pnpm tsx src/recover.ts float set 100000

  pause <reason>
      Engage the global kill switch: every new money path fails closed. Needs no
      chain node — pausing must work when the node is the thing that broke.
      example: pnpm tsx src/recover.ts pause "node desync during payout batch"

  unpause
      Release the kill switch. Does not reconcile: a stale balance keeps failing
      closed until the worker's next successful reconcile.
      example: pnpm tsx src/recover.ts unpause

  --help
      Print this block. Also printed, to stderr, on an unrecognised command.`

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

export async function main(argv: string[]): Promise<number> {
  const [command, argument, third] = argv

  if (command && HELP_FLAGS.has(command)) {
    console.log(USAGE)
    return 0
  }
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    console.error(USAGE)
    return 2
  }
  if (NEEDS_ARGUMENT.has(command) && !argument) {
    console.error(USAGE)
    return 2
  }
  if (command === 'float' && argument !== 'show' && argument !== 'set') {
    console.error(USAGE)
    return 2
  }
  if (command === 'float' && argument === 'set' && third === undefined) {
    console.error(USAGE)
    return 2
  }

  const wantsChain = NEEDS_CHAIN.has(command) || (command === 'float' && argument === 'set')
  const mayUseChain = OPTIONAL_CHAIN.has(command) || (command === 'float' && argument === 'show')

  let pool: Pool | null = null
  let chain: NimiqChain | null = null
  /** Why there is no chain client, for the degraded section of a read-only report. */
  let chainUnavailableReason: string | undefined

  const print = (value: unknown): void => {
    console.log(JSON.stringify(value, null, 2))
  }
  const needChain = (): NimiqChain => {
    if (!chain) throw new RecoverError(`command ${command} requires a chain client`)
    return chain
  }

  try {
    pool = getPool()
    if (wantsChain) {
      chain = nimiqChainFromEnv()
    } else if (mayUseChain) {
      try {
        chain = nimiqChainFromEnv()
      } catch (err) {
        chainUnavailableReason = `no chain client: ${errorMessage(err)}`
      }
    }

    const alerts = consoleAlerts()

    if (command === 'status') {
      print(await statusReport(pool, chain, chainUnavailableReason))
    } else if (command === 'float') {
      print(
        argument === 'show'
          ? await floatShow(pool, chain, chainUnavailableReason)
          : await setOperatorFloat(pool, needChain(), third as string),
      )
    } else if (command === 'resume') {
      print(await resumeTransfer(pool, needChain(), alerts, argument))
    } else if (command === 'replace') {
      print(await replaceTransfer(pool, needChain(), alerts, argument))
    } else if (command === 'deposits') {
      print(await depositReport(pool, needChain()))
    } else if (command === 'pause') {
      print(await pauseCustody(pool, argument))
    } else {
      print(await unpauseCustody(pool))
    }
    return 0
  } catch (err) {
    console.error(errorMessage(err))
    return 1
  } finally {
    await chain?.close().catch(() => {})
    await closePool().catch(() => {})
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(errorMessage(err))
      process.exitCode = 1
    },
  )
}
