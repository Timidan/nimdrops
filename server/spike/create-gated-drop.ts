/**
 * OPERATOR UTILITY — create ONE gated drop, as a draft, ready to be funded.
 *
 *   pnpm tsx spike/create-gated-drop.ts --kind trivia --claims 20 --nim-each 1 \
 *     --tier novice --listed
 *
 * This is the ONLY creation path for a gated drop. No sponsor-facing form ships
 * in Cycle I (spec §1.1) — the operator funds every gated drop — so every check
 * a create screen would have made has to live here instead, and the guard rails
 * below are the whole point of the file rather than decoration.
 *
 * What it does, in order: validate the arguments, validate the resulting
 * `drop_gates.config` THROUGH THE KIND'S OWN PARSER, show the cap headroom the
 * drop will consume, create the draft, then write the gate row. It prints the
 * funding memo and the `/game/:publicId` URL an operator needs next.
 *
 * ── what it deliberately does NOT do ────────────────────────────────────────
 * It does not fund, sign, broadcast, or activate anything, and it holds NO
 * custody key: the chain client is `readOnlyNimiqChainFromEnv`, which takes
 * `CUSTODY_ADDRESS` and cannot sign. It never connects to a node either — the
 * only chain fact a draft needs is the custody address, which is local. Funding
 * is a separate, deliberate step in a separate script:
 *
 *     PUBLIC_ID=<publicId> pnpm tsx spike/fund-one-drop.ts
 *
 * Keeping the two apart is what makes "created 20 × 1 NIM by mistake" cost
 * nothing: an unfunded draft releases its cap headroom when its reservation
 * expires (`FUNDING_RESERVATION_MINUTES`) and no money has moved.
 *
 * ── guard rails ─────────────────────────────────────────────────────────────
 *  1. **Trivia serves five questions or none.** The eligibility argument in
 *     spec §3 is that pure guessing succeeds at `0.25^5 = 0.098%`; at three
 *     questions it is `0.25^3 = 1.6%`, close enough to a coin flip that the
 *     argument stops holding. `parseTriviaConfig` already refuses anything else
 *     at play time; refusing it HERE means the operator hears the arithmetic
 *     before a stranger meets a broken game.
 *  2. **Mainnet plus paused is refused up front,** naming the staged cap
 *     schedule in spec §9.4. `lockControlsForCapacity` inside `createDraft`
 *     also refuses while paused, so this preflight adds no safety — it adds the
 *     reason. `MAINNET_PILOT_DEFAULTS` ships `paused = true` on purpose, and an
 *     operator who reaches for `unpause` has to know that Stage 1 is an ungated
 *     2 NIM drop and a gated one belongs at Stage 2.
 *  3. **Headroom is printed before funding,** both as it stands and as it will
 *     stand after this draft's reservation, against `max_live_principal_luna`.
 *     A cap refusal at funding time is the expensive kind: the sponsor's money
 *     is already on chain.
 *  4. **A passphrase never reaches stdout, a log line, or an error message.**
 *     Only its keyed hash is printed. The phrase is also accepted through
 *     `GATE_PHRASE` in preference to `--phrase`, because argv is visible in `ps`
 *     to every user on the box and lands in shell history.
 *  5. **An attester key is 64 hex characters or the run stops** before anything
 *     is written. A key that only looks like a key would make every attestation
 *     on the drop fail verification, which reads to a partner as our bug.
 *
 * ── environment ─────────────────────────────────────────────────────────────
 *   DATABASE_URL              (required)
 *   NIMIQ_NETWORK             (required) TestAlbatross | MainAlbatross
 *   CUSTODY_ADDRESS           (required) the address sponsors are told to pay
 *   PUBLIC_ORIGIN             (default https://nimdrops.timidan.xyz)
 *   TRIVIA_SELECTION_SALT     required for `trivia` and `passphrase`
 *   TRIVIA_BANK_PATH          required for `trivia`
 *   GATE_PHRASE               `passphrase` only, preferred over `--phrase`
 *
 * Run it through a process that has the database, e.g. the API service. It needs
 * no custody key.
 */

import type pg from 'pg'
import { readOnlyNimiqChainFromEnv } from '../src/chain/nimiq'
import {
  requireNetwork,
  requirePassphraseSalt,
  requireTriviaSalt,
  triviaConfigured,
} from '../src/config'
import { closePool, getPool } from '../src/db/pool'
import { exitAfterTeardown } from '../src/exit'
import { parseAttestedConfig } from '../src/gates/attested'
import { hashPhrase, parsePassphraseConfig } from '../src/gates/passphrase'
import { type Tier, loadBank, questionsForTier } from '../src/gates/trivia/bank'
import { parseTriviaConfig } from '../src/gates/trivia/sessions'
import {
  CapError,
  MAX_CLAIMS,
  MAX_TOTAL_LUNA,
  MIN_CLAIMS,
  assertCaps,
  formatNim,
  lunaFromNim,
} from '../src/money'
import { createDraft, fundingMemoFor } from '../src/services/drops'
import {
  type CapacitySnapshot,
  ensureChainBinding,
  readCapacity,
  readControls,
} from '../src/services/solvency'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number.
import '../src/db/pool'

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const DEFAULT_ORIGIN = 'https://nimdrops.timidan.xyz'
const KINDS = ['trivia', 'passphrase', 'attested'] as const
type Kind = (typeof KINDS)[number]
const TIERS: readonly Tier[] = ['novice', 'easy', 'medium', 'hard']

/**
 * The only `questionCount` a trivia drop may carry. See guard rail 1 — this is
 * the same constant `gates/trivia/sessions.ts` refuses on, restated here rather
 * than imported because that one is private to the kind and because the number
 * appearing twice, in two files, with the same argument written out, is the
 * point.
 */
const REQUIRED_QUESTION_COUNT = 5

/** Per-question thinking time. `--seconds` overrides it; the config needs one. */
const DEFAULT_SECONDS_PER_QUESTION = 20

/** `MAX_SPONSOR_LABEL_CHARS` in `http/app.ts`, which validates the same field. */
const MAX_LABEL_CHARS = 40
const MAX_MESSAGE_CHARS = 200

/** `/^[0-9a-f]{64}$/i` is also what `parseAttestedConfig` enforces. */
const HEX64_RE = /^[0-9a-f]{64}$/i

const USAGE = `
create ONE gated drop as an unfunded draft.

  pnpm tsx spike/create-gated-drop.ts --kind <kind> --claims <n> --nim-each <NIM> [flags]

every kind:
  --kind trivia|passphrase|attested
  --claims <2..20>            slots, one payout each
  --nim-each <decimal NIM>    exact amount per claim, e.g. 1 or 0.5
  --listed[=true|false]       show it in GET /api/games (default false)
  --label <text>              sponsor label on the claim screen (default "NimDrops")
  --message <text>            optional note on the claim screen

--kind trivia:
  --tier novice|easy|medium|hard
  --unlock-requires <tier>    optional; a pass at that tier or above unlocks this game
  --questions <n>             optional; ${REQUIRED_QUESTION_COUNT} is the only accepted value
  --seconds <n>               optional; per question, default ${DEFAULT_SECONDS_PER_QUESTION}

--kind passphrase:
  --phrase <text>             prefer GATE_PHRASE — argv is visible in \`ps\`
  --hint <text>               public hint, e.g. "said at the 3pm talk"

--kind attested:
  --attester-key <64 hex>     the attester's Ed25519 public key
  --max-age <seconds>         how old an attestation may be

  --help                      print this and exit 0
`.trimStart()

/** Flags that take a following value. Everything else is a bare switch. */
const VALUE_FLAGS = new Set([
  '--kind',
  '--claims',
  '--nim-each',
  '--label',
  '--message',
  '--tier',
  '--unlock-requires',
  '--questions',
  '--seconds',
  '--phrase',
  '--hint',
  '--attester-key',
  '--max-age',
])
const SWITCH_FLAGS = new Set(['--listed', '--help'])

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Stop, and say why in one sentence an operator can act on.
 *
 * NEVER pass a passphrase into this. Guard rail 4 is about every path out of
 * the process, and an error message is a path out.
 */
function fail(message: string): never {
  console.error(`\nREFUSED: ${message}\n`)
  throw new CreateGatedDropError(message)
}

class CreateGatedDropError extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message)
}

function nim(luna: bigint): string {
  return `${formatNim(luna)} NIM`
}

function field(label: string, value: unknown): void {
  console.log(`${label.padEnd(14)}:`, value)
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * Strict flag parsing: an unrecognised flag stops the run.
 *
 * Not pedantry. This script writes a drop's economics from its arguments, and a
 * typo'd `--nim_each 5` that parsed as "no value given" would silently create a
 * drop at some default amount. There is no create screen to notice, so the
 * parser has to.
 */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const eq = token.indexOf('=')
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token
    if (!token.startsWith('--')) {
      // The token itself is NOT echoed. `--phrase red panda`, unquoted, arrives
      // here holding the second word of a passphrase, and guard rail 4 covers
      // every path out of this process including this one. Its position is
      // enough to find it.
      fail(
        `argument ${i + 1} is not a --flag, and every input to this script is one. If it is a ` +
          `value with a space in it, quote it.\n${USAGE}`,
      )
    }
    if (!VALUE_FLAGS.has(name) && !SWITCH_FLAGS.has(name)) {
      fail(`unknown flag ${name}\n${USAGE}`)
    }
    if (flags.has(name)) fail(`${name} was given twice`)
    if (eq > 0) {
      flags.set(name, token.slice(eq + 1))
      continue
    }
    if (SWITCH_FLAGS.has(name)) {
      flags.set(name, 'true')
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
    flags.set(name, value)
    i += 1
  }
  return flags
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim()
  if (value === undefined || value === '') fail(`${name} is required for this kind`)
  return value
}

function integer(flags: Map<string, string>, name: string, fallback?: number): number {
  const raw = flags.get(name)
  if (raw === undefined) {
    if (fallback === undefined) fail(`${name} is required for this kind`)
    return fallback
  }
  const value = Number(raw)
  assert(Number.isInteger(value), `${name} must be a whole number, got ${JSON.stringify(raw)}`)
  return value
}

function boolFlag(flags: Map<string, string>, name: string): boolean {
  const raw = flags.get(name)
  if (raw === undefined) return false
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  fail(`${name} must be true or false, got ${JSON.stringify(raw)}`)
}

function tierFlag(flags: Map<string, string>, name: string): Tier {
  const raw = required(flags, name)
  assert(TIERS.includes(raw as Tier), `${name} must be one of ${TIERS.join(', ')}, got ${raw}`)
  return raw as Tier
}

// ---------------------------------------------------------------------------
// per-kind config, validated by the kind that will read it back
// ---------------------------------------------------------------------------

/**
 * Build `drop_gates.config` for one kind.
 *
 * Every branch ends by round-tripping the object through the kind's OWN parser,
 * the one the play path calls. A config this script invented and only this
 * script understood would be caught at a stranger's first attempt, reported as
 * `misconfigured`, and answered as a 5xx — a broken game rather than a refused
 * argument.
 *
 * Returns the config plus the lines to print about it, so nothing is echoed by
 * a branch that also holds a secret.
 */
async function buildConfig(
  kind: Kind,
  flags: Map<string, string>,
): Promise<{ config: Record<string, unknown>; lines: [string, unknown][] }> {
  if (kind === 'trivia') {
    const tier = tierFlag(flags, '--tier')
    const questionCount = integer(flags, '--questions', REQUIRED_QUESTION_COUNT)
    // Guard rail 1, with the arithmetic spelled out: this refusal has to teach,
    // because the only reason to pass `--questions 3` is not knowing why not.
    assert(
      questionCount === REQUIRED_QUESTION_COUNT,
      `--questions ${questionCount} is refused. Trivia serves ${REQUIRED_QUESTION_COUNT} ` +
        'questions or none: pure guessing beats five four-option questions at ' +
        '0.25^5 = 0.098%, three orders of magnitude below skill, while three questions ' +
        'is 0.25^3 = 1.6% — close enough to a coin flip that the eligibility argument ' +
        'in spec §3 stops holding, and it is the argument that makes this a game of ' +
        'skill rather than a lottery.',
    )
    const secondsPerQuestion = integer(flags, '--seconds', DEFAULT_SECONDS_PER_QUESTION)
    const unlockRaw = flags.get('--unlock-requires')
    const unlockRequiresTier = unlockRaw === undefined ? null : tierFlag(flags, '--unlock-requires')

    // A trivia drop with no bank is unplayable, and a drop pinned to a bank
    // version this deployment does not hold answers `misconfigured` on every
    // session (`parseTriviaConfig`). So the bank is read here and its version is
    // what goes into the config — never an operator-typed string.
    assert(
      triviaConfigured(),
      'TRIVIA_SELECTION_SALT and TRIVIA_BANK_PATH must both be set before a trivia drop is ' +
        'created. Without them `http/app.ts` serves no game routes, so the drop would be ' +
        'listed, funded, and unplayable.',
    )
    const bank = await loadBank(process.env.TRIVIA_BANK_PATH as string)
    const pool = questionsForTier(bank, tier)
    const categories = new Set(pool.map((q) => q.category))
    // The same two conditions `selectQuestionIds` raises `SelectionError` on. It
    // would raise them at a player's first tap; a drop whose tier cannot fill a
    // set must not be created at all.
    assert(pool.length > 0, `the bank at version ${bank.version} has no questions in tier ${tier}`)
    assert(
      categories.size >= questionCount,
      `tier ${tier} spans ${categories.size} categories and a set needs ${questionCount} ` +
        'distinct ones — a five-question set drawn from one category lets a specialist coast',
    )

    const config = {
      tier,
      bankVersion: bank.version,
      questionCount,
      secondsPerQuestion,
      unlockRequiresTier,
    }
    parseTriviaConfig(config, bank.version)
    return {
      config,
      lines: [
        ['tier', tier],
        ['unlock needs', unlockRequiresTier ?? '(nothing — always open)'],
        ['questions', `${questionCount} × ${secondsPerQuestion}s`],
        ['bank', `${bank.version} — ${pool.length} in tier, ${categories.size} categories`],
      ],
    }
  }

  if (kind === 'passphrase') {
    // Preferred over --phrase: argv is world-readable in `ps` and lands in shell
    // history. Read once into a const that is never logged, never interpolated
    // into a message, and never returned from this function.
    const phrase = (process.env.GATE_PHRASE ?? flags.get('--phrase') ?? '').trim()
    assert(
      phrase !== '',
      'the phrase is missing. Set GATE_PHRASE=<phrase> (preferred — argv is visible in `ps` ' +
        'and in shell history) or pass --phrase.',
    )
    const hint = required(flags, '--hint')
    assert(hint.length <= MAX_MESSAGE_CHARS, `--hint must be at most ${MAX_MESSAGE_CHARS} chars`)
    // PASSPHRASE_SALT, not the trivia selection salt. `index.ts` hands
    // `submitPassphrase` the same key, and hashing here with the other one would
    // write a drop whose correct phrase is refused forever.
    //
    // They were one value until this was found: the selection salt is documented
    // as rotatable, and sharing it meant a rotation silently invalidated every
    // hash already stored on a live drop.
    const config = { hash: hashPhrase(phrase, requirePassphraseSalt()), hint }
    parsePassphraseConfig(config)
    return {
      config,
      // The hash, never the phrase. The hash is not a secret — it is what the
      // database row holds — and printing it is how an operator confirms two
      // runs mean the same word without the word appearing anywhere.
      lines: [
        ['phrase hash', config.hash],
        ['hint', JSON.stringify(hint)],
      ],
    }
  }

  const attesterPublicKey = required(flags, '--attester-key').toLowerCase()
  // Guard rail 5, ahead of every write. A key that is nearly a key fails at the
  // partner's first attestation, which looks like our bug and not their typo.
  assert(
    HEX64_RE.test(attesterPublicKey),
    `--attester-key must be 64 hex characters (32 bytes), got ${attesterPublicKey.length} ` +
      'characters. This is the attester\'s Ed25519 public key, not an address and not a seed.',
  )
  const maxAgeSeconds = integer(flags, '--max-age')
  assert(maxAgeSeconds > 0, `--max-age must be a positive number of seconds, got ${maxAgeSeconds}`)
  const config = { attesterPublicKey, maxAgeSeconds }
  parseAttestedConfig(config)
  return {
    config,
    lines: [
      ['attester key', attesterPublicKey],
      ['max age', `${maxAgeSeconds}s`],
    ],
  }
}

// ---------------------------------------------------------------------------
// cap headroom
// ---------------------------------------------------------------------------

/** Guard rail 3: the cap picture, in the same units the cap is written in. */
function printCapacity(title: string, capacity: CapacitySnapshot, addLuna: bigint | null): void {
  const committed = capacity.outstandingLuna + capacity.reservedLuna
  console.log(`\n--- ${title} ---`)
  field('cap', `${nim(capacity.maxLivePrincipalLuna)} (max_live_principal_luna)`)
  field('outstanding', nim(capacity.outstandingLuna))
  field('reserved', `${nim(capacity.reservedLuna)} in ${capacity.reservedDrafts} draft(s)`)
  field('live principal', `${nim(committed)} of ${nim(capacity.maxLivePrincipalLuna)}`)
  field('headroom', nim(capacity.remainingLuna))
  field(
    'live drops',
    capacity.maxLiveDrops === null
      ? `${capacity.liveDrops} (no max_live_drops limit)`
      : `${capacity.liveDrops} + ${capacity.reservedDrafts} draft(s) of ${capacity.maxLiveDrops}`,
  )
  if (addLuna !== null) {
    field('this drop', nim(addLuna))
    assert(
      capacity.remainingLuna >= addLuna,
      `this drop needs ${nim(addLuna)} of live principal and only ${nim(capacity.remainingLuna)} ` +
        'is left under max_live_principal_luna. Either make it smaller, wait for a live drop to ' +
        'settle, or advance the stage in spec §9.4 deliberately — do not raise the cap to fit ' +
        'one drop.',
    )
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function teardown(): Promise<void> {
  await closePool()
}

async function run(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.has('--help')) {
    console.log(USAGE)
    return
  }

  console.log('=== NimDrops — create one gated drop ===\n')

  // -- 0. arguments, before anything is read or written ----------------------
  const kindRaw = required(flags, '--kind')
  assert(KINDS.includes(kindRaw as Kind), `--kind must be one of ${KINDS.join(', ')}`)
  const kind = kindRaw as Kind

  const claimCount = integer(flags, '--claims')
  // `createDraft` runs `assertCaps` too. Running it first means a refusal
  // arrives before any output rather than half way through a report — and as a
  // REFUSAL: a `CapError` is an argument an operator can fix, so it must not
  // reach the top-level handler and print a stack trace at them.
  const amountEachLuna = (() => {
    try {
      const luna = lunaFromNim(required(flags, '--nim-each'))
      assertCaps(luna, claimCount)
      return luna
    } catch (err) {
      if (err instanceof CapError) {
        fail(
          `${err.message} — ${claimCount} × ${flags.get('--nim-each')} NIM. The launch caps are ` +
            `${MIN_CLAIMS}–${MAX_CLAIMS} claims and ${nim(MAX_TOTAL_LUNA)} total (money.ts); the ` +
            'ladder in spec §9.1 fits inside them at every tier.',
        )
      }
      throw err
    }
  })()
  const expectedFundingLuna = amountEachLuna * BigInt(claimCount)

  const listed = boolFlag(flags, '--listed')
  const sponsorLabel = flags.get('--label')?.trim() || 'NimDrops'
  assert(
    sponsorLabel.length <= MAX_LABEL_CHARS,
    `--label must be at most ${MAX_LABEL_CHARS} characters`,
  )
  const message = flags.get('--message')?.trim()
  assert(
    message === undefined || message.length <= MAX_MESSAGE_CHARS,
    `--message must be at most ${MAX_MESSAGE_CHARS} characters`,
  )

  const network = requireNetwork()
  const origin = (process.env.PUBLIC_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  // No key: this script cannot sign, and a creation path has nothing to sign.
  const chain = readOnlyNimiqChainFromEnv()
  const custody = chain.custodyAddress()

  const { config, lines } = await buildConfig(kind, flags)

  field('kind', kind)
  field('network', network)
  field('custody', custody)
  field('origin', origin)
  field('listed', listed)
  field('label', JSON.stringify(sponsorLabel))
  if (message !== undefined) field('message', JSON.stringify(message))
  field('claims', claimCount)
  field('each', `${nim(amountEachLuna)} (${amountEachLuna} luna)`)
  field('total', `${nim(expectedFundingLuna)} (${expectedFundingLuna} luna)`)
  for (const [label, value] of lines) field(label, value)

  const pool: pg.Pool = getPool()

  // -- 1. the database this drop will live in, and the chain it is bound to ---
  // Same check `fund-one-drop.ts` makes, for the same reason: if the database is
  // bound to another custody wallet, the funding instructions printed below name
  // an address the deployment never publishes and nothing can spend from.
  const binding = await ensureChainBinding(pool, chain)
  assert(
    binding.custodyAddress === custody,
    `custody binding mismatch: the database is bound to ${binding.custodyAddress}, this run ` +
      `would publish ${custody}`,
  )
  assert(
    binding.network === network,
    `network binding mismatch: the database is bound to ${binding.network}, this run is on ` +
      `${network}`,
  )

  // -- 2. guard rail 2: mainnet plus paused ----------------------------------
  const controls = await readControls(pool)
  if (network === 'MainAlbatross' && controls.paused) {
    fail(
      'NIMIQ_NETWORK is MainAlbatross and custody_controls.paused is true, so nothing created ' +
        'here could be activated and a sponsor would be sent to their wallet for money that ' +
        'would sit in custody waiting for an operator.\n\n' +
        '  MAINNET_PILOT_DEFAULTS ships paused = true, 2 NIM of live principal and 1 live drop ' +
        'on purpose (services/solvency.ts). That is Stage 1 of the staged cap schedule in spec ' +
        '§9.4, and Stage 1 is an UNGATED 2 × 0.5 NIM drop whose job is to measure the real fee ' +
        'and the finality wall-clock on a real device. A gated drop is Stage 2, at 25 NIM.\n\n' +
        '  Advance a stage deliberately — clean `recover.ts status`, zero manual_review rows, ' +
        'no shortfall_detected_at, reconciliation current — then `pnpm tsx src/recover.ts ' +
        'unpause`. Do not unpause to get this script to run.',
    )
  }
  if (controls.paused) {
    console.log(
      '\n!! custody is PAUSED. The draft below can be created but never activated, so its ' +
        'funding\n!! would sit in custody: `pnpm tsx src/recover.ts unpause` before funding it.',
    )
  }

  // -- 3. guard rail 3: headroom, BEFORE the draft ---------------------------
  // Read without the singleton lock, so it is an observation rather than a
  // decision — `createDraft` makes the decision under `lockControlsForCapacity`
  // moments later. Printing it first is what makes a refusal legible instead of
  // a bare `NoHeadroomError`.
  printCapacity('cap headroom now', await readCapacity(pool, controls), expectedFundingLuna)

  // -- 4. the draft ----------------------------------------------------------
  const draft = await createDraft(pool, chain, {
    sponsorLabel,
    ...(message === undefined ? {} : { message }),
    amountEachLuna,
    claimCount,
  })
  const memo = fundingMemoFor(draft.publicId)
  assert(
    memo === draft.fundingMemo && memo === `ND1:${draft.publicId}`,
    `the memo builder produced ${JSON.stringify(draft.fundingMemo)}, not ND1:${draft.publicId}`,
  )

  // -- 5. the gate -----------------------------------------------------------
  // Second statement, not part of `createDraft`'s transaction, because
  // `drop_gates.drop_id` references `drops(id)` and the drop has to exist first.
  // Everything that could refuse has already refused above, so the only way this
  // fails is the database going away — and then the draft is an ORDINARY
  // ungated drop that must not be funded. It is left alone rather than patched
  // up: nothing in this file writes to `drops`, and an unfunded draft releases
  // its cap headroom by itself when the reservation expires.
  try {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM drops WHERE public_id = $1',
      [draft.publicId],
    )
    assert(rows[0] !== undefined, `the draft ${draft.publicId} is not readable after creation`)
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, listed, config)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [rows[0].id, kind, listed, JSON.stringify(config)],
    )
  } catch (err) {
    fail(
      `the draft ${draft.publicId} was created but its ${kind} gate was not written ` +
        `(${err instanceof Error ? err.message : String(err)}).\n\n` +
        '  DO NOT FUND IT. Without a `drop_gates` row it is an ordinary ungated drop that ' +
        'anyone with the link can claim. Leave it: an unfunded draft gives its cap headroom ' +
        `back when its reservation expires at ${draft.reservationExpiresAt.toISOString()}. ` +
        'Then run this script again.',
    )
  }

  // -- 6. what an operator does next ----------------------------------------
  console.log('\n=== DRAFT (unfunded) ===')
  field('public id', draft.publicId)
  field('kind', `${kind}${listed ? ' (listed)' : ' (unlisted)'}`)
  field('funding to', draft.fundingAddress)
  field('funding memo', memo)
  field('funding total', `${nim(draft.expectedFundingLuna)} (${draft.expectedFundingLuna} luna)`)
  field('reservation', `holds cap headroom until ${draft.reservationExpiresAt.toISOString()}`)

  printCapacity('live principal after this reservation', draft.capacity, null)

  console.log('\ngame url     :', `${origin}/game/${draft.publicId}`)
  console.log('share url    :', `${origin}/d/${draft.publicId}`)
  console.log('\nfund it, from the WORKER service — it holds the only custody key:')
  console.log(
    `  docker compose run --rm -e PUBLIC_ID=${draft.publicId} --entrypoint sh worker \\\n` +
      '    -c "cd /app/server && pnpm tsx spike/fund-one-drop.ts"',
  )
  console.log('')
}

// The outcome is fixed HERE, before teardown starts (exit.ts). No chain client
// is ever connected in this script, so there is nothing to disconnect — but the
// ending stays the same shape as every other entrypoint's.
run().then(
  () => exitAfterTeardown(0, teardown, (message) => console.error(message)),
  (err: unknown) => {
    // `fail()` has already printed its own message; anything else has not.
    if (!(err instanceof CreateGatedDropError)) {
      console.error(
        '\nFAILED:',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
        '\n',
      )
    }
    exitAfterTeardown(1, teardown, (message) => console.error(message))
  },
)
