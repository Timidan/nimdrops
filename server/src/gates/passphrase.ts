/**
 * Kind `passphrase`: the sponsor says a word, and whoever heard it can claim
 * (spec §4.7).
 *
 * Proof of presence, not proof of knowledge — the sponsor already controls who
 * hears it. This is what a meetup host, a lecturer or a community call actually
 * wants, and it needs no question bank, no timer and no scoring, which is why it
 * is the kind that proves the whole seam end to end.
 *
 * NOT secret: one attendee can post the phrase publicly. The mitigations are the
 * drop's fixed slot count, its 24-hour expiry, and the sponsor's choice of when
 * to say it. Sponsor-facing copy must say so.
 *
 * Imports run one way — `types.ts` and `grants.ts` only, never `services/`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { issueGrant } from './grants'
import { type GateRow, GateRejectedError, assertGameLive } from './types'

/** Wrong guesses allowed per address per drop before an hour's refusal. */
export const MAX_ATTEMPTS = 5
export const ATTEMPT_WINDOW_MINUTES = 60

export interface PassphraseConfig {
  /** Salted HMAC-SHA256 of the normalised phrase, hex. Never the phrase. */
  hash: string
  /** Short public hint, e.g. "said at the 3pm talk". Safe to list. */
  hint: string
}

/**
 * Trim, collapse internal whitespace, casefold.
 *
 * A noisy venue is the normal case: "Red Panda", "red  panda" and "RED PANDA"
 * are the same answer, and a transcription difference must not cost somebody
 * their share. Whitespace collapses to a single space rather than being deleted,
 * so "red panda" and "redpanda" stay different phrases.
 */
export function normalisePhrase(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/**
 * The digest stored in `drop_gates.config`.
 *
 * Keyed rather than plain: a bare SHA-256 of a short human phrase is a dictionary
 * lookup away from the phrase, and the config row is readable by anyone who can
 * read the database. The salt is server-side and lives outside the row.
 */
export function hashPhrase(phrase: string, salt: string): string {
  return createHmac('sha256', salt).update(normalisePhrase(phrase)).digest('hex')
}

export function parsePassphraseConfig(config: Record<string, unknown>): PassphraseConfig {
  const { hash, hint } = config
  if (typeof hash !== 'string' || hash.length !== 64) {
    throw new GateRejectedError('bad_attempt', 'this drop is misconfigured')
  }
  return { hash, hint: typeof hint === 'string' ? hint : '' }
}

/**
 * Constant-time digest comparison.
 *
 * `timingSafeEqual` throws on differing lengths, which would both crash and leak
 * the one bit it exists to hide, so the length check is explicit and comes first.
 * A same-length but undecodable hex hash decodes to a shorter buffer and so comes
 * out as a plain mismatch rather than an unhandled error.
 */
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function submitPassphrase(
  pool: Pool,
  o: { gate: GateRow; walletAddress: string; phrase: string; salt: string },
): Promise<{ granted: true }> {
  if (o.gate.kind !== 'passphrase') {
    throw new GateRejectedError('wrong_kind', 'this drop does not use a passphrase')
  }
  assertGameLive(o.gate)

  const config = parsePassphraseConfig(o.gate.config)

  // Already granted: return success rather than spending an attempt. A player
  // who taps twice, or whose page re-posts, has done nothing wrong — and this
  // check sits ahead of the cap so earlier wrong guesses cannot lock a wallet
  // out of an answer it has already been credited for.
  const { rows: held } = await pool.query<{ id: string }>(
    'SELECT id FROM gate_grants WHERE drop_id = $1 AND wallet_address = $2',
    [o.gate.dropId, o.walletAddress],
  )
  if (held[0]) return { granted: true }

  // Counted per address per drop, and counted in the database: the cap is about
  // an address, so a restart must not hand a brute-forcer a fresh five. Per-IP
  // limiting is the caller's job; this is the durable half.
  const { rows: recent } = await pool.query<{ attempts: number }>(
    `SELECT count(*)::int AS attempts
     FROM passphrase_attempts
     WHERE drop_id = $1 AND wallet_address = $2
       AND attempted_at > now() - make_interval(mins => $3::int)`,
    [o.gate.dropId, o.walletAddress, ATTEMPT_WINDOW_MINUTES],
  )
  if (recent[0].attempts >= MAX_ATTEMPTS) {
    throw new GateRejectedError(
      'too_many_attempts',
      `more than ${MAX_ATTEMPTS} tries in ${ATTEMPT_WINDOW_MINUTES} minutes`,
    )
  }

  if (!matches(hashPhrase(o.phrase, o.salt), config.hash)) {
    await pool.query(
      'INSERT INTO passphrase_attempts (drop_id, wallet_address) VALUES ($1, $2)',
      [o.gate.dropId, o.walletAddress],
    )
    throw new GateRejectedError('bad_attempt', 'that is not the phrase')
  }

  await issueGrant(pool, {
    dropId: o.gate.dropId,
    walletAddress: o.walletAddress,
    kind: 'passphrase',
  })
  return { granted: true }
}
