import { createHash, randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import type { Hono } from 'hono'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { ChainClient, ChainTx } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import { makeApp } from '../src/http/app'
import {
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  makeClientIpResolver,
} from '../src/http/client-ip'
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
  /** Ed25519 over the prefixed SHA-256 digest: what Nimiq Pay actually sends. */
  signLikeNimiqPay(message: string): string
}

/** A real Ed25519 wallet: the suite never fakes a signature it then verifies. */
function newWallet(): Wallet {
  const keyPair = KeyPair.generate()
  return {
    publicKeyHex: keyPair.publicKey.toHex(),
    address: keyPair.publicKey.toAddress().toUserFriendlyAddress(),
    sign: (message: string) => keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex(),
    // What a real Nimiq wallet returns, which this suite's `SIG_SCHEME=raw`
    // deliberately does NOT accept — see the misconfiguration test below.
    signLikeNimiqPay: (message: string) => {
      const body = Buffer.from(message, 'utf8')
      const digest = createHash('sha256')
        .update(
          Buffer.concat([
            Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
            Buffer.from(String(body.byteLength), 'utf8'),
            body,
          ]),
        )
        .digest()
      return keyPair.sign(new Uint8Array(digest)).toHex()
    },
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

/**
 * The suite nominates a client IP the same way production does: through the
 * authenticated hop, not through `X-Forwarded-For`. This app trusts NO
 * forwarding header — see `src/http/client-ip.ts` — so a test that set one
 * would silently put every request in the same bucket and stop measuring the
 * per-IP limiter at all. Here Caddy's role is played by these two headers plus
 * the resolver `makeApp` is given below; `test/client-ip.test.ts` is where the
 * resolver's own rules are asserted.
 */
const PROXY_SECRET = 'api-test-proxy-secret-'.padEnd(64, '0')

const clientIp = makeClientIpResolver({
  proxySecret: PROXY_SECRET,
  // `app.request()` has no socket, so an unnominated request is unattributable
  // — exactly as it would be in production.
  peerAddress: () => undefined,
})

async function call(method: string, path: string, o: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    [PROXY_SECRET_HEADER]: PROXY_SECRET,
    [CLIENT_IP_HEADER]: o.ip ?? DEFAULT_IP,
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

interface DisclosureBody {
  network: string
  chainLabel: string
  custodyAddress: string
  mainnetPilot: boolean
  paused: boolean
  expiryHours: number
  fundingWindowMinutes: number
  limits: {
    aggregateMax: string | null
    aggregateMaxLuna: string | null
    remaining: string | null
    remainingLuna: string | null
    atRisk: string
    atRiskLuna: string
    outstandingLuna: string
    unactivatedFundedLuna: string
    maxLiveDrops: number | null
    liveDrops: number
    reservedDrafts: number
    remainingDrops: number | null
  }
  summary: string
  points: { id: string; text: string }[]
}

interface DraftBody {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFunding: string
  expectedFundingLuna: string
  shareUrl: string
  expiryHours: number
  reservationExpiresAt: string | null
  disclosure: DisclosureBody
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
async function liveDrop(o: { claimCount?: number; expiryHours?: number } = {}): Promise<DraftBody> {
  const draft =
    o.claimCount === undefined && o.expiryHours === undefined
      ? await createDrop()
      : await createDrop({
          body: {
            sponsorLabel: 'Nimiq Community',
            message: 'thanks for shipping',
            amountEach: AMOUNT_EACH_NIM,
            claimCount: o.claimCount ?? CLAIM_COUNT,
            ...(o.expiryHours === undefined ? {} : { expiryHours: o.expiryHours }),
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
       operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
    await pool.query(
      `UPDATE custody_controls
       SET paused = false,
           max_live_principal_luna = NULL,
           max_live_drops = NULL,
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
    app = makeApp({ pool, chain, alerts: consoleAlerts(), now, clientIp })
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
    expect(draft.shareUrl).toBe(`${ORIGIN}/drop/${draft.publicId}`)

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

  // ---- sponsor disclosure and the capacity cap ---------------------------------
  //
  // NimDrops is a custodial hot wallet with a disclosed cap. A sponsor who only
  // learns that afterwards has been misled by omission, so the server owns the
  // words and the numbers, and the web layer's job is to render all of them
  // above the fund button.

  async function setCaps(o: { capLuna?: bigint | null; maxLiveDrops?: number | null }): Promise<void> {
    await pool.query(
      `UPDATE custody_controls SET max_live_principal_luna = $1, max_live_drops = $2
       WHERE singleton`,
      [o.capLuna === undefined || o.capLuna === null ? null : o.capLuna.toString(), o.maxLiveDrops ?? null],
    )
  }

  it('serves the custody disclosure unauthenticated, with no cap to point at', async () => {
    const body = await json<DisclosureBody>(await get('/api/custody'))

    expect(body.network).toBe('TestAlbatross')
    expect(body.custodyAddress).toBe(CUSTODY)
    expect(body.mainnetPilot).toBe(false)
    expect(body.paused).toBe(false)
    expect(body.expiryHours).toBe(24)
    expect(body.limits.aggregateMax, 'no ceiling is set by default').toBeNull()
    expect(body.limits.remaining).toBeNull()
    expect(body.limits.atRisk, 'the honest number: held and not yet paid out').toBe('0')
    expect(body.limits.outstandingLuna, 'and it decomposes').toBe('0')
    expect(body.limits.unactivatedFundedLuna).toBe('0')
    expect(body.limits.liveDrops).toBe(0)

    // Every disclosure the sponsor is owed, by id rather than by prose. There
    // is no `limits` point and no `funding_window` point: with nothing capped
    // there is no room to run out of and none to hold for anybody.
    const ids = body.points.map((p) => p.id)
    expect(ids).toEqual([
      'not_escrow',
      'why_no_contract',
      'operator_key',
      'exposure',
      'mitigations',
      'destination',
      'test_network',
      'expiry_clock',
      'refunds',
    ])
    const text = body.points.map((p) => p.text).join('\n')
    expect(text, 'the custody address must be readable before approving').toContain(CUSTODY)
    expect(text, 'that the operator can move everything is the disclosure').toMatch(
      /only key.*can move everything/i,
    )
    expect(text).toMatch(/not an escrow contract/i)
    // The claim the old copy made — that hard caps were the mitigation — is
    // false now, and a false custody disclosure is worse than none.
    expect(text, 'never promise a ceiling that does not exist').not.toMatch(/can hold up to/i)
    expect(text, 'say why there is no contract, not just that there is none').toMatch(/HTLC/)
    expect(text, 'name the exposure').toMatch(/has not finished paying out/i)
    // "unclaimed" was untrue in both directions: the figure keeps shares that
    // are allocated and broadcast but not yet final, and it now also counts
    // funding that was verified and never activated.
    expect(text, 'and do not call it unclaimed').not.toMatch(/nobody has claimed/i)
    expect(text, 'and do not dress the mitigations up').toMatch(/is not cryptography/i)
    expect(text, 'no exclamation marks in interface copy').not.toContain('!')
  })

  it('names the operator’s cap only when the operator has set one', async () => {
    await setCaps({ capLuna: 1_000_000n, maxLiveDrops: 2 })
    const body = await json<DisclosureBody>(await get('/api/custody'))

    expect(body.limits.aggregateMax).toBe('10')
    expect(body.limits.remaining).toBe('10')
    const ids = body.points.map((p) => p.id)
    expect(ids).toContain('limits')
    expect(ids, 'a reservation only means something when there is room to reserve').toContain(
      'funding_window',
    )
    const limits = body.points.find((p) => p.id === 'limits')
    expect(limits?.text).toContain('10 NIM')
    expect(limits?.text).toContain('2 drops can run at a time')
  })

  it('reports the money as at risk when funding went final and activation refused', async () => {
    // The disclosure used to derive its one number from `outstandingPrincipalLuna`
    // alone, which counts ACTIVATED drops. A funding transaction that reaches
    // finality while activation fails closed — paused custody here, and equally a
    // stale reconciliation or any other prerequisite — leaves the operator
    // holding that sponsor's NIM with `activated_height` still NULL. The figure
    // said "0 NIM", verbatim, to the next sponsor about to fund.
    const draft = await createDrop()
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
    await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')

    // The transaction is final and every §7 predicate passes; only activation
    // refuses. The sponsor's money is in the custody wallet either way.
    const refused = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
    expect(refused.status).toBe(503)

    const { rows } = await pool.query<{ activated_height: string | null; funding_tx_hash: string | null }>(
      'SELECT activated_height, funding_tx_hash FROM drops WHERE public_id = $1',
      [draft.publicId],
    )
    expect(rows[0].activated_height, 'nothing activated').toBeNull()
    expect(rows[0].funding_tx_hash, 'but the deposit is written down').toBe(txHash)

    const body = await json<DisclosureBody>(await get('/api/custody'))
    expect(body.limits.atRiskLuna).toBe(draft.expectedFundingLuna)
    expect(body.limits.outstandingLuna, 'no drop went live').toBe('0')
    expect(body.limits.unactivatedFundedLuna, 'and this is where it is').toBe(
      draft.expectedFundingLuna,
    )
    expect(body.limits.atRisk).toBe('5')

    const exposure = body.points.find((p) => p.id === 'exposure')
    expect(exposure?.text, 'the sentence carries the same number').toContain('5 NIM')
    expect(body.summary).toContain('holding 5 NIM')
  })

  it('names the mainnet pilot and the pause state in the disclosure', async () => {
    await pool.query('UPDATE custody_controls SET paused = true WHERE singleton')
    const paused = await json<DisclosureBody>(await get('/api/custody'))
    expect(paused.paused).toBe(true)
    expect(paused.points[0].id, 'a closed door is the first thing to say').toBe('paused')
  })

  it('says the drop limit and holds the room, with no principal cap at all', async () => {
    // The shape a mainnet deployment actually runs after migration 015: no
    // principal ceiling, one drop at a time. The reservation still means
    // something here — it is holding the one slot — so the window is still said.
    await setCaps({ maxLiveDrops: 1 })
    const body = await json<DisclosureBody>(await get('/api/custody'))

    expect(body.limits.aggregateMax).toBeNull()
    expect(body.limits.maxLiveDrops).toBe(1)
    const limits = body.points.find((p) => p.id === 'limits')
    expect(limits?.text).toBe('Only one drop can run at a time.')
    expect(limits?.text, 'never name a NIM ceiling that is not set').not.toContain('NIM')
    expect(body.points.map((p) => p.id)).toContain('funding_window')
  })

  it('carries the disclosure on the draft, with this drop already counted', async () => {
    await setCaps({ capLuna: 1_000_000n }) // 10 NIM
    const draft = await createDrop()

    expect(draft.reservationExpiresAt, 'the room is promised for a stated time').not.toBeNull()
    expect(new Date(draft.reservationExpiresAt as string).getTime()).toBeGreaterThan(Date.now())
    expect(draft.disclosure.limits.aggregateMax).toBe('10')
    // 10 NIM cap, this 5 NIM drop reserved: half is left, and the sponsor is
    // shown the number that includes their own drop rather than a stale one.
    expect(draft.disclosure.limits.remaining).toBe('5')
    expect(draft.disclosure.limits.reservedDrafts).toBe(1)
    expect(draft.disclosure.points.map((p) => p.id)).toContain('limits')
  })

  it('refuses a drop bigger than the whole cap with 422 and a smaller-total hint', async () => {
    await setCaps({ capLuna: 400_000n }) // 4 NIM, against a 5 NIM drop
    const res = await post('/api/drops', {
      idemKey: randomUUID(),
      body: { sponsorLabel: 'S', amountEach: AMOUNT_EACH_NIM, claimCount: CLAIM_COUNT },
    })
    const message = await expectEnvelope(res, 422, 'drop_too_large')
    expect(message).toContain('4 NIM')
    expect(message, 'retrying will never help, so do not suggest it').not.toMatch(/try again/i)
    expect(message, 'the ceiling is the operator’s choice, not a property of drops').toMatch(
      /operator has capped/i,
    )

    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text FROM drops')
    expect(rows[0].count, 'a refused draft holds no room of its own').toBe('0')
  })

  it('refuses a drop that does not fit right now with 503 and a retry hint', async () => {
    await setCaps({ capLuna: 500_000n }) // room for exactly one 5 NIM drop
    await createDrop()

    const res = await post('/api/drops', {
      idemKey: randomUUID(),
      body: { sponsorLabel: 'S', amountEach: AMOUNT_EACH_NIM, claimCount: CLAIM_COUNT },
    })
    const message = await expectEnvelope(res, 503, 'no_capacity')
    expect(message).toContain('0 NIM is free')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('says so plainly when the pilot runs one drop at a time', async () => {
    await setCaps({ capLuna: 10_000_000n, maxLiveDrops: 1 })
    await createDrop()

    const res = await post('/api/drops', {
      idemKey: randomUUID(),
      body: { sponsorLabel: 'S', amountEach: AMOUNT_EACH_NIM, claimCount: CLAIM_COUNT },
    })
    const message = await expectEnvelope(res, 503, 'no_capacity')
    expect(message).toMatch(/one at a time/i)

    const disclosure = await json<DisclosureBody>(await get('/api/custody'))
    expect(disclosure.limits.maxLiveDrops).toBe(1)
    expect(disclosure.limits.remainingDrops).toBe(0)
    expect(disclosure.points.find((p) => p.id === 'limits')?.text).toMatch(
      /Only one drop can run at a time/,
    )
  })

  // ---- the sponsor's claim window ------------------------------------------------
  //
  // The window is a decision now, and the two things that make it safe are both
  // asserted here: the bound is the SERVER'S (a client mirror is a convenience,
  // never the authority), and the disclosure the sponsor reads before funding
  // names the window this drop will actually have rather than a constant.

  async function readExpiry(publicId: string): Promise<{ hours: number; at: string | null }> {
    const body = await json<{ expiryHours: number; expiresAt: string | null }>(
      await get(`/api/drops/${publicId}`),
    )
    return { hours: body.expiryHours, at: body.expiresAt }
  }

  it('applies the 24 hour default when the field is absent, exactly as before', async () => {
    const draft = await createDrop()
    expect(draft.expiryHours).toBe(24)
    expect(draft.disclosure.expiryHours).toBe(24)
    expect(draft.disclosure.points.find((p) => p.id === 'expiry_clock')?.text).toMatch(
      /^The 24 hour claim window starts when the network confirms your funding/,
    )
    expect((await readExpiry(draft.publicId)).hours).toBe(24)
  })

  it('honours a non-default window from the draft through to the stamped deadline', async () => {
    const draft = await liveDrop({ expiryHours: 72 })
    expect(draft.expiryHours).toBe(72)

    const { hours, at } = await readExpiry(draft.publicId)
    expect(hours).toBe(72)
    // Three days from activation, not one. The clock still starts at
    // activation: the deadline is measured from now, not from draft creation.
    const ahead = Date.parse(at!) - Date.now()
    expect(ahead).toBeGreaterThan(71.9 * 3600_000)
    expect(ahead).toBeLessThan(72.1 * 3600_000)
  })

  it('refuses a window outside the bounds, server side, whatever the client believes', async () => {
    for (const expiryHours of [0, -1, 337, 720, 1.5, 24.0001]) {
      const res = await post('/api/drops', {
        idemKey: randomUUID(),
        body: {
          sponsorLabel: 'S',
          amountEach: AMOUNT_EACH_NIM,
          claimCount: CLAIM_COUNT,
          expiryHours,
        },
      })
      // A whole-number check is a shape refusal; a range check is a window
      // refusal. Both are 400, and neither creates a drop.
      expect([400], `expiryHours=${expiryHours} must be refused`).toContain(res.status)
      const body = await json(res)
      const code = (body.error as { code: string }).code
      expect(['invalid_request', 'invalid_expiry_window']).toContain(code)
    }
    // Both ends of the range ARE accepted, so the refusals above are the bound
    // and not an accident of validation order.
    expect((await createDrop({ body: { sponsorLabel: 'S', amountEach: AMOUNT_EACH_NIM, claimCount: CLAIM_COUNT, expiryHours: 1 } })).expiryHours).toBe(1)
    expect((await createDrop({ body: { sponsorLabel: 'S', amountEach: AMOUNT_EACH_NIM, claimCount: CLAIM_COUNT, expiryHours: 336 } })).expiryHours).toBe(336)
  })

  it('refuses a window that is not a number at all', async () => {
    const res = await post('/api/drops', {
      idemKey: randomUUID(),
      body: {
        sponsorLabel: 'S',
        amountEach: AMOUNT_EACH_NIM,
        claimCount: CLAIM_COUNT,
        expiryHours: '72',
      },
    })
    await expectEnvelope(res, 400, 'invalid_request')
  })

  /**
   * The security property, stated as a test.
   *
   * A sponsor who could shorten the window after people started claiming would
   * strand the remaining claimants and take their shares back as a refund. So
   * the value is fixed at draft creation and NO request body may move it. Every
   * request that could plausibly try is tried here.
   */
  it('does not let any request body change the window after activation', async () => {
    const draft = await liveDrop({ expiryHours: 168 })
    const before = await readExpiry(draft.publicId)
    expect(before.hours).toBe(168)

    const txHash = fundingHashFor(draft.publicId)

    // 1. The funding endpoint, carrying a window. Unknown properties are
    //    rejected outright rather than ignored, which is why this is a 400 and
    //    not a silent no-op.
    await expectEnvelope(
      await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash, expiryHours: 1 } }),
      400,
      'invalid_request',
    )

    // 2. The funding endpoint's ordinary idempotent replay. It re-runs the
    //    whole §7 predicate and re-enters `activate()`, which is the one place
    //    that ever writes `expires_at` — so if the deadline could be recomputed
    //    at all, it would move here.
    const replay = await post(`/api/drops/${draft.publicId}/funding`, { body: { txHash } })
    expect(replay.status).toBe(200)

    // 3. Creating "the same" drop again with a different window on the same
    //    idempotency key. The key is bound to a request hash that includes the
    //    window, so this is a conflict, not a quiet overwrite.
    const key = randomUUID()
    const body = {
      sponsorLabel: 'Nimiq Community',
      amountEach: AMOUNT_EACH_NIM,
      claimCount: CLAIM_COUNT,
      expiryHours: 24,
    }
    expect((await post('/api/drops', { idemKey: key, body })).status).toBe(201)
    await expectEnvelope(
      await post('/api/drops', { idemKey: key, body: { ...body, expiryHours: 336 } }),
      409,
      'idempotency_key_reused',
    )

    const after = await readExpiry(draft.publicId)
    expect(after.hours).toBe(168)
    expect(after.at, 'the deadline a claimant was shown must be the deadline').toBe(before.at)
  })

  it('states the window this drop will have in the disclosure, in the units a person says', async () => {
    const cases: [number, RegExp][] = [
      [1, /^The 1 hour claim window /],
      [6, /^The 6 hour claim window /],
      [24, /^The 24 hour claim window /],
      [72, /^The 3 day claim window /],
      [336, /^The 14 day claim window /],
    ]
    for (const [expiryHours, phrase] of cases) {
      const draft = await createDrop({
        body: {
          sponsorLabel: 'S',
          amountEach: AMOUNT_EACH_NIM,
          claimCount: CLAIM_COUNT,
          expiryHours,
        },
      })
      const point = draft.disclosure.points.find((p) => p.id === 'expiry_clock')?.text ?? ''
      expect(point, `expiryHours=${expiryHours}`).toMatch(phrase)
      // The consequence, stated rather than implied: a longer window is a
      // longer time the operator is holding the money — and, since the
      // sponsor's early close, the way out of it. A disclosure that named the
      // cost without naming the exit would be describing the old product.
      expect(point).toMatch(/operator holds your NIM for the whole window/)
      expect(point).toMatch(/only the wallet you fund from can end the drop early/)
      expect(draft.disclosure.expiryHours).toBe(expiryHours)
    }
  })

  it('describes the window the sponsor is considering on GET /api/custody', async () => {
    const chosen = await json<DisclosureBody>(await get('/api/custody?expiryHours=168'))
    expect(chosen.expiryHours).toBe(168)
    expect(chosen.points.find((p) => p.id === 'expiry_clock')?.text).toMatch(/The 7 day claim window/)

    // Omitted is the default, which is what a sponsor who has not chosen sees.
    const plain = await json<DisclosureBody>(await get('/api/custody'))
    expect(plain.expiryHours).toBe(24)

    // And the read endpoint refuses what the create endpoint would refuse: it
    // must never describe a window that could not actually be created.
    await expectEnvelope(await get('/api/custody?expiryHours=337'), 400, 'invalid_expiry_window')
    await expectEnvelope(await get('/api/custody?expiryHours=0'), 400, 'invalid_expiry_window')
    await expectEnvelope(await get('/api/custody?expiryHours=abc'), 400, 'invalid_request')
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
    // The exact key set, so a field added later has to be argued for here
    // rather than appearing on a public read by accident. `expiryHours` is the
    // sponsor's own published choice and is already derivable from
    // `expiresAt`; it says nothing about any claimant.
    expect(Object.keys(pub).sort()).toEqual([
      'amountEach',
      'claimCount',
      'expiresAt',
      'expiryHours',
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
      { sponsorLabel: 'S', amountEach: '1', claimCount: 2.5 },
      { sponsorLabel: 'S', amountEach: '1', claimCount: -5 },
      // Past the width of the INT column the count is stored in. Not a policy
      // ceiling — an impossible request answered as a 400 rather than a 500.
      { sponsorLabel: 'S', amountEach: '1', claimCount: 2_147_483_648 },
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

  /**
   * The live incident: production ran `SIG_SCHEME=raw`, a claimant approved in
   * Nimiq Pay, and the server refused a perfectly good signature. From the
   * outside it was indistinguishable from a wallet that declined — nobody could
   * see it but the claimant, and what they saw blamed their wallet.
   *
   * The refusal is correct and stays: the server must not start accepting bytes
   * it was not configured to accept. What changes is that it now says why, to
   * the one party who can fix it.
   */
  it('alerts the operator when a refused signature fits the OTHER SIG_SCHEME', async () => {
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })

    const draft = await liveDrop()
    const wallet = newWallet()
    const issued = await challenge(draft.publicId)
    const res = await post(`/api/drops/${draft.publicId}/claims`, {
      idemKey: randomUUID(),
      body: {
        challengeId: issued.challengeId,
        publicKey: wallet.publicKeyHex,
        signature: wallet.signLikeNimiqPay(issued.message),
      },
    })

    const message = await expectEnvelope(res, 409, 'invalid_signature')
    // The claimant is not blamed and is not told to blame their wallet.
    expect(message).not.toMatch(/wallet signature/i)
    expect(message).toMatch(/nothing was claimed/i)

    const alert = warnings.find((line) => line.includes('sig_scheme_mismatch'))
    expect(alert).toBeDefined()
    const parsed = JSON.parse(alert as string) as Record<string, unknown>
    expect(parsed.alert).toBe('sig_scheme_mismatch')
    expect(parsed.detail).toMatchObject({
      configured: 'raw',
      verifiesUnder: 'nimiq-signed-message',
      walletScheme: 'nimiq-signed-message',
    })

    // And a signature that is simply wrong stays an ordinary refusal.
    warnings.length = 0
    const other = await challenge(draft.publicId)
    await expectEnvelope(
      await post(`/api/drops/${draft.publicId}/claims`, {
        idemKey: randomUUID(),
        body: {
          challengeId: other.challengeId,
          publicKey: wallet.publicKeyHex,
          signature: newWallet().sign(other.message),
        },
      }),
      409,
      'invalid_signature',
    )
    expect(warnings.some((line) => line.includes('sig_scheme_mismatch'))).toBe(false)
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
    app = makeApp({ pool, chain: broken, alerts: consoleAlerts(), now, clientIp })

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
      clientIp,
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
    app = makeApp({ pool, chain: broken, alerts: consoleAlerts(), now, clientIp })

    const res = await get('/health')
    expect(res.status).toBe(503)
    const body = await json(res)
    expect(body).toEqual({ ok: false, headHeight: null, workerFresh: false })
  })
})
