/**
 * G0 SPIKE S1 — server-side custody engine, end to end, against a real chain.
 *
 *   pnpm tsx spike/s1-custody.ts
 *
 * Proves design §2 items 3, 5, 8 and the §7 funding predicate:
 *
 *   1. Derive the custody address from `CUSTODY_PRIVATE_KEY_HEX` and print it.
 *   2. Wait for a funding transaction that pays the custody address exactly
 *      `SPIKE_FUNDING_NIM` with the ASCII memo `ND1:spike1`.
 *   3. Verify THAT EXACT HASH against every §7 predicate. Never by memo scan.
 *   4. Build + sign a payout of half the funding back to the verified sender,
 *      persist `{rawTxHex, txHash}` to `spike-attempt.json` BEFORE broadcasting.
 *   5. Broadcast the persisted bytes, poll to finality, print the evidence.
 *
 * TESTNET CONVENIENCE (TestAlbatross only, refuses to run on MainAlbatross):
 * with no `CUSTODY_PRIVATE_KEY_HEX` in the environment the script generates a
 * throwaway custody key AND a throwaway "sponsor" key, stores them in
 * `spike/.dev-key` (gitignored, mode 0600), taps the public testnet faucet for
 * the sponsor, and has the sponsor submit the funding transaction. The sponsor
 * stands in for a Nimiq Pay wallet: it signs locally, learns the hash BEFORE
 * broadcast, and hands only that hash to the verifier — exactly the shape of
 * the real `POST /drops/:id/funding` flow.
 *
 * On MainAlbatross none of that happens: the key must come from the
 * environment and a human must send the funding transaction.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  Address,
  KeyPair,
  Policy,
  PrivateKey,
  TransactionBuilder,
} from '@nimiq/core'
import type { ChainTx } from '../src/chain/types'
import { NETWORK_ID, NimiqChain, POLICY_SNAPSHOT, type NimiqNetwork } from '../src/chain/nimiq'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_KEY_PATH = join(HERE, '.dev-key')
const ATTEMPT_PATH = join(HERE, 'spike-attempt.json')
const FUNDING_PATH = join(HERE, 's1-funding.json')

const FUNDING_MEMO = 'ND1:spike1'
/** The launch claim memo. Included so the spike measures a multi-byte memo too. */
const PAYOUT_MEMO = '🧧 NimDrop'
const LUNA_PER_NIM = 100_000n
const FAUCET_URL = 'https://faucet.pos.nimiq-testnet.com/tapit'
const EXPLORER = { TestAlbatross: 'https://test.nimiq.watch', MainAlbatross: 'https://nimiq.watch' }

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
function log(...a: unknown[]): void {
  console.log(`[${el()}]`, ...a)
}
function fail(msg: string): never {
  console.error(`\n✗ SPIKE FAILED: ${msg}\n`)
  process.exit(1)
}

const NETWORK = (process.env.NIMIQ_NETWORK ?? 'TestAlbatross') as NimiqNetwork
const IS_TESTNET = NETWORK === 'TestAlbatross'
const FUNDING_LUNA = nimToLuna(process.env.SPIKE_FUNDING_NIM ?? '1')

function nimToLuna(nim: string): bigint {
  if (!/^\d+(\.\d{1,5})?$/.test(nim)) fail(`invalid SPIKE_FUNDING_NIM: ${nim}`)
  const [whole, frac = ''] = nim.split('.')
  return BigInt(whole) * LUNA_PER_NIM + BigInt(frac.padEnd(5, '0'))
}
function fmtNim(luna: bigint): string {
  const w = luna / LUNA_PER_NIM
  const f = (luna % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return f ? `${w}.${f} NIM` : `${w} NIM`
}
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// dev keys (testnet only)
// ---------------------------------------------------------------------------

interface DevKeys {
  custodyPrivateKeyHex: string
  sponsorPrivateKeyHex: string
}

function loadOrCreateDevKeys(): DevKeys {
  if (existsSync(DEV_KEY_PATH)) {
    return JSON.parse(readFileSync(DEV_KEY_PATH, 'utf8')) as DevKeys
  }
  if (!IS_TESTNET) fail('refusing to generate a key on MainAlbatross')
  const keys: DevKeys = {
    custodyPrivateKeyHex: PrivateKey.generate().toHex(),
    sponsorPrivateKeyHex: PrivateKey.generate().toHex(),
  }
  writeFileSync(DEV_KEY_PATH, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
  console.log(`\n*** GENERATED THROWAWAY TESTNET KEYS -> ${DEV_KEY_PATH} (gitignored) ***`)
  console.log('*** TESTNET ONLY. Never reuse these on MainAlbatross. ***\n')
  return keys
}

async function tapFaucet(address: string): Promise<void> {
  if (!IS_TESTNET) fail('faucet is TestAlbatross only')
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address }).toString(),
  })
  log('faucet responded', res.status, (await res.text()).slice(0, 200))
}

// ---------------------------------------------------------------------------
// §7 funding predicate — the whole point of the spike
// ---------------------------------------------------------------------------

interface PredicateResult {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

function checkFundingPredicate(o: {
  tx: ChainTx
  submittedHash: string
  chain: NimiqChain
  head: number
}): PredicateResult {
  const { tx, submittedHash, chain, head } = o
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  add('hash is the exact submitted hash', tx.hash === submittedHash, `${tx.hash} vs ${submittedHash}`)
  add('correct network', chain.network() === NETWORK, chain.network())
  add('recipient is custody address', tx.recipient === chain.custodyAddress(), tx.recipient)
  add('value exactly equals expected', tx.valueLuna === FUNDING_LUNA, `${tx.valueLuna} vs ${FUNDING_LUNA}`)
  add('memo exactly equals ND1:spike1', tx.dataUtf8 === FUNDING_MEMO, JSON.stringify(tx.dataUtf8))
  add('memo within 64 UTF-8 bytes', utf8Bytes(tx.dataUtf8 ?? '') <= 64, `${utf8Bytes(tx.dataUtf8 ?? '')} bytes`)
  add('sender is a parseable address', isParseableAddress(tx.sender), tx.sender)
  add('sender is not the custody address', tx.sender !== chain.custodyAddress(), tx.sender)
  add('execution ok', tx.executionOk, String(tx.executionOk))
  add('final', chain.isFinal(tx, head), `head ${head} >= ${tx.includedHeight} + ${chain.finalityDepthBlocks()}`)

  return { ok: checks.every((c) => c.ok), checks }
}

function isParseableAddress(s: string): boolean {
  try {
    Address.fromAny(s)
    return true
  } catch {
    return false
  }
}

function printChecks(r: PredicateResult): void {
  for (const c of r.checks) console.log(`   ${c.ok ? '✓' : '✗'} ${c.name}  (${c.detail})`)
}

// ---------------------------------------------------------------------------
// finality
// ---------------------------------------------------------------------------

async function waitForFinality(chain: NimiqChain, tx: ChainTx, label: string): Promise<number> {
  const target = tx.includedHeight + chain.finalityDepthBlocks()
  const started = Date.now()
  log(
    `${label}: included at ${tx.includedHeight} ` +
      `(batch ${Policy.batchAt(tx.includedHeight)}, ` +
      `epoch ${Policy.epochAt(tx.includedHeight)}, ` +
      `macro=${Policy.isMacroBlockAt(tx.includedHeight)}); ` +
      `next macro block ${Policy.macroBlockAfter(tx.includedHeight)}; ` +
      `finality target ${target}`,
  )
  let head = await chain.headHeight()
  let loggedMacro = false
  while (head < target) {
    if (!loggedMacro && head >= Policy.macroBlockAfter(tx.includedHeight)) {
      loggedMacro = true
      log(
        `${label}: MACRO BLOCK ${Policy.macroBlockAfter(tx.includedHeight)} passed after ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s — batch containing the tx is finalised`,
      )
    }
    await sleep(2000)
    head = await chain.headHeight()
  }
  const secs = (Date.now() - started) / 1000
  log(`${label}: FINAL at head ${head} after ${secs.toFixed(1)}s (${head - tx.includedHeight} blocks)`)
  return secs
}

/** Polls until the hash is included, or times out. Returns null on timeout. */
async function waitForInclusion(
  chain: NimiqChain,
  hash: string,
  timeoutMs: number,
  label: string,
): Promise<ChainTx | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tx = await chain.getTransaction(hash)
    if (tx) return tx
    const raw = await chain.getTransactionDetails(hash)
    log(`${label}: waiting — state=${raw?.state ?? 'unknown-hash'}`)
    await sleep(3000)
  }
  return null
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== G0 SPIKE S1 — custody engine ===')
  console.log('network      :', NETWORK, `(networkId ${NETWORK_ID[NETWORK]})`)
  console.log('policy       :', JSON.stringify(POLICY_SNAPSHOT, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)))
  console.log('funding value:', fmtNim(FUNDING_LUNA), `= ${FUNDING_LUNA} luna`)
  console.log('funding memo :', JSON.stringify(FUNDING_MEMO), `(${utf8Bytes(FUNDING_MEMO)} UTF-8 bytes)`)
  console.log('payout memo  :', JSON.stringify(PAYOUT_MEMO), `(${utf8Bytes(PAYOUT_MEMO)} UTF-8 bytes)`)

  let custodyKeyHex = process.env.CUSTODY_PRIVATE_KEY_HEX
  let sponsorKeyHex: string | undefined
  if (!custodyKeyHex) {
    const keys = loadOrCreateDevKeys()
    custodyKeyHex = keys.custodyPrivateKeyHex
    sponsorKeyHex = keys.sponsorPrivateKeyHex
  }

  const chain = new NimiqChain({
    network: NETWORK,
    custodyPrivateKeyHex: custodyKeyHex,
    logLevel: 'warn',
  })

  console.log('\ncustody addr :', chain.custodyAddress())
  console.log('fee (luna)   :', chain.feeLuna())
  console.log('finality depth:', chain.finalityDepthBlocks(), 'blocks\n')

  // -- 1. consensus ---------------------------------------------------------
  const cStart = Date.now()
  await chain.connect()
  const consensusMs = Date.now() - cStart
  const head0 = await chain.headHeight()
  log(`consensus established in ${(consensusMs / 1000).toFixed(1)}s; head ${head0}`)

  // -- 2. obtain the funding transaction hash -------------------------------
  let submittedHash = process.env.SPIKE_FUNDING_TX_HASH ?? ''

  if (!submittedHash && sponsorKeyHex && IS_TESTNET) {
    // Stand-in for the Nimiq Pay wallet: sign locally, learn the hash before
    // broadcast, hand ONLY the hash to the verifier.
    const sponsor = KeyPair.derive(PrivateKey.fromHex(sponsorKeyHex))
    const sponsorAddr = sponsor.toAddress().toUserFriendlyAddress()
    log('sponsor (stand-in wallet):', sponsorAddr)

    let bal = await chain.confirmedBalanceLuna(sponsorAddr)
    log('sponsor balance:', fmtNim(bal))
    if (bal < FUNDING_LUNA * 4n) {
      log('tapping testnet faucet for sponsor…')
      await tapFaucet(sponsorAddr)
      const deadline = Date.now() + 180_000
      while (bal < FUNDING_LUNA * 4n && Date.now() < deadline) {
        await sleep(4000)
        bal = await chain.confirmedBalanceLuna(sponsorAddr)
        log('sponsor balance:', fmtNim(bal))
      }
    }
    if (bal < FUNDING_LUNA) fail('sponsor was never funded by the faucet')

    const vsh = await chain.headHeight()
    const fundingTx = TransactionBuilder.newBasicWithData(
      sponsor.toAddress(),
      Address.fromAny(chain.custodyAddress()),
      new TextEncoder().encode(FUNDING_MEMO),
      FUNDING_LUNA,
      0n, // measuring whether a 0-fee transaction is accepted
      vsh,
      NETWORK_ID[NETWORK],
    )
    fundingTx.sign(sponsor, undefined)
    submittedHash = fundingTx.hash()
    log(
      `sponsor funding tx signed: hash=${submittedHash} fee=${fundingTx.fee} ` +
        `size=${fundingTx.serializedSize}B format=${fundingTx.format} vsh=${vsh}`,
    )
    await chain.broadcast(fundingTx.toHex())
    log('sponsor funding tx broadcast')
  }

  if (!submittedHash) {
    console.log('\n--- WAITING FOR OPERATOR FUNDING ---')
    console.log(`Send EXACTLY ${fmtNim(FUNDING_LUNA)} to ${chain.custodyAddress()}`)
    console.log(`with the transaction data / memo:  ${FUNDING_MEMO}`)
    console.log('Then re-run with SPIKE_FUNDING_TX_HASH=<hash>.')
    fail('no funding tx hash supplied (set SPIKE_FUNDING_TX_HASH)')
  }

  // -- 3. verify by exact hash ----------------------------------------------
  log('verifying funding by exact hash', submittedHash)
  const funding = await waitForInclusion(chain, submittedHash, 300_000, 'funding')
  if (!funding) fail('funding tx never appeared on chain')
  const fundingFinalitySecs = await waitForFinality(chain, funding, 'funding')

  const head1 = await chain.headHeight()
  const predicate = checkFundingPredicate({ tx: funding, submittedHash, chain, head: head1 })
  console.log('\n--- §7 FUNDING PREDICATE ---')
  printChecks(predicate)
  if (!predicate.ok) fail('funding predicate rejected the transaction')
  console.log('--- predicate PASSED ---\n')

  writeFileSync(
    FUNDING_PATH,
    `${JSON.stringify(
      {
        network: NETWORK,
        custodyAddress: chain.custodyAddress(),
        fundingTxHash: funding.hash,
        sender: funding.sender,
        valueLuna: funding.valueLuna.toString(),
        memo: funding.dataUtf8,
        includedHeight: funding.includedHeight,
        finalitySeconds: fundingFinalitySecs,
      },
      null,
      2,
    )}\n`,
  )

  const custodyBal = await chain.confirmedBalanceLuna(chain.custodyAddress())
  log('custody balance after funding:', fmtNim(custodyBal))

  // -- 4. sign + persist BEFORE broadcast -----------------------------------
  const payoutLuna = funding.valueLuna / 2n
  const vsh = await chain.headHeight()
  const built = await chain.buildSignedBasic({
    to: funding.sender, // the immutable verified sender, never a client-supplied address
    valueLuna: payoutLuna,
    dataUtf8: PAYOUT_MEMO,
    validityStartHeight: vsh,
  })
  log(`payout signed: hash=${built.txHash} value=${fmtNim(payoutLuna)} fee=${built.feeLuna} vsh=${vsh}`)

  // Determinism check: identical inputs must reproduce identical bytes+hash,
  // which is what makes rebroadcast-after-crash safe.
  const rebuilt = await chain.buildSignedBasic({
    to: funding.sender,
    valueLuna: payoutLuna,
    dataUtf8: PAYOUT_MEMO,
    validityStartHeight: vsh,
  })
  log(
    'build determinism:',
    rebuilt.txHash === built.txHash && rebuilt.rawTxHex === built.rawTxHex ? 'IDENTICAL ✓' : 'DIFFERENT ✗',
  )

  writeFileSync(
    ATTEMPT_PATH,
    `${JSON.stringify(
      {
        purpose: 's1 payout',
        network: NETWORK,
        rawTxHex: built.rawTxHex,
        txHash: built.txHash,
        feeLuna: built.feeLuna.toString(),
        valueLuna: payoutLuna.toString(),
        recipient: funding.sender,
        validityStartHeight: vsh,
        signedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  log(`PERSISTED ${ATTEMPT_PATH} before any broadcast call`)

  // -- 5. broadcast the persisted bytes -------------------------------------
  const persisted = JSON.parse(readFileSync(ATTEMPT_PATH, 'utf8')) as { rawTxHex: string; txHash: string }
  await chain.broadcast(persisted.rawTxHex)
  log('payout broadcast')

  const payout = await waitForInclusion(chain, persisted.txHash, 300_000, 'payout')
  if (!payout) fail('payout tx never appeared on chain')
  if (payout.hash !== built.txHash) fail('on-chain payout hash differs from the pre-broadcast hash')
  const payoutFinalitySecs = await waitForFinality(chain, payout, 'payout')

  // -- 6. evidence ----------------------------------------------------------
  const base = EXPLORER[NETWORK]
  console.log('\n=== S1 EVIDENCE ===')
  console.log('network            :', NETWORK)
  console.log('custody address    :', chain.custodyAddress())
  console.log('consensus (s)      :', (consensusMs / 1000).toFixed(1))
  console.log('fee used (luna)    :', built.feeLuna.toString(), built.feeLuna === 0n ? '(ZERO-FEE ACCEPTED)' : '')
  console.log('funding tx         :', funding.hash)
  console.log('  explorer         :', `${base}/tx/${funding.hash}`)
  console.log('  sender           :', funding.sender)
  console.log('  value            :', fmtNim(funding.valueLuna))
  console.log('  memo             :', JSON.stringify(funding.dataUtf8), `(${utf8Bytes(funding.dataUtf8 ?? '')}B)`)
  console.log('  included height  :', funding.includedHeight, `batch ${Policy.batchAt(funding.includedHeight)}`)
  console.log('  finality (s)     :', fundingFinalitySecs.toFixed(1))
  console.log('payout tx          :', payout.hash)
  console.log('  explorer         :', `${base}/tx/${payout.hash}`)
  console.log('  recipient        :', payout.recipient)
  console.log('  value            :', fmtNim(payout.valueLuna))
  console.log('  memo             :', JSON.stringify(payout.dataUtf8), `(${utf8Bytes(payout.dataUtf8 ?? '')}B)`)
  console.log('  included height  :', payout.includedHeight, `batch ${Policy.batchAt(payout.includedHeight)}`)
  console.log('  finality (s)     :', payoutFinalitySecs.toFixed(1))
  console.log('custody balance    :', fmtNim(await chain.confirmedBalanceLuna(chain.custodyAddress())))
  console.log('=== S1 PASSED ===')

  await chain.close()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  fail(String(err))
})
