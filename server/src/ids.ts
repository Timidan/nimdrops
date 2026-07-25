import { createHash, createHmac, randomBytes } from 'node:crypto'

/** 16 random bytes = 128 bits of entropy, base64url-encoded to exactly 22 chars. */
const PUBLIC_ID_BYTES = 16

/**
 * Public, shareable identifier for a drop. 22 URL-safe characters carrying
 * 128 bits of entropy, so campaign links are unguessable and never enumerable.
 */
export function newPublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url')
}

/**
 * Bearer token a claimant uses to poll their own claim status.
 * Derived (not stored) as HMAC-SHA256(STATUS_TOKEN_SECRET, claimId) so the same
 * claim always yields the same token and the DB only ever stores `hashToken()`.
 */
export function statusToken(claimId: string): string {
  return createHmac('sha256', requireSecret()).update(claimId, 'utf8').digest('base64url')
}

/** What the DB stores for a bearer token: sha256 hex. Never reversible to the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Storage key for an HTTP idempotency record. The scope byte-length prefix keeps
 * the (scope, key) pair unambiguous, so no scope/key boundary shift can collide.
 */
export function hashIdemKey(scope: string, key: string): string {
  const scopeBytes = Buffer.byteLength(scope, 'utf8')
  return createHash('sha256').update(`${scopeBytes}:${scope}:${key}`, 'utf8').digest('hex')
}

function requireSecret(): string {
  const secret = process.env.STATUS_TOKEN_SECRET
  if (!secret) throw new Error('STATUS_TOKEN_SECRET is not set')
  return secret
}
