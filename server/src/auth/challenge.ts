import { createHash, randomBytes } from 'node:crypto'

/**
 * What a signature over a challenge is allowed to do.
 *
 * The action is INSIDE the signed bytes, which is what makes a signature
 * harvested for one action useless for the other. A claimant's wallet approves
 * `"action":"claim"` and nothing else; a sponsor closing their drop approves
 * `"action":"close"` and nothing else. Both verifiers re-canonicalize the stored
 * message and refuse an action that is not theirs, and migration 017 records the
 * action on the row so the single UPDATE that consumes the nonce can filter on
 * it too — two independent enforcements of one binding, because the close path
 * moves the unclaimed remainder of a drop back to its funder.
 *
 * Adding a third action means adding it here, in `assertSignable`, in the
 * `wallet_challenges_action_allowed` CHECK, and in a verifier that names it.
 * There is deliberately no wildcard.
 */
export type ChallengeAction = 'claim' | 'close'

/**
 * Short-lived, single-use wallet challenge (design §8.1). The wallet signs the
 * canonical serialization of exactly this object; the server derives the acting
 * address from the verified public key, so the request never carries an
 * independently trusted address of its own.
 */
export interface Challenge {
  /** Message format version. Bump only with a matching verifier change. */
  v: 1
  /** Application origin the challenge is bound to (audience). */
  aud: string
  /** Nimiq network name, e.g. `TestAlbatross` / `MainAlbatross`. */
  net: string
  /** The only action this signature authorizes. */
  action: ChallengeAction
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
 * The audience every challenge is bound to, from `PUBLIC_ORIGIN`.
 *
 * One reader for every path that mints or verifies a challenge, so a claim and a
 * sponsor's close can never disagree about which origin a signature was for.
 * Unset fails closed: a challenge with no audience is a challenge that could be
 * replayed against another deployment.
 */
export function requireAudience(): string {
  const origin = process.env.PUBLIC_ORIGIN
  if (!origin) throw new ChallengeError('PUBLIC_ORIGIN is not set')
  return origin
}

/**
 * What the database stores in place of the nonce.
 *
 * The plaintext nonce lives only inside `canonical_message`, which is what the
 * wallet signed; the indexed, uniqueness-enforcing column holds this digest, so
 * a read of the table cannot forge a challenge. Shared by every path that mints
 * one, because a second hashing rule would silently break the uniqueness the
 * column exists to provide.
 */
export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

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

/**
 * Mints a fresh challenge for one drop and one action, expiring
 * `CHALLENGE_TTL_SECONDS` from now.
 *
 * `action` is required rather than defaulted. A default would mean a caller that
 * forgot the parameter still gets a valid, signable challenge — for the wrong
 * action, silently. On the path where one of the actions returns a drop's
 * remaining principal to its funder, forgetting must be a type error.
 */
export function issueChallenge(o: {
  origin: string
  network: string
  dropPublicId: string
  action: ChallengeAction
}): Challenge {
  const iat = nowSeconds()
  return {
    v: 1,
    aud: o.origin,
    net: o.network,
    action: o.action,
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
  if (c.action !== 'claim' && c.action !== 'close')
    throw new ChallengeError(`unsupported challenge action: ${String(c.action)}`)
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp))
    throw new ChallengeError('challenge timestamps must be integer Unix seconds')
  if (c.exp <= c.iat) throw new ChallengeError('challenge expiry must follow issuance')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
