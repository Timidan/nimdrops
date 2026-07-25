import { expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'

it('fake chain funds, builds deterministic txs, and finalizes after depth', async () => {
  const c = new FakeChain({ custody: 'NQ07 CUSTODY', finalityDepth: 5 })
  c.deposit({ hash: 'f1', sender: 'NQ07 ALICE', recipient: 'NQ07 CUSTODY', valueLuna: 100n, dataUtf8: 'ND1:abc', includedHeight: 10 })
  const tx = await c.getTransaction('f1')
  expect(tx!.valueLuna).toBe(100n)
  c.setHead(14); expect(c.isFinal(tx!, await c.headHeight())).toBe(false)
  c.setHead(15); expect(c.isFinal(tx!, await c.headHeight())).toBe(true)
  const built = await c.buildSignedBasic({ to: 'NQ07 BOB', valueLuna: 50n, validityStartHeight: 15 })
  expect(built.txHash).toMatch(/^fake-/)
  await c.broadcast(built.rawTxHex)                 // now visible on chain
  expect(await c.getTransaction(built.txHash)).not.toBeNull()
  expect(await c.confirmedBalanceLuna('NQ07 CUSTODY')).toBe(100n - 50n - built.feeLuna)
})
it('fake chain can simulate broadcast outage', async () => {
  const c = new FakeChain({ custody: 'NQ07 CUSTODY', finalityDepth: 5 })
  c.failNextBroadcast('timeout')
  const b = await c.buildSignedBasic({ to: 'NQ07 BOB', valueLuna: 1n, validityStartHeight: 1 })
  await expect(c.broadcast(b.rawTxHex)).rejects.toThrow('timeout')
  expect(await c.getTransaction(b.txHash)).toBeNull() // did not land
})
