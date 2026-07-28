import { describe, expect, it } from 'vitest'
import { type Bank, parseBank } from '../src/gates/trivia/bank'
import { SelectionError, selectQuestionIds } from '../src/gates/trivia/select'

const SALT = 'x'.repeat(32)

/** 12 novice questions across 6 categories, two per category. */
function bank(): Bank {
  const categories = ['geography', 'science', 'history', 'sport', 'music', 'film']
  return parseBank({
    version: 'v1',
    questions: categories.flatMap((category, c) =>
      [0, 1].map((n) => ({
        id: `${category}-${n}`,
        tier: 'novice',
        category,
        prompt: `${category} ${n}?`,
        options: ['a', 'b', 'c', 'd'],
        answerIndex: n,
        source: 'https://example.org',
      })),
    ),
  })
}

const base = { bank: bank(), tier: 'novice' as const, salt: SALT, count: 5 }

describe('selectQuestionIds', () => {
  it('is deterministic for the same wallet and drop', () => {
    const a = selectQuestionIds({ ...base, dropId: 'drop-1', walletAddress: 'NQ07 A' })
    const b = selectQuestionIds({ ...base, dropId: 'drop-1', walletAddress: 'NQ07 A' })
    expect(a).toEqual(b)
  })

  it('differs between wallets on the same drop', () => {
    const a = selectQuestionIds({ ...base, dropId: 'drop-1', walletAddress: 'NQ07 A' })
    const b = selectQuestionIds({ ...base, dropId: 'drop-1', walletAddress: 'NQ07 B' })
    expect(a).not.toEqual(b)
  })

  it('differs between drops for the same wallet', () => {
    const a = selectQuestionIds({ ...base, dropId: 'drop-1', walletAddress: 'NQ07 A' })
    const b = selectQuestionIds({ ...base, dropId: 'drop-2', walletAddress: 'NQ07 A' })
    expect(a).not.toEqual(b)
  })

  it('depends on the salt, so a leaked bank does not reveal the set', () => {
    const a = selectQuestionIds({ ...base, dropId: 'd', walletAddress: 'NQ07 A' })
    const b = selectQuestionIds({ ...base, salt: 'y'.repeat(32), dropId: 'd', walletAddress: 'NQ07 A' })
    expect(a).not.toEqual(b)
  })

  it('returns exactly count ids, all distinct', () => {
    const ids = selectQuestionIds({ ...base, dropId: 'd', walletAddress: 'NQ07 A' })
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
  })

  it('draws each question from a distinct category', () => {
    const b = bank()
    const ids = selectQuestionIds({ ...base, bank: b, dropId: 'd', walletAddress: 'NQ07 A' })
    const categories = ids.map((id) => b.questions.find((q) => q.id === id)!.category)
    expect(new Set(categories).size).toBe(5)
  })

  it('refuses when the tier has fewer distinct categories than count', () => {
    const thin = parseBank({
      version: 'v1',
      questions: [
        {
          id: 'only-1',
          tier: 'hard',
          category: 'science',
          prompt: 'q?',
          options: ['a', 'b', 'c', 'd'],
          answerIndex: 0,
          source: 'https://example.org',
        },
      ],
    })
    expect(() =>
      selectQuestionIds({ ...base, bank: thin, tier: 'hard', dropId: 'd', walletAddress: 'NQ07 A' }),
    ).toThrow(SelectionError)
  })
})
