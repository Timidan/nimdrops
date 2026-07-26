/**
 * G1 SPIKE S3 — settlement end to end, through the REAL services, on a REAL chain.
 *
 *   DATABASE_URL=postgres://nimdrops:dev@localhost:5432/nimdrops pnpm tsx spike/s3-settlement-e2e.ts
 *
 * Unlike S1/S2 (which drove `chain/nimiq.ts` directly), this script calls the
 * production service functions — `createDraft`, `submitFunding`, `issueChallenge`,
 * `reserveClaim`, `runWorkerTick`, `reconcileOnStartup`, `sweepExpiry`,
 * `settleTerminal`, `setOperatorFloat`, `pauseCustody`, `unpauseCustody`,
 * `resumeTransfer` — against Postgres and TestAlbatross. Nothing here
 * re-implements money logic; if a state transition happens, the shipped code
 * did it.
 *
 * The scripted path (design §12.3 settlement gate):
 *
 *   1. Create a draft (3 shares, tiny amounts): one share is paid the ordinary
 *      way, one is paid ACROSS TWO PROCESS KILLS, one is never claimed and must
 *      come back as the refund.
 *   2. Seed the sponsor out of custody, then have the sponsor pay TWO
 *      transactions into custody: the drop's funding (exact `ND1:<publicId>`
 *      memo) and a separate, memo-less operator FLOAT DEPOSIT. Both are built
 *      and signed in this process with `@nimiq/core` — the stand-in for a Nimiq
 *      Pay wallet: it learns each hash BEFORE broadcast.
 *   3. LEG 1 — FAIL-CLOSED SOLVENCY. With the operator float still zero, poll
 *      `submitFunding` until the funding is final and ASSERT the activation is
 *      REFUSED with `InsolventError`. A run in which a zero-float deployment
 *      activates a drop is a FAILED run.
 *   4. Attest the float through the production path — `recover.ts`'s
 *      `setOperatorFloat`, i.e. `float set <luna> --tx <hash>` — against the
 *      finalized deposit from step 2, then re-submit and watch the drop go
 *      `live`. `operator_float_luna` is never written by raw SQL: migration 006
 *      exists so the float is attributable, and a harness that bypasses it
 *      proves nothing about the deployment that cannot.
 *   5. Reserve slot A for a fresh claimant keypair which signs the canonical
 *      challenge itself; run worker ticks until it is `paid`.
 *   6. LEG 2 — KILL/RESTART. Reserve slot B, then run the worker loop in CHILD
 *      PROCESSES (`spike/s3-tick-runner.ts`) and `kill -9` them at two distinct
 *      points: (a) after the `signed` attempt row commits and before broadcast,
 *      (b) the instant the real broadcast returns, before `markBroadcast`. A
 *      third process restarts and lets `reconcileOnStartup` finish the job.
 *      ASSERTS exactly one attempt row, exactly one hash, one confirmed
 *      attempt, one on-chain transaction paying the claimant, and — because
 *      claimant B is a brand-new address — a final claimant balance of EXACTLY
 *      one share. Two payments would show up as two.
 *   7. FORCE EXPIRY — the single test lever in this script: `expires_at` is set
 *      to one second ago with a direct UPDATE, because the real horizon is 24h.
 *      Everything downstream of that UPDATE is production code.
 *   8. `sweepExpiry` closes the drop and writes ONE refund intent for the single
 *      unallocated slot (never for a claimed one).
 *   9. LEG 3 — PAUSE SWITCH AND SHORTFALL. With that refund sitting `queued`:
 *      `pauseCustody` and ASSERT the tick signs nothing; then move custody money
 *      OUT OF BAND so the chain really does hold less than the books claim, and
 *      ASSERT `reconcile` detects it and stamps `shortfall_detected_at`;
 *      `unpauseCustody` and ASSERT signing is STILL refused (round-2 review N3 —
 *      unpausing is permission, not evidence); repay custody, run a clean
 *      reconcile, and ASSERT the refund then proceeds. No column is hand-edited:
 *      the shortfall is a real one.
 *  10. Run worker ticks until the refund confirms, then `settleTerminal` marks
 *      the drop `refunded`.
 *  11. LEG 4 — CONSERVATION, asserted here rather than by an operator's SQL
 *      after the fact: `sum(confirmed payouts) + refund == expected_funding`,
 *      the refund covers exactly the unallocated slots, and the custody wallet's
 *      own balance moved by exactly principal + recorded fees.
 *  12. Print every transaction hash, explorer link, timing and final state, and
 *      write `spike/g1-local-evidence.md` (or `S3_EVIDENCE_PATH`).
 *
 * ISOLATION: everything runs in a throwaway Postgres schema named after the run
 * id, migrated from scratch and dropped at the end (`S3_KEEP_SCHEMA=1` keeps it
 * for inspection). The custody wallet is real, so the money is real testnet NIM.
 *
 * TestAlbatross only — it refuses to run against MainAlbatross.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Address, KeyPair, PrivateKey, TransactionBuilder } from '@nimiq/core'
import pg from 'pg'
import { NETWORK_ID, NimiqChain, type NimiqNetwork } from '../src/chain/nimiq'
import type { ChainTx } from '../src/chain/types'
import { migrate } from '../src/db/migrate'
import { formatNim } from '../src/money'
import {
  floatShow,
  pauseCustody,
  resumeTransfer,
  setOperatorFloat,
  unpauseCustody,
} from '../src/recover'
import { consoleAlerts } from '../src/services/alerts'
import { issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, getPublic, submitFunding } from '../src/services/drops'
import { settleTerminal, sweepExpiry } from '../src/services/expiry'
import {
  InsolventError,
  inFlightOutgoingLuna,
  ledgerBalanceLuna,
  readControls,
  reconcile,
} from '../src/services/solvency'
import { runWorkerTick } from '../src/services/transfers'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number.
import '../src/db/pool'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_KEY_PATH = join(HERE, '.dev-key')
const TICK_RUNNER = join(HERE, 's3-tick-runner.ts')
// Override with S3_EVIDENCE_PATH when the source tree is read-only (e.g. inside the
// deploy image, where the evidence file belongs on a mounted volume instead).
const EVIDENCE_PATH = process.env.S3_EVIDENCE_PATH ?? join(HERE, 'g1-local-evidence.md')

const FAUCET_URL = 'https://faucet.pos.nimiq-testnet.com/tapit'
const EXPLORER = 'https://test.nimiq.watch'

/** 0.02 NIM each × 3 shares = 0.06 NIM of real testnet money per run. */
const AMOUNT_EACH_LUNA = 2_000n
/** Slot A: ordinary payout. Slot B: paid across two kills. Slot C: refunded. */
const CLAIM_COUNT = 3
const EXPECTED_FUNDING_LUNA = AMOUNT_EACH_LUNA * BigInt(CLAIM_COUNT)
/** Custody must hold this much before the solvency invariant lets anything sign. */
const CUSTODY_MIN_LUNA = 300_000n
/** How far below the ledger the shortfall leg pushes the real custody balance. */
const SHORTFALL_MARGIN_LUNA = 1_000n

const FUNDING_TIMEOUT_MS = 15 * 60_000
const PAYOUT_TIMEOUT_MS = 15 * 60_000
const INCLUSION_TIMEOUT_MS = 5 * 60_000
const RECONCILE_EVERY_MS = 60_000
const TICK_SLEEP_MS = 3_000

const RUN_ID = `s3_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`

const t0 = Date.now()
const el = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`
function log(...a: unknown[]): void {
  console.log(`[${el()}]`, ...a)
}
function fail(msg: string): never {
  console.error(`\n✗ S3 FAILED: ${msg}\n`)
  process.exit(1)
}
/** Every gate assertion goes through here, so none of them can be a soft warning. */
function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) fail(msg)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

const NETWORK = (process.env.NIMIQ_NETWORK ?? 'TestAlbatross') as NimiqNetwork
if (NETWORK !== 'TestAlbatross') fail('S3 is TestAlbatross only')

process.env.NIMIQ_NETWORK = NETWORK
process.env.PUBLIC_ORIGIN ??= 'https://s3.nimdrops.local'
// The Task 7 device fixture locks production's scheme; the claimant here signs
// the canonical message bytes directly.
process.env.SIG_SCHEME ??= 'raw'
process.env.STATUS_TOKEN_SECRET ??= `s3-${RUN_ID}`

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) fail('DATABASE_URL is not set')

const alerts = consoleAlerts()

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

interface TxNote {
  label: string
  hash: string
  /** Seconds from broadcast to our own finality depth, when we waited for it. */
  finalitySeconds?: number
  includedHeight?: number
}

const txNotes: TxNote[] = []
const legNotes: string[] = []

function noteTx(note: TxNote): void {
  txNotes.push(note)
}
function noteLeg(line: string): void {
  legNotes.push(line)
  log(`  ✓ ${line}`)
}

/**
 * Persist the run write-up. Never throws: by the time this runs the settlement
 * result is already proven and printed, so a read-only source tree (the deploy
 * image) must not turn a passing gate run into a non-zero exit.
 */
function writeEvidence(lines: string[]): void {
  try {
    writeFileSync(EVIDENCE_PATH, lines.join('\n'))
    log(`wrote ${EVIDENCE_PATH}`)
  } catch (err) {
    log(`WARNING: could not write ${EVIDENCE_PATH}: ${(err as Error).message}`)
    log('evidence follows on stdout instead:')
    console.log(lines.join('\n'))
  }
}

// ---------------------------------------------------------------------------
// keys and faucet
// ---------------------------------------------------------------------------

interface DevKeys {
  custodyPrivateKeyHex: string
  sponsorPrivateKeyHex?: string
}

function loadDevKeys(): DevKeys | null {
  if (!existsSync(DEV_KEY_PATH)) return null
  return JSON.parse(readFileSync(DEV_KEY_PATH, 'utf8')) as DevKeys
}

/** True once the faucet has topped custody up during THIS run (see the audit). */
let custodyFaucetTapped = false

async function tapFaucet(address: string, who: string): Promise<void> {
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address }).toString(),
  })
  log(`faucet(${who}) ->`, res.status, (await res.text()).slice(0, 160))
}

/** Tap and wait until `address` holds at least `min`, or give up. */
async function ensureFunded(
  chain: NimiqChain,
  address: string,
  min: bigint,
  who: string,
): Promise<bigint> {
  let balance = await chain.confirmedBalanceLuna(address)
  log(`${who} balance: ${formatNim(balance)} NIM`)
  if (balance >= min) return balance

  await tapFaucet(address, who)
  if (who === 'custody') custodyFaucetTapped = true
  const deadline = Date.now() + 180_000
  while (balance < min && Date.now() < deadline) {
    await sleep(5_000)
    balance = await chain.confirmedBalanceLuna(address)
    log(`${who} balance: ${formatNim(balance)} NIM`)
  }
  return balance
}

// ---------------------------------------------------------------------------
// chain helpers
// ---------------------------------------------------------------------------

/** Poll `ok()` until it is true, or FAIL. Never returns a "didn't happen". */
async function waitFor(
  label: string,
  ok: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  while (Date.now() < deadline) {
    if (await ok()) {
      log(`${label}: reached after ${polls} polls`)
      return
    }
    polls += 1
    await sleep(intervalMs)
  }
  fail(`${label}: timed out after ${(timeoutMs / 1000).toFixed(0)}s`)
}

/** Wait for OUR finality depth (never the library's `confirmed`). */
async function waitFinal(chain: NimiqChain, hash: string, label: string): Promise<ChainTx> {
  const started = Date.now()
  let tx: ChainTx | null = null
  await waitFor(
    `${label} final`,
    async () => {
      tx = await chain.getTransaction(hash)
      if (!tx) return false
      return chain.isFinal(tx, await chain.headHeight())
    },
    FUNDING_TIMEOUT_MS,
    4_000,
  )
  const seconds = (Date.now() - started) / 1000
  const found = tx as ChainTx | null
  assert(found !== null, `${label}: finality loop exited without a transaction`)
  log(`${label} FINAL at height ${found.includedHeight} after ${seconds.toFixed(1)}s`)
  return found
}

/** Build, sign and broadcast one transaction FROM the sponsor. Hash known first. */
async function sponsorSend(
  chain: NimiqChain,
  sponsor: KeyPair,
  o: { to: string; valueLuna: bigint; memo?: string; label: string },
): Promise<string> {
  const vsh = await chain.headHeight()
  const tx =
    o.memo === undefined
      ? TransactionBuilder.newBasic(
          sponsor.toAddress(),
          Address.fromAny(o.to),
          o.valueLuna,
          0n,
          vsh,
          NETWORK_ID[NETWORK],
        )
      : TransactionBuilder.newBasicWithData(
          sponsor.toAddress(),
          Address.fromAny(o.to),
          new TextEncoder().encode(o.memo),
          o.valueLuna,
          0n,
          vsh,
          NETWORK_ID[NETWORK],
        )
  tx.sign(sponsor, undefined)
  const hash = tx.hash()
  log(`${o.label}: signed ${hash} value=${formatNim(o.valueLuna)} NIM vsh=${vsh}`)
  await chain.broadcast(tx.toHex())
  log(`${o.label}: broadcast`)
  return hash
}

/** Build, sign and broadcast one transaction FROM custody, via the real signer. */
async function custodySend(
  chain: NimiqChain,
  o: { to: string; valueLuna: bigint; label: string },
): Promise<string> {
  const built = await chain.buildSignedBasic({
    to: o.to,
    valueLuna: o.valueLuna,
    validityStartHeight: await chain.headHeight(),
  })
  log(`${o.label}: signed ${built.txHash} value=${formatNim(o.valueLuna)} NIM`)
  await chain.broadcast(built.rawTxHex)
  log(`${o.label}: broadcast`)
  return built.txHash
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

/**
 * Create and migrate the throwaway run schema.
 *
 * Deliberately does NOT attest the operator float. A freshly migrated schema
 * starts at `operator_float_luna = 0`, and that is the state leg 1 asserts on:
 * the very first activation must be REFUSED. The float is attested later, and
 * only through `recover.ts`'s `setOperatorFloat` — the same code path
 * `float set <luna> --tx <hash>` runs — against a deposit this run really made.
 */
async function createRunSchema(): Promise<pg.Pool> {
  const admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`DROP SCHEMA IF EXISTS ${RUN_ID} CASCADE`)
  await admin.query(`CREATE SCHEMA ${RUN_ID}`)
  await admin.end()

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${RUN_ID},public`,
    max: 4,
  })
  await migrate(pool)
  log(`run schema ${RUN_ID} migrated`)
  return pool
}

async function dropRunSchema(): Promise<void> {
  if (process.env.S3_KEEP_SCHEMA === '1') {
    log(`keeping schema ${RUN_ID} (S3_KEEP_SCHEMA=1)`)
    return
  }
  const admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`DROP SCHEMA IF EXISTS ${RUN_ID} CASCADE`)
  await admin.end()
}

interface TransferSnapshot {
  purpose: string
  recipient_address: string
  amount_luna: string
  state: string
  tx_hash: string | null
  attempt_state: string | null
  confirmed_height: string | null
  fee_luna: string | null
}

async function readTransfers(pool: pg.Pool, publicId: string): Promise<TransferSnapshot[]> {
  const { rows } = await pool.query<TransferSnapshot>(
    `SELECT t.purpose, t.recipient_address, t.amount_luna, t.state,
            a.tx_hash, a.state AS attempt_state, a.confirmed_height, a.fee_luna
     FROM outgoing_transfers t
     JOIN drops d ON d.id = t.drop_id
     LEFT JOIN transaction_attempts a ON a.transfer_id = t.id
     WHERE d.public_id = $1
     ORDER BY t.purpose, a.sequence`,
    [publicId],
  )
  return rows
}

async function readDropRow(pool: pg.Pool, publicId: string) {
  const { rows } = await pool.query<{
    id: string
    state: string
    closing_reason: string | null
    refund_address: string | null
    claim_count: number
    amount_each_luna: string
    expected_funding_luna: string
    expires_at: Date | null
  }>(
    `SELECT id, state, closing_reason, refund_address, claim_count, amount_each_luna,
            expected_funding_luna, expires_at
     FROM drops WHERE public_id = $1`,
    [publicId],
  )
  const row = rows[0]
  assert(row !== undefined, `drop ${publicId} vanished from the database`)
  return row
}

async function readClaimStates(pool: pg.Pool, publicId: string): Promise<string[]> {
  const { rows } = await pool.query<{ state: string }>(
    `SELECT c.state FROM claims c JOIN drops d ON d.id = c.drop_id
     WHERE d.public_id = $1 ORDER BY c.slot_index`,
    [publicId],
  )
  return rows.map((r) => r.state)
}

async function transferIdForClaim(pool: pg.Pool, claimId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM outgoing_transfers WHERE claim_id = $1`,
    [claimId],
  )
  assert(rows.length === 1, `expected exactly one payout intent for claim ${claimId}, got ${rows.length}`)
  return rows[0].id
}

interface AttemptRow {
  id: string
  sequence: number
  state: string
  tx_hash: string
  confirmed_height: string | null
  fee_luna: string
}

async function readAttempts(pool: pg.Pool, transferId: string): Promise<AttemptRow[]> {
  const { rows } = await pool.query<AttemptRow>(
    `SELECT id, sequence, state, tx_hash, confirmed_height, fee_luna
     FROM transaction_attempts WHERE transfer_id = $1 ORDER BY sequence`,
    [transferId],
  )
  return rows
}

async function readTransferRow(
  pool: pg.Pool,
  transferId: string,
): Promise<{ state: string; last_error: string | null; next_attempt_at: Date | null }> {
  const { rows } = await pool.query<{
    state: string
    last_error: string | null
    next_attempt_at: Date | null
  }>('SELECT state, last_error, next_attempt_at FROM outgoing_transfers WHERE id = $1', [transferId])
  assert(rows[0] !== undefined, `transfer ${transferId} vanished`)
  return rows[0]
}

// ---------------------------------------------------------------------------
// worker driver (in-process)
// ---------------------------------------------------------------------------

let lastReconciledAt = 0

/**
 * Tick the real worker until `done()` is true. Reconciliation is refreshed on
 * the way, because `lockControls` fails closed once the reconciled balance is
 * more than 10 minutes old and a finality wait can outlast that.
 */
async function workUntil(
  pool: pg.Pool,
  chain: NimiqChain,
  label: string,
  done: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let ticks = 0
  while (Date.now() < deadline) {
    if (await done()) {
      log(`${label}: reached after ${ticks} ticks`)
      return
    }
    if (Date.now() - lastReconciledAt >= RECONCILE_EVERY_MS) {
      await reconcile(pool, chain, alerts)
      lastReconciledAt = Date.now()
    }
    const outcome = await runWorkerTick(pool, chain, alerts)
    ticks++
    if (ticks % 10 === 0) log(`${label}: ${ticks} ticks, last=${outcome}`)
    await sleep(TICK_SLEEP_MS)
  }
  fail(`${label}: timed out after ${(timeoutMs / 1000).toFixed(0)}s`)
}

// ---------------------------------------------------------------------------
// child processes for the kill/restart leg
// ---------------------------------------------------------------------------

interface ChildOutcome {
  status: number | null
  signal: NodeJS.Signals | null
}

function runTickChild(mode: string, transferId: string, custodyKeyHex: string): ChildOutcome {
  console.log(`\n${'='.repeat(70)}\n  CHILD PROCESS: ${mode}\n${'='.repeat(70)}`)
  const r = spawnSync(process.execPath, [...process.execArgv, TICK_RUNNER, mode, transferId], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL,
      S3_SCHEMA: RUN_ID,
      NIMIQ_NETWORK: NETWORK,
      CUSTODY_PRIVATE_KEY_HEX: custodyKeyHex,
    },
  })
  console.log(`--- child ${mode} exited: status=${r.status} signal=${r.signal} ---`)
  return { status: r.status, signal: r.signal }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== G1 SPIKE S3 — settlement end to end ===')
  console.log('run id       :', RUN_ID)
  console.log('network      :', NETWORK)
  console.log('amount each  :', `${formatNim(AMOUNT_EACH_LUNA)} NIM × ${CLAIM_COUNT} shares`)

  // -- keys -----------------------------------------------------------------
  const dev = loadDevKeys()
  const custodyKeyHex = process.env.CUSTODY_PRIVATE_KEY_HEX ?? dev?.custodyPrivateKeyHex
  if (!custodyKeyHex) {
    fail('no custody key: set CUSTODY_PRIVATE_KEY_HEX or run spike/s1-custody.ts first')
  }

  // Sponsor: generated in-script unless an existing throwaway testnet key is
  // available (reusing one avoids a faucet tap per run). It is seeded out of
  // custody below, so it does not depend on the faucet's generosity.
  const sponsorKeyHex =
    process.env.S3_SPONSOR_PRIVATE_KEY_HEX ?? dev?.sponsorPrivateKeyHex ?? PrivateKey.generate().toHex()
  const sponsor = KeyPair.derive(PrivateKey.fromHex(sponsorKeyHex))
  const sponsorAddress = sponsor.toAddress().toUserFriendlyAddress()

  // Claimants: always fresh, and NEVER funded from anywhere else. That is what
  // makes "final balance == exactly one share" a proof of no duplicate payment.
  const claimantA = KeyPair.derive(PrivateKey.generate())
  const claimantB = KeyPair.derive(PrivateKey.generate())
  const claimantAAddress = claimantA.toAddress().toUserFriendlyAddress()
  const claimantBAddress = claimantB.toAddress().toUserFriendlyAddress()

  const chain = new NimiqChain({
    network: NETWORK,
    custodyPrivateKeyHex: custodyKeyHex,
    logLevel: 'warn',
  })
  const custodyAddress = chain.custodyAddress()

  console.log('custody      :', custodyAddress)
  console.log('sponsor      :', sponsorAddress)
  console.log('claimant A   :', claimantAAddress)
  console.log('claimant B   :', claimantBAddress)
  console.log('finality     :', chain.finalityDepthBlocks(), 'blocks')
  console.log('fee (luna)   :', chain.feeLuna().toString(), '\n')

  const cStart = Date.now()
  await chain.connect()
  const consensusMs = Date.now() - cStart
  log(`consensus established in ${(consensusMs / 1000).toFixed(1)}s; head ${await chain.headHeight()}`)

  const pool = await createRunSchema()

  try {
    // -- 0. sizes, read from the migrated controls ---------------------------
    const seeded = await readControls(pool)
    const feeReserveLuna = seeded.configuredFeeReserveLuna
    assert(
      feeReserveLuna > 0n,
      'configured_fee_reserve_luna is 0, so leg 1 could never prove a fail-closed activation',
    )
    assert(
      seeded.operatorFloatLuna === 0n,
      `a freshly migrated schema must start at float 0, found ${seeded.operatorFloatLuna}`,
    )
    // Twice the reserve: enough headroom that a non-zero NIMIQ_FEE_LUNA does not
    // make the invariant fail on the last payout, small enough that the custody
    // wallet can back it.
    const floatLuna = feeReserveLuna * 2n
    const seedLuna = floatLuna + EXPECTED_FUNDING_LUNA
    console.log('fee reserve  :', `${formatNim(feeReserveLuna)} NIM`)
    console.log('float target :', `${formatNim(floatLuna)} NIM`)

    // -- balances ------------------------------------------------------------
    const custodyStartLuna = await ensureFunded(
      chain,
      custodyAddress,
      CUSTODY_MIN_LUNA,
      'custody',
    )
    assert(
      custodyStartLuna >= CUSTODY_MIN_LUNA,
      `custody holds ${formatNim(custodyStartLuna)} NIM, needs ${formatNim(CUSTODY_MIN_LUNA)} ` +
        '(float + principal + fee reserve headroom) — fund it and re-run',
    )
    assert(
      custodyStartLuna >= seedLuna,
      `custody holds ${formatNim(custodyStartLuna)} NIM but must seed the sponsor with ` +
        `${formatNim(seedLuna)} NIM (float deposit + drop funding)`,
    )

    // -- 1. draft ------------------------------------------------------------
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'S3 settlement spike',
      message: 'end-to-end settlement gate',
      amountEachLuna: AMOUNT_EACH_LUNA,
      claimCount: CLAIM_COUNT,
    })
    log('draft created:', draft.publicId, `memo=${draft.fundingMemo}`)
    assert(
      draft.expectedFundingLuna === EXPECTED_FUNDING_LUNA,
      `draft expects ${draft.expectedFundingLuna} luna, this script computed ${EXPECTED_FUNDING_LUNA}`,
    )

    // -- 2. seed the sponsor, then fund + deposit ----------------------------
    // The sponsor's money comes OUT OF CUSTODY and goes straight back in, so
    // the run needs no faucet luck and nets to zero against the audit below.
    const seedHash = await custodySend(chain, {
      to: sponsorAddress,
      valueLuna: seedLuna,
      label: 'sponsor seed (custody → sponsor)',
    })
    noteTx({ label: 'sponsor seed (custody → sponsor)', hash: seedHash })
    await waitFor(
      'sponsor seed credited',
      async () => (await chain.confirmedBalanceLuna(sponsorAddress)) >= seedLuna,
      INCLUSION_TIMEOUT_MS,
    )

    // Memo-less: this is operator float, not any drop's funding. `float set`
    // refuses a hash that is some drop's accepted funding, and this must not be
    // mistaken for one by a human reading the chain either.
    const depositHash = await sponsorSend(chain, sponsor, {
      to: custodyAddress,
      valueLuna: floatLuna,
      label: 'float deposit (sponsor → custody)',
    })
    const fundingHash = await sponsorSend(chain, sponsor, {
      to: custodyAddress,
      valueLuna: draft.expectedFundingLuna,
      memo: draft.fundingMemo,
      label: 'drop funding (sponsor → custody)',
    })

    // -- 3. LEG 1: activation must FAIL CLOSED at float 0 --------------------
    log('LEG 1: activation with operator float 0 must be REFUSED')
    let insolvent: Error | null = null
    let lastState = 'awaiting_funding'
    const legOneDeadline = Date.now() + FUNDING_TIMEOUT_MS
    while (Date.now() < legOneDeadline) {
      try {
        const pub = await submitFunding(pool, chain, {
          publicId: draft.publicId,
          txHash: fundingHash,
        })
        if (pub.state !== lastState) log(`drop state: ${lastState} -> ${pub.state}`)
        lastState = pub.state
        assert(
          pub.state !== 'live',
          'ACTIVATION SUCCEEDED WITH ZERO OPERATOR FLOAT — the solvency invariant did not fail ' +
            'closed. This is the whole point of leg 1; the run is void.',
        )
      } catch (err) {
        // UnreconciledShortfallError is a subclass, so this covers both.
        if (err instanceof InsolventError) {
          insolvent = err
          break
        }
        throw err
      }
      await sleep(5_000)
    }
    assert(
      insolvent !== null,
      'the funding never reached finality, so the fail-closed solvency assertion never ran',
    )
    noteLeg(
      `LEG 1 fail-closed solvency: activation at float 0 refused with ` +
        `${insolvent.constructor.name} — "${insolvent.message}"`,
    )

    // -- 4. attest the float through the production path ---------------------
    // `recover.ts float set <luna> --tx <hash>`. Not raw SQL: migration 006
    // exists so every luna of the float points at a transaction an auditor can
    // open on a block explorer, and a harness that writes the column directly
    // proves nothing about the deployment that cannot.
    const depositTx = await waitFinal(chain, depositHash, 'float deposit')
    noteTx({
      label: 'float deposit (sponsor → custody)',
      hash: depositHash,
      includedHeight: depositTx.includedHeight,
    })
    const floatResult = await setOperatorFloat(pool, chain, floatLuna.toString(), depositHash)
    log(
      `float attested: ${floatResult.operatorFloatLuna.before} -> ${floatResult.operatorFloatLuna.after} luna ` +
        `against deposit ${depositHash} at height ${floatResult.deposit.includedHeight}`,
    )
    const shown = await floatShow(pool, chain)
    assert(
      shown.solvency.floatAttributed,
      'float set left floatAttributed=false — the float is not backed by the deposits recorded',
    )
    assert(
      shown.solvency.attestedFloatDepositsLuna === floatLuna.toString(),
      `attested deposits total ${shown.solvency.attestedFloatDepositsLuna}, expected ${floatLuna}`,
    )
    noteLeg(
      `operator float ${floatLuna} luna attested through recover.ts float set, attributed to ` +
        `deposit ${depositHash} (height ${floatResult.deposit.includedHeight}), floatAttributed=true`,
    )

    // -- 5. activation now succeeds ------------------------------------------
    const fundingDeadline = Date.now() + FUNDING_TIMEOUT_MS
    let state = lastState
    while (state !== 'live' && Date.now() < fundingDeadline) {
      const pub = await submitFunding(pool, chain, {
        publicId: draft.publicId,
        txHash: fundingHash,
      })
      if (pub.state !== state) log(`drop state: ${state} -> ${pub.state}`)
      state = pub.state
      if (state === 'live') break
      await sleep(5_000)
    }
    assert(state === 'live', 'funding never activated the drop after the float was attested')
    lastReconciledAt = Date.now() // submitFunding reconciled on activation
    const live = await getPublic(pool, draft.publicId)
    log(`drop LIVE: remaining=${live.remaining}, expires ${live.expiresAt?.toISOString()}`)
    const fundingTx = await chain.getTransaction(fundingHash)
    assert(fundingTx !== null, 'the funding transaction disappeared from the chain after activation')
    noteTx({
      label: 'drop funding (sponsor → custody)',
      hash: fundingHash,
      includedHeight: fundingTx.includedHeight,
    })

    // -- helper: reserve one slot -------------------------------------------
    const reserveFor = async (kp: KeyPair, tag: string): Promise<string> => {
      const challenge = await issueChallenge(pool, draft.publicId)
      const signature = kp.sign(new Uint8Array(Buffer.from(challenge.message, 'utf8'))).toHex()
      const claim = await reserveClaim(pool, {
        publicId: draft.publicId,
        challengeId: challenge.challengeId,
        publicKeyHex: kp.publicKey.toHex(),
        signatureHex: signature,
        idemKey: `${RUN_ID}-${tag}`,
        requestHash: `${RUN_ID}-${tag}`,
      })
      log(`claim ${tag} reserved: ${claim.claimId} state=${claim.state}`)
      return claim.claimId
    }

    // -- 6. slot A: the ordinary payout --------------------------------------
    const claimAId = await reserveFor(claimantA, 'claim-a')
    const transferA = await transferIdForClaim(pool, claimAId)
    await workUntil(
      pool,
      chain,
      'payout A',
      async () => (await readClaimStates(pool, draft.publicId))[0] === 'paid',
      PAYOUT_TIMEOUT_MS,
    )
    const attemptsA = await readAttempts(pool, transferA)
    assert(attemptsA.length === 1, `payout A produced ${attemptsA.length} attempts, expected 1`)
    assert(attemptsA[0].state === 'confirmed', `payout A attempt is ${attemptsA[0].state}`)
    log(`payout A CONFIRMED: ${attemptsA[0].tx_hash} at height ${attemptsA[0].confirmed_height}`)
    noteTx({
      label: 'payout A (custody → claimant A)',
      hash: attemptsA[0].tx_hash,
      includedHeight: Number(attemptsA[0].confirmed_height),
    })

    // -- 7. LEG 2: kill/restart ----------------------------------------------
    log('LEG 2: kill/restart across both crash windows')
    const claimBId = await reserveFor(claimantB, 'claim-b')
    const transferB = await transferIdForClaim(pool, claimBId)
    const beforeB = await readTransferRow(pool, transferB)
    assert(beforeB.state === 'queued', `payout B should start queued, found '${beforeB.state}'`)
    assert(
      (await readAttempts(pool, transferB)).length === 0,
      'payout B already has an attempt before the kill leg started',
    )

    // (a) sign, commit, DIE before broadcast.
    const childA = runTickChild('sign-then-crash', transferB, custodyKeyHex)
    assert(
      childA.signal === 'SIGKILL',
      `crash window (a): child exited status=${childA.status} signal=${childA.signal}, expected SIGKILL`,
    )
    const afterCrashA = await readAttempts(pool, transferB)
    assert(
      afterCrashA.length === 1,
      `crash window (a): expected exactly 1 persisted attempt, found ${afterCrashA.length}`,
    )
    assert(
      afterCrashA[0].state === 'signed',
      `crash window (a): attempt is '${afterCrashA[0].state}', expected 'signed' — the crash ` +
        'happened at the wrong point',
    )
    const hashB = afterCrashA[0].tx_hash
    assert(typeof hashB === 'string' && hashB.length > 0, 'crash window (a): no hash was persisted')
    const seenAfterA = await chain.getTransactionDetails(hashB)
    assert(
      seenAfterA === null,
      `crash window (a): the network already knows ${hashB} (state ${seenAfterA?.state}) — the ` +
        'bytes were broadcast before the kill, so nothing about the pre-broadcast window was proven',
    )
    noteLeg(
      `LEG 2 crash window (a): killed -9 after the signed attempt committed and BEFORE broadcast; ` +
        `attempt ${hashB} persisted, absent from the chain`,
    )

    // (b) restart, rebroadcast the SAME bytes, DIE the instant broadcast returns.
    const childB = runTickChild('broadcast-then-crash', transferB, custodyKeyHex)
    assert(
      childB.signal === 'SIGKILL',
      `crash window (b): child exited status=${childB.status} signal=${childB.signal}, expected SIGKILL`,
    )
    const afterCrashB = await readAttempts(pool, transferB)
    assert(
      afterCrashB.length === 1,
      `crash window (b): expected still exactly 1 attempt, found ${afterCrashB.length} — a second ` +
        'attempt would be a second payment',
    )
    assert(
      afterCrashB[0].tx_hash === hashB,
      `crash window (b): the hash changed across the crash (${hashB} -> ${afterCrashB[0].tx_hash})`,
    )
    assert(
      afterCrashB[0].state === 'signed',
      `crash window (b): attempt is '${afterCrashB[0].state}', expected still 'signed' — the kill ` +
        'must land before markBroadcast, otherwise this is not the ambiguous window',
    )
    // The database says `signed`, the network has it. That is the whole point.
    await waitFor(
      `crash window (b): network knows ${hashB}`,
      async () => (await chain.getTransactionDetails(hashB)) !== null,
      120_000,
      3_000,
    )
    const seenAfterB = await chain.getTransactionDetails(hashB)
    noteLeg(
      `LEG 2 crash window (b): killed -9 the instant broadcast returned; database still 'signed' ` +
        `while the network reports ${hashB} in state '${seenAfterB?.state}'`,
    )

    // Restart once more and let reconciliation finish the job.
    const childC = runTickChild('finish', transferB, custodyKeyHex)
    assert(
      childC.status === 0,
      `restart: the recovering child exited status=${childC.status} signal=${childC.signal}`,
    )
    lastReconciledAt = Date.now()

    const finalAttemptsB = await readAttempts(pool, transferB)
    assert(
      finalAttemptsB.length === 1,
      `recovery produced ${finalAttemptsB.length} attempts for one intent — a duplicate payment path exists`,
    )
    assert(
      new Set(finalAttemptsB.map((a) => a.tx_hash)).size === 1,
      'recovery produced more than one transaction hash for one intent',
    )
    assert(
      finalAttemptsB[0].tx_hash === hashB,
      `recovery confirmed a different hash (${finalAttemptsB[0].tx_hash}) than the one signed before ` +
        `the first crash (${hashB})`,
    )
    assert(
      finalAttemptsB[0].state === 'confirmed',
      `recovery left the attempt in '${finalAttemptsB[0].state}', expected 'confirmed'`,
    )
    const onChainB = await chain.getTransaction(hashB)
    assert(onChainB !== null, `the chain no longer has ${hashB}`)
    assert(
      onChainB.recipient === claimantBAddress,
      `${hashB} paid ${onChainB.recipient}, not claimant B ${claimantBAddress}`,
    )
    assert(
      onChainB.valueLuna === AMOUNT_EACH_LUNA,
      `${hashB} moved ${onChainB.valueLuna} luna, expected ${AMOUNT_EACH_LUNA}`,
    )
    const claimStatesAfterB = await readClaimStates(pool, draft.publicId)
    assert(
      claimStatesAfterB[1] === 'paid',
      `claim B ended '${claimStatesAfterB[1]}', expected 'paid'`,
    )
    noteTx({
      label: 'payout B (custody → claimant B, across two kills)',
      hash: hashB,
      includedHeight: onChainB.includedHeight,
    })
    noteLeg(
      `LEG 2 recovery: reconcileOnStartup in a THIRD process confirmed ${hashB} at height ` +
        `${onChainB.includedHeight} — 1 attempt row, 1 hash, 1 confirmation, claim B paid`,
    )

    // Both claimants are addresses this run created and nothing else has ever
    // paid. Their balances are therefore a chain-side count of the payments.
    for (const [tag, address] of [
      ['A', claimantAAddress],
      ['B', claimantBAddress],
    ] as const) {
      const balance = await chain.confirmedBalanceLuna(address)
      assert(
        balance === AMOUNT_EACH_LUNA,
        `claimant ${tag} holds ${balance} luna; exactly one share (${AMOUNT_EACH_LUNA}) was ` +
          'authorised, so this is a duplicate or a missing payment',
      )
    }
    noteLeg(
      `both claimant addresses hold exactly ${AMOUNT_EACH_LUNA} luna on chain — one payment each, ` +
        'counted on the chain rather than in our own books',
    )

    // -- 8. TEST LEVER: force expiry -----------------------------------------
    // The production horizon is 24h after activation (drops.ts EXPIRY_HOURS).
    // This UPDATE is the ONLY thing the script fakes; every transition after it
    // is produced by the shipped services.
    await pool.query(
      `UPDATE drops SET expires_at = now() - interval '1 second' WHERE public_id = $1`,
      [draft.publicId],
    )
    log('TEST LEVER: expires_at set to one second ago')

    // -- 9. sweep -------------------------------------------------------------
    const closed = await sweepExpiry(pool, alerts)
    const afterSweep = await readDropRow(pool, draft.publicId)
    const refundIntent = (await readTransfers(pool, draft.publicId)).find(
      (t) => t.purpose === 'refund',
    )
    log(
      `sweep closed ${closed} drop(s): state=${afterSweep.state}/${afterSweep.closing_reason}, ` +
        `refund=${refundIntent ? `${formatNim(BigInt(refundIntent.amount_luna))} NIM` : 'none'}`,
    )
    assert(closed === 1, 'sweep did not close the expired drop')
    assert(refundIntent !== undefined, 'no refund intent was created for the unallocated slot')
    const unallocatedSlots = CLAIM_COUNT - 2
    const expectedRefundLuna = BigInt(unallocatedSlots) * AMOUNT_EACH_LUNA
    assert(
      BigInt(refundIntent.amount_luna) === expectedRefundLuna,
      `refund is ${refundIntent.amount_luna} luna, expected exactly the ${unallocatedSlots} ` +
        `unallocated slot(s) (${expectedRefundLuna} luna)`,
    )
    assert(
      refundIntent.recipient_address === sponsorAddress,
      `refund goes to ${refundIntent.recipient_address}, expected the funding sender`,
    )
    const { rows: refundRows } = await pool.query<{ id: string }>(
      `SELECT t.id FROM outgoing_transfers t JOIN drops d ON d.id = t.drop_id
       WHERE d.public_id = $1 AND t.purpose = 'refund'`,
      [draft.publicId],
    )
    assert(refundRows.length === 1, `expected 1 refund intent, found ${refundRows.length}`)
    const refundTransferId = refundRows[0].id

    // -- 10. LEG 3: pause switch, then the N3 shortfall gate ------------------
    log('LEG 3: pause switch and the unreconciled-shortfall gate')

    const paused = await pauseCustody(pool, `S3 ${RUN_ID}: exercising the kill switch`)
    assert(paused.paused, 'pauseCustody returned controls that are not paused')
    const pausedTick = await runWorkerTick(pool, chain, alerts)
    assert(
      (await readAttempts(pool, refundTransferId)).length === 0,
      'the worker SIGNED a transfer while custody was paused — the kill switch does not hold',
    )
    assert(
      (await readTransferRow(pool, refundTransferId)).state === 'queued',
      'the refund left `queued` while custody was paused',
    )
    noteLeg(
      `LEG 3 pause: with custody paused the tick returned '${pausedTick}' and created NO attempt ` +
        'for the queued refund',
    )

    // A REAL shortfall, not a hand-written column. Move custody money out of
    // band — the exact condition the chain cross-check exists to catch — until
    // the chain holds less than the books can explain.
    const controlsNow = await readControls(pool)
    const ledgerNow = await ledgerBalanceLuna(pool, controlsNow)
    const inFlightNow = await inFlightOutgoingLuna(pool)
    const custodyNow = await chain.confirmedBalanceLuna(custodyAddress)
    const explainableMin = ledgerNow - inFlightNow
    const debitLuna = custodyNow - explainableMin + SHORTFALL_MARGIN_LUNA
    log(
      `shortfall setup: chain ${custodyNow} luna, ledger ${ledgerNow}, in-flight ${inFlightNow}, ` +
        `debiting ${debitLuna} luna out of band`,
    )
    assert(
      debitLuna > 0n,
      `custody already holds less than the ledger explains (${custodyNow} < ${explainableMin}); ` +
        'the run cannot set up a controlled shortfall',
    )
    assert(
      custodyNow - debitLuna >= expectedRefundLuna * 2n,
      'the shortfall debit would leave custody unable to pay the refund afterwards',
    )
    const debitHash = await custodySend(chain, {
      to: sponsorAddress,
      valueLuna: debitLuna,
      label: 'shortfall debit (custody → sponsor, out of band)',
    })
    noteTx({ label: 'shortfall debit (custody → sponsor, out of band)', hash: debitHash })
    await waitFor(
      'custody balance below the ledger',
      async () => (await chain.confirmedBalanceLuna(custodyAddress)) < explainableMin,
      INCLUSION_TIMEOUT_MS,
    )
    await reconcile(pool, chain, alerts)
    lastReconciledAt = Date.now()
    const shortControls = await readControls(pool)
    assert(
      shortControls.shortfallDetectedAt !== null,
      'reconcile did not stamp shortfall_detected_at even though the chain holds less than the ledger',
    )
    assert(shortControls.paused, 'reconcile detected a shortfall but did not pause custody')
    noteLeg(
      `LEG 3 shortfall: a real out-of-band custody debit of ${debitLuna} luna made the chain hold ` +
        `less than the ledger; reconcile paused custody and stamped shortfall_detected_at=` +
        `${shortControls.shortfallDetectedAt.toISOString()}`,
    )

    // N3: unpausing is permission to resume, not evidence that the money is there.
    const unpaused = await unpauseCustody(pool)
    assert(!unpaused.paused, 'unpauseCustody left custody paused')
    assert(
      unpaused.shortfallDetectedAt !== null,
      'unpause CLEARED shortfall_detected_at — N3 says only a clean reconcile may',
    )
    const unpausedTick = await runWorkerTick(pool, chain, alerts)
    assert(
      (await readAttempts(pool, refundTransferId)).length === 0,
      'the worker SIGNED after unpause while a shortfall stood — N3 is not enforced',
    )
    const refusedRow = await readTransferRow(pool, refundTransferId)
    assert(
      refusedRow.last_error !== null && /reconciliation has succeeded since/i.test(refusedRow.last_error),
      `expected the refusal to name the unreconciled shortfall, got: ${refusedRow.last_error}`,
    )
    noteLeg(
      `LEG 3 N3: after unpause the tick returned '${unpausedTick}' and STILL refused to sign — ` +
        `"${refusedRow.last_error}"`,
    )

    // Put the money back and let a clean reconcile reopen the money paths.
    const repayHash = await sponsorSend(chain, sponsor, {
      to: custodyAddress,
      valueLuna: debitLuna,
      label: 'shortfall repayment (sponsor → custody)',
    })
    noteTx({ label: 'shortfall repayment (sponsor → custody)', hash: repayHash })
    await waitFor(
      'custody balance restored above the ledger',
      async () => (await chain.confirmedBalanceLuna(custodyAddress)) >= explainableMin,
      INCLUSION_TIMEOUT_MS,
    )
    await reconcile(pool, chain, alerts)
    lastReconciledAt = Date.now()
    const cleanControls = await readControls(pool)
    assert(
      cleanControls.shortfallDetectedAt === null,
      'a clean reconcile did not clear shortfall_detected_at',
    )
    assert(!cleanControls.paused, 'a clean reconcile left custody paused')
    // The refusal above set a retry backoff; `resume` is the operator command
    // that clears it, and it signs nothing itself.
    const resumed = await resumeTransfer(pool, chain, alerts, refundTransferId)
    log(`resume ${refundTransferId}: action=${resumed.action} state=${resumed.intentState}`)
    noteLeg(
      'LEG 3 recovery: a clean reconcile cleared the shortfall flag and the refund was allowed to proceed',
    )

    // -- 11. worker refunds, then the drop settles ---------------------------
    await workUntil(
      pool,
      chain,
      'refund',
      async () =>
        (await readTransfers(pool, draft.publicId))
          .filter((t) => t.purpose === 'refund')
          .every((t) => t.state === 'confirmed' && t.attempt_state === 'confirmed'),
      PAYOUT_TIMEOUT_MS,
    )
    const settled = await settleTerminal(pool)
    const finalDrop = await readDropRow(pool, draft.publicId)
    log(`settleTerminal marked ${settled} drop(s); state=${finalDrop.state}`)
    assert(finalDrop.state === 'refunded', `expected 'refunded', got '${finalDrop.state}'`)

    const refundAttempts = await readAttempts(pool, refundTransferId)
    assert(refundAttempts.length === 1, `refund produced ${refundAttempts.length} attempts, expected 1`)
    noteTx({
      label: 'refund (custody → sponsor)',
      hash: refundAttempts[0].tx_hash,
      includedHeight: Number(refundAttempts[0].confirmed_height),
    })

    // -- 12. LEG 4: conservation, asserted here -------------------------------
    log('LEG 4: conservation')
    const finalTransfers = await readTransfers(pool, draft.publicId)
    const confirmedPayouts = finalTransfers.filter(
      (t) => t.purpose === 'payout' && t.state === 'confirmed' && t.attempt_state === 'confirmed',
    )
    const confirmedRefunds = finalTransfers.filter(
      (t) => t.purpose === 'refund' && t.state === 'confirmed' && t.attempt_state === 'confirmed',
    )
    const paidLuna = confirmedPayouts.reduce((sum, t) => sum + BigInt(t.amount_luna), 0n)
    const refundedLuna = confirmedRefunds.reduce((sum, t) => sum + BigInt(t.amount_luna), 0n)
    const expectedFundingLuna = BigInt(finalDrop.expected_funding_luna)
    const reservedSlots = (await readClaimStates(pool, draft.publicId)).length
    const unallocated = finalDrop.claim_count - reservedSlots

    console.log('\n--- conservation ---')
    console.log('expected funding :', expectedFundingLuna.toString(), 'luna')
    console.log('confirmed payouts:', `${confirmedPayouts.length} × slot =`, paidLuna.toString(), 'luna')
    console.log('confirmed refund :', refundedLuna.toString(), 'luna')
    console.log('unallocated slots:', unallocated, `× ${AMOUNT_EACH_LUNA} luna`)
    console.log('sum              :', (paidLuna + refundedLuna).toString(), 'luna')

    assert(
      confirmedPayouts.length === 2,
      `expected 2 confirmed payouts, found ${confirmedPayouts.length}`,
    )
    assert(confirmedRefunds.length === 1, `expected 1 confirmed refund, found ${confirmedRefunds.length}`)
    assert(
      paidLuna + refundedLuna === expectedFundingLuna,
      `CONSERVATION FAILED: payouts ${paidLuna} + refund ${refundedLuna} != funding ${expectedFundingLuna}`,
    )
    assert(
      refundedLuna === BigInt(unallocated) * BigInt(finalDrop.amount_each_luna),
      `the refund (${refundedLuna} luna) does not cover exactly the ${unallocated} unallocated slot(s)`,
    )
    noteLeg(
      `LEG 4 conservation: ${paidLuna} luna paid (${confirmedPayouts.length} claims) + ${refundedLuna} ` +
        `luna refunded (${unallocated} unallocated slot(s)) == ${expectedFundingLuna} luna funded`,
    )

    // Facade-level audit, the S2 argument applied to the whole settlement: the
    // custody wallet's own balance must have moved by exactly the principal it
    // was authorised to send plus the fees it recorded. A duplicate payment
    // anywhere in the run shows up here as extra movement, whatever the books say.
    const { rows: feeRows } = await pool.query<{ fees: string }>(
      `SELECT COALESCE(SUM(fee_luna), 0)::BIGINT AS fees FROM transaction_attempts WHERE state = 'confirmed'`,
    )
    const recordedFeesLuna = BigInt(feeRows[0].fees)
    // Two custody-signed transactions belong to the harness, not the ledger:
    // the sponsor seed and the shortfall debit (both returned in full).
    const harnessFeesLuna = chain.feeLuna() * 2n
    const custodyEndLuna = await chain.confirmedBalanceLuna(custodyAddress)
    const expectedEndLuna =
      custodyStartLuna - paidLuna - refundedLuna - recordedFeesLuna - harnessFeesLuna
    console.log('custody start    :', custodyStartLuna.toString(), 'luna')
    console.log('custody end      :', custodyEndLuna.toString(), 'luna')
    console.log('expected end     :', expectedEndLuna.toString(), 'luna')
    if (custodyFaucetTapped) {
      log(
        'custody balance audit SKIPPED: the faucet topped custody up during this run, so the ' +
          'delta is not attributable. Re-run against a pre-funded custody wallet to assert it.',
      )
    } else {
      assert(
        custodyEndLuna === expectedEndLuna,
        `CUSTODY BALANCE AUDIT FAILED: custody moved ${custodyStartLuna - custodyEndLuna} luna but ` +
          `exactly ${paidLuna + refundedLuna + recordedFeesLuna + harnessFeesLuna} was authorised — ` +
          'a payment exists that the books do not know about',
      )
      noteLeg(
        `LEG 4 custody audit: the wallet moved exactly ${custodyStartLuna - custodyEndLuna} luna ` +
          `(${paidLuna} payouts + ${refundedLuna} refund + ${recordedFeesLuna} recorded fees + ` +
          `${harnessFeesLuna} harness fees) — no unaccounted payment`,
      )
    }

    // -- 13. evidence ---------------------------------------------------------
    const claimStates = await readClaimStates(pool, draft.publicId)

    console.log('\n=== S3 EVIDENCE ===')
    console.log('run id           :', RUN_ID)
    console.log('network          :', NETWORK)
    console.log('consensus (s)    :', (consensusMs / 1000).toFixed(1))
    console.log('finality depth   :', chain.finalityDepthBlocks(), 'blocks')
    console.log('custody address  :', custodyAddress)
    console.log('sponsor address  :', sponsorAddress)
    console.log('claimant A       :', claimantAAddress)
    console.log('claimant B       :', claimantBAddress)
    console.log('drop public id   :', draft.publicId)
    console.log('drop final state :', finalDrop.state, `(closing_reason ${finalDrop.closing_reason})`)
    console.log('claim states     :', claimStates.join(', '))
    for (const t of finalTransfers) {
      console.log(
        `${t.purpose.padEnd(7)}          : ${formatNim(BigInt(t.amount_luna))} NIM -> ${t.recipient_address}`,
      )
      console.log(`  intent/attempt : ${t.state} / ${t.attempt_state}`)
      console.log(`  tx             : ${t.tx_hash}`)
      console.log(`  explorer       : ${EXPLORER}/tx/${t.tx_hash}`)
    }
    console.log('custody balance  :', formatNim(custodyEndLuna), 'NIM')
    console.log('total runtime    :', el())
    console.log('\n--- gate assertions proven ---')
    for (const line of legNotes) console.log(`  ✓ ${line}`)
    console.log('=== S3 PASSED ===')

    // The settlement result is already proven above; a failure to persist the
    // write-up must not turn a passing gate run into a non-zero exit.
    writeEvidence([
      '# G1 local evidence — s3-settlement-e2e',
      '',
      `- run id: \`${RUN_ID}\``,
      `- network: ${NETWORK}`,
      `- ran at: ${new Date().toISOString()}`,
      `- consensus established: ${(consensusMs / 1000).toFixed(1)}s`,
      `- finality depth: ${chain.finalityDepthBlocks()} blocks (our own authority, never the client's \`confirmed\`)`,
      `- custody: \`${custodyAddress}\``,
      `- sponsor: \`${sponsorAddress}\``,
      `- claimant A: \`${claimantAAddress}\``,
      `- claimant B (paid across two process kills): \`${claimantBAddress}\``,
      `- amounts: ${formatNim(AMOUNT_EACH_LUNA)} NIM × ${CLAIM_COUNT} shares — 2 claimed, 1 refunded`,
      `- final drop state: **${finalDrop.state}** (${finalDrop.closing_reason})`,
      `- claim states: ${claimStates.join(', ')}`,
      `- total runtime: ${el()}`,
      '',
      '## Transactions',
      '',
      '| Leg | Tx hash | Height | Explorer |',
      '|---|---|---|---|',
      ...txNotes.map(
        (n) =>
          `| ${n.label} | \`${n.hash}\` | ${n.includedHeight ?? '—'} | ${EXPLORER}/tx/${n.hash} |`,
      ),
      '',
      `Drop \`${draft.publicId}\`, funding memo \`${draft.fundingMemo}\`.`,
      `Operator float attested against deposit \`${depositHash}\` ` +
        `(${floatLuna} luna, height ${floatResult.deposit.includedHeight}) through ` +
        '`recover.ts float set <luna> --tx <hash>` — never by raw SQL.',
      '',
      '## Gate assertions the harness itself makes',
      '',
      ...legNotes.map((line) => `- ${line}`),
      '',
      '## Conservation',
      '',
      '```',
      `expected funding : ${expectedFundingLuna} luna`,
      `confirmed payouts: ${paidLuna} luna (${confirmedPayouts.length} claims)`,
      `confirmed refund : ${refundedLuna} luna (${unallocated} unallocated slot(s))`,
      `sum              : ${paidLuna + refundedLuna} luna`,
      `custody start    : ${custodyStartLuna} luna`,
      `custody end      : ${custodyEndLuna} luna`,
      `recorded fees    : ${recordedFeesLuna} luna (+ ${harnessFeesLuna} luna of harness fees)`,
      `custody audit    : ${custodyFaucetTapped ? 'SKIPPED (faucet topped custody up mid-run)' : 'ASSERTED'}`,
      '```',
      '',
      'NOTE: this is a LOCAL run of the harness unless it was executed on the VPS.',
      'The formal G1 record is the same script executed on the judging deployment;',
      'that output goes to docs/HACKATHON.md §3b.',
      '',
      '## What this run FAKES',
      '',
      'Exactly one thing: `expires_at` is forced one second into the past with a direct',
      'UPDATE, because the production horizon is 24h. Every transition after that UPDATE',
      'is produced by the shipped services.',
      '',
      'In particular the following are NOT faked — they are produced by real events:',
      '',
      '- the zero-float insolvency (a genuinely un-attested fresh schema);',
      '- the operator float (attested through `setOperatorFloat` against a finalized deposit);',
      '- both crash windows (`kill -9` of real child processes, at the two instruction',
      '  boundaries that matter);',
      '- the pause switch (`pauseCustody`/`unpauseCustody`, the same functions the CLI calls);',
      '- the chain-below-ledger shortfall (real custody money moved out of band, then repaid).',
      '',
    ])
  } finally {
    await pool.end()
    await dropRunSchema()
    await chain.close()
  }

  process.exit(0)
}

main().catch((err: unknown) => {
  console.error(err)
  fail(String(err))
})
