/**
 * Development-only wallet stand-in so the flows can be driven in a desktop
 * browser with no Nimiq Pay provider.
 *
 * This module is reachable ONLY through the `import.meta.env.DEV` branch of
 * `getBridge()`/`resolveBridge()` in `adapter.ts`. Vite replaces that flag with
 * a literal `false` in production builds and the branch (plus this module) is
 * eliminated. Do not import it from anywhere else — a mock reachable from a
 * production entrypoint is a documented kill criterion.
 */
import type { WalletBridge } from './adapter'

export interface MockBridgeCall {
  method: 'ready' | 'sign' | 'sendWithData'
  args: unknown
  result: unknown
  at: string
}

declare global {
  interface Window {
    /** Every mock call, in order — read this from the console or the spike page. */
    __mockBridgeLog?: MockBridgeCall[]
  }
}

/** Artificial latency so the UI's pending states are actually exercised. */
export const MOCK_LATENCY_MS = 300

/** Fixed, obviously-fake Ed25519-shaped key material: 32 bytes = 64 hex chars. */
export const MOCK_PUBLIC_KEY = `facade00${'de'.repeat(28)}`
/** Fixed signature-shaped hex: 64 bytes = 128 hex chars. */
export const MOCK_SIGNATURE = `facade00${'ad'.repeat(60)}`

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** FNV-1a — not cryptography, just a stable fake digest for the mock. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Deterministic 64-hex-char pseudo tx hash: same inputs → same hash, always. */
function fakeTxHash(seed: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round += 1) out += fnv1a(`${round}|${seed}`)
  return out.slice(0, 64)
}

function record(call: MockBridgeCall): void {
  if (typeof window === 'undefined') return
  ;(window.__mockBridgeLog ??= []).push(call)
}

export class MockBridge implements WalletBridge {
  async ready(): Promise<void> {
    await delay(MOCK_LATENCY_MS)
    record({ method: 'ready', args: null, result: null, at: new Date().toISOString() })
  }

  async sign(message: string): Promise<{ publicKey: string; signature: string }> {
    await delay(MOCK_LATENCY_MS)
    const result = { publicKey: MOCK_PUBLIC_KEY, signature: MOCK_SIGNATURE }
    record({ method: 'sign', args: { message }, result, at: new Date().toISOString() })
    return result
  }

  async sendWithData(o: {
    recipient: string
    valueLuna: bigint
    data: string
  }): Promise<{ txHash: string }> {
    await delay(MOCK_LATENCY_MS)
    const result = { txHash: fakeTxHash(`${o.recipient}|${o.valueLuna}|${o.data}`) }
    record({
      method: 'sendWithData',
      // bigint is not JSON-serializable; keep the log printable.
      args: { recipient: o.recipient, valueLuna: o.valueLuna.toString(), data: o.data },
      result,
      at: new Date().toISOString(),
    })
    return result
  }
}
