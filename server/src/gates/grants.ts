/**
 * The one and only writer of `gate_grants`.
 *
 * Every kind funnels through here so that a new kind cannot invent its own grant
 * semantics. The semantics are:
 *
 *  - **One grant per non-trivia wallet, or per passed trivia session.** A quiz
 *    replay earns a new payout, while retrying the same finished session stays
 *    idempotent.
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
  /** False when this non-trivia wallet or trivia session was already granted. */
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
    /** Required for trivia, absent for every other gate kind. */
    triviaSessionId?: string
  },
): Promise<IssuedGrant> {
  // The last checkpoint, and the reason it is here rather than only in the kinds:
  // this is the choke point every kind already funnels through, so a kind added
  // later cannot store an address in a spelling of its own by forgetting a call.
  // The non-trivia unique index is only a rule about a wallet when one wallet
  // is one string; trivia is instead unique by the passed session id.
  const walletAddress = requireGateWallet(o.walletAddress)
  if (o.kind === 'trivia' && !o.triviaSessionId) {
    throw new Error('a trivia grant requires its passed session id')
  }
  if (o.kind !== 'trivia' && o.triviaSessionId) {
    throw new Error('only trivia grants may name a trivia session')
  }

  const { rows: inserted } = await db.query<{ id: string }>(
    `INSERT INTO gate_grants (
       drop_id, wallet_address, kind, payout_permille, trivia_session_id
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [o.dropId, walletAddress, o.kind, o.payoutPermille ?? null, o.triviaSessionId ?? null],
  )
  if (inserted[0]) return { grantId: inserted[0].id, fresh: true }

  const { rows: existing } = await db.query<{ id: string }>(
    o.kind === 'trivia'
      ? 'SELECT id FROM gate_grants WHERE trivia_session_id = $1'
      : 'SELECT id FROM gate_grants WHERE drop_id = $1 AND wallet_address = $2',
    o.kind === 'trivia' ? [o.triviaSessionId] : [o.dropId, walletAddress],
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
