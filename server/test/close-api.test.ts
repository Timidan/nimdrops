import { KeyPair } from '@nimiq/core'
import type { Hono } from 'hono'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { migrate } from '../src/db/migrate'
import { makeApp } from '../src/http/app'
import { consoleAlerts } from '../src/services/alerts'
import { createDraft, submitFunding } from '../src/services/drops'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The two HTTP routes the sponsor's close is reachable through, and the status
 * codes a screen branches on.
 *
 * `close.race.test.ts` owns the money and the concurrency; this file owns the
 * boundary: that a body is validated before anything is looked up, that a wrong
 * wallet is a 403 and a closed drop a 409, and that a refusal never says more
 * than the envelope allows.
 *
 * Its own Postgres schema, for the same reason every other suite here has one:
 * it drives the singleton `custody_controls` row and global aggregates.
 */
const SCHEMA = 'close_api_test'

const CUSTODY = 'NQ07 CUSTODY'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100
const FEE_FLOAT = 100_000n
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5

let pool: pg.Pool
let chain: FakeChain
let app: Hono

interface Wallet {
  publicKeyHex: string
  address: string
  sign(message: string): string
}

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
  c.deposit({
    hash: 'operator-fee-float',
    sender: 'NQ07 OPERATOR',
    recipient: CUSTODY,
    valueLuna: FEE_FLOAT,
    includedHeight: 1,
  })
  return c
}

async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function expectEnvelope(res: Response, status: number, code: string): Promise<void> {
  expect(res.status, `expected ${status} ${code}`).toBe(status)
  const body = await json(res)
  expect(Object.keys(body)).toEqual(['error'])
  const error = body.error as Record<string, unknown>
  expect(Object.keys(error).sort()).toEqual(['code', 'message'])
  expect(error.code).toBe(code)
  const message = error.message as string
  expect(typeof message).toBe('string')
  expect(message).not.toMatch(/\n\s*at /)
  expect(message).not.toMatch(/node_modules|\/src\/|SELECT |INSERT /)
}

interface LiveDrop {
  publicId: string
  sponsor: Wallet
}

async function liveDrop(): Promise<LiveDrop> {
  const sponsor = newWallet()
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount: CLAIM_COUNT,
  })
  const hash = `tx-${draft.publicId}`
  const height = Math.max(await chain.headHeight(), FUND_HEIGHT)
  chain.deposit({
    hash,
    sender: sponsor.address,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(CLAIM_COUNT),
    dataUtf8: draft.fundingMemo,
    includedHeight: height,
  })
  chain.setHead(height + FINALITY_DEPTH)
  await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  return { publicId: draft.publicId, sponsor }
}

interface ChallengeBody {
  challengeId: string
  message: string
  expiresAt: string
}

async function closeChallenge(publicId: string): Promise<ChallengeBody> {
  const res = await post(`/api/drops/${publicId}/close/challenge`)
  expect(res.status).toBe(200)
  return json<ChallengeBody>(res)
}

describe.skipIf(!hasDb)('POST /api/drops/:publicId/close (real Postgres)', () => {
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
           max_live_principal_luna = 10000000,
           configured_fee_reserve_luna = ${FEE_FLOAT},
           operator_float_luna = ${FEE_FLOAT},
           reconciled_confirmed_balance_luna = NULL,
           last_reconciled_height = NULL,
           last_reconciled_at = NULL
       WHERE singleton`,
    )
    chain = newChain()
    app = makeApp({ pool, chain, alerts: consoleAlerts() })
  })

  afterEach(setEnv)

  function setEnv(): void {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'close-api-test-secret'
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

  it('closes on a signature from the funder and answers 202 with the refund', async () => {
    const { publicId, sponsor } = await liveDrop()
    const challenge = await closeChallenge(publicId)
    // The message the wallet is asked to sign names the action and the drop.
    const parsed = JSON.parse(challenge.message) as Record<string, unknown>
    expect(parsed.action).toBe('close')
    expect(parsed.drop).toBe(publicId)
    expect(parsed.aud).toBe(ORIGIN)

    const res = await post(`/api/drops/${publicId}/close`, {
      challengeId: challenge.challengeId,
      publicKey: sponsor.publicKeyHex,
      signature: sponsor.sign(challenge.message),
    })
    expect(res.status).toBe(202)

    const body = await json(res)
    expect(body).toMatchObject({
      claimedShares: 0,
      unclaimedShares: CLAIM_COUNT,
      refund: '5',
      refundLuna: (AMOUNT_EACH * BigInt(CLAIM_COUNT)).toString(),
    })
    // The drop comes back in the same body, from the committed row.
    expect((body.drop as Record<string, unknown>).state).toBe('closing')
    // And carries no address, no claimant and no row id.
    expect(JSON.stringify(body)).not.toContain(sponsor.address)
  })

  it('answers 403 for a wallet that did not fund the drop', async () => {
    const { publicId } = await liveDrop()
    const stranger = newWallet()
    const challenge = await closeChallenge(publicId)

    const res = await post(`/api/drops/${publicId}/close`, {
      challengeId: challenge.challengeId,
      publicKey: stranger.publicKeyHex,
      signature: stranger.sign(challenge.message),
    })
    await expectEnvelope(res, 403, 'not_the_funder')
  })

  it('answers 409 for a drop that is already closed', async () => {
    const { publicId, sponsor } = await liveDrop()
    const first = await closeChallenge(publicId)
    const second = await closeChallenge(publicId)

    expect(
      (
        await post(`/api/drops/${publicId}/close`, {
          challengeId: first.challengeId,
          publicKey: sponsor.publicKeyHex,
          signature: sponsor.sign(first.message),
        })
      ).status,
    ).toBe(202)

    await expectEnvelope(
      await post(`/api/drops/${publicId}/close`, {
        challengeId: second.challengeId,
        publicKey: sponsor.publicKeyHex,
        signature: sponsor.sign(second.message),
      }),
      409,
      'already_closed',
    )
  })

  it('refuses to mint a close challenge for a drop that was never funded', async () => {
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'Sponsor',
      amountEachLuna: AMOUNT_EACH,
      claimCount: 2,
    })
    await expectEnvelope(
      await post(`/api/drops/${draft.publicId}/close/challenge`),
      409,
      'drop_not_funded',
    )
  })

  it('validates the body before it looks anything up', async () => {
    const { publicId } = await liveDrop()
    for (const body of [
      {},
      { challengeId: 'not-a-uuid', publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) },
      { challengeId: '11111111-2222-4333-8444-555555555555', publicKey: 'zz', signature: 'b'.repeat(128) },
      {
        challengeId: '11111111-2222-4333-8444-555555555555',
        publicKey: 'a'.repeat(64),
        signature: 'b'.repeat(128),
        // An unknown property is rejected, never ignored.
        refundTo: 'NQ07 ATTACKER',
      },
    ]) {
      await expectEnvelope(await post(`/api/drops/${publicId}/close`, body), 400, 'invalid_request')
    }
  })

  it('is a uniform 404 for a malformed or unknown drop id', async () => {
    await expectEnvelope(await post('/api/drops/nope/close/challenge'), 404, 'not_found')
    await expectEnvelope(
      await post('/api/drops/Zz9Yy8Xx7Ww6Vv5Uu4Tt3S/close/challenge'),
      404,
      'not_found',
    )
  })

  it('serves the app shell at /drop/:publicId/close and reveals nothing about the drop', async () => {
    const { publicId } = await liveDrop()
    const res = await app.request(`/drop/${publicId}/close`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<div id="root"></div>')
    // The head must be the generic one: a URL anyone can construct may not
    // confirm that a drop exists, let alone who is sharing it.
    expect(html).toContain('<meta name="robots" content="noindex" />')
    expect(html).toContain('Someone is sharing NIM')
    expect(html).not.toContain('Sponsor')
    expect(html).not.toContain(publicId)

    // And a malformed id is refused rather than served.
    expect((await app.request('/drop/nope/close')).status).toBe(404)
  })
})
