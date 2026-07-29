import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg, { type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import { getPool } from '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/** Default drop shape that satisfies every CHECK. */
function ok() {
  return { claimCount: 5, amountEachLuna: 100n, expectedFundingLuna: 500n }
}

async function insertDrop(
  pool: Pool,
  o: { claimCount: number; amountEachLuna: bigint; expectedFundingLuna: bigint; state?: string },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO drops (public_id, sponsor_label, claim_count, amount_each_luna, expected_funding_luna, state)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      randomUUID(),
      'Sponsor',
      o.claimCount,
      o.amountEachLuna.toString(),
      o.expectedFundingLuna.toString(),
      o.state ?? 'live',
    ],
  )
  return rows[0]
}

async function insertClaim(
  pool: Pool,
  dropId: string,
  slotIndex: number,
  recipientAddress: string,
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO claims (drop_id, slot_index, recipient_address, status_token_hash, state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [dropId, slotIndex, recipientAddress, randomUUID(), 'reserved'],
  )
  return rows[0]
}

async function insertTransfer(
  pool: Pool,
  o: { purpose: 'payout' | 'refund'; dropId: string; claimId?: string | null; amountLuna?: bigint },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outgoing_transfers (idempotency_key, purpose, drop_id, claim_id, recipient_address, amount_luna, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      `${o.purpose}:${randomUUID()}`,
      o.purpose,
      o.dropId,
      o.claimId ?? null,
      'NQ07 RECIPIENT',
      (o.amountLuna ?? 100n).toString(),
      'queued',
    ],
  )
  return rows[0]
}

async function insertAttempt(
  pool: Pool,
  o: { transferId: string; sequence: number; state: string },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO transaction_attempts (
       transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna, validity_start_height
     ) VALUES ($1, $2, $3, $4, $5, $6, 1)
     RETURNING id`,
    [o.transferId, o.sequence, o.state, Buffer.from('00ff', 'hex'), randomUUID(), '0'],
  )
  return rows[0]
}

describe.skipIf(!hasDb)('schema invariants (real Postgres)', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = getPool()
    await migrate(pool)
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops, operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('seeds exactly one custody_controls row, uncapped, with a fee reserve', async () => {
    const { rows } = await pool.query(
      `SELECT paused, max_live_principal_luna, configured_fee_reserve_luna FROM custody_controls`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].paused).toBe(false)
    // Migration 015. 001 seeded a 100 NIM ceiling; the ceiling is now an
    // operator kill switch that ships off, and the solvency invariant is what
    // decides what a deployment can actually accept.
    expect(rows[0].max_live_principal_luna).toBeNull()
    expect(BigInt(rows[0].configured_fee_reserve_luna)).toBe(100_000n)
  })

  it('accepts a principal cap when an operator sets one, and refuses a negative', async () => {
    await pool.query('UPDATE custody_controls SET max_live_principal_luna = 500000 WHERE singleton')
    await expect(
      pool.query('UPDATE custody_controls SET max_live_principal_luna = -1 WHERE singleton'),
    ).rejects.toThrow(/max_live_principal_non_negative|check/i)
    await pool.query('UPDATE custody_controls SET max_live_principal_luna = NULL WHERE singleton')
  })

  it('still requires a non-negative fee reserve', async () => {
    await expect(
      pool.query('UPDATE custody_controls SET configured_fee_reserve_luna = -1 WHERE singleton'),
    ).rejects.toThrow(/fee_reserve_non_negative|check/i)
  })

  it('rejects a drop whose expected funding mismatches count*amount', async () => {
    await expect(
      insertDrop(pool, { claimCount: 5, amountEachLuna: 100n, expectedFundingLuna: 400n }),
    ).rejects.toThrow(/expected_funding|check/i)
  })

  it('forbids two payouts for one claim', async () => {
    const d = await insertDrop(pool, ok())
    const c = await insertClaim(pool, d.id, 0, 'NQ07 X')
    await insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id })
    await expect(
      insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id }),
    ).rejects.toThrow(/one_payout_per_claim|duplicate/i)
  })

  it('forbids two refunds for one drop', async () => {
    const d = await insertDrop(pool, ok())
    await insertTransfer(pool, { purpose: 'refund', dropId: d.id })
    await expect(insertTransfer(pool, { purpose: 'refund', dropId: d.id })).rejects.toThrow(
      /one_refund_per_drop|duplicate/i,
    )
  })

  it('forbids a second open attempt per transfer', async () => {
    const d = await insertDrop(pool, ok())
    const c = await insertClaim(pool, d.id, 0, 'NQ07 OPEN')
    const t = await insertTransfer(pool, { purpose: 'payout', dropId: d.id, claimId: c.id })
    await insertAttempt(pool, { transferId: t.id, sequence: 1, state: 'signed' })
    await expect(
      insertAttempt(pool, { transferId: t.id, sequence: 2, state: 'broadcast' }),
    ).rejects.toThrow(/one_open_attempt|duplicate/i)

    // A replacement is only allowed once the prior attempt is proven_dead.
    await pool.query(`UPDATE transaction_attempts SET state = 'proven_dead' WHERE transfer_id = $1`, [
      t.id,
    ])
    await expect(
      insertAttempt(pool, { transferId: t.id, sequence: 2, state: 'signed' }),
    ).resolves.toBeDefined()
  })

  /**
   * G1 review finding 9. `002` backfills `validity_start_height = 0`, and a zero
   * window is past at any real head — every pre-existing attempt would read as
   * "provably dead" to the recovery CLI, which is permission to sign a second
   * payment. The guard makes that impossible to do by accident: on an empty
   * table (every fresh deploy) it is invisible, on a populated one it raises.
   */
  describe('migration 002 refuses to backfill a populated table', () => {
    const GUARD_SCHEMA = 'schema_guard_test'
    const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations/', import.meta.url))

    async function sql(name: string): Promise<string> {
      return readFile(join(MIGRATIONS, name), 'utf8')
    }

    /** A private schema holding ONLY 001, i.e. a 001-era database. */
    async function fresh001(): Promise<pg.Pool> {
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`DROP SCHEMA IF EXISTS ${GUARD_SCHEMA} CASCADE`)
      await admin.query(`CREATE SCHEMA ${GUARD_SCHEMA}`)
      await admin.end()
      const scoped = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${GUARD_SCHEMA},public`,
      })
      await scoped.query(await sql('001_core.sql'))
      return scoped
    }

    async function dropGuardSchema(): Promise<void> {
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`DROP SCHEMA IF EXISTS ${GUARD_SCHEMA} CASCADE`)
      await admin.end()
    }

    it('applies cleanly to an empty 001 schema', async () => {
      const scoped = await fresh001()
      try {
        await expect(scoped.query(await sql('002_attempt_validity_window.sql'))).resolves.toBeDefined()
        const { rows } = await scoped.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'transaction_attempts'
             AND column_name = 'validity_start_height'`,
          [GUARD_SCHEMA],
        )
        expect(rows).toHaveLength(1)
      } finally {
        await scoped.end()
        await dropGuardSchema()
      }
    })

    it('raises rather than backfilling height 0 when attempts already exist', async () => {
      const scoped = await fresh001()
      try {
        const d = await insertDrop(scoped, ok())
        const c = await insertClaim(scoped, d.id, 0, 'NQ07 LEGACY')
        const { rows } = await scoped.query<{ id: string }>(
          `INSERT INTO outgoing_transfers (idempotency_key, purpose, drop_id, claim_id,
             recipient_address, amount_luna, state)
           VALUES ($1, 'payout', $2, $3, 'NQ07 RECIPIENT', 100, 'in_progress')
           RETURNING id`,
          [`payout:${randomUUID()}`, d.id, c.id],
        )
        // A 001-era attempt: real money in flight, no validity height column.
        await scoped.query(
          `INSERT INTO transaction_attempts (transfer_id, sequence, state, raw_signed_tx, tx_hash, fee_luna)
           VALUES ($1, 1, 'broadcast', $2, $3, 0)`,
          [rows[0].id, Buffer.from('00ff', 'hex'), randomUUID()],
        )

        await expect(scoped.query(await sql('002_attempt_validity_window.sql'))).rejects.toThrow(
          /refusing to backfill validity_start_height/i,
        )

        // …and the schema is untouched, so an operator can fix it by hand.
        const { rows: columns } = await scoped.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'transaction_attempts'
             AND column_name = 'validity_start_height'`,
          [GUARD_SCHEMA],
        )
        expect(columns).toHaveLength(0)
      } finally {
        await scoped.end()
        await dropGuardSchema()
      }
    })
  })

  /**
   * Round-2 review F9. The guard above is correct and, on the databases it was
   * written for, unreachable: `db/migrate.ts` skips by FILENAME, so a
   * deployment that had already applied 002 never ran the amended version of it
   * and never will. `005` ships the check as a migration of its own, where it
   * does execute — and it looks for the DAMAGE (a `validity_start_height` of 0)
   * rather than the precondition, so a healthy populated database is not
   * refused along with the broken ones.
   */
  describe('migration 005 catches a backfill that 002 already committed', () => {
    const GUARD_SCHEMA = 'schema_guard_005_test'
    const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations/', import.meta.url))
    const APPLIED = [
      '001_core.sql',
      '002_attempt_validity_window.sql',
      '003_annotations.sql',
      '004_absence_tracking_and_network.sql',
    ]

    async function sql(name: string): Promise<string> {
      return readFile(join(MIGRATIONS, name), 'utf8')
    }

    async function dropSchema(): Promise<void> {
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`DROP SCHEMA IF EXISTS ${GUARD_SCHEMA} CASCADE`)
      await admin.end()
    }

    /**
     * A database in the state a real deployment is in: 001–004 applied and
     * RECORDED as applied, so the runner will never look at any of them again.
     */
    async function alreadyMigratedTo004(): Promise<pg.Pool> {
      await dropSchema()
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`CREATE SCHEMA ${GUARD_SCHEMA}`)
      await admin.end()

      const scoped = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${GUARD_SCHEMA},public`,
      })
      for (const name of APPLIED) await scoped.query(await sql(name))
      await scoped.query(
        `CREATE TABLE schema_migrations (
           name TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      )
      for (const name of APPLIED) {
        await scoped.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      }
      return scoped
    }

    /** One attempt row carrying `validityStartHeight`, with its intent and claim. */
    async function attemptAtHeight(db: Pool, validityStartHeight: number): Promise<void> {
      const d = await insertDrop(db, ok())
      const c = await insertClaim(db, d.id, 0, `NQ07 LEGACY ${randomUUID()}`)
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO outgoing_transfers (idempotency_key, purpose, drop_id, claim_id,
           recipient_address, amount_luna, state)
         VALUES ($1, 'payout', $2, $3, 'NQ07 RECIPIENT', 100, 'in_progress')
         RETURNING id`,
        [`payout:${randomUUID()}`, d.id, c.id],
      )
      await db.query(
        `INSERT INTO transaction_attempts (transfer_id, sequence, state, raw_signed_tx, tx_hash,
           fee_luna, validity_start_height)
         VALUES ($1, 1, 'broadcast', $2, $3, 0, $4)`,
        [rows[0].id, Buffer.from('00ff', 'hex'), randomUUID(), validityStartHeight],
      )
    }

    it('refuses to migrate a database whose attempts were backfilled to height 0', async () => {
      const scoped = await alreadyMigratedTo004()
      try {
        // The damage 002 did before it grew a guard: a live payment whose
        // validity window (0 + 7200) is past at any real head, which
        // `recover.ts replace` would read as permission to pay again.
        await attemptAtHeight(scoped, 0)

        await expect(migrate(scoped)).rejects.toThrow(/validity_start_height = 0/i)

        // 002 is recorded as applied and stays that way; 005 is NOT recorded,
        // so the operator gets the same refusal on every retry until they fix it.
        const { rows } = await scoped.query<{ name: string }>(
          'SELECT name FROM schema_migrations ORDER BY name',
        )
        expect(rows.map((r) => r.name)).toEqual(APPLIED)
      } finally {
        await scoped.end()
        await dropSchema()
      }
    })

    it('migrates a populated database whose attempts carry real heights', async () => {
      const scoped = await alreadyMigratedTo004()
      try {
        await attemptAtHeight(scoped, 6_999_043)

        await expect(migrate(scoped)).resolves.toBeUndefined()

        // The later migrations landed: the float attribution table and the
        // durable shortfall flag.
        const { rows } = await scoped.query<{ name: string }>(
          'SELECT name FROM schema_migrations ORDER BY name',
        )
        expect(rows.map((r) => r.name)).toContain('005_attempt_validity_backfill_guard.sql')
        expect(rows.map((r) => r.name)).toContain('006_float_attestation.sql')
        expect(rows.map((r) => r.name)).toContain('007_reconcile_shortfall_flag.sql')
      } finally {
        await scoped.end()
        await dropSchema()
      }
    })

    it('locks the table before counting, so a concurrent writer cannot slip past it', async () => {
      const scoped = await alreadyMigratedTo004()
      const writer = await scoped.connect()
      try {
        // An in-flight insert that has NOT committed. A bare `count(*)` in READ
        // COMMITTED cannot see it, so a guard that only counts would report a
        // clean table and let the migration through — and the row would land
        // moments later, backfilled and invisible.
        await writer.query('BEGIN')
        const d = await insertDrop(scoped, ok())
        const c = await insertClaim(scoped, d.id, 0, `NQ07 RACER ${randomUUID()}`)
        const { rows } = await writer.query<{ id: string }>(
          `INSERT INTO outgoing_transfers (idempotency_key, purpose, drop_id, claim_id,
             recipient_address, amount_luna, state)
           VALUES ($1, 'payout', $2, $3, 'NQ07 RECIPIENT', 100, 'in_progress')
           RETURNING id`,
          [`payout:${randomUUID()}`, d.id, c.id],
        )
        await writer.query(
          `INSERT INTO transaction_attempts (transfer_id, sequence, state, raw_signed_tx, tx_hash,
             fee_luna, validity_start_height)
           VALUES ($1, 1, 'broadcast', $2, $3, 0, 0)`,
          [rows[0].id, Buffer.from('00ff', 'hex'), randomUUID()],
        )

        let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
        const guard = scoped
          .query(await sql('005_attempt_validity_backfill_guard.sql'))
          .then(
            () => {
              settled = 'resolved'
            },
            () => {
              settled = 'rejected'
            },
          )

        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(settled, 'the guard must wait for the writer, not read around it').toBe('pending')

        await writer.query('COMMIT')
        await guard
        expect(settled, 'and then refuse on the row it was made to wait for').toBe('rejected')
      } finally {
        writer.release()
        await scoped.end()
        await dropSchema()
      }
    })
  })

  describe('migrations 016 and 017 cannot stall the claim path', () => {
    const CONSTRAINTS: ReadonlyArray<[string, string]> = [
      ['drops', 'drops_expiry_hours_range'],
      ['drops', 'drops_closing_reason_allowed'],
      ['wallet_challenges', 'wallet_challenges_action_allowed'],
    ]
    const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations/', import.meta.url))

    async function sql(name: string): Promise<string> {
      return readFile(join(MIGRATIONS, name), 'utf8')
    }

    it('bounds the wait AND the work, in both files', async () => {
      for (const name of ['016_sponsor_chosen_expiry.sql', '017_sponsor_close.sql']) {
        const text = await sql(name)
        expect(text, `${name} must bound how long it waits for the lock`).toMatch(
          /SET LOCAL lock_timeout/,
        )
        expect(text, `${name} must bound the work it does while holding it`).toMatch(
          /SET LOCAL statement_timeout/,
        )
        // A validated ADD CONSTRAINT scans the table under ACCESS EXCLUSIVE.
        const body = text
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
        const added = body.match(/\bADD CONSTRAINT\b/g)?.length ?? 0
        const deferred = body.match(/\bNOT VALID\b/g)?.length ?? 0
        expect(added, `${name} should still add constraints`).toBeGreaterThan(0)
        expect(deferred, `${name} must add every constraint NOT VALID`).toBe(added)
      }
    })

    it('adds every constraint NOT VALID, and enforces all three anyway', async () => {
      // `beforeAll` already ran 018 on this schema, so validity is asserted
      // below against one where only 016 and 017 have. Here: still enforced.
      for (const [table, conname] of CONSTRAINTS) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
          [conname, table],
        )
        expect(rows, `${conname} must exist`).toHaveLength(1)
      }

      const d = await insertDrop(pool, ok())
      await expect(
        pool.query('UPDATE drops SET expiry_hours = 0 WHERE id = $1', [d.id]),
      ).rejects.toThrow(/drops_expiry_hours_range/)
      await expect(
        pool.query('UPDATE drops SET expiry_hours = 337 WHERE id = $1', [d.id]),
      ).rejects.toThrow(/drops_expiry_hours_range/)
      await expect(
        pool.query(`UPDATE drops SET closing_reason = 'because' WHERE id = $1`, [d.id]),
      ).rejects.toThrow(/drops_closing_reason_allowed/)
      await expect(
        pool.query(
          `INSERT INTO wallet_challenges (drop_id, action, nonce_hash, canonical_message, expires_at)
           VALUES ($1, 'refund', $2, '{}', now() + interval '5 minutes')`,
          [d.id, randomUUID()],
        ),
      ).rejects.toThrow(/wallet_challenges_action_allowed/)
      await pool.query('DELETE FROM drops WHERE id = $1', [d.id])
    })

    /** A private schema at 001..015, so 016-018 can be run one at a time. */
    const CUTOVER_SCHEMA = 'schema_cutover_test'

    async function dropCutoverSchema(): Promise<void> {
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`DROP SCHEMA IF EXISTS ${CUTOVER_SCHEMA} CASCADE`)
      await admin.end()
    }

    async function migratedTo015(): Promise<pg.Pool> {
      await dropCutoverSchema()
      const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      await admin.query(`CREATE SCHEMA ${CUTOVER_SCHEMA}`)
      await admin.end()

      const scoped = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${CUTOVER_SCHEMA},public`,
      })
      const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()
      for (const name of names) {
        if (name >= '016') break
        await scoped.query(await sql(name))
      }
      return scoped
    }

    async function validity(db: pg.Pool): Promise<Record<string, boolean>> {
      const { rows } = await db.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conname = ANY($1) AND connamespace = $2::regnamespace`,
        [CONSTRAINTS.map(([, c]) => c), CUTOVER_SCHEMA],
      )
      return Object.fromEntries(rows.map((r) => [r.conname, r.convalidated]))
    }

    it('leaves the constraints unvalidated until 018 says otherwise', async () => {
      const scoped = await migratedTo015()
      try {
        await scoped.query(await sql('016_sponsor_chosen_expiry.sql'))
        await scoped.query(await sql('017_sponsor_close.sql'))

        // `false` here means no table was scanned under ACCESS EXCLUSIVE.
        expect(await validity(scoped)).toEqual({
          drops_expiry_hours_range: false,
          drops_closing_reason_allowed: false,
          wallet_challenges_action_allowed: false,
        })

        await scoped.query(await sql('018_validate_deferred_constraints.sql'))
        expect(await validity(scoped)).toEqual({
          drops_expiry_hours_range: true,
          drops_closing_reason_allowed: true,
          wallet_challenges_action_allowed: true,
        })

        // Re-runnable against an already-valid database.
        await expect(
          scoped.query(await sql('018_validate_deferred_constraints.sql')),
        ).resolves.toBeDefined()
      } finally {
        await scoped.end()
        await dropCutoverSchema()
      }
    })

    it('aborts within its lock_timeout instead of queueing behind a held lock', async () => {
      const scoped = await migratedTo015()
      const blocker = await scoped.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE drops IN ACCESS EXCLUSIVE MODE')

        const startedAt = Date.now()
        await expect(scoped.query(await sql('016_sponsor_chosen_expiry.sql'))).rejects.toThrow(
          /lock timeout|canceling statement due to lock timeout/i,
        )
        const waited = Date.now() - startedAt
        // 3 s bound, with headroom for a loaded box. The blocker never yields
        // on its own, so waiting for it would never return at all.
        expect(waited, 'the migration must give up on its own bound').toBeLessThan(10_000)

        await blocker.query('ROLLBACK')

        // Nothing left behind: the runner's next start applies it cleanly.
        await expect(
          scoped.query(await sql('016_sponsor_chosen_expiry.sql')),
        ).resolves.toBeDefined()
      } finally {
        blocker.release()
        await scoped.end()
        await dropCutoverSchema()
      }
    })

    it('validates under a lock that a reader and a writer run straight through', async () => {
      const scoped = await migratedTo015()
      const validator = await scoped.connect()
      const claimant = await scoped.connect()
      try {
        await scoped.query(await sql('016_sponsor_chosen_expiry.sql'))
        await scoped.query(await sql('017_sponsor_close.sql'))

        // A validation in progress: SHARE UPDATE EXCLUSIVE, held open.
        await validator.query('BEGIN')
        await validator.query('ALTER TABLE drops VALIDATE CONSTRAINT drops_expiry_hours_range')

        // `statement_timeout` turns "this blocks" into a readable failure.
        await claimant.query(`SET statement_timeout = '2s'`)
        await expect(claimant.query('SELECT count(*) FROM drops')).resolves.toBeDefined()
        await expect(
          claimant.query(
            `INSERT INTO drops (public_id, sponsor_label, claim_count, amount_each_luna,
               expected_funding_luna, state)
             VALUES ($1, 'Sponsor', 5, 100, 500, 'live')`,
            [randomUUID()],
          ),
        ).resolves.toBeDefined()
        await validator.query('ROLLBACK')

        // The control: the shape 016 and 017 used to have blocks the same read.
        await validator.query('BEGIN')
        await validator.query(
          `ALTER TABLE drops ADD CONSTRAINT drops_scan_control CHECK (claim_count >= 0)`,
        )
        await expect(claimant.query('SELECT count(*) FROM drops')).rejects.toThrow(
          /statement timeout/i,
        )
        await validator.query('ROLLBACK')
      } finally {
        validator.release()
        claimant.release()
        await scoped.end()
        await dropCutoverSchema()
      }
    })
  })

  it('forbids two claims for one wallet in one drop and two claims in one slot', async () => {
    const d = await insertDrop(pool, ok())
    await insertClaim(pool, d.id, 0, 'NQ07 WALLET')
    await expect(insertClaim(pool, d.id, 1, 'NQ07 WALLET')).rejects.toThrow(
      /drop_id.*recipient_address|claims_drop_id_recipient_address_key|duplicate/i,
    )
    await expect(insertClaim(pool, d.id, 0, 'NQ07 OTHER')).rejects.toThrow(
      /drop_id.*slot_index|claims_drop_id_slot_index_key|duplicate/i,
    )
  })
})
