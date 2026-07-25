import pg from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Anything that can run a query: a `Pool` (autocommit, read-only callers) or a
 * `PoolClient` inside an explicit transaction (every write path).
 *
 * Defined once, here, so a helper can accept either without every module
 * re-declaring its own structurally-identical copy.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

// Money safety: keep BIGINT (oid 20) as a string so luna values never pass
// through a lossy JS number on the way out of the database. Callers convert
// with BigInt(...) explicitly.
pg.types.setTypeParser(20, (value: string) => value)

let pool: pg.Pool | null = null

function isUsable(p: pg.Pool | null): p is pg.Pool {
  return p !== null && (p as unknown as { ended?: boolean }).ended !== true
}

/** Process-wide connection pool built from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (isUsable(pool)) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  pool = new pg.Pool({ connectionString })
  return pool
}

export async function closePool(): Promise<void> {
  if (isUsable(pool)) await pool.end()
  pool = null
}
