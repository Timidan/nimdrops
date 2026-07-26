// CLI entry for applying migrations. Used by deploys and the operator runbook:
//   docker compose run --rm --entrypoint sh server -c "cd /app/server && pnpm tsx src/db/migrate-cli.ts"
// migrate() is idempotent (tracked in schema_migrations) and takes an advisory lock,
// so concurrent invocations are safe.
import { getPool } from './pool.js'
import { migrate } from './migrate.js'

const pool = getPool()
try {
  await migrate(pool)
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = current_schema() order by table_name`,
  )
  console.log(`migrations applied; tables: ${rows.map((r) => r.table_name).join(', ')}`)
} finally {
  await pool.end()
}
