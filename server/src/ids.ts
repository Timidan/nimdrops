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

/** 22 base64url characters = 132 bits, the same width as a drop's public id. */
const MEMO_TAG_CHARS = 22

/**
 * The on-chain half of an outgoing transfer's memo. Must be unique per
 * transfer: a Nimiq basic transaction has no account nonce, so two payouts of
 * the same amount to the same address in the same block window collide into one
 * transaction unless their data differs.
 *
 * KEYED, not hashed, and that is the whole point. The memo sits on the chain
 * beside the recipient and the amount, while the transfer id travels in logs
 * and alert payloads — so a tag anyone holding the id could compute (the id
 * itself, or `sha256` of it) is a join key from an internal id to a claimant's
 * address. Only the operator, who has `STATUS_TOKEN_SECRET`, can go from one to
 * the other. Domain-separated so it can never collide with {@link statusToken},
 * which HMACs a bare claim id under the same key.
 */
export function transferMemoTag(transferId: string): string {
  return createHmac('sha256', requireSecret())
    .update(`nimdrop-memo:v1:${transferId}`, 'utf8')
    .digest('base64url')
    .slice(0, MEMO_TAG_CHARS)
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
