export const LUNA_PER_NIM = 100_000n
export const MAX_TOTAL_LUNA = 100n * LUNA_PER_NIM
export const MIN_CLAIMS = 2
export const MAX_CLAIMS = 20
export class CapError extends Error {}

export function lunaFromNim(nim: string): bigint {
  if (!/^\d+(\.\d{1,5})?$/.test(nim)) throw new CapError(`invalid NIM amount: ${nim}`)
  const [whole, frac = ''] = nim.split('.')
  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(frac.padEnd(5, '0'))
  if (luna <= 0n) throw new CapError('amount must be positive')
  return luna
}
export function formatNim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const frac = (luna % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
export function assertCaps(amountEachLuna: bigint, claimCount: number): void {
  if (!Number.isInteger(claimCount) || claimCount < MIN_CLAIMS || claimCount > MAX_CLAIMS)
    throw new CapError(`claim count must be ${MIN_CLAIMS}-${MAX_CLAIMS}`)
  if (amountEachLuna <= 0n) throw new CapError('amount must be positive')
  if (amountEachLuna * BigInt(claimCount) > MAX_TOTAL_LUNA)
    throw new CapError('total exceeds 100 NIM launch cap')
}
