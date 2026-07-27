import { KeyPair } from '@nimiq/core'
import type { Hono } from 'hono'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { hashPhrase } from '../src/gates/passphrase'
import { type Bank, parseBank } from '../src/gates/trivia/bank'
import { makeTrivia } from '../src/gates/trivia/sessions'
import { makeApp } from '../src/http/app'
import { consoleAlerts } from '../src/services/alerts'
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

const SCHEMA = 'gates_api_test'
const ORIGIN = 'https://nimdrops.test'
const CUSTODY = 'NQ07 CUSTODY'
const SALT = 'q'.repeat(32)
const PHRASE = 'red panda'
const HINT = 'said at the 3pm talk'
/**
 * A checksum-valid address. It used to be `NQ07 0000 … 0000 00`, which was 34
 * payload-and-prefix characters and a checksum that did not add up — the old
 * shape-only `ADDRESS_RE` did not care about either. Extending it to a full 32
 * character payload of zeros makes `07` the CORRECT check digits, so this stays
 * the same readable fixture and is now an address a wallet could really hold.
 */
const PLAYER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
/** A second real wallet, for proving one player's session id is useless to another. */
const STRANGER = 'NQ54 RNSR 6MFK P8LK JVYU 152Y P1FH 30HD 84N4'
/**
 * `PLAYER` with its check digits bumped by one: 36 characters, every one of them
 * from Nimiq's alphabet, and arithmetically impossible. This is exactly the input
 * the old regex waved through, and every grant written for it was unclaimable.
 */
const BAD_CHECKSUM = 'NQ08 0000 0000 0000 0000 0000 0000 0000 0000'

function testBank(): Bank {
  const categories = ['geography', 'science', 'history', 'sport', 'music', 'film']
  return parseBank({
    version: 'v1',
    questions: categories.flatMap((category) =>
      [0, 1].map((n) => ({
        id: `${category}-${n}`,
        tier: 'novice',
        category,
        prompt: `${category} ${n}?`,
        options: ['a', 'b', 'c', 'd'],
        answerIndex: n,
        source: 'https://example.org',
      })),
    ),
  })
}

describe.skipIf(!hasDb)('gate HTTP surface', () => {
  let pool: pg.Pool
  let app: Hono
  let bare: Hono
  let clock: number

  const saved = {
    network: process.env.NIMIQ_NETWORK,
    origin: process.env.PUBLIC_ORIGIN,
    scheme: process.env.SIG_SCHEME,
    secret: process.env.STATUS_TOKEN_SECRET,
    custody: process.env.CUSTODY_ADDRESS,
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    for (const [key, value] of [
      ['NIMIQ_NETWORK', saved.network],
      ['PUBLIC_ORIGIN', saved.origin],
      ['SIG_SCHEME', saved.scheme],
      ['STATUS_TOKEN_SECRET', saved.secret],
      ['CUSTODY_ADDRESS', saved.custody],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  beforeEach(async () => {
    clock = 1_800_000_000_000
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'gates-api-secret'
    process.env.CUSTODY_ADDRESS = CUSTODY

    await pool.query(
      `TRUNCATE gate_grants, trivia_answers, trivia_sessions, passphrase_attempts,
       attestation_nonces, drop_gates, transaction_attempts, outgoing_transfers,
       wallet_challenges, claims, drops, operator_float_deposits,
       custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )

    const chain = new FakeChain({ custody: CUSTODY, finalityDepth: 5, headHeight: 100 })
    const deps = {
      pool,
      chain,
      alerts: consoleAlerts(),
      now: () => clock,
      // One shared bucket would let the earlier cases in a file spend the later
      // ones' budget; a per-test app keeps each case's limiter fresh.
      clientIp: () => 'test-ip',
    }
    app = makeApp({
      ...deps,
      gates: {
        trivia: makeTrivia({ pool, bank: testBank(), salt: SALT }),
        passphraseSalt: SALT,
      },
    })
    bare = makeApp(deps)
  })

  /** A live drop, gated when asked. Bypasses funding: this suite tests HTTP. */
  async function game(o: {
    kind?: 'trivia' | 'passphrase' | 'attested'
    listed?: boolean
    config?: Record<string, unknown>
    gated?: boolean
  } = {}): Promise<string> {
    const publicId = Array.from({ length: 22 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + Math.floor(Math.random() * 36)) % 36]).join('')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state, expires_at
       ) VALUES ($1, 'quiz night', 20, 100000, 2000000, 'live', now() + interval '24 hours')
       RETURNING id`,
      [publicId],
    )
    if (o.gated === false) return publicId
    const kind = o.kind ?? 'trivia'
    const config =
      o.config ??
      (kind === 'trivia'
        ? { tier: 'novice', bankVersion: 'v1', questionCount: 5, secondsPerQuestion: 15 }
        : kind === 'passphrase'
          ? { hash: hashPhrase(PHRASE, SALT), hint: HINT }
          : { attesterPublicKey: KeyPair.generate().publicKey.toHex(), maxAgeSeconds: 300 })
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, listed, config) VALUES ($1, $2, $3, $4::jsonb)`,
      [rows[0].id, kind, o.listed ?? false, JSON.stringify(config)],
    )
    return publicId
  }

  const post = (path: string, body: unknown, target: Hono = app) =>
    target.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const get = (path: string, target: Hono = app) => target.request(path)

  const json = async (res: Response) => (await res.json()) as Record<string, unknown>

  async function startSession(publicId: string): Promise<string> {
    const res = await post(`/api/games/${publicId}/session`, { walletAddress: PLAYER })
    // Read the body ONCE. `expect(res.status, await res.text())` evaluates the
    // message eagerly and leaves the stream consumed, so the parse after it fails
    // with "Body has already been read" and hides the real status.
    const text = await res.text()
    expect(res.status, text).toBe(200)
    return (JSON.parse(text) as { sessionId: string }).sessionId
  }

  /**
   * The session routes take the wallet as well as the session id, so a leaked id
   * on its own drives nothing. Both helpers default to `PLAYER`; the tests about
   * the check pass someone else's address explicitly.
   */
  const question = (publicId: string, sessionId: string, wallet: string = PLAYER) =>
    get(
      `/api/games/${publicId}/session/${sessionId}/question?wallet=${encodeURIComponent(wallet)}`,
    )

  const answer = (
    publicId: string,
    sessionId: string,
    body: Record<string, unknown>,
    wallet: string = PLAYER,
  ) =>
    post(`/api/games/${publicId}/session/${sessionId}/answer`, {
      ...body,
      walletAddress: wallet,
    })

  // ---- the catalogue --------------------------------------------------------

  it('lists a listed game and omits an unlisted one', async () => {
    const listed = await game({ listed: true })
    const hidden = await game({ listed: false })
    const body = (await json(await get('/api/games'))) as { games: { publicId: string }[] }
    const ids = body.games.map((g) => g.publicId)
    expect(ids).toContain(listed)
    expect(ids).not.toContain(hidden)
  })

  it('returns exactly the listed-game fields, and no address anywhere', async () => {
    await game({ listed: true })
    const body = await json(await get('/api/games'))
    const games = body.games as Record<string, unknown>[]
    expect(Object.keys(games[0]).sort()).toEqual([
      'amountEachLuna',
      'expiresAt',
      'hint',
      'kind',
      'publicId',
      'slotsRemaining',
      'tier',
      'unlockRequiresTier',
    ])
    expect(JSON.stringify(body)).not.toContain('NQ')
  })

  it('answers the catalogue even with no gates configured', async () => {
    await game({ listed: true })
    expect(await json(await get('/api/games', bare))).toEqual({ games: [] })
  })

  it('reports one game in luna, matching the catalogue’s units', async () => {
    const publicId = await game({ listed: true })
    const single = await json(await get(`/api/games/${publicId}`))
    const list = (await json(await get('/api/games'))) as {
      games: { publicId: string; amountEachLuna: string }[]
    }
    const listed = list.games.find((g) => g.publicId === publicId)
    expect(single.amountEachLuna).toBe(listed?.amountEachLuna)
    expect(single.amountEachLuna).toBe('100000')
  })

  it('never returns the raw gate config', async () => {
    const publicId = await game({ kind: 'passphrase' })
    const body = await json(await get(`/api/games/${publicId}`))
    expect(Object.keys(body)).not.toContain('config')
    expect(JSON.stringify(body)).not.toContain(hashPhrase(PHRASE, SALT))
    // The hint is public on purpose; the hash is not.
    expect(body.hint).toBe(HINT)
  })

  it('404s a drop that carries no condition', async () => {
    const plain = await game({ gated: false })
    expect((await get(`/api/games/${plain}`)).status).toBe(404)
    expect((await post(`/api/games/${plain}/session`, { walletAddress: PLAYER })).status).toBe(404)
  })

  // ---- request validation ---------------------------------------------------

  it('rejects a malformed wallet address', async () => {
    const publicId = await game()
    expect((await post(`/api/games/${publicId}/session`, { walletAddress: 'nope' })).status).toBe(400)
  })

  it('rejects an unexpected body field', async () => {
    const publicId = await game()
    const res = await post(`/api/games/${publicId}/session`, {
      walletAddress: PLAYER,
      tier: 'hard',
    })
    expect(res.status).toBe(400)
  })

  it('rejects an answer index outside the four options', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    await question(publicId, sessionId)
    const res = await answer(publicId, sessionId, {
      questionIndex: 0,
      answerIndex: 9,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a numeric string where a number is required', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    await question(publicId, sessionId)
    const res = await answer(publicId, sessionId, {
      questionIndex: 0,
      answerIndex: '1',
    })
    expect(res.status).toBe(400)
  })

  it('404s a malformed session id rather than describing its shape', async () => {
    const publicId = await game()
    expect((await question(publicId, 'not-a-uuid')).status).toBe(404)
  })

  // ---- the address is checked, not merely shaped -----------------------------

  /**
   * The loophole this closes. `BAD_CHECKSUM` is 36 characters drawn entirely from
   * Nimiq's alphabet, so the old shape-only regex accepted it — and every route
   * that accepted it wrote a row naming a wallet that cannot exist. `reserveClaim`
   * compares a grant against an address DERIVED from a verified public key, so
   * nothing could ever match it: the row was orphaned the instant it was written,
   * and repeating the request accumulated more of them.
   */
  it('rejects a well-shaped but checksum-invalid address and writes no row', async () => {
    const quiz = await game()
    const phrase = await game({ kind: 'passphrase' })

    const session = await post(`/api/games/${quiz}/session`, { walletAddress: BAD_CHECKSUM })
    expect(session.status, await session.text()).toBe(400)

    const pass = await post(`/api/games/${phrase}/passphrase`, {
      walletAddress: BAD_CHECKSUM,
      phrase: PHRASE,
    })
    expect(pass.status, await pass.text()).toBe(400)

    // The point of the fix: nothing reached the database. A 400 that still left a
    // row behind would close nothing at all.
    const counts = await pool.query<{ grants: string; sessions: string }>(
      `SELECT (SELECT count(*) FROM gate_grants) AS grants,
              (SELECT count(*) FROM trivia_sessions) AS sessions`,
    )
    expect(counts.rows[0]).toEqual({ grants: '0', sessions: '0' })
  })

  it('rejects the checksum-invalid address however it is spaced or cased', async () => {
    const publicId = await game()
    for (const spelling of [
      BAD_CHECKSUM,
      BAD_CHECKSUM.replace(/ /g, ''),
      BAD_CHECKSUM.toLowerCase(),
      `  ${BAD_CHECKSUM}  `,
    ]) {
      const res = await post(`/api/games/${publicId}/session`, { walletAddress: spelling })
      expect(res.status, spelling).toBe(400)
    }
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM trivia_sessions')
    expect(rows[0].count).toBe('0')
  })

  it('treats spacing and case variants of one wallet as one wallet', async () => {
    // Two spellings must not become two grants. If they did, a one-play-per-wallet
    // gate would pay a wallet twice and the claim path could match only one row.
    const publicId = await game({ kind: 'passphrase' })
    const first = await post(`/api/games/${publicId}/passphrase`, {
      walletAddress: PLAYER,
      phrase: PHRASE,
    })
    expect(first.status, await first.text()).toBe(200)

    const { rows } = await pool.query<{ wallet_address: string }>(
      'SELECT wallet_address FROM gate_grants',
    )
    expect(rows).toHaveLength(1)
    // Stored in ONE canonical spelling, not as it happened to arrive.
    expect(rows[0].wallet_address).toBe('NQ07' + '0'.repeat(32))

    // Every other spelling of the same wallet reads that same grant back.
    for (const spelling of [PLAYER, PLAYER.replace(/ /g, ''), PLAYER.toLowerCase()]) {
      const body = await json(
        await get(`/api/games/${publicId}?wallet=${encodeURIComponent(spelling)}`),
      )
      expect(body.granted, spelling).toBe(true)
    }
  })

  // ---- a leaked session id is not enough ------------------------------------

  /**
   * Session ids are v4 uuids, so unguessable — but they are not secrets. They sit
   * in URLs, in `Referer` headers and in access logs. Before the wallet check,
   * anyone holding one could submit a wrong answer and impose the ten-minute
   * cooldown on somebody else's wallet: a remote "end that player's run" button.
   */
  it('refuses the question route to a valid session id presented with the wrong wallet', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)

    const stranger = await question(publicId, sessionId, STRANGER)
    const unknown = await question(publicId, '00000000-0000-4000-8000-000000000000', PLAYER)

    // Identical answers. A caller must not be able to tell "no such session" from
    // "right session, wrong wallet", or the route becomes an ownership oracle.
    expect(stranger.status).toBe(404)
    expect(stranger.status).toBe(unknown.status)
    expect(await stranger.text()).toBe(await unknown.text())
  })

  it('refuses the answer route to the wrong wallet without touching the session', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const q = await json(await question(publicId, sessionId))

    const stranger = await answer(
      publicId,
      sessionId,
      { questionIndex: q.questionIndex, answerIndex: 3 },
      STRANGER,
    )
    const unknown = await answer(
      publicId,
      '00000000-0000-4000-8000-000000000000',
      { questionIndex: 0, answerIndex: 3 },
      PLAYER,
    )
    expect(stranger.status).toBe(404)
    expect(stranger.status).toBe(unknown.status)
    expect(await stranger.text()).toBe(await unknown.text())

    // The cooldown was the prize: the session is untouched and the real player can
    // still answer. Nothing was recorded against their attempt.
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM trivia_answers WHERE session_id = $1 AND answer_index IS NOT NULL',
      [sessionId],
    )
    expect(rows[0].count).toBe('0')
    const { rows: state } = await pool.query<{ state: string }>(
      'SELECT state FROM trivia_sessions WHERE id = $1',
      [sessionId],
    )
    expect(state[0].state).toBe('in_progress')
  })

  it('requires the wallet on both session routes rather than defaulting it', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)

    // Missing entirely.
    expect((await get(`/api/games/${publicId}/session/${sessionId}/question`)).status).toBe(400)
    expect(
      (
        await post(`/api/games/${publicId}/session/${sessionId}/answer`, {
          questionIndex: 0,
          answerIndex: 0,
        })
      ).status,
    ).toBe(400)

    // Present but not an address, which must not be mistaken for absent.
    expect((await question(publicId, sessionId, 'nope')).status).toBe(400)
    expect((await question(publicId, sessionId, BAD_CHECKSUM)).status).toBe(400)
  })

  it('accepts the owner’s wallet in any spelling and plays the session out', async () => {
    // The end-to-end proof that the check constrains a stranger and not the owner.
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const bank = testBank()
    const ids = (
      await pool.query<{ question_ids: string[] }>(
        'SELECT question_ids FROM trivia_sessions WHERE id = $1',
        [sessionId],
      )
    ).rows[0].question_ids

    // A different spelling per question: compact, spaced, lowercased.
    const spellings = [
      PLAYER.replace(/ /g, ''),
      PLAYER,
      PLAYER.toLowerCase(),
      PLAYER.replace(/ /g, '').toLowerCase(),
      PLAYER,
    ]

    let last: Record<string, unknown> = {}
    for (let i = 0; i < 5; i += 1) {
      const q = await json(await question(publicId, sessionId, spellings[i]))
      const truth = bank.questions.find((x) => x.id === ids[q.questionIndex as number])!.answerIndex
      const res = await answer(
        publicId,
        sessionId,
        { questionIndex: q.questionIndex, answerIndex: truth },
        spellings[i],
      )
      expect(res.status, await res.clone().text()).toBe(200)
      last = await json(res)
    }
    expect(last.state).toBe('passed')

    // And the grant landed on the canonical spelling of that one wallet.
    const { rows } = await pool.query<{ wallet_address: string }>(
      'SELECT wallet_address FROM gate_grants',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].wallet_address).toBe('NQ07' + '0'.repeat(32))
  })

  // ---- trivia ---------------------------------------------------------------

  it('delivers a question with four options and never the answer', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const res = await question(publicId, sessionId)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.options).toHaveLength(4)
    expect(Object.keys(body)).not.toContain('answerIndex')
    const text = JSON.stringify(body)
    expect(text).not.toContain('isCorrect')
    expect(text).not.toContain('answerIndex')
  })

  it('refuses an answer for a question that is not in play', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    await question(publicId, sessionId)
    const res = await answer(publicId, sessionId, {
      questionIndex: 3,
      answerIndex: 0,
    })
    expect(res.status).toBe(409)
  })

  /**
   * The web layer renders `review` but could not prove the server sends it — no
   * running server is reachable from `web/`. This is that proof, at the boundary
   * that actually carries it.
   */
  it('sends no review mid-session and a full one when the session ends', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const bank = testBank()

    const truthFor = async (index: number) => {
      const { rows } = await pool.query<{ question_ids: string[] }>(
        'SELECT question_ids FROM trivia_sessions WHERE id = $1',
        [sessionId],
      )
      const id = rows[0].question_ids[index]
      return bank.questions.find((q) => q.id === id)!.answerIndex
    }

    let last: Record<string, unknown> = {}
    for (let i = 0; i < 5; i += 1) {
      const q = await json(await question(publicId, sessionId))
      const choice = await truthFor(q.questionIndex as number)
      const res = await answer(publicId, sessionId, {
        questionIndex: q.questionIndex,
        answerIndex: choice,
      })
      expect(res.status).toBe(200)
      last = await json(res)
      // Mid-session there is nothing to read: a review here would be the same
      // leak as scoring here.
      if (i < 4) expect(last.review).toBeUndefined()
    }

    expect(last.state).toBe('passed')
    const review = last.review as Record<string, unknown>[]
    expect(review).toHaveLength(5)
    expect(Object.keys(review[0]).sort()).toEqual([
      'answerIndex',
      'correctIndex',
      'options',
      'prompt',
      'questionIndex',
      'wasCorrect',
      'wasLate',
    ])
    expect(review.every((r) => r.wasCorrect === true && r.wasLate === false)).toBe(true)
  })

  it('marks a late-but-right answer late rather than wrong', async () => {
    // wasCorrect is not `answerIndex === correctIndex`. Without wasLate a player
    // who picked the right option one second late is shown their own correct
    // answer labelled "not correct", which reads as a scoring bug.
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const bank = testBank()

    const { rows } = await pool.query<{ question_ids: string[] }>(
      'SELECT question_ids FROM trivia_sessions WHERE id = $1',
      [sessionId],
    )
    const ids = rows[0].question_ids

    for (let i = 0; i < 5; i += 1) {
      const q = await json(await question(publicId, sessionId))
      const truth = bank.questions.find((x) => x.id === ids[i])!.answerIndex
      if (i === 0) {
        await pool.query(
          `UPDATE trivia_answers SET deadline_at = now() - interval '1 second'
           WHERE session_id = $1 AND question_index = 0`,
          [sessionId],
        )
      }
      await answer(publicId, sessionId, {
        questionIndex: q.questionIndex,
        answerIndex: truth,
      })
    }

    const { rows: finished } = await pool.query<{ state: string }>(
      'SELECT state FROM trivia_sessions WHERE id = $1',
      [sessionId],
    )
    expect(finished[0].state).toBe('failed')
  })

  it('answers 500 for an operator misconfiguration, not 4xx', async () => {
    // Three questions would put pure guessing at 1.6%. The player did nothing
    // wrong, so blaming them with a 4xx would be a lie; the deployment is broken,
    // so hiding it with a 2xx would be worse.
    const publicId = await game({
      config: { tier: 'novice', bankVersion: 'v1', questionCount: 3, secondsPerQuestion: 15 },
    })
    const res = await post(`/api/games/${publicId}/session`, { walletAddress: PLAYER })
    expect(res.status).toBe(500)
    expect((await json(res)).error).toMatchObject({ code: 'misconfigured' })
  })

  // ---- passphrase -----------------------------------------------------------

  it('grants on the correct phrase and refuses a wrong one', async () => {
    const publicId = await game({ kind: 'passphrase' })
    const ok = await post(`/api/games/${publicId}/passphrase`, {
      walletAddress: PLAYER,
      phrase: '  RED   Panda ',
    })
    expect(ok.status, await ok.text()).toBe(200)
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')
    expect(rows[0].count).toBe('1')

    const other = await game({ kind: 'passphrase' })
    const bad = await post(`/api/games/${other}/passphrase`, {
      walletAddress: PLAYER,
      phrase: 'blue panda',
    })
    expect(bad.status).toBe(409)
  })

  it('never echoes the phrase back', async () => {
    const publicId = await game({ kind: 'passphrase' })
    const res = await post(`/api/games/${publicId}/passphrase`, {
      walletAddress: PLAYER,
      phrase: PHRASE,
    })
    expect(await res.text()).not.toContain(PHRASE)
  })

  it('reports granted for a wallet that has met the condition', async () => {
    const publicId = await game({ kind: 'passphrase' })
    await post(`/api/games/${publicId}/passphrase`, { walletAddress: PLAYER, phrase: PHRASE })
    const body = await json(await get(`/api/games/${publicId}?wallet=${encodeURIComponent(PLAYER)}`))
    expect(body.granted).toBe(true)
  })

  it('reports not granted when no wallet is supplied', async () => {
    const publicId = await game({ kind: 'passphrase' })
    await post(`/api/games/${publicId}/passphrase`, { walletAddress: PLAYER, phrase: PHRASE })
    expect((await json(await get(`/api/games/${publicId}`))).granted).toBe(false)
  })

  // ---- attestation ----------------------------------------------------------

  it('refuses an attestation body that tries to nominate a beneficiary', async () => {
    // The attester names the wallet inside the signed bytes. A body field is
    // refused outright rather than ignored, so a client cannot believe it works.
    const publicId = await game({ kind: 'attested' })
    const res = await post(`/api/games/${publicId}/attestation`, {
      message: 'nimdrops-attestation\n…',
      signature: 'a'.repeat(128),
      walletAddress: PLAYER,
    })
    expect(res.status).toBe(400)
  })

  it('refuses an unverifiable attestation', async () => {
    const publicId = await game({ kind: 'attested' })
    const res = await post(`/api/games/${publicId}/attestation`, {
      message: 'nimdrops-attestation\nnetwork=TestAlbatross',
      signature: 'a'.repeat(128),
    })
    expect(res.status).toBe(400)
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')
    expect(rows[0].count).toBe('0')
  })

  // ---- absent configuration -------------------------------------------------

  it('404s trivia while still serving passphrase when no bank is loaded', async () => {
    const noBank = makeApp({
      pool,
      chain: new FakeChain({ custody: CUSTODY, finalityDepth: 5, headHeight: 100 }),
      alerts: consoleAlerts(),
      now: () => clock,
      clientIp: () => 'test-ip',
      gates: { trivia: null, passphraseSalt: SALT },
    })
    const quiz = await game()
    expect((await post(`/api/games/${quiz}/session`, { walletAddress: PLAYER }, noBank)).status).toBe(404)

    const phrase = await game({ kind: 'passphrase' })
    const res = await post(
      `/api/games/${phrase}/passphrase`,
      { walletAddress: PLAYER, phrase: PHRASE },
      noBank,
    )
    expect(res.status, await res.text()).toBe(200)
  })

  it('leaves an ungated drop readable with no gates configured at all', async () => {
    const plain = await game({ gated: false })
    expect((await get(`/api/drops/${plain}`, bare)).status).toBe(200)
  })
})
