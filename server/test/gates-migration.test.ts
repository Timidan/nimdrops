import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)
const SCHEMA = 'gates_migration_test'

describe.skipIf(!hasDb)('015_gates', () => {
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

  async function gatedDrop(kind = 'trivia', config = '{}'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'seed', 20, 100000, 2000000, 'live')
       RETURNING id`,
      [`seed-${Math.random().toString(36).slice(2, 12)}`],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, $2, $3::jsonb)`,
      [rows[0].id, kind, config],
    )
    return rows[0].id
  }

  it('creates the six gate tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('drop_gates','gate_grants','trivia_sessions',
                            'trivia_answers','passphrase_attempts','attestation_nonces')
       ORDER BY table_name`,
      [SCHEMA],
    )
    expect(rows.map((r) => r.table_name)).toEqual([
      'attestation_nonces',
      'drop_gates',
      'gate_grants',
      'passphrase_attempts',
      'trivia_answers',
      'trivia_sessions',
    ])
  })

  it('refuses an unknown gate kind', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'seed', 20, 100000, 2000000, 'live') RETURNING id`,
      [`bad-${Math.random().toString(36).slice(2, 12)}`],
    )
    await expect(
      pool.query(`INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1,'captcha','{}'::jsonb)`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/drop_gates_kind_allowed/)
  })

  it('allows only one grant per wallet per drop', async () => {
    const dropId = await gatedDrop()
    const grant = () =>
      pool.query(
        `INSERT INTO gate_grants (drop_id, wallet_address, kind)
         VALUES ($1, 'NQ07 PLAYER', 'trivia')`,
        [dropId],
      )
    await grant()
    await expect(grant()).rejects.toThrow(/gate_grants_drop_id_wallet_address_key/)
  })

  it('allows the same wallet a grant on a different drop', async () => {
    const a = await gatedDrop()
    const b = await gatedDrop()
    for (const dropId of [a, b]) {
      await pool.query(
        `INSERT INTO gate_grants (drop_id, wallet_address, kind)
         VALUES ($1, 'NQ07 BOTH', 'trivia')`,
        [dropId],
      )
    }
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM gate_grants WHERE wallet_address = 'NQ07 BOTH'`,
    )
    expect(rows[0].count).toBe('2')
  })

  it('refuses a second answer for one question index', async () => {
    const dropId = await gatedDrop()
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions
         (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
       VALUES ($1, 'NQ07 TWICE', 'in_progress', 'v1', '["a"]'::jsonb,
               now() + interval '10 minutes')
       RETURNING id`,
      [dropId],
    )
    const answer = () =>
      pool.query(
        `INSERT INTO trivia_answers
           (session_id, question_index, question_id, delivered_at, deadline_at)
         VALUES ($1, 0, 'a', now(), now() + interval '15 seconds')`,
        [rows[0].id],
      )
    await answer()
    await expect(answer()).rejects.toThrow(/trivia_answers_pkey/)
  })

  it('allows repeated failed sessions for one wallet', async () => {
    const dropId = await gatedDrop()
    const session = (state: string) =>
      pool.query(
        `INSERT INTO trivia_sessions
           (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
         VALUES ($1, 'NQ07 TRIER', $2, 'v1', '["a"]'::jsonb, now())`,
        [dropId, state],
      )
    await session('failed')
    await session('failed')
    await session('expired')
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM trivia_sessions WHERE wallet_address = 'NQ07 TRIER'`,
    )
    expect(rows[0].count).toBe('3')
  })

  it('records repeated passphrase attempts for one wallet on one drop', async () => {
    const dropId = await gatedDrop('passphrase')
    const attempt = () =>
      pool.query(
        `INSERT INTO passphrase_attempts (drop_id, wallet_address)
         VALUES ($1, 'NQ07 GUESSER')`,
        [dropId],
      )
    for (let i = 0; i < 5; i += 1) await attempt()
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM passphrase_attempts WHERE wallet_address = 'NQ07 GUESSER'`,
    )
    expect(rows[0].count).toBe('5')
  })

  it('refuses a replayed attestation nonce on one drop', async () => {
    const dropId = await gatedDrop('attested')
    const use = () =>
      pool.query(`INSERT INTO attestation_nonces (drop_id, nonce_hash) VALUES ($1, 'abc')`, [
        dropId,
      ])
    await use()
    await expect(use()).rejects.toThrow(/attestation_nonces_pkey/)
  })

  // ---- CHECK constraints, exercised in the direction that matters -------------
  //
  // A CHECK fed only valid values is an unverified CHECK: it would pass just as
  // happily if it had been written backwards or dropped altogether. Each case
  // below asserts the constraint REFUSES something, and names it.

  /** An in-progress session, for the answer-constraint cases. */
  async function sessionFor(dropId: string, wallet: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions
         (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
       VALUES ($1, $2, 'in_progress', 'v1', '["a"]'::jsonb, now())
       RETURNING id`,
      [dropId, wallet],
    )
    return rows[0].id
  }

  it('accepts every allowed gate kind', async () => {
    for (const kind of ['trivia', 'passphrase', 'attested']) {
      await expect(gatedDrop(kind)).resolves.toBeTruthy()
    }
  })

  it('refuses an unknown session state', async () => {
    const dropId = await gatedDrop()
    await expect(
      pool.query(
        `INSERT INTO trivia_sessions
           (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
         VALUES ($1, 'NQ07 X', 'cheating', 'v1', '["a"]'::jsonb, now())`,
        [dropId],
      ),
    ).rejects.toThrow(/trivia_sessions_state_allowed/)
  })

  it("accepts 'passed', which no other case inserts", async () => {
    const dropId = await gatedDrop()
    await expect(
      pool.query(
        `INSERT INTO trivia_sessions
           (drop_id, wallet_address, state, bank_version, question_ids, expires_at, completed_at)
         VALUES ($1, 'NQ07 WINNER', 'passed', 'v1', '["a"]'::jsonb, now(), now())`,
        [dropId],
      ),
    ).resolves.toBeTruthy()
  })

  it('refuses a negative delivered_count', async () => {
    const dropId = await gatedDrop()
    await expect(
      pool.query(
        `INSERT INTO trivia_sessions
           (drop_id, wallet_address, state, bank_version, question_ids, expires_at, delivered_count)
         VALUES ($1, 'NQ07 Y', 'in_progress', 'v1', '["a"]'::jsonb, now(), -1)`,
        [dropId],
      ),
    ).rejects.toThrow(/trivia_sessions_delivered_non_negative/)
  })

  it('refuses an answer index outside the four options', async () => {
    const sessionId = await sessionFor(await gatedDrop(), 'NQ07 Z')
    await expect(
      pool.query(
        `INSERT INTO trivia_answers
           (session_id, question_index, question_id, delivered_at, deadline_at, answer_index)
         VALUES ($1, 0, 'a', now(), now(), 4)`,
        [sessionId],
      ),
    ).rejects.toThrow(/trivia_answers_answer_range/)
  })

  it('refuses a negative question index', async () => {
    const sessionId = await sessionFor(await gatedDrop(), 'NQ07 NEG')
    await expect(
      pool.query(
        `INSERT INTO trivia_answers
           (session_id, question_index, question_id, delivered_at, deadline_at)
         VALUES ($1, -1, 'a', now(), now())`,
        [sessionId],
      ),
    ).rejects.toThrow(/trivia_answers_index_non_negative/)
  })

  // Gate rows hang off `drop_gates`, not `drops`, so a drop carrying no gate
  // cannot acquire grants, sessions or nonces by accident.
  it('refuses a grant for a drop that carries no gate', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'plain', 5, 100000, 500000, 'live')
       RETURNING id`,
      [`plain-${Math.random().toString(36).slice(2, 12)}`],
    )
    await expect(
      pool.query(
        `INSERT INTO gate_grants (drop_id, wallet_address, kind)
         VALUES ($1, 'NQ07 SNEAK', 'trivia')`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/gate_grants_drop_id_fkey/)
  })
})
