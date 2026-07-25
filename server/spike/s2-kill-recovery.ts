/**
 * G0 SPIKE S2 — kill/restart safety of the sign→persist→broadcast path.
 *
 *   pnpm tsx spike/s2-kill-recovery.ts all     # runs every phase as its own process
 *   pnpm tsx spike/s2-kill-recovery.ts a|b|c|d # one phase
 *
 * Proves design §2 item 6 / §8.3. Each phase is a SEPARATE OS PROCESS, so the
 * "crash" is a real process death, not a try/catch.
 *
 *   A  sign an attempt, persist bytes+hash, then `process.exit(1)`
 *      BEFORE the broadcast call is ever made.
 *   B  restart: read the persisted bytes, query the hash (must be ABSENT),
 *      rebroadcast THE SAME BYTES, confirm to finality.
 *   C  sign a second, distinct attempt, persist, broadcast, then exit
 *      IMMEDIATELY after broadcast returns — the ambiguous crash window.
 *   D  restart: query the hash. It MUST be found, and this phase MUST NOT
 *      broadcast anything.
 *
 * Final audit (`all`): the custody balance must have moved by exactly
 * value(A) + value(C) + fees. That is the facade-only proof that no phase
 * created a duplicate payment — a rebroadcast of identical bytes is idempotent
 * by hash, and a *second* transaction would show up as extra balance movement.
 *
 * A NOTE THAT MATTERS FOR TASK 11: phase D must NOT use
 * `ChainClient.getTransaction`. That returns `null` for a mempool-pending
 * transaction as well as for an unknown hash, and "pending" is precisely the
 * state a post-broadcast crash leaves behind. D uses the raw
 * `getTransactionDetails` so it can tell "the network has never heard of this
 * hash" apart from "it is sitting in the mempool". Rebroadcasting the same
 * bytes would still be harmless; constructing NEW bytes would not be.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { KeyPair, Policy, PrivateKey } from '@nimiq/core'
import { NimiqChain, type NimiqNetwork } from '../src/chain/nimiq'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_KEY_PATH = join(HERE, '.dev-key')
const FUNDING_PATH = join(HERE, 's1-funding.json')
const ATTEMPT_A = join(HERE, 's2-attempt-a.json')
const ATTEMPT_C = join(HERE, 's2-attempt-c.json')
const BASELINE = join(HERE, 's2-baseline.json')

const LUNA_PER_NIM = 100_000n
const VALUE_A = 10_000n // 0.1 NIM
const VALUE_C = 20_000n // 0.2 NIM — distinct value ⇒ distinct hash
const MEMO_A = 'ND1:s2a'
const MEMO_C = 'ND1:s2c'

const NETWORK = (process.env.NIMIQ_NETWORK ?? 'TestAlbatross') as NimiqNetwork

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
function log(...a: unknown[]): void {
  console.log(`[${el()}]`, ...a)
}
function fail(msg: string): never {
  console.error(`\n✗ S2 FAILED: ${msg}\n`)
  process.exit(1)
}
function fmtNim(luna: bigint): string {
  const neg = luna < 0n
  const v = neg ? -luna : luna
  const w = v / LUNA_PER_NIM
  const f = (v % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${f ? `${w}.${f}` : `${w}`} NIM`
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Attempt {
  phase: string
  rawTxHex: string
  txHash: string
  valueLuna: string
  feeLuna: string
  recipient: string
  validityStartHeight: number
  signedAt: string
}

function openChain(): NimiqChain {
  let key = process.env.CUSTODY_PRIVATE_KEY_HEX
  if (!key) {
    if (!existsSync(DEV_KEY_PATH)) fail(`no CUSTODY_PRIVATE_KEY_HEX and no ${DEV_KEY_PATH}; run s1 first`)
    key = (JSON.parse(readFileSync(DEV_KEY_PATH, 'utf8')) as { custodyPrivateKeyHex: string }).custodyPrivateKeyHex
  }
  return new NimiqChain({ network: NETWORK, custodyPrivateKeyHex: key, logLevel: 'warn' })
}

function recipient(): string {
  if (process.env.S2_RECIPIENT) return process.env.S2_RECIPIENT
  if (existsSync(FUNDING_PATH)) {
    return (JSON.parse(readFileSync(FUNDING_PATH, 'utf8')) as { sender: string }).sender
  }
  if (existsSync(DEV_KEY_PATH)) {
    const k = JSON.parse(readFileSync(DEV_KEY_PATH, 'utf8')) as { sponsorPrivateKeyHex: string }
    return KeyPair.derive(PrivateKey.fromHex(k.sponsorPrivateKeyHex)).toAddress().toUserFriendlyAddress()
  }
  fail('no recipient: set S2_RECIPIENT, or run s1 first')
}

async function signAndPersist(
  chain: NimiqChain,
  path: string,
  phase: string,
  valueLuna: bigint,
  memo: string,
): Promise<Attempt> {
  const to = recipient()
  const vsh = await chain.headHeight()
  const built = await chain.buildSignedBasic({ to, valueLuna, dataUtf8: memo, validityStartHeight: vsh })
  const attempt: Attempt = {
    phase,
    rawTxHex: built.rawTxHex,
    txHash: built.txHash,
    valueLuna: valueLuna.toString(),
    feeLuna: built.feeLuna.toString(),
    recipient: to,
    validityStartHeight: vsh,
    signedAt: new Date().toISOString(),
  }
  writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`)
  log(`phase ${phase}: signed ${built.txHash} (${fmtNim(valueLuna)} to ${to}) and PERSISTED to ${path}`)
  return attempt
}

async function waitFinal(chain: NimiqChain, hash: string, label: string): Promise<void> {
  const deadline = Date.now() + 420_000
  let tx = await chain.getTransaction(hash)
  while (!tx && Date.now() < deadline) {
    const raw = await chain.getTransactionDetails(hash)
    log(`${label}: awaiting inclusion — state=${raw?.state ?? 'unknown-hash'}`)
    await sleep(3000)
    tx = await chain.getTransaction(hash)
  }
  if (!tx) fail(`${label}: never included`)
  log(
    `${label}: included at ${tx.includedHeight} (batch ${Policy.batchAt(tx.includedHeight)}), ` +
      `waiting ${chain.finalityDepthBlocks()} blocks for finality`,
  )
  const started = Date.now()
  let head = await chain.headHeight()
  while (!chain.isFinal(tx, head) && Date.now() < deadline) {
    await sleep(2000)
    head = await chain.headHeight()
  }
  if (!chain.isFinal(tx, head)) fail(`${label}: never reached finality`)
  log(`${label}: FINAL at head ${head} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

async function phaseA(): Promise<never> {
  const chain = openChain()
  await chain.connect()
  await signAndPersist(chain, ATTEMPT_A, 'A', VALUE_A, MEMO_A)
  log('phase A: killing the process BEFORE broadcast')
  // No broadcast. No graceful close. This is the crash.
  process.exit(1)
}

async function phaseB(): Promise<void> {
  if (!existsSync(ATTEMPT_A)) fail('phase B: no persisted attempt from phase A')
  const attempt = JSON.parse(readFileSync(ATTEMPT_A, 'utf8')) as Attempt
  const chain = openChain()
  await chain.connect()

  const raw = await chain.getTransactionDetails(attempt.txHash)
  log(`phase B: chain lookup of ${attempt.txHash} -> ${raw ? `state=${raw.state}` : 'unknown-hash (ABSENT)'}`)
  if (raw) fail('phase B: the tx is already on chain — phase A must not have broadcast it')

  log('phase B: rebroadcasting THE SAME PERSISTED BYTES')
  await chain.broadcast(attempt.rawTxHex)

  await waitFinal(chain, attempt.txHash, 'phase B')
  const onChain = await chain.getTransaction(attempt.txHash)
  if (!onChain) fail('phase B: tx vanished')
  if (onChain.hash !== attempt.txHash) fail('phase B: hash changed across the crash')
  if (onChain.valueLuna !== BigInt(attempt.valueLuna)) fail('phase B: value changed across the crash')
  log('phase B: recovered attempt confirmed, same hash and value ✓')
  await chain.close()
}

async function phaseC(): Promise<never> {
  const chain = openChain()
  await chain.connect()
  const attempt = await signAndPersist(chain, ATTEMPT_C, 'C', VALUE_C, MEMO_C)
  await chain.broadcast(attempt.rawTxHex)
  log('phase C: broadcast returned — killing the process IMMEDIATELY (ambiguous window)')
  process.exit(1)
}

async function phaseD(): Promise<void> {
  if (!existsSync(ATTEMPT_C)) fail('phase D: no persisted attempt from phase C')
  const attempt = JSON.parse(readFileSync(ATTEMPT_C, 'utf8')) as Attempt
  const chain = openChain()
  await chain.connect()

  // Raw details, NOT getTransaction: 'pending' must not read as 'absent'.
  let raw = await chain.getTransactionDetails(attempt.txHash)
  const deadline = Date.now() + 60_000
  while (!raw && Date.now() < deadline) {
    log('phase D: hash not visible yet, retrying before concluding anything')
    await sleep(3000)
    raw = await chain.getTransactionDetails(attempt.txHash)
  }
  if (!raw) fail('phase D: the broadcast tx is not known to the network at all')
  log(`phase D: FOUND ${attempt.txHash} in state '${raw.state}' — NOT rebroadcasting, NOT re-signing`)

  await waitFinal(chain, attempt.txHash, 'phase D')
  log('phase D: confirmed without a second broadcast ✓')
  await chain.close()
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

function runPhase(phase: string): number {
  console.log(`\n${'='.repeat(70)}\n  PHASE ${phase.toUpperCase()}  (fresh process)\n${'='.repeat(70)}`)
  const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], phase], { stdio: 'inherit' })
  console.log(`--- phase ${phase} exited with code ${r.status} ---`)
  return r.status ?? -1
}

async function runAll(): Promise<void> {
  const chain = openChain()
  await chain.connect()
  const custody = chain.custodyAddress()
  const startBalance = await chain.confirmedBalanceLuna(custody)
  const startHead = await chain.headHeight()
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ custody, startBalance: startBalance.toString(), startHead }, null, 2)}\n`,
  )
  console.log(`custody ${custody}`)
  console.log(`baseline balance ${fmtNim(startBalance)} at head ${startHead}`)
  if (startBalance < (VALUE_A + VALUE_C) * 3n) fail('custody balance too low to run S2; run s1 first')
  await chain.close()

  if (runPhase('a') !== 1) fail('phase A should have exited 1 (crash before broadcast)')
  if (runPhase('b') !== 0) fail('phase B failed')
  if (runPhase('c') !== 1) fail('phase C should have exited 1 (crash after broadcast)')
  if (runPhase('d') !== 0) fail('phase D failed')

  // ---- audit --------------------------------------------------------------
  const audit = openChain()
  await audit.connect()
  const a = JSON.parse(readFileSync(ATTEMPT_A, 'utf8')) as Attempt
  const c = JSON.parse(readFileSync(ATTEMPT_C, 'utf8')) as Attempt
  const txA = await audit.getTransaction(a.txHash)
  const txC = await audit.getTransaction(c.txHash)
  if (!txA || !txC) fail('audit: one of the two attempts is not on chain')

  const endBalance = await audit.confirmedBalanceLuna(custody)
  const spent = startBalance - endBalance
  const expected = BigInt(a.valueLuna) + BigInt(c.valueLuna) + BigInt(a.feeLuna) + BigInt(c.feeLuna)

  console.log('\n=== S2 AUDIT ===')
  console.log('phase A/B tx      :', txA.hash, fmtNim(txA.valueLuna), `height ${txA.includedHeight}`)
  console.log('phase C/D tx      :', txC.hash, fmtNim(txC.valueLuna), `height ${txC.includedHeight}`)
  console.log('custody start     :', fmtNim(startBalance))
  console.log('custody end       :', fmtNim(endBalance))
  console.log('moved             :', fmtNim(spent))
  console.log('expected exactly  :', fmtNim(expected))
  if (spent !== expected) {
    fail(`custody moved ${spent} luna but exactly ${expected} was authorised — a duplicate payment exists`)
  }
  console.log('EXACTLY ONE PAYMENT PER INTENT ✓')
  console.log('=== S2 PASSED ===')
  await audit.close()
  process.exit(0)
}

const phase = (process.argv[2] ?? 'all').toLowerCase()
const run =
  phase === 'a'
    ? phaseA
    : phase === 'b'
      ? phaseB
      : phase === 'c'
        ? phaseC
        : phase === 'd'
          ? phaseD
          : phase === 'all'
            ? runAll
            : null

if (!run) {
  console.error('usage: s2-kill-recovery.ts [all|a|b|c|d]')
  process.exit(2)
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    fail(String(err))
  })
