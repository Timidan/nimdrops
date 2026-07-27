/**
 * Gate lookup and listing — the layer between HTTP and the individual kinds.
 *
 * Dependency direction is one-way and checked: this module imports from
 * `gates/*`, and nothing under `gates/` imports back. `services/claims.ts`
 * imports neither, which is what keeps the question bank, the selection salt and
 * the attester keys out of the money path.
 */
import type { Pool } from 'pg'
import { type GateKind, type GateRow, GateRejectedError } from '../gates/types'

// Re-exported for the HTTP layer, which needs the same liveness check before it
// dispatches to a kind. The definition lives in `gates/types.ts` so that a kind
// can use it without importing from `services/`.
export { assertGameLive } from '../gates/types'

/**
 * One row of the public games list.
 *
 * A named field set, never the raw `drop_gates.config`. Config holds the
 * passphrase hash for one kind and the attester public key for another, so
 * serialising it wholesale would leak both — the reason this interface exists
 * rather than returning the row.
 */
export interface ListedGame {
  publicId: string
  kind: GateKind
  /** Trivia difficulty, or null for a kind that has no tiers. */
  tier: string | null
  amountEachLuna: string
  slotsRemaining: number
  expiresAt: string | null
  unlockRequiresTier: string | null
  /** The sponsor's public hint for `passphrase`; null for every other kind. */
  hint: string | null
}

export async function loadGate(pool: Pool, publicId: string): Promise<GateRow> {
  const { rows } = await pool.query<{
    drop_id: string
    public_id: string
    kind: GateKind
    listed: boolean
    config: Record<string, unknown>
    drop_state: string
  }>(
    `SELECT g.drop_id, d.public_id, g.kind, g.listed, g.config, d.state AS drop_state
     FROM drop_gates g
     JOIN drops d ON d.id = g.drop_id
     WHERE d.public_id = $1`,
    [publicId],
  )
  const row = rows[0]
  if (!row) throw new GateRejectedError('not_a_game', 'this drop carries no condition')
  return {
    dropId: row.drop_id,
    publicId: row.public_id,
    kind: row.kind,
    listed: row.listed,
    config: row.config,
    dropState: row.drop_state,
  }
}

/** Whether a wallet has already satisfied this drop's condition. */
export async function hasGrant(
  pool: Pool,
  dropId: string,
  walletAddress: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT true AS exists FROM gate_grants
     WHERE drop_id = $1 AND wallet_address = $2`,
    [dropId, walletAddress],
  )
  return rows.length > 0
}

/**
 * Listed, gated, live games.
 *
 * Opt-in via `drop_gates.listed`, so an ungated drop keeps today's
 * unguessable-link-only behaviour and no published privacy property weakens.
 * Ordering is deterministic — kind, then tier, then expiry — because a list that
 * reorders itself between loads reads as a slot machine rather than a catalogue.
 *
 * No claimant address is selected, let alone returned (PRIVACY.md).
 */
export async function listGames(pool: Pool): Promise<ListedGame[]> {
  const { rows } = await pool.query<{
    public_id: string
    kind: GateKind
    amount_each_luna: string
    slots_remaining: number
    expires_at: Date | null
    tier: string | null
    unlock_requires_tier: string | null
    hint: string | null
  }>(
    `SELECT d.public_id, g.kind, d.amount_each_luna,
            d.claim_count - (SELECT count(*)::int FROM claims c WHERE c.drop_id = d.id)
              AS slots_remaining,
            d.expires_at,
            g.config->>'tier'               AS tier,
            g.config->>'unlockRequiresTier' AS unlock_requires_tier,
            CASE WHEN g.kind = 'passphrase' THEN g.config->>'hint' END AS hint
     FROM drop_gates g
     JOIN drops d ON d.id = g.drop_id
     WHERE g.listed = true AND d.state = 'live'
     ORDER BY array_position(ARRAY['passphrase','trivia','attested']::text[], g.kind),
              array_position(ARRAY['novice','easy','medium','hard']::text[], g.config->>'tier')
                NULLS FIRST,
              d.expires_at NULLS LAST,
              d.public_id`,
  )
  return rows.map((r) => ({
    publicId: r.public_id,
    kind: r.kind,
    tier: r.tier,
    amountEachLuna: r.amount_each_luna,
    slotsRemaining: r.slots_remaining,
    expiresAt: r.expires_at?.toISOString() ?? null,
    unlockRequiresTier: r.unlock_requires_tier,
    hint: r.hint,
  }))
}
