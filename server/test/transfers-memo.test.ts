import { describe, expect, it } from 'vitest'
import { MEMO_MAX_BYTES } from '../src/chain/types'
import { claimMemo, refundMemo } from '../src/services/transfers'

const A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const B = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9'

/**
 * Why a payout's data field must differ per claim.
 *
 * Nimiq basic transactions carry no account nonce. A payout's bytes are exactly
 * sender, recipient, value, fee, data, validity-start-height and network id, so
 * with one CONSTANT memo two payouts of equal value to one address signed at the
 * same head height are byte-identical — and therefore hash-identical. `tx_hash`
 * is UNIQUE on `transaction_attempts`, so that surfaces as a rolled-back signing
 * tick rather than a double payment, but it takes the tick's reconciliation pass
 * down with it and logs a unique violation.
 *
 * Unreachable while amounts vary and one drop is live at a time. A campaign with
 * a fixed amount per winner, where one address can win twice, makes it ordinary.
 */
describe('claimMemo', () => {
  it('differs for two claim ids', () => {
    expect(claimMemo(A)).not.toBe(claimMemo(B))
  })

  it('is stable for one claim id', () => {
    expect(claimMemo(A)).toBe(claimMemo(A))
  })

  it('fits the hard 64-byte transaction data limit', () => {
    expect(Buffer.byteLength(claimMemo(A), 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
  })

  it('still reads as a NimDrop to someone looking at their wallet', () => {
    expect(claimMemo(A)).toContain('NimDrop')
  })
})

describe('refundMemo', () => {
  it('differs for two drop ids', () => {
    expect(refundMemo(A)).not.toBe(refundMemo(B))
  })

  it('fits the hard 64-byte transaction data limit', () => {
    expect(Buffer.byteLength(refundMemo(A), 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
  })

  // A sponsor reading their own wallet history should be able to tell the money
  // coming back from money going out, without opening the app.
  it('is distinguishable from a payout for the same id', () => {
    expect(refundMemo(A)).not.toBe(claimMemo(A))
  })
})

describe('memo byte budget', () => {
  // The ids above are real v4 UUID shapes, but the check that matters is the
  // worst case: every memo this module can produce, for any id, at the limit.
  it('holds for an all-f id, which is the longest short form', () => {
    const longest = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    for (const memo of [claimMemo(longest), refundMemo(longest)]) {
      expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
    }
  })
})
