import { createHash } from 'node:crypto'
import type { ChainClient, ChainTx } from './types'

/**
 * Deterministic in-memory ChainClient used by tests and the local dev harness.
 *
 * NEVER wire this into `index.ts` / `worker.ts` — it is a displaced path and
 * must be unreachable from production entrypoints (PLAN.md kill criteria).
 *
 * Semantics that matter to the money engine:
 *  - `buildSignedBasic` signs but does NOT put the tx on chain; only
 *    `broadcast(rawTxHex)` makes it visible. This is the crash window the
 *    worker must survive.
 *  - `rawTxHex` carries the full signed payload, so bytes persisted before a
 *    crash can be rebroadcast verbatim after restart and land the SAME hash.
 *  - `broadcast` is idempotent by hash: rebroadcasting the same bytes can
 *    never produce a second on-chain payment.
 */

export type BroadcastFailureMode =
  /** throws, tx never lands — the true-timeout case */
  | 'timeout'
  /** throws AND lands the tx — the ambiguous-broadcast case */
  | 'timeout-but-lands'

export type FakeNetwork = 'TestAlbatross' | 'MainAlbatross'

export interface FakeChainOptions {
  custody: string
  finalityDepth: number
  network?: FakeNetwork
  headHeight?: number
  feeLuna?: bigint
}

export interface DepositInput {
  hash: string
  sender: string
  recipient: string
  valueLuna: bigint
  dataUtf8?: string | null
  includedHeight: number
  executionOk?: boolean
  feeLuna?: bigint
}

export interface FakeCall {
  op: 'build' | 'broadcast'
  txHash: string
  /** set when a broadcast call threw */
  failed?: BroadcastFailureMode
}

interface FakeTxRecord extends ChainTx {
  feeLuna: bigint
}

interface SignedPayload {
  from: string
  to: string
  valueLuna: string
  dataUtf8: string | null
  validityStartHeight: number
  feeLuna: string
  /** per-instance account nonce: two otherwise identical builds are distinct txs, as on a real chain */
  nonce: number
}

function canonical(p: SignedPayload): string {
  return JSON.stringify([
    p.from,
    p.to,
    p.valueLuna,
    p.dataUtf8,
    p.validityStartHeight,
    p.feeLuna,
    p.nonce,
  ])
}

function hashPayload(p: SignedPayload): string {
  return `fake-${createHash('sha256').update(canonical(p), 'utf8').digest('hex')}`
}

export class FakeChain implements ChainClient {
  private readonly custody: string
  private readonly finalityDepth: number
  private readonly net: FakeNetwork
  private readonly txs = new Map<string, FakeTxRecord>()
  private head: number
  private feeLuna: bigint
  private nonce = 0
  private nextBroadcastFailure: BroadcastFailureMode | null = null

  /** ordered log of build/broadcast calls — lets tests assert sign-before-broadcast ordering */
  readonly calls: FakeCall[] = []

  constructor(o: FakeChainOptions) {
    this.custody = o.custody
    this.finalityDepth = o.finalityDepth
    this.net = o.network ?? 'TestAlbatross'
    this.head = o.headHeight ?? 0
    this.feeLuna = o.feeLuna ?? 0n
  }

  // ---- ChainClient ---------------------------------------------------------

  network(): FakeNetwork {
    return this.net
  }

  custodyAddress(): string {
    return this.custody
  }

  async headHeight(): Promise<number> {
    return this.head
  }

  isFinal(tx: ChainTx, head: number): boolean {
    return head >= tx.includedHeight + this.finalityDepth
  }

  async getTransaction(hash: string): Promise<ChainTx | null> {
    const tx = this.txs.get(hash)
    return tx ? this.project(tx) : null
  }

  /**
   * Balance implied by every tx currently included on chain (finality is the
   * caller's concern via `isFinal`). Debits are recognised as soon as a tx
   * lands — the conservative direction for the solvency invariant.
   */
  async confirmedBalanceLuna(address: string): Promise<bigint> {
    let balance = 0n
    for (const tx of this.txs.values()) {
      if (tx.sender === address) {
        balance -= tx.feeLuna
        if (tx.executionOk) balance -= tx.valueLuna
      }
      if (tx.recipient === address && tx.executionOk) balance += tx.valueLuna
    }
    return balance
  }

  async buildSignedBasic(o: {
    to: string
    valueLuna: bigint
    dataUtf8?: string
    validityStartHeight: number
  }): Promise<{ rawTxHex: string; txHash: string; feeLuna: bigint }> {
    const payload: SignedPayload = {
      from: this.custody,
      to: o.to,
      valueLuna: o.valueLuna.toString(),
      dataUtf8: o.dataUtf8 ?? null,
      validityStartHeight: o.validityStartHeight,
      feeLuna: this.feeLuna.toString(),
      nonce: this.nonce++,
    }
    const txHash = hashPayload(payload)
    const rawTxHex = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex')
    this.calls.push({ op: 'build', txHash })
    return { rawTxHex, txHash, feeLuna: this.feeLuna }
  }

  async broadcast(rawTxHex: string): Promise<void> {
    const payload = this.decode(rawTxHex)
    const txHash = hashPayload(payload)
    const mode = this.nextBroadcastFailure
    this.nextBroadcastFailure = null

    if (mode === 'timeout') {
      this.calls.push({ op: 'broadcast', txHash, failed: mode })
      throw new Error('timeout')
    }

    this.land(payload, txHash)
    this.calls.push({ op: 'broadcast', txHash, ...(mode ? { failed: mode } : {}) })
    if (mode === 'timeout-but-lands') throw new Error('timeout')
  }

  // ---- test controls -------------------------------------------------------

  /** Put an externally-originated tx (e.g. sponsor funding) on chain. */
  deposit(d: DepositInput): ChainTx {
    const tx: FakeTxRecord = {
      hash: d.hash,
      sender: d.sender,
      recipient: d.recipient,
      valueLuna: d.valueLuna,
      dataUtf8: d.dataUtf8 ?? null,
      executionOk: d.executionOk ?? true,
      includedHeight: d.includedHeight,
      feeLuna: d.feeLuna ?? 0n,
    }
    this.txs.set(tx.hash, tx)
    return this.project(tx)
  }

  setHead(height: number): void {
    this.head = height
  }

  setFee(feeLuna: bigint): void {
    this.feeLuna = feeLuna
  }

  /** Arm a one-shot broadcast failure for the next `broadcast` call. */
  failNextBroadcast(mode: BroadcastFailureMode): void {
    this.nextBroadcastFailure = mode
  }

  /** Reorg simulation: a tx that was visible disappears before finality. */
  removeTx(hash: string): boolean {
    return this.txs.delete(hash)
  }

  /** Every tx currently on chain, in insertion order. */
  allTxs(): ChainTx[] {
    return [...this.txs.values()].map((tx) => this.project(tx))
  }

  /** How many times bytes for this hash were handed to `broadcast`. */
  broadcastCount(txHash: string): number {
    return this.calls.filter((c) => c.op === 'broadcast' && c.txHash === txHash).length
  }

  // ---- internals -----------------------------------------------------------

  private land(p: SignedPayload, txHash: string): void {
    // Idempotent by hash: rebroadcasting identical bytes cannot double-pay.
    if (this.txs.has(txHash)) return
    this.txs.set(txHash, {
      hash: txHash,
      sender: p.from,
      recipient: p.to,
      valueLuna: BigInt(p.valueLuna),
      dataUtf8: p.dataUtf8,
      executionOk: true,
      includedHeight: this.head,
      feeLuna: BigInt(p.feeLuna),
    })
  }

  private decode(rawTxHex: string): SignedPayload {
    return JSON.parse(Buffer.from(rawTxHex, 'hex').toString('utf8')) as SignedPayload
  }

  private project(tx: FakeTxRecord): ChainTx {
    return {
      hash: tx.hash,
      sender: tx.sender,
      recipient: tx.recipient,
      valueLuna: tx.valueLuna,
      dataUtf8: tx.dataUtf8,
      executionOk: tx.executionOk,
      includedHeight: tx.includedHeight,
    }
  }
}
