import type { Pool, PoolClient } from 'pg'
import type { ChainClient } from '../chain/types'
import { BLOCK_SEPARATION_MS, type NetworkName, validityWindowBlocks } from '../config'
import type { Queryable } from '../db/pool'
import { type Alerts, consoleAlerts } from './alerts'

/**
 * Solvency invariant and custody runtime controls (design §10.2, §10.3).
 *
 * Every money-moving path — funding activation, claim allocation, and each
 * outgoing signature — must run inside ONE database transaction that starts by
 * calling `lockControls`. The mandated lock order is ALWAYS
 * `custody_controls` → drop row; taking them in the other order deadlocks.
 *
 * Since the G1 review review the invariant runs on a LEDGER-DERIVED balance
 * (`ledgerBalanceLuna`: operator float + accepted finalized funding − finalized
 * outgoing principal − recorded fees), not on the chain's head-state balance.
 * The chain balance is still fetched every `reconcile()`, but only as a
 * cross-check that pauses custody when the chain holds LESS than the books
 * claim. Books decide what may be spent; the chain decides whether the books
 * are still true.
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

/** Ledger balance cannot cover outstanding principal plus the fee reserve. */
export class InsolventError extends SolvencyError {}

/**
 * A reconciliation observed the chain holding LESS than the books claim, and no
 * reconciliation has succeeded since (round-2 review N3).
 *
 * Deliberately a subclass of {@link InsolventError}: every existing handler —
 * the worker's deferral path, the HTTP 503 mapping — already treats an
 * insolvency as "money is owed and we will not sign for it", which is exactly
 * the right behaviour here. What the distinct type adds is an operator-facing
 * name for a condition `unpause` cannot clear.
 */
export class UnreconciledShortfallError extends InsolventError {}

/** The requested addition would push live principal past `max_live_principal_luna`. */
export class CapExceededError extends SolvencyError {}

export interface Controls {
  paused: boolean
  maxLivePrincipalLuna: bigint
  configuredFeeReserveLuna: bigint
  /**
   * Operator-attested custody money that is not any drop's funding — the
   * pre-funded float the fee reserve is spent out of. The ONLY ledger credit
   * the drops themselves cannot supply (see 004 migration, finding 4).
   */
  operatorFloatLuna: bigint
  lastReconciledHeight: number | null
  lastReconciledAt: Date | null
  /**
   * Chain balance observed at the last `reconcile()`. A CROSS-CHECK ONLY since
   * finding 4: it is head-state, so it can include credits a reorg later takes
   * away. The invariant runs on `ledgerBalanceLuna` instead. `null` before the
   * first successful `reconcile()`.
   */
  reconciledConfirmedBalanceLuna: bigint | null
  /** `null` until the first boot stamps it (finding 6). */
  network: NetworkName | null
  /**
   * When `reconcile()` last saw the chain below the ledger, `null` once a
   * reconciliation has succeeded since (N3). While this is set every money path
   * fails closed with {@link UnreconciledShortfallError}, and `unpause` does
   * NOT clear it — only a clean reconcile does.
   */
  shortfallDetectedAt: Date | null
}

interface ControlsRow {
  paused: boolean
  max_live_principal_luna: string
  configured_fee_reserve_luna: string
  operator_float_luna: string
  last_reconciled_height: string | null
  last_reconciled_at: Date | null
  reconciled_confirmed_balance_luna: string | null
  network: NetworkName | null
  shortfall_detected_at: Date | null
  stale: boolean
}

function toControls(row: ControlsRow): Controls {
  return {
    paused: row.paused,
    maxLivePrincipalLuna: BigInt(row.max_live_principal_luna),
    configuredFeeReserveLuna: BigInt(row.configured_fee_reserve_luna),
    operatorFloatLuna: BigInt(row.operator_float_luna),
    lastReconciledHeight: row.last_reconciled_height === null ? null : Number(row.last_reconciled_height),
    lastReconciledAt: row.last_reconciled_at,
    reconciledConfirmedBalanceLuna:
      row.reconciled_confirmed_balance_luna === null
        ? null
        : BigInt(row.reconciled_confirmed_balance_luna),
    network: row.network,
    shortfallDetectedAt: row.shortfall_detected_at,
  }
}

const SELECT_CONTROLS = `
  SELECT paused,
         max_live_principal_luna,
         configured_fee_reserve_luna,
         operator_float_luna,
         last_reconciled_height,
         last_reconciled_at,
         reconciled_confirmed_balance_luna,
         network,
         shortfall_detected_at,
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
 * The custody balance the invariant is allowed to trust, derived from the
 * LEDGER rather than from the chain's head state (G1 review finding 4):
 *
 *     operator float
 *   + sum(accepted finalized funding)
 *   - sum(finalized outgoing principal)
 *   - sum(recorded fees on confirmed attempts)
 *
 * Why not the chain balance: `chain.confirmedBalanceLuna` answers about the
 * head, which includes credits that are not final and can be reorged away, and
 * credits that belong to nobody's drop. Spending either as capacity is spending
 * money that may not be there — the failure mode is a stranded campaign whose
 * claimants cannot be paid.
 *
 * Every term here is money this system verified for itself:
 *
 *  - funding counts only drops with `activated_height IS NOT NULL`, i.e. a
 *    transaction that passed every design §7 predicate AND our own finality
 *    depth. Terminal drops stay in the sum: their money entered custody and
 *    only the payout side removes it again.
 *  - outgoing counts only intents that are `confirmed` WITH a `confirmed`
 *    attempt — the same "finalized" definition `outstandingPrincipalLuna` uses,
 *    so in-flight payments are absent from BOTH sides and can never
 *    double-count against the invariant.
 *  - fees are real, already-spent custody money that no drop's principal
 *    covers; leaving them out would let the reserve drain invisibly.
 *
 * The operator float is the one term the drops cannot supply — see the 004
 * migration. It is an attestation, and `reconcile()`'s chain cross-check is
 * what catches an attestation that is too high.
 */
export async function ledgerMovementsLuna(db: Queryable): Promise<bigint> {
  const { rows } = await db.query<{ movements_luna: string }>(`
    WITH funded AS (
      SELECT COALESCE(SUM(expected_funding_luna), 0) AS luna
      FROM drops
      WHERE activated_height IS NOT NULL
    ),
    paid_out AS (
      SELECT COALESCE(SUM(t.amount_luna), 0) AS luna
      FROM outgoing_transfers t
      WHERE t.state = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM transaction_attempts a
          WHERE a.transfer_id = t.id AND a.state = 'confirmed'
        )
    ),
    fees AS (
      SELECT COALESCE(SUM(fee_luna), 0) AS luna
      FROM transaction_attempts
      WHERE state = 'confirmed'
    )
    SELECT (
      (SELECT luna FROM funded)
      - (SELECT luna FROM paid_out)
      - (SELECT luna FROM fees)
    )::BIGINT AS movements_luna
  `)
  return BigInt(rows[0].movements_luna)
}

/** `operator float + ledger movements`: the balance the invariant may spend. */
export async function ledgerBalanceLuna(db: Queryable, controls: Controls): Promise<bigint> {
  return controls.operatorFloatLuna + (await ledgerMovementsLuna(db))
}

/**
 * How long an attempt may still be counted as legitimately in flight.
 *
 * The same window the chain itself enforces (`validity_start_height + 7200`
 * blocks at one block per second), measured in wall time because attempt rows
 * carry a timestamp rather than a head height. Past it the transaction cannot
 * be included by anyone, so it can no longer be the explanation for money
 * missing from custody.
 */
export function inFlightMaxAgeMs(windowBlocks: number = validityWindowBlocks()): number {
  return windowBlocks * BLOCK_SEPARATION_MS
}

/** @internal test-only override; production reads the floored config. */
export interface InFlightOptions {
  maxAgeMs?: number
}

/**
 * Money that has been committed to leaving custody but is not yet finalized in
 * the ledger, and that can still plausibly explain a chain balance below the
 * books: an attempt that was actually BROADCAST and is still inside its
 * validity window, plus that attempt's fee.
 *
 * Used ONLY by the chain cross-check. The chain debits a payment the moment it
 * lands, while the ledger waits for our own finality depth, so during that
 * window the chain legitimately shows LESS than the books do. Without this term
 * every in-flight payout would look like a shortfall and pause custody.
 *
 * Two exclusions, both from round-2 review N1. The offset used to cover every
 * `signed`/`broadcast` attempt with no age bound, which turned it into a
 * permanent alibi: ONE stale attempt sitting open forever subtracted its amount
 * from the cross-check for as long as it existed, so a real custody shortfall
 * of the same size never showed up at all.
 *
 *  - **`signed` but never broadcast.** The bytes never left this process, so
 *    the chain cannot possibly have debited them. Counting them as an
 *    explanation for missing money is counting a payment that was never made.
 *  - **Older than the validity window.** Past its deadline a transaction is
 *    unincludable, so custody will never be debited for it either.
 *
 * Anything excluded here is money the books think is leaving and the chain will
 * never take. That is an operator condition in its own right — see
 * {@link staleInFlightOutgoing}, which `reconcile()` alerts on.
 */
export async function inFlightOutgoingLuna(
  db: Queryable,
  opts?: InFlightOptions,
): Promise<bigint> {
  const { rows } = await db.query<{ in_flight_luna: string }>(
    `SELECT COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS in_flight_luna
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE a.state = 'broadcast'
       AND a.created_at > now() - make_interval(secs => $1::float8 / 1000)`,
    [opts?.maxAgeMs ?? inFlightMaxAgeMs()],
  )
  return BigInt(rows[0].in_flight_luna)
}

export interface StaleInFlight {
  /** Open attempts that no longer offset the cross-check. */
  count: number
  /** Their principal plus fees — money the books expect to leave and the chain will not take. */
  lunaTotal: bigint
  /** Never handed to the network at all: `signed`, no acknowledged broadcast. */
  neverBroadcastCount: number
}

/**
 * Open attempts that {@link inFlightOutgoingLuna} deliberately refuses to count
 * (N1). Non-empty means an intent is stuck in a state only a human resolves:
 * either the worker never got its bytes out, or they aged out of the chain's
 * validity window without landing.
 */
export async function staleInFlightOutgoing(
  db: Queryable,
  opts?: InFlightOptions,
): Promise<StaleInFlight> {
  const { rows } = await db.query<{
    n: number
    luna_total: string
    never_broadcast: number
  }>(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(t.amount_luna + a.fee_luna), 0)::BIGINT AS luna_total,
            count(*) FILTER (WHERE a.state = 'signed')::int AS never_broadcast
     FROM transaction_attempts a
     JOIN outgoing_transfers t ON t.id = a.transfer_id
     WHERE a.state IN ('signed', 'broadcast')
       AND NOT (
         a.state = 'broadcast'
         AND a.created_at > now() - make_interval(secs => $1::float8 / 1000)
       )`,
    [opts?.maxAgeMs ?? inFlightMaxAgeMs()],
  )
  return {
    count: rows[0].n,
    lunaTotal: BigInt(rows[0].luna_total),
    neverBroadcastCount: rows[0].never_broadcast,
  }
}

/**
 * Enforce both design §10.2 invariants before adding `addLuna` of new principal
 * (a funding activation passes the drop's expected funding; allocation and
 * outgoing signatures pass `0n`, since that principal is already outstanding):
 *
 *   ledger balance + addLuna        >= outstanding principal + addLuna + fee reserve
 *   outstanding principal + addLuna <= max_live_principal_luna
 *
 * `addLuna` appears in the balance requirement because of G1 review finding 3:
 * checking only `balance >= outstanding + reserve` let an activation pass while
 * leaving the POST-activation state short — the new principal became a
 * liability that the balance was never asked to cover. It also appears on the
 * available side, because a ledger balance credits accepted funding at the same
 * instant it becomes a liability: the drop's funding transaction is verified
 * and final before `activate()` runs, and `activated_height` is stamped in the
 * very transaction this check guards. Writing both terms out is deliberate —
 * they cancel to `ledger >= outstanding + reserve`, and that cancellation IS
 * the structural reason finding 3 cannot recur under a ledger-derived balance.
 * Under the old head-state chain balance they did not cancel, which is exactly
 * how the gap appeared.
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

  // The chain cross-check must have run at least once. The invariant no longer
  // spends this number, but a system that has never compared its books against
  // the chain has no business creating new liabilities.
  if (controls.reconciledConfirmedBalanceLuna === null) {
    throw new StaleReconciliationError('custody balance has never been reconciled')
  }

  // N3: a reconciliation saw the chain below the books and no reconciliation
  // has succeeded since. `paused` may well have been cleared by an operator —
  // that is permission to resume, not evidence that custody holds the money.
  // Only a clean `reconcile()` clears this, which forces the right order:
  // re-establish that the books are true, THEN sign against them.
  if (controls.shortfallDetectedAt !== null) {
    throw new UnreconciledShortfallError(
      `custody was observed holding less than the ledger at ` +
        `${controls.shortfallDetectedAt.toISOString()} and no reconciliation has succeeded since. ` +
        'Unpausing does not clear this: a clean reconcile must.',
    )
  }

  const outstanding = await outstandingPrincipalLuna(client)
  const ledger = await ledgerBalanceLuna(client, controls)

  const available = ledger + addLuna
  const required = outstanding + addLuna + controls.configuredFeeReserveLuna
  if (available < required) {
    throw new InsolventError(
      `ledger balance ${ledger} (operator float ${controls.operatorFloatLuna}) < outstanding principal ` +
        `${outstanding} + added ${addLuna} + fee reserve ${controls.configuredFeeReserveLuna}`,
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
 * How far the chain may sit below the books before custody is paused. Zero for
 * now: the ledger only counts finalized movements and the in-flight term below
 * already explains every legitimate difference, so any shortfall is real.
 */
export const CROSS_CHECK_EPSILON_LUNA = 0n

/**
 * Refresh the chain cross-check and the reconciliation timestamp (design §10.3:
 * startup and periodic reconciliation).
 *
 * Since G1 review finding 4 this no longer feeds the invariant — it AUDITS it.
 * The chain balance is stored, then compared against the smallest balance the
 * books can explain (`ledger − in-flight outgoing`). Custody having MORE than
 * the books say is normal and harmless (an operator top-up, a stray deposit,
 * a not-yet-activated funding transaction); custody having LESS means either
 * money left without a ledger entry or a credit the books trusted was reorged
 * away. Neither is survivable by carrying on, so it pauses and pages.
 *
 * Chain reads happen outside any transaction, then one UPDATE stamps the row.
 * This intentionally bypasses `lockControls`: reconciliation is exactly the
 * operation that must still work while the system is paused or stale.
 *
 * The three database reads run inside ONE `REPEATABLE READ, READ ONLY` snapshot
 * (round-2 review N4). Taken in autocommit they came from three different
 * instants, and a confirmation committing between the ledger read and the
 * in-flight read produced a pair that no single instant could have produced —
 * a payout still counted as unpaid by the ledger AND already gone from the
 * in-flight offset. That difference is not a shortfall, it is a seam, and it
 * false-paused custody. One snapshot, one instant, no seam. READ ONLY makes
 * that structural, and no lock is taken: reconciliation must never block a
 * payout it is trying to account for.
 */
export async function reconcile(pool: Pool, chain: ChainClient, alerts?: Alerts): Promise<void> {
  const height = await chain.headHeight()
  const chainBalanceLuna = await chain.confirmedBalanceLuna(chain.custodyAddress())

  const client = await pool.connect()
  let ledgerLuna: bigint
  let inFlightLuna: bigint
  let stale: StaleInFlight
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const controls = await readControls(client)
    ledgerLuna = await ledgerBalanceLuna(client, controls)
    inFlightLuna = await inFlightOutgoingLuna(client)
    stale = await staleInFlightOutgoing(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  const explainableMinimumLuna = ledgerLuna - inFlightLuna
  const short = chainBalanceLuna < explainableMinimumLuna - CROSS_CHECK_EPSILON_LUNA

  // One statement stamps the cross-check AND the durable shortfall verdict (N3).
  // `COALESCE` keeps the FIRST time the condition was seen across repeated
  // failing passes; a clean pass is the only thing that writes NULL back.
  await pool.query(
    `UPDATE custody_controls
     SET reconciled_confirmed_balance_luna = $1,
         last_reconciled_height = $2,
         last_reconciled_at = now(),
         shortfall_detected_at = CASE
           WHEN $3::bool THEN COALESCE(shortfall_detected_at, now())
           ELSE NULL
         END
     WHERE singleton`,
    [chainBalanceLuna.toString(), height.toString(), short],
  )

  const notify = alerts ?? consoleAlerts()

  if (short) {
    const detail = {
      stage: 'reconcile',
      reason: 'chain_below_ledger',
      chainBalanceLuna: chainBalanceLuna.toString(),
      ledgerBalanceLuna: ledgerLuna.toString(),
      inFlightOutgoingLuna: inFlightLuna.toString(),
      shortfallLuna: (explainableMinimumLuna - chainBalanceLuna).toString(),
      height,
    }
    await pause(pool, `chain balance ${chainBalanceLuna} below ledger balance ${ledgerLuna}`)
    await notify.notify('insolvent', detail)
  }

  // N1: attempts excluded from the offset above. Money the books have committed
  // to sending that the chain will never take — silent until now, because the
  // old unbounded offset made each one look like an ordinary payment in flight.
  if (stale.count > 0) {
    await notify.notify('manual_review', {
      stage: 'reconcile',
      reason: 'stale_in_flight_attempt',
      staleAttempts: stale.count,
      neverBroadcast: stale.neverBroadcastCount,
      lunaTotal: stale.lunaTotal.toString(),
      height,
    })
  }
}

/** The database is bound to a different chain than this process is talking to. */
export class NetworkMismatchError extends Error {}

/**
 * An unbound database that already holds money history: the operator must say
 * which chain it belongs to before anything is stamped (round-2 review F6).
 */
export class NetworkBindingUnconfirmedError extends Error {}

/** Env var an operator sets to confirm the network of a pre-existing database. */
export const CONFIRM_NETWORK_ENV = 'NIMDROPS_CONFIRM_NETWORK'

/**
 * Bind this database to a chain, or refuse to run (G1 review finding 6).
 *
 * Nothing in the schema used to say which network the money in it lives on. An
 * operator whose shell still had `NIMIQ_NETWORK=TestAlbatross` could point the
 * recovery CLI at the mainnet database and have it prove a mainnet payout
 * "absent" — by looking for it on testnet — and then sign a replacement. The
 * first boot stamps the network; every later boot and every chain-touching
 * recovery command calls this first and throws before any chain action.
 *
 * Deliberately not idempotent in the loose sense: the stamp is written once and
 * never updated. Moving a custody database between networks is not an operation
 * this system supports.
 *
 * **Round-2 F6.** "Stamp whatever the first process says" is only safe on a
 * database with no money in it. Migration 004 added the column NULL to
 * databases that already had a payment history, so the very deployment the
 * guard was written for — a live mainnet database, an operator with a stale
 * testnet shell — would have had its binding invented by the wrong process and
 * the guard would then have agreed with itself forever. So an unbound database
 * that ALREADY HAS attempt rows fails closed: the operator must state the
 * network in `NIMDROPS_CONFIRM_NETWORK`, and it must match what this process is
 * actually talking to. A genuinely fresh database (no attempts) still stamps on
 * first boot, because there is no history for a wrong guess to endanger.
 */
export async function ensureNetworkBinding(pool: Pool, chain: ChainClient): Promise<NetworkName> {
  const running = chain.network()
  const { rows } = await pool.query<{ network: NetworkName | null }>(
    'SELECT network FROM custody_controls WHERE singleton',
  )
  const row = rows[0]
  if (!row) throw new SolvencyError('custody_controls singleton row is missing')

  if (row.network === null) {
    const { rows: counted } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM transaction_attempts',
    )
    const attempts = counted[0].n
    if (attempts > 0) {
      const confirmed = process.env[CONFIRM_NETWORK_ENV]
      if (confirmed !== running) {
        throw new NetworkBindingUnconfirmedError(
          `this custody database has ${attempts} transaction attempt(s) but no recorded network, ` +
            `and this process is running against ${running}. Refusing to stamp it: if that guess ` +
            'is wrong, every payment in here can be proven "absent" on the wrong chain and paid ' +
            `again. Confirm the network the money actually lives on with ${CONFIRM_NETWORK_ENV}=` +
            `<TestAlbatross|MainAlbatross> (got ${confirmed ?? 'unset'}); it must match this ` +
            'process. Verify one of the stored tx hashes on a block explorer first.',
        )
      }
    }
    // Conditional UPDATE: two processes booting at once must not disagree, and
    // the loser of the race re-reads rather than overwrites.
    const { rows: stamped } = await pool.query<{ network: NetworkName }>(
      `UPDATE custody_controls SET network = $1 WHERE singleton AND network IS NULL
       RETURNING network`,
      [running],
    )
    if (stamped[0]) {
      console.warn(JSON.stringify({ event: 'network_bound', network: running }))
      return stamped[0].network
    }
    return ensureNetworkBinding(pool, chain)
  }

  if (row.network !== running) {
    throw new NetworkMismatchError(
      `custody database is bound to ${row.network} but this process is running against ${running}. ` +
        'Refusing every chain action: a payout signed on the wrong network can pay twice.',
    )
  }
  return row.network
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

/**
 * Release the operator pause switch.
 *
 * The mirror image of `pause`, and deliberately as dumb: it clears the flag and
 * says so. It does NOT reconcile — a system that was paused long enough for the
 * balance to go stale must still fail closed on staleness until the worker's
 * next `reconcile()`, which is the correct order (know the balance, then move
 * money). Idempotent: unpausing a running system is a no-op.
 *
 * In particular it does NOT clear `shortfall_detected_at` (N3). A pause the
 * system engaged on itself because the chain held less than the books claim is
 * not an operator's to overrule; only a reconciliation that finds the two in
 * agreement again reopens the money paths.
 */
export async function unpause(pool: Pool): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = false WHERE singleton')
  console.warn(JSON.stringify({ event: 'custody_unpaused' }))
}
