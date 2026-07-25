import { randomUUID } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { nimiqChainFromEnv } from '../src/chain/nimiq'
import { MEMO_MAX_BYTES, type ChainClient } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import type { AlertKind, Alerts } from '../src/services/alerts'
import { issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, submitFunding } from '../src/services/drops'
import {
  CLAIM_MEMO,
  WORKER_LOCK_ID,
  acquireWorkerLock,
  evaluateProvenDead,
  reconcileOnStartup,
  releaseWorkerLock,
  runWorkerTick,
  validityWindowBlocks,
  withWorkerLock,
} from '../src/services/transfers'
import {
  ReplaceRefusedError,
  depositReport,
  pauseCustody,
  replaceTransfer,
  resumeTransfer,
  unpauseCustody,
} from '../src/recover'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The worker serializes on the singleton `custody_controls` row and reads
 * `outstandingPrincipalLuna`, a GLOBAL aggregate over every drop. Neither can
 * be shared with the other `*.race.test.ts` files vitest runs in parallel, so
 * this suite migrates a private Postgres schema and points its own pool's
 * `search_path` at it.
 */
const SCHEMA = 'transfers_race_test'

const CUSTODY = 'NQ07 CUSTODY'
const SPONSOR = 'NQ07 SPONSOR'
const ORIGIN = 'https://nimdrops.test'
const FINALITY_DEPTH = 5
const FUND_HEIGHT = 100
/** Head once the funding tx is final — the height the worker signs against. */
const LIVE_HEIGHT = FUND_HEIGHT + FINALITY_DEPTH

/** 1 NIM each × 5 people = 5 NIM principal. */
const AMOUNT_EACH = 100_000n
const CLAIM_COUNT = 5
/** Operator's pre-funded fee float, matching `configured_fee_reserve_luna`. */
const FEE_FLOAT = 100_000n

let pool: pg.Pool
let chain: FakeChain

// ---- alert spy ---------------------------------------------------------------

interface SentAlert {
  alert: AlertKind
  detail: Record<string, unknown>
}

interface SpyAlerts extends Alerts {
  sent: SentAlert[]
  alertNames(): AlertKind[]
}

function spyAlerts(): SpyAlerts {
  const sent: SentAlert[] = []
  return {
    sent,
    alertNames: () => sent.map((a) => a.alert),
    async notify(alert, detail) {
      sent.push({ alert, detail })
    },
  }
}

let alerts: SpyAlerts

// ---- chain doubles -----------------------------------------------------------

/**
 * A ChainClient that delegates everything to `base` except the overridden
 * methods. Used to inject crash windows the FakeChain itself cannot express —
 * a broadcast that never reaches the network at all (process killed), or a
 * node that answers lookups with an error rather than an absence.
 */
function chainWith(base: FakeChain, over: Partial<ChainClient>): ChainClient {
  const delegate: ChainClient = {
    network: () => base.network(),
    custodyAddress: () => base.custodyAddress(),
    headHeight: () => base.headHeight(),
    isFinal: (tx, head) => base.isFinal(tx, head),
    getTransaction: (hash) => base.getTransaction(hash),
    confirmedBalanceLuna: (address) => base.confirmedBalanceLuna(address),
    buildSignedBasic: (o) => base.buildSignedBasic(o),
    broadcast: (raw) => base.broadcast(raw),
  }
  return { ...delegate, ...over }
}

/** The process dies before the broadcast call ever reaches the network. */
function killedBeforeBroadcast(base: FakeChain): ChainClient {
  return chainWith(base, {
    broadcast: async () => {
      throw new Error('process-killed')
    },
  })
}

/** The node is up but cannot answer: "we could not ask" is NOT "absent". */
function lookupsFail(base: FakeChain): ChainClient {
  return chainWith(base, {
    getTransaction: async () => {
      throw new Error('rpc down')
    },
  })
}

// ---- fixtures ----------------------------------------------------------------

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
  const c = new FakeChain({
    custody: CUSTODY,
    finalityDepth: FINALITY_DEPTH,
    headHeight: FUND_HEIGHT,
  })
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

/** Create, fund, finalize and activate a drop; returns its public id. */
async function liveDrop(o: { claimCount?: number } = {}): Promise<string> {
  const claimCount = o.claimCount ?? CLAIM_COUNT
  const draft = await createDraft(pool, chain, {
    sponsorLabel: 'Sponsor',
    amountEachLuna: AMOUNT_EACH,
    claimCount,
  })
  const hash = `tx-${draft.publicId}`
  chain.deposit({
    hash,
    sender: SPONSOR,
    recipient: CUSTODY,
    valueLuna: AMOUNT_EACH * BigInt(claimCount),
    dataUtf8: draft.fundingMemo,
    includedHeight: FUND_HEIGHT,
  })
  chain.setHead(LIVE_HEIGHT)
  const pub = await submitFunding(pool, chain, { publicId: draft.publicId, txHash: hash })
  expect(pub.state).toBe('live')
  return draft.publicId
}

interface QueuedPayout {
  publicId: string
  claimId: string
  transferId: string
  recipient: string
}

/** A live drop with one reserved claim, i.e. exactly one `queued` payout intent. */
async function queuedPayout(): Promise<QueuedPayout> {
  return reserveOn(await liveDrop())
}

/** Reserve one slot on an already-live drop and return its payout intent. */
async function reserveOn(publicId: string): Promise<QueuedPayout> {
  const wallet = newWallet()
  const issued = await issueChallenge(pool, publicId)
  const claim = await reserveClaim(pool, {
    publicId,
    challengeId: issued.challengeId,
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: wallet.sign(issued.message),
    idemKey: randomUUID(),
    requestHash: 'request-hash-a',
  })
  const transfer = await readTransferByClaim(claim.claimId)
  expect(transfer.state).toBe('queued')
  return {
    publicId,
    claimId: claim.claimId,
    transferId: transfer.id,
    recipient: wallet.address,
  }
}

// ---- reads -------------------------------------------------------------------

interface TransferRow {
  id: string
  purpose: string
  claim_id: string | null
  recipient_address: string
  amount_luna: string
  state: string
  last_error: string | null
}

async function readTransferByClaim(claimId: string): Promise<TransferRow> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT id, purpose, claim_id, recipient_address, amount_luna, state, last_error
     FROM outgoing_transfers WHERE claim_id = $1`,
    [claimId],
  )
  return rows[0]
}

async function readTransfer(transferId: string): Promise<TransferRow> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT id, purpose, claim_id, recipient_address, amount_luna, state, last_error
     FROM outgoing_transfers WHERE id = $1`,
    [transferId],
  )
  return rows[0]
}

interface AttemptRow {
  id: string
  sequence: number
  state: string
  raw_hex: string
  tx_hash: string
  fee_luna: string
  validity_start_height: string
  observed_height: string | null
  confirmed_height: string | null
  last_error: string | null
}

async function readAttempts(transferId: string): Promise<AttemptRow[]> {
  const { rows } = await pool.query<AttemptRow>(
    `SELECT id, sequence, state, encode(raw_signed_tx, 'hex') AS raw_hex, tx_hash, fee_luna,
            validity_start_height, observed_height, confirmed_height, last_error
     FROM transaction_attempts WHERE transfer_id = $1 ORDER BY sequence`,
    [transferId],
  )
  return rows
}

async function readClaimState(claimId: string): Promise<string> {
  const { rows } = await pool.query<{ state: string }>('SELECT state FROM claims WHERE id = $1', [
    claimId,
  ])
  return rows[0].state
}

/** Payments actually leaving custody, regardless of how many broadcasts it took. */
function custodyPayments(): ReturnType<FakeChain['allTxs']> {
  return chain.allTxs().filter((tx) => tx.sender === CUSTODY)
}

async function setPaused(paused: boolean): Promise<void> {
  await pool.query('UPDATE custody_controls SET paused = $1 WHERE singleton', [paused])
}

/** Make the reconciled balance look untrustworthy without touching the chain. */
async function makeReconciliationStale(): Promise<void> {
  await pool.query(
    `UPDATE custody_controls SET last_reconciled_at = now() - interval '1 hour' WHERE singleton`,
  )
}

async function backdateAttempts(transferId: string, interval: string): Promise<void> {
  await pool.query(
    `UPDATE transaction_attempts SET created_at = now() - $2::interval WHERE transfer_id = $1`,
    [transferId, interval],
  )
}

// ---- suite -------------------------------------------------------------------

describe.skipIf(!hasDb)('transfer worker crash windows (real Postgres)', () => {
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
       http_idempotency RESTART IDENTITY CASCADE`,
    )
    await pool.query(
      `UPDATE custody_controls
       SET paused = false,
           max_live_principal_luna = 10000000,
           configured_fee_reserve_luna = ${FEE_FLOAT},
           reconciled_confirmed_balance_luna = NULL,
           last_reconciled_height = NULL,
           last_reconciled_at = NULL
       WHERE singleton`,
    )
    chain = newChain()
    alerts = spyAlerts()
  })

  afterEach(setEnv)

  function setEnv(): void {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    process.env.STATUS_TOKEN_SECRET = 'transfers-race-test-secret'
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

  // ---- the sign-before-broadcast invariant ------------------------------------

  it('commits the signed attempt bytes and hash BEFORE any broadcast call', async () => {
    const payout = await queuedPayout()

    // Read the database from INSIDE the broadcast call: at that instant the
    // signed attempt must already be committed and visible to another
    // connection. This is the kill criterion — no payment without a persisted
    // signed attempt row.
    let seenAtBroadcast: AttemptRow[] = []
    let intentAtBroadcast = ''
    const observing = chainWith(chain, {
      broadcast: async (raw) => {
        seenAtBroadcast = await readAttempts(payout.transferId)
        intentAtBroadcast = (await readTransfer(payout.transferId)).state
        await chain.broadcast(raw)
      },
    })

    expect(await runWorkerTick(pool, observing, alerts)).toBe('worked')

    expect(seenAtBroadcast).toHaveLength(1)
    expect(seenAtBroadcast[0].state).toBe('signed')
    expect(seenAtBroadcast[0].tx_hash).toMatch(/^fake-/)
    expect(seenAtBroadcast[0].raw_hex.length).toBeGreaterThan(0)
    expect(seenAtBroadcast[0].validity_start_height).toBe(String(LIVE_HEIGHT))
    expect(intentAtBroadcast).toBe('in_progress')

    // …and the chain saw the build strictly before the broadcast.
    const order = chain.calls.map((c) => c.op)
    expect(order).toEqual(['build', 'broadcast'])

    const attempts = await readAttempts(payout.transferId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].state).toBe('broadcast')
    expect(attempts[0].raw_hex).toBe(seenAtBroadcast[0].raw_hex)
    expect(await readClaimState(payout.claimId)).toBe('confirming')
  })

  it('signs the payout with the NimDrop memo, inside the 64-byte limit', async () => {
    expect(Buffer.byteLength(CLAIM_MEMO, 'utf8')).toBeLessThanOrEqual(MEMO_MAX_BYTES)

    const payout = await queuedPayout()
    await runWorkerTick(pool, chain, alerts)

    const [tx] = custodyPayments()
    expect(tx.dataUtf8).toBe(CLAIM_MEMO)
    expect(tx.recipient).toBe(payout.recipient)
    expect(tx.valueLuna).toBe(AMOUNT_EACH)
  })

  // ---- crash windows ----------------------------------------------------------

  it('kill after sign: restart rebroadcasts the SAME bytes and pays exactly once', async () => {
    const payout = await queuedPayout()

    await runWorkerTick(pool, killedBeforeBroadcast(chain), alerts)

    // The bytes never reached the network, but they are durable.
    expect(chain.calls.filter((c) => c.op === 'broadcast')).toHaveLength(0)
    const [signed] = await readAttempts(payout.transferId)
    expect(signed.state).toBe('signed')
    expect(custodyPayments()).toHaveLength(0)

    await reconcileOnStartup(pool, chain, alerts)

    const after = await readAttempts(payout.transferId)
    expect(after).toHaveLength(1)
    expect(after[0].tx_hash).toBe(signed.tx_hash)
    expect(after[0].raw_hex).toBe(signed.raw_hex)
    expect(after[0].state).toBe('broadcast')
    expect(chain.broadcastCount(signed.tx_hash)).toBe(1)
    expect(custodyPayments()).toHaveLength(1)
  })

  it('kill after broadcast (ambiguous): reconcile finds the hash and never rebroadcasts', async () => {
    const payout = await queuedPayout()

    // Acknowledged-then-timed-out: the tx IS on chain but the worker never
    // learned that. This is the window that double-pays if handled wrongly.
    chain.failNextBroadcast('timeout-but-lands')
    await runWorkerTick(pool, chain, alerts)

    const [signed] = await readAttempts(payout.transferId)
    expect(signed.state).toBe('signed')
    expect(custodyPayments()).toHaveLength(1)

    await reconcileOnStartup(pool, chain, alerts)

    const after = await readAttempts(payout.transferId)
    expect(after).toHaveLength(1)
    expect(after[0].tx_hash).toBe(signed.tx_hash)
    expect(after[0].state).toBe('broadcast')
    // One broadcast call total: reconcile saw the hash and stopped.
    expect(chain.broadcastCount(signed.tx_hash)).toBe(1)
    expect(custodyPayments()).toHaveLength(1)
  })

  it('true timeout: reconcile rebroadcasts the same bytes and creates NO new attempt', async () => {
    const payout = await queuedPayout()

    chain.failNextBroadcast('timeout')
    await runWorkerTick(pool, chain, alerts)

    const [signed] = await readAttempts(payout.transferId)
    expect(signed.state).toBe('signed')
    expect(custodyPayments()).toHaveLength(0)

    await reconcileOnStartup(pool, chain, alerts)

    const after = await readAttempts(payout.transferId)
    expect(after, 'a replacement attempt must never be built on a timeout').toHaveLength(1)
    expect(after[0].tx_hash).toBe(signed.tx_hash)
    expect(after[0].raw_hex).toBe(signed.raw_hex)
    expect(after[0].state).toBe('broadcast')
    expect(chain.broadcastCount(signed.tx_hash)).toBe(2)
    expect(custodyPayments()).toHaveLength(1)
  })

  // ---- MEMPOOL BLINDNESS (g0-evidence.md §5A) ---------------------------------

  it('not-found is never proven_dead until the validity window is provably past', async () => {
    const payout = await queuedPayout()

    chain.failNextBroadcast('timeout')
    await runWorkerTick(pool, chain, alerts)
    const [signed] = await readAttempts(payout.transferId)
    const vsh = Number(signed.validity_start_height)
    expect(vsh).toBe(LIVE_HEIGHT)

    // The node answers "not found" — which, for the first minutes after a
    // broadcast, means the mempool is simply invisible to us.
    chain.failNextBroadcast('timeout')
    await reconcileOnStartup(pool, chain, alerts)

    const stillOpen = await readAttempts(payout.transferId)
    expect(stillOpen).toHaveLength(1)
    expect(stillOpen[0].state, 'absence alone must never mean proven_dead').not.toBe('proven_dead')
    expect((await readTransfer(payout.transferId)).state).toBe('in_progress')
    // The safe action on not-found is rebroadcasting the SAME bytes.
    expect(chain.broadcastCount(signed.tx_hash)).toBe(2)
    expect(
      await evaluateProvenDead(chain, {
        txHash: signed.tx_hash,
        validityStartHeight: vsh,
      }),
    ).toMatchObject({ provenDead: false, absent: true, windowPast: false })

    // Now the window is provably past and the hash is still absent. Only NOW
    // may the attempt be considered dead — and only an operator may act on it.
    chain.setHead(vsh + validityWindowBlocks() + 1)
    await reconcileOnStartup(pool, chain, alerts)

    const dead = await readAttempts(payout.transferId)
    expect(dead).toHaveLength(1)
    expect(dead[0].state, 'the worker never marks proven_dead by itself').toBe('signed')
    expect((await readTransfer(payout.transferId)).state).toBe('manual_review')
    expect(alerts.alertNames()).toContain('manual_review')
    expect(
      await evaluateProvenDead(chain, {
        txHash: signed.tx_hash,
        validityStartHeight: vsh,
      }),
    ).toMatchObject({ provenDead: true, absent: true, windowPast: true })
    expect(custodyPayments()).toHaveLength(0)
  })

  // ---- finality is the only authority (g0-evidence.md §5B) --------------------

  it('confirms only at our own finality depth, never on inclusion alone', async () => {
    const payout = await queuedPayout()

    await runWorkerTick(pool, chain, alerts)
    const [attempt] = await readAttempts(payout.transferId)
    expect(attempt.state).toBe('broadcast')

    // Included but one block short of final: NOT paid.
    chain.setHead(LIVE_HEIGHT + FINALITY_DEPTH - 1)
    await runWorkerTick(pool, chain, alerts)

    let rows = await readAttempts(payout.transferId)
    expect(rows[0].state).toBe('broadcast')
    expect(rows[0].observed_height).toBe(String(LIVE_HEIGHT))
    expect(rows[0].confirmed_height).toBeNull()
    expect((await readTransfer(payout.transferId)).state).toBe('in_progress')
    expect(await readClaimState(payout.claimId)).toBe('confirming')

    chain.setHead(LIVE_HEIGHT + FINALITY_DEPTH)
    expect(await runWorkerTick(pool, chain, alerts)).toBe('worked')

    rows = await readAttempts(payout.transferId)
    expect(rows[0].state).toBe('confirmed')
    expect(rows[0].confirmed_height).toBe(String(LIVE_HEIGHT))
    expect((await readTransfer(payout.transferId)).state).toBe('confirmed')
    expect(await readClaimState(payout.claimId)).toBe('paid')
  })

  // ---- fail-closed controls ----------------------------------------------------

  it('does nothing and leaves the intent queued when paused, and alerts the operator', async () => {
    const payout = await queuedPayout()
    await setPaused(true)

    expect(await runWorkerTick(pool, chain, alerts)).toBe('idle')

    expect(await readAttempts(payout.transferId)).toHaveLength(0)
    expect((await readTransfer(payout.transferId)).state).toBe('queued')
    expect(chain.calls).toHaveLength(0)
    expect(alerts.alertNames()).toContain('paused')
  })

  it('does nothing and alerts when reconciliation is stale', async () => {
    const payout = await queuedPayout()
    await makeReconciliationStale()

    expect(await runWorkerTick(pool, chain, alerts)).toBe('idle')

    expect(await readAttempts(payout.transferId)).toHaveLength(0)
    expect((await readTransfer(payout.transferId)).state).toBe('queued')
    expect(alerts.alertNames()).toContain('stale_reconciliation')
  })

  it('does nothing when the fee reserve is not covered', async () => {
    const payout = await queuedPayout()
    // Raise the required reserve above what the operator actually pre-funded.
    await pool.query(
      'UPDATE custody_controls SET configured_fee_reserve_luna = $1 WHERE singleton',
      [(FEE_FLOAT * 10n).toString()],
    )

    expect(await runWorkerTick(pool, chain, alerts)).toBe('idle')

    expect(await readAttempts(payout.transferId)).toHaveLength(0)
    const transfer = await readTransfer(payout.transferId)
    expect(transfer.state).toBe('queued')
    expect(transfer.last_error).toMatch(/fee reserve|balance/i)
    expect(chain.calls).toHaveLength(0)
  })

  // ---- unresolvable ------------------------------------------------------------

  it('sends an intent to manual_review only after the lookup budget is exhausted', async () => {
    const payout = await queuedPayout()
    await runWorkerTick(pool, chain, alerts)

    // A node that errors is "we could not ask", never "absent": inside the
    // budget the intent must keep waiting.
    await reconcileOnStartup(pool, lookupsFail(chain), alerts)
    expect((await readTransfer(payout.transferId)).state).toBe('in_progress')
    expect(alerts.alertNames()).not.toContain('manual_review')
    expect((await readAttempts(payout.transferId))[0].last_error).toMatch(/rpc down/)

    await backdateAttempts(payout.transferId, '2 hours')
    await reconcileOnStartup(pool, lookupsFail(chain), alerts)

    expect((await readTransfer(payout.transferId)).state).toBe('manual_review')
    expect(await readClaimState(payout.claimId)).toBe('manual_review')
    expect(alerts.alertNames()).toContain('manual_review')
    // Still exactly one attempt, still auditable.
    expect(await readAttempts(payout.transferId)).toHaveLength(1)
  })

  // ---- single worker ------------------------------------------------------------

  it('a second advisory-lock holder cannot tick', async () => {
    const payout = await queuedPayout()

    const holder = await pool.connect()
    try {
      expect(await acquireWorkerLock(holder)).toBe(true)

      // A second process asking for the same lock is refused and does no work.
      const contender = await pool.connect()
      try {
        expect(await acquireWorkerLock(contender)).toBe(false)
      } finally {
        contender.release()
      }

      expect(await withWorkerLock(pool, () => runWorkerTick(pool, chain, alerts))).toBe('locked')
      expect(await readAttempts(payout.transferId)).toHaveLength(0)
      expect((await readTransfer(payout.transferId)).state).toBe('queued')
      expect(chain.calls).toHaveLength(0)

      await releaseWorkerLock(holder)
    } finally {
      holder.release()
    }

    // With the lock free the single worker proceeds normally.
    expect(await withWorkerLock(pool, () => runWorkerTick(pool, chain, alerts))).toBe('worked')
    expect(await readAttempts(payout.transferId)).toHaveLength(1)
    expect(WORKER_LOCK_ID).toBe(42)
  })

  // ---- recovery CLI --------------------------------------------------------------

  it('resume re-enqueues reconciliation of an existing intent', async () => {
    const payout = await queuedPayout()
    await runWorkerTick(pool, killedBeforeBroadcast(chain), alerts)

    const [signed] = await readAttempts(payout.transferId)
    expect(signed.state).toBe('signed')
    expect(signed.last_error).toMatch(/process-killed/)

    const result = await resumeTransfer(pool, chain, alerts, payout.transferId)

    expect(result.action).toBe('rebroadcast')
    const after = await readAttempts(payout.transferId)
    expect(after).toHaveLength(1)
    expect(after[0].tx_hash).toBe(signed.tx_hash)
    expect(after[0].state).toBe('broadcast')
    expect(after[0].last_error).toBeNull()
    expect((await readTransfer(payout.transferId)).state).toBe('in_progress')
    expect(custodyPayments()).toHaveLength(1)
  })

  it('resume puts a manual_review intent with no open attempt back on the queue', async () => {
    const payout = await queuedPayout()
    await pool.query(
      `UPDATE outgoing_transfers SET state = 'manual_review', last_error = 'operator halt'
       WHERE id = $1`,
      [payout.transferId],
    )

    const result = await resumeTransfer(pool, chain, alerts, payout.transferId)

    expect(result.action).toBe('requeued')
    const transfer = await readTransfer(payout.transferId)
    expect(transfer.state).toBe('queued')
    expect(transfer.last_error).toBeNull()
  })

  it('a recovered payment promotes its claim out of manual_review to confirming', async () => {
    const payout = await queuedPayout()
    await runWorkerTick(pool, killedBeforeBroadcast(chain), alerts)

    // The state an operator finds after the worker gave up on this attempt:
    // both the intent and the claimant's own view are flagged.
    await pool.query(`UPDATE outgoing_transfers SET state = 'manual_review' WHERE id = $1`, [
      payout.transferId,
    ])
    await pool.query(`UPDATE claims SET state = 'manual_review' WHERE id = $1`, [payout.claimId])

    const result = await resumeTransfer(pool, chain, alerts, payout.transferId)

    expect(result.action).toBe('rebroadcast')
    // The claimant must see the recovery, not stay stuck on a stale flag.
    expect(await readClaimState(payout.claimId)).toBe('confirming')
    expect(custodyPayments()).toHaveLength(1)
  })

  it('nimiqChainFromEnv fails closed on the network instead of defaulting', () => {
    const savedKey = process.env.CUSTODY_PRIVATE_KEY_HEX
    delete process.env.CUSTODY_PRIVATE_KEY_HEX
    try {
      delete process.env.NIMIQ_NETWORK
      expect(() => nimiqChainFromEnv()).toThrow(/NIMIQ_NETWORK/)

      // With a valid network the NEXT missing variable is reported, which is
      // what proves the check above is the one that fired.
      process.env.NIMIQ_NETWORK = 'TestAlbatross'
      expect(() => nimiqChainFromEnv()).toThrow(/CUSTODY_PRIVATE_KEY_HEX/)
    } finally {
      if (savedKey === undefined) delete process.env.CUSTODY_PRIVATE_KEY_HEX
      else process.env.CUSTODY_PRIVATE_KEY_HEX = savedKey
    }
  })

  it('pause stops the money paths and unpause releases them, both reporting controls', async () => {
    const payout = await queuedPayout()

    const paused = await pauseCustody(pool, 'operator drill')
    expect(paused.paused).toBe(true)
    expect(await runWorkerTick(pool, chain, alerts)).toBe('idle')
    expect(await readAttempts(payout.transferId)).toHaveLength(0)

    const resumed = await unpauseCustody(pool)
    expect(resumed.paused).toBe(false)
    // The reconciled balance survives the pause, so work restarts immediately.
    expect(await runWorkerTick(pool, chain, alerts)).toBe('worked')
    expect(await readAttempts(payout.transferId)).toHaveLength(1)
  })

  it('unpause is idempotent on an already-running system', async () => {
    expect((await unpauseCustody(pool)).paused).toBe(false)
    expect((await unpauseCustody(pool)).paused).toBe(false)
  })

  it('replace refuses while the prior attempt could still land', async () => {
    const payout = await queuedPayout()
    await runWorkerTick(pool, chain, alerts)

    // Broadcast and sitting on chain: replacing would double-pay.
    await expect(replaceTransfer(pool, chain, alerts, payout.transferId)).rejects.toBeInstanceOf(
      ReplaceRefusedError,
    )
    expect(await readAttempts(payout.transferId)).toHaveLength(1)
  })

  it('replace refuses on an ambiguous lookup even when the window is past', async () => {
    const payout = await queuedPayout()
    chain.failNextBroadcast('timeout')
    await runWorkerTick(pool, chain, alerts)
    const [signed] = await readAttempts(payout.transferId)
    chain.setHead(Number(signed.validity_start_height) + validityWindowBlocks() + 1)

    // "We could not ask" is not "it is dead".
    await expect(
      replaceTransfer(pool, lookupsFail(chain), alerts, payout.transferId),
    ).rejects.toBeInstanceOf(ReplaceRefusedError)
    expect((await readAttempts(payout.transferId))[0].state).toBe('signed')
  })

  it('replace refuses before the validity window is past', async () => {
    const payout = await queuedPayout()
    chain.failNextBroadcast('timeout')
    await runWorkerTick(pool, chain, alerts)

    await expect(replaceTransfer(pool, chain, alerts, payout.transferId)).rejects.toBeInstanceOf(
      ReplaceRefusedError,
    )
    expect((await readAttempts(payout.transferId))[0].state).toBe('signed')
  })

  it('replace succeeds once proven dead, with recipient and amount taken from the intent', async () => {
    const payout = await queuedPayout()
    chain.failNextBroadcast('timeout')
    await runWorkerTick(pool, chain, alerts)
    const [first] = await readAttempts(payout.transferId)
    chain.setHead(Number(first.validity_start_height) + validityWindowBlocks() + 1)

    const result = await replaceTransfer(pool, chain, alerts, payout.transferId)

    expect(result.sequence).toBe(2)
    const attempts = await readAttempts(payout.transferId)
    expect(attempts, 'both attempts stay auditable').toHaveLength(2)
    expect(attempts[0].state).toBe('proven_dead')
    expect(attempts[0].tx_hash).toBe(first.tx_hash)
    expect(attempts[0].raw_hex).toBe(first.raw_hex)
    expect(attempts[1].state).toBe('broadcast')
    expect(attempts[1].tx_hash).not.toBe(first.tx_hash)

    // Recipient and amount are immutable, read straight off the intent row.
    const intent = await readTransfer(payout.transferId)
    expect(intent.recipient_address).toBe(payout.recipient)
    expect(intent.amount_luna).toBe(AMOUNT_EACH.toString())
    expect(intent.state).toBe('in_progress')
    const payments = custodyPayments()
    expect(payments).toHaveLength(1)
    expect(payments[0].recipient).toBe(payout.recipient)
    expect(payments[0].valueLuna).toBe(AMOUNT_EACH)
  })

  // ---- deposit reconciliation report ------------------------------------------

  it('deposits reports every custody deposit that matches no exact funding predicate', async () => {
    // Drop A: funded correctly and live.
    const funded = await liveDrop()
    const fundedTx = `tx-${funded}`
    // …then someone pays it a second time.
    chain.deposit({
      hash: 'dup-1',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: AMOUNT_EACH * BigInt(CLAIM_COUNT),
      dataUtf8: `ND1:${funded}`,
      includedHeight: FUND_HEIGHT + 1,
    })

    // Drop B: a draft that was never accepted — late, partial and excess money.
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'Sponsor B',
      amountEachLuna: AMOUNT_EACH,
      claimCount: CLAIM_COUNT,
    })
    const expected = AMOUNT_EACH * BigInt(CLAIM_COUNT)
    chain.deposit({
      hash: 'late-1',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: expected,
      dataUtf8: draft.fundingMemo,
      includedHeight: FUND_HEIGHT + 2,
    })
    chain.deposit({
      hash: 'partial-1',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: expected - 1n,
      dataUtf8: draft.fundingMemo,
      includedHeight: FUND_HEIGHT + 3,
    })
    chain.deposit({
      hash: 'excess-1',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: expected + 1n,
      dataUtf8: draft.fundingMemo,
      includedHeight: FUND_HEIGHT + 4,
    })
    chain.deposit({
      hash: 'unknown-memo-1',
      sender: SPONSOR,
      recipient: CUSTODY,
      valueLuna: expected,
      dataUtf8: 'ND1:nosuchdroppublicid',
      includedHeight: FUND_HEIGHT + 5,
    })

    const report = await depositReport(pool, chain)
    const byHash = new Map(report.unmatched.map((d) => [d.txHash, d]))

    expect(byHash.get('dup-1')?.reason).toBe('duplicate')
    expect(byHash.get('late-1')?.reason).toBe('late')
    expect(byHash.get('partial-1')?.reason).toBe('partial')
    expect(byHash.get('excess-1')?.reason).toBe('excess')
    expect(byHash.get('unknown-memo-1')?.reason).toBe('unknown_memo')
    // The operator's own fee float carries no memo and needs manual eyes too.
    expect(byHash.get('operator-fee-float')?.reason).toBe('no_memo')

    // The accepted funding tx is matched and must NOT appear.
    expect(byHash.has(fundedTx)).toBe(false)
    expect(report.matchedCount).toBe(1)

    // Outgoing custody payments are not deposits.
    await reserveOn(funded)
    expect(await runWorkerTick(pool, chain, alerts)).toBe('worked')
    expect(custodyPayments()).toHaveLength(1)
    const after = await depositReport(pool, chain)
    expect(after.unmatched.map((d) => d.txHash)).toEqual(report.unmatched.map((d) => d.txHash))
  })
})
