import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BankError, loadBank, parseBank, questionsForTier } from '../src/gates/trivia/bank'

const ok = {
  version: 'v1',
  questions: [
    {
      id: 'geo-001',
      tier: 'novice',
      category: 'geography',
      prompt: 'What is the capital of Japan?',
      options: ['Osaka', 'Tokyo', 'Kyoto', 'Nagoya'],
      answerIndex: 1,
      source: 'https://example.org/japan',
    },
  ],
}

describe('parseBank', () => {
  it('accepts a well-formed bank', () => {
    expect(parseBank(ok).questions[0].id).toBe('geo-001')
  })

  it('rejects a question with fewer than four options', () => {
    const bad = { ...ok, questions: [{ ...ok.questions[0], options: ['a', 'b', 'c'] }] }
    expect(() => parseBank(bad)).toThrow(BankError)
  })

  it('rejects an answerIndex outside 0..3', () => {
    const bad = { ...ok, questions: [{ ...ok.questions[0], answerIndex: 4 }] }
    expect(() => parseBank(bad)).toThrow(BankError)
  })

  it('rejects a duplicate question id', () => {
    const bad = { ...ok, questions: [ok.questions[0], ok.questions[0]] }
    expect(() => parseBank(bad)).toThrow(/duplicate/i)
  })

  it('rejects an unknown tier', () => {
    const bad = { ...ok, questions: [{ ...ok.questions[0], tier: 'expert' }] }
    expect(() => parseBank(bad)).toThrow(BankError)
  })

  it('rejects a missing version', () => {
    expect(() => parseBank({ questions: ok.questions })).toThrow(BankError)
  })
})

describe('parseBank / disclosable', () => {
  const withFlag = (disclosable: unknown) =>
    parseBank({ ...ok, questions: [{ ...ok.questions[0], disclosable }] }).questions[0].disclosable

  /**
   * The flag decides whether a finished session names the right option. Absent
   * must mean false, because absent is what a hand-written question looks like
   * before anyone has decided whether its answer is public — and the cost of
   * being wrong in that direction is a review that says "not correct" without
   * naming an answer, against an answer key handed out five questions at a time.
   */
  it('is false when the question does not mention it', () => {
    expect(parseBank(ok).questions[0].disclosable).toBe(false)
  })

  it('is true only for the boolean, never for a truthy value', () => {
    expect(withFlag(true)).toBe(true)
    expect(withFlag(false)).toBe(false)
  })

  it('rejects a non-boolean rather than reading it as permission', () => {
    // `"true"` is the shape a hand-edited JSON file takes when somebody quotes
    // the value, and `1` is what a spreadsheet export produces. Truthiness would
    // read both as "publish this answer".
    expect(() => withFlag('true')).toThrow(BankError)
    expect(() => withFlag(1)).toThrow(BankError)
    expect(() => withFlag(null)).toThrow(BankError)
  })

  it('accepts the committed example bank, whose answers are already public', async () => {
    // The example lives in a public repository, so its questions carry the flag
    // honestly. This also proves the shipped file still parses under the stricter
    // rule rather than only under the one it was written for.
    const bank = await loadBank(
      fileURLToPath(new URL('../src/gates/trivia/questions.example.json', import.meta.url)),
    )
    expect(bank.questions.every((q) => q.disclosable)).toBe(true)
  })
})

describe('questionsForTier', () => {
  it('returns questions in a stable id order, so selection is reproducible', () => {
    const bank = parseBank({
      version: 'v1',
      questions: [
        { ...ok.questions[0], id: 'b-002' },
        { ...ok.questions[0], id: 'a-001' },
      ],
    })
    expect(questionsForTier(bank, 'novice').map((q) => q.id)).toEqual(['a-001', 'b-002'])
  })

  it('returns an empty array for a tier with no questions', () => {
    expect(questionsForTier(parseBank(ok), 'hard')).toEqual([])
  })
})
