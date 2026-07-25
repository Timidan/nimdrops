/**
 * Luna arithmetic for the browser — a deliberate mirror of `server/src/money.ts`.
 *
 * The server is authoritative: it recomputes every total, re-checks every cap,
 * and its `expectedFundingLuna` is what the wallet is asked to send. This module
 * exists only so the create screen can show a total before a round trip, and it
 * follows the same one rule as the server: NIM never becomes a JS `number`.
 */
export const LUNA_PER_NIM = 100_000n
export const MAX_TOTAL_LUNA = 100n * LUNA_PER_NIM
export const MIN_CLAIMS = 2
export const MAX_CLAIMS = 20

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

export type CapProblem = 'amount' | 'claims' | 'total'

/** The same three launch caps the server enforces, phrased for a form. */
export function capProblem(amountEachLuna: bigint | null, claimCount: number): CapProblem | null {
  if (amountEachLuna === null || amountEachLuna <= 0n) return 'amount'
  if (!Number.isInteger(claimCount) || claimCount < MIN_CLAIMS || claimCount > MAX_CLAIMS) return 'claims'
  if (amountEachLuna * BigInt(claimCount) > MAX_TOTAL_LUNA) return 'total'
  return null
}
