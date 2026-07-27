import { KeyPair } from '@nimiq/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NimiqChain } from '../src/chain/nimiq'
import { MEMO_MAX_BYTES } from '../src/chain/types'
import { transferMemoTag } from '../src/ids'
import { transferMemo } from '../src/services/transfers'

const A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const B = '1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9'

const SECRET = 'transfers-memo-test-secret'
const CUSTODY_KEY = '11'.repeat(32)

let saved: string | undefined

beforeAll(() => {
  saved = process.env.STATUS_TOKEN_SECRET
  process.env.STATUS_TOKEN_SECRET = SECRET
})

afterAll(() => {
  if (saved === undefined) delete process.env.STATUS_TOKEN_SECRET
  else process.env.STATUS_TOKEN_SECRET = saved
})

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

  it('does not publish the transfer id, so a webhook payload is not a join key', () => {
    expect(transferMemo(A)).not.toContain(A)
    expect(transferMemo(A)).not.toContain(A.replace(/-/g, ''))
  })

  it('cannot be recomputed from the transfer id alone', () => {
    const withOurSecret = transferMemoTag(A)
    process.env.STATUS_TOKEN_SECRET = 'someone-elses-secret'
    try {
      expect(transferMemoTag(A)).not.toBe(withOurSecret)
    } finally {
      process.env.STATUS_TOKEN_SECRET = SECRET
    }
  })
})

/**
 * `FakeChain` cannot answer this question: it mixes a per-build counter into its
 * payload (`fake.ts`), so two identical builds differ there whatever the memo
 * says. A real Nimiq basic transaction has no account nonce, so its hash is a
 * function of the fields alone — which is why the memo has to carry the
 * uniqueness, and why this asserts against `NimiqChain`. Signing is local: no
 * socket, no consensus.
 */
describe('transaction uniqueness, against the real transaction builder', () => {
  const chain = new NimiqChain({
    network: 'TestAlbatross',
    custodyPrivateKeyHex: CUSTODY_KEY,
    finalityDepthOverride: 5,
  })
  const recipient = KeyPair.generate().toAddress().toUserFriendlyAddress()
  const identical = { to: recipient, valueLuna: 100_000n, validityStartHeight: 4_242 }

  it('collides when two otherwise-identical payouts share a memo', async () => {
    const first = await chain.buildSignedBasic({ ...identical, dataUtf8: 'NimDrop same' })
    const second = await chain.buildSignedBasic({ ...identical, dataUtf8: 'NimDrop same' })

    expect(second.txHash).toBe(first.txHash)
  })

  it('does not collide when the memo is per-transfer', async () => {
    const first = await chain.buildSignedBasic({ ...identical, dataUtf8: transferMemo(A) })
    const second = await chain.buildSignedBasic({ ...identical, dataUtf8: transferMemo(B) })

    expect(second.txHash).not.toBe(first.txHash)
  })

  it('rebuilds the same bytes for the same transfer, so a rebroadcast stays idempotent', async () => {
    const first = await chain.buildSignedBasic({ ...identical, dataUtf8: transferMemo(A) })
    const again = await chain.buildSignedBasic({ ...identical, dataUtf8: transferMemo(A) })

    expect(again.rawTxHex).toBe(first.rawTxHex)
    expect(again.txHash).toBe(first.txHash)
  })
})
