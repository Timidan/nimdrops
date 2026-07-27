import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import pg from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import type { Queryable } from '../src/db/pool'
import { migrate } from '../src/db/migrate'
import { makeApp } from '../src/http/app'
import { consoleAlerts } from '../src/services/alerts'
import {
  QUESTIONS_ANSWERED,
  StatsCache,
  StatsUnavailableError,
  computePublicStats,
  type PublicStats,
} from '../src/services/stats'
// Side-effect import: installs the int8-as-string parser, so a BIGINT sum never
// passes through a lossy JS number on its way out of the database.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Global aggregates, so this suite needs a schema nothing else writes to.
 *
 * `public` is deliberately NOT on this suite's `search_path`, unlike the other
 * integration suites. The whole point of half these tests is what happens when
 * `trivia_answers` does not exist, and `to_regclass` resolves through the search
 * path — a copy of that table in `public`, left by any other branch or suite
 * sharing this database, would silently turn the absence tests into presence
 * tests. Production keeps the ordinary path, which is exactly why the probe
 * finds the real tables there once they land.
 */
const SCHEMA = 'stats_test'

// ---- unit: shape and caching, against a fake database -------------------------------

interface FakeRow {
  paid_out_luna: string
  unique_wallets_paid: number
  drops_funded: number
  shares_claimed: number
  trivia_present: boolean
}

const EMPTY_ROW: FakeRow = {
  paid_out_luna: '0',
  unique_wallets_paid: 0,
  drops_funded: 0,
  shares_claimed: 0,
  trivia_present: false,
}

/**
 * A database that counts what it was asked and can be made to hang or fail on
 * demand. The caching tests are about how MANY queries happen, which is exactly
 * what a real Postgres makes hard to observe.
 */
class FakeDb implements Queryable {
  aggregateCalls = 0
  triviaCalls = 0
  row: FakeRow = { ...EMPTY_ROW }
  answered = 0
  failWith: Error | null = null
  triviaFailWith: Error | null = null
  /** When set, the next aggregate query blocks until this is resolved. */
  gate: Promise<void> | null = null

  async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
    // `to_regclass('trivia_answers')` lives in the aggregate statement too, so
    // the two are told apart by the FROM clause rather than by the table name.
    if (text.includes('FROM trivia_answers')) {
      this.triviaCalls += 1
      if (this.triviaFailWith) throw this.triviaFailWith
      return rows<R>([{ questions_answered: this.answered }])
    }
    this.aggregateCalls += 1
    if (this.gate) await this.gate
    if (this.failWith) throw this.failWith
    return rows<R>([this.row])
  }
}

function rows<R extends QueryResultRow>(value: unknown[]): QueryResult<R> {
  return { rows: value } as unknown as QueryResult<R>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Let a fire-and-forget background refresh settle before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('computePublicStats', () => {
  it('reports exact luna as a string, never a JS number', async () => {
    const db = new FakeDb()
    // Larger than Number.MAX_SAFE_INTEGER: a value that a lossy read mangles.
    db.row = { ...EMPTY_ROW, paid_out_luna: '9007199254740993' }

    const { stats } = await computePublicStats(db)

    expect(stats.totalPaidOutLuna).toBe('9007199254740993')
    expect(typeof stats.totalPaidOutLuna).toBe('string')
    // 1 NIM = 100000 luna, and the decimal form is exact — nothing is rounded.
    expect(stats.totalPaidOut).toBe('90071992547.40993')
  })

  it('formats a whole number of NIM without a decimal point', async () => {
    const db = new FakeDb()
    db.row = { ...EMPTY_ROW, paid_out_luna: '200000' }
    const { stats } = await computePublicStats(db)
    expect(stats.totalPaidOut).toBe('2')
    expect(stats.totalPaidOutLuna).toBe('200000')
  })

  it('omits questionsAnswered and names it unavailable when the table is absent', async () => {
    const db = new FakeDb()
    const snapshot = await computePublicStats(db)

    expect(snapshot.unavailable).toEqual([QUESTIONS_ANSWERED])
    expect(QUESTIONS_ANSWERED in snapshot.stats).toBe(false)
    // The whole point: absent is not the same as zero, and never becomes zero.
    expect(snapshot.stats.questionsAnswered).toBeUndefined()
    expect(db.triviaCalls).toBe(0)
  })

  it('reports questionsAnswered and an empty unavailable list once the table exists', async () => {
    const db = new FakeDb()
    db.row = { ...EMPTY_ROW, trivia_present: true }
    db.answered = 17

    const snapshot = await computePublicStats(db)

    expect(snapshot.stats.questionsAnswered).toBe(17)
    expect(snapshot.unavailable).toEqual([])
    expect(db.triviaCalls).toBe(1)
  })

  it('treats an undefined_table error from the trivia count as unavailable, not as a failure', async () => {
    const db = new FakeDb()
    db.row = { ...EMPTY_ROW, trivia_present: true, paid_out_luna: '100000' }
    db.triviaFailWith = Object.assign(new Error('relation "trivia_answers" does not exist'), {
      code: '42P01',
    })

    const snapshot = await computePublicStats(db)

    // The money figures still arrive: a statistic that cannot be measured must
    // not take down the ones that can.
    expect(snapshot.stats.totalPaidOutLuna).toBe('100000')
    expect(snapshot.unavailable).toEqual([QUESTIONS_ANSWERED])
  })

  it('does not swallow an unrelated error from the trivia count', async () => {
    const db = new FakeDb()
    db.row = { ...EMPTY_ROW, trivia_present: true }
    db.triviaFailWith = Object.assign(new Error('connection terminated'), { code: '08006' })
    await expect(computePublicStats(db)).rejects.toThrow('connection terminated')
  })

  it('propagates a real database error rather than reporting zeroes', async () => {
    const db = new FakeDb()
    db.failWith = new Error('connection terminated')
    await expect(computePublicStats(db)).rejects.toThrow('connection terminated')
  })

  it('stamps generatedAt from the injected clock, not the request time', async () => {
    const db = new FakeDb()
    const snapshot = await computePublicStats(db, () => 1_700_000_000_000)
    expect(snapshot.generatedAt).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('StatsCache', () => {
  let clock: number
  const now = (): number => clock

  beforeEach(() => {
    clock = 1_700_000_000_000
  })

  it('serves the same snapshot from memory for the whole TTL', async () => {
    const db = new FakeDb()
    const cache = new StatsCache(db, { now, ttlMs: 60_000 })

    const first = await cache.read()
    clock += 59_999
    const second = await cache.read()

    expect(db.aggregateCalls).toBe(1)
    expect(second).toBe(first)
    expect(second.generatedAt).toBe(first.generatedAt)
  })

  it('answers a stale read from memory and refreshes behind it', async () => {
    const db = new FakeDb()
    const gate = deferred()
    const cache = new StatsCache(db, { now, ttlMs: 60_000, staleGraceMs: 600_000 })

    const first = await cache.read()
    clock += 60_000
    db.gate = gate.promise

    // The refresh is blocked, and the read still returns immediately: no public
    // request waits on the database while a real answer is already in hand.
    const immediate = await cache.read()
    expect(immediate).toBe(first)
    expect(db.aggregateCalls).toBe(2)

    gate.resolve()
    await flush()

    const refreshed = await cache.read()
    expect(db.aggregateCalls).toBe(2)
    expect(refreshed).not.toBe(first)
    expect(refreshed.generatedAt).toBe(new Date(clock).toISOString())
  })

  it('starts at most one background refresh for a burst of stale reads', async () => {
    const db = new FakeDb()
    const gate = deferred()
    const cache = new StatsCache(db, { now, ttlMs: 60_000, staleGraceMs: 600_000 })

    await cache.read()
    clock += 60_000
    db.gate = gate.promise

    await Promise.all(Array.from({ length: 200 }, () => cache.read()))
    expect(db.aggregateCalls).toBe(2)

    gate.resolve()
    await flush()
  })

  it('collapses a cold-cache burst into a single query', async () => {
    const db = new FakeDb()
    const gate = deferred()
    db.gate = gate.promise
    const cache = new StatsCache(db, { now, ttlMs: 60_000 })

    // 200 simultaneous requests against an empty cache. If this endpoint queried
    // per request it would take 200 connections out of a pool that is also
    // paying claimants.
    const burst = Promise.all(Array.from({ length: 200 }, () => cache.read()))
    gate.resolve()
    const answers = await burst

    expect(db.aggregateCalls).toBe(1)
    for (const answer of answers) expect(answer).toBe(answers[0])
  })

  it('serves the last real snapshot while a refresh is failing', async () => {
    const db = new FakeDb()
    db.row = { ...EMPTY_ROW, paid_out_luna: '100000' }
    const cache = new StatsCache(db, { now, ttlMs: 60_000, staleGraceMs: 600_000 })
    const fresh = await cache.read()

    db.failWith = new Error('connection terminated')
    clock += 60_000
    const stale = await cache.read()
    await flush()

    // A real query result, and it says so: generatedAt is still the old one, so
    // the page cannot present it as current.
    expect(stale).toBe(fresh)
    expect(stale.generatedAt).toBe(fresh.generatedAt)
    expect(stale.stats.totalPaidOutLuna).toBe('100000')

    // And the failed refresh does not become a retry per request.
    for (let i = 0; i < 20; i++) expect(await cache.read()).toBe(fresh)
    expect(db.aggregateCalls).toBe(2)
  })

  it('does not re-query on every request while the database is failing', async () => {
    const db = new FakeDb()
    db.failWith = new Error('connection terminated')
    const cache = new StatsCache(db, { now, ttlMs: 60_000, failureBackoffMs: 5_000 })

    for (let i = 0; i < 25; i++) {
      await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)
    }
    expect(db.aggregateCalls).toBe(1)

    clock += 5_000
    await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)
    expect(db.aggregateCalls).toBe(2)
  })

  it('stops serving a stale snapshot once it is past the grace window', async () => {
    const db = new FakeDb()
    const cache = new StatsCache(db, {
      now,
      ttlMs: 60_000,
      staleGraceMs: 120_000,
      failureBackoffMs: 0,
    })
    await cache.read()

    db.failWith = new Error('connection terminated')
    clock += 119_999
    await expect(cache.read()).resolves.toBeDefined()
    await flush()

    // One millisecond past the grace window, a snapshot nobody can refresh stops
    // being an answer: "unchanged for two minutes" must not look like "we lost
    // the database two minutes ago".
    clock += 1
    await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)
  })

  it('refuses rather than waiting forever on a hung database, and starts no second query', async () => {
    const db = new FakeDb()
    const gate = deferred()
    db.gate = gate.promise
    const cache = new StatsCache(db, {
      now,
      ttlMs: 60_000,
      failureBackoffMs: 5_000,
      refreshTimeoutMs: 20,
    })

    // Cold cache, so there is nothing to serve and the caller must wait — but a
    // hung Postgres cannot be allowed to hold public requests open in the same
    // process that pays claimants.
    await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)

    // The query is still stuck. Nothing starts a second one on top of it.
    for (let i = 0; i < 20; i++) {
      await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)
    }
    clock += 5_000
    await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)
    expect(db.aggregateCalls).toBe(1)

    gate.resolve()
    await flush()
    // Once it finally lands, the next read is served normally.
    expect((await cache.read()).stats.totalPaidOutLuna).toBe('0')
  })

  it('recovers on the next successful refresh', async () => {
    const db = new FakeDb()
    const cache = new StatsCache(db, { now, ttlMs: 60_000, failureBackoffMs: 5_000 })
    db.failWith = new Error('connection terminated')
    await expect(cache.read()).rejects.toBeInstanceOf(StatsUnavailableError)

    db.failWith = null
    db.row = { ...EMPTY_ROW, paid_out_luna: '300000' }
    clock += 5_000

    const recovered = await cache.read()
    expect(recovered.stats.totalPaidOutLuna).toBe('300000')
  })

  it('carries no error detail on the refusal it throws', async () => {
    const db = new FakeDb()
    db.failWith = new Error('password authentication failed for user "nimdrops"')
    const cache = new StatsCache(db, { now, ttlMs: 60_000 })

    await expect(cache.read()).rejects.toThrow(/^statistics are temporarily unavailable$/)
  })
})

// ---- integration: real Postgres ------------------------------------------------------

const CUSTODY = 'NQ07 CUSTODY'
const ORIGIN = 'https://nimdrops.test'

let pool: pg.Pool
let app: Hono

interface SeedPayout {
  /** The recipient of this payout. Deliberately distinctive, so a leak is visible. */
  address: string
  amountLuna: bigint
  /** `outgoing_transfers.state`. */
  transferState: 'queued' | 'in_progress' | 'confirmed' | 'manual_review'
  /** `transaction_attempts.state`, or `none` for an intent with no attempt yet. */
  attemptState: 'none' | 'signed' | 'broadcast' | 'confirmed' | 'proven_dead'
  purpose?: 'payout' | 'refund'
}

let seq = 0

/** One activated drop with one claim and one outgoing transfer per payout. */
async function seedDrop(payouts: SeedPayout[], o: { activated?: boolean } = {}): Promise<void> {
  seq += 1
  const dropId = randomUUID()
  const claimCount = Math.max(2, payouts.length)
  const amountEach = 100_000n
  const activated = o.activated ?? true

  await pool.query(
    `INSERT INTO drops (id, public_id, sponsor_label, claim_count, amount_each_luna,
                        expected_funding_luna, state, activated_height, funding_tx_hash)
     VALUES ($1, $2, 'Seed', $3, $4, $5, $6, $7, $8)`,
    [
      dropId,
      `seed-${String(seq).padStart(4, '0')}`.padEnd(22, 'x'),
      claimCount,
      amountEach.toString(),
      (amountEach * BigInt(claimCount)).toString(),
      activated ? 'live' : 'awaiting_funding',
      activated ? '1000' : null,
      activated ? `${'f'.repeat(60)}${String(seq).padStart(4, '0')}` : null,
    ],
  )

  for (const [index, payout] of payouts.entries()) {
    const claimId = randomUUID()
    const transferId = randomUUID()
    await pool.query(
      `INSERT INTO claims (id, drop_id, slot_index, recipient_address, status_token_hash, state)
       VALUES ($1, $2, $3, $4, $5, 'reserved')`,
      [claimId, dropId, index, payout.address, `${transferId}-token`],
    )
    const purpose = payout.purpose ?? 'payout'
    await pool.query(
      `INSERT INTO outgoing_transfers (id, idempotency_key, purpose, drop_id, claim_id,
                                       recipient_address, amount_luna, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        transferId,
        `${purpose}:${transferId}`,
        purpose,
        dropId,
        purpose === 'payout' ? claimId : null,
        payout.address,
        payout.amountLuna.toString(),
        payout.transferState,
      ],
    )
    if (payout.attemptState === 'none') continue
    await pool.query(
      `INSERT INTO transaction_attempts (transfer_id, sequence, state, raw_signed_tx, tx_hash,
                                         fee_luna, validity_start_height)
       VALUES ($1, 1, $2, $3, $4, 100, 1000)`,
      [transferId, payout.attemptState, Buffer.from('00', 'hex'), `${transferId.replace(/-/g, '')}${'a'.repeat(32)}`.slice(0, 64)],
    )
  }
}

async function readStats(): Promise<PublicStats> {
  return computePublicStats(pool)
}

describe.skipIf(!hasDb)('public stats (real Postgres)', () => {
  const saved = { network: process.env.NIMIQ_NETWORK, origin: process.env.PUBLIC_ORIGIN }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
      max: 4,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
    if (saved.network === undefined) delete process.env.NIMIQ_NETWORK
    else process.env.NIMIQ_NETWORK = saved.network
    if (saved.origin === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = saved.origin
  })

  beforeEach(async () => {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    await pool.query(
      `TRUNCATE transaction_attempts, outgoing_transfers, wallet_challenges, claims, drops,
       operator_float_deposits, custody_deposit_owners, http_idempotency RESTART IDENTITY CASCADE`,
    )
    seq = 0
    app = makeApp({
      pool,
      chain: new FakeChain({ custody: CUSTODY, finalityDepth: 5, headHeight: 100 }),
      alerts: consoleAlerts(),
      // Never cache between tests: each one seeds different rows.
      statsCache: { ttlMs: 0 },
    })
  })

  it('reports honest zeroes on an empty database', async () => {
    const snapshot = await readStats()
    expect(snapshot.stats).toEqual({
      totalPaidOut: '0',
      totalPaidOutLuna: '0',
      uniqueWalletsPaid: 0,
      dropsFunded: 0,
      sharesClaimed: 0,
      // Zero, not absent. This suite was written before the gates migrations
      // landed, when `trivia_answers` genuinely did not exist and the honest
      // answer was "cannot measure". Migration 015 creates the table on every
      // deployment now, so nobody has answered a question yet is a MEASURED
      // zero — which is the distinction `unavailable` exists to preserve.
      questionsAnswered: 0,
    })
    expect(snapshot.unavailable).toEqual([])
  })

  it('reports a single settled payout exactly', async () => {
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 40_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    const { stats } = await readStats()
    expect(stats.totalPaidOutLuna).toBe('40000')
    expect(stats.totalPaidOut).toBe('0.4')
    expect(stats.uniqueWalletsPaid).toBe(1)
    expect(stats.dropsFunded).toBe(1)
    expect(stats.sharesClaimed).toBe(1)
  })

  it('counts only payouts that reached finality on both the intent and an attempt', async () => {
    await seedDrop([
      // Settled: the only one that may appear in the total.
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 100_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
      // Queued: nothing has been signed.
      {
        address: 'NQ11 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB',
        amountLuna: 100_000n,
        transferState: 'queued',
        attemptState: 'none',
      },
      // Broadcast is not paid.
      {
        address: 'NQ11 CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC',
        amountLuna: 100_000n,
        transferState: 'in_progress',
        attemptState: 'broadcast',
      },
      // An operator is looking at it; nobody can say what the chain did.
      {
        address: 'NQ11 DDDD DDDD DDDD DDDD DDDD DDDD DDDD DDDD',
        amountLuna: 100_000n,
        transferState: 'manual_review',
        attemptState: 'signed',
      },
      // Proven never to have landed.
      {
        address: 'NQ11 EEEE EEEE EEEE EEEE EEEE EEEE EEEE EEEE',
        amountLuna: 100_000n,
        transferState: 'in_progress',
        attemptState: 'proven_dead',
      },
      // A `confirmed` intent whose attempt is not confirmed: unreachable through
      // the code, and still excluded, so one bad row cannot inflate the total.
      {
        address: 'NQ11 FFFF FFFF FFFF FFFF FFFF FFFF FFFF FFFF',
        amountLuna: 100_000n,
        transferState: 'confirmed',
        attemptState: 'broadcast',
      },
      // The mirror image: a confirmed attempt under an unconfirmed intent.
      {
        address: 'NQ11 GGGG GGGG GGGG GGGG GGGG GGGG GGGG GGGG',
        amountLuna: 100_000n,
        transferState: 'in_progress',
        attemptState: 'confirmed',
      },
    ])

    const { stats } = await readStats()
    expect(stats.totalPaidOutLuna).toBe('100000')
    expect(stats.uniqueWalletsPaid).toBe(1)
    // Every one of them is still a share somebody claimed.
    expect(stats.sharesClaimed).toBe(7)
  })

  it('excludes refunds from money paid out', async () => {
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 100_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])
    await seedDrop([
      {
        address: 'NQ11 SPON SPON SPON SPON SPON SPON SPON SPON',
        amountLuna: 900_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
        purpose: 'refund',
      },
    ])

    const { stats } = await readStats()
    // A refund is the sponsor's own money coming back, not a payout.
    expect(stats.totalPaidOutLuna).toBe('100000')
    expect(stats.uniqueWalletsPaid).toBe(1)
  })

  it('counts a wallet once when it claimed from two drops', async () => {
    const repeat = 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA'
    for (const _ of [0, 1]) {
      await seedDrop([
        { address: repeat, amountLuna: 50_000n, transferState: 'confirmed', attemptState: 'confirmed' },
        {
          address: `NQ11 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BB${String(seq).padStart(2, '0')}`,
          amountLuna: 50_000n,
          transferState: 'confirmed',
          attemptState: 'confirmed',
        },
      ])
    }

    const { stats } = await readStats()
    expect(stats.uniqueWalletsPaid).toBe(3)
    expect(stats.totalPaidOutLuna).toBe('200000')
    expect(stats.dropsFunded).toBe(2)
  })

  it('counts only drops whose funding was verified and finalized', async () => {
    await seedDrop([], { activated: true })
    await seedDrop([], { activated: false })

    const { stats } = await readStats()
    expect(stats.dropsFunded).toBe(1)
  })

  it('sums BIGINT luna without going through a JS number', async () => {
    // Two payouts whose exact sum is not representable as a double.
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 9_007_199_254_740_992n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
      {
        address: 'NQ11 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB',
        amountLuna: 1n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    const { stats } = await readStats()
    expect(stats.totalPaidOutLuna).toBe('9007199254740993')
  })

  // ---- the endpoint ------------------------------------------------------------------

  it('serves the aggregate over HTTP with a cache header and nothing else', async () => {
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 40_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    const res = await app.request('/api/stats')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/)

    const body = (await res.json()) as PublicStats
    // The exact top-level key set. Asserting it is what stops an operational
    // field being smuggled in later.
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'stats', 'unavailable'])
    expect(Object.keys(body.stats).sort()).toEqual([
      'dropsFunded',
      'questionsAnswered',
      'sharesClaimed',
      'totalPaidOut',
      'totalPaidOutLuna',
      'uniqueWalletsPaid',
    ])
    expect(body.stats.totalPaidOutLuna).toBe('40000')
    // Empty since the gates migrations landed: `trivia_answers` exists on every
    // deployment, so there is nothing this endpoint cannot measure.
    expect(body.unavailable).toEqual([])
  })

  it('publishes no address and no per-wallet detail', async () => {
    const addresses = [
      'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
      'NQ11 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB',
      'NQ11 CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC',
    ]
    await seedDrop(
      addresses.map((address, i) => ({
        address,
        amountLuna: BigInt((i + 1) * 10_000),
        transferState: 'confirmed' as const,
        attemptState: 'confirmed' as const,
      })),
    )

    const text = await (await app.request('/api/stats')).text()

    for (const address of addresses) {
      expect(text).not.toContain(address)
      expect(text).not.toContain(address.replace(/ /g, ''))
    }
    // No address in any form, spaced or not: `NQ` cannot appear at all.
    expect(text).not.toMatch(/NQ/i)
    // No per-wallet amounts either — only the sum, which is 60000, and never
    // the 10000 / 20000 / 30000 that make it up.
    expect(text).toContain('"totalPaidOutLuna":"60000"')
    for (const each of ['10000', '20000', '30000']) {
      expect(text).not.toContain(`"${each}"`)
    }
    // And nothing operational: no custody balance, float, pause flag, queue
    // depth or reconciliation freshness.
    for (const forbidden of [
      'custody',
      'balance',
      'float',
      'paused',
      'reserve',
      'queued',
      'manual_review',
      'reconcil',
      'headHeight',
      'txHash',
      'publicId',
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('answers correctly while the trivia tables do not exist, and picks them up when they do', async () => {
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 40_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    // 1. Absent. This used to be the state the deployment was actually in; the
    //    gates migrations now create `trivia_answers` everywhere, so absence has
    //    to be simulated by dropping it. The BEHAVIOUR is still worth pinning —
    //    a deployment reads stats for one TTL after a migration lands, and any
    //    future table this service learns to read starts out missing.
    await pool.query(`DROP TABLE IF EXISTS ${SCHEMA}.trivia_answers CASCADE`)
    const before = (await (await app.request('/api/stats')).json()) as PublicStats
    expect(before.stats.totalPaidOutLuna).toBe('40000')
    expect(before.unavailable).toEqual([QUESTIONS_ANSWERED])
    expect(QUESTIONS_ANSWERED in before.stats).toBe(false)

    // 2. Present. A stand-in carrying only the two things `services/stats.ts`
    //    reads: the name `trivia_answers` and an `answered_at` that is NULL
    //    until the player submits. The real migration (015_gates.sql) now ships
    //    both, and if either is ever renamed THIS TEST is where that is caught,
    //    before the landing page under-reports in silence.
    try {
      await pool.query(`
        CREATE TABLE ${SCHEMA}.trivia_answers (
          session_id     UUID NOT NULL,
          question_index INT  NOT NULL,
          question_id    TEXT NOT NULL,
          delivered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          deadline_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          answered_at    TIMESTAMPTZ NULL,
          answer_index   INT NULL,
          is_correct     BOOL NULL,
          PRIMARY KEY (session_id, question_index)
        )
      `)
      const session = randomUUID()
      await pool.query(
        `INSERT INTO ${SCHEMA}.trivia_answers (session_id, question_index, question_id, answered_at)
         VALUES ($1, 0, 'q0', now()), ($1, 1, 'q1', now()), ($1, 2, 'q2', NULL)`,
        [session],
      )

      // `ttlMs: 0` expires the snapshot instantly but does NOT make the read
      // synchronous: inside the stale grace the cache answers from memory and
      // refreshes BEHIND the request. So the first read after the DDL still
      // describes a world without the table — which is exactly what a live
      // deployment does for one TTL after the migration lands, and is worth
      // knowing rather than designing away.
      //
      // That refresh is a real database round trip, so a microtask flush is
      // not enough to see it land. Poll instead of sleeping on a guessed
      // duration: a fixed wait either flakes on a slow machine or wastes time
      // on a fast one. What is being proven is that the stat appears without
      // a restart, not how many milliseconds it takes.
      let after = (await (await app.request('/api/stats')).json()) as PublicStats
      for (let attempt = 0; attempt < 50 && after.stats.questionsAnswered === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        after = (await (await app.request('/api/stats')).json()) as PublicStats
      }
      // Delivered-but-unanswered does not count: "answered" means answered.
      expect(after.stats.questionsAnswered).toBe(2)
      expect(after.unavailable).toEqual([])
      // Purely additive — every key a client already reads is untouched.
      expect(after.stats.totalPaidOutLuna).toBe(before.stats.totalPaidOutLuna)
      expect(after.stats.uniqueWalletsPaid).toBe(before.stats.uniqueWalletsPaid)
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${SCHEMA}.trivia_answers`)
    }
  })

  it('caches the endpoint rather than querying per request', async () => {
    await seedDrop([
      {
        address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA',
        amountLuna: 40_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    // A real TTL this time, and a clock that does not advance.
    const cached = makeApp({
      pool,
      chain: new FakeChain({ custody: CUSTODY, finalityDepth: 5, headHeight: 100 }),
      alerts: consoleAlerts(),
      now: () => 1_700_000_000_000,
      // The per-IP limiter would otherwise stop this burst before the cache did.
      limits: { ipPerWindow: 1000 },
    })

    const first = (await (await cached.request('/api/stats')).json()) as PublicStats

    // Seed more money AFTER the first read. A cached response must not see it.
    await seedDrop([
      {
        address: 'NQ11 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB',
        amountLuna: 60_000n,
        transferState: 'confirmed',
        attemptState: 'confirmed',
      },
    ])

    const bodies = await Promise.all(
      Array.from({ length: 50 }, async () => (await (await cached.request('/api/stats')).json()) as PublicStats),
    )
    for (const body of bodies) {
      expect(body.stats.totalPaidOutLuna).toBe('40000')
      expect(body.generatedAt).toBe(first.generatedAt)
    }
  })
})
