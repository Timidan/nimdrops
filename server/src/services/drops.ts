import type { Pool, PoolClient } from 'pg'
import { MEMO_MAX_BYTES, type ChainClient, type ChainTx } from '../chain/types'
import { errorMessage, requireNetwork } from '../config'
import type { Queryable } from '../db/pool'
import { newPublicId } from '../ids'
import { assertCaps, formatNim } from '../money'
import { assertSolvent, lockControls, reconcile } from './solvency'

/**
 * Drop drafts and exact funding activation (design §7).
 *
 * Two rules govern this file:
 *
 *  1. **Never activate by memo scan.** A drop goes live only for a transaction
 *     hash the client submitted, verified against EVERY predicate below by exact
 *     equality. Substring, prefix, or "close enough" memo matching is a kill
 *     criterion (PLAN.md), so the memo comparison is `===` on the full string.
 *  2. **Never tell the user to fund again** because detection is slow
 *     (design §4.2 step 5). A hash the chain cannot see yet is "not detected",
 *     not "rejected": those calls return the drop's current state without error
 *     and without recording anything.
 *
 * Chain verification happens OUTSIDE the database transaction. Once the funding
 * is final we `reconcile()` — which refreshes the chain cross-check and stamps
 * the freshness the invariant demands — and only then open the activation
 * transaction, which takes locks in the mandated order `custody_controls` →
 * drop row. The invariant itself (`ledger balance >= outstanding + added +
 * fee reserve`) runs inside that transaction, on the books rather than on the
 * chain's head state (G1 review finding 4).
 *
 * All money is BIGINT luna; `db/pool.ts` keeps int8 as a string on the wire, so
 * every value is parsed with `BigInt(...)` at this boundary.
 */

/** Versioned funding memo prefix. The `1` is the memo format version. */
export const MEMO_PREFIX = 'ND1:'
/** Expiry is measured from finalized activation, never from draft creation. */
export const EXPIRY_HOURS = 24

/**
 * NOTE on `paused`: this is a PER-DROP state, never the operator kill switch.
 * Global pause lives in `custody_controls.paused` (see `services/solvency.ts`
 * and `recover.ts pause`), which is what every money path checks. Nothing
 * currently writes this value; it is kept for a per-drop hold.
 */
export type DropState =
  | 'awaiting_funding'
  | 'funding_pending'
  | 'live'
  | 'closing'
  | 'settled'
  | 'refunded'
  | 'paused'
  | 'manual_review'
  | 'cancelled'

/** States that can still accept a funding transaction. */
const FUNDABLE_STATES: readonly DropState[] = ['awaiting_funding', 'funding_pending']

/**
 * States a funding transaction may still ACTIVATE from (G1 review finding 7).
 *
 * `cancelled` is in this list and not in `FUNDABLE_STATES` on purpose. Draft GC
 * (`expiry.gcDrafts`) cancels an unfunded draft 24 hours after it was created,
 * and it can legitimately fire on a draft whose funding is mid-verification:
 * the sponsor's transaction is on chain and final, `submitFunding` is between
 * its chain reads and its activation transaction, and GC only looks at
 * `funding_tx_hash IS NULL`. Refusing the activation afterwards would strand
 * verified money in a cancelled drop and force a manual refund.
 *
 * Reactivating is safe because the ENTIRE §7 predicate is re-checked first —
 * exact recipient, exact amount, exact memo, real sender, unused hash, our own
 * finality — and `activate()` re-checks the drop row under the custody lock. A
 * cancelled drop holds no claims, no liabilities and no expiry, so nothing was
 * built on top of the cancellation that reactivation would contradict.
 *
 * `gcDrafts` itself is deliberately untouched: narrowing the collector would
 * only move the race, and the collector's three guards are the reason it can
 * never touch a drop that money was already attributed to.
 */
const ACTIVATABLE_STATES: readonly DropState[] = [...FUNDABLE_STATES, 'cancelled']

export class DropError extends Error {}

export class DropNotFoundError extends DropError {
  constructor(publicId: string) {
    // Deliberately does not echo the id: callers turn this into a uniform 404.
    super('drop not found')
    void publicId
  }
}

/** Why a submitted funding transaction failed a §7 predicate. */
export type FundingRejectionCode =
  | 'wrong_network'
  | 'execution_failed'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'wrong_memo'
  | 'invalid_sender'
  | 'reused_hash'
  | 'drop_not_fundable'
  /**
   * The hash is already attested as operator float (round-3 R2). Crediting it
   * as funding too would put the same luna in the ledger twice.
   */
  | 'attested_as_float'

export class FundingRejectedError extends DropError {
  constructor(
    readonly code: FundingRejectionCode,
    message: string,
  ) {
    super(message)
  }
}

/** Public-safe projection of a drop. Never carries claimant addresses or row ids. */
export interface DropPublic {
  publicId: string
  sponsorLabel: string
  message: string | null
  /** Decimal NIM string, e.g. `"2.5"`. */
  amountEach: string
  claimCount: number
  /** Slots not yet reserved. */
  remaining: number
  state: DropState
  expiresAt: Date | null
  fundingTxHash?: string
}

export interface CreateDraftInput {
  sponsorLabel: string
  message?: string
  amountEachLuna: bigint
  claimCount: number
}

export interface Draft {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFundingLuna: bigint
}

/** The one memo that can fund this drop. Compared with `===`, never `includes`. */
export function fundingMemoFor(publicId: string): string {
  const memo = `${MEMO_PREFIX}${publicId}`
  if (Buffer.byteLength(memo, 'utf8') > MEMO_MAX_BYTES) {
    throw new DropError(`funding memo exceeds ${MEMO_MAX_BYTES} bytes`)
  }
  return memo
}

/**
 * Create an unfunded draft. No money exists yet, so this takes no locks and
 * makes no chain calls beyond reading the custody address to display.
 */
export async function createDraft(
  pool: Pool,
  chain: ChainClient,
  o: CreateDraftInput,
): Promise<Draft> {
  assertCaps(o.amountEachLuna, o.claimCount)
  const expectedFundingLuna = o.amountEachLuna * BigInt(o.claimCount)
  const publicId = newPublicId()
  const fundingMemo = fundingMemoFor(publicId)

  await pool.query(
    `INSERT INTO drops (
       public_id, sponsor_label, message, claim_count, amount_each_luna,
       expected_funding_luna, state
     ) VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_funding')`,
    [
      publicId,
      o.sponsorLabel,
      o.message ?? null,
      o.claimCount,
      o.amountEachLuna.toString(),
      expectedFundingLuna.toString(),
    ],
  )

  return { publicId, fundingAddress: chain.custodyAddress(), fundingMemo, expectedFundingLuna }
}

interface DropRow {
  id: string
  public_id: string
  sponsor_label: string
  message: string | null
  claim_count: number
  amount_each_luna: string
  expected_funding_luna: string
  state: DropState
  funding_tx_hash: string | null
  activated_height: string | null
  expires_at: Date | null
  claims_reserved: string
}

const SELECT_DROP = `
  SELECT d.id, d.public_id, d.sponsor_label, d.message, d.claim_count,
         d.amount_each_luna, d.expected_funding_luna, d.state, d.funding_tx_hash,
         d.activated_height, d.expires_at,
         (SELECT count(*) FROM claims c WHERE c.drop_id = d.id)::text AS claims_reserved
  FROM drops d
  WHERE d.public_id = $1
`

async function loadDrop(db: Queryable, publicId: string): Promise<DropRow> {
  const { rows } = await db.query<DropRow>(SELECT_DROP, [publicId])
  const row = rows[0]
  if (!row) throw new DropNotFoundError(publicId)
  return row
}

function toPublic(row: DropRow): DropPublic {
  const reserved = Number(row.claims_reserved)
  return {
    publicId: row.public_id,
    sponsorLabel: row.sponsor_label,
    message: row.message,
    amountEach: formatNim(BigInt(row.amount_each_luna)),
    claimCount: row.claim_count,
    remaining: Math.max(0, row.claim_count - reserved),
    state: row.state,
    expiresAt: row.expires_at,
    ...(row.funding_tx_hash === null ? {} : { fundingTxHash: row.funding_tx_hash }),
  }
}

/** Public-safe drop state. Safe to serve unauthenticated. */
export async function getPublic(pool: Pool, publicId: string): Promise<DropPublic> {
  return toPublic(await loadDrop(pool, publicId))
}

/**
 * The real `@nimiq/core` client REJECTS with "Transaction not found" where
 * `FakeChain` resolves `null`. Both mean the same thing to us — the chain has
 * not shown us this transaction — and neither is an error the sponsor can act
 * on. Any OTHER failure (RPC down, consensus lost) propagates, so a degraded
 * node can never be mistaken for a missing transaction.
 */
async function findTx(chain: ChainClient, txHash: string): Promise<ChainTx | null> {
  try {
    return await chain.getTransaction(txHash)
  } catch (err) {
    const message = errorMessage(err)
    if (/not found|unknown transaction|no such transaction/i.test(message)) return null
    throw err
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/**
 * Migration 008's trigger fired: this hash is already attested as operator
 * float. The application checks for it first with a better message; this is the
 * backstop speaking, and it must not surface as a 500.
 */
function isFloatExclusivityViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return e?.code === '23514' && /attested as operator float/i.test(e.message ?? '')
}

/**
 * Round-3 R2. A deposit is EITHER a drop's funding OR the operator's float,
 * never both — the ledger credits each of them separately, so counting one
 * transaction as both invents money that was never in custody.
 *
 * `float set` refuses a hash that is already some drop's funding and refuses
 * any hash carrying a `ND1:` memo. This is the same rule from the other side:
 * an operator who attested a memo-less deposit and only afterwards discovered
 * it was meant to fund a drop must not be able to activate that drop on top of
 * the attestation. The float has to be withdrawn first, deliberately.
 */
async function assertHashNotAttestedFloat(db: Queryable, txHash: string): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM operator_float_deposits WHERE tx_hash = $1', [
    txHash,
  ])
  if (rows.length > 0) {
    throw new FundingRejectedError(
      'attested_as_float',
      'that transaction is already attested as operator float; it cannot also fund a drop',
    )
  }
}

async function assertHashUnusedElsewhere(
  db: Queryable,
  publicId: string,
  txHash: string,
): Promise<void> {
  const { rows } = await db.query<{ public_id: string }>(
    'SELECT public_id FROM drops WHERE funding_tx_hash = $1 AND public_id <> $2',
    [txHash, publicId],
  )
  if (rows.length > 0) {
    throw new FundingRejectedError('reused_hash', 'funding transaction already funded another drop')
  }
}

/**
 * Verify a submitted funding transaction against every design §7 predicate and,
 * once it is final, activate the drop.
 *
 * Idempotent: re-submitting the hash that already activated a drop returns the
 * same state without touching money. Returns the drop's current public state
 * rather than throwing whenever the outcome is merely "not yet" — not visible on
 * chain, or visible but not final.
 */
export async function submitFunding(
  pool: Pool,
  chain: ChainClient,
  o: { publicId: string; txHash: string },
): Promise<DropPublic> {
  const { publicId, txHash } = o
  const drop = await loadDrop(pool, publicId)

  // Already activated by exactly this transaction: idempotent replay.
  if (drop.funding_tx_hash === txHash && !ACTIVATABLE_STATES.includes(drop.state)) {
    return toPublic(drop)
  }
  if (!ACTIVATABLE_STATES.includes(drop.state)) {
    throw new FundingRejectedError('drop_not_fundable', 'drop is not awaiting funding')
  }
  // A drop holds at most one funding transaction, for its whole life. A second
  // deposit — including a replacement after the first was reorged away — is an
  // operator reconciliation item (design §7), never automatic extra capacity.
  if (drop.funding_tx_hash !== null && drop.funding_tx_hash !== txHash) {
    throw new FundingRejectedError(
      'drop_not_fundable',
      'a different funding transaction was already submitted for this drop',
    )
  }
  await assertHashUnusedElsewhere(pool, publicId, txHash)
  // Cheap pre-check so the sponsor is told the truth before a chain round trip;
  // `activate()` re-checks it under the custody lock, which is the authority.
  await assertHashNotAttestedFloat(pool, txHash)

  // ---- chain verification, OUTSIDE any database transaction ----------------

  if (chain.network() !== requireNetwork()) {
    throw new FundingRejectedError(
      'wrong_network',
      `funding observed on ${chain.network()}, expected ${requireNetwork()}`,
    )
  }

  const tx = await findTx(chain, txHash)
  if (tx === null) {
    // Not detected yet, or gone in a reorg before it ever finalized. Either way
    // the drop simply stays where it is: no error, no recorded hash, and a
    // funding_pending drop freezes rather than activating (design §12.1).
    return toPublic(drop)
  }

  if (!tx.executionOk) {
    throw new FundingRejectedError('execution_failed', 'funding transaction failed execution')
  }
  if (tx.recipient !== chain.custodyAddress()) {
    throw new FundingRejectedError('wrong_recipient', 'funding was not sent to the custody address')
  }
  const expectedFundingLuna = BigInt(drop.expected_funding_luna)
  if (tx.valueLuna !== expectedFundingLuna) {
    throw new FundingRejectedError(
      'wrong_amount',
      'funding amount does not exactly match the expected total',
    )
  }
  // Exact equality only — a memo that merely CONTAINS the id never activates.
  if (tx.dataUtf8 !== fundingMemoFor(publicId)) {
    throw new FundingRejectedError('wrong_memo', 'funding memo does not match this drop')
  }
  if (!tx.sender) {
    throw new FundingRejectedError('invalid_sender', 'funding transaction has no valid sender')
  }

  if (!chain.isFinal(tx, await chain.headHeight())) {
    await recordPending(pool, publicId, txHash)
    return getPublic(pool, publicId)
  }

  // ---- activation ----------------------------------------------------------

  // Reconcile after finality, before the transaction: `lockControls` refuses to
  // move money on a stale reconciliation, and this is also where the chain
  // cross-check would notice custody holding less than the books claim — before
  // a new liability is added rather than after.
  await reconcile(pool, chain)
  await activate(pool, drop.id, publicId, txHash, tx, expectedFundingLuna)
  return getPublic(pool, publicId)
}

/**
 * Record a verified-but-not-yet-final funding transaction against the drop.
 *
 * `cancelled` is accepted here for the same reason `activate` accepts it
 * (finding 7): the transaction has already passed every §7 predicate except our
 * own finality, so the drop has verified money pointed at it and must stop
 * being garbage. Recording the hash also takes it out of `gcDrafts`' reach for
 * good.
 */
async function recordPending(pool: Pool, publicId: string, txHash: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE drops
       SET state = 'funding_pending', funding_tx_hash = $2
       WHERE public_id = $1
         AND state IN ('awaiting_funding', 'funding_pending', 'cancelled')
         AND (funding_tx_hash IS NULL OR funding_tx_hash = $2)`,
      [publicId, txHash],
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FundingRejectedError('reused_hash', 'funding transaction already funded another drop')
    }
    if (isFloatExclusivityViolation(err)) {
      throw new FundingRejectedError(
        'attested_as_float',
        'that transaction is already attested as operator float; it cannot also fund a drop',
      )
    }
    throw err
  }
}

/**
 * The single activation transaction. Lock order is `custody_controls` → drop
 * row, always: taking them the other way round deadlocks against the claim and
 * expiry paths.
 */
async function activate(
  pool: Pool,
  dropId: string,
  publicId: string,
  txHash: string,
  tx: ChainTx,
  expectedFundingLuna: bigint,
): Promise<void> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const controls = await lockControls(client)

    const { rows } = await client.query<{ state: DropState; funding_tx_hash: string | null }>(
      'SELECT state, funding_tx_hash FROM drops WHERE id = $1 FOR UPDATE',
      [dropId],
    )
    const current = rows[0]
    if (!current) throw new DropNotFoundError(publicId)

    if (!ACTIVATABLE_STATES.includes(current.state)) {
      // A concurrent caller activated it first with this same transaction:
      // that is the idempotent outcome, not a conflict.
      if (current.funding_tx_hash === txHash) {
        await client.query('ROLLBACK')
        return
      }
      throw new FundingRejectedError('drop_not_fundable', 'drop is not awaiting funding')
    }
    if (current.funding_tx_hash !== null && current.funding_tx_hash !== txHash) {
      throw new FundingRejectedError(
        'drop_not_fundable',
        'a different funding transaction was already submitted for this drop',
      )
    }
    await assertHashUnusedElsewhere(client, publicId, txHash)
    // R2, under the custody lock — the same lock `float set` takes, which is
    // what makes this check and that command mutually exclusive rather than
    // racing. Migration 008's trigger enforces it in the schema as well.
    await assertHashNotAttestedFloat(client, txHash)

    // The drop is not yet counted in outstanding principal (`activated_height`
    // is still NULL), so its whole principal is what this activation adds.
    await assertSolvent(client, controls, expectedFundingLuna)

    await client.query(
      `UPDATE drops
       SET state = 'live',
           creator_address = $2,
           refund_address = $2,
           funding_tx_hash = $3,
           activated_height = $4,
           expires_at = now() + make_interval(hours => $5)
       WHERE id = $1`,
      [dropId, tx.sender, txHash, tx.includedHeight.toString(), EXPIRY_HOURS],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (isUniqueViolation(err)) {
      throw new FundingRejectedError('reused_hash', 'funding transaction already funded another drop')
    }
    if (isFloatExclusivityViolation(err)) {
      throw new FundingRejectedError(
        'attested_as_float',
        'that transaction is already attested as operator float; it cannot also fund a drop',
      )
    }
    throw err
  } finally {
    client.release()
  }
}
