/**
 * Real `ChainClient` backed by `@nimiq/core` 2.7.1 (the Rust-to-WASM web client)
 * running in Node.
 *
 * `chain/types.ts` is FROZEN. Everything below adapts the real 2.7.1 API to it.
 * Every place where the real API differed from the plan's hints is marked
 * `API-DIVERGENCE` so `server/spike/g0-evidence.md` and Task 7 can transcribe it.
 *
 * API-DIVERGENCE index (verified against node_modules/@nimiq/core@2.7.1 typings
 * and by running the probes in Task 6):
 *
 *  1. `ClientConfiguration` setters are void mutators, not a fluent builder.
 *     You call `cfg.network('TestAlbatross')` then `Client.create(cfg.build())`.
 *     `Client.create` takes the *plain* config object, not the configuration
 *     instance. There is also an `instantiateClient()` mentioned in the doc
 *     comment that does not exist on the 2.7.1 type surface.
 *  2. `TransactionBuilder.newBasic` / `newBasicWithData` need an explicit
 *     numeric `network_id`. No `NetworkId` enum is exported. Measured mapping
 *     (by building a tx per id and reading `tx.toPlain().network`):
 *     TestAlbatross = 5, MainAlbatross = 24 (also: test 1, dev 2, bounty 3,
 *     dummy 4, devalbatross 6, unitalbatross 7, main 42).
 *  3. `newBasicWithData(sender, recipient, data, value, fee, vsh, networkId)` —
 *     `data` is the THIRD argument (before value), and it is a `Uint8Array`,
 *     not a string.
 *  4. `tx.sign(keyPair, innerKeyPair)` takes two positional args; the second is
 *     `KeyPair | undefined` and must be passed explicitly under TS strict.
 *     `sign()` mutates the transaction in place and returns `void`.
 *  5. Serialization is `tx.toHex()` (there is also `tx.serialize(): Uint8Array`).
 *     `tx.hash()` returns the hex tx id as a `string`.
 *  6. `client.getTransaction(hash)` REJECTS when the transaction is unknown; it
 *     does not resolve to null/undefined. Mapped to `null` here — see
 *     `isNotFoundError`.
 *  7. `PlainTransactionDetails.value` / `.fee` are JS `number`, not `bigint`
 *     (safe: max NIM supply in luna is ~2.1e15 < 2^53). We convert at the
 *     boundary so no `number` money ever escapes this file.
 *  8. Transaction data comes back as a tagged union
 *     `data: { type: 'raw', raw: <hex string> } | {type:'vesting'|...}`.
 *     `raw` is HEX, not UTF-8 — it must be hex-decoded then UTF-8 decoded.
 *  9. Inclusion height is `blockHeight?: number` and only present once
 *     `state` is `'included' | 'confirmed'`. `'new' | 'pending'` (mempool) and
 *     `'invalidated' | 'expired'` carry no height, so they map to `null`.
 * 10. `executionResult?: boolean` is optional. Absent on plain value transfers.
 * 11. Addresses in plain objects are user-friendly IBAN WITH spaces
 *     ("NQ21 SEXP ..."). `Address.fromAny` accepts spaced, unspaced and hex.
 *     We normalise every address we emit to the spaced user-friendly form.
 * 12. `client.sendTransaction()` accepts the raw hex string directly and
 *     resolves to `PlainTransactionDetails`; the frozen interface returns void.
 * 13. Fee `0n` is accepted by `tx.verify()` and by `newBasic(..., 0n, ...)`;
 *     passing `undefined` for fee also yields `fee === 0n`.
 * 14. The 64-byte data limit is hard: 64 bytes builds, 65 throws `Error: Overflow`.
 * 15. **The big one.** `ClientConfiguration`'s built-in seed list is a hardcoded
 *     MAINNET list and does NOT change when you call `network('TestAlbatross')`.
 *     `cfg.build()` on a TestAlbatross config still emits the 14 mainnet seeds
 *     (aurora/catalyst/cipher/... .seed.nimiq.*), so the client dials mainnet
 *     seeds with a testnet genesis, the handshake is rejected, and every
 *     connection closes ~0.3 s after it is established. Symptom: an endless
 *     `consensus state: connecting` loop with `peers = 0` and no error.
 *     Fix: pass testnet seeds explicitly via `cfg.seedNodes([...])`.
 *     With that, consensus on TestAlbatross established in ~4.3 s.
 *     The plan's hint said `ClientConfiguration → network(...) → Client.create`,
 *     which is NOT sufficient for testnet.
 */

import {
  Address,
  Client,
  ClientConfiguration,
  KeyPair,
  Policy,
  PrivateKey,
  Transaction,
  TransactionBuilder,
  type PlainTransactionDetails,
} from '@nimiq/core'
import { FINALITY_DEPTH_FLOOR_BLOCKS, finalityDepthBlocks, requireNetwork } from '../config'
import { MEMO_MAX_BYTES, type ChainClient, type ChainTx } from './types'

export type NimiqNetwork = 'TestAlbatross' | 'MainAlbatross'

/** API-DIVERGENCE 2: measured `network_id` values, no enum is exported. */
export const NETWORK_ID: Record<NimiqNetwork, number> = {
  TestAlbatross: 5,
  MainAlbatross: 24,
}

/**
 * API-DIVERGENCE 15: seed nodes per network.
 *
 * The WASM `ClientConfiguration` hardcodes the mainnet seed list and keeps it
 * even after `network('TestAlbatross')`. Passing the wrong seeds does not
 * error — it silently never reaches consensus. So we always set them ourselves.
 */
export const DEFAULT_SEED_NODES: Record<NimiqNetwork, string[]> = {
  TestAlbatross: [
    '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
    '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
    '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
    '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
  ],
  // Same list the WASM ships as its built-in default, pinned here so the
  // network→seeds relationship is explicit and reviewable in one place.
  MainAlbatross: [
    '/dns4/aurora.seed.nimiq.com/tcp/443/wss',
    '/dns4/catalyst.seed.nimiq.network/tcp/443/wss',
    '/dns4/cipher.seed.nimiq-network.com/tcp/443/wss',
    '/dns4/eclipse.seed.nimiq.cloud/tcp/443/wss',
    '/dns4/lumina.seed.nimiq.systems/tcp/443/wss',
    '/dns4/nebula.seed.nimiq.com/tcp/443/wss',
    '/dns4/nexus.seed.nimiq.network/tcp/443/wss',
    '/dns4/polaris.seed.nimiq-network.com/tcp/443/wss',
    '/dns4/photon.seed.nimiq.cloud/tcp/443/wss',
    '/dns4/pulsar.seed.nimiq.systems/tcp/443/wss',
    '/dns4/quasar.seed.nimiq.com/tcp/443/wss',
    '/dns4/solstice.seed.nimiq.network/tcp/443/wss',
    '/dns4/vortex.seed.nimiq.cloud/tcp/443/wss',
    '/dns4/zenith.seed.nimiq.systems/tcp/443/wss',
  ],
}

/**
 * Blocks after inclusion before we call a transaction final.
 *
 * Albatross finalises a batch with a macro block; `Policy.BLOCKS_PER_BATCH` is
 * 60 and `Policy.BLOCK_SEPARATION_TIME` is 1000 ms, so a macro block lands
 * roughly every 60 s. A depth of 64 > 60 therefore guarantees that at least one
 * macro block was produced after inclusion NO MATTER where in the batch the
 * transaction landed — that is the reason for the default, not a round number.
 *
 * Re-exported from `config.ts`, where it is also the HARD FLOOR: since the G1
 * review finding 5, `NIMIQ_FINALITY_DEPTH` may raise this number and never lower it.
 */
export const DEFAULT_FINALITY_DEPTH = FINALITY_DEPTH_FLOOR_BLOCKS

/**
 * Raised by every signing method on a read-only client.
 *
 * A distinct class, not a bare `Error`: "this process was never given a key" is
 * an architectural fact an operator should be able to recognise instantly in a
 * log, and it must never be mistaken for a transient chain failure that some
 * retry loop should have another go at.
 */
export class ReadOnlyChainError extends Error {
  constructor(what = 'sign') {
    super(
      `refusing to ${what}: this NimiqChain was constructed read-only from CUSTODY_ADDRESS. ` +
        'Only the worker process holds the custody key.',
    )
    this.name = 'ReadOnlyChainError'
  }
}

export interface NimiqChainOptions {
  network: NimiqNetwork
  /**
   * Signing mode. Mutually exclusive with {@link NimiqChainOptions.custodyAddress}.
   */
  custodyPrivateKeyHex?: string
  /**
   * READ-ONLY mode: the custody address, with no key anywhere in the process.
   *
   * The API process needs `custodyAddress()` for funding instructions, plus
   * head height and transaction reads; it signs nothing — `worker.ts` holds
   * advisory lock 42 and is the only writer to the chain. It was nonetheless
   * being handed `CUSTODY_PRIVATE_KEY_HEX` purely so this constructor could
   * DERIVE the address from it, which put the hot key in the memory of the one
   * process that faces the internet, for no capability it uses.
   *
   * §10.3 asks for the signing code to stay narrow and the runtime access
   * restricted. This is the mechanical version of that: give the HTTP process
   * the address it needs and nothing that can move money. Mutually exclusive
   * with {@link NimiqChainOptions.custodyPrivateKeyHex} — supplying both is a
   * configuration error, not a preference, and throws.
   */
  custodyAddress?: string
  /**
   * @internal TEST-ONLY seam (finding 5). Bypasses `config.finalityDepthBlocks()`
   * and therefore its 64-block floor, so a test can call a transaction final
   * after a handful of blocks. No production entrypoint sets it: `index.ts`,
   * `worker.ts` and `recover.ts` all build their client through
   * `nimiqChainFromEnv`, which does not forward it.
   */
  finalityDepthOverride?: number
  /** Defaults to `NIMIQ_FEE_LUNA` env, else 0n (0-fee txs are accepted). */
  feeLuna?: bigint
  /** 'pico' (default) or 'light'. Only these two are supported by the web client. */
  syncMode?: 'pico' | 'light'
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  /**
   * Multiaddr strings. Defaults to `DEFAULT_SEED_NODES[network]`, or the
   * comma-separated `NIMIQ_SEED_NODES` env var when set. Never falls through to
   * the WASM built-in list — see API-DIVERGENCE 15.
   */
  seedNodes?: string[]
}

function envBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return BigInt(raw)
}

/**
 * API-DIVERGENCE 6: `getTransaction` rejects instead of resolving null.
 *
 * Deliberately a WHITELIST of "the chain says this hash is not there" phrases.
 * Anything else (no peers, request timeout, worker gone) is re-thrown, because
 * "we could not ask" must never be reported to the money engine as "absent" —
 * that is the input to the `proven_dead` decision.
 */
const NOT_FOUND_PATTERNS = [
  'not found',
  'no transaction',
  'unknown transaction',
  'does not exist',
  'transaction not yet',
]

function isNotFoundError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return NOT_FOUND_PATTERNS.some((p) => msg.includes(p))
}

/** API-DIVERGENCE 8: `data.raw` is hex; decode to UTF-8 or null when empty. */
function decodeDataUtf8(details: PlainTransactionDetails): string | null {
  const data = details.data
  if (!data || data.type !== 'raw') return null
  const raw = (data as { raw?: string }).raw
  if (!raw) return null
  const bytes = Buffer.from(raw, 'hex')
  if (bytes.length === 0) return null
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** API-DIVERGENCE 11: normalise to spaced user-friendly IBAN. */
function toUserFriendly(addr: string): string {
  return Address.fromAny(addr).toUserFriendlyAddress()
}

function fundingOwner(details: PlainTransactionDetails): string | null {
  if (details.senderType === 'basic') return toUserFriendly(details.sender)

  const proof = details.proof
  if (proof.type === 'standard' && (details.senderType === 'vesting' || details.senderType === 'staking')) {
    return toUserFriendly(proof.signer)
  }
  if (details.senderType !== 'htlc') return null
  if (proof.type === 'regular-transfer') return toUserFriendly(proof.signer)
  if (proof.type === 'early-resolve' || proof.type === 'timeout-resolve') {
    return toUserFriendly(proof.creator)
  }
  return null
}

export class NimiqChain implements ChainClient {
  private readonly net: NimiqNetwork
  private readonly networkId: number
  /** `null` in read-only mode. Every signing path checks this and only this. */
  private readonly keyPair: KeyPair | null
  private readonly custody: string
  private readonly finalityDepth: number
  private readonly fee: bigint
  private readonly syncMode: 'pico' | 'light'
  private readonly logLevel: string
  private readonly seeds: string[]

  private client: Client | null = null
  private connecting: Promise<Client> | null = null

  constructor(o: NimiqChainOptions) {
    this.net = o.network
    this.networkId = NETWORK_ID[o.network]
    if (this.networkId === undefined) throw new Error(`unknown network ${o.network}`)

    // Exactly one of the two. Neither is a configuration nobody can act on;
    // both is worse — it would let a deployment believe it had disarmed the
    // HTTP process while the key sat right there in the same options object.
    const hasKey = o.custodyPrivateKeyHex !== undefined && o.custodyPrivateKeyHex !== ''
    const hasAddress = o.custodyAddress !== undefined && o.custodyAddress !== ''
    if (hasKey === hasAddress) {
      throw new Error(
        'NimiqChain needs exactly one of custodyPrivateKeyHex (signing) or custodyAddress (read-only)',
      )
    }

    if (hasKey) {
      const hex = (o.custodyPrivateKeyHex as string).trim().replace(/^0x/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('custodyPrivateKeyHex must be 32 bytes of hex (64 chars)')
      }
      // The WASM module is loaded synchronously at import time, so key derivation
      // works before (and without) any network connection.
      this.keyPair = KeyPair.derive(PrivateKey.fromHex(hex))
      this.custody = this.keyPair.toAddress().toUserFriendlyAddress()
    } else {
      this.keyPair = null
      // Parsed, not trusted: a typo'd `CUSTODY_ADDRESS` would otherwise become
      // funding instructions pointing at nothing, and every deposit made
      // against them is money nobody controls. `Address.fromAny` throws on
      // anything that is not a real address, at BOOT, which is where a wrong
      // custody address has to be caught. Normalised to the same spaced
      // user-friendly form the signing path produces, so the two modes are
      // indistinguishable to `custodyAddress()` callers.
      this.custody = Address.fromAny((o.custodyAddress as string).trim()).toUserFriendlyAddress()
    }

    // Floored config, or the documented test-only override. There is no third
    // path: a deployment cannot configure a depth below the protocol floor.
    this.finalityDepth = o.finalityDepthOverride ?? finalityDepthBlocks()
    this.fee = o.feeLuna ?? envBigint('NIMIQ_FEE_LUNA', 0n)
    this.syncMode = o.syncMode ?? 'pico'
    this.logLevel = o.logLevel ?? 'warn'

    const envSeeds = (process.env.NIMIQ_SEED_NODES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    this.seeds =
      o.seedNodes && o.seedNodes.length > 0
        ? o.seedNodes
        : envSeeds.length > 0
          ? envSeeds
          : DEFAULT_SEED_NODES[o.network]
  }

  // ---- lifecycle (not part of the frozen interface) ------------------------

  /**
   * Spawns the consensus worker and blocks until consensus is established.
   * Idempotent and safe to call concurrently. Every async `ChainClient` method
   * funnels through here, so callers that forget still get a connected client.
   */
  async connect(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting

    this.connecting = (async () => {
      const cfg = new ClientConfiguration()
      // API-DIVERGENCE 1: void mutators, then `.build()` into `Client.create`.
      cfg.network(this.net)
      cfg.syncMode(this.syncMode)
      cfg.logLevel(this.logLevel)
      // ALWAYS set seeds — see API-DIVERGENCE 15. Omitting this on
      // TestAlbatross hangs forever in `connecting` with zero peers.
      cfg.seedNodes(this.seeds)
      const client = await Client.create(cfg.build())
      await client.waitForConsensusEstablished()
      this.client = client
      return client
    })()

    try {
      return await this.connecting
    } catch (err) {
      this.connecting = null
      throw err
    }
  }

  /** Tears the consensus worker down so a spike/CLI process can exit cleanly. */
  async close(): Promise<void> {
    const client = this.client
    this.client = null
    this.connecting = null
    if (client) {
      try {
        await client.disconnectNetwork()
      } catch {
        // best effort — the process is going away anyway
      }
    }
  }

  /**
   * True when this client holds no key and can only read.
   *
   * Exposed so a process can ASSERT its own posture (`index.ts` logs it at
   * boot) rather than infer it from configuration it cannot see.
   */
  isReadOnly(): boolean {
    return this.keyPair === null
  }

  /** Exposed for evidence/diagnostics; not part of the frozen interface. */
  finalityDepthBlocks(): number {
    return this.finalityDepth
  }

  /** Exposed for evidence/diagnostics; not part of the frozen interface. */
  feeLuna(): bigint {
    return this.fee
  }

  /**
   * The network a stored signed transaction was built for (G1 review finding 6).
   *
   * `recover.ts replace` calls this on the bytes it is about to declare dead:
   * bytes carrying another chain's network id could never have been included
   * here, so their absence on this chain proves nothing at all.
   *
   * Deserialization, not byte-offset parsing — `Transaction.fromAny` already
   * knows the wire format and exposes `networkId`, so the network id's position
   * in the serialization is not something this file has to keep true. Returns
   * `null` when the bytes do not parse or carry an id we do not map; callers
   * must treat that as "unknown", never as a match.
   */
  rawTxNetwork(rawTxHex: string): NimiqNetwork | null {
    let networkId: number
    try {
      networkId = Transaction.fromAny(rawTxHex).networkId
    } catch {
      return null
    }
    const match = Object.entries(NETWORK_ID).find(([, id]) => id === networkId)
    return match ? (match[0] as NimiqNetwork) : null
  }

  // ---- ChainClient ---------------------------------------------------------

  network(): NimiqNetwork {
    return this.net
  }

  custodyAddress(): string {
    return this.custody
  }

  async headHeight(): Promise<number> {
    const client = await this.connect()
    return client.getHeadHeight()
  }

  /**
   * Depth rule, deliberately conservative: 64 blocks always spans a macro
   * block (batch = 60 blocks), so an included transaction at `head - 64` sits
   * behind at least one finalised batch. Override with `NIMIQ_FINALITY_DEPTH`.
   */
  isFinal(tx: ChainTx, head: number): boolean {
    return head >= tx.includedHeight + this.finalityDepth
  }

  /**
   * `null` means "not usable as an included transaction": unknown hash,
   * still in the mempool (`new`/`pending`), or `invalidated`/`expired`.
   * API-DIVERGENCE 6 + 9.
   */
  async getTransaction(hash: string): Promise<ChainTx | null> {
    const client = await this.connect()
    let details: PlainTransactionDetails
    try {
      details = await client.getTransaction(hash)
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }
    return this.toChainTx(details)
  }

  /**
   * Every included transaction touching `address` at or after `sinceHeight`.
   *
   * NOT part of the frozen `ChainClient` contract, and deliberately not: no
   * money path reads it. It exists for the S3 harness's custody audit (round-4
   * S6), which used to compare only the NET movement of the custody wallet —
   * so an extra outgoing payment plus an equal unsolicited credit cancelled out
   * and "no unaccounted payment" passed while both existed. A net figure cannot
   * answer "was every payment from this wallet one we authorised"; only an
   * enumeration can.
   *
   * `limit` is passed through and MUST be checked by the caller: the client
   * returns "up to `limit`, newest first", so a full page is indistinguishable
   * from a truncated history, and a truncated history is exactly how an
   * unauthorised payment would slip past an enumeration. The caller compares
   * the returned count against the limit it asked for and fails if they match.
   *
   * `sinceHeight` should be comfortably BEFORE the window of interest — the
   * client documents it as a height that could not have been forked from — and
   * the caller narrows to the exact window itself.
   */
  async transactionsByAddress(
    address: string,
    sinceHeight?: number,
    limit?: number,
  ): Promise<ChainTx[]> {
    const client = await this.connect()
    const details = await client.getTransactionsByAddress(
      Address.fromAny(address),
      sinceHeight ?? null,
      null,
      null,
      limit ?? null,
    )
    return details
      .map((d) => this.toChainTx(d))
      .filter((tx): tx is ChainTx => tx !== null)
  }

  /** Public so the spike can log the raw state of a not-yet-included tx. */
  async getTransactionDetails(hash: string): Promise<PlainTransactionDetails | null> {
    const client = await this.connect()
    try {
      return await client.getTransaction(hash)
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  toChainTx(details: PlainTransactionDetails): ChainTx | null {
    if (details.state !== 'included' && details.state !== 'confirmed') return null
    if (typeof details.blockHeight !== 'number') return null
    return {
      hash: details.transactionHash,
      sender: toUserFriendly(details.sender),
      fundingOwner: fundingOwner(details),
      recipient: toUserFriendly(details.recipient),
      // API-DIVERGENCE 7: `value` is a JS number.
      valueLuna: BigInt(details.value),
      dataUtf8: decodeDataUtf8(details),
      // API-DIVERGENCE 10: absent on plain value transfers ⇒ treat as success,
      // an included basic transfer that did not execute is not representable.
      executionOk: details.executionResult ?? true,
      includedHeight: details.blockHeight,
    }
  }

  async confirmedBalanceLuna(address: string): Promise<bigint> {
    const client = await this.connect()
    const account = await client.getAccount(Address.fromAny(address))
    // Every PlainAccount variant (basic/vesting/htlc/staking) carries `balance`.
    return BigInt(account.balance)
  }

  async buildSignedBasic(o: {
    to: string
    valueLuna: bigint
    dataUtf8?: string
    validityStartHeight: number
  }): Promise<{ rawTxHex: string; txHash: string; feeLuna: bigint }> {
    // FIRST, before any argument validation: a read-only client must fail the
    // same way for every call, so no caller can learn anything by probing it.
    const keyPair = this.keyPair
    if (keyPair === null) throw new ReadOnlyChainError('build a signed transaction')

    if (o.valueLuna <= 0n) throw new Error('valueLuna must be positive')
    if (!Number.isInteger(o.validityStartHeight) || o.validityStartHeight < 0) {
      throw new Error('validityStartHeight must be a non-negative integer')
    }

    const sender = keyPair.toAddress()
    const recipient = Address.fromAny(o.to)

    let tx
    if (o.dataUtf8 !== undefined && o.dataUtf8 !== '') {
      const data = new TextEncoder().encode(o.dataUtf8)
      if (data.length > MEMO_MAX_BYTES) {
        throw new Error(`tx data is ${data.length} bytes, limit is ${MEMO_MAX_BYTES}`)
      }
      // API-DIVERGENCE 3: data is the third positional argument.
      tx = TransactionBuilder.newBasicWithData(
        sender,
        recipient,
        data,
        o.valueLuna,
        this.fee,
        o.validityStartHeight,
        this.networkId,
      )
    } else {
      tx = TransactionBuilder.newBasic(
        sender,
        recipient,
        o.valueLuna,
        this.fee,
        o.validityStartHeight,
        this.networkId,
      )
    }

    // API-DIVERGENCE 4: in-place mutation, second positional arg required.
    tx.sign(keyPair, undefined)
    // Throws with the exact validity error if we built something unusable —
    // better here than after we have already persisted bytes.
    tx.verify(this.networkId)

    // API-DIVERGENCE 5: hex + hash computed locally, BEFORE any broadcast.
    return { rawTxHex: tx.toHex(), txHash: tx.hash(), feeLuna: tx.fee }
  }

  /**
   * Broadcasts exactly the bytes it was given. Rebroadcasting identical bytes
   * is idempotent on the network (same hash ⇒ same transaction), which is what
   * makes the kill/restart path in `spike/s2-kill-recovery.ts` safe.
   */
  async broadcast(rawTxHex: string): Promise<void> {
    // Guarded as well as `buildSignedBasic`, and on purpose. Broadcasting is
    // not signing, but "hand the read-only process some bytes somebody else
    // signed" is precisely the path a key-less API would still be able to move
    // money down. A client with no key does not write to the chain at all.
    if (this.keyPair === null) throw new ReadOnlyChainError('broadcast')
    const client = await this.connect()
    // API-DIVERGENCE 12: resolves to PlainTransactionDetails; we discard it so
    // callers cannot start treating "acknowledged" as "included".
    await client.sendTransaction(rawTxHex)
  }
}

/**
 * Convenience for entrypoints and spikes. Reads the documented env contract.
 *
 * `finalityDepthOverride` is stripped rather than forwarded: this function is
 * what every production entrypoint calls, so the test-only seam must not be
 * reachable through it even if a caller supplies one (finding 5).
 */
export function nimiqChainFromEnv(overrides: Partial<NimiqChainOptions> = {}): NimiqChain {
  // No default: a silent `TestAlbatross` fallback here would let a mainnet
  // deployment sign with the wrong network id and never say so.
  const network = overrides.network ?? requireNetwork()
  const custodyPrivateKeyHex = overrides.custodyPrivateKeyHex ?? process.env.CUSTODY_PRIVATE_KEY_HEX
  if (!custodyPrivateKeyHex) throw new Error('CUSTODY_PRIVATE_KEY_HEX is not set')
  const { finalityDepthOverride: _ignored, custodyAddress: _never, ...rest } = overrides
  return new NimiqChain({ ...rest, network, custodyPrivateKeyHex })
}

/**
 * The same client, built from `CUSTODY_ADDRESS` and no key. For `index.ts`.
 *
 * A separate function rather than a flag on `nimiqChainFromEnv`, so that
 * "which entrypoints can sign" is answerable by grepping for one name. The
 * signing factory reads `CUSTODY_PRIVATE_KEY_HEX`; this one cannot, and drops
 * any `custodyPrivateKeyHex` an override tries to smuggle in — the same
 * treatment `finalityDepthOverride` gets, and for the same reason.
 */
export function readOnlyNimiqChainFromEnv(
  overrides: Partial<NimiqChainOptions> = {},
): NimiqChain {
  const network = overrides.network ?? requireNetwork()
  const custodyAddress = overrides.custodyAddress ?? process.env.CUSTODY_ADDRESS
  if (!custodyAddress) throw new Error('CUSTODY_ADDRESS is not set')
  const {
    finalityDepthOverride: _ignored,
    custodyPrivateKeyHex: _never,
    ...rest
  } = overrides
  return new NimiqChain({ ...rest, network, custodyAddress })
}

/** Re-exported for evidence: batch geometry behind DEFAULT_FINALITY_DEPTH. */
export const POLICY_SNAPSHOT = {
  blocksPerBatch: Policy.BLOCKS_PER_BATCH,
  batchesPerEpoch: Policy.BATCHES_PER_EPOCH,
  blocksPerEpoch: Policy.BLOCKS_PER_EPOCH,
  blockSeparationTimeMs: Policy.BLOCK_SEPARATION_TIME,
  txValidityWindowBlocks: Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS,
}
