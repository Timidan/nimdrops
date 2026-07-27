/**
 * Luna arithmetic for the browser — a deliberate mirror of `server/src/money.ts`.
 *
 * The server is authoritative: it recomputes every total, re-checks the drop
 * shape, and its `expectedFundingLuna` is what the wallet is asked to send. This
 * module exists only so the create screen can show a total before a round trip,
 * and it follows the same one rule as the server: NIM never becomes a JS
 * `number`.
 *
 * There is no size ceiling here and no headcount ceiling. The total a drop holds
 * is the sponsor's decision, and the only limit left is whatever the deployment
 * publishes in `GET /api/custody` — read live and shown on the form, never
 * hard-coded in this file.
 */
export const LUNA_PER_NIM = 100_000n
/** A one-person drop is a Cashlink, not a drop. Two is the floor. */
export const MIN_CLAIMS = 2

/**
 * The widths of the two columns the server stores a drop in — NOT ceilings on
 * what a sponsor may do. `claim_count` is an INT and `expected_funding_luna` is
 * a BIGINT; a request past either is impossible rather than disallowed, and the
 * form refuses it here so the sponsor is not sent to a server error. The luna
 * bound is roughly four million times the entire NIM supply.
 */
export const MAX_CLAIM_COUNT = 2_147_483_647
export const MAX_LUNA = 9_223_372_036_854_775_807n

/**
 * The claim window, mirrored from `server/src/services/drops.ts`.
 *
 * A MIRROR, not the rule. The server refuses anything outside these bounds, and
 * migration 016's CHECK constraint refuses it again underneath that; these
 * numbers exist so the form can offer honest choices without a round trip. The
 * reasons for the two ends live on the server, where they are enforced: the
 * floor protects claimants from a drop that expires before anyone could open
 * the link, and the ceiling bounds how long the operator holds a sponsor's NIM
 * with no way for either of them to end it early.
 */
export const DEFAULT_EXPIRY_HOURS = 24
export const MIN_EXPIRY_HOURS = 1
export const MAX_EXPIRY_HOURS = 24 * 14

/**
 * The windows the form offers, shortest first.
 *
 * Discrete rather than a typed hour count, and the reasoning is the phone: a
 * number field asks the sponsor to convert "a weekend" into 72 and then to
 * discover the bounds by being refused, while a row of chips shows the whole
 * range at a glance and cannot express an invalid one. The ends of this list
 * ARE the bounds, so the shortest and longest windows this deployment allows
 * are visible without anyone having to be told no.
 */
export const EXPIRY_CHOICES: readonly number[] = [1, 6, 24, 72, 168, 336]

/**
 * A window as a standalone noun phrase: `"6 hours"`, `"3 days"`.
 *
 * Deliberately NOT the same string the server builds. The server produces a
 * bare quantity to put a noun after ("the 3 day claim window"); this produces
 * something a sentence can end on ("goes back after 3 days"). Neither is used
 * to restate a disclosure point — those are rendered as the server wrote them.
 */
export function expiryWindowLabel(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`
  return hours === 1 ? '1 hour' : `${hours} hours`
}

/**
 * The same window as a modifier, for a noun to follow: `"24 hour"`, `"3 day"`.
 *
 * English needs both forms and picking one would make half the sentences on
 * these screens ungrammatical — "its 1 hour are up", "its 24 hours window".
 * This matches the string the server builds for its own disclosure point.
 */
export function expiryWindowAdjective(hours: number): string {
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} day` : `${hours} hour`
}

/** Accepts a decimal NIM string with at most 5 places; `null` if it is not one. */
export function lunaFromNim(nim: string): bigint | null {
  if (!/^\d{1,9}(\.\d{1,5})?$/.test(nim)) return null
  const [whole, frac = ''] = nim.split('.')
  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(frac.padEnd(5, '0'))
  return luna > 0n ? luna : null
}

export function formatNim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const frac = (luna % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export type ShapeProblem = 'amount' | 'claims'

/**
 * The two things about a drop's shape the server refuses outright, phrased for
 * a form: an amount that is not a positive NIM figure, and fewer than
 * {@link MIN_CLAIMS} people.
 *
 * Everything else — how big the total is, how many people it is spread across —
 * is the sponsor's to choose. `null` means the shape is fine, which is not the
 * same as "this will be accepted": the deployment's own capacity is a live
 * number and the form checks the total against it separately.
 */
export function shapeProblem(
  amountEachLuna: bigint | null,
  claimCount: number,
): ShapeProblem | null {
  if (amountEachLuna === null || amountEachLuna <= 0n) return 'amount'
  if (!Number.isInteger(claimCount) || claimCount < MIN_CLAIMS) return 'claims'
  if (claimCount > MAX_CLAIM_COUNT) return 'claims'
  if (amountEachLuna > MAX_LUNA / BigInt(claimCount)) return 'amount'
  return null
}
