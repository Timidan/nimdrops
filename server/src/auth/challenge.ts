import { randomBytes } from 'node:crypto'

/**
 * Short-lived, single-use claim challenge (design §8.1). The wallet signs the
 * canonical serialization of exactly this object; the server derives the payout
 * address from the verified public key, so the claim request never carries an
 * independently trusted recipient.
 */
export interface Challenge {
  /** Message format version. Bump only with a matching verifier change. */
  v: 1
  /** Application origin the challenge is bound to (audience). */
  aud: string
  /** Nimiq network name, e.g. `TestAlbatross` / `MainAlbatross`. */
  net: string
  /** The only action this signature authorizes. */
  action: 'claim'
  /** Drop public ID the challenge is bound to. */
  drop: string
  /** Cryptographically random, base64url-encoded nonce. */
  nonce: string
  /** Issued-at, Unix seconds. */
  iat: number
  /** Expiry, Unix seconds (exclusive: `now >= exp` is expired). */
  exp: number
}

/** Challenges live 5 minutes — long enough to approve in-wallet, short enough to bound replay. */
export const CHALLENGE_TTL_SECONDS = 300

/** Tolerance for a client/server clock skew when checking `iat`. */
export const CHALLENGE_CLOCK_SKEW_SECONDS = 60

/** 16 random bytes = 128 bits, base64url-encoded to 22 chars. */
const NONCE_BYTES = 16

export class ChallengeError extends Error {}
export class ChallengeExpiredError extends ChallengeError {}

/**
 * Canonical JSON for a challenge: keys in fixed ASCII-sorted order, no whitespace.
 * The literal object below IS the key order, so the caller's property insertion
 * order can never change a byte of the signed message.
 */
export function buildChallengeMessage(c: Challenge): string {
  assertSignable(c)
  return JSON.stringify({
    action: c.action,
    aud: c.aud,
    drop: c.drop,
    exp: c.exp,
    iat: c.iat,
    net: c.net,
    nonce: c.nonce,
    v: c.v,
  })
}

/** Mints a fresh challenge for one drop, expiring `CHALLENGE_TTL_SECONDS` from now. */
export function issueChallenge(o: {
  origin: string
  network: string
  dropPublicId: string
}): Challenge {
  const iat = nowSeconds()
  return {
    v: 1,
    aud: o.origin,
    net: o.network,
    action: 'claim',
    drop: o.dropPublicId,
    nonce: randomBytes(NONCE_BYTES).toString('base64url'),
    iat,
    exp: iat + CHALLENGE_TTL_SECONDS,
  }
}

/**
 * Throws unless `now` (Unix seconds) is inside the challenge window.
 * Freshness only — the caller still atomically consumes the stored challenge row
 * and matches its recorded message (design §8.2 step 4).
 */
export function assertChallengeFresh(c: Challenge, now: number = nowSeconds()): void {
  assertSignable(c)
  if (!Number.isFinite(now)) throw new ChallengeError('invalid current time')
  if (now >= c.exp) throw new ChallengeExpiredError('challenge expired')
  if (c.iat - now > CHALLENGE_CLOCK_SKEW_SECONDS)
    throw new ChallengeError('challenge issued in the future')
}

function assertSignable(c: Challenge): void {
  if (c.v !== 1) throw new ChallengeError(`unsupported challenge version: ${String(c.v)}`)
  if (c.action !== 'claim') throw new ChallengeError(`unsupported challenge action: ${String(c.action)}`)
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp))
    throw new ChallengeError('challenge timestamps must be integer Unix seconds')
  if (c.exp <= c.iat) throw new ChallengeError('challenge expiry must follow issuance')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
