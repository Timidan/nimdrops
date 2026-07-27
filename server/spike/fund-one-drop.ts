/**
 * OPERATOR UTILITY — fund ONE drop on a live deployment until it is claimable.
 *
 *   PUBLIC_ID=<22-char id> pnpm tsx spike/fund-one-drop.ts
 *
 * This is the sponsor half of the funding handshake, driven from the operator's
 * side so a real campaign can be put in front of a real phone. It plays the
 * part a human sponsor plays in the product: it pays the exact total to the
 * custody address with the exact `ND1:<publicId>` memo, then hands the hash to
 * the PUBLIC API and waits for production code — not this script — to verify it
 * and flip the drop to `live`.
 *
 * What it deliberately does NOT do: decide that a drop is funded. Nothing here
 * writes to `drops`. The only authority on activation is `submitFunding`,
 * reached over HTTPS exactly as a browser would reach it, so a green run here
 * is evidence about the deployment rather than about this file.
 *
 * ── why custody is not the sender ───────────────────────────────────────────
 * The funding sender becomes the drop's refund address: whatever is unclaimed
 * at expiry goes back to it. Paying from custody would make custody its own
 * refund address and would also fail `proveFloatDeposit`'s self-transfer check
 * if the same money were ever attested. So custody SEEDS a throwaway sponsor
 * and the sponsor pays. The money round-trips out of custody and back in.
 *
 * ── the operator float, and why this script may have to attest one ──────────
 * `activate()` runs `assertSolvent(..., addLuna)`, which requires
 *
 *     ledgerBalance >= outstandingPrincipal + configuredFeeReserve
 *
 * on BOTH sides of the new liability. A fresh deployment has an operator float
 * of 0 and a fee reserve of 1 NIM, so its headroom is −1 NIM and the very first
 * activation is refused — correctly: the system will not take on a claimant's
 * liability before an operator has attested that custody holds working capital
 * on top of it. The API answers that refusal as a 503, which polls forever and
 * looks like a chain problem, so this script checks the headroom UP FRONT and,
 * when it is negative, deposits and attests the shortfall through the same
 * `float set` path `recover.ts` exposes. That step is logged loudly and skipped
 * entirely when the headroom is already non-negative.
 *
 * ── resumability ────────────────────────────────────────────────────────────
 * Finality is 64 blocks — around ten minutes — and a dropped SSH session must
 * not strand money. So the sponsor keypair is DERIVED, not random: it is
 * `sha256(domain || publicId || custody key)`, which means a re-run reproduces
 * the same sponsor address, sees the seed already sitting there, and continues.
 * The key is never written down and never printed. A re-run also reuses the
 * funding hash the drop already recorded rather than paying a second time.
 *
 * ── environment ─────────────────────────────────────────────────────────────
 *   PUBLIC_ID                 (required) the drop to fund
 *   PUBLIC_ORIGIN             (default https://nimdrops.timidan.xyz)
 *   CUSTODY_PRIVATE_KEY_HEX   (required) — read, never printed
 *   DATABASE_URL              (required) — the solvency preflight and `float set`
 *   NIMIQ_NETWORK             (required) — must be TestAlbatross unless
 *                             FUND_ALLOW_MAINNET is set to the network name
 *   FUND_TIMEOUT_MS           (default 900000) per wait
 *
 * Run it through the WORKER service: it is the only one holding the custody
 * key, and the API is deliberately key-less.
 *
 *   docker compose run --rm -e PUBLIC_ID=... --entrypoint sh worker \
 *     -c "cd /app/server && pnpm tsx spike/fund-one-drop.ts"
 */

import { createHash } from 'node:crypto'
import { Address, KeyPair, PrivateKey, TransactionBuilder } from '@nimiq/core'
import type pg from 'pg'
import { NETWORK_ID, NimiqChain, nimiqChainFromEnv } from '../src/chain/nimiq'
import type { ChainTx } from '../src/chain/types'
import { requireNetwork } from '../src/config'
import { closePool, getPool } from '../src/db/pool'
import { exitAfterTeardown } from '../src/exit'
import { formatNim, lunaFromNim } from '../src/money'
import { floatShow, setOperatorFloat } from '../src/recover'
import { fundingMemoFor } from '../src/services/drops'
import { ensureChainBinding } from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number.
import '../src/db/pool'

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const DEFAULT_ORIGIN = 'https://nimdrops.timidan.xyz'
/** `ids.ts`: 16 random bytes, base64url — exactly 22 URL-safe characters. */
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/
/** Per wait, not for the whole run. Finality is 64 blocks ≈ 10 minutes. */
const TIMEOUT_MS = readTimeoutMs()
const POLL_MS = 15_000

function readTimeoutMs(): number {
  const raw = process.env.FUND_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return 900_000
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 60_000) {
    throw new Error(
      `FUND_TIMEOUT_MS=${JSON.stringify(raw)} is not a number of milliseconds >= 60000. ` +
        'Finality alone takes about ten minutes; a shorter wait can only ever time out.',
    )
  }
  return ms
}

/** States from which a funding transaction can still be submitted. */
const FUNDABLE = new Set(['awaiting_funding', 'funding_pending'])

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const startedAt = Date.now()

function log(...parts: unknown[]): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7)
  console.log(`[${seconds}s]`, ...parts)
}

/**
 * Stop. Every failure in this script is an operator-facing failure: the money
 * is real, and a step that "carried on anyway" would either strand it or send
 * it somewhere nothing can spend it from.
 */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}\n`)
  throw new FundOneDropError(message)
}

class FundOneDropError extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function nim(luna: bigint): string {
  return `${formatNim(luna)} NIM`
}

/**
 * `formatNim` divides and takes a remainder, which produces nonsense like
 * `-1.-5` for a negative fraction. Solvency headroom is routinely negative —
 * that is the whole reason this script reads it — so sign it by hand.
 */
function signedNim(luna: bigint): string {
  return luna < 0n ? `-${nim(-luna)}` : nim(luna)
}

// ---------------------------------------------------------------------------
// the public API, reached exactly as a browser reaches it
// ---------------------------------------------------------------------------

interface DropPublicBody {
  publicId: string
  sponsorLabel: string
  message: string | null
  amountEach: string
  claimCount: number
  remaining: number
  state: string
  expiresAt: string | null
  fundingTxHash?: string
}

interface ApiResult {
  status: number
  body: unknown
}

/**
 * One API call, or FAIL.
 *
 * A transport error is not an ANSWER, so it is retried a few times rather than
 * ending the run: this script spends ten minutes polling and must not lose that
 * to a single DNS blip. An HTTP status IS an answer, and is handed straight
 * back to the caller to judge — never retried here.
 */
async function api(origin: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const method = init?.method ?? 'GET'
  let res: Response | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(`${origin}${path}`, init)
      break
    } catch (err) {
      if (attempt === 3) {
        fail(`${method} ${path}: the deployment is unreachable after 3 tries (${String(err)})`)
      }
      log(`${method} ${path}: transport error (${String(err)}); retrying`)
      await sleep(5_000)
    }
  }
  assert(res !== null, `${method} ${path}: retry loop exited without a response`)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    fail(
      `${method} ${path}: HTTP ${res.status} with a non-JSON body — is ${origin} really the ` +
        `NimDrops API? First 200 bytes: ${text.slice(0, 200)}`,
    )
  }
  return { status: res.status, body }
}

function errorCode(body: unknown): string | null {
  const envelope = body as { error?: { code?: unknown } } | null
  const code = envelope?.error?.code
  return typeof code === 'string' ? code : null
}

/** Read the drop, or FAIL. Never returns a partially-understood shape. */
async function readDrop(origin: string, publicId: string): Promise<DropPublicBody> {
  const { status, body } = await api(origin, `/api/drops/${publicId}`)
  if (status === 404) fail(`drop ${publicId} does not exist on ${origin}`)
  assert(status === 200, `GET /api/drops/${publicId}: HTTP ${status} ${JSON.stringify(body)}`)

  const drop = body as DropPublicBody
  assert(
    drop.publicId === publicId,
    `the API answered for ${drop.publicId}, not the requested ${publicId}`,
  )
  assert(
    typeof drop.amountEach === 'string' && typeof drop.claimCount === 'number',
    `unexpected drop shape from ${origin}: ${JSON.stringify(body)}`,
  )
  return drop
}

// ---------------------------------------------------------------------------
// chain helpers — the shapes proven in `s3-settlement-e2e.ts`
// ---------------------------------------------------------------------------

/** Poll `ok()` until true, or FAIL. Never returns a "didn't happen". */
async function waitFor(
  label: string,
  ok: () => Promise<boolean>,
  timeoutMs = TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  while (Date.now() < deadline) {
    if (await ok()) {
      log(`${label}: reached after ${polls} poll(s)`)
      return
    }
    polls += 1
    await sleep(5_000)
  }
  fail(`${label}: timed out after ${(timeoutMs / 1000).toFixed(0)}s`)
}

/**
 * Wait for OUR finality depth, never the library's `confirmed`.
 *
 * `getTransaction` REJECTS on an unknown hash rather than resolving null;
 * `NimiqChain` already turns that into `null`, which is the only reason this
 * loop can be written as a predicate.
 */
async function waitFinal(chain: NimiqChain, hash: string, label: string): Promise<ChainTx> {
  let found: ChainTx | null = null
  await waitFor(`${label} final`, async () => {
    found = await chain.getTransaction(hash)
    if (!found) return false
    return chain.isFinal(found, await chain.headHeight())
  })
  const tx = found as ChainTx | null
  assert(tx !== null, `${label}: the finality loop exited without a transaction`)
  log(`${label}: FINAL at height ${tx.includedHeight}`)
  return tx
}

/**
 * Build, sign and broadcast one transaction FROM the sponsor. The hash is known
 * BEFORE the bytes leave, which is what makes an interrupted broadcast
 * recoverable instead of a mystery.
 *
 * `newBasicWithData` takes the data as its THIRD positional argument, as a
 * `Uint8Array` — not a trailing option, and not a string.
 */
async function sponsorSend(
  chain: NimiqChain,
  sponsor: KeyPair,
  network: 'TestAlbatross' | 'MainAlbatross',
  o: { to: string; valueLuna: bigint; memo?: string; label: string },
): Promise<string> {
  const validityStartHeight = await chain.headHeight()
  const fee = chain.feeLuna()
  const tx =
    o.memo === undefined
      ? TransactionBuilder.newBasic(
          sponsor.toAddress(),
          Address.fromAny(o.to),
          o.valueLuna,
          fee,
          validityStartHeight,
          NETWORK_ID[network],
        )
      : TransactionBuilder.newBasicWithData(
          sponsor.toAddress(),
          Address.fromAny(o.to),
          new TextEncoder().encode(o.memo),
          o.valueLuna,
          fee,
          validityStartHeight,
          NETWORK_ID[network],
        )
  // In-place mutation, and the second positional argument is required.
  tx.sign(sponsor, undefined)
  tx.verify(NETWORK_ID[network])

  const hash = tx.hash()
  log(
    `${o.label}: SIGNED ${hash} value=${nim(o.valueLuna)} fee=${fee} vsh=${validityStartHeight}` +
      (o.memo === undefined ? ' memo=<none>' : ` memo=${JSON.stringify(o.memo)}`),
  )
  await chain.broadcast(tx.toHex())
  log(`${o.label}: broadcast`)
  return hash
}

/** Seed the sponsor out of custody, through the real custody signer. */
async function custodySend(
  chain: NimiqChain,
  o: { to: string; valueLuna: bigint; label: string },
): Promise<string> {
  const built = await chain.buildSignedBasic({
    to: o.to,
    valueLuna: o.valueLuna,
    validityStartHeight: await chain.headHeight(),
  })
  log(`${o.label}: SIGNED ${built.txHash} value=${nim(o.valueLuna)} fee=${built.feeLuna}`)
  await chain.broadcast(built.rawTxHex)
  log(`${o.label}: broadcast`)
  return built.txHash
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Held at module scope purely so `teardown` can reach the client.
 *
 * `exit.ts` is emphatic about why the ending is shaped this way: a process that
 * has held a `@nimiq/core` client never releases the event loop by itself, and
 * the library can raise an uncaught `unwrap_throw` AFTER the work is finished.
 * So the outcome is decided in `run()`, and teardown happens under
 * `exitAfterTeardown`, where a late fault can no longer change the exit code.
 */
let openChain: NimiqChain | null = null

async function teardown(): Promise<void> {
  await openChain?.close()
  await closePool()
}

async function run(): Promise<void> {
  console.log('=== NimDrops — fund one live drop ===\n')

  // -- 0. inputs -------------------------------------------------------------
  const publicId = (process.env.PUBLIC_ID ?? '').trim()
  assert(publicId !== '', 'PUBLIC_ID is not set — nothing to fund')
  assert(
    PUBLIC_ID_RE.test(publicId),
    `PUBLIC_ID ${JSON.stringify(publicId)} is not a 22-character public id`,
  )
  const origin = (process.env.PUBLIC_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  assert(origin.startsWith('https://'), `PUBLIC_ORIGIN must be https, got ${origin}`)

  const custodyKeyHex = process.env.CUSTODY_PRIVATE_KEY_HEX
  assert(
    custodyKeyHex !== undefined && custodyKeyHex.trim() !== '',
    'CUSTODY_PRIVATE_KEY_HEX is not set. Run this through the WORKER service — the API is ' +
      'deliberately key-less and cannot sign or broadcast.',
  )

  const network = requireNetwork()
  if (network !== 'TestAlbatross') {
    assert(
      process.env.FUND_ALLOW_MAINNET === network,
      `NIMIQ_NETWORK is ${network}. This utility spends real money from custody; set ` +
        `FUND_ALLOW_MAINNET=${network} to say that is intended.`,
    )
  }

  console.log('origin       :', origin)
  console.log('public id    :', publicId)
  console.log('network      :', network)

  // -- 1. read the drop, and only then decide what it costs ------------------
  const before = await readDrop(origin, publicId)
  console.log('sponsor label:', JSON.stringify(before.sponsorLabel))
  console.log('state        :', before.state)
  console.log('amount each  :', before.amountEach, 'NIM ×', before.claimCount)

  if (before.state === 'live') {
    fail(
      `drop ${publicId} is already live (${before.remaining}/${before.claimCount} shares left). ` +
        'Funding it again would pay a second time for capacity it already has.',
    )
  }
  assert(
    FUNDABLE.has(before.state),
    `drop ${publicId} is in state ${before.state}, which cannot be funded. Only ` +
      `${[...FUNDABLE].join(' or ')} can.`,
  )

  const amountEachLuna = lunaFromNim(before.amountEach)
  assert(amountEachLuna > 0n, `amountEach ${before.amountEach} parsed to ${amountEachLuna} luna`)
  assert(
    Number.isInteger(before.claimCount) && before.claimCount > 0,
    `claimCount ${before.claimCount} is not a positive integer`,
  )
  const fundingLuna = amountEachLuna * BigInt(before.claimCount)
  const memo = fundingMemoFor(publicId)
  assert(
    memo === `ND1:${publicId}`,
    `the memo builder produced ${JSON.stringify(memo)}, not ND1:${publicId}`,
  )

  console.log('funding total:', nim(fundingLuna), `(${fundingLuna} luna)`)
  console.log('funding memo :', memo)

  // -- 2. connect -------------------------------------------------------------
  const chain = nimiqChainFromEnv({ logLevel: 'warn' })
  openChain = chain
  const pool: pg.Pool = getPool()
  {
    log('establishing consensus…')
    await chain.connect()
    const custody = chain.custodyAddress()
    log(`consensus up; head ${await chain.headHeight()}`)
    console.log('custody      :', custody)
    console.log('finality     :', chain.finalityDepthBlocks(), 'blocks')
    console.log('fee (luna)   :', chain.feeLuna().toString())

    // The database records which wallet this deployment's money lives in. If
    // the key in this process derives a different address, the funding would be
    // paid to an address the API never publishes and nothing can spend from.
    const binding = await ensureChainBinding(pool, chain)
    assert(
      binding.custodyAddress === custody,
      `custody binding mismatch: the database is bound to ${binding.custodyAddress}, this ` +
        `process signs for ${custody}`,
    )
    assert(
      binding.network === network,
      `network binding mismatch: the database is bound to ${binding.network}, this process is ` +
        `on ${network}`,
    )
    log(`chain binding verified: ${binding.network} / ${binding.custodyAddress}`)

    // -- 3. solvency preflight ------------------------------------------------
    // Read BEFORE any money moves. A negative headroom here is the difference
    // between a ten-minute wait that ends in `live` and one that polls a 503
    // until the timeout and tells the operator nothing about why.
    const solvencyBefore = (await floatShow(pool, chain)).solvency
    const feeReserveLuna = BigInt(solvencyBefore.feeReserveLuna)
    const headroomLuna = BigInt(solvencyBefore.solvencyHeadroomLuna)
    const attestedLuna = BigInt(solvencyBefore.attestedFloatDepositsLuna)
    // `null` since migration 015 means no principal cap is set — not "no room".
    const capHeadroomLuna =
      solvencyBefore.livePrincipalHeadroomLuna === null
        ? null
        : BigInt(solvencyBefore.livePrincipalHeadroomLuna)

    console.log('\n--- solvency before ---')
    console.log('operator float  :', nim(BigInt(solvencyBefore.operatorFloatLuna)))
    console.log('fee reserve     :', nim(feeReserveLuna))
    console.log('headroom        :', signedNim(headroomLuna))
    console.log('cap headroom    :', capHeadroomLuna === null ? 'uncapped' : nim(capHeadroomLuna))

    assert(
      !solvencyBefore.paused,
      'custody is PAUSED, so activation will be refused. Unpause it first: ' +
        'pnpm tsx src/recover.ts unpause',
    )
    assert(
      solvencyBefore.shortfallDetectedAt === null,
      `a reconciliation saw the chain below the books at ${solvencyBefore.shortfallDetectedAt} ` +
        'and none has succeeded since. Unpausing does not clear this and neither does funding ' +
        'a drop — investigate before adding a new liability.',
    )
    assert(
      solvencyBefore.floatAttributed,
      'the operator float does not equal the deposits backing it. Refusing to add to a ledger ' +
        'that already credits money nothing on chain has been pointed at.',
    )
    assert(
      capHeadroomLuna === null || capHeadroomLuna >= fundingLuna,
      `this drop needs ${nim(fundingLuna)} of live principal but only ` +
        `${capHeadroomLuna === null ? '0' : nim(capHeadroomLuna)} is left under ` +
        'max_live_principal_luna',
    )

    // The shortfall to cover, plus one fee reserve of working room on top so
    // the drop's own payouts are not immediately back at zero headroom.
    const depositLuna = headroomLuna >= 0n ? 0n : -headroomLuna + feeReserveLuna
    if (depositLuna > 0n) {
      console.log(
        `\n!! OPERATOR FLOAT REQUIRED: headroom is ${signedNim(headroomLuna)}, so activation would be\n` +
          `!! refused. This run will deposit ${nim(depositLuna)} into custody and attest it as\n` +
          '!! operator float through the same path `recover.ts float set` uses.',
      )
    } else {
      log('solvency headroom is already non-negative; no float attestation needed')
    }

    // -- 4. the sponsor --------------------------------------------------------
    // Derived, not random: a re-run after a dropped SSH session must find the
    // same wallet holding the same seed rather than stranding it. Never printed.
    const sponsorKeyHex =
      process.env.FUND_SPONSOR_PRIVATE_KEY_HEX?.trim() ||
      createHash('sha256')
        .update(`nimdrops/fund-one-drop/v1/${network}/${publicId}/`, 'utf8')
        .update(custodyKeyHex, 'utf8')
        .digest('hex')
    const sponsor = KeyPair.derive(PrivateKey.fromHex(sponsorKeyHex))
    const sponsorAddress = sponsor.toAddress().toUserFriendlyAddress()
    assert(
      sponsorAddress !== custody,
      'the derived sponsor IS the custody address. The funding sender becomes the drop’s refund ' +
        'address, so custody must not fund its own drop.',
    )
    console.log('\nsponsor      :', sponsorAddress)

    // The sponsor's two sends each pay `chain.feeLuna()`, so seed for both.
    const sponsorNeedLuna = depositLuna + fundingLuna + chain.feeLuna() * 2n
    const sponsorHasLuna = await chain.confirmedBalanceLuna(sponsorAddress)
    log(`sponsor holds ${nim(sponsorHasLuna)}, needs ${nim(sponsorNeedLuna)}`)

    if (sponsorHasLuna < sponsorNeedLuna) {
      const seedLuna = sponsorNeedLuna - sponsorHasLuna
      const custodyLuna = await chain.confirmedBalanceLuna(custody)
      assert(
        custodyLuna >= seedLuna,
        `custody holds ${nim(custodyLuna)} but must seed ${nim(seedLuna)} — top it up first`,
      )
      await custodySend(chain, {
        to: sponsorAddress,
        valueLuna: seedLuna,
        label: 'sponsor seed (custody → sponsor)',
      })
      await waitFor(
        'sponsor seed credited',
        async () => (await chain.confirmedBalanceLuna(sponsorAddress)) >= sponsorNeedLuna,
      )
    } else {
      log('sponsor is already seeded; skipping')
    }

    // -- 5. operator float, if the preflight said so ---------------------------
    if (depositLuna > 0n) {
      // NO MEMO. A deposit carrying `ND1:` is drop money by construction and
      // `proveFloatDeposit` refuses it — operator float is deposited bare.
      const depositHash = await sponsorSend(chain, sponsor, network, {
        to: custody,
        valueLuna: depositLuna,
        label: 'float deposit (sponsor → custody)',
      })
      const depositTx = await waitFinal(chain, depositHash, 'float deposit')
      assert(depositTx.executionOk, `float deposit ${depositHash} did not execute`)

      const result = await setOperatorFloat(
        pool,
        chain,
        (attestedLuna + depositLuna).toString(),
        depositHash,
      )
      log(
        `float attested: ${result.operatorFloatLuna.before} -> ${result.operatorFloatLuna.after} ` +
          `luna, headroom ${result.solvencyHeadroomLuna.before} -> ` +
          `${result.solvencyHeadroomLuna.after}`,
      )
      const after = BigInt((await floatShow(pool, chain)).solvency.solvencyHeadroomLuna)
      assert(
        after >= 0n,
        `headroom is still ${signedNim(after)} after attesting ${nim(depositLuna)} — activation would ` +
          'still be refused',
      )
      console.log(`float deposit  : https://test.nimiq.watch/#${depositHash}`)
    }

    // -- 6. the funding payment ------------------------------------------------
    const current = await readDrop(origin, publicId)
    assert(
      FUNDABLE.has(current.state),
      `drop moved to ${current.state} while this run was preparing; refusing to pay`,
    )

    let fundingHash: string
    if (current.fundingTxHash !== undefined) {
      fundingHash = current.fundingTxHash
      log(`drop already records funding ${fundingHash}; reusing it instead of paying twice`)
    } else {
      fundingHash = await sponsorSend(chain, sponsor, network, {
        to: custody,
        valueLuna: fundingLuna,
        memo,
        label: 'drop funding (sponsor → custody)',
      })
    }
    assert(TX_HASH_RE.test(fundingHash), `funding hash ${fundingHash} is not 32 bytes of hex`)

    const explorerUrl = `https://${network === 'MainAlbatross' ? '' : 'test.'}nimiq.watch/#${fundingHash}`
    console.log('\nfunding tx   :', fundingHash)
    console.log('explorer     :', explorerUrl)

    // -- 7. hand the hash to production and wait for IT to say live ------------
    // Nothing below decides anything. `submitFunding` re-derives the memo,
    // re-checks the amount and the recipient, and applies its own 64-block
    // finality rule; this loop only asks, prints, and waits.
    console.log(
      `\npolling POST /api/drops/${publicId}/funding every ${POLL_MS / 1000}s until the public ` +
        'state is live\n(finality is 64 blocks, so allow ~10 minutes)\n',
    )
    const deadline = Date.now() + TIMEOUT_MS
    let state = current.state
    let polls = 0
    while (state !== 'live') {
      if (Date.now() > deadline) {
        fail(
          `the drop is still ${state} after ${(TIMEOUT_MS / 1000).toFixed(0)}s. The funding ` +
            `transaction ${fundingHash} is on chain — re-run this script to keep polling; it ` +
            'will reuse the same hash and pay nothing more.',
        )
      }
      polls += 1
      const { status, body } = await api(origin, `/api/drops/${publicId}/funding`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: fundingHash }),
      })

      if (status === 200) {
        const drop = body as DropPublicBody
        state = drop.state
        log(
          `poll ${polls}: HTTP 200 state=${state}` +
            (drop.fundingTxHash === undefined ? ' (hash not yet recorded)' : ' (hash recorded)'),
        )
      } else if (status === 503) {
        // Degraded, paused, or insolvent. Retryable by design, but the
        // preflight above should have made insolvency impossible.
        log(`poll ${polls}: HTTP 503 ${errorCode(body) ?? 'unavailable'} — retrying`)
      } else {
        // 422 is a funding predicate refusing this transaction. It will never
        // become true by waiting.
        fail(
          `POST funding answered HTTP ${status} ${errorCode(body) ?? ''}: ` +
            `${JSON.stringify(body)}. This is a verdict, not a delay.`,
        )
      }

      if (state !== 'live') await sleep(POLL_MS)
    }

    // -- 8. the artifacts an owner actually needs ------------------------------
    const final = await readDrop(origin, publicId)
    assert(final.state === 'live', `final read says ${final.state}, not live`)
    assert(
      final.fundingTxHash === fundingHash,
      `the drop recorded funding ${final.fundingTxHash}, not ${fundingHash}`,
    )

    const shareUrl = `${origin}/d/${publicId}`
    const deeplink = `nimiqpay://miniapp?url=${encodeURIComponent(shareUrl)}`

    console.log('\n=== LIVE ===')
    console.log('state        :', final.state)
    console.log('shares       :', `${final.remaining}/${final.claimCount} unclaimed`)
    console.log('each         :', final.amountEach, 'NIM')
    console.log('expires at   :', final.expiresAt)
    console.log('funding tx   :', fundingHash)
    console.log('explorer     :', explorerUrl)
    console.log('refund addr  :', sponsorAddress, '(the funding sender)')
    console.log('\nshare url    :', shareUrl)
    console.log('deeplink     :', deeplink)
    console.log('')
  }
}

// The outcome is fixed HERE, before teardown starts, and a `@nimiq/core` fault
// raised on the way out is logged rather than allowed to rewrite it (exit.ts).
run().then(
  () => exitAfterTeardown(0, teardown, (message) => console.error(message)),
  (err: unknown) => {
    // `fail()` has already printed its own message; anything else has not.
    if (!(err instanceof FundOneDropError)) {
      console.error('\nFAILED:', err instanceof Error ? (err.stack ?? err.message) : String(err), '\n')
    }
    exitAfterTeardown(1, teardown, (message) => console.error(message))
  },
)
