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

// protocol constant, not part of the frozen interface
//
// Hard Nimiq limit on a basic transaction's data field (API-DIVERGENCE 14).
// It lives here because three unrelated modules need it — the funding memo
// builder, the payout memo check and the real signer — and three copies of a
// protocol constant is three chances to update two of them. Adding it below
// the interfaces keeps the frozen contract above untouched.
export const MEMO_MAX_BYTES = 64
