/**
 * OPERATOR UTILITY — import the Open Trivia Database into a local bank file.
 *
 *   pnpm tsx spike/import-opentdb.ts --out /srv/nimdrops/questions.v2.json --max 800
 *
 * A trivia drop is unplayable without a bank, and `questions.example.json` holds
 * five questions — enough to prove the loader, not enough to run a game. This
 * script fills that gap from the one large, openly-licensed source that ships
 * four-option multiple choice with a difficulty label already attached.
 *
 * The bank it writes is OPERATOR CONTENT, exactly as `gates/trivia/bank.ts`
 * says: a public bank is a machine-readable answer key, and a farmer holding it
 * takes every slot of every live drop. So this script refuses to write anywhere
 * under the repository — `.gitignore` covers `questions.v*.json`, but relying on
 * an ignore rule to keep an answer key out of a public history is relying on the
 * one line nobody re-reads. The refusal is the guard rail; the ignore rule is
 * the backstop.
 *
 * ── what it does NOT do ─────────────────────────────────────────────────────
 * It does not touch the database, hold a key, or read `TRIVIA_BANK_PATH`. It
 * cannot make a drop use the file it writes: pointing a deployment at a new bank
 * is a separate, deliberate act, and a drop already pinned to an older
 * `bankVersion` keeps serving that version until an operator changes it.
 *
 * ── their API, and the four facts that shape this file ──────────────────────
 *  1. **One request per five seconds per IP.** Faster gets HTTP 429. Every
 *     request in here — token, questions, retries — goes through `throttled()`,
 *     which paces the WHOLE process rather than sprinkling sleeps at call sites.
 *     A 2000-question import is therefore minutes long by construction.
 *  2. **`encode=base64`, always.** Their default encoding mangles punctuation
 *     and their HTML-escaped mode double-escapes, so `&amp;#039;` reaches you
 *     where an apostrophe was. Base64 is the only mode that round-trips, and
 *     every field of every item — including `difficulty` and `category` — is
 *     encoded, so every field is decoded here.
 *  3. **`response_code` is not an HTTP status.** HTTP 200 carries `1` (no
 *     results), `2` (invalid parameter), `3` (token not found), `4` (token
 *     exhausted) and `5` (rate limited) just as happily as `0`. Code 4 is the
 *     SUCCESS ending of a full drain — every question the token has not already
 *     handed out is gone — and is treated as "this tier is finished", never as a
 *     failure.
 *  4. **A session token is what stops duplicates.** Without one, repeated pulls
 *     re-serve the same questions and the import plateaus at a few hundred. The
 *     token is requested per run and never persisted: it exists to de-duplicate
 *     WITHIN a run. Across runs, the stable `id` does that job instead.
 *
 * ── stability, and why it is worth the extra step ───────────────────────────
 * `id` is `otdb-<sha256(prompt)[:12]>` and the option order is a permutation
 * derived from that id, so re-importing produces a byte-identical file for the
 * same question. That matters twice over: a gate's per-wallet question selection
 * is an HMAC over an index into the sorted bank, and any "seen question" history
 * an operator keeps is keyed by id. A reshuffle on re-import would move the
 * correct answer under a session that had already been served the old order.
 *
 * The four options are sorted lexicographically BEFORE the permutation is
 * applied, because their API does not promise a stable order for
 * `incorrect_answers` — permuting the order they happened to arrive in would
 * make the output depend on their response rather than on the id.
 *
 * ── breadth is a functional property, not an editorial one ──────────────────
 * The brief for this feature says "questions from all walks of life", and Open
 * Trivia DB un-capped does not deliver it: a 60-question sample came back with
 * `entertainment-video-games` at 22% and the top four categories holding 34 of
 * 60. But the reason this script CAPS a category rather than merely reporting it
 * is mechanical. `selectQuestionIds` draws one question from each of five
 * DISTINCT categories, and `trivia_seen` means a wallet never meets the same
 * question twice, so what limits how many sessions a wallet can play is HOW MANY
 * CATEGORIES STILL HOLD AN UNSEEN QUESTION — not the tier's question count. A
 * tier that is deep in three categories and shallow in twelve stops dealing
 * while most of its questions are still unseen.
 *
 * So `--max-per-category` (default: 15% of a tier) holds each category down, and
 * the summary prints the distinct-category count per tier plus the session
 * ceiling that follows from it. Questions past the cap are still FETCHED — the
 * API cannot be asked to skip a category — and then dropped as `category-full`,
 * counted like any other drop so the tally stays honest.
 *
 * ── licence ─────────────────────────────────────────────────────────────────
 * Open Trivia DB is CC BY-SA 4.0. Attribution is a licence condition, so every
 * question carries `source: https://opentdb.com/`. Do not strip it.
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Bank, type Question, type Tier, parseBank } from '../src/gates/trivia/bank'
import { exitAfterTeardown } from '../src/exit'

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const API = 'https://opentdb.com'
const SOURCE = 'https://opentdb.com/'

/**
 * Their documented limit is one request per five seconds per IP. The extra
 * 400ms is not superstition: the limit is enforced on THEIR clock, and a
 * request that leaves at exactly 5.000s can arrive at 4.98s and be answered
 * with `response_code: 5`, which costs a retry — i.e. more than the margin.
 */
const MIN_REQUEST_GAP_MS = 5_400

/** Their maximum per call. Asking for more is `response_code: 2`. */
const BATCH = 50

/** How many times one request may be re-sent after a rate-limit answer. */
const RATE_LIMIT_RETRIES = 4

/**
 * Consecutive questions a tier may contribute nothing from before it is treated
 * as saturated. Two full batches: at a ~15% drop rate from the content filters
 * alone, a run of this length means the category cap is what is refusing them.
 */
const FRUITLESS_LIMIT = 100

/** Transport errors only — an HTTP status is an answer and is never retried. */
const TRANSPORT_RETRIES = 3

const DEFAULT_MAX = 2000

/**
 * Our schema has four tiers; theirs has three. `novice` is deliberately absent
 * from this map — see `TIER_NOTE`.
 */
const SOURCE_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
type Difficulty = (typeof SOURCE_DIFFICULTIES)[number]

const TIER_NOTE =
  'Our `novice` tier has no Open Trivia DB equivalent: their easiest label is `easy`, and ' +
  'demoting some of it to `novice` would be inventing a difficulty judgement this script is ' +
  'not in a position to make. This import emits NOTHING for `novice`.'

/** The longest a prompt or an option may be, in characters. */
const MAX_TEXT_CHARS = 200

/**
 * How much of ONE TIER a single category may occupy, before `--max-per-category`
 * overrides it.
 *
 * A share rather than a count, because the right cap depends on how big the bank
 * is: 15 questions of video games is a fifth of a 75-question tier and a
 * rounding error in a 600-question one.
 *
 * Why cap at all — this is not editorial tidiness. `selectQuestionIds` draws one
 * question from each of five DISTINCT categories, and `trivia_seen` means a
 * wallet never meets the same question twice. So the
 * number of sessions a wallet can play is governed by how many categories still
 * hold an unseen question, NOT by the tier's question count. A tier that is deep
 * in three categories and shallow in twelve runs out while most of its questions
 * are still unseen — the deep categories cannot be drawn from twice in one
 * session, and there is nothing else to pair them with.
 *
 * Un-capped, Open Trivia DB skews hard: an early 60-question sample came back
 * with `entertainment-video-games` at 13 (22%) and the top four categories
 * holding 34 of 60.
 */
const CATEGORY_SHARE = 0.15

/**
 * Above this many categories-per-tier, the cap is asking for more breadth than
 * the source has. Their 24 category names collapse to roughly 19 slugs once
 * `CATEGORY_SLUGS` merges the ones that merge, and the content filters thin the
 * small ones further, so a cap that needs much more than half of them will
 * simply leave the tier short.
 */
const CATEGORY_HEADROOM_WARN = 12

/**
 * Questions in one session, and therefore distinct categories in one session.
 * `create-gated-drop.ts` refuses any other value and `selectQuestionIds` raises
 * `SelectionError` below it; restated here because the session arithmetic below
 * is meaningless without it.
 */
const QUESTIONS_PER_SESSION = 5

/**
 * Their long category names, mapped onto the short slugs the example bank uses,
 * ONLY where the fit is real. Everything absent from this map keeps a slugified
 * version of their own name, which is honest about what the question is: a
 * television question is not a film question, and folding it in would make
 * `film` mean "screens generally" in one tier and "cinema" in another.
 *
 * `food` and `language` are in our vocabulary and have no source category at
 * all, so nothing here produces them.
 */
const CATEGORY_SLUGS = new Map<string, string>([
  ['Geography', 'geography'],
  ['History', 'history'],
  ['Sports', 'sport'],
  ['Science & Nature', 'science'],
  ['Science: Mathematics', 'science'],
  ['Science: Computers', 'tech'],
  ['Science: Gadgets', 'tech'],
  ['Entertainment: Music', 'music'],
  ['Entertainment: Musicals & Theatres', 'music'],
  ['Entertainment: Film', 'film'],
])

/**
 * Reasons a decoded item never reaches the bank. Checked in this order, and a
 * dropped item is counted ONCE, against the first reason that matched — a tally
 * where one question adds to three counters tells an operator nothing about
 * which filter to loosen.
 */
const DROP_REASONS = [
  'malformed',
  'options-not-4-distinct',
  'too-long',
  'negation',
  'time-sensitive',
  'duplicate-id',
  'category-full',
] as const
type DropReason = (typeof DROP_REASONS)[number]

/**
 * Negation-style wording. A four-option question that asks which answer is NOT
 * true inverts the guess-rate argument the gate depends on — a player who can
 * eliminate one option is right three times in four — and reads as a trick
 * under a 20-second deadline.
 *
 * Applied to the prompt AND the options: "None of the above" as an option is
 * the same defect wearing a different hat.
 */
const NEGATION_PATTERNS: readonly RegExp[] = [
  /of the following/i,
  /of these/i,
  /\bnot\b/i,
  /n['’]t\b/i,
  /\bnever\b/i,
  /\bneither\b/i,
  /\bnone\b/i,
  /\bexcept\b/i,
  /\bincorrect\b/i,
  /\bfalse\b/i,
]

/**
 * Wording whose correct answer decays. A bank is written once and served for
 * months; "the latest" was true on import day and is a wrong answer by the time
 * a stranger meets it, which reads to them as us being broken.
 */
const TIME_SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\bcurrently\b/i,
  /\bas of\b/i,
  /\brecently\b/i,
  /\bthis year\b/i,
  /\blatest\b/i,
]

const USAGE = `
import the Open Trivia Database into a local trivia bank file.

  pnpm tsx spike/import-opentdb.ts --out <path> [flags]

  --out <path>       (required) where to write. MUST be outside this repository.
  --max <n>          stop after this many kept questions (default ${DEFAULT_MAX})
  --tiers <list>     comma-separated, from ${SOURCE_DIFFICULTIES.join(',')}
                     (default ${SOURCE_DIFFICULTIES.join(',')})
  --max-per-category <n>
                     most questions ONE category may hold in ONE tier. Default is
                     a share, not a count: ${(CATEGORY_SHARE * 100).toFixed(0)}% of the tier's target, i.e.
                     ceil(${CATEGORY_SHARE} × --max ÷ tiers). Questions past the cap are
                     fetched and then dropped as \`category-full\`.
  --dry-run          fetch, filter and validate, but write nothing
  --help             print this and exit 0

Their API allows ONE request every 5 seconds, so a full --max ${DEFAULT_MAX} run
takes roughly ${Math.ceil((DEFAULT_MAX / BATCH) * (MIN_REQUEST_GAP_MS / 1000) / 60)} minutes at best. Leave it running.
`.trimStart()

const VALUE_FLAGS = new Set(['--out', '--max', '--tiers', '--max-per-category'])
const SWITCH_FLAGS = new Set(['--dry-run', '--help'])

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const startedAt = Date.now()

function log(...parts: unknown[]): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7)
  console.log(`[${seconds}s]`, ...parts)
}

function field(label: string, value: unknown): void {
  console.log(`${label.padEnd(16)}:`, value)
}

class ImportError extends Error {}

/** Stop, and say why in one sentence an operator can act on. */
function fail(message: string): never {
  console.error(`\nREFUSED: ${message}\n`)
  throw new ImportError(message)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * Strict flag parsing: an unrecognised flag stops the run.
 *
 * The same reasoning as `create-gated-drop.ts`. A typo'd `--dry_run` that
 * parsed as "not given" would write a real file over a live bank, and there is
 * no confirmation prompt to catch it.
 */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const eq = token.indexOf('=')
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token
    if (!token.startsWith('--')) {
      fail(`argument ${i + 1} (${JSON.stringify(token)}) is not a --flag.\n${USAGE}`)
    }
    if (!VALUE_FLAGS.has(name) && !SWITCH_FLAGS.has(name)) fail(`unknown flag ${name}\n${USAGE}`)
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

/**
 * Where the file may go — anywhere the repository is not.
 *
 * Resolved against the REPO ROOT derived from this file's own location, not
 * from `process.cwd()`, so the answer does not change with the directory the
 * operator happened to run from.
 */
function resolveOutPath(raw: string): string {
  const out = resolve(process.cwd(), raw)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const inside = relative(repoRoot, out)
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
    fail(
      `--out ${out} is inside the repository at ${repoRoot}.\n\n` +
        '  A trivia bank is an ANSWER KEY. `gates/trivia/bank.ts` is explicit that its value ' +
        'comes from not being in hand: the per-question deadline constrains humans, not ' +
        'scripts, so a bank in a public history means a script takes every slot of every live ' +
        'drop.\n\n' +
        '  `.gitignore` does cover `questions.v*.json`, but a rule that has to be remembered is ' +
        'not a guard rail. Write it where the deployment reads it from — the path in ' +
        'TRIVIA_BANK_PATH, e.g. a mounted volume outside the checkout.',
    )
  }
  const parent = dirname(out)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    fail(`--out ${out}: the directory ${parent} does not exist. Create it first.`)
  }
  return out
}

// ---------------------------------------------------------------------------
// the API, paced
// ---------------------------------------------------------------------------

let lastRequestAt = 0

/**
 * One GET, never sooner than `MIN_REQUEST_GAP_MS` after the previous one.
 *
 * The pacing lives HERE, in the only function that reaches the network, rather
 * than in the fetch loops. A retry is a request too, and a sleep at the call
 * site is exactly the thing that gets forgotten on the retry path — which is
 * the path already running into their rate limit.
 *
 * A transport error is not an ANSWER and is retried; an HTTP status IS an
 * answer and is handed back for the caller to judge. HTTP 429 is the one
 * exception, because it means only "you were early".
 */
async function throttled(path: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()

    let res: Response | null = null
    for (let t = 1; t <= TRANSPORT_RETRIES; t += 1) {
      try {
        res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
        break
      } catch (err) {
        if (t === TRANSPORT_RETRIES) {
          fail(`GET ${path}: opentdb.com is unreachable after ${t} tries (${String(err)})`)
        }
        log(`GET ${path}: transport error (${String(err)}); retrying`)
        await sleep(MIN_REQUEST_GAP_MS)
        lastRequestAt = Date.now()
      }
    }
    assert(res !== null, `GET ${path}: retry loop exited without a response`)

    if (res.status === 429) {
      if (attempt > RATE_LIMIT_RETRIES) {
        fail(
          `GET ${path}: still HTTP 429 after ${RATE_LIMIT_RETRIES} backoffs. Another process on ` +
            'this IP is almost certainly hitting opentdb.com at the same time — their limit is ' +
            'per IP, not per token.',
        )
      }
      const backoff = MIN_REQUEST_GAP_MS * (attempt + 1)
      log(`GET ${path}: HTTP 429, backing off ${(backoff / 1000).toFixed(1)}s`)
      await sleep(backoff)
      continue
    }

    const text = await res.text()
    if (res.status !== 200) {
      fail(`GET ${path}: HTTP ${res.status}. First 200 bytes: ${text.slice(0, 200)}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      fail(`GET ${path}: HTTP 200 with a non-JSON body. First 200 bytes: ${text.slice(0, 200)}`)
    }
  }
}

function responseCode(body: unknown): number {
  const code = (body as { response_code?: unknown } | null)?.response_code
  assert(typeof code === 'number', `opentdb answered without a response_code: ${JSON.stringify(body)}`)
  return code
}

/**
 * A session token, so repeated pulls do not re-serve the same questions.
 *
 * Not persisted between runs on purpose. A stored token would eventually be
 * exhausted or expired (they drop after six hours idle) and the failure mode —
 * `response_code: 4` on the very first call, i.e. an import that writes nothing
 * and looks like a bug — is worse than re-requesting one every time. Duplicates
 * ACROSS runs are handled by the id being derived from the prompt.
 */
async function requestToken(): Promise<string> {
  const body = await throttled('/api_token.php?command=request')
  const code = responseCode(body)
  assert(code === 0, `opentdb refused a session token with response_code ${code}`)
  const token = (body as { token?: unknown }).token
  assert(
    typeof token === 'string' && token.length > 0,
    `opentdb answered response_code 0 with no token: ${JSON.stringify(body)}`,
  )
  return token
}

interface RawItem {
  type: string
  difficulty: string
  category: string
  question: string
  correct_answer: string
  incorrect_answers: string[]
}

/**
 * One batch, or a reason there is no batch.
 *
 * `drained` is returned for BOTH code 1 and code 4, which look different and
 * mean the same thing here. Code 4 is "this token has returned every question
 * for this query". Code 1 is "there are not `amount` questions left" — with a
 * token that is the tail of the same drain, and the caller shrinks its request
 * before believing it.
 */
type Batch =
  | { kind: 'items'; items: unknown[] }
  | { kind: 'drained'; code: 1 | 4 }

async function fetchBatch(token: string, difficulty: Difficulty, amount: number): Promise<Batch> {
  const path =
    `/api.php?amount=${amount}&type=multiple&encode=base64` +
    `&difficulty=${difficulty}&token=${token}`

  for (let attempt = 1; ; attempt += 1) {
    const body = await throttled(path)
    const code = responseCode(body)
    if (code === 0) {
      const results = (body as { results?: unknown }).results
      assert(Array.isArray(results), `opentdb answered response_code 0 with no results array`)
      return { kind: 'items', items: results }
    }
    if (code === 1 || code === 4) return { kind: 'drained', code }
    if (code === 5) {
      // Their own rate-limit signal, carried on an HTTP 200. `throttled` is
      // already pacing; this only ever fires when their clock and ours disagree.
      if (attempt > RATE_LIMIT_RETRIES) {
        fail(`opentdb kept answering response_code 5 (rate limited) after ${attempt - 1} backoffs`)
      }
      const backoff = MIN_REQUEST_GAP_MS * (attempt + 1)
      log(`response_code 5 (rate limited); backing off ${(backoff / 1000).toFixed(1)}s`)
      await sleep(backoff)
      continue
    }
    if (code === 2) {
      fail(
        `opentdb answered response_code 2 (invalid parameter) for amount=${amount} ` +
          `difficulty=${difficulty}. Their maximum amount is ${BATCH}.`,
      )
    }
    if (code === 3) {
      fail(
        'opentdb answered response_code 3 (token not found). The session token expired mid-run — ' +
          'they drop tokens after six hours idle. Re-run; nothing was written.',
      )
    }
    fail(`opentdb answered an undocumented response_code ${code}`)
  }
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/**
 * Base64 in, text out — and a round-trip check, because Node's decoder is
 * LENIENT: it silently drops characters it does not recognise rather than
 * throwing, so a corrupted field would arrive here as plausible-looking text
 * with letters missing. Re-encoding and comparing is the cheapest way to find
 * that, and a field that fails it makes the whole item `malformed`.
 */
function decodeField(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  const text = Buffer.from(value, 'base64').toString('utf8')
  if (Buffer.from(text, 'utf8').toString('base64') !== value) return null
  return text.trim() === '' ? null : text.trim()
}

function decodeItem(raw: unknown): RawItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const type = decodeField(r.type)
  const difficulty = decodeField(r.difficulty)
  const category = decodeField(r.category)
  const question = decodeField(r.question)
  const correct = decodeField(r.correct_answer)
  if (type === null || difficulty === null || category === null) return null
  if (question === null || correct === null) return null
  if (!Array.isArray(r.incorrect_answers)) return null
  const incorrect = r.incorrect_answers.map(decodeField)
  if (incorrect.some((o) => o === null)) return null
  return {
    type,
    difficulty,
    category,
    question,
    correct_answer: correct,
    incorrect_answers: incorrect as string[],
  }
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function questionId(prompt: string): string {
  return `otdb-${createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 12)}`
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'uncategorised' : slug
}

function categoryFor(name: string): string {
  return CATEGORY_SLUGS.get(name) ?? slugify(name)
}

/**
 * The k-th permutation of four items, k taken from the id's own hash.
 *
 * A Lehmer code rather than a shuffle: it depends on nothing but `k`, so there
 * is no iteration order, no comparator and no RNG state that could change the
 * result between two runs of two different Node versions.
 *
 * The four options are sorted before this is applied (see the file header), so
 * the output does not depend on the order their API happened to return.
 */
function permute<T>(sorted: readonly T[], k: number): T[] {
  const pool = [...sorted]
  const out: T[] = []
  let rest = k
  for (let size = pool.length; size > 0; size -= 1) {
    const index = rest % size
    rest = Math.floor(rest / size)
    out.push(pool.splice(index, 1)[0])
  }
  return out
}

/** 24 = 4!. Anything above that would bias the low permutations. */
function permutationIndex(id: string): number {
  return createHash('sha256').update(id, 'utf8').digest().readUInt32BE(0) % 24
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function matches(patterns: readonly RegExp[], texts: readonly string[]): boolean {
  return texts.some((t) => patterns.some((p) => p.test(t)))
}

/** Read-only view of what has been kept so far, for the two "already have it" filters. */
interface ConvertContext {
  seen: Set<string>
  /** tier -> category -> kept so far. Mutated by the CALLER, on success only. */
  byTierCategory: Map<Difficulty, Map<string, number>>
  /** Most one category may hold in one tier. */
  capPerCategory: number
}

/**
 * Turn one decoded item into a `Question`, or into the reason it was dropped.
 *
 * Nothing here mutates `ctx`, so a question dropped for length does not reserve
 * its id — or a slot in its category — against a later, better copy of itself.
 * The caller records a kept question.
 *
 * `category-full` is checked LAST, after every content filter, because the tally
 * is read as "which filter should I loosen": a question that is both a negation
 * and in a full category is a bad question first and a surplus one second, and
 * counting it as surplus would suggest raising the cap would recover it.
 */
function convert(item: RawItem, ctx: ConvertContext): { question: Question } | { drop: DropReason } {
  const prompt = item.question
  const options = [item.correct_answer, ...item.incorrect_answers]

  // 1. exactly four distinct, non-empty options
  if (options.length !== 4) return { drop: 'options-not-4-distinct' }
  if (options.some((o) => o === '')) return { drop: 'options-not-4-distinct' }
  if (new Set(options).size !== 4) return { drop: 'options-not-4-distinct' }

  // 2. length — a 20-second deadline is a reading test above this
  if (prompt.length > MAX_TEXT_CHARS) return { drop: 'too-long' }
  if (options.some((o) => o.length > MAX_TEXT_CHARS)) return { drop: 'too-long' }

  const texts = [prompt, ...options]
  if (matches(NEGATION_PATTERNS, texts)) return { drop: 'negation' }
  if (matches(TIME_SENSITIVE_PATTERNS, texts)) return { drop: 'time-sensitive' }

  const id = questionId(prompt)
  if (ctx.seen.has(id)) return { drop: 'duplicate-id' }

  const category = categoryFor(item.category)
  const held = ctx.byTierCategory.get(item.difficulty as Difficulty)?.get(category) ?? 0
  if (held >= ctx.capPerCategory) return { drop: 'category-full' }

  // Sorted, THEN permuted: byte-identical output for the same question, whatever
  // order their API returned the wrong answers in.
  const sorted = [...options].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const shuffled = permute(sorted, permutationIndex(id))
  const answerIndex = shuffled.indexOf(item.correct_answer)
  // Unreachable: `sorted` is a permutation of `options`, which contains the
  // correct answer. Asserted anyway — silently writing -1 would mean a bank in
  // which no answer is ever right, and nothing downstream would catch it.
  assert(answerIndex >= 0, `the correct answer vanished from the shuffle for ${id}`)

  return {
    question: {
      id,
      tier: item.difficulty as Tier,
      category,
      prompt,
      options: shuffled as [string, string, string, string],
      answerIndex: answerIndex as 0 | 1 | 2 | 3,
      source: SOURCE,
    },
  }
}

// ---------------------------------------------------------------------------
// how long a tier lasts one wallet
// ---------------------------------------------------------------------------

/**
 * The most sessions ONE wallet could play in a tier before it cannot be dealt a
 * set — an UPPER BOUND, not a forecast.
 *
 * The rule that makes this non-obvious: a session needs five DISTINCT
 * categories, so a single category contributes at most one question per session,
 * and `trivia_seen` means never the same question twice. Across `S` sessions a
 * category of size `c` can therefore supply at most `min(c, S)` questions, and
 * `S` sessions are dealable only while
 *
 *     Σ min(cᵢ, S)  ≥  5·S
 *
 * Each step of `S` adds one to that sum for every category with more than `S`
 * questions and five to the requirement, so once fewer than five categories are
 * still deep enough the margin only shrinks — the feasible values of `S` are a
 * prefix, and counting up from zero finds the largest.
 *
 * It is a ceiling because it assumes a perfectly spread deal. Real selection is
 * an HMAC over the wallet and the drop, which does not optimise anything, so
 * expect fewer. An operator sizing a bank wants the ceiling: if the ceiling is
 * three sessions, no amount of luck makes it ten.
 */
function sessionCeiling(counts: readonly number[]): number {
  if (counts.length < QUESTIONS_PER_SESSION) return 0
  for (let sessions = 1; ; sessions += 1) {
    const supply = counts.reduce((sum, c) => sum + Math.min(c, sessions), 0)
    if (supply < QUESTIONS_PER_SESSION * sessions) return sessions - 1
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.has('--help')) {
    console.log(USAGE)
    return
  }

  console.log('=== NimDrops — import Open Trivia DB ===\n')

  // -- 0. arguments, before a single request goes out ------------------------
  const outRaw = flags.get('--out')?.trim()
  assert(outRaw !== undefined && outRaw !== '', `--out is required\n${USAGE}`)
  // Resolved and refused HERE, not after several minutes of fetching: a run
  // that discovers its destination is illegal at the end has burned the rate
  // limit to tell the operator something it knew at the start.
  const outPath = resolveOutPath(outRaw)

  const maxRaw = flags.get('--max')
  const max = maxRaw === undefined ? DEFAULT_MAX : Number(maxRaw)
  assert(
    Number.isInteger(max) && max > 0,
    `--max must be a positive whole number, got ${JSON.stringify(maxRaw)}`,
  )

  const tiersRaw = flags.get('--tiers')?.trim() ?? SOURCE_DIFFICULTIES.join(',')
  const tiers = tiersRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
  assert(tiers.length > 0, '--tiers is empty')
  for (const tier of tiers) {
    if (tier === 'novice') {
      fail(`--tiers novice is refused. ${TIER_NOTE}`)
    }
    assert(
      (SOURCE_DIFFICULTIES as readonly string[]).includes(tier),
      `--tiers must be a comma-separated subset of ${SOURCE_DIFFICULTIES.join(',')}, got ${tier}`,
    )
  }
  assert(new Set(tiers).size === tiers.length, `--tiers ${tiersRaw} repeats a tier`)
  const wanted = tiers as Difficulty[]

  // The cap is per TIER per CATEGORY, so it is derived from the tier's target —
  // `--max` split across the tiers — not from `--max` itself.
  const tierTarget = Math.ceil(max / wanted.length)
  const capRaw = flags.get('--max-per-category')
  const capPerCategory =
    capRaw === undefined ? Math.max(1, Math.ceil(CATEGORY_SHARE * tierTarget)) : Number(capRaw)
  assert(
    Number.isInteger(capPerCategory) && capPerCategory > 0,
    `--max-per-category must be a positive whole number, got ${JSON.stringify(capRaw)}`,
  )
  // How many categories a tier now NEEDS to reach its target. Reported as part
  // of the cap field rather than as a warning, because with the default share it
  // is true on every run: 15% of a tier always needs seven categories to fill it.
  const categoriesNeeded = Math.ceil(tierTarget / capPerCategory)

  const dryRun = flags.get('--dry-run') === 'true'
  const version = `otdb-${new Date().toISOString().slice(0, 10)}`

  field('out', outPath + (dryRun ? '  (DRY RUN — nothing will be written)' : ''))
  field('max kept', `${max} (about ${tierTarget} per tier)`)
  field('tiers', wanted.join(', '))
  field(
    'category cap',
    `${capPerCategory} per tier ` +
      (capRaw === undefined ? `(${(CATEGORY_SHARE * 100).toFixed(0)}% of ${tierTarget})` : '(--max-per-category)') +
      ` — needs ${categoriesNeeded} categories to fill a tier`,
  )
  // Only when the cap asks for more of the source than it reliably has. Their 24
  // category names collapse to roughly 19 slugs after mapping, and the content
  // filters thin the small ones, so needing much past half of them is fragile.
  if (categoriesNeeded > CATEGORY_HEADROOM_WARN) {
    console.log(
      `!! a cap of ${capPerCategory} needs ${categoriesNeeded} categories per tier, and Open Trivia DB\n` +
        '!! has about 19 after mapping. Expect the tiers to fall short of their target.',
    )
  }
  field('version', version)
  field('pacing', `1 request / ${(MIN_REQUEST_GAP_MS / 1000).toFixed(1)}s (their limit is 5s/IP)`)
  console.log('')

  // -- 1. a session token, so repeated pulls do not repeat themselves --------
  const token = await requestToken()
  log(`session token acquired (${token.slice(0, 8)}…)`)

  // -- 2. drain the tiers, always feeding the emptiest one -------------------
  // Not tier-by-tier and not a plain round robin. Tier-by-tier spends the whole
  // of a small `--max` on `easy`; a round robin at batch granularity does
  // almost the same, because one 50-question batch is most of a small budget.
  // So each pass picks the tier with the FEWEST kept questions and asks for its
  // fair share of what is left. `--max 60 --tiers easy,medium,hard` then writes
  // roughly twenty of each, which is what passing three tiers asked for.
  const kept: Question[] = []
  const keptByTier = new Map<Difficulty, number>(wanted.map((t) => [t, 0]))
  const byTierCategory = new Map<Difficulty, Map<string, number>>(
    wanted.map((t) => [t, new Map<string, number>()]),
  )
  const seen = new Set<string>()
  const drops = new Map<DropReason, number>(DROP_REASONS.map((r) => [r, 0]))
  const drained = new Set<Difficulty>()
  /**
   * Tiers whose categories are all at cap. A tier that keeps nothing from a
   * hundred consecutive questions is not going to keep anything from the next
   * hundred either, and the emptiest-tier rule below would otherwise pick it
   * every single pass — spinning at 5.4s a request until its token drained.
   */
  const saturated = new Set<Difficulty>()
  const fruitless = new Map<Difficulty, number>(wanted.map((t) => [t, 0]))
  let fetched = 0
  let exhaustedEarly = false
  let saturatedEarly = false
  /**
   * Per-tier ceiling on `amount`, lowered when their code 1 says "there are not
   * that many left". Strictly decreasing, which is what makes the tail drain
   * terminate rather than ask the same doomed question forever.
   */
  const ceilings = new Map<Difficulty, number>(wanted.map((t) => [t, BATCH]))

  while (kept.length < max) {
    const active = wanted.filter((t) => !drained.has(t) && !saturated.has(t))
    if (active.length === 0) break

    const tier = active.reduce((a, b) =>
      (keptByTier.get(b) as number) < (keptByTier.get(a) as number) ? b : a,
    )
    const share = Math.max(1, Math.ceil((max - kept.length) / active.length))
    const amount = Math.min(ceilings.get(tier) as number, share)
    const batch = await fetchBatch(token, tier, amount)

    if (batch.kind === 'drained') {
      // Code 4 is final: the token has handed out every question for this query.
      // Code 1 means "fewer than `amount` are left" — halve and ask again, so
      // the tail of the pool is not thrown away, and give up only when even one
      // question cannot be produced.
      if (batch.code === 4 || amount === 1) {
        drained.add(tier)
        exhaustedEarly = true
        log(`${tier}: drained (response_code ${batch.code}) at ${kept.length} kept overall`)
        continue
      }
      ceilings.set(tier, Math.floor(amount / 2))
      log(`${tier}: response_code 1 at amount=${amount}; retrying at amount=${Math.floor(amount / 2)}`)
      continue
    }

    fetched += batch.items.length
    let keptHere = 0
    for (const raw of batch.items) {
      if (kept.length >= max) break
      const item = decodeItem(raw)
      if (item === null) {
        drops.set('malformed', (drops.get('malformed') as number) + 1)
        continue
      }
      // Their `difficulty` is what the bank's `tier` becomes, so it has to be
      // the one we asked for. A mismatch means the query did not mean what we
      // thought and the tier labels in the file would be fiction.
      assert(
        item.difficulty === tier,
        `asked opentdb for difficulty=${tier} and got ${item.difficulty}`,
      )
      const result = convert(item, { seen, byTierCategory, capPerCategory })
      if ('drop' in result) {
        drops.set(result.drop, (drops.get(result.drop) as number) + 1)
        continue
      }
      seen.add(result.question.id)
      kept.push(result.question)
      keptHere += 1
      // Recorded HERE, not in `convert`, so a question rejected by a later filter
      // never consumes a slot in its category.
      const counts = byTierCategory.get(tier) as Map<string, number>
      const held = (counts.get(result.question.category) ?? 0) + 1
      counts.set(result.question.category, held)
      if (held === capPerCategory) {
        log(`${tier}/${result.question.category}: at its cap of ${capPerCategory}`)
      }
    }
    keptByTier.set(tier, (keptByTier.get(tier) as number) + keptHere)

    // Saturation, tracked in ITEMS rather than batches because `amount` shrinks
    // to 1 or 2 in the tail and "kept nothing from one question" is no evidence.
    if (keptHere > 0) fruitless.set(tier, 0)
    else fruitless.set(tier, (fruitless.get(tier) as number) + batch.items.length)
    if ((fruitless.get(tier) as number) >= FRUITLESS_LIMIT) {
      saturated.add(tier)
      saturatedEarly = true
      log(
        `${tier}: saturated — ${fruitless.get(tier)} consecutive questions kept nothing, so its ` +
          `categories are at the cap of ${capPerCategory}. Not asking for more of this tier.`,
      )
    }

    log(
      `${tier}: asked ${amount}, +${keptHere}/${batch.items.length} kept — ` +
        `${kept.length}/${max} total, ${fetched} fetched`,
    )
  }

  // -- 3. the report ---------------------------------------------------------
  // Sorted by id: `questionsForTier` sorts the same way, and a stable file order
  // is what makes two imports of the same questions diff to nothing.
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const perTier = new Map<string, number>()
  const perCategory = new Map<string, number>()
  for (const q of kept) {
    perTier.set(q.tier, (perTier.get(q.tier) ?? 0) + 1)
    perCategory.set(q.category, (perCategory.get(q.category) ?? 0) + 1)
  }
  const droppedTotal = [...drops.values()].reduce((a, b) => a + b, 0)

  console.log('\n--- fetched and filtered ---')
  field('fetched', fetched)
  field('kept', kept.length)
  field('dropped', droppedTotal)
  console.log('\ndropped, by reason:')
  for (const reason of DROP_REASONS) {
    console.log(`  ${reason.padEnd(24)} ${String(drops.get(reason) ?? 0).padStart(6)}`)
  }

  // Per TIER per CATEGORY, recomputed from the questions actually kept rather
  // than read out of the counters the loop maintained — the table an operator
  // acts on has to describe the FILE, not the bookkeeping.
  const catsByTier = new Map<string, Map<string, number>>()
  for (const q of kept) {
    const counts = catsByTier.get(q.tier) ?? new Map<string, number>()
    counts.set(q.category, (counts.get(q.category) ?? 0) + 1)
    catsByTier.set(q.tier, counts)
  }
  const sessionsByTier = new Map<string, number>()
  for (const tier of ['novice', ...SOURCE_DIFFICULTIES]) {
    sessionsByTier.set(tier, sessionCeiling([...(catsByTier.get(tier)?.values() ?? [])]))
  }

  // `novice` is listed at zero on purpose — an operator reading this report has
  // to see that the tier exists and that this import did not fill it.
  console.log('\nkept, by tier — a session needs 5 questions from 5 DISTINCT categories:')
  console.log(
    `  ${'tier'.padEnd(10)}${'questions'.padStart(10)}${'categories'.padStart(12)}` +
      `${'sessions'.padStart(10)}`,
  )
  for (const tier of ['novice', ...SOURCE_DIFFICULTIES]) {
    const categories = catsByTier.get(tier)?.size ?? 0
    console.log(
      `  ${tier.padEnd(10)}${String(perTier.get(tier) ?? 0).padStart(10)}` +
        `${String(categories).padStart(12)}${String(sessionsByTier.get(tier) ?? 0).padStart(10)}`,
    )
  }
  console.log(
    '\n  `sessions` is the CEILING for ONE wallet: `trivia_seen` means a wallet never meets the\n' +
      '  same question twice, and a category can supply at most one question per session, so the\n' +
      '  largest S with sum(min(per-category count, S)) >= 5S. Real selection is an HMAC that\n' +
      '  optimises nothing, so expect fewer — but no wallet gets more.',
  )
  console.log(`\n  note: ${TIER_NOTE}`)

  // Loud, and about the tiers the OPERATOR asked for. `selectQuestionIds` throws
  // `SelectionError` below five categories and `create-gated-drop.ts` refuses to
  // create a drop on such a tier — but a bank written now and pinned later would
  // surface that only when a stranger tapped Start.
  const thin = wanted.filter((t) => (catsByTier.get(t)?.size ?? 0) < QUESTIONS_PER_SESSION)
  if (thin.length > 0) {
    console.log(
      `\n${'!'.repeat(78)}\n` +
        `!! TIER TOO THIN: ${thin.join(', ')} — fewer than ${QUESTIONS_PER_SESSION} distinct ` +
        'categories.\n!!\n' +
        `!! \`selectQuestionIds\` draws one question from each of ${QUESTIONS_PER_SESSION} distinct ` +
        'categories and\n' +
        '!! raises SelectionError below that, so NO SESSION CAN BE DEALT from these tiers. A\n' +
        '!! drop pinned to one would answer `misconfigured` at a stranger\'s first tap.\n' +
        '!!\n!! Raise --max, or pass --tiers only for the tiers you can fill.\n' +
        `${'!'.repeat(78)}`,
    )
  }
  const zeroSessions = wanted.filter(
    (t) => (catsByTier.get(t)?.size ?? 0) >= QUESTIONS_PER_SESSION && sessionsByTier.get(t) === 0,
  )
  if (zeroSessions.length > 0) {
    console.log(
      `\n!! ${zeroSessions.join(', ')} has ${QUESTIONS_PER_SESSION}+ categories but a session ` +
        'ceiling of 0 — its categories\n!! cannot jointly supply one full set. Raise --max.',
    )
  }

  console.log(`\nkept, by category (${perCategory.size} distinct, cap ${capPerCategory}/tier):`)
  for (const [category, count] of [...perCategory].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const share = ((count / kept.length) * 100).toFixed(1)
    const perTierBreakdown = wanted
      .map((t) => `${t[0]}${catsByTier.get(t)?.get(category) ?? 0}`)
      .join(' ')
    console.log(
      `  ${category.padEnd(36)} ${String(count).padStart(6)} ${share.padStart(5)}%  ${perTierBreakdown}`,
    )
  }

  if (exhaustedEarly && kept.length < max) {
    console.log(
      `\n!! The session token ran out at ${kept.length} of the requested ${max}. That is the whole\n` +
        '!! of Open Trivia DB that survives these filters for these tiers, not a failure — the\n' +
        '!! bank below is complete and will be written. Re-running will not find more.',
    )
  }
  if (saturatedEarly && kept.length < max) {
    console.log(
      `\n!! Stopped at ${kept.length} of the requested ${max} because every category of at least one\n` +
        `!! tier reached the cap of ${capPerCategory}. This is the cap working, not a failure: the\n` +
        '!! remaining source questions would all have gone into categories that are already full.\n' +
        '!! To go deeper, raise --max (which raises the share-derived cap with it) rather than\n' +
        '!! --max-per-category on its own, which would just re-concentrate the bank.',
    )
  }

  // -- 4. validate through the loader that will read it back -----------------
  // The same `parseBank` the runtime calls. A bank this script invented and only
  // this script understood would fail at a stranger's first tap, be reported as
  // `misconfigured`, and answered as a 5xx — a broken game rather than a refused
  // import.
  assert(
    kept.length > 0,
    'nothing survived the filters, so there is no bank to write. `parseBank` refuses an empty ' +
      'question list, and a drop pinned to an empty bank is unplayable.',
  )
  const bank: Bank = { version, questions: kept }
  try {
    parseBank(JSON.parse(JSON.stringify(bank)))
  } catch (err) {
    fail(
      `the assembled bank does not pass parseBank, so it is NOT being written: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  log(`parseBank accepted ${kept.length} questions at version ${version}`)

  // -- 5. write, or say what would have been written -------------------------
  if (dryRun) {
    console.log(`\n=== DRY RUN — nothing written ===`)
    field('would write', outPath)
    field('questions', kept.length)
    console.log('')
    return
  }

  await writeFile(outPath, `${JSON.stringify(bank, null, 2)}\n`, 'utf8')

  console.log('\n=== WRITTEN ===')
  field('path', outPath)
  field('version', version)
  field('questions', kept.length)
  console.log('\npoint a deployment at it with TRIVIA_BANK_PATH, then create a drop:')
  console.log(`  TRIVIA_BANK_PATH=${outPath} pnpm tsx spike/create-gated-drop.ts --kind trivia …`)
  console.log(
    '\nBefore pinning a drop to a tier, read the `categories` and `sessions` columns above:\n' +
      '`create-gated-drop.ts` refuses a tier with fewer than five distinct categories, and the\n' +
      'session ceiling is how many games one wallet can play there before it runs dry.',
  )
  console.log(`\nOpen Trivia DB is CC BY-SA 4.0; every question carries source ${SOURCE}`)
  console.log('')
}

async function teardown(): Promise<void> {
  // Nothing to close: no pool, no chain client, no key. The shape stays the same
  // as every other entrypoint's so the exit rules in `exit.ts` still apply —
  // notably the flush, since this script's whole product is its report.
}

run().then(
  () => exitAfterTeardown(0, teardown, (message) => console.error(message)),
  (err: unknown) => {
    // `fail()` has already printed its own message; anything else has not.
    if (!(err instanceof ImportError)) {
      console.error('\nFAILED:', err instanceof Error ? (err.stack ?? err.message) : String(err), '\n')
    }
    exitAfterTeardown(1, teardown, (message) => console.error(message))
  },
)
