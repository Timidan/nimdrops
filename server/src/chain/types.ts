// Frozen contract. Every service reads the chain ONLY through this facade.
// `chain/nimiq.ts` (real, @nimiq/core) and `chain/fake.ts` (test double) are
// interchangeable implementations; if the real @nimiq/core API differs, fix
// nimiq.ts — this interface must not change.

export interface ChainTx {
  hash: string; sender: string; recipient: string
  valueLuna: bigint; dataUtf8: string | null
  executionOk: boolean; includedHeight: number
}

export interface ChainClient {
  network(): 'TestAlbatross' | 'MainAlbatross'
  custodyAddress(): string
  headHeight(): Promise<number>
  isFinal(tx: ChainTx, head: number): boolean
  getTransaction(hash: string): Promise<ChainTx | null>
  confirmedBalanceLuna(address: string): Promise<bigint>
  buildSignedBasic(o: { to: string; valueLuna: bigint; dataUtf8?: string; validityStartHeight: number }):
    Promise<{ rawTxHex: string; txHash: string; feeLuna: bigint }>
  broadcast(rawTxHex: string): Promise<void>
}
