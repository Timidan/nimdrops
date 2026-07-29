import type { Pool, PoolClient } from 'pg'
import { ChainCallTimeoutError, withChainDeadline } from '../chain/deadline'
import { MEMO_MAX_BYTES, type ChainClient, type ChainTx } from '../chain/types'
import { errorMessage, requireNetwork } from '../config'
import type { Queryable } from '../db/pool'
import type { GateKind } from '../gates/types'
import { newPublicId } from '../ids'
import { assertDropShape, formatNim } from '../money'
import {
  type CapacitySnapshot,
  assertCapacityFor,
  assertSolvent,
  lockControls,
  lockControlsForCapacity,
  readCapacity,
  reconcile,
} from './solvency'

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

/**
 * The claim window a sponsor gets when they do not choose one.
 *
 * Expiry is measured from finalized activation, never from draft creation: the
 * window begins when the network confirms the funding, not when the sponsor
 * taps send. Every caller that omits `expiryHours` lands here, which is what
 * makes the parameter additive rather than a change to existing behaviour.
 */
export const DEFAULT_EXPIRY_HOURS = 24

/**
 * The shortest window a sponsor may choose, and it exists to protect CLAIMANTS.
 *
 * A drop that expires before anyone realistically opens the link refunds every
 * unclaimed share to the sponsor, at no cost to them, having advertised money
 * nobody had a real chance to take. That is indistinguishable from a scam even
 * when it is not one, and the floor is what stops the product from being able
 * to express it. An hour is the shortest window in which a link posted into a
 * group chat can plausibly be opened by the people in it — and because the
 * clock starts at finalized activation, none of that hour is spent waiting on
 * the chain.
 */
export const MIN_EXPIRY_HOURS = 1

/**
 * The longest window a sponsor may choose. It bounds CUSTODY DURATION.
 *
 * There is no on-chain escrow: the operator's hot key can move a drop's
 * principal for as long as the drop is live, and since migration 015 there is
 * no ceiling on how large a drop is. "Any amount for any length of time" is a
 * materially different risk from the one this product carried before, so the
 * time half of it is bounded here.
 *
 * Fourteen days rather than a month, for three reasons that agree:
 *
 *  - **How long a sponsor can be locked in.** When this ceiling was chosen
 *    nothing could end a drop early — `sweepExpiry` at `expires_at` was the
 *    only exit — so the number was not "the longest claim window" but "the
 *    longest a sponsor can lock their own money with no way out".
 *    `services/close.ts` has since given them the way out: the wallet that
 *    funded a drop can close it and take back what nobody claimed. That
 *    weakens this argument rather than removing it — the ceiling still bounds
 *    a drop the sponsor has abandoned or lost the key to — so the number
 *    stands until it is re-argued on its own merits.
 *  - **Every campaign shape fits inside it**: an evening, a weekend, a
 *    week-long conference, a fortnight's push. A month is not a longer
 *    campaign, it is a deposit, and this is not a deposit product.
 *  - **The operator has to be there for all of it.** The signer and the sweeper
 *    must stay alive for the whole window of every outstanding drop. A ceiling
 *    nobody can credibly commit to is a promise the deployment has not earned.
 *
 * It can be raised later against evidence. It cannot be lowered without
 * stranding drops that were funded under the old number.
 */
export const MAX_EXPIRY_HOURS = 24 * 14

/**
 * A window in the units a person would say it in: `"24 hour"`, `"3 day"`.
 *
 * Days only once there is more than one of them AND the window is a whole
 * number of them, so nothing ever reads "1.5 day" or "1 day" where the sponsor
 * picked twenty-four hours. Returns the bare quantity so callers can put their
 * own noun after it.
 */
export function formatExpiryWindow(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} day`
  return `${hours} hour`
}

/**
 * How long funding instructions hold aggregate cap headroom (migration 014).
 *
 * Two failure directions, and the number sits between them.
 *
 *  - TOO SHORT and a sponsor who is still reading the confirmation screen loses
 *    their room to somebody else; they then pay, and the activation that used to
 *    fail before this change fails after it instead. That is the exact bug being
 *    fixed, so the window has to be comfortably longer than a real funding flow:
 *    open the wallet, read the disclosure, approve, and wait out macro finality.
 *  - TOO LONG and an abandoned draft keeps everyone else out. On a pilot capped
 *    at one live drop, a single tab left open would close the product.
 *
 * Thirty minutes is roughly thirty times the funding flow and roughly a
 * forty-eighth of the 24-hour draft GC horizon. It is deliberately NOT the GC
 * horizon: garbage collection answers "when may this row be deleted", which is
 * a question about storage, and a reservation answers "how long did we promise
 * a stranger room", which is a question about other sponsors.
 *
 * A draft that has a funding hash recorded against it keeps its room past this
 * window regardless — see `reservedPrincipalLuna`. The sponsor has paid by then.
 */
export const FUNDING_RESERVATION_MINUTES = 30

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

/** A claim window outside {@link MIN_EXPIRY_HOURS}..{@link MAX_EXPIRY_HOURS}. */
export class ExpiryWindowError extends DropError {}

/**
 * The server-side bound, and the only one that decides anything.
 *
 * `web/` mirrors these numbers so a form can refuse before a round trip, but a
 * mirror is a convenience: this function is what a drop's window is actually
 * held to, and `drops_expiry_hours_range` (migration 016) is the backstop that
 * holds even if this is wrong.
 */
export function assertExpiryHours(hours: number): void {
  if (!Number.isInteger(hours) || hours < MIN_EXPIRY_HOURS || hours > MAX_EXPIRY_HOURS) {
    throw new ExpiryWindowError(
      `a claim window must be a whole number of hours between ${MIN_EXPIRY_HOURS} and ${MAX_EXPIRY_HOURS}`,
    )
  }
}

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

/**
 * Test-only control over the funding path's chain deadline.
 *
 * Production never passes it: the money engine's own
 * {@link CHAIN_CALL_TIMEOUT_MS} is the number, and it is not an operator dial.
 */
export interface FundingChainOptions {
  /** @internal TEST-ONLY override of `CHAIN_CALL_TIMEOUT_MS`. */
  chainTimeoutMs?: number
}

/**
 * Why a drop stopped being claimable, as `drops.closing_reason` records it.
 *
 * Every value the column may hold, not only the two {@link ClosingReason} a
 * close writes: `exhausted` is written by the claim that takes the last slot.
 * `null` — a drop that has not closed — is the projection's own absence, never
 * a default.
 */
export type PublicClosingReason = 'expired' | 'exhausted' | 'closed_by_sponsor'

const PUBLIC_CLOSING_REASONS: readonly string[] = ['expired', 'exhausted', 'closed_by_sponsor']

/**
 * The column, narrowed to what this projection promises.
 *
 * A value this build does not know about becomes `null` rather than travelling
 * as an unrecognised string: a screen that branched on it would be branching on
 * a word nobody here chose, and "we are not telling you why" is the honest
 * degradation. Unreachable while `drops_closing_reason_allowed` stands.
 */
function toClosingReason(raw: string | null): PublicClosingReason | null {
  if (raw === null || !PUBLIC_CLOSING_REASONS.includes(raw)) return null
  return raw as PublicClosingReason
}

/** Public-safe projection of a drop. Never carries claimant addresses or row ids. */
export interface DropPublic {
  publicId: string
  sponsorLabel: string
  message: string | null
  /** Decimal NIM string, e.g. `"2.5"`. */
  amountEach: string
  /** `null` for an uncapped drop (migration 025) — no slot ceiling exists. */
  claimCount: number | null
  /** Slots not yet reserved, or `null` for an uncapped drop. */
  remaining: number | null
  state: DropState
  /**
   * The window this drop was created with, in hours. Present on every drop,
   * funded or not — a claimant reading an unfunded drop can still be told how
   * long it will run once it goes live, which `expiresAt` cannot say yet.
   */
  expiryHours: number
  expiresAt: Date | null
  /**
   * Why this drop is no longer claimable, or `null` while it still is.
   *
   * Served rather than inferred. The claimant's screen used to derive "the
   * sponsor ended this early" from state, remaining and the deadline, which is
   * a guess that breaks in exactly the case it exists for — a sponsor closing a
   * drop in its last minutes reads as an ordinary expiry.
   *
   * Safe on an unauthenticated projection: it says only why the person holding
   * the link cannot claim, which is the one thing they are owed. It names no
   * sponsor address, no claimant, no time of the decision and no amount.
   */
  closingReason: PublicClosingReason | null
  fundingTxHash?: string
  /**
   * The kind of condition gating this drop, or `null` for an ungated one.
   *
   * Served so a pre-claim screen can phrase the amount honestly: `'trivia'` is
   * the one kind whose payout is a score-derived fraction of the share, so it
   * is the one kind the claim surface promises only "up to". It names the
   * KIND alone — never the passphrase hint, the question bank, or whether the
   * reader's own wallet holds a grant.
   */
  gateKind: string | null
}

export interface CreateDraftInput {
  sponsorLabel: string
  message?: string
  amountEachLuna: bigint
  claimCount: number
  /**
   * How long the drop stays claimable once funding is final. Omitted means
   * {@link DEFAULT_EXPIRY_HOURS}, so every caller written before this existed
   * gets exactly the behaviour it had.
   */
  expiryHours?: number
}

export interface Draft {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFundingLuna: bigint
  /** The window this drop will have. Fixed here; nothing can change it later. */
  expiryHours: number
  /** When this draft stops holding aggregate cap headroom. */
  reservationExpiresAt: Date
  /** The capacity picture AFTER this reservation, for the sponsor's disclosure. */
  capacity: CapacitySnapshot
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
 * Create an unfunded draft AND reserve the aggregate capacity its funding will
 * need (migration 014).
 *
 * This function used to take no locks, on the reasoning that a draft holds no
 * money. The reasoning was wrong in one specific way: it hands a sponsor the
 * custody address and an exact amount, which is a PROMISE that the money will
 * be accepted. `max_live_principal_luna` was only enforced in `activate()`, by
 * which time the sponsor's transaction is on chain and final — so any number of
 * sponsors could be promised room that only one of them had, all pay, and every
 * activation after the first fail on money already sitting in custody. Refusing
 * there is the most expensive possible place to refuse.
 *
 * So capacity is committed here, where refusing costs a sponsor nothing but a
 * sentence on screen. The shape is the same one every other money path uses:
 *
 *  - ONE transaction, opened with the singleton `custody_controls` lock, which
 *    is what makes two concurrent drafts see each other. Lock order is
 *    `custody_controls` → drop, unchanged: the only drop row touched is the one
 *    this INSERT creates.
 *  - `lockControlsForCapacity` rather than `lockControls`, because a
 *    reservation spends nothing and therefore does not need a fresh
 *    reconciliation. The pause switch still applies — see that function.
 *  - the reservation EXPIRES (`FUNDING_RESERVATION_MINUTES`), so an abandoned
 *    draft gives its headroom back instead of holding it until draft GC.
 *
 * The one chain call is `custodyAddress()`, which is local.
 */
export async function createDraft(
  pool: Pool,
  chain: ChainClient,
  o: CreateDraftInput,
): Promise<Draft> {
  assertDropShape(o.amountEachLuna, o.claimCount)
  // The window is decided HERE and nowhere else. `activate()` reads it back out
  // of the row rather than off anything a later request carried, so this INSERT
  // is the one and only write of it in the system.
  const expiryHours = o.expiryHours ?? DEFAULT_EXPIRY_HOURS
  assertExpiryHours(expiryHours)
  const expectedFundingLuna = o.amountEachLuna * BigInt(o.claimCount)
  const publicId = newPublicId()
  const fundingMemo = fundingMemoFor(publicId)

  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const controls = await lockControlsForCapacity(client)
    await assertCapacityFor(client, controls, expectedFundingLuna)

    const { rows } = await client.query<{ funding_reservation_expires_at: Date }>(
      `INSERT INTO drops (
         public_id, sponsor_label, message, claim_count, amount_each_luna,
         expected_funding_luna, expiry_hours, state, funding_reservation_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_funding',
                 now() + make_interval(mins => $8))
       RETURNING funding_reservation_expires_at`,
      [
        publicId,
        o.sponsorLabel,
        o.message ?? null,
        o.claimCount,
        o.amountEachLuna.toString(),
        expectedFundingLuna.toString(),
        expiryHours,
        FUNDING_RESERVATION_MINUTES,
      ],
    )

    // Read back INSIDE the transaction, so the numbers the sponsor is shown
    // already include their own reservation. Computing them by subtraction
    // would be one arithmetic assumption; this is the same query the next
    // sponsor's refusal will be decided by.
    const capacity = await readCapacity(client, controls)
    await client.query('COMMIT')

    return {
      publicId,
      fundingAddress: chain.custodyAddress(),
      fundingMemo,
      expectedFundingLuna,
      expiryHours,
      reservationExpiresAt: rows[0].funding_reservation_expires_at,
      capacity,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface CreateOperatorFundedDropInput {
  sponsorLabel: string
  message?: string
  amountEachLuna: bigint
  /**
   * `null` creates an UNCAPPED drop (migration 025): no slot ceiling, no
   * `expected_funding_luna` total, running for as long as custody can cover
   * the next claim. Only legal here — an operator drop — never for a sponsor.
   */
  claimCount: number | null
  /** Omitted means {@link DEFAULT_EXPIRY_HOURS}, same as a sponsor draft. */
  expiryHours?: number
  /**
   * The gate this drop is created with. Operator-funded drops exist for gated
   * games (design doc "The ceremony being removed") — every gated game is
   * funded by the operator and by nobody else — so, unlike {@link createDraft},
   * there is no ungated shape here.
   *
   * `config` must already be validated THROUGH THE KIND'S OWN PARSER
   * (`parseTriviaConfig`, `parsePassphraseConfig`, `parseAttestedConfig`) by
   * the caller, exactly as `spike/create-gated-drop.ts` validates it today.
   * This function does not re-validate it: duplicating that validation here
   * would be a second place for a kind's config shape to be gotten wrong.
   */
  gate: {
    kind: GateKind
    listed: boolean
    config: Record<string, unknown>
  }
}

export interface OperatorFundedDrop {
  publicId: string
}

/**
 * Create a drop that is funded by the OPERATOR, not by a sponsor — the
 * replacement for the round trip in `spike/fund-one-drop.ts` (operator-funded
 * drops design doc, "The replacement").
 *
 * An operator drop moves no money: the NIM is already in custody, sitting in
 * the operator float, and this function only changes which bucket it is
 * counted in. It is therefore created directly `live`, in ONE transaction,
 * with `activated_height` NULL (it never goes through `activate()`) and
 * `refund_address` NULL (there is no verified sender to name — migration 024).
 *
 * Three things make this safe to run against real custody money:
 *
 *  1. **The lock order is the mandated one.** `lockControls` takes the
 *     singleton `custody_controls` row first, exactly as every other
 *     money-moving path does; this INSERT is the only "drop row" a create
 *     needs to take second, since there is no existing row to lock.
 *     `lockControls` (not `lockControlsForCapacity`) is used deliberately:
 *     unlike a sponsor's draft, this call commits a REAL liability in the
 *     same transaction, so it needs the same fresh-reconciliation guarantee
 *     `activate()` needs, not a capacity promise that spends nothing yet.
 *  2. **The optional policy caps are asserted too, via {@link assertCapacityFor}
 *     — the SAME check `createDraft` makes, and for the same reason.** This
 *     function is the one place a caller both PROMISES capacity and SPENDS it
 *     in a single transaction, so skipping this check would be a real gap, not
 *     a redundant one: `assertSolvent` (used for the balance check below)
 *     deliberately does NOT weigh a sponsor's outstanding draft reservations
 *     (`reservedPrincipalLuna`) — by design, because it decides whether to
 *     honour money that has ALREADY arrived, and a reservation is a promise to
 *     a sponsor who has not paid yet. `assertCapacityFor` is the check that
 *     DOES weigh those reservations, because it decides whether to make a NEW
 *     promise — exactly what this call is doing. Without it, an operator drop
 *     could commit principal a concurrent sponsor's reservation was already
 *     counting on, and that sponsor's finalized deposit would then fail
 *     `activate()`'s cap check with real NIM already on chain and nowhere to
 *     go. Called BEFORE the INSERT, on the pre-drop state, exactly as
 *     `createDraft` calls it before its own INSERT.
 *  3. **Solvency is asserted with the drop's principal ALREADY COUNTED as
 *     outstanding**, which is why the row is inserted BEFORE
 *     {@link assertSolvent} runs, and why that call passes `0n` rather than
 *     the principal. This is the one place this function deliberately does
 *     NOT copy `activate()`'s shape, and the reason is arithmetic, not style:
 *     `assertSolvent(client, controls, addLuna)` computes
 *     `ledger + addLuna >= outstanding + addLuna + reserve + …`, and `addLuna`
 *     CANCELS OUT of that comparison by construction — which is correct for
 *     `activate()` only because a sponsor's funding is a CREDIT to the ledger
 *     (`ledgerMovementsLuna` counts `activated_height IS NOT NULL`) at the
 *     exact same instant it becomes a liability, so the credit and the
 *     liability are the same number and net to nothing. An operator drop has
 *     no credit — `ledgerMovementsLuna` never counts it — so calling
 *     `assertSolvent` with `addLuna` set to the principal would silently
 *     charge nothing for the drop's size and pass for a float that covers
 *     only the fee reserve. Inserting the row first makes
 *     `outstandingPrincipalLuna` see the new liability on its own (it counts
 *     `funding_source = 'operator'` with no `activated_height` required), so
 *     `assertSolvent(client, controls, 0n)` — the same call `reserveClaim`
 *     and the signing path make for "this principal is already outstanding,
 *     add nothing new" — checks the true post-creation balance. A refusal
 *     here throws before `COMMIT`, so the INSERT never becomes visible
 *     outside this transaction.
 *
 * `ledgerMovementsLuna` is untouched by this drop: no funding transaction is
 * ever recorded for it, so `ledgerBalanceLuna` does not move. The arithmetic
 * that falls out is the whole point — headroom drops by exactly this
 * principal, and it returns by itself once the drop reaches `settled`
 * (`services/expiry.ts` writes no refund for an operator drop, because
 * nothing ever left custody to send back).
 *
 * The `drop_gates` row is written in the SAME transaction as the drop, so a
 * drop can never exist gate-less: unlike `spike/create-gated-drop.ts`'s
 * two-statement sequence (the drop must exist before `drop_gates.drop_id` can
 * reference it), there is no ungated intermediate state a claim could ever
 * observe here.
 */
export async function createOperatorFundedDrop(
  pool: Pool,
  o: CreateOperatorFundedDropInput,
): Promise<OperatorFundedDrop> {
  assertDropShape(o.amountEachLuna, o.claimCount)
  const expiryHours = o.expiryHours ?? DEFAULT_EXPIRY_HOURS
  assertExpiryHours(expiryHours)
  const expectedFundingLuna = o.claimCount === null ? null : o.amountEachLuna * BigInt(o.claimCount)
  const publicId = newPublicId()

  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const controls = await lockControls(client)

    // The optional policy caps, on the PRE-drop state — the same call and the
    // same reasoning `createDraft` uses before its own INSERT. Weighs
    // concurrent sponsors' draft reservations, which `assertSolvent` below
    // deliberately does not: see point 2 of the docstring above.
    //
    // Skipped for an UNCAPPED drop (migration 025): it has no fixed total, so
    // there is nothing to reserve against the optional aggregate cap here —
    // each claim's own `assertSolvent` call is what protects the float.
    if (expectedFundingLuna !== null) {
      await assertCapacityFor(client, controls, expectedFundingLuna)
    }

    // Inserted BEFORE the solvency check — see the docstring above for why:
    // `funding_source = 'operator'` alone makes `outstandingPrincipalLuna`
    // count this row from here on, in THIS transaction, so `assertSolvent`
    // below sees the true post-creation liability. A refusal rolls this back
    // before it is ever visible to another transaction.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, message, claim_count, amount_each_luna,
         expected_funding_luna, expiry_hours, state, funding_source,
         activated_height, refund_address, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'live', 'operator',
                 NULL, NULL, now() + make_interval(hours => $7))
       RETURNING id`,
      [
        publicId,
        o.sponsorLabel,
        o.message ?? null,
        o.claimCount,
        o.amountEachLuna.toString(),
        expectedFundingLuna === null ? null : expectedFundingLuna.toString(),
        expiryHours,
      ],
    )
    const dropId = rows[0].id

    // `0n`: the principal is already outstanding (the row above), and this
    // drop credits the ledger nothing — see the docstring for why passing the
    // principal itself here would be the wrong (sponsor) shape.
    await assertSolvent(client, controls, 0n)

    await client.query(
      `INSERT INTO drop_gates (drop_id, kind, listed, config)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [dropId, o.gate.kind, o.gate.listed, JSON.stringify(o.gate.config)],
    )

    await client.query('COMMIT')
    return { publicId }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

interface DropRow {
  id: string
  public_id: string
  sponsor_label: string
  message: string | null
  /** `null` for an uncapped drop (migration 025). */
  claim_count: number | null
  amount_each_luna: string
  /** `null` together with `claim_count` (migration 025). */
  expected_funding_luna: string | null
  state: DropState
  funding_tx_hash: string | null
  activated_height: string | null
  expiry_hours: number
  expires_at: Date | null
  closing_reason: string | null
  claims_reserved: string
  gate_kind: string | null
}

const SELECT_DROP = `
  SELECT d.id, d.public_id, d.sponsor_label, d.message, d.claim_count,
         d.amount_each_luna, d.expected_funding_luna, d.state, d.funding_tx_hash,
         d.activated_height, d.expiry_hours, d.expires_at, d.closing_reason,
         (SELECT count(*) FROM claims c WHERE c.drop_id = d.id)::text AS claims_reserved,
         (SELECT g.kind FROM drop_gates g WHERE g.drop_id = d.id) AS gate_kind
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
    remaining: row.claim_count === null ? null : Math.max(0, row.claim_count - reserved),
    state: row.state,
    expiryHours: row.expiry_hours,
    expiresAt: row.expires_at,
    closingReason: toClosingReason(row.closing_reason),
    gateKind: row.gate_kind,
    ...(row.funding_tx_hash === null ? {} : { fundingTxHash: row.funding_tx_hash }),
  }
}

/** Public-safe drop state. Safe to serve unauthenticated. */
export async function getPublic(pool: Pool, publicId: string): Promise<DropPublic> {
  return toPublic(await loadDrop(pool, publicId))
}

/**
 * Run one of the funding path's chain calls under the money engine's deadline
 * (`chain/deadline.ts`).
 *
 * The worker got this bound first, on the reasoning that a hung call there
 * stops every drop while a hung call here only parks one HTTP request. That
 * undersold it. This is the sponsor-facing call that decides whether the money
 * they have already sent was seen, it runs inside a request, and a node that
 * accepts the lookup and never answers leaves the browser waiting on it with no
 * end and no message — while the connection, the pool client behind it and the
 * sponsor's own attention are all held open. Ten seconds and a retryable answer
 * is strictly better than forever.
 */
function chainCall<T>(label: string, o: FundingChainOptions, call: () => Promise<T>): Promise<T> {
  return o.chainTimeoutMs === undefined
    ? withChainDeadline(label, call)
    : withChainDeadline(label, call, o.chainTimeoutMs)
}

/**
 * The real `@nimiq/core` client REJECTS with "Transaction not found" where
 * `FakeChain` resolves `null`. Both mean the same thing to us — the chain has
 * not shown us this transaction — and neither is an error the sponsor can act
 * on. Any OTHER failure (RPC down, consensus lost) propagates, so a degraded
 * node can never be mistaken for a missing transaction.
 *
 * A DEADLINE IS NOT AN ABSENCE, and the guard for that is structural rather
 * than lexical. `ChainCallTimeoutError` is re-thrown before the message is ever
 * matched, so no future wording of the timeout — or of this pattern list — can
 * turn "we could not ask" into "the chain does not have it". That distinction
 * is load-bearing: `null` here makes the endpoint answer 200 with the drop
 * unchanged, which tells a sponsor whose money HAS landed that it has not been
 * seen, and leaves a `funding_pending` drop frozen with no error anywhere.
 */
async function findTx(
  chain: ChainClient,
  txHash: string,
  o: FundingChainOptions,
): Promise<ChainTx | null> {
  try {
    return await chainCall('submitFunding.getTransaction', o, () => chain.getTransaction(txHash))
  } catch (err) {
    if (err instanceof ChainCallTimeoutError) throw err
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
  o: { publicId: string; txHash: string } & FundingChainOptions,
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

  const tx = await findTx(chain, txHash, o)
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
  // Unreachable: `ACTIVATABLE_STATES` (checked above) never includes a drop
  // born `live`, which is the only shape a NULL `expected_funding_luna`
  // (migration 025) can have. Guarded rather than cast, on a money path.
  if (drop.expected_funding_luna === null) {
    throw new FundingRejectedError('drop_not_fundable', 'drop has no fixed funding total')
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

  // EVERY §7 predicate has now passed, so the hash is recorded BEFORE anything
  // else is attempted — final or not.
  //
  // It used to be recorded only on the not-yet-final branch, on the reasoning
  // that a final transaction was about to activate anyway. That reasoning has a
  // hole the width of every reason activation can refuse: paused custody, a
  // stale reconciliation, a detected shortfall, an indeterminate broadcast. A
  // sponsor whose transaction reached finality before their first poll — or
  // whose only poll came after it — then had verified money sitting in the
  // custody wallet with NOTHING in the database pointing at it. The drop stayed
  // `awaiting_funding` with a NULL hash, its draft reservation expired, draft GC
  // was free to cancel it, and no figure anywhere counted the deposit.
  //
  // Recording first costs nothing and is the same write either way: the row is
  // taken out of `gcDrafts`' reach, its capacity reservation stops expiring
  // (`reservedPrincipalLuna`), and `unactivatedFundedPrincipalLuna` — which is
  // what the sponsor-facing disclosure reads — can see the money. `activate`
  // accepts `funding_pending` and re-checks the whole predicate under the
  // custody lock, so nothing here is trusted by it.
  await recordPending(pool, publicId, txHash)

  const head = await chainCall('submitFunding.headHeight', o, () => chain.headHeight())
  if (!chain.isFinal(tx, head)) {
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
 * Record a VERIFIED funding transaction against the drop.
 *
 * Called for every transaction that passes the §7 predicates, whether or not it
 * is final yet — see the call site for why the finality distinction was the
 * wrong place to draw this line.
 *
 * `cancelled` is accepted here for the same reason `activate` accepts it
 * (finding 7): the transaction has already passed every §7 predicate, so the
 * drop has verified money pointed at it and must stop being garbage. Recording
 * the hash also takes it out of `gcDrafts`' reach for good.
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
      // `funding_reservation_expires_at` is cleared as the principal moves from
      // reserved to outstanding. Stamping `activated_height` already takes the
      // row out of `reservedPrincipalLuna`, so this changes no arithmetic; it
      // stops the column from reading as a live promise on a drop that has
      // already been paid for.
      //
      // `expires_at` is computed from `expiry_hours` ON THE ROW, inside the
      // same statement, under the row lock taken above. That is what makes the
      // window immutable rather than merely un-updated: there is no parameter
      // here for a request body to reach, so no request — a second funding
      // submit, a replay, an operator command — can move the deadline a
      // claimant has already been shown. The only write of `expiry_hours` in
      // the system is `createDraft`'s INSERT.
      `UPDATE drops
       SET state = 'live',
           creator_address = $2,
           refund_address = $2,
           funding_tx_hash = $3,
           activated_height = $4,
           expires_at = now() + make_interval(hours => expiry_hours),
           funding_reservation_expires_at = NULL
       WHERE id = $1`,
      [dropId, tx.sender, txHash, tx.includedHeight.toString()],
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
