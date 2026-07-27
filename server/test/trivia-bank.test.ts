import { describe, expect, it } from 'vitest'
import { BankError, parseBank, questionsForTier } from '../src/gates/trivia/bank'

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
