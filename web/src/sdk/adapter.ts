/**
 * The ONLY file in `web/` allowed to import `@nimiq/mini-app-sdk`.
 *
 * Everything above this module talks to a `WalletBridge`, never to the raw
 * provider. Two rules make that boundary worth having:
 *
 *  - Design §5.1: a resolved provider value is NOT success until its shape is
 *    checked. Rejected promises AND resolved `ErrorResponse` objects both
 *    normalize into one typed `BridgeError`.
 *  - Design §5.2: this bridge only ever moves money FROM THE USER'S WALLET
 *    (drop funding). Custodial payouts are signed server-side. There is
 *    deliberately no generic `send()` that hides which key signs.
 */
import { init } from '@nimiq/mini-app-sdk'
import type { ErrorResponse, NimiqProvider, SignatureResult } from '@nimiq/mini-app-sdk'
import { MockBridge } from './mock'

export interface WalletBridge {
  ready(): Promise<void>
  sign(message: string): Promise<{ publicKey: string; signature: string }>
  sendWithData(o: { recipient: string; valueLuna: bigint; data: string }): Promise<{ txHash: string }>
}

export type BridgeResult =
  | { kind: 'real'; bridge: WalletBridge }
  | { kind: 'mock'; bridge: WalletBridge } // ONLY when import.meta.env.DEV && no provider
  | { kind: 'unavailable' } // production browser without a Nimiq Pay provider

export type BridgeKind = BridgeResult['kind']

/**
 * How long we wait for Nimiq Pay to inject `window.nimiq`. The SDK polls every
 * 50 ms and rejects at the timeout; its own default is 10 s, which would stall
 * a plain browser for ten seconds before showing the no-wallet screen. Inside
 * Nimiq Pay the provider is injected before the page script runs, so a short
 * budget only ever costs us on a genuinely broken host.
 */
export const PROVIDER_DETECT_TIMEOUT_MS = 1500

export type BridgeErrorType =
  | 'provider_unavailable'
  | 'provider_error'
  | 'malformed_response'
  | 'invalid_request'

/** One typed error for every failure mode of the wallet boundary. */
export class BridgeError extends Error {
  readonly type: BridgeErrorType
  readonly op: string
  constructor(type: BridgeErrorType, op: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BridgeError'
    this.type = type
    this.op = op
  }
}

/**
 * Raw, unnormalized provider responses, kept for the Task 7 on-device spike:
 * the exact `sign()` and `sendBasicTransactionWithData()` shapes have to be
 * transcribed from a real phone, not guessed. Debug-only; nothing reads it.
 */
export interface RawProviderCall {
  method: 'sign' | 'sendBasicTransactionWithData'
  request: unknown
  response: unknown
  at: string
}

declare global {
  interface Window {
    __nimiqRawLog?: RawProviderCall[]
  }
}

function recordRaw(method: RawProviderCall['method'], request: unknown, response: unknown): void {
  if (typeof window === 'undefined') return
  ;(window.__nimiqRawLog ??= []).push({
    method,
    request,
    response,
    at: new Date().toISOString(),
  })
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value
}

/** Turns a resolved-but-failed provider value into a thrown `BridgeError`. */
function unwrap<T>(value: T | ErrorResponse, op: string): T {
  if (isErrorResponse(value)) {
    const { type, message } = value.error ?? {}
    throw new BridgeError('provider_error', op, `${type ?? 'error'}: ${message ?? 'wallet rejected'}`)
  }
  return value
}

function rethrow(op: string, cause: unknown): never {
  if (cause instanceof BridgeError) throw cause
  const message = cause instanceof Error ? cause.message : String(cause)
  throw new BridgeError('provider_error', op, message, { cause })
}

const utf8 = new TextEncoder()

/** Global constraint: transaction memos are at most 64 UTF-8 bytes. */
export const MAX_MEMO_BYTES = 64

class RealBridge implements WalletBridge {
  #provider: NimiqProvider | undefined

  async ready(): Promise<void> {
    await this.#connect()
  }

  async #connect(): Promise<NimiqProvider> {
    if (this.#provider) return this.#provider
    try {
      // NOTE: deliberately NOT `provider.connect()` — that calls
      // `listAccounts()`, which costs the claimant an extra native prompt.
      // Design §4.3: derive the address from the verified `sign()` public key.
      this.#provider = await init({ timeout: PROVIDER_DETECT_TIMEOUT_MS })
      return this.#provider
    } catch (cause) {
      throw new BridgeError(
        'provider_unavailable',
        'ready',
        'Nimiq Pay provider was not injected into this page.',
        { cause },
      )
    }
  }

  async sign(message: string): Promise<{ publicKey: string; signature: string }> {
    if (typeof message !== 'string' || message.length === 0) {
      throw new BridgeError('invalid_request', 'sign', 'message must be a non-empty string')
    }
    const provider = await this.#connect()
    let raw: SignatureResult | ErrorResponse
    try {
      raw = await provider.sign(message)
    } catch (cause) {
      rethrow('sign', cause)
    }
    recordRaw('sign', { message }, raw)
    const result = unwrap<SignatureResult>(raw, 'sign')
    if (typeof result?.publicKey !== 'string' || typeof result?.signature !== 'string') {
      throw new BridgeError('malformed_response', 'sign', 'provider returned no publicKey/signature pair')
    }
    return { publicKey: result.publicKey, signature: result.signature }
  }

  async sendWithData(o: {
    recipient: string
    valueLuna: bigint
    data: string
  }): Promise<{ txHash: string }> {
    if (!o.recipient) {
      throw new BridgeError('invalid_request', 'sendWithData', 'recipient is required')
    }
    if (o.valueLuna <= 0n) {
      throw new BridgeError('invalid_request', 'sendWithData', 'valueLuna must be positive')
    }
    // Luna is bigint everywhere in this codebase; the SDK takes a number. This
    // is the one and only place the conversion is allowed, and it is guarded.
    if (o.valueLuna > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BridgeError(
        'invalid_request',
        'sendWithData',
        `valueLuna ${o.valueLuna} exceeds Number.MAX_SAFE_INTEGER`,
      )
    }
    const memoBytes = utf8.encode(o.data).length
    if (memoBytes > MAX_MEMO_BYTES) {
      throw new BridgeError(
        'invalid_request',
        'sendWithData',
        `data is ${memoBytes} UTF-8 bytes, max ${MAX_MEMO_BYTES}`,
      )
    }

    const provider = await this.#connect()
    const request = { recipient: o.recipient, value: Number(o.valueLuna), data: o.data }
    let raw: string | ErrorResponse
    try {
      raw = await provider.sendBasicTransactionWithData(request)
    } catch (cause) {
      rethrow('sendWithData', cause)
    }
    recordRaw('sendBasicTransactionWithData', request, raw)
    const result = unwrap<string>(raw, 'sendWithData')
    // The SDK types this as "the serialized transaction". Whether that string
    // is the hash or the raw tx (from which the hash must be derived) is
    // exactly what the Task 7 on-device run has to settle; until then we pass
    // the provider string through unchanged and log the raw value above.
    if (typeof result !== 'string' || result.length === 0) {
      throw new BridgeError('malformed_response', 'sendWithData', 'provider returned no transaction string')
    }
    return { txHash: result }
  }
}

/**
 * Synchronous provider presence check. Nimiq Pay seeds `window.nimiqPay`
 * before the mini app's page script runs and injects `window.nimiq` for the
 * provider, so either one being present means we are inside a real wallet host
 * and the mock must never be selected.
 */
export function hasNimiqProvider(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(window.nimiq) || Boolean(window.nimiqPay)
}

/**
 * Selection rule (kill-criterion — see PLAN.md "Mock/fake reachable from
 * production entrypoints → blocker"):
 *   real provider present            → 'real'
 *   DEV build AND no provider        → 'mock'
 *   otherwise                        → 'unavailable'
 */
export function getBridge(): BridgeResult {
  if (hasNimiqProvider()) return { kind: 'real', bridge: new RealBridge() }
  if (import.meta.env.DEV) return { kind: 'mock', bridge: new MockBridge() }
  return { kind: 'unavailable' }
}

/**
 * Async variant of the same rule, for callers that can afford to wait out the
 * injection race instead of trusting the synchronous snapshot. Identical
 * selection rule; only the "is a provider present" question is answered with
 * the SDK's polling `init()` rather than a single property read.
 */
export async function resolveBridge(
  timeoutMs: number = PROVIDER_DETECT_TIMEOUT_MS,
): Promise<BridgeResult> {
  if (typeof window !== 'undefined') {
    try {
      await init({ timeout: timeoutMs })
      return { kind: 'real', bridge: new RealBridge() }
    } catch {
      // No provider injected within the budget — fall through to the same
      // DEV/mock vs production/unavailable decision as getBridge().
    }
  }
  if (import.meta.env.DEV) return { kind: 'mock', bridge: new MockBridge() }
  return { kind: 'unavailable' }
}

/**
 * Deep link that reopens the current HTTPS page inside Nimiq Pay (design §4.1).
 * The campaign ID survives because the whole URL, query string included, is
 * encoded into the link.
 */
export function nimiqPayDeeplink(httpsUrl: string): string {
  return `nimiqpay://miniapp?url=${encodeURIComponent(httpsUrl)}`
}
