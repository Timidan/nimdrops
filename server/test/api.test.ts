import { createHash, randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import type { Hono } from 'hono'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient, ChainTx } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import { makeApp } from '../src/http/app'
import { consoleAlerts } from '../src/services/alerts'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The API drives the same global aggregates the service race suites do
 * (`outstandingPrincipalLuna` over every drop, the singleton `custody_controls`
 * row), so it gets its own Postgres schema and its own pool pointed at it.
 */
const SCHEMA = 'api_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100
const FEE_FLOAT = 100_000n

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH_NIM = '1'
const CLAIM_COUNT = 5

let pool: pg.Pool
let chain: FakeChain
let app: Hono
let clock: number

/** Frozen clock: token buckets only refill when a test advances it. */
function now(): number {
  return clock
}

interface Wallet {
  publicKeyHex: string
  address: string
  sign(message: string): string
}

/** A real Ed25519 wallet: the suite never fakes a signature it then verifies. */
function newWallet(): Wallet {
  const keyPair = KeyPair.generate()
  return {
    publicKeyHex: keyPair.publicKey.toHex(),
    address: keyPair.publicKey.toAddress().toUserFriendlyAddress(),
    sign: (message: string) => keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
  }
}

function newChain(): FakeChain {
  const c = new FakeChain({ custody: CUSTODY, finalityDepth: FINALITY_DEPTH, headHeight: FUND_HEIGHT })
  // The operator pre-funds the fee reserve; without it invariant 1
  // (balance >= outstanding + fee reserve) can never hold.
  c.deposit({
    hash: 'operator-fee-float',
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: FEE_FLOAT,
    includedHeight: 1,
  })
  return c
}

// ---- request helpers ---------------------------------------------------------

interface CallOptions {
  body?: unknown
  /** Raw body text, for malformed-JSON cases. */
  raw?: string
  idemKey?: string
  bearer?: string
  ip?: string
  headers?: Record<string, string>
}

const DEFAULT_IP = '203.0.113.9'

async function call(method: string, path: string, o: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-for': o.ip ?? DEFAULT_IP,
    ...(o.headers ?? {}),
  }
  if (o.idemKey !== undefined) headers['idempotency-key'] = o.idemKey
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`
  const hasBody = o.body !== undefined || o.raw !== undefined
  if (hasBody) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(hasBody ? { body: o.raw ?? JSON.stringify(o.body) } : {}),
  })
}

const get = (path: string, o: CallOptions = {}) => call('GET', path, o)
const post = (path: string, o: CallOptions = {}) => call('POST', path, o)

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/**
 * Every failure on every route uses the same two-field envelope. Asserting the
 * exact key set is what stops an internal detail (stack, sql, pg code) from
 * being smuggled into a response later.
 */
async function expectEnvelope(res: Response, status: number, code: string): Promise<string> {
  expect(res.status, `expected ${status} ${code}`).toBe(status)
  const body = await json(res)
  expect(Object.keys(body)).toEqual(['error'])
  const error = body.error as Record<string, unknown>
  expect(Object.keys(error).sort()).toEqual(['code', 'message'])
  expect(error.code).toBe(code)
  expect(typeof error.message).toBe('string')
  const message = error.message as string
  expect(message).not.toMatch(/\n\s*at /) // no stack frames
  expect(message).not.toMatch(/node_modules|\/src\/|SELECT |INSERT /)
  return message
}

// ---- domain helpers ----------------------------------------------------------

interface DraftBody {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFunding: string
  expectedFundingLuna: string
  shareUrl: string
}

async function createDrop(o: { idemKey?: string; body?: unknown } = {}): Promise<DraftBody> {
  const res = await post('/api/drops', {
    idemKey: o.idemKey ?? randomUUID(),
    body: o.body ?? {
      sponsorLabel: 'Nimiq Community',
      message: 'thanks for shipping',
      amountEach: AMOUNT_EACH_NIM,
      claimCount: CLAIM_COUNT,
    },
  })
  expect(res.status).toBe(201)
  return json<DraftBody>(res)
}

function fundingHashFor(publicId: string): string {
  return createHash('sha256').update(`funding:${publicId}`).digest('hex')
}

/** Create, deposit exact funding, finalize, and activate through the API. */
async function liveDrop(o: { claimCount?: number } = {}): Promise<DraftBody> {
  const draft =
    o.claimCount === undefined
      ? await createDrop()
      : await createDrop({
          body: {
            sponsorLabel: 'Nimiq Community',
            message: 'thanks for shipping',
            amountEach: AMOUNT_EACH_NIM,
            claimCount: o.claimCount,
          },
        })
  const txHash = fundingHashFor(draft.publicId)
  chain.deposit({
    hash: txHash,
    sender: SPONSOR,
    recipient: CUSTODY,
    valueLuna: BigInt(draft.expectedFundingLuna),
    dataUtf8: draft.fundingMemo,
    includedHeight: FUND_HEIGHT,
  })
  chain.setHead(FUND_HEIGHT + FINALITY_DEPTH)
  const res = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
  expect(res.status).toBe(200)
  expect((await json(res)).state).toBe('live')
  return draft
}

interface ChallengeBody {
  challengeId: string
  message: string
  expiresAt: string
}

async function challenge(publicId: string, ip?: string): Promise<ChallengeBody> {
  const res = await post(`/api/drops/${publicId}/challenge`, ip === undefined ? {} : { ip })
  expect(res.status).toBe(200)
  return json<ChallengeBody>(res)
}

async function claim(
  publicId: string,
  wallet: Wallet,
  o: { ip?: string; idemKey?: string } = {},
): Promise<Response> {
  const issued = await challenge(publicId, o.ip)
  return post(`/api/drops/${publicId}/claims`, {
    ...(o.ip === undefined ? {} : { ip: o.ip }),
    idemKey: o.idemKey ?? randomUUID(),
    body: {
      challengeId: issued.challengeId,
      publicKey: wallet.publicKeyHex,
      signature: wallet.sign(issued.message),
    },
  })
}

describe.skipIf(!hasDb)('HTTP API (real Postgres)', () => {
  const saved = {
    network: process.env.NIMIQ_NETWORK,
    origin: process.env.PUBLIC_ORIGIN,
    scheme: process.env.SIG_SCHEME,
    secret: process.env.STATUS_TOKEN_SECRET,
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA},public`,
      max: 8,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
    restoreEnv()
  })

  beforeEach(async () => {
    setEnv()
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       operator_float_deposits, http_idempotency RESTART IDENTITY CASCADE`,
    )
    await pool.query(
      `UPDATE custody_controls
       SET paused = false,
           max_live_principal_luna = 10000000,
           configured_fee_reserve_luna = ${FEE_FLOAT},
           operator_float_luna = ${FEE_FLOAT},
           reconciled_confirmed_balance_luna = NULL,
           last_reconciled_height = NULL,
           last_reconciled_at = NULL
       WHERE singleton`,
    )
    chain = newChain()
    clock = 1_700_000_000_000
    // A fresh app per test means fresh in-memory token buckets.
    app = makeApp({ pool, chain, alerts: consoleAlerts(), now })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setEnv()
  })

  function setEnv(): void {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'api-test-secret'
  }

  function restoreEnv(): void {
    for (const [key, value] of [
      ['NIMIQ_NETWORK', saved.network],
      ['PUBLIC_ORIGIN', saved.origin],
      ['SIG_SCHEME', saved.scheme],
      ['STATUS_TOKEN_SECRET', saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // ---- happy path ------------------------------------------------------------

  it('walks create → fund → challenge → claim → status', async () => {
    const logged: string[] = []
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
      })
    }

    // 1. create
    const draft = await createDrop()
    expect(draft.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(draft.fundingAddress).toBe(CUSTODY)
    expect(draft.fundingMemo).toBe(`ND1:${draft.publicId}`)
    expect(draft.expectedFunding).toBe('5')
    expect(draft.expectedFundingLuna).toBe('500000')
    expect(draft.shareUrl).toBe(`${ORIGIN}/d/${draft.publicId}`)

    // 2. fund
    const txHash = fundingHashFor(draft.publicId)
    chain.deposit({
      hash: txHash,
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: 500_000n,
      dataUtf8: draft.fundingMemo,
      includedHeight: FUND_HEIGHT,
    })

    // Not final yet: the drop reports funding_pending, never an error and never
    // a prompt to fund again.
    const pending = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
    expect(pending.status).toBe(200)
    expect((await json(pending)).state).toBe('funding_pending')

    chain.setHead(FUND_HEIGHT + FINALITY_DEPTH)
    const funded = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
    expect(funded.status).toBe(200)
    expect((await json(funded)).state).toBe('live')

    // 3. public read
    const publicRes = await get(`/api/drops/${draft.publicId}`)
    expect(publicRes.status).toBe(200)
    const pub = await json(publicRes)
    expect(pub).toMatchObject({
      publicId: draft.publicId,
      sponsorLabel: 'Nimiq Community',
      message: 'thanks for shipping',
      amountEach: '1',
      claimCount: CLAIM_COUNT,
      remaining: CLAIM_COUNT,
      state: 'live',
      fundingTxHash: txHash,
    })
    expect(typeof pub.expiresAt).toBe('string')

    // 4. challenge + claim
    const wallet = newWallet()
    const issued = await challenge(draft.publicId)
    expect(issued.challengeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(issued.message)).toMatchObject({ drop: draft.publicId, action: 'claim' })

    const claimRes = await post(`/api/drops/${draft.publicId}/claims`, {
      idemKey: 'claim-key-1',
      body: {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: wallet.sign(issued.message),
      },
    })
    expect(claimRes.status).toBe(202)
    const claimText = await claimRes.text()
    const reserved = JSON.parse(claimText) as { claimId: string; statusToken: string; state: string }
    expect(reserved.state).toBe('reserved')
    expect(reserved.claimId).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof reserved.statusToken).toBe('string')
    expect(reserved.statusToken.length).toBeGreaterThan(20)

    // The token appears exactly once in the whole response body, and nowhere
    // in the response headers.
    expect(claimText.split(reserved.statusToken).length - 1).toBe(1)
    for (const [, value] of claimRes.headers.entries()) {
      expect(value).not.toContain(reserved.statusToken)
    }

    // 5. status — the token travels in the Authorization header, never the path
    const statusPath = `/api/claims/${reserved.claimId}`
    expect(statusPath).not.toContain(reserved.statusToken)
    const statusRes = await get(statusPath, { bearer: reserved.statusToken })
    expect(statusRes.status).toBe(200)
    expect(await json(statusRes)).toEqual({ state: 'reserved', amountEach: '1' })

    // remaining decreases, and the public projection still leaks nothing
    const after = await json(await get(`/api/drops/${draft.publicId}`))
    expect(after.remaining).toBe(CLAIM_COUNT - 1)

    // No status token ever reaches the logs.
    for (const line of logged) expect(line).not.toContain(reserved.statusToken)
  })

  // ---- idempotency -----------------------------------------------------------

  it('requires an Idempotency-Key on POST /api/drops and on claims', async () => {
    const noKey = await post('/api/drops', {
      body: { sponsorLabel: 'S', amountEach: '1', claimCount: 2 },
    })
    await expectEnvelope(noKey, 400, 'idempotency_key_required')

    const blank = await post('/api/drops', {
      idemKey: '   ',
      body: { sponsorLabel: 'S', amountEach: '1', claimCount: 2 },
    })
    await expectEnvelope(blank, 400, 'idempotency_key_required')

    const draft = await liveDrop()
    const issued = await challenge(draft.publicId)
    const wallet = newWallet()
    const claimNoKey = await post(`/api/drops/${draft.publicId}/claims`, {
      body: {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: wallet.sign(issued.message),
      },
    })
    await expectEnvelope(claimNoKey, 400, 'idempotency_key_required')
  })

  it('replays the same drop for the same key and body, ignoring key order', async () => {
    const first = await createDrop({ idemKey: 'create-key' })

    const replay = await post('/api/drops', {
      idemKey: 'create-key',
      // Same request, different property order and whitespace.
      raw: JSON.stringify({
        claimCount: CLAIM_COUNT,
        amountEach: AMOUNT_EACH_NIM,
        message: 'thanks for shipping',
        sponsorLabel: 'Nimiq Community',
      }),
    })
    expect(replay.status).toBe(201)
    expect(await json<DraftBody>(replay)).toEqual(first)

    // Exactly one drop was created.
    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text FROM drops')
    expect(rows[0].count).toBe('1')
  })

  it('rejects the same key with a different body (409) on both keyed routes', async () => {
    await createDrop({ idemKey: 'create-key' })
    const conflict = await post('/api/drops', {
      idemKey: 'create-key',
      body: { sponsorLabel: 'Someone Else', amountEach: '2', claimCount: 3 },
    })
    await expectEnvelope(conflict, 409, 'idempotency_key_reused')

    const draft = await liveDrop()
    const wallet = newWallet()
    const ok = await claim(draft.publicId, wallet, { idemKey: 'claim-key' })
    expect(ok.status).toBe(202)

    const other = newWallet()
    const issued = await challenge(draft.publicId)
    const reused = await post(`/api/drops/${draft.publicId}/claims`, {
      idemKey: 'claim-key',
      body: {
        challengeId: issued.challengeId,
        publicKey: other.publicKeyHex,
        signature: other.sign(issued.message),
      },
    })
    await expectEnvelope(reused, 409, 'idempotency_key_reused')
  })

  it('returns the same claim and token for an exact retry', async () => {
    const draft = await liveDrop()
    const wallet = newWallet()
    const issued = await challenge(draft.publicId)
    const body = {
      challengeId: issued.challengeId,
      publicKey: wallet.publicKeyHex,
      signature: wallet.sign(issued.message),
    }
    const first = await post(`/api/drops/${draft.publicId}/claims`, { idemKey: 'retry', body })
    const second = await post(`/api/drops/${draft.publicId}/claims`, { idemKey: 'retry', body })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(await json(second)).toEqual(await json(first))
  })

  // ---- uniform not-found -------------------------------------------------------

  it('answers unknown ids, wrong bearers and absent bearers with one uniform 404', async () => {
    const draft = await liveDrop()
    const wallet = newWallet()
    const reserved = await json<{ claimId: string; statusToken: string }>(
      await claim(draft.publicId, wallet),
    )

    const unknownClaim = await get(`/api/claims/${randomUUID()}`, { bearer: reserved.statusToken })
    const wrongBearer = await get(`/api/claims/${reserved.claimId}`, { bearer: 'not-the-token' })
    const noBearer = await get(`/api/claims/${reserved.claimId}`)
    const junkId = await get('/api/claims/not-a-uuid', { bearer: reserved.statusToken })

    const bodies: string[] = []
    for (const res of [unknownClaim, wrongBearer, noBearer, junkId]) {
      expect(res.status).toBe(404)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size, 'every 404 must be byte-identical').toBe(1)
    expect(JSON.parse(bodies[0])).toEqual({ error: { code: 'not_found', message: 'not found' } })
  })

  it('answers an unknown drop id with the same generic 404', async () => {
    const unknown = await get(`/api/drops/${'a'.repeat(22)}`)
    const malformed = await get('/api/drops/nope')
    for (const res of [unknown, malformed]) {
      const message = await expectEnvelope(res, 404, 'not_found')
      expect(message).toBe('not found')
    }

    // …and so do the other verbs on an unknown drop.
    await expectEnvelope(await post(`/api/drops/${'a'.repeat(22)}/challenge`), 404, 'not_found')
    await expectEnvelope(
      await post(`/api/drops/${'a'.repeat(22)}/funding`, { body: { txHash: 'a'.repeat(64) } }),
      404,
      'not_found',
    )
    await expectEnvelope(await get('/api/nope'), 404, 'not_found')
  })

  // ---- no address enumeration ----------------------------------------------------

  it('never exposes claimant addresses, signatures or internal ids in public state', async () => {
    const draft = await liveDrop()
    const wallet = newWallet()
    await claim(draft.publicId, wallet)

    const text = await (await get(`/api/drops/${draft.publicId}`)).text()
    expect(text).not.toContain(wallet.address)
    expect(text).not.toContain(wallet.publicKeyHex)

    const pub = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(pub).sort()).toEqual([
      'amountEach',
      'claimCount',
      'expiresAt',
      'fundingTxHash',
      'message',
      'publicId',
      'remaining',
      'sponsorLabel',
      'state',
    ])
  })

  // ---- validation ----------------------------------------------------------------

  it('validates request bodies strictly', async () => {
    const bad: unknown[] = [
      undefined,
      { sponsorLabel: 'S', amountEach: '1' },
      { sponsorLabel: '', amountEach: '1', claimCount: 5 },
      { sponsorLabel: 'S', amountEach: 1, claimCount: 5 },
      { sponsorLabel: 'S', amountEach: '1', claimCount: 1 },
      { sponsorLabel: 'S', amountEach: '1', claimCount: 21 },
      { sponsorLabel: 'S', amountEach: '1', claimCount: 2.5 },
      { sponsorLabel: 'S', amountEach: '1000', claimCount: 20 },
      { sponsorLabel: 'S', amountEach: '0', claimCount: 5 },
      { sponsorLabel: 'S', amountEach: '1.000001', claimCount: 5 },
      { sponsorLabel: 'S', amountEach: '1', claimCount: 5, extra: true },
    ]
    for (const body of bad) {
      const res = await post('/api/drops', { idemKey: randomUUID(), ...(body === undefined ? {} : { body }) })
      await expectEnvelope(res, 400, 'invalid_request')
    }

    const malformed = await post('/api/drops', { idemKey: randomUUID(), raw: '{oops' })
    await expectEnvelope(malformed, 400, 'invalid_request')

    await expectEnvelope(
      await post(`/api/drops/${'a'.repeat(22)}/funding`, { body: { txHash: 'zz' } }),
      400,
      'invalid_request',
    )

    const draft = await liveDrop()
    for (const body of [
      { challengeId: 'nope', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) },
      { challengeId: randomUUID(), publicKey: 'xyz', signature: 'b'.repeat(128) },
      { challengeId: randomUUID(), publicKey: 'a'.repeat(64), signature: 'b'.repeat(10) },
      { challengeId: randomUUID(), publicKey: 'a'.repeat(64) },
    ]) {
      const res = await post(`/api/drops/${draft.publicId}/claims`, { idemKey: randomUUID(), body })
      await expectEnvelope(res, 400, 'invalid_request')
    }
  })

  // ---- rejections ------------------------------------------------------------------

  it('maps funding predicate failures to 422 with their code', async () => {
    const draft = await createDrop()
    const txHash = fundingHashFor(draft.publicId)
    chain.deposit({
      hash: txHash,
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: 400_000n, // wrong amount
      dataUtf8: draft.fundingMemo,
      includedHeight: FUND_HEIGHT,
    })
    chain.setHead(FUND_HEIGHT + FINALITY_DEPTH)
    const res = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
    await expectEnvelope(res, 422, 'wrong_amount')
  })

  it('reports an undetected funding hash as normal state, never as an error', async () => {
    const draft = await createDrop()
    const res = await post(`/api/drops/${draft.publicId}/funding`, {
      body: { txHash: fundingHashFor(draft.publicId) },
    })
    expect(res.status).toBe(200)
    expect((await json(res)).state).toBe('awaiting_funding')
  })

  it('maps claim rejections to 409 with their code', async () => {
    const draft = await liveDrop()
    const wallet = newWallet()
    const issued = await challenge(draft.publicId)
    const res = await post(`/api/drops/${draft.publicId}/claims`, {
      idemKey: randomUUID(),
      body: {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: newWallet().sign(issued.message), // signed by someone else
      },
    })
    await expectEnvelope(res, 409, 'invalid_signature')

    // A drop that is not live cannot even issue a challenge.
    const draining = await createDrop()
    await expectEnvelope(
      await post(`/api/drops/${draining.publicId}/challenge`),
      409,
      'drop_not_live',
    )
  })

  it('answers money paths with 503 and a retry hint while custody is paused', async () => {
    const draft = await liveDrop()
    await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')

    const res = await claim(draft.publicId, newWallet())
    await expectEnvelope(res, 503, 'paused')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('returns a generic 500 for an unexpected failure and logs it', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })

    const secret = 'postgres://user:hunter2@db.internal:5432 at Object.<anonymous>'
    const broken: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: () => chain.headHeight(),
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: async () => {
        throw new Error(secret)
      },
      confirmedBalanceLuna: (a: string) => chain.confirmedBalanceLuna(a),
      buildSignedBasic: (o) => chain.buildSignedBasic(o),
      broadcast: (raw: string) => chain.broadcast(raw),
    }
    const draft = await createDrop()
    app = makeApp({ pool, chain: broken, alerts: consoleAlerts(), now })

    const res = await post(`/api/drops/${draft.publicId}/funding`, {
      body: { txHash: fundingHashFor(draft.publicId) },
    })
    const message = await expectEnvelope(res, 500, 'internal_error')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('db.internal')
    expect(errors.join('\n')).toContain('request_failed')
  })

  // ---- rate limits --------------------------------------------------------------

  it('rate limits 60 requests per minute per IP', async () => {
    const draft = await liveDrop()
    for (let i = 0; i < 60; i++) {
      const res = await get(`/api/drops/${draft.publicId}`, { ip: '198.51.100.7' })
      expect(res.status, `request ${i + 1} should pass`).toBe(200)
    }
    const limited = await get(`/api/drops/${draft.publicId}`, { ip: '198.51.100.7' })
    await expectEnvelope(limited, 429, 'rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    // A different IP has its own bucket…
    expect((await get(`/api/drops/${draft.publicId}`, { ip: '198.51.100.8' })).status).toBe(200)
    // …and the bucket refills as the clock advances.
    clock += 60_000
    expect((await get(`/api/drops/${draft.publicId}`, { ip: '198.51.100.7' })).status).toBe(200)
  })

  it('rate limits 10 AUTHENTICATED claim attempts per minute per drop, across IPs and wallets', async () => {
    // 20 slots so the per-drop limiter, not the drop's own capacity, is what
    // ends the run.
    const draft = await liveDrop({ claimCount: 20 })

    // Distinct IP and wallet each time, so only the per-drop bucket can trip.
    for (let i = 0; i < 10; i++) {
      const res = await claim(draft.publicId, newWallet(), { ip: `192.0.2.${i + 1}` })
      expect(res.status, `claim ${i + 1} status ${res.status}`).toBe(202)
    }
    await expectEnvelope(
      await claim(draft.publicId, newWallet(), { ip: '192.0.2.100' }),
      429,
      'rate_limited',
    )

    // Another drop is unaffected.
    const other = await liveDrop()
    expect((await claim(other.publicId, newWallet(), { ip: '192.0.2.201' })).status).toBe(202)
  })

  /**
   * round-2 review F8. Charging the per-drop bucket on every AUTHENTICATED
   * request was the same denial of service one signature deeper: the
   * idempotency contract invites a client to retry, and each retry — answered
   * from a record, allocating nothing — still spent one of the drop's ten
   * tokens. Two wallets and ten signatures closed a twenty-slot drop to
   * everybody else. A signature proves who is asking, not that they are asking
   * for anything new.
   */
  it('authenticated retries do not spend a drop’s claim budget — only new reservations do', async () => {
    // 20 slots, so the per-drop limiter and not the drop's capacity is what
    // ends the run.
    const draft = await liveDrop({ claimCount: 20 })

    // Two wallets, five EXACT retries each: same challenge, same idempotency
    // key, same bytes. Ten authenticated requests, two real reservations.
    for (const octet of [11, 12]) {
      const wallet = newWallet()
      const issued = await challenge(draft.publicId, `203.0.113.${octet}`)
      const body = {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: wallet.sign(issued.message),
      }
      const idemKey = randomUUID()
      const seen = new Set<string>()
      for (let i = 0; i < 5; i++) {
        const res = await post(`/api/drops/${draft.publicId}/claims`, {
          ip: `203.0.113.${octet}`,
          idemKey,
          body,
        })
        expect(res.status, `wallet ${octet} retry ${i + 1} status ${res.status}`).toBe(202)
        seen.add(((await res.json()) as { claimId: string }).claimId)
      }
      expect(seen.size, 'a retry must return the SAME claim, not another one').toBe(1)
    }

    // Two tokens spent, not ten. Eight more genuinely new claimants fit.
    for (let i = 0; i < 8; i++) {
      const res = await claim(draft.publicId, newWallet(), { ip: `192.0.2.${i + 1}` })
      expect(res.status, `new claimant ${i + 1} status ${res.status}`).toBe(202)
    }

    // And the bucket is a real bucket: ten NEW reservations do exhaust it.
    await expectEnvelope(
      await claim(draft.publicId, newWallet(), { ip: '192.0.2.99' }),
      429,
      'rate_limited',
    )
  })

  /**
   * round-3 review R5. F8 made SEQUENTIAL retries free and left concurrent ones
   * charged: the retry recheck that spares a duplicate runs inside the
   * allocation transaction, but the charge happened before it, so ten copies of
   * one request sent at once all found no existing claim, all spent a token,
   * one reserved and nine returned the winner's claim. Ten tokens for one
   * reservation — a claimant double-tapping a button, or any client with
   * retry-on-timeout, could lock a drop out on their own. Whether a retry is
   * sequential or concurrent is not something the idempotency contract lets a
   * client control, so it must not change what the retry costs.
   */
  it('ten CONCURRENT identical retries spend one token, not ten', async () => {
    // The per-WALLET bucket (5/min) is charged per request by design and is a
    // limit the retrying wallet imposes on itself; raising it here leaves the
    // per-DROP bucket — the one a retry can aim at everybody else — as the only
    // thing this test measures.
    app = makeApp({
      pool,
      chain,
      alerts: consoleAlerts(),
      now,
      limits: { claimsPerWalletPerWindow: 50 },
    })
    const draft = await liveDrop({ claimCount: 20 })

    const wallet = newWallet()
    const issued = await challenge(draft.publicId, '203.0.113.30')
    const body = {
      challengeId: issued.challengeId,
      publicKey: wallet.publicKeyHex,
      signature: wallet.sign(issued.message),
    }
    const idemKey = randomUUID()

    // True concurrency: one Promise.all, no awaits in between. Every request is
    // byte-identical, which is exactly the retry the contract invites.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/api/drops/${draft.publicId}/claims`, {
          ip: '203.0.113.30',
          idemKey,
          body,
        }),
      ),
    )

    const claimIds = new Set<string>()
    for (const [i, res] of responses.entries()) {
      expect(res.status, `concurrent retry ${i + 1} status ${res.status}`).toBe(202)
      claimIds.add(((await res.json()) as { claimId: string }).claimId)
    }
    expect(claimIds.size, 'ten copies of one request must produce ONE claim').toBe(1)

    // One token spent by the one reservation those ten requests produced, so
    // nine more genuinely new claimants still fit before the bucket is empty.
    for (let i = 0; i < 9; i++) {
      const res = await claim(draft.publicId, newWallet(), { ip: `192.0.2.${i + 1}` })
      expect(res.status, `new claimant ${i + 1} status ${res.status}`).toBe(202)
    }
    await expectEnvelope(
      await claim(draft.publicId, newWallet(), { ip: '192.0.2.98' }),
      429,
      'rate_limited',
    )
  })

  /**
   * The other half of F8: a replayed challenge cannot allocate, so it must not
   * be charged either. Anyone can lift a challenge id out of a shared link and
   * sign the same message with their own key — that request is refused on the
   * consumed nonce, and refusing it must cost the drop nothing.
   */
  it('a replayed challenge is refused without spending the drop’s claim budget', async () => {
    const draft = await liveDrop({ claimCount: 20 })

    const issued = await challenge(draft.publicId, '198.51.100.10')
    const first = await post(`/api/drops/${draft.publicId}/claims`, {
      ip: '198.51.100.10',
      idemKey: randomUUID(),
      body: {
        challengeId: issued.challengeId,
        publicKey: newWallet().publicKeyHex,
        signature: 'not-checked-yet',
      },
    })
    // (a malformed signature is refused before anything is consumed)
    expect(first.status).toBe(400)

    const owner = newWallet()
    const claimed = await post(`/api/drops/${draft.publicId}/claims`, {
      ip: '198.51.100.10',
      idemKey: randomUUID(),
      body: {
        challengeId: issued.challengeId,
        publicKey: owner.publicKeyHex,
        signature: owner.sign(issued.message),
      },
    })
    expect(claimed.status).toBe(202)

    // Nine other wallets sign the SAME already-spent message. Every one of them
    // verifies, and every one of them is refused on the consumed challenge.
    for (let i = 0; i < 9; i++) {
      const thief = newWallet()
      const res = await post(`/api/drops/${draft.publicId}/claims`, {
        ip: `198.51.100.${20 + i}`,
        idemKey: randomUUID(),
        body: {
          challengeId: issued.challengeId,
          publicKey: thief.publicKeyHex,
          signature: thief.sign(issued.message),
        },
      })
      await expectEnvelope(res, 409, 'challenge_consumed')
    }

    // One token spent by the one real reservation; the drop is still open.
    expect((await claim(draft.publicId, newWallet(), { ip: '192.0.2.51' })).status).toBe(202)
  })

  /**
   * G1 review finding 8. The per-drop bucket used to be charged before the
   * signature was checked, so ten junk requests a minute — costing an attacker
   * nothing, and provable by nobody — locked every real claimant out of a
   * named drop. Unauthenticated requests now pay the per-IP limiter instead,
   * which is the bucket an attacker can only aim at themselves.
   */
  it('malformed claims cannot spend a drop’s claim budget, only the attacker’s own IP budget', async () => {
    const draft = await liveDrop()
    const ATTACKER_IP = '198.51.100.66'

    const junk = () =>
      post(`/api/drops/${draft.publicId}/claims`, {
        ip: ATTACKER_IP,
        idemKey: randomUUID(),
        body: {
          challengeId: randomUUID(),
          publicKey: newWallet().publicKeyHex,
          signature: 'b'.repeat(128),
        },
      })

    for (let i = 0; i < 10; i++) {
      await expectEnvelope(await junk(), 409, 'unknown_challenge')
    }

    // The whole point: a real claimant on the targeted drop still gets in.
    const victim = await claim(draft.publicId, newWallet(), { ip: '203.0.113.77' })
    expect(victim.status, 'ten junk requests must not lock out a real claimant').toBe(202)

    // The attacker still pays for the flood — on their own IP bucket, at its
    // own threshold (60/min across every /api route, of which 10 are spent).
    for (let i = 0; i < 50; i++) {
      const res = await get(`/api/drops/${draft.publicId}`, { ip: ATTACKER_IP })
      expect(res.status, `attacker request ${i + 11} status ${res.status}`).toBe(200)
    }
    await expectEnvelope(await junk(), 429, 'rate_limited')
    // …and that 429 is the IP bucket, not the drop's: the victim's next claim
    // from a clean IP is still served.
    expect((await claim(draft.publicId, newWallet(), { ip: '203.0.113.78' })).status).toBe(202)
  })

  it('rate limits 5 claim attempts per minute per wallet, across drops', async () => {
    const wallet = newWallet()
    const drops = [await liveDrop(), await liveDrop()]

    let allowed = 0
    for (let i = 0; i < 5; i++) {
      const res = await claim(drops[i % 2].publicId, wallet, { ip: `198.51.100.${i + 20}` })
      expect(res.status, `attempt ${i + 1} status ${res.status}`).not.toBe(429)
      allowed++
    }
    expect(allowed).toBe(5)

    const issued = await challenge(drops[0].publicId, '198.51.100.99')
    const limited = await post(`/api/drops/${drops[0].publicId}/claims`, {
      ip: '198.51.100.99',
      idemKey: randomUUID(),
      body: {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: wallet.sign(issued.message),
      },
    })
    await expectEnvelope(limited, 429, 'rate_limited')

    // A different wallet on the same drop still gets through.
    expect((await claim(drops[0].publicId, newWallet(), { ip: '198.51.100.98' })).status).toBe(202)
  })

  // ---- health ---------------------------------------------------------------------

  it('serves /health with head height and worker freshness, unauthenticated', async () => {
    const stale = await get('/health')
    expect(stale.status).toBe(503)
    expect(await json(stale)).toEqual({ ok: false, headHeight: FUND_HEIGHT, workerFresh: false })

    await liveDrop() // activation reconciles, stamping last_reconciled_at
    const fresh = await get('/health')
    expect(fresh.status).toBe(200)
    expect(await json(fresh)).toEqual({
      ok: true,
      headHeight: FUND_HEIGHT + FINALITY_DEPTH,
      workerFresh: true,
    })

    // Health is never rate limited: monitors must not lose visibility.
    for (let i = 0; i < 80; i++) expect((await get('/health')).status).toBe(200)
  })

  it('reports unhealthy without leaking the reason when the chain is unreachable', async () => {
    const broken: ChainClient = {
      network: () => chain.network(),
      custodyAddress: () => chain.custodyAddress(),
      headHeight: async () => {
        throw new Error('no peers: dialing /dns4/seed1.pos.nimiq-testnet.com failed')
      },
      isFinal: (tx: ChainTx, head: number) => chain.isFinal(tx, head),
      getTransaction: (h: string) => chain.getTransaction(h),
      confirmedBalanceLuna: (a: string) => chain.confirmedBalanceLuna(a),
      buildSignedBasic: (o) => chain.buildSignedBasic(o),
      broadcast: (raw: string) => chain.broadcast(raw),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    app = makeApp({ pool, chain: broken, alerts: consoleAlerts(), now })

    const res = await get('/health')
    expect(res.status).toBe(503)
    const body = await json(res)
    expect(body).toEqual({ ok: false, headHeight: null, workerFresh: false })
  })
})
