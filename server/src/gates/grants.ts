/**
 * The one and only writer of `gate_grants`.
 *
 * Every kind funnels through here so that a new kind cannot invent its own grant
 * semantics. The semantics are:
 *
 *  - **One grant per wallet per drop, ever.** Enforced by
 *    `UNIQUE (drop_id, wallet_address)`, not by a partial index on unconsumed
 *    grants: `claims` already permits one claim per wallet per drop via
 *    `UNIQUE (drop_id, recipient_address)`, so a second grant could never be
 *    spent and its only effect would be to confuse an audit.
 *  - **A grant names an address, and that is all it asserts.** It does not prove
 *    the holder of that address asked for it — no kind requires a signature to
 *    attempt a condition. What makes that safe is downstream: `reserveClaim`
 *    compares this row's `wallet_address` against the address DERIVED from the
 *    verified claim signature, so a grant issued under someone else's address is
 *    worthless to whoever issued it.
 */
import type { Queryable } from '../db/pool'
import { type GateKind, requireGateWallet } from './types'

export interface IssuedGrant {
  grantId: string
  /** False when the wallet already held a grant for this drop. */
  fresh: boolean
}

/**
 * Record that a wallet satisfied this drop's condition.
 *
 * Idempotent by `ON CONFLICT` rather than by read-then-write, and that choice is
 * load-bearing rather than tidy. Two browser tabs, a double-tapped button, or a
 * retried request can all reach this at once, and a unique violation surfacing as
 * a 500 would read to a player as the condition they just satisfied not counting.
 * Read-then-write would have the same problem with worse timing: both callers see
 * no row, both insert, one fails.
 *
 * Accepts any {@link Queryable}, so a kind may call it inside its own
 * transaction — trivia does, committing the passing session and its grant
 * together — or against the pool when there is nothing to be atomic with.
 */
export async function issueGrant(
  db: Queryable,
  o: {
    dropId: string
    walletAddress: string
    kind: GateKind
    /** Permille of the full share this grant pays; omitted (or null) means full. */
    payoutPermille?: number
  },
): Promise<IssuedGrant> {
  // The last checkpoint, and the reason it is here rather than only in the kinds:
  // this is the choke point every kind already funnels through, so a kind added
  // later cannot store an address in a spelling of its own by forgetting a call.
  // `UNIQUE (drop_id, wallet_address)` is what makes one grant per wallet true,
  // and a unique index on a text column is only a rule about a WALLET when one
  // wallet is one string.
  const walletAddress = requireGateWallet(o.walletAddress)

  const { rows: inserted } = await db.query<{ id: string }>(
    `INSERT INTO gate_grants (drop_id, wallet_address, kind, payout_permille)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (drop_id, wallet_address) DO NOTHING
     RETURNING id`,
    [o.dropId, walletAddress, o.kind, o.payoutPermille ?? null],
  )
  if (inserted[0]) return { grantId: inserted[0].id, fresh: true }

  // The conflict target already held a row. Read it rather than reporting
  // failure: the caller's condition IS satisfied for this wallet, whichever
  // kind got there first.
  const { rows: existing } = await db.query<{ id: string }>(
    'SELECT id FROM gate_grants WHERE drop_id = $1 AND wallet_address = $2',
    [o.dropId, walletAddress],
  )
  const row = existing[0]
  if (!row) {
    // Nothing inserted and nothing found. Only reachable if the row was deleted
    // between the two statements, which no code path does — so this is a bug
    // report, not a condition to paper over with a retry.
    throw new Error(
      `gate_grants row for drop ${o.dropId} vanished between insert and read`,
    )
  }
  return { grantId: row.id, fresh: false }
}
