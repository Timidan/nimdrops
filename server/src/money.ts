/**
 * Luna arithmetic and the one shape rule a drop has to satisfy.
 *
 * There is deliberately no size ceiling and no headcount ceiling here. How much
 * a drop holds and how many people it is split across are the sponsor's
 * decisions; what the deployment will accept is decided by
 * `services/solvency.ts` against the ledger, under the singleton custody lock,
 * and that is the only authority on the subject.
 */
export const LUNA_PER_NIM = 100_000n
/** A one-person drop is a Cashlink, not a drop. Two is the floor. */
export const MIN_CLAIMS = 2

/**
 * The widths of the two columns a drop is stored in — NOT policy ceilings.
 *
 * `drops.claim_count` is INT and `drops.expected_funding_luna` is BIGINT, and
 * the schema computes the second from the first. A request past either would
 * reach Postgres as "integer out of range" and come back to the sponsor as a
 * 500, which is the wrong answer to a request that is simply impossible. They
 * are checked here so it is a 400 instead.
 *
 * Neither is a limit anyone will meet by accident: the BIGINT ceiling is roughly
 * four million times the entire NIM supply.
 */
export const MAX_CLAIM_COUNT = 2_147_483_647
export const MAX_LUNA = 9_223_372_036_854_775_807n

/** A drop the server will not build: a bad amount, or fewer than two people. */
export class DropShapeError extends Error {}

export function lunaFromNim(nim: string): bigint {
  if (!/^\d+(\.\d{1,5})?$/.test(nim)) throw new DropShapeError(`invalid NIM amount: ${nim}`)
  const [whole, frac = ''] = nim.split('.')
  const luna = BigInt(whole) * LUNA_PER_NIM + BigInt(frac.padEnd(5, '0'))
  if (luna <= 0n) throw new DropShapeError('amount must be positive')
  return luna
}
export function formatNim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const frac = (luna % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
export function assertDropShape(amountEachLuna: bigint, claimCount: number): void {
  if (!Number.isInteger(claimCount) || claimCount < MIN_CLAIMS)
    throw new DropShapeError(`a drop needs at least ${MIN_CLAIMS} people`)
  if (amountEachLuna <= 0n) throw new DropShapeError('amount must be positive')
  if (claimCount > MAX_CLAIM_COUNT)
    throw new DropShapeError(`a drop cannot record more than ${MAX_CLAIM_COUNT} people`)
  if (amountEachLuna > MAX_LUNA / BigInt(claimCount))
    throw new DropShapeError('that total is larger than any amount of NIM that exists')
}
