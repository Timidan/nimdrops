/**
 * Migration 017, against data written the way the code used to write it.
 *
 * The application started canonicalising addresses on the way in before this
 * migration existed, and that half on its own is worse than neither half: a row
 * already stored as `NQ07 ABCD…` becomes invisible to a lookup that now asks for
 * `NQ07ABCD…`. An eligible claimant is refused `gate_required`; a wallet that has
 * spent all five passphrase guesses is handed five more; a question a wallet has
 * already answered can be dealt to it again.
 *
 * So these cases seed the OLD spelling deliberately. A suite that only ever wrote
 * canonical rows would pass whether or not the migration did anything at all.
 */
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import { testAddress } from './fixtures/address'
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)
const SCHEMA = 'gates_address_migration_test'

const MIGRATION = '017_canonical_gate_addresses.sql'
const CONSTRAINT = 'gate_grants_wallet_address_canonical'

/** One wallet, spelled the three ways a client could have sent it. */
const CANONICAL = testAddress('LEGACY')
const SPACED = `${CANONICAL.slice(0, 4)} ${CANONICAL.slice(4)}`
const LOWER = CANONICAL.toLowerCase()

describe.skipIf(!hasDb)('017_canonical_gate_addresses', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  /**
   * Wind 017 back so the next `migrate()` re-runs it.
   *
   * The CHECK constraint has to go first, and its presence is the reason this
   * dance is needed at all: with it in place a legacy row cannot be inserted, so
   * there would be nothing for the migration to fix. Dropping it here is
   * therefore also a check that the constraint is doing its job.
   */
  async function rewind(): Promise<void> {
    await pool.query(`ALTER TABLE gate_grants DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`)
    await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION])
  }

  async function gatedDrop(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'seed', 20, 100000, 2000000, 'live')
       RETURNING id`,
      [`seed-${Math.random().toString(36).slice(2, 12)}`],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, 'trivia', '{}'::jsonb)`,
      [rows[0].id],
    )
    return rows[0].id
  }

  /** One `in_progress` session for a wallet, spelled however the caller says. */
  async function sessionRow(dropId: string, wallet: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions
         (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
       VALUES ($1, $2, 'in_progress', 'v1', '["geo-1"]'::jsonb, now() + interval '10 minutes')
       RETURNING id`,
      [dropId, wallet],
    )
    return rows[0].id
  }

  beforeEach(async () => {
    for (const table of [
      'trivia_seen',
      'trivia_answers',
      'trivia_sessions',
      // Before `claims`: a consumed grant points at one, and the merge case
      // writes both. FK order is the whole reason this is a list and not a loop
      // over information_schema.
      'gate_grants',
      'claims',
      'passphrase_attempts',
      'attestation_nonces',
      'drop_gates',
      'drops',
    ]) {
      await pool.query(`DELETE FROM ${table}`)
    }
  })

  it('rewrites a legacy grant into the spelling the claim path looks for', async () => {
    const dropId = await gatedDrop()
    await rewind()
    await pool.query(
      `INSERT INTO gate_grants (drop_id, wallet_address, kind) VALUES ($1, $2, 'trivia')`,
      [dropId, SPACED],
    )

    await migrate(pool)

    const { rows } = await pool.query<{ wallet_address: string }>(
      'SELECT wallet_address FROM gate_grants',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].wallet_address).toBe(CANONICAL)
  })

  it('merges duplicate spellings and keeps the one that was spent', async () => {
    // Two spellings of one wallet can BOTH hold a grant on one drop, because the
    // unique constraint is textual. Rewriting both would violate it and abort the
    // whole migration, so one has to win — and it has to be the CONSUMED one, or
    // the link between a paid claim and the grant that authorised it is lost.
    const dropId = await gatedDrop()
    await rewind()
    const { rows: claim } = await pool.query<{ id: string }>(
      `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
       VALUES ($1, 0, $2, 'hash-legacy', 'paid') RETURNING id`,
      [dropId, SPACED],
    )
    // The consumed one is inserted SECOND and is the newer row, so a tie-break on
    // age alone would pick the wrong survivor.
    await pool.query(
      `INSERT INTO gate_grants (drop_id, wallet_address, kind, granted_at)
       VALUES ($1, $2, 'trivia', now() - interval '1 hour')`,
      [dropId, LOWER],
    )
    await pool.query(
      `INSERT INTO gate_grants (drop_id, wallet_address, kind, consumed_claim_id)
       VALUES ($1, $2, 'trivia', $3)`,
      [dropId, SPACED, claim[0].id],
    )

    await migrate(pool)

    const { rows } = await pool.query<{
      wallet_address: string
      consumed_claim_id: string | null
    }>('SELECT wallet_address, consumed_claim_id FROM gate_grants')
    expect(rows).toHaveLength(1)
    expect(rows[0].wallet_address).toBe(CANONICAL)
    expect(rows[0].consumed_claim_id).toBe(claim[0].id)
  })

  it('merges a wallet’s seen questions instead of losing the earlier sighting', async () => {
    // The surviving row is identified by its session_id, not merely counted.
    // Asserting the row COUNT alone would pass against a migration that kept the
    // later sighting — the title's whole claim — which is what the review of this
    // file caught.
    const dropId = await gatedDrop()
    await rewind()
    const early = await sessionRow(dropId, SPACED)
    const late = await sessionRow(dropId, LOWER)
    await pool.query(
      `INSERT INTO trivia_seen (wallet_address, question_id, session_id, seen_at)
       VALUES ($1, 'geo-1', $3, now() - interval '2 hours'),
              ($2, 'geo-1', $4, now()),
              ($1, 'sci-1', $3, now())`,
      [SPACED, LOWER, early, late],
    )

    await migrate(pool)

    const { rows } = await pool.query<{
      wallet_address: string
      question_id: string
      session_id: string
      age_hours: number
    }>(
      `SELECT wallet_address, question_id, session_id,
              round(extract(epoch FROM now() - seen_at) / 3600)::int AS age_hours
       FROM trivia_seen ORDER BY question_id`,
    )
    // Three rows under two spellings become two under one, and `geo-1` survives
    // exactly once — the answer to "has this wallet seen it" is yes either way.
    expect(rows.map((r) => [r.wallet_address, r.question_id])).toEqual([
      [CANONICAL, 'geo-1'],
      [CANONICAL, 'sci-1'],
    ])
    // ...and it is the EARLIER of the two: two hours old, and pointing at the
    // session that actually showed it.
    expect(rows[0].session_id).toBe(early)
    expect(rows[0].age_hours).toBe(2)
  })

  it('rewrites trivia_sessions, which nothing else in this file would notice', async () => {
    // Its own case because the cooldown and the resume lookup both read this
    // table by wallet. Deleting the migration's UPDATE for it passed every other
    // test in this file, so without this the statement was unprotected.
    const dropId = await gatedDrop()
    await rewind()
    await sessionRow(dropId, SPACED)
    await sessionRow(dropId, LOWER)

    await migrate(pool)

    const { rows } = await pool.query<{ spellings: string; sessions: string }>(
      `SELECT count(DISTINCT wallet_address)::text AS spellings, count(*)::text AS sessions
       FROM trivia_sessions`,
    )
    // Both survive — this table has no unique key to collide on, and two attempts
    // by one wallet are two rows. They just stop being two different wallets.
    expect(rows[0]).toEqual({ spellings: '1', sessions: '2' })
    const { rows: spelled } = await pool.query<{ wallet_address: string }>(
      'SELECT DISTINCT wallet_address FROM trivia_sessions',
    )
    expect(spelled[0].wallet_address).toBe(CANONICAL)
  })

  it('folds a wallet’s passphrase attempts together, so the cap is not reset', async () => {
    // The cap counts the last hour's attempts for one wallet. Split across
    // spellings, a wallet that had spent all five was handed another five per
    // spelling — the concurrency fix in `passphrase.ts` closed the race and this
    // closes the way around it.
    const dropId = await gatedDrop()
    await rewind()
    await pool.query(
      `INSERT INTO passphrase_attempts (drop_id, wallet_address)
       VALUES ($1, $2), ($1, $2), ($1, $3), ($1, $4)`,
      [dropId, SPACED, LOWER, CANONICAL],
    )

    await migrate(pool)

    const { rows } = await pool.query<{ spellings: string; attempts: string }>(
      `SELECT count(DISTINCT wallet_address)::text AS spellings, count(*)::text AS attempts
       FROM passphrase_attempts`,
    )
    expect(rows[0]).toEqual({ spellings: '1', attempts: '4' })
  })

  it('leaves an already-canonical database untouched', async () => {
    const dropId = await gatedDrop()
    await rewind()
    await pool.query(
      `INSERT INTO gate_grants (drop_id, wallet_address, kind) VALUES ($1, $2, 'trivia')`,
      [dropId, CANONICAL],
    )

    await migrate(pool)

    const { rows } = await pool.query<{ wallet_address: string }>(
      'SELECT wallet_address FROM gate_grants',
    )
    expect(rows).toEqual([{ wallet_address: CANONICAL }])
  })

  it('refuses a non-canonical grant afterwards, whoever writes it', async () => {
    // `issueGrant` canonicalises, but "the only writer" is a fact about today's
    // code rather than about the schema. This is what survives a spike script, a
    // psql session, or a kind added later.
    const dropId = await gatedDrop()
    for (const spelling of [SPACED, LOWER]) {
      await expect(
        pool.query(
          `INSERT INTO gate_grants (drop_id, wallet_address, kind) VALUES ($1, $2, 'trivia')`,
          [dropId, spelling],
        ),
      ).rejects.toThrow(new RegExp(CONSTRAINT))
    }
  })
})
