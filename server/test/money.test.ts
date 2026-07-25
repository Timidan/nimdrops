import { describe, expect, it } from 'vitest'
import { assertCaps, formatNim, lunaFromNim, LUNA_PER_NIM } from '../src/money'

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
  it('enforces launch caps', () => {
    expect(() => assertCaps(100_000n, 1)).toThrow()      // < MIN_CLAIMS
    expect(() => assertCaps(100_000n, 21)).toThrow()     // > MAX_CLAIMS
    expect(() => assertCaps(1_000_000n, 20)).toThrow()   // 200 NIM total > cap
    expect(() => assertCaps(100_000n, 20)).not.toThrow() // 20 NIM total
  })
})
