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
 */

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
 * `Policy.BLOCK_SEPARATION_TIME` on both Albatross networks: one block per
 * second. Only ever used to turn a window measured in BLOCKS into the same
 * window measured in WALL TIME, for durable rows that carry a timestamp rather
 * than a height (see `solvency.inFlightMaxAgeMs`).
 */
export const BLOCK_SEPARATION_MS = 1_000

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

/** Uniform message extraction for the `catch (err: unknown)` sites. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
