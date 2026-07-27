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
/** 36 characters, the shape `ADDRESS_RE` accepts. */
const PLAYER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 00'

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
    await get(`/api/games/${publicId}/session/${sessionId}/question`)
    const res = await post(`/api/games/${publicId}/session/${sessionId}/answer`, {
      questionIndex: 0,
      answerIndex: 9,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a numeric string where a number is required', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    await get(`/api/games/${publicId}/session/${sessionId}/question`)
    const res = await post(`/api/games/${publicId}/session/${sessionId}/answer`, {
      questionIndex: 0,
      answerIndex: '1',
    })
    expect(res.status).toBe(400)
  })

  it('404s a malformed session id rather than describing its shape', async () => {
    const publicId = await game()
    expect((await get(`/api/games/${publicId}/session/not-a-uuid/question`)).status).toBe(404)
  })

  // ---- trivia ---------------------------------------------------------------

  it('delivers a question with four options and never the answer', async () => {
    const publicId = await game()
    const sessionId = await startSession(publicId)
    const res = await get(`/api/games/${publicId}/session/${sessionId}/question`)
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
    await get(`/api/games/${publicId}/session/${sessionId}/question`)
    const res = await post(`/api/games/${publicId}/session/${sessionId}/answer`, {
      questionIndex: 3,
      answerIndex: 0,
    })
    expect(res.status).toBe(409)
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
