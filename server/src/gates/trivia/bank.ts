/**
 * Load and validate a trivia question bank.
 *
 * The bank is OPERATOR CONTENT, not repository content: only
 * `questions.example.json` is committed, and the real file is read from
 * `TRIVIA_BANK_PATH` at runtime. That keeps one deployment's questions out of the
 * repository; it does NOT make them secret, and no security argument here may
 * assume it does. The shipped bank combines Open Trivia DB questions with
 * original questions backed by public reference pages. A determined farmer can
 * still harvest the answer key, and a script answers five questions inside their
 * deadlines trivially.
 *
 * Which is the honest position for this whole kind: trivia is an ENGAGEMENT
 * MECHANIC, not an authorization control (spec §6). What bounds the money is the
 * drop's fixed slot count and one claim per wallet, enforced in `reserveClaim` —
 * never the difficulty of the questions. See {@link Question.disclosable} for the
 * one place that distinction has teeth.
 *
 * No database and no HTTP here, so this module stays unit-testable.
 */
import { readFile } from 'node:fs/promises'

export type Tier = 'novice' | 'easy' | 'medium' | 'hard'

const TIERS: readonly Tier[] = ['novice', 'easy', 'medium', 'hard']

/** Exactly four, because the guess-rate argument in the spec depends on it. */
export const OPTIONS_PER_QUESTION = 4

export interface Question {
  id: string
  tier: Tier
  category: string
  prompt: string
  options: [string, string, string, string]
  answerIndex: 0 | 1 | 2 | 3
  /** Where the fact was verified. Never sent to a client. */
  source: string
  /**
   * This question's answer is ALREADY PUBLISHED somewhere anyone can read it, so
   * echoing it back in a finished session's review discloses nothing that was not
   * already downloadable. Only such a question has its `correctIndex` revealed —
   * see `buildReview` in `sessions.ts`.
   *
   * The field exists because the reveal's original justification was wrong. It
   * rested on `trivia_seen`: a wallet never meets a question twice, so knowing an
   * answer is worth nothing to the wallet that learned it. True, and irrelevant —
   * a session starts under a CLIENT-ASSERTED address with no signature, so
   * addresses are free. An attacker opens sessions under disposable addresses,
   * harvests five question/answer pairs each, and then plays cleanly with the
   * wallet that will actually claim. `trivia_seen` constrains only the throwaway
   * addresses; the per-wallet cooldown does not touch a Sybil at all. Learning a
   * whole tier costs roughly `ceil(N/5)` sessions, not 1024 guesses.
   *
   * Today every shipped question either comes from Open Trivia DB or cites a
   * public page containing the answer. A private or unpublished question must not
   * inherit that assumption, so the condition is enforced here rather than left
   * to an operator comment.
   *
   * Absent means false. That is the direction to be wrong in: a hand-written
   * question that says nothing about publication keeps its answer, and the cost of
   * being wrong is a review that shows "not correct" without naming the right
   * option. The other default costs the answer key.
   */
  disclosable: boolean
}

export interface Bank {
  version: string
  questions: Question[]
}

export class BankError extends Error {}

function fail(what: string): never {
  throw new BankError(`trivia bank is not valid: ${what}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseQuestion(raw: unknown, at: number): Question {
  if (!isRecord(raw)) fail(`question ${at} is not an object`)
  const { id, tier, category, prompt, options, answerIndex, source, disclosable } = raw

  if (typeof id !== 'string' || id.length === 0) fail(`question ${at} has no id`)
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) {
    fail(`question ${id} has tier ${String(tier)}, expected one of ${TIERS.join(', ')}`)
  }
  if (typeof category !== 'string' || category.length === 0) fail(`question ${id} has no category`)
  if (typeof prompt !== 'string' || prompt.length === 0) fail(`question ${id} has no prompt`)
  if (!Array.isArray(options) || options.length !== OPTIONS_PER_QUESTION) {
    fail(`question ${id} needs exactly ${OPTIONS_PER_QUESTION} options`)
  }
  if (options.some((o) => typeof o !== 'string' || o.length === 0)) {
    fail(`question ${id} has an empty option`)
  }
  if (new Set(options as string[]).size !== OPTIONS_PER_QUESTION) {
    fail(`question ${id} has duplicate options`)
  }
  if (
    typeof answerIndex !== 'number' ||
    !Number.isInteger(answerIndex) ||
    answerIndex < 0 ||
    answerIndex >= OPTIONS_PER_QUESTION
  ) {
    fail(`question ${id} has answerIndex ${String(answerIndex)}, expected 0..3`)
  }
  if (typeof source !== 'string' || source.length === 0) {
    fail(`question ${id} has no source reference`)
  }
  // Deliberately NOT a validation failure when absent, and deliberately `=== true`
  // rather than truthiness. A missing field means "nobody has said this answer is
  // public", which is the safe reading; rejecting the bank outright would instead
  // make an operator's first hand-written question break the whole deployment, and
  // the obvious way out of that is to set the flag without thinking about it.
  if (disclosable !== undefined && typeof disclosable !== 'boolean') {
    fail(`question ${id} has disclosable ${String(disclosable)}, expected true or false`)
  }

  return {
    id,
    tier: tier as Tier,
    category,
    prompt,
    options: options as [string, string, string, string],
    answerIndex: answerIndex as 0 | 1 | 2 | 3,
    source,
    disclosable: disclosable === true,
  }
}

export function parseBank(raw: unknown): Bank {
  if (!isRecord(raw)) fail('top level is not an object')
  const { version, questions } = raw
  if (typeof version !== 'string' || version.length === 0) fail('no version string')
  if (!Array.isArray(questions) || questions.length === 0) fail('no questions')

  const parsed = questions.map(parseQuestion)
  const seen = new Set<string>()
  for (const q of parsed) {
    if (seen.has(q.id)) fail(`duplicate question id ${q.id}`)
    seen.add(q.id)
  }
  return { version, questions: parsed }
}

export async function loadBank(path: string): Promise<Bank> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new BankError(`cannot read trivia bank at ${path}: ${(err as Error).message}`)
  }
  try {
    return parseBank(JSON.parse(text))
  } catch (err) {
    if (err instanceof BankError) throw err
    throw new BankError(`trivia bank at ${path} is not JSON: ${(err as Error).message}`)
  }
}

/**
 * Every question in one tier, sorted by id.
 *
 * The sort is load-bearing: selection is deterministic from an HMAC over an
 * index into THIS array, so a stable order is what makes a retry serve the
 * identical question set.
 */
export function questionsForTier(bank: Bank, tier: Tier): Question[] {
  return bank.questions.filter((q) => q.tier === tier).sort((a, b) => (a.id < b.id ? -1 : 1))
}
