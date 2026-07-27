import { describe, expect, it } from 'vitest'
import {
  assertDropShape,
  formatNim,
  lunaFromNim,
  LUNA_PER_NIM,
  MIN_AMOUNT_EACH_LUNA,
} from '../src/money'

describe('money', () => {
  it('parses NIM decimal strings to luna exactly', () => {
    expect(lunaFromNim('1')).toBe(100_000n)
    expect(lunaFromNim('0.00001')).toBe(1n)
    expect(lunaFromNim('2.5')).toBe(250_000n)
  })
  it('rejects negatives, zero, >5 decimals, junk', () => {
    for (const bad of ['-1', '0', '1.000001', 'abc', '1e3', ''])
      expect(() => lunaFromNim(bad)).toThrow()
  })
  it('formats luna back to NIM', () => {
    expect(formatNim(250_000n)).toBe('2.5')
    expect(formatNim(1n)).toBe('0.00001')
  })
  it('requires at least two people and a positive amount', () => {
    expect(() => assertDropShape(100_000n, 1)).toThrow()  // < MIN_CLAIMS
    expect(() => assertDropShape(100_000n, 2.5)).toThrow() // not a whole number
    expect(() => assertDropShape(0n, 5)).toThrow()
    expect(() => assertDropShape(-1n, 5)).toThrow()
  })
  it('puts no ceiling on the total or on the headcount', () => {
    // The product is one signature funding many payouts. A 20-person ceiling
    // and a 100 NIM total ceiling both used to live here; neither does now, and
    // what a deployment will actually accept is decided by the solvency
    // invariant against its own ledger.
    expect(() => assertDropShape(200_000n, 100)).not.toThrow() // 200 NIM, 100 people
    expect(() => assertDropShape(100_000n, 10_000)).not.toThrow()
    expect(() => assertDropShape(MIN_AMOUNT_EACH_LUNA, 1_000_000)).not.toThrow()
  })

  // ---- the share floor ---------------------------------------------------------

  it('refuses a share below the floor, and takes the floor itself', () => {
    // The floor is what makes HEADCOUNT cost something now that nothing caps
    // it. A 14,400-person drop of one luna each cost 0.144 NIM and bought
    // 14,400 payouts in a worker every other drop shares.
    expect(() => assertDropShape(1n, 2)).toThrow(/at least 0\.1 NIM/)
    expect(() => assertDropShape(MIN_AMOUNT_EACH_LUNA - 1n, 2)).toThrow(/at least 0\.1 NIM/)
    expect(() => assertDropShape(MIN_AMOUNT_EACH_LUNA, 2)).not.toThrow()
  })

  it('leaves every real drop expressible', () => {
    // The smallest use anyone named: a meetup handing out 0.5 NIM a head. It
    // is five times the floor, and it must not have become harder to express.
    expect(() => assertDropShape(50_000n, 40)).not.toThrow()
    // And nothing above it is bounded: the floor is a floor, not a cap.
    expect(() => assertDropShape(100_000_000n, 2_000)).not.toThrow()
  })
})
