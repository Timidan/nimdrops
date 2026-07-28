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
import { type GateRow, GateRejectedError, assertGameLive, requireGateWallet } from './types'

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
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
    // `misconfigured`, not `bad_attempt`. This reported an operator's broken
    // config under the code meaning "you guessed wrong", which told the player
    // they had made a mistake they had not made. The shape check is also
    // tightened from a length check to hex, so a 64-character non-hash cannot
    // reach `timingSafeEqual` and be rejected there for the wrong reason.
    throw new GateRejectedError('misconfigured', 'passphrase gate is misconfigured')
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

  // Canonicalised once, here, and used for every lock, count, insert and grant
  // below. The cap is five attempts per wallet per hour, and it is only a cap on
  // a WALLET if one wallet is one string — otherwise a caller re-spells its own
  // address and buys another five guesses without touching the lock the fix in
  // this file installed.
  const walletAddress = requireGateWallet(o.walletAddress)

  // Already granted: return success rather than spending an attempt. A player
  // who taps twice, or whose page re-posts, has done nothing wrong — and this
  // check sits ahead of the cap so earlier wrong guesses cannot lock a wallet
  // out of an answer it has already been credited for.
  const { rows: held } = await pool.query<{ id: string }>(
    'SELECT id FROM gate_grants WHERE drop_id = $1 AND wallet_address = $2',
    [o.gate.dropId, walletAddress],
  )
  if (held[0]) return { granted: true }

  // Counting and charging happen in ONE transaction, serialised per address.
  //
  // This was `SELECT count(*)` followed later by an independent `INSERT`, and the
  // gap was exploitable: five concurrent requests all read four attempts, all
  // passed the cap, and all five guesses were evaluated — nine recorded attempts
  // against a budget of five. The per-IP bucket bounded a single-IP burst to four
  // extra guesses, and bounded a distributed one not at all, because every
  // request can assert the same wallet address from a different address of its
  // own.
  //
  // The advisory lock is on `(drop, wallet)` rather than a row, because on the
  // first attempt there is no row to lock. It is transaction-scoped, so it is
  // released by COMMIT or ROLLBACK and never leaks on a throw.
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `passphrase:${o.gate.dropId}:${walletAddress}`,
    ])

    const { rows: recent } = await client.query<{ attempts: number }>(
      `SELECT count(*)::int AS attempts
       FROM passphrase_attempts
       WHERE drop_id = $1 AND wallet_address = $2
         AND attempted_at > now() - make_interval(mins => $3::int)`,
      [o.gate.dropId, walletAddress, ATTEMPT_WINDOW_MINUTES],
    )
    if (recent[0].attempts >= MAX_ATTEMPTS) {
      await client.query('COMMIT')
      committed = true
      throw new GateRejectedError(
        'too_many_attempts',
        `more than ${MAX_ATTEMPTS} tries in ${ATTEMPT_WINDOW_MINUTES} minutes`,
      )
    }

    if (!matches(hashPhrase(o.phrase, o.salt), config.hash)) {
      // Charged inside the lock, so the next concurrent caller reads this attempt
      // rather than the count that let this one through.
      await client.query(
        'INSERT INTO passphrase_attempts (drop_id, wallet_address) VALUES ($1, $2)',
        [o.gate.dropId, walletAddress],
      )
      await client.query('COMMIT')
      committed = true
      throw new GateRejectedError('bad_attempt', 'that is not the phrase')
    }

    await issueGrant(client, {
      dropId: o.gate.dropId,
      walletAddress,
      kind: 'passphrase',
    })
    await client.query('COMMIT')
    committed = true
    return { granted: true }
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
