import type { QueryResult, QueryResultRow } from 'pg'
import { hashIdemKey } from '../ids'

/**
 * HTTP idempotency records (design §11).
 *
 * Deliberately framework-free: these helpers take any `Queryable`, so a service
 * can bind the record inside the SAME transaction as the resource mutation —
 * which is the whole point. Task 13 wires the Hono layer to them; nothing here
 * knows about requests, headers, or responses.
 *
 * The record is a retry convenience, never a financial invariant. One payout per
 * claim and one refund per drop are enforced by the partial unique indexes in
 * `001_core.sql`; an arbitrary caller-supplied key can never substitute for them.
 */

/** How long a stored idempotency record answers replays. */
export const IDEM_TTL_HOURS = 24

/** Same key, different request body: the caller reused a key for new work. */
export class ConflictError extends Error {
  constructor(message = 'idempotency key was already used for a different request') {
    super(message)
  }
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

export interface IdemRecord {
  scope: string
  keyHash: string
  requestHash: string
  resourceType: string
  resourceId: string | null
  responseStatus: number
}

interface IdemRow {
  scope: string
  key_hash: string
  request_hash: string
  resource_type: string
  resource_id: string | null
  response_status: number
}

function toRecord(row: IdemRow): IdemRecord {
  return {
    scope: row.scope,
    keyHash: row.key_hash,
    requestHash: row.request_hash,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    responseStatus: row.response_status,
  }
}

/**
 * Storage key for one caller-supplied idempotency key within one route/action.
 * `hashIdemKey` length-prefixes the scope, so no scope/key boundary shift can
 * make two different (scope, key) pairs collide.
 */
export function idemKeyHash(scope: string, key: string): string {
  return hashIdemKey(scope, key)
}

/**
 * Read a stored record. Expired rows are treated as absent so a long-dead key
 * can be reused rather than conflicting forever.
 */
export async function lookupIdem(
  db: Queryable,
  scope: string,
  keyHash: string,
): Promise<IdemRecord | null> {
  const { rows } = await db.query<IdemRow>(
    `SELECT scope, key_hash, request_hash, resource_type, resource_id, response_status
     FROM http_idempotency
     WHERE scope = $1 AND key_hash = $2 AND expires_at > now()`,
    [scope, keyHash],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

/**
 * Bind a key to a resource, or confirm it is already bound to the same request.
 *
 * Race-safe by construction: the INSERT either wins or loses to a concurrent
 * writer, and the loser re-reads what actually landed rather than trusting its
 * own earlier read. Returns `created: false` when the row already existed.
 *
 * Throws {@link ConflictError} when the stored request hash differs — same key,
 * different work, which must never silently return someone else's resource.
 */
export async function bindIdem(
  db: Queryable,
  record: IdemRecord,
): Promise<{ created: boolean; record: IdemRecord }> {
  const { rows } = await db.query<IdemRow>(
    `INSERT INTO http_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id, response_status, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
     ON CONFLICT (scope, key_hash) DO NOTHING
     RETURNING scope, key_hash, request_hash, resource_type, resource_id, response_status`,
    [
      record.scope,
      record.keyHash,
      record.requestHash,
      record.resourceType,
      record.resourceId,
      record.responseStatus,
      IDEM_TTL_HOURS,
    ],
  )
  if (rows[0]) return { created: true, record: toRecord(rows[0]) }

  const existing = await lookupIdem(db, record.scope, record.keyHash)
  if (!existing) {
    // The row exists but is expired: it belongs to a past request that can no
    // longer be replayed, so take it over.
    const { rows: replaced } = await db.query<IdemRow>(
      `UPDATE http_idempotency
       SET request_hash = $3, resource_type = $4, resource_id = $5, response_status = $6,
           created_at = now(), expires_at = now() + make_interval(hours => $7)
       WHERE scope = $1 AND key_hash = $2
       RETURNING scope, key_hash, request_hash, resource_type, resource_id, response_status`,
      [
        record.scope,
        record.keyHash,
        record.requestHash,
        record.resourceType,
        record.resourceId,
        record.responseStatus,
        IDEM_TTL_HOURS,
      ],
    )
    return { created: true, record: toRecord(replaced[0]) }
  }

  if (existing.requestHash !== record.requestHash) throw new ConflictError()
  return { created: false, record: existing }
}
