import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { nimiqChainFromEnv } from './chain/nimiq'
import type { ChainClient, ChainTx } from './chain/types'
import { closePool, getPool } from './db/pool'
import { errorMessage } from './config'
import { type Alerts, consoleAlerts } from './services/alerts'
import { MEMO_PREFIX } from './services/drops'
import { type Controls, pause, readControls, unpause } from './services/solvency'
import {
  type StoredAttempt,
  type TransferIntent,
  broadcastStored,
  evaluateProvenDead,
  loadOpenAttempts,
  progressAttempt,
  signAndPersistAttempt,
} from './services/transfers'

/**
 * Operator recovery commands (design §10.3).
 *
 *   pnpm tsx src/recover.ts resume <transferId>
 *   pnpm tsx src/recover.ts replace <transferId>
 *   pnpm tsx src/recover.ts deposits
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
  }>(
    `SELECT id, sequence, state, tx_hash, validity_start_height
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
  }
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
 * money twice, so it refuses unless both halves of the proof hold right now,
 * re-checked against the chain rather than trusted from an earlier reconcile:
 *
 *   - the hash is ABSENT (a lookup error is not absence — it refuses), and
 *   - the head is strictly past `validity_start_height + window`, so the signed
 *     bytes can never be included by anyone, ever again.
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
): Promise<ReplaceResult> {
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

  const head = await chain.headHeight()
  let evidence: Record<string, unknown> = { alreadyProvenDead: true }

  if (latest.state !== 'proven_dead') {
    const proof = await evaluateProvenDead(chain, latest, head)
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
    evidence = { ...proof }
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

// ---- CLI -------------------------------------------------------------------------------

const USAGE = `usage:
  pnpm tsx src/recover.ts resume <transferId>    reconcile or re-queue an existing intent
  pnpm tsx src/recover.ts replace <transferId>   replace a PROVEN DEAD attempt (same recipient+amount)
  pnpm tsx src/recover.ts deposits               custody deposits matching no drop's funding predicate
  pnpm tsx src/recover.ts pause <reason>         engage the global kill switch (fails every money path closed)
  pnpm tsx src/recover.ts unpause                release the kill switch`

const COMMANDS = ['resume', 'replace', 'deposits', 'pause', 'unpause'] as const
/** Commands whose second word is required. `pause` takes a reason, not an id. */
const NEEDS_ARGUMENT = new Set<string>(['resume', 'replace', 'pause'])
/** Commands that talk to the chain. Pause must work when the node is down. */
const NEEDS_CHAIN = new Set<string>(['resume', 'replace', 'deposits'])

export async function main(argv: string[]): Promise<number> {
  const [command, argument] = argv
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    console.error(USAGE)
    return 2
  }
  if (NEEDS_ARGUMENT.has(command) && !argument) {
    console.error(USAGE)
    return 2
  }

  const pool = getPool()
  const chain = NEEDS_CHAIN.has(command) ? nimiqChainFromEnv() : null
  const alerts = consoleAlerts()
  const print = (value: unknown): void => {
    console.log(JSON.stringify(value, null, 2))
  }
  const needChain = (): ChainClient => {
    if (!chain) throw new RecoverError(`command ${command} requires a chain client`)
    return chain
  }

  try {
    if (command === 'resume') {
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
