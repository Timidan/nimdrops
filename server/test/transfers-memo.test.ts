import { describe, expect, it } from 'vitest'
import { MEMO_MAX_BYTES } from '../src/chain/types'
import { transferMemo } from '../src/services/transfers'

const A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const B = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9'

describe('transferMemo', () => {
  it('is stable and unique per outgoing transfer', () => {
    expect(transferMemo(A)).toBe(transferMemo(A))
    expect(transferMemo(A)).not.toBe(transferMemo(B))
  })

  it('remains recognizable and inside the chain limit', () => {
    const memo = transferMemo(A)
    expect(memo).toContain('NimDrop')
    expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)
  })
})
