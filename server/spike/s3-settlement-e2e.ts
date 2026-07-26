/**
 * G1 SPIKE S3 — settlement end to end, through the REAL services, on a REAL chain.
 *
 *   DATABASE_URL=postgres://nimdrops:dev@localhost:5432/nimdrops pnpm tsx spike/s3-settlement-e2e.ts
 *
 * Unlike S1/S2 (which drove `chain/nimiq.ts` directly), this script calls the
 * production service functions — `createDraft`, `submitFunding`, `issueChallenge`,
 * `reserveClaim`, `runWorkerTick`, `sweepExpiry`, `settleTerminal` — against
 * Postgres and TestAlbatross. Nothing here re-implements money logic; if a state
 * transition happens, the shipped code did it.
 *
 * The scripted path (design §12.3 settlement gate):
 *
 *   1. Create a draft (2 shares, tiny amounts).
 *   2. Fund it from a faucet-funded sponsor keypair with the exact `ND1:<publicId>`
 *      memo, built and signed in this process with `@nimiq/core` — the stand-in
 *      for a Nimiq Pay wallet: it learns the hash BEFORE broadcast and hands only
 *      that hash to `submitFunding`.
 *   3. Poll `submitFunding` until finality flips the drop `live`.
 *   4. Reserve ONE of the two slots for a claimant keypair generated here, which
 *      signs the canonical challenge message itself.
 *   5. Run worker ticks until that payout is confirmed on chain and the claim is
 *      `paid`.
 *   6. FORCE EXPIRY — the single test lever in this script: `expires_at` is set
 *      to one second ago with a direct UPDATE, because the real horizon is 24h.
 *      Everything downstream of that UPDATE is production code.
 *   7. `sweepExpiry` closes the drop and writes ONE refund intent for the single
 *      unallocated slot (never for the claimed one).
 *   8. Run worker ticks until the refund confirms, then `settleTerminal` marks
 *      the drop `refunded`.
 *   9. Print every transaction hash, explorer link and final state, and write
 *      `spike/g1-local-evidence.md`.
 *
 * ISOLATION: everything runs in a throwaway Postgres schema named after the run
 * id, migrated from scratch and dropped at the end (`S3_KEEP_SCHEMA=1` keeps it
 * for inspection). The custody wallet is real, so the money is real testnet NIM.
 *
 * TestAlbatross only — it refuses to run against MainAlbatross.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Address, KeyPair, PrivateKey, TransactionBuilder } from '@nimiq/core'
import pg from 'pg'
import { NETWORK_ID, NimiqChain, type NimiqNetwork } from '../src/chain/nimiq'
import { migrate } from '../src/db/migrate'
import { formatNim } from '../src/money'
import { consoleAlerts } from '../src/services/alerts'
import { issueChallenge, reserveClaim } from '../src/services/claims'
import { createDraft, getPublic, submitFunding } from '../src/services/drops'
import { settleTerminal, sweepExpiry } from '../src/services/expiry'
import { reconcile } from '../src/services/solvency'
import { runWorkerTick } from '../src/services/transfers'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number.
import '../src/db/pool'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_KEY_PATH = join(HERE, '.dev-key')
const EVIDENCE_PATH = join(HERE, 'g1-local-evidence.md')

const FAUCET_URL = 'https://faucet.pos.nimiq-testnet.com/tapit'
const EXPLORER = 'https://test.nimiq.watch'

/** 0.02 NIM each × 2 shares = 0.04 NIM of real testnet money per run. */
const AMOUNT_EACH_LUNA = 2_000n
const CLAIM_COUNT = 2
/** Custody must hold this much before the solvency invariant lets anything sign. */
const CUSTODY_MIN_LUNA = 300_000n
const SPONSOR_MIN_LUNA = 100_000n

const FUNDING_TIMEOUT_MS = 15 * 60_000
const PAYOUT_TIMEOUT_MS = 15 * 60_000
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
// keys
// ---------------------------------------------------------------------------

interface DevKeys {
  custodyPrivateKeyHex: string
  sponsorPrivateKeyHex?: string
}

function loadDevKeys(): DevKeys | null {
  if (!existsSync(DEV_KEY_PATH)) return null
  return JSON.parse(readFileSync(DEV_KEY_PATH, 'utf8')) as DevKeys
}

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
  const deadline = Date.now() + 180_000
  while (balance < min && Date.now() < deadline) {
    await sleep(5_000)
    balance = await chain.confirmedBalanceLuna(address)
    log(`${who} balance: ${formatNim(balance)} NIM`)
  }
  return balance
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

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

  // Play the operator: attest the fee float this run's custody wallet is backed by.
  // A freshly migrated schema starts at operator_float_luna = 0, and the solvency
  // invariant (ledger >= outstanding + fee reserve) then fails closed on the very
  // first activation — correct production behaviour, and the same step a real
  // deployment performs once after provisioning. Sized to cover the seeded fee
  // reserve plus headroom for this run's payout/refund fees.
  const { rows } = await pool.query<{ configured_fee_reserve_luna: string }>(
    `UPDATE custody_controls
        SET operator_float_luna = configured_fee_reserve_luna * 10
      WHERE singleton
      RETURNING configured_fee_reserve_luna`,
  )
  log(`operator float attested: ${BigInt(rows[0]!.configured_fee_reserve_luna) * 10n} luna`)
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
}

async function readTransfers(pool: pg.Pool, publicId: string): Promise<TransferSnapshot[]> {
  const { rows } = await pool.query<TransferSnapshot>(
    `SELECT t.purpose, t.recipient_address, t.amount_luna, t.state,
            a.tx_hash, a.state AS attempt_state, a.confirmed_height
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
    expires_at: Date | null
  }>(
    'SELECT id, state, closing_reason, refund_address, expires_at FROM drops WHERE public_id = $1',
    [publicId],
  )
  return rows[0]
}

async function readClaimStates(pool: pg.Pool, publicId: string): Promise<string[]> {
  const { rows } = await pool.query<{ state: string }>(
    `SELECT c.state FROM claims c JOIN drops d ON d.id = c.drop_id
     WHERE d.public_id = $1 ORDER BY c.slot_index`,
    [publicId],
  )
  return rows.map((r) => r.state)
}

// ---------------------------------------------------------------------------
// worker driver
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
      await reconcile(pool, chain)
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
  // available (reusing one avoids a faucet tap per run).
  const sponsorKeyHex =
    process.env.S3_SPONSOR_PRIVATE_KEY_HEX ?? dev?.sponsorPrivateKeyHex ?? PrivateKey.generate().toHex()
  const sponsor = KeyPair.derive(PrivateKey.fromHex(sponsorKeyHex))
  const sponsorAddress = sponsor.toAddress().toUserFriendlyAddress()

  // Claimant: always fresh. It never needs funding — it only signs a challenge
  // and receives a payout.
  const claimant = KeyPair.derive(PrivateKey.generate())
  const claimantAddress = claimant.toAddress().toUserFriendlyAddress()

  const chain = new NimiqChain({
    network: NETWORK,
    custodyPrivateKeyHex: custodyKeyHex,
    logLevel: 'warn',
  })

  console.log('custody      :', chain.custodyAddress())
  console.log('sponsor      :', sponsorAddress)
  console.log('claimant     :', claimantAddress)
  console.log('finality     :', chain.finalityDepthBlocks(), 'blocks')
  console.log('fee (luna)   :', chain.feeLuna().toString(), '\n')

  const cStart = Date.now()
  await chain.connect()
  const consensusMs = Date.now() - cStart
  log(`consensus established in ${(consensusMs / 1000).toFixed(1)}s; head ${await chain.headHeight()}`)

  // -- balances -------------------------------------------------------------
  const custodyBalance = await ensureFunded(
    chain,
    chain.custodyAddress(),
    CUSTODY_MIN_LUNA,
    'custody',
  )
  if (custodyBalance < CUSTODY_MIN_LUNA) {
    fail(
      `custody holds ${formatNim(custodyBalance)} NIM, needs ${formatNim(CUSTODY_MIN_LUNA)} ` +
        '(fee reserve + principal) — fund it and re-run',
    )
  }
  const sponsorBalance = await ensureFunded(chain, sponsorAddress, SPONSOR_MIN_LUNA, 'sponsor')
  if (sponsorBalance < AMOUNT_EACH_LUNA * BigInt(CLAIM_COUNT)) {
    fail('sponsor was never funded by the faucet')
  }

  const pool = await createRunSchema()
  const evidence: string[] = []

  try {
    // -- 1. draft -----------------------------------------------------------
    const draft = await createDraft(pool, chain, {
      sponsorLabel: 'S3 settlement spike',
      message: 'end-to-end settlement gate',
      amountEachLuna: AMOUNT_EACH_LUNA,
      claimCount: CLAIM_COUNT,
    })
    log('draft created:', draft.publicId, `memo=${draft.fundingMemo}`)
    evidence.push(`- draft \`${draft.publicId}\`, memo \`${draft.fundingMemo}\``)

    // -- 2. sponsor funds it with the exact memo ----------------------------
    const vsh = await chain.headHeight()
    const fundingTx = TransactionBuilder.newBasicWithData(
      sponsor.toAddress(),
      Address.fromAny(draft.fundingAddress),
      new TextEncoder().encode(draft.fundingMemo),
      draft.expectedFundingLuna,
      0n,
      vsh,
      NETWORK_ID[NETWORK],
    )
    fundingTx.sign(sponsor, undefined)
    const fundingHash = fundingTx.hash()
    log(`funding signed: ${fundingHash} value=${formatNim(draft.expectedFundingLuna)} NIM vsh=${vsh}`)
    await chain.broadcast(fundingTx.toHex())
    log('funding broadcast')

    // -- 3. activation by exact hash ----------------------------------------
    const fundingDeadline = Date.now() + FUNDING_TIMEOUT_MS
    let state = 'awaiting_funding'
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
    if (state !== 'live') fail('funding never reached finality')
    lastReconciledAt = Date.now() // submitFunding reconciled on activation
    const live = await getPublic(pool, draft.publicId)
    log(`drop LIVE: remaining=${live.remaining}, expires ${live.expiresAt?.toISOString()}`)
    evidence.push(`- funding tx \`${fundingHash}\` → ${EXPLORER}/tx/${fundingHash}`)

    // -- 4. one claim, signed by the claimant key ---------------------------
    const challenge = await issueChallenge(pool, draft.publicId)
    const signature = claimant
      .sign(new Uint8Array(Buffer.from(challenge.message, 'utf8')))
      .toHex()
    const claim = await reserveClaim(pool, {
      publicId: draft.publicId,
      challengeId: challenge.challengeId,
      publicKeyHex: claimant.publicKey.toHex(),
      signatureHex: signature,
      idemKey: `${RUN_ID}-claim-1`,
      requestHash: `${RUN_ID}-claim-1`,
    })
    log(`claim reserved: ${claim.claimId} state=${claim.state} -> ${claimantAddress}`)

    // -- 5. worker pays it --------------------------------------------------
    await workUntil(
      pool,
      chain,
      'payout',
      async () => (await readClaimStates(pool, draft.publicId))[0] === 'paid',
      PAYOUT_TIMEOUT_MS,
    )
    const afterPayout = await readTransfers(pool, draft.publicId)
    const payout = afterPayout.find((t) => t.purpose === 'payout')
    if (!payout?.tx_hash) fail('payout confirmed without a transaction hash')
    log(`payout CONFIRMED: ${payout.tx_hash} at height ${payout.confirmed_height}`)
    evidence.push(`- payout tx \`${payout.tx_hash}\` → ${EXPLORER}/tx/${payout.tx_hash}`)

    // -- 6. TEST LEVER: force expiry ----------------------------------------
    // The production horizon is 24h after activation (drops.ts EXPIRY_HOURS).
    // This UPDATE is the ONLY thing the script fakes; every transition after it
    // is produced by the shipped services.
    await pool.query(
      `UPDATE drops SET expires_at = now() - interval '1 second' WHERE public_id = $1`,
      [draft.publicId],
    )
    log('TEST LEVER: expires_at set to one second ago')

    // -- 7. sweep -----------------------------------------------------------
    const closed = await sweepExpiry(pool, alerts)
    const afterSweep = await readDropRow(pool, draft.publicId)
    const refundIntent = (await readTransfers(pool, draft.publicId)).find(
      (t) => t.purpose === 'refund',
    )
    log(
      `sweep closed ${closed} drop(s): state=${afterSweep.state}/${afterSweep.closing_reason}, ` +
        `refund=${refundIntent ? `${formatNim(BigInt(refundIntent.amount_luna))} NIM` : 'none'}`,
    )
    if (closed !== 1) fail('sweep did not close the expired drop')
    if (!refundIntent) fail('no refund intent was created for the unallocated slot')
    if (BigInt(refundIntent.amount_luna) !== AMOUNT_EACH_LUNA) {
      fail(
        `refund is ${refundIntent.amount_luna} luna, expected exactly one unallocated slot ` +
          `(${AMOUNT_EACH_LUNA} luna)`,
      )
    }
    if (refundIntent.recipient_address !== sponsorAddress) {
      fail(`refund goes to ${refundIntent.recipient_address}, expected the funding sender`)
    }

    // -- 8. worker refunds, then the drop settles ---------------------------
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
    if (finalDrop.state !== 'refunded') fail(`expected 'refunded', got '${finalDrop.state}'`)

    // -- 9. evidence --------------------------------------------------------
    const finalTransfers = await readTransfers(pool, draft.publicId)
    const refund = finalTransfers.find((t) => t.purpose === 'refund')
    if (refund?.tx_hash) {
      evidence.push(`- refund tx \`${refund.tx_hash}\` → ${EXPLORER}/tx/${refund.tx_hash}`)
    }

    console.log('\n=== S3 EVIDENCE ===')
    console.log('run id           :', RUN_ID)
    console.log('network          :', NETWORK)
    console.log('consensus (s)    :', (consensusMs / 1000).toFixed(1))
    console.log('custody address  :', chain.custodyAddress())
    console.log('sponsor address  :', sponsorAddress)
    console.log('claimant address :', claimantAddress)
    console.log('drop public id   :', draft.publicId)
    console.log('drop final state :', finalDrop.state, `(closing_reason ${finalDrop.closing_reason})`)
    console.log('claim states     :', (await readClaimStates(pool, draft.publicId)).join(', '))
    for (const t of finalTransfers) {
      console.log(
        `${t.purpose.padEnd(7)}          : ${formatNim(BigInt(t.amount_luna))} NIM -> ${t.recipient_address}`,
      )
      console.log(`  intent/attempt : ${t.state} / ${t.attempt_state}`)
      console.log(`  tx             : ${t.tx_hash}`)
      console.log(`  explorer       : ${EXPLORER}/tx/${t.tx_hash}`)
    }
    console.log('custody balance  :', formatNim(await chain.confirmedBalanceLuna(chain.custodyAddress())), 'NIM')
    console.log('total runtime    :', el())
    console.log('=== S3 PASSED ===')

    writeFileSync(
      EVIDENCE_PATH,
      [
        '# G1 local evidence — s3-settlement-e2e',
        '',
        `- run id: \`${RUN_ID}\``,
        `- network: ${NETWORK}`,
        `- ran at: ${new Date().toISOString()}`,
        `- consensus: ${(consensusMs / 1000).toFixed(1)}s`,
        `- custody: \`${chain.custodyAddress()}\``,
        `- sponsor: \`${sponsorAddress}\``,
        `- claimant: \`${claimantAddress}\``,
        `- amounts: ${formatNim(AMOUNT_EACH_LUNA)} NIM × ${CLAIM_COUNT} shares, 1 claimed, 1 refunded`,
        `- final drop state: **${finalDrop.state}**`,
        `- claim states: ${(await readClaimStates(pool, draft.publicId)).join(', ')}`,
        `- total runtime: ${el()}`,
        '',
        '## Transactions',
        '',
        ...evidence,
        '',
        'NOTE: this is a LOCAL run of the harness. The formal G1 record is the same',
        'script executed on the VPS deployment; that output goes to docs/HACKATHON.md §3b.',
        '',
        'Test lever used: `expires_at` forced one second into the past with a direct',
        'UPDATE (the production horizon is 24h). Every transition after that UPDATE was',
        'produced by the shipped services.',
        '',
      ].join('\n'),
    )
    log(`wrote ${EVIDENCE_PATH}`)
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
