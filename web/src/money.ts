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
