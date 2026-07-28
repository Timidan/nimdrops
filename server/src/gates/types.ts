/**
 * Shared vocabulary for conditional claim gates (spec §4).
 *
 * A gate is a condition a wallet must satisfy before it may claim its fixed
 * share of a drop. Three kinds ship, and the point of this module is that none
 * of them knows about the others: a kind may import from here, and nothing here
 * may import a kind.
 *
 * The dependency direction is deliberate and is checked in the plan's
 * verification list:
 *
 *     services/claims.ts   ──►  (nothing under gates/)
 *     services/gates.ts    ──►  gates/*
 *     gates/<kind>.ts      ──►  gates/types.ts, gates/grants.ts
 *
 * `services/claims.ts` importing a kind would drag the question bank, the
 * selection salt and the attester keys into the money path. A kind importing
 * back from `services/` would turn the one-way arrow into a cycle.
 */
import { normaliseNimiqAddress } from '../nimiq-address'

/** The conditions a drop can carry. Mirrors `drop_gates_kind_allowed`. */
export type GateKind = 'trivia' | 'passphrase' | 'attested'

/**
 * Why a gate attempt was refused.
 *
 * Callers map these to generic client-facing messages — the same discipline
 * `ClaimRejectionCode` already follows, so a service message can be reworded
 * without a new sentence reaching a client by accident.
 */
export type GateRejectionCode =
  /** This drop carries no condition at all. */
  | 'not_a_game'
  /** The drop behind the gate can no longer allocate. */
  | 'game_not_live'
  /** Right drop, wrong kind of attempt — e.g. a phrase posted to a quiz. */
  | 'wrong_kind'
  /**
   * The drop's own `config` is invalid. An OPERATOR fault, never the player's.
   *
   * It exists because the two alternatives both lie. Reporting it as
   * `bad_attempt` tells a player they guessed wrong when they did not, and
   * throwing a bare error turns a typo in one drop's config into a 500 that
   * looks like an outage. The HTTP layer maps this to a 5xx — the request was
   * fine, the deployment is not — while still naming the real cause in the log.
   */
  | 'misconfigured'
  /** This wallet already satisfied the condition; it should be claiming. */
  | 'already_granted'
  /** Too soon after the previous attempt. */
  | 'cooldown'
  /** Attempt budget for this wallet on this drop is spent. */
  | 'too_many_attempts'
  /** A wrong answer, phrase, or otherwise unmet condition. */
  | 'bad_attempt'
  | 'session_not_found'
  | 'session_over'
  | 'deadline_missed'
  /** Answer submitted for something other than the question in play. */
  | 'wrong_index'
  /** A higher tier that this wallet has not unlocked. */
  | 'tier_locked'
  /** A third-party attestation that does not verify, or does not apply here. */
  | 'bad_attestation'
  | 'attestation_replayed'
  /** The wallet address given is not a valid Nimiq address. */
  | 'bad_address'

export class GateError extends Error {}

export class GateRejectedError extends GateError {
  constructor(
    readonly code: GateRejectionCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

/** One `drop_gates` row, joined to the drop it gates. */
export interface GateRow {
  dropId: string
  publicId: string
  kind: GateKind
  listed: boolean
  /**
   * Kind-specific settings, validated by that kind's module and never by the
   * claim path. It holds secrets for two of the three kinds — the passphrase
   * hash and the attester public key — so it must never be serialised to a
   * client wholesale.
   */
  config: Record<string, unknown>
  dropState: string
}

/**
 * The one spelling of a wallet address, or a rejection.
 *
 * EVERY kind calls this on the way in, before the address reaches a lock key, a
 * lookup, an insert or a grant. The HTTP layer already normalises, and this is
 * not redundant with it: the boundary is where the rule is currently obeyed, and
 * this is where it is enforced. A spike script, an operator tool or a route added
 * later reaches the same functions without passing through `requireWalletAddress`
 * in `http/app.ts`, and every one of those callers would otherwise be one paste
 * away from splitting a wallet in two.
 *
 * Splitting a wallet in two is not cosmetic. `NQ07 ABCD…`, `nq07abcd…` and
 * `NQ07ABCD…` are one wallet and three strings, so they are three `gate_grants`
 * rows on a one-grant-per-wallet gate, three separate `passphrase_attempts`
 * budgets against a cap of five, and three disjoint `trivia_seen` sets. Two of
 * the three are also grants `reserveClaim` can never match, because it compares
 * against an address DERIVED from a verified signature — which has exactly one
 * spelling.
 */
export function requireGateWallet(raw: string): string {
  const address = normaliseNimiqAddress(raw)
  if (address === null) {
    throw new GateRejectedError('bad_address', 'that is not a valid Nimiq address')
  }
  return address
}

/**
 * Throws unless the drop behind this gate can still allocate.
 *
 * Every kind needs this, which is why it lives here rather than in
 * `services/gates.ts`: putting it there would make each kind import from
 * `services/` and reverse the one-way dependency described above.
 *
 * This is a courtesy check, not a safety one. `reserveClaim` re-reads the drop
 * state under a row lock, so a drop that closes between a granted condition and
 * a claim is refused there regardless. Checking here means a player is told
 * before they answer five questions, rather than after.
 */
export function assertGameLive(gate: GateRow): void {
  if (gate.dropState !== 'live') {
    throw new GateRejectedError('game_not_live', 'this drop is not accepting claims')
  }
}
