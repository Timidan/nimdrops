/**
 * Luna arithmetic and the one shape rule a drop has to satisfy.
 *
 * There is deliberately no size ceiling and no headcount ceiling here. How much
 * a drop holds and how many people it is split across are the sponsor's
 * decisions; what the deployment will accept is decided by
 * `services/solvency.ts` against the ledger, under the singleton custody lock,
 * and that is the only authority on the subject.
 *
 * The two rules that remain are both FLOORS, and neither bounds a drop from
 * above: at least {@link MIN_CLAIMS} people, and at least
 * {@link MIN_AMOUNT_EACH_LUNA} for each of them.
 */
export const LUNA_PER_NIM = 100_000n
/** A one-person drop is a Cashlink, not a drop. Two is the floor. */
export const MIN_CLAIMS = 2

/**
 * The smallest share a drop may promise one person: 0.1 NIM.
 *
 * This is NOT a size or headcount cap through the back door, and the difference
 * matters. A cap says "your drop may not be this big". This says "a share has to
 * be worth having", and it leaves every total and every headcount expressible:
 * a sponsor may still fund any amount for any number of people, and the cost of
 * doing so simply scales with the number of people, which is the property that
 * was missing.
 *
 * WHAT IT IS FOR. With no headcount ceiling and a one-luna share, a 14,400-person
 * drop costs 0.144 NIM — and 14,400 people is what the default claim rate limits
 * (10 per drop per minute) allow inside a 24-hour window. That drop costs its
 * sponsor nothing and costs the deployment 14,400 payouts: one signature, one
 * broadcast, and one chain lookup per tick per unconfirmed payout, ahead of
 * every other drop in the same worker. The old 20-claim ceiling was what bounded
 * it; nothing did afterwards. At this floor the same drop costs 1,440 NIM, and
 * that NIM is not spent on the attack — it is escrowed, and it is paid to
 * whoever claims. The cheap version of the attack stops being cheap, and the
 * expensive version funds its own victims.
 *
 * WHY 0.1 NIM AND NOT MORE. It has to clear every real use, and the smallest
 * real one is a meetup handing out 0.5 NIM a head — five times this floor. A
 * share below 0.1 NIM is not a gift anyone notices; a claimant's own wallet
 * rounds it away. Ten times higher would start refusing plausible drops, and ten
 * times lower would put the 14,400-person drop back at pocket change.
 *
 * It can be lowered later without stranding anything — existing drops keep the
 * shares they were funded with — and raised only against evidence.
 */
export const MIN_AMOUNT_EACH_LUNA = 10_000n

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
  if (amountEachLuna < MIN_AMOUNT_EACH_LUNA)
    throw new DropShapeError(`each person must get at least ${formatNim(MIN_AMOUNT_EACH_LUNA)} NIM`)
  if (claimCount > MAX_CLAIM_COUNT)
    throw new DropShapeError(`a drop cannot record more than ${MAX_CLAIM_COUNT} people`)
  if (amountEachLuna > MAX_LUNA / BigInt(claimCount))
    throw new DropShapeError('that total is larger than any amount of NIM that exists')
}
