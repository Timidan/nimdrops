import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { testAddress } from './fixtures/address'
import { migrate } from '../src/db/migrate'
import {
  ATTEMPT_WINDOW_MINUTES,
  MAX_ATTEMPTS,
  hashPhrase,
  normalisePhrase,
  parsePassphraseConfig,
  submitPassphrase,
} from '../src/gates/passphrase'
import { GateRejectedError } from '../src/gates/types'
import { listGames, loadGate } from '../src/services/gates'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Private schema, private pool. This suite truncates `drops`, and the
 * `*.race.test.ts` suites vitest may run alongside it truncate it too.
 */
const SCHEMA = 'passphrase_test'

const SALT = 'p'.repeat(32)
const PHRASE = 'red panda'
const HINT = 'said at the 3pm talk'
const W = testAddress('ATTENDEE')

describe('normalisePhrase', () => {
  it('casefolds, trims, and collapses internal whitespace', () => {
    // A noisy venue is the normal case. All three of these are one answer.
    expect(normalisePhrase('  Red   Panda ')).toBe('red panda')
    expect(normalisePhrase('RED PANDA')).toBe('red panda')
    expect(normalisePhrase('red panda')).toBe('red panda')
    expect(normalisePhrase('red\tpanda')).toBe('red panda')
    expect(normalisePhrase('red\n panda')).toBe('red panda')
  })

  it('does not conflate different phrases', () => {
    expect(normalisePhrase('red panda')).not.toBe(normalisePhrase('red pandas'))
    // Internal whitespace collapses; it is not deleted.
    expect(normalisePhrase('red panda')).not.toBe(normalisePhrase('redpanda'))
  })
})

describe('hashPhrase', () => {
  it('is a 64-character hex digest', () => {
    expect(hashPhrase(PHRASE, SALT)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalises before hashing, so spacing and case do not matter', () => {
    expect(hashPhrase('  RED   Panda ', SALT)).toBe(hashPhrase(PHRASE, SALT))
  })

  it('is salted, so the same phrase under a different salt differs', () => {
    expect(hashPhrase(PHRASE, SALT)).not.toBe(hashPhrase(PHRASE, 'q'.repeat(32)))
  })

  it('never contains the phrase', () => {
    expect(hashPhrase(PHRASE, SALT)).not.toContain('red')
    expect(hashPhrase(PHRASE, SALT)).not.toContain('panda')
  })
})

describe('parsePassphraseConfig', () => {
  it('accepts a well-formed config', () => {
    const hash = hashPhrase(PHRASE, SALT)
    expect(parsePassphraseConfig({ hash, hint: HINT })).toEqual({ hash, hint: HINT })
  })

  it('treats a missing hint as empty rather than a failure', () => {
    const hash = hashPhrase(PHRASE, SALT)
    expect(parsePassphraseConfig({ hash })).toEqual({ hash, hint: '' })
  })

  it('refuses a config with no hash, a non-string hash, or a short hash', () => {
    for (const config of [
      {},
      { hash: 42 },
      { hash: null },
      { hash: hashPhrase(PHRASE, SALT).slice(0, 63) },
      { hash: `${hashPhrase(PHRASE, SALT)}0` },
    ]) {
      expect(() => parsePassphraseConfig(config)).toThrow(GateRejectedError)
    }
  })
})

describe.skipIf(!hasDb)('submitPassphrase', () => {
  let pool: pg.Pool
  let publicId: string
  let dropId: string

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** A live, listed drop carrying the given gate. Returns its public id. */
  async function gatedDrop(
    kind: 'passphrase' | 'trivia',
    config: Record<string, unknown>,
  ): Promise<{ publicId: string; dropId: string }> {
    const id = `pp-${Math.random().toString(36).slice(2, 12)}`
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state, expires_at
       ) VALUES ($1, 'meetup', 20, 100000, 2000000, 'live', now() + interval '24 hours')
       RETURNING id`,
      [id],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, listed, config)
       VALUES ($1, $2, true, $3::jsonb)`,
      [rows[0].id, kind, JSON.stringify(config)],
    )
    return { publicId: id, dropId: rows[0].id }
  }

  beforeEach(async () => {
    // passphrase_attempts and gate_grants both reference drop_gates(drop_id).
    await pool.query('DELETE FROM passphrase_attempts')
    await pool.query('DELETE FROM gate_grants')
    await pool.query('DELETE FROM drop_gates')
    await pool.query('DELETE FROM drops')
    const made = await gatedDrop('passphrase', {
      hash: hashPhrase(PHRASE, SALT),
      hint: HINT,
    })
    publicId = made.publicId
    dropId = made.dropId
  })

  const submit = async (phrase: string, wallet = W, id = publicId) =>
    submitPassphrase(pool, {
      gate: await loadGate(pool, id),
      walletAddress: wallet,
      phrase,
      salt: SALT,
    })

  const countGrants = async () =>
    (await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')).rows[0].count

  const countAttempts = async (wallet?: string) =>
    (
      await pool.query<{ count: string }>(
        wallet
          ? 'SELECT count(*) FROM passphrase_attempts WHERE wallet_address = $1'
          : 'SELECT count(*) FROM passphrase_attempts',
        wallet ? [wallet] : [],
      )
    ).rows[0].count

  /**
   * Wrong guesses attributed to a wallet without going through
   * `submitPassphrase` — the rows a previous process would have left behind.
   */
  const seedAttempts = (count: number, wallet: string, minutesAgo = 0) =>
    pool.query(
      `INSERT INTO passphrase_attempts (drop_id, wallet_address, attempted_at)
       SELECT $1, $2, now() - make_interval(mins => $3::int)
       FROM generate_series(1, $4::int)`,
      [dropId, wallet, minutesAgo, count],
    )

  it('grants on the correct phrase', async () => {
    await expect(submit(PHRASE)).resolves.toEqual({ granted: true })
    expect(await countGrants()).toBe('1')
    expect(await countAttempts()).toBe('0')
  })

  it('tolerates case and spacing differences', async () => {
    await expect(submit('  RED   Panda ')).resolves.toEqual({ granted: true })
    expect(await countGrants()).toBe('1')
  })

  it('records the grant against the passphrase kind', async () => {
    await submit(PHRASE)
    const { rows } = await pool.query<{ kind: string; wallet_address: string }>(
      'SELECT kind, wallet_address FROM gate_grants',
    )
    expect(rows[0]).toMatchObject({ kind: 'passphrase', wallet_address: W })
  })

  it('refuses a wrong phrase, grants nothing, and records the attempt', async () => {
    await expect(submit('blue panda')).rejects.toThrow(GateRejectedError)
    await expect(submit('blue panda')).rejects.toMatchObject({ code: 'bad_attempt' })
    expect(await countGrants()).toBe('0')
    expect(await countAttempts(W)).toBe('2')
  })

  it(`refuses after ${MAX_ATTEMPTS} wrong attempts from one address`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await expect(submit('wrong')).rejects.toMatchObject({ code: 'bad_attempt' })
    }
    // Even the right phrase is refused now, and refused for being over budget
    // rather than for being wrong.
    await expect(submit(PHRASE)).rejects.toMatchObject({ code: 'too_many_attempts' })
    expect(await countGrants()).toBe('0')
    // A refused-for-budget call spends nothing further; the counter is not a
    // ratchet that a locked-out wallet keeps pushing.
    expect(await countAttempts(W)).toBe(String(MAX_ATTEMPTS))
  })

  it('counts attempts per address, not globally', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await expect(submit('wrong', testAddress('NOISY'))).rejects.toThrow(GateRejectedError)
    }
    await expect(submit(PHRASE, testAddress('QUIET'))).resolves.toEqual({ granted: true })
  })

  it('does not hand a re-spelled address a fresh budget', async () => {
    // The cap is enforced with `WHERE wallet_address = $1` on a text column, so it
    // is a cap on a WALLET only if one wallet is one string. `NQ07 ABCD…`,
    // `nq07abcd…` and `NQ07ABCD…` are one wallet, and reading them as three turns
    // five guesses into fifteen without ever contending for the lock that makes
    // the count atomic — a way ROUND the concurrency fix rather than through it.
    const compact = W.replace(/\s/g, '')
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await expect(submit('wrong')).rejects.toThrow(/bad_attempt/)
    }
    const spellings = [compact, compact.toLowerCase(), `${compact.slice(0, 4)} ${compact.slice(4)}`]
    for (const spelling of spellings) {
      await expect(submit('wrong', spelling)).rejects.toThrow(/too_many_attempts/)
    }
    // And the five that were spent sit under one spelling rather than spread
    // across four.
    expect(await countAttempts(compact)).toBe(String(MAX_ATTEMPTS))
  })

  it('refuses an address no wallet could hold rather than charging an attempt', async () => {
    // `'NQ07 ATTENDEE'` is what this suite's fixtures used to be. It reads like an
    // address and is not one: six payload characters instead of 32, and check
    // digits that agree with nothing.
    await expect(submit(PHRASE, 'NQ07 ATTENDEE')).rejects.toThrow(/bad_address/)
    await expect(submit(PHRASE, 'hello')).rejects.toThrow(/bad_address/)
    // Nothing charged and nothing granted: there was no wallet to charge.
    expect(await countAttempts()).toBe('0')
    expect(await countGrants()).toBe('0')
  })

  it('counts attempts per drop, so one drop does not lock out another', async () => {
    const other = await gatedDrop('passphrase', {
      hash: hashPhrase(PHRASE, SALT),
      hint: HINT,
    })
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await expect(submit('wrong')).rejects.toThrow(GateRejectedError)
    }
    await expect(submit(PHRASE, W, other.publicId)).resolves.toEqual({ granted: true })
  })

  it('counts from the database, so a restart hands no fresh budget', async () => {
    // Rows only, no in-process state: this is what a brute-forcer would face
    // after the server restarted mid-spree.
    await seedAttempts(MAX_ATTEMPTS, W)
    await expect(submit(PHRASE)).rejects.toMatchObject({ code: 'too_many_attempts' })
    expect(await countGrants()).toBe('0')
  })

  it(`forgets attempts older than ${ATTEMPT_WINDOW_MINUTES} minutes`, async () => {
    await seedAttempts(MAX_ATTEMPTS, W, ATTEMPT_WINDOW_MINUTES + 1)
    await expect(submit(PHRASE)).resolves.toEqual({ granted: true })
  })

  it('still refuses when the attempts sit just inside the window', async () => {
    await seedAttempts(MAX_ATTEMPTS, W, ATTEMPT_WINDOW_MINUTES - 1)
    await expect(submit(PHRASE)).rejects.toMatchObject({ code: 'too_many_attempts' })
  })

  it('is idempotent for a wallet that already holds a grant', async () => {
    await submit(PHRASE)
    await expect(submit(PHRASE)).resolves.toEqual({ granted: true })
    expect(await countGrants()).toBe('1')
  })

  it('spends no attempt for a wallet that already holds a grant', async () => {
    await submit(PHRASE)
    // Tapping twice is not an offence, and neither is a stale page re-posting a
    // phrase this wallet has already been credited for.
    await expect(submit('blue panda')).resolves.toEqual({ granted: true })
    expect(await countAttempts(W)).toBe('0')
    expect(await countGrants()).toBe('1')
  })

  it('does not lock out a granted wallet that guessed wrong on the way in', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await expect(submit('wrong')).rejects.toThrow(GateRejectedError)
    }
    await expect(submit(PHRASE)).resolves.toEqual({ granted: true })
    await seedAttempts(MAX_ATTEMPTS, W)
    await expect(submit(PHRASE)).resolves.toEqual({ granted: true })
  })

  it('refuses when the drop is not live', async () => {
    await pool.query(`UPDATE drops SET state = 'closing' WHERE public_id = $1`, [publicId])
    await expect(submit(PHRASE)).rejects.toMatchObject({ code: 'game_not_live' })
    expect(await countGrants()).toBe('0')
    expect(await countAttempts()).toBe('0')
  })

  it('refuses a phrase posted to a drop of another kind', async () => {
    const quiz = await gatedDrop('trivia', { tier: 'easy' })
    await expect(submit(PHRASE, W, quiz.publicId)).rejects.toMatchObject({
      code: 'wrong_kind',
    })
    expect(await countGrants()).toBe('0')
  })

  it('refuses a misconfigured gate without granting', async () => {
    const broken = await gatedDrop('passphrase', { hint: HINT })
    await expect(submit(PHRASE, W, broken.publicId)).rejects.toThrow(GateRejectedError)
    expect(await countGrants()).toBe('0')
  })

  it('refuses a same-length non-hex hash as a misconfiguration, not a wrong guess', async () => {
    // Comparison is over hex-decoded buffers, so a well-shaped but undecodable
    // hash must never reach `timingSafeEqual`. It is also not the player's
    // fault: `bad_attempt` here would tell someone who typed the CORRECT phrase
    // that they got it wrong, which is why this is `misconfigured` and why the
    // HTTP layer answers 5xx for it.
    const junk = await gatedDrop('passphrase', { hash: 'z'.repeat(64), hint: HINT })
    await expect(submit(PHRASE, W, junk.publicId)).rejects.toMatchObject({
      code: 'misconfigured',
    })
    expect(await countGrants()).toBe('0')
  })

  it('does not spend an attempt on a misconfigured gate', async () => {
    // The counter is for brute-forcers. A player defeated by the operator's typo
    // must not also lose one of their five tries.
    const junk = await gatedDrop('passphrase', { hash: 'z'.repeat(64), hint: HINT })
    await expect(submit(PHRASE, W, junk.publicId)).rejects.toThrow(GateRejectedError)
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM passphrase_attempts',
    )
    expect(rows[0].count).toBe('0')
  })

  describe('secrecy', () => {
    it('never stores the phrase', async () => {
      await submit(PHRASE)
      const { rows } = await pool.query<{ config: string }>(
        'SELECT config::text AS config FROM drop_gates',
      )
      for (const row of rows) {
        expect(row.config.toLowerCase()).not.toContain('red')
        expect(row.config.toLowerCase()).not.toContain('panda')
      }
    })

    it('keeps the phrase and its hash out of listGames', async () => {
      const games = await listGames(pool)
      expect(games.map((g) => g.publicId)).toContain(publicId)
      const serialised = JSON.stringify(games)
      expect(serialised).not.toContain(PHRASE)
      expect(serialised).not.toContain(hashPhrase(PHRASE, SALT))
      expect(serialised).not.toContain('hash')
      // The public hint is the whole of what a stranger gets to see.
      expect(games.find((g) => g.publicId === publicId)?.hint).toBe(HINT)
    })

    it('keeps the phrase out of loadGate, and the hash inside config only', async () => {
      const gate = await loadGate(pool, publicId)
      expect(JSON.stringify(gate)).not.toContain(PHRASE)
      // The hash IS returned, under `config`, because this kind's comparison
      // needs it: `loadGate` is a server-internal read, and the HTTP boundary is
      // what must not serialise `config` wholesale. Asserted narrowly so that
      // the hash appearing anywhere else has to be a deliberate change.
      const { config, ...rest } = gate
      expect(JSON.stringify(rest)).not.toContain(hashPhrase(PHRASE, SALT))
      expect(config).toEqual({ hash: hashPhrase(PHRASE, SALT), hint: HINT })
    })
  })
})
