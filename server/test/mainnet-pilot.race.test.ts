import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { createDraft } from '../src/services/drops'
import {
  DropTooLargeError,
  FloatAttestationError,
  MAINNET_PILOT_DEFAULTS,
  NoHeadroomError,
  PausedError,
  assertFloatAttestationIntact,
  ensureChainBinding,
  readControls,
} from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number.
import '../src/db/pool'

/**
 * The mainnet pilot posture (tasks 2 and 3 of the cutover).
 *
 * Nimiq Pay has no testnet for NIM: a real device claim paid out on
 * TestAlbatross is invisible in the recipient's wallet, and the same address
 * shows a zero balance on mainnet. So every real user, including a judge, is on
 * mainnet — which means the first mainnet deployment is not a rehearsal, and it
 * must start closed rather than open.
 *
 * Two claims are asserted here, and both are about what happens when NOBODY
 * REMEMBERS TO CONFIGURE ANYTHING:
 *
 *  1. a fresh database bound to MainAlbatross gets the pilot posture — paused,
 *     one drop at a time — while TestAlbatross is left alone (which is what
 *     leaves the rest of the suite and the VPS harness untouched); and
 *  2. a float attestation proven on another chain, or a float the deposits do
 *     not add up to, stops both entrypoints from starting.
 *
 * The second is the guard behind the recommendation that mainnet runs on a
 * FRESH database, because the testnet one's drops, attempts
 * and float mean nothing on mainnet and several of them mean something wrong.
 * Nothing in the supported path produces the states below — `bindNetwork`
 * refuses to move a bound database at all — so these are the guards for the
 * ways around it: a hand-edited column, a restored dump, a copied database.
 */

const hasDb = Boolean(process.env.DATABASE_URL)

const SCHEMA = 'mainnet_pilot_race_test'
const CUSTODY = 'NQ07 CUSTODY'
const OTHER_HASH = 'a'.repeat(64)

let pool: pg.Pool

function chainOn(network: 'TestAlbatross' | 'MainAlbatross'): FakeChain {
  return new FakeChain({ custody: CUSTODY, finalityDepth: 5, headHeight: 100, network })
}

/** Back to the state the migrations leave, with no binding of any kind. */
async function resetControls(): Promise<void> {
  await pool.query(
    `UPDATE custody_controls
     SET singleton = true,
         paused = false,
         max_live_principal_luna = NULL,
         max_live_drops = NULL,
         configured_fee_reserve_luna = 100000,
         operator_float_luna = 0,
         network = NULL,
         custody_address = NULL,
         last_reconciled_at = NULL,
         last_reconciled_height = NULL,
         reconciled_confirmed_balance_luna = NULL,
         shortfall_detected_at = NULL,
         shortfall_observed_height = NULL
     WHERE singleton`,
  )
}

describe.skipIf(!hasDb)('mainnet pilot posture (real Postgres)', () => {
  const savedNetwork = process.env.NIMIQ_NETWORK

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
    if (savedNetwork === undefined) delete process.env.NIMIQ_NETWORK
    else process.env.NIMIQ_NETWORK = savedNetwork
  })

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       operator_float_deposits, operator_float_withdrawals, custody_deposit_owners,
       http_idempotency RESTART IDENTITY CASCADE`,
    )
    await resetControls()
  })

  // ---- pilot defaults ---------------------------------------------------------

  it('a fresh database bound to MainAlbatross starts paused, at one drop, uncapped', async () => {
    const bound = await ensureChainBinding(pool, chainOn('MainAlbatross'))
    expect(bound.network).toBe('MainAlbatross')

    const controls = await readControls(pool)
    expect(controls.paused, 'production opens on a deliberate unpause, not on a container start').toBe(
      true,
    )
    expect(controls.maxLivePrincipalLuna).toBe(MAINNET_PILOT_DEFAULTS.maxLivePrincipalLuna)
    expect(
      controls.maxLivePrincipalLuna,
      'migration 015: a drop’s size is the sponsor’s decision, not a pilot number',
    ).toBeNull()
    expect(controls.maxLiveDrops, 'one drop at a time is what is left of the pilot posture').toBe(1)
    expect(controls.configuredFeeReserveLuna).toBe(100_000n)
    expect(controls.operatorFloatLuna, 'the float is attested, never assumed').toBe(0n)
  })

  it('a fresh database bound to TestAlbatross keeps the migrations’ values', async () => {
    await ensureChainBinding(pool, chainOn('TestAlbatross'))

    const controls = await readControls(pool)
    expect(controls.paused).toBe(false)
    expect(controls.maxLivePrincipalLuna, 'no principal ceiling anywhere by default').toBeNull()
    expect(controls.maxLiveDrops, 'no drop-count limit on testnet').toBeNull()
    expect(controls.configuredFeeReserveLuna).toBe(100_000n)
  })

  it('applies the pilot defaults once, never over an operator’s later choice', async () => {
    const chain = chainOn('MainAlbatross')
    await ensureChainBinding(pool, chain)

    // The operator opens the pilot and widens it deliberately.
    await pool.query(
      `UPDATE custody_controls
       SET paused = false, max_live_principal_luna = 500000, max_live_drops = 3
       WHERE singleton`,
    )
    // A restart must not undo that: the defaults are applied at the moment the
    // binding is stamped, and this database is already bound.
    await ensureChainBinding(pool, chain)

    const controls = await readControls(pool)
    expect(controls.paused).toBe(false)
    expect(controls.maxLivePrincipalLuna).toBe(500_000n)
    expect(controls.maxLiveDrops).toBe(3)
  })

  it('the pilot defaults are what actually stop a second drop', async () => {
    const chain = chainOn('MainAlbatross')
    await ensureChainBinding(pool, chain)

    const draft = (amountEachLuna: bigint, claimCount: number) =>
      createDraft(pool, chain, { sponsorLabel: 'Sponsor', amountEachLuna, claimCount })

    // Paused out of the box: nobody is told where to send real NIM until an
    // operator says so.
    await expect(draft(100_000n, 2)).rejects.toBeInstanceOf(PausedError)

    await pool.query('UPDATE custody_controls SET paused = false WHERE singleton')

    // The one the pilot still asks for: 200 NIM across 100 people goes through,
    // because no policy number stands between a sponsor and the size of their
    // own drop any more.
    const first = await draft(200_000n, 100)
    expect(first.expectedFundingLuna, '2 NIM each × 100 people').toBe(20_000_000n)
    expect(first.capacity.remainingLuna, 'nothing to run out of').toBeNull()
    expect(first.capacity.remainingDrops, 'the drop slot is what the pilot holds').toBe(0)

    // `max_live_drops` is now the only ceiling a fresh mainnet database has.
    await expect(draft(100_000n, 2)).rejects.toBeInstanceOf(NoHeadroomError)
  })

  it('an operator can put the principal cap back as a kill switch', async () => {
    const chain = chainOn('MainAlbatross')
    await ensureChainBinding(pool, chain)
    await pool.query(
      `UPDATE custody_controls
       SET paused = false, max_live_drops = NULL, max_live_principal_luna = 500000
       WHERE singleton`,
    )
    const draft = (amountEachLuna: bigint, claimCount: number) =>
      createDraft(pool, chain, { sponsorLabel: 'Sponsor', amountEachLuna, claimCount })

    // 10 NIM against a 5 NIM ceiling: refused before the sponsor pays anything.
    await expect(draft(500_000n, 2)).rejects.toBeInstanceOf(DropTooLargeError)
    // …and lifting the switch lets the same drop straight through.
    await pool.query('UPDATE custody_controls SET max_live_principal_luna = NULL WHERE singleton')
    await expect(draft(500_000n, 2)).resolves.toBeDefined()
  })

  // ---- the float attestation may not cross chains -----------------------------

  it('accepts a float that is backed, on this chain, to the luna', async () => {
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, 100000, 10, 'MainAlbatross')`,
      [OTHER_HASH],
    )
    await pool.query('UPDATE custody_controls SET operator_float_luna = 100000 WHERE singleton')

    await expect(assertFloatAttestationIntact(pool, 'MainAlbatross')).resolves.toBeUndefined()
  })

  it('refuses to start on a float attested against another chain’s deposit', async () => {
    // The exact carry-over: a database that ran on testnet, moved to mainnet.
    // Nothing sums float deposits per network, so those luna would be spent as
    // mainnet custody capacity and real payouts signed against them.
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, 100000, 10, 'TestAlbatross')`,
      [OTHER_HASH],
    )
    await pool.query('UPDATE custody_controls SET operator_float_luna = 100000 WHERE singleton')

    const err = await assertFloatAttestationIntact(pool, 'MainAlbatross').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FloatAttestationError)
    expect((err as Error).message).toContain('TestAlbatross')
    expect((err as Error).message, 'the operator is told what to do about it').toMatch(
      /fresh database/i,
    )
  })

  it('refuses to start on a float the deposits do not add up to', async () => {
    // What deleting the foreign rows and forgetting the number leaves behind.
    await pool.query('UPDATE custody_controls SET operator_float_luna = 100000 WHERE singleton')

    await expect(assertFloatAttestationIntact(pool, 'MainAlbatross')).rejects.toBeInstanceOf(
      FloatAttestationError,
    )
  })

  it('a genuinely fresh database passes the float guard with nothing attested', async () => {
    await expect(assertFloatAttestationIntact(pool, 'MainAlbatross')).resolves.toBeUndefined()
  })

  // ---- the float is deposits MINUS withdrawals (migration 022) ----------------
  //
  // Found in the final pre-deploy review, one step from production. `float
  // lower` reduced the declared float below gross deposits; this guard compared
  // against gross deposits only; and the next boot of BOTH entrypoints refused
  // to start. The command built to unstick a paused deployment would have
  // bricked it. These three cases compose the lower path with the boot guard,
  // which is exactly the composition the lower path's own tests missed.

  it('accepts a lowered float: deposits minus withdrawals, to the luna', async () => {
    // The production shape the fix exists for: 15 NIM attested in, 2 NIM
    // verifiably out (the smoke drop's sponsor seed), declared float 13.
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, 1500000, 10, 'MainAlbatross')`,
      [OTHER_HASH],
    )
    await pool.query(
      `INSERT INTO operator_float_withdrawals (tx_hash, value_luna, included_height, network, reason)
       VALUES ('seed-tx-hash', 200000, 20, 'MainAlbatross', 'sponsor seed for smoke drop')`,
    )
    await pool.query('UPDATE custody_controls SET operator_float_luna = 1300000 WHERE singleton')

    await expect(assertFloatAttestationIntact(pool, 'MainAlbatross')).resolves.toBeUndefined()
  })

  it('refuses a float still declared at gross deposits after a withdrawal', async () => {
    // The bug itself, pinned: if the guard read only the deposits table, this
    // state — withdrawal recorded, float never lowered — would pass, and the
    // books would credit 2 NIM that verifiably left custody.
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, 1500000, 10, 'MainAlbatross')`,
      [OTHER_HASH],
    )
    await pool.query(
      `INSERT INTO operator_float_withdrawals (tx_hash, value_luna, included_height, network, reason)
       VALUES ('seed-tx-hash', 200000, 20, 'MainAlbatross', 'sponsor seed for smoke drop')`,
    )
    await pool.query('UPDATE custody_controls SET operator_float_luna = 1500000 WHERE singleton')

    await expect(assertFloatAttestationIntact(pool, 'MainAlbatross')).rejects.toBeInstanceOf(
      FloatAttestationError,
    )
  })

  it('refuses to start on a withdrawal attested against another chain', async () => {
    // The mirror of the foreign-deposit case: a testnet withdrawal must not be
    // able to lower a mainnet float any more than a testnet deposit could raise
    // one. Same carry-over risk, opposite direction.
    await pool.query(
      `INSERT INTO operator_float_deposits (tx_hash, value_luna, included_height, network)
       VALUES ($1, 1500000, 10, 'MainAlbatross')`,
      [OTHER_HASH],
    )
    await pool.query(
      `INSERT INTO operator_float_withdrawals (tx_hash, value_luna, included_height, network, reason)
       VALUES ('foreign-out', 200000, 20, 'TestAlbatross', 'testnet history')`,
    )
    await pool.query('UPDATE custody_controls SET operator_float_luna = 1300000 WHERE singleton')

    const err = await assertFloatAttestationIntact(pool, 'MainAlbatross').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FloatAttestationError)
    expect((err as Error).message).toContain('TestAlbatross')
  })
})
