/**
 * Shared process configuration and small cross-cutting helpers.
 *
 * Everything here was duplicated across three or four modules before. The
 * network validator in particular had four copies, one of which silently
 * defaulted to `TestAlbatross` — the exact shape of bug that lets a mainnet
 * deployment sign against the wrong chain id without ever saying so. There is
 * now one implementation and it fails closed.
 *
 * This module must stay dependency-free (no `pg`, no `@nimiq/core`) so any
 * layer can import it without dragging a driver or the WASM bundle along.
 *
 * The one import below is `import type`, which the compiler erases: it names a
 * union declared in `auth/verify.ts` without pulling that module — or the WASM
 * bundle behind it — into anything that imports this file at runtime. Naming the
 * union rather than restating it is the point; two copies of a scheme union is
 * how the copies start drifting.
 */
import type { SigScheme } from './auth/verify'

/** The only two networks this system is allowed to run against. */
export type NetworkName = 'TestAlbatross' | 'MainAlbatross'

/**
 * Read `NIMIQ_NETWORK`, or throw.
 *
 * NEVER give this a default. The network decides the transaction `network_id`
 * we sign into every payout and the chain a claimant's funding is verified
 * against; guessing it wrong is unrecoverable in the direction that matters.
 */
export function requireNetwork(): NetworkName {
  const network = process.env.NIMIQ_NETWORK
  if (network !== 'TestAlbatross' && network !== 'MainAlbatross') {
    throw new Error(
      `NIMIQ_NETWORK must be TestAlbatross or MainAlbatross (got ${network ?? 'unset'})`,
    )
  }
  return network
}

/**
 * A configured value that decides whether a signature is accepted is missing or
 * unrecognised. Never a caller's fault, and never mapped to anything but a 500:
 * a deployment that cannot say which bytes it verifies must refuse everyone.
 */
export class SigConfigError extends Error {}

/**
 * Which bytes the wallet signs. An unset or unknown value fails closed rather
 * than guessing, since guessing wrong rejects every real claimant.
 *
 * A deployment serving Nimiq Pay wants `WALLET_SIG_SCHEME`; see `auth/verify.ts`
 * for where that is established. It stays configurable so a non-wallet signer
 * can be verified too, and because a wrong value must be *detectable* —
 * `reserveClaim` says so out loud when the signature it just refused would have
 * verified under the other scheme.
 *
 * It lives here rather than in `auth/verify.ts` so `gates/attested.ts`, the
 * claim path and the sponsor's close path all read one reader and cannot end up
 * verifying under two different schemes — and so a caller can read it without
 * pulling the WASM bundle behind `auth/verify.ts`. That module re-exports it.
 */
export function requireSigScheme(): SigScheme {
  const scheme = process.env.SIG_SCHEME
  if (scheme !== 'raw' && scheme !== 'nimiq-signed-message') {
    throw new SigConfigError(
      `SIG_SCHEME must be raw or nimiq-signed-message (got ${scheme ?? 'unset'})`,
    )
  }
  return scheme
}

// ---- protocol floors ---------------------------------------------------------
//
// G1 review findings 1 and 5. Both numbers below are PROTOCOL constants, not
// preferences, and both fail in the double-payment direction when set too low:
//
//  - A validity window shorter than the chain's own makes a transaction that is
//    still perfectly includable look permanently dead. `recover.ts replace`
//    would then sign a second payment for the same claim while the first can
//    still land.
//  - A finality depth shallower than one batch (60 blocks) calls a transaction
//    final before a macro block has finalised the batch it sits in, so a reorg
//    can un-pay a claim we already reported as `paid`.
//
// Therefore the environment may only ever RAISE them. There is deliberately no
// env-var escape hatch below the floor: a deployment that wants a smaller
// number is a deployment that wants the bug.
//
// TEST SEAM: production code never passes a number to these readers, so the
// floor is the only value a deployment can run with. Tests that need small
// windows/depths inject them through explicit, documented parameters instead —
// `evaluateProvenDead(..., { windowBlocks })`, `progressAttempt(..., { windowBlocks })`,
// `replaceTransfer(..., { windowBlocks })`, `NimiqChainOptions.finalityDepthOverride`
// and `FakeChainOptions.finalityDepth`. Those seams bypass the environment, not
// the floor: nothing reachable from `index.ts` / `worker.ts` / `recover.ts` can
// reach them.

/** `Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS` on both Albatross networks (~2h). */
export const VALIDITY_WINDOW_FLOOR_BLOCKS = 7_200

/**
 * One Albatross batch is 60 blocks (`Policy.BLOCKS_PER_BATCH`), so 64 blocks
 * always spans at least one macro block wherever in the batch the transaction
 * landed. Measured in `server/spike/g0-evidence.md`.
 */
export const FINALITY_DEPTH_FLOOR_BLOCKS = 64

function envIntAtLeast(name: string, floor: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return floor
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer (got ${raw})`)
  }
  if (value < floor) {
    throw new Error(`${name} must be at least ${floor} (got ${value}); the floor is a protocol constant`)
  }
  return value
}

/**
 * How long a signed transaction stays includable after its validity start
 * height. Floored at `VALIDITY_WINDOW_FLOOR_BLOCKS`; env may only raise it.
 */
export function validityWindowBlocks(): number {
  return envIntAtLeast('NIMIQ_VALIDITY_WINDOW_BLOCKS', VALIDITY_WINDOW_FLOOR_BLOCKS)
}

/**
 * Blocks after inclusion before a transaction may be called final — the ONLY
 * authority for `confirmed`/`paid`. Floored at `FINALITY_DEPTH_FLOOR_BLOCKS`;
 * env may only raise it.
 */
export function finalityDepthBlocks(): number {
  return envIntAtLeast('NIMIQ_FINALITY_DEPTH', FINALITY_DEPTH_FLOOR_BLOCKS)
}

// ---- trusted proxy ------------------------------------------------------------

/** Below this a "secret" is a guess away from letting anyone pick their bucket. */
export const MIN_PROXY_SECRET_BYTES = 32

/**
 * The secret Caddy presents in `X-NimDrops-Proxy-Secret` to prove a request
 * came through our own edge (`http/client-ip.ts`).
 *
 * Optional on purpose — a direct run with no proxy has no edge to authenticate,
 * and the app then buckets by socket peer, which is correct. But a value that
 * is SET AND WEAK is not a third option: it is the same as unset, except nobody
 * knows. So a short one throws at boot rather than at the first flood.
 *
 * Generate with `openssl rand -hex 32`.
 */
export function caddyAppSharedSecret(): string | undefined {
  const raw = process.env.CADDY_APP_SHARED_SECRET
  if (raw === undefined || raw === '') return undefined
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes < MIN_PROXY_SECRET_BYTES) {
    throw new Error(
      `CADDY_APP_SHARED_SECRET must be at least ${MIN_PROXY_SECRET_BYTES} bytes (got ${bytes}); ` +
        'generate one with `openssl rand -hex 32`, or leave it unset for a run with no proxy',
    )
  }
  return raw
}

/** Uniform message extraction for the `catch (err: unknown)` sites. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- trivia gate -------------------------------------------------------------
//
// Both fail closed and neither has a default. A missing salt would otherwise
// make question selection predictable from the bank alone; a missing bank path
// would otherwise silently serve no questions, which reads to a player as a
// broken game rather than a disabled one. `http/app.ts` mounts the trivia routes
// only when both are present, so ordinary drops keep working without either.

/**
 * HMAC key for deterministic question selection.
 *
 * Treat as STABLE for a campaign's duration: rotating it reshuffles every
 * future session's questions, which is harmless for a new session and
 * confusing for a player who has already failed one and expects the same set.
 */
export function requireTriviaSalt(): string {
  const salt = process.env.TRIVIA_SELECTION_SALT
  if (!salt || salt.length < 32) {
    throw new Error('TRIVIA_SELECTION_SALT must be set to at least 32 characters')
  }
  return salt
}

/** Filesystem path to the operator's question bank. Never inside the repo. */
export function requireTriviaBankPath(): string {
  const path = process.env.TRIVIA_BANK_PATH
  if (!path) throw new Error('TRIVIA_BANK_PATH must be set to the question bank file')
  return path
}

/** Whether trivia is configured at all. Absent config disables the feature. */
export function triviaConfigured(): boolean {
  return Boolean(process.env.TRIVIA_SELECTION_SALT && process.env.TRIVIA_BANK_PATH)
}

/**
 * HMAC key for passphrase hashing. SEPARATE from the trivia selection salt.
 *
 * These were one value, and that was an operability bug rather than a tidy
 * simplification. `TRIVIA_SELECTION_SALT` is documented as rotatable, and the
 * cost of rotating it is meant to be that future sessions draw different
 * questions. Sharing it with passphrase hashing made rotation ALSO invalidate
 * every hash already written into `drop_gates.config`, which turned every
 * existing passphrase drop permanently unsatisfiable: the sponsor's word still
 * worked at the event, and nobody could ever claim with it.
 *
 * Two keys means rotating either one is survivable. Neither has a default, so a
 * deployment cannot silently fall back to the other.
 */
export function requirePassphraseSalt(): string {
  const salt = process.env.PASSPHRASE_SALT
  if (!salt || salt.length < 32) {
    throw new Error('PASSPHRASE_SALT must be set to at least 32 characters')
  }
  return salt
}

/** Whether passphrase gates can be served. Independent of trivia. */
export function passphraseConfigured(): boolean {
  return Boolean(process.env.PASSPHRASE_SALT)
}
