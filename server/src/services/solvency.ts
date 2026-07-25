import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { ChainClient } from '../chain/types'

/**
 * Solvency invariant and custody runtime controls (design §10.2, §10.3).
 *
 * Every money-moving path — funding activation, claim allocation, and each
 * outgoing signature — must run inside ONE database transaction that starts by
 * calling `lockControls`. The mandated lock order is ALWAYS
 * `custody_controls` → drop row; taking them in the other order deadlocks.
 *
 * All amounts are BIGINT luna. `db/pool.ts` keeps int8 as a string on the wire,
 * so every value read here is parsed with `BigInt(...)` at this boundary and a
 * JS `number` never touches money.
 */

/** Reconciliation older than this is not trustworthy enough to move money. */
export const RECONCILIATION_MAX_AGE_MS = 10 * 60 * 1000

export class SolvencyError extends Error {}

/** Operator pause switch is engaged: fail closed on every new money path. */
export class PausedError extends SolvencyError {
  constructor(message = 'custody is paused') {
    super(message)
  }
}

/** Custody balance has not been reconciled recently enough to be trusted. */
export class StaleReconciliationError extends SolvencyError {}

/** Reconciled balance cannot cover outstanding principal plus the fee reserve. */
export class InsolventError extends SolvencyError {}

/** The requested addition would push live principal past `max_live_principal_luna`. */
export class CapExceededError extends SolvencyError {}

export interface Controls {
  paused: boolean
  maxLivePrincipalLuna: bigint
  configuredFeeReserveLuna: bigint
  lastReconciledHeight: number | null
  lastReconciledAt: Date | null
  /** `null` before the first successful `reconcile()`. */
  reconciledConfirmedBalanceLuna: bigint | null
}

/**
 * Anything that can run a query: a `Pool` (autocommit, read-only callers) or a
 * `PoolClient` inside an explicit transaction (every write path).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

interface ControlsRow {
  paused: boolean
  max_live_principal_luna: string
  configured_fee_reserve_luna: string
  last_reconciled_height: string | null
  last_reconciled_at: Date | null
  reconciled_confirmed_balance_luna: string | null
  stale: boolean
}

function toControls(row: ControlsRow): Controls {
  return {
    paused: row.paused,
    maxLivePrincipalLuna: BigInt(row.max_live_principal_luna),
    configuredFeeReserveLuna: BigInt(row.configured_fee_reserve_luna),
    lastReconciledHeight: row.last_reconciled_height === null ? null : Number(row.last_reconciled_height),
    lastReconciledAt: row.last_reconciled_at,
    reconciledConfirmedBalanceLuna:
      row.reconciled_confirmed_balance_luna === null
        ? null
        : BigInt(row.reconciled_confirmed_balance_luna),
  }
}

const SELECT_CONTROLS = `
  SELECT paused,
         max_live_principal_luna,
         configured_fee_reserve_luna,
         last_reconciled_height,
         last_reconciled_at,
         reconciled_confirmed_balance_luna,
         (last_reconciled_at IS NULL
          OR now() - last_reconciled_at > make_interval(secs => $1::float8 / 1000)) AS stale
  FROM custody_controls
  WHERE singleton
`

/**
 * Take the singleton custody lock and return the controls.
 *
 * MUST be called inside an explicit transaction (`BEGIN` already issued):
 * `FOR UPDATE` outside one is released immediately and serializes nothing.
 * This is the single choke point that makes two concurrent activations or
 * allocations impossible to both pass a cap that only fits one.
 *
 * Fails closed: `PausedError` when the operator switch is on,
 * `StaleReconciliationError` when the reconciled balance is older than
 * `RECONCILIATION_MAX_AGE_MS` (or has never been taken). Recovery paths that
 * must run while paused or stale — `reconcile()` and `pause()` — deliberately
 * do NOT go through here, otherwise the system could never unstick itself.
 */
export async function lockControls(client: PoolClient): Promise<Controls> {
  const { rows } = await client.query<ControlsRow>(`${SELECT_CONTROLS} FOR UPDATE`, [
    RECONCILIATION_MAX_AGE_MS,
  ])
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')
  if (row.paused) throw new PausedError()
  if (row.stale) {
    throw new StaleReconciliationError(
      row.last_reconciled_at === null
        ? 'custody balance has never been reconciled'
        : `custody balance last reconciled at ${row.last_reconciled_at.toISOString()}`,
    )
  }
  return toControls(row)
}

/** Read the controls without locking. Reporting and health checks only. */
export async function readControls(db: Queryable): Promise<Controls> {
  const { rows } = await db.query<ControlsRow>(SELECT_CONTROLS, [RECONCILIATION_MAX_AGE_MS])
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')
  return toControls(row)
}

/**
 * Outstanding customer principal, per design §10.2:
 *
 *     sum(all accepted finalized funding principal)
 *   - sum(all finalized outgoing payout/refund principal)
 *
 * Deliberately NOT derived from claim/refund rows: a fully unclaimed live drop
 * still owes its entire principal to future claimants or to its creator, so the
 * funding side is `expected_funding_luna` of every drop whose funding was
 * accepted and finalized (`activated_height IS NOT NULL`) and which has not yet
 * reached a terminal state.
 *
 * The outgoing side subtracts only FINALIZED principal, and only for drops in
 * that same set, so a drop's funding and its payouts leave the sum together
 * when it settles. "Finalized" requires both the intent row to be `confirmed`
 * AND a `confirmed` on-chain attempt: `broadcast` is not `paid`, and principal
 * sent in an unconfirmed attempt stays outstanding until that attempt
 * finalizes. Both conditions err toward over-reporting liability, which is the
 * safe direction for a solvency check.
 *
 * Network fees are excluded on purpose — the operator pre-funds them
 * separately, and they are covered by `configured_fee_reserve_luna`.
 */
export async function outstandingPrincipalLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ outstanding_luna: string }>(`
    WITH open_drops AS (
      SELECT id, expected_funding_luna
      FROM drops
      WHERE activated_height IS NOT NULL
        AND state NOT IN ('settled', 'refunded', 'cancelled')
    ),
    finalized_out AS (
      SELECT t.amount_luna
      FROM outgoing_transfers t
      JOIN open_drops d ON d.id = t.drop_id
      WHERE t.state = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM transaction_attempts a
          WHERE a.transfer_id = t.id AND a.state = 'confirmed'
        )
    )
    SELECT (
      COALESCE((SELECT SUM(expected_funding_luna) FROM open_drops), 0)
      - COALESCE((SELECT SUM(amount_luna) FROM finalized_out), 0)
    )::BIGINT AS outstanding_luna
  `)
  return BigInt(rows[0].outstanding_luna)
}

/**
 * Enforce both design §10.2 invariants before adding `addLuna` of new principal
 * (a funding activation passes the drop's expected funding; allocation and
 * outgoing signatures pass `0n`, since that principal is already outstanding):
 *
 *   reconciled confirmed custody balance >= outstanding principal + fee reserve
 *   outstanding principal + addLuna      <= max_live_principal_luna
 *
 * `controls` must come from `lockControls` on the SAME client/transaction —
 * the lock is what stops two callers from each passing a cap that fits one.
 */
export async function assertSolvent(
  client: Queryable,
  controls: Controls,
  addLuna: bigint,
): Promise<void> {
  if (addLuna < 0n) throw new SolvencyError('addLuna must be non-negative')

  const balance = controls.reconciledConfirmedBalanceLuna
  if (balance === null) {
    throw new StaleReconciliationError('custody balance has never been reconciled')
  }

  const outstanding = await outstandingPrincipalLuna(client)

  const required = outstanding + controls.configuredFeeReserveLuna
  if (balance < required) {
    throw new InsolventError(
      `custody balance ${balance} < outstanding principal ${outstanding} + fee reserve ${controls.configuredFeeReserveLuna}`,
    )
  }

  const projected = outstanding + addLuna
  if (projected > controls.maxLivePrincipalLuna) {
    throw new CapExceededError(
      `projected live principal ${projected} exceeds cap ${controls.maxLivePrincipalLuna}`,
    )
  }
}

/**
 * Refresh the reconciled custody balance and chain height (design §10.3:
 * startup and periodic reconciliation).
 *
 * Chain reads happen outside any transaction, then one UPDATE stamps the row.
 * This intentionally bypasses `lockControls`: reconciliation is exactly the
 * operation that must still work while the system is paused or stale.
 */
export async function reconcile(pool: Pool, chain: ChainClient): Promise<void> {
  const height = await chain.headHeight()
  const balanceLuna = await chain.confirmedBalanceLuna(chain.custodyAddress())
  await pool.query(
    `UPDATE custody_controls
     SET reconciled_confirmed_balance_luna = $1,
         last_reconciled_height = $2,
         last_reconciled_at = now()
     WHERE singleton`,
    [balanceLuna.toString(), height.toString()],
  )
}

/**
 * Engage the operator pause switch. Fail-closed kill switch: after this every
 * `lockControls` caller throws `PausedError`, so no new activation, allocation,
 * or outgoing signature can start.
 *
 * The schema has no column for the reason (see 001_core.sql), so it is logged
 * rather than persisted; `alerts.ts` (Task 11) is the durable operator record.
 */
export async function pause(pool: Pool, reason: string): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')
  console.warn(JSON.stringify({ event: 'custody_paused', reason }))
}
