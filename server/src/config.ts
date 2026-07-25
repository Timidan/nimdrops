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

/** Uniform message extraction for the `catch (err: unknown)` sites. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
