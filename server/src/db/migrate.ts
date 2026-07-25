import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

// Distinct from the transfer worker's advisory lock (42): this one only
// serializes concurrent migrate() callers (e.g. parallel *.race.test.ts files).
const MIGRATION_LOCK_ID = 1001

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

/**
 * Apply every unapplied `migrations/*.sql` in filename order. Each file runs in
 * its own transaction together with its `schema_migrations` bookkeeping row, so
 * a crash mid-migration leaves the database on a clean earlier version.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const applied = new Set(rows.map((r) => r.name))

    for (const name of await listMigrations()) {
      if (applied.has(name)) continue
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err })
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {})
    client.release()
  }
}
