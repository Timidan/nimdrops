/**
 * Deterministic, unpredictable question selection.
 *
 * Two properties, both required:
 *
 *  - UNPREDICTABLE without the salt. A player who has the bank must still not
 *    know which five questions they will be asked, so they cannot look the
 *    answers up before starting.
 *  - DETERMINISTIC given the salt. A retry serves the IDENTICAL set. Combined
 *    with never revealing per-question correctness, a failed attempt leaks one
 *    bit ("something was wrong") instead of narrowing the answer space.
 *
 * Pure: no database, no clock, no randomness.
 */
import { createHmac } from 'node:crypto'
import { type Bank, type Question, type Tier, questionsForTier } from './bank'

export class SelectionError extends Error {}

/**
 * A deterministic 32-bit value from the HMAC of a label.
 *
 * `createHmac` is keyed on the salt, so without it the stream cannot be
 * reproduced from the bank.
 */
function streamValue(salt: string, label: string): number {
  return createHmac('sha256', salt).update(label).digest().readUInt32BE(0)
}

/**
 * One question from each of `count` distinct categories.
 *
 * Distinct categories are not decoration: a five-question set drawn from one
 * category lets a specialist coast, and makes the tier's difficulty rubric mean
 * something different per player.
 */
export function selectQuestionIds(o: {
  bank: Bank
  tier: Tier
  salt: string
  dropId: string
  walletAddress: string
  count: number
}): string[] {
  const pool = questionsForTier(o.bank, o.tier)
  if (pool.length === 0) throw new SelectionError(`no questions in tier ${o.tier}`)

  const byCategory = new Map<string, Question[]>()
  for (const q of pool) {
    const list = byCategory.get(q.category)
    if (list) list.push(q)
    else byCategory.set(q.category, [q])
  }

  const categories = [...byCategory.keys()].sort()
  if (categories.length < o.count) {
    throw new SelectionError(
      `tier ${o.tier} has ${categories.length} categories, need ${o.count} distinct`,
    )
  }

  const seed = `${o.dropId} ${o.walletAddress} ${o.bank.version} ${o.tier}`

  // Deterministic shuffle: sort categories by their keyed stream value. A sort
  // is used rather than a Fisher-Yates so the result depends only on the values,
  // never on iteration order of the map.
  const chosenCategories = categories
    .map((category) => ({ category, rank: streamValue(o.salt, `${seed} cat ${category}`) }))
    .sort((a, b) => (a.rank === b.rank ? (a.category < b.category ? -1 : 1) : a.rank - b.rank))
    .slice(0, o.count)
    .map((c) => c.category)

  return chosenCategories.map((category) => {
    const candidates = byCategory.get(category)!
    const pick = streamValue(o.salt, `${seed} q ${category}`) % candidates.length
    return candidates[pick].id
  })
}
