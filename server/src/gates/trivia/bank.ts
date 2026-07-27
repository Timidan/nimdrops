/**
 * Load and validate a trivia question bank.
 *
 * The bank is OPERATOR CONTENT, not repository content: only
 * `questions.example.json` is committed, and the real file is read from
 * `TRIVIA_BANK_PATH` at runtime. The reason is not secrecy for its own sake — a
 * public bank is a machine-readable answer key, and a script answers five
 * questions inside their deadlines trivially, so a farmer holding the bank takes
 * every slot of every live drop. The per-question deadline — whatever a gate is
 * configured with — constrains humans, not scripts; its value comes from the
 * bank not being in hand.
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
  const { id, tier, category, prompt, options, answerIndex, source } = raw

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

  return {
    id,
    tier: tier as Tier,
    category,
    prompt,
    options: options as [string, string, string, string],
    answerIndex: answerIndex as 0 | 1 | 2 | 3,
    source,
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
