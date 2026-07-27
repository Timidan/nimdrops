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
/**
 * @param exclude question ids this wallet has already been shown, from
 *   `trivia_seen`. Nothing in it can be selected again.
 *
 *   This is what lets a finished session REVEAL its answers. The two rules only
 *   work as a pair: a wallet never meets a question twice, so knowing its answer
 *   is worth nothing to that wallet, and therefore the answers can be shown.
 *
 *   It also replaces the old bound rather than adding to it. Selection used to be
 *   deterministic per (drop, wallet), so a retry served the identical set and a
 *   failure leaked one bit — brute force was 4^5 = 1024 attempts. Under a reveal
 *   that would collapse to about four: test one option across all five questions,
 *   read every verdict, repeat. So determinism is given up deliberately, and what
 *   makes cheating expensive is now the size of the pool a wallet has to walk.
 *
 *   `seed` still includes the wallet, so two players never get the same five in
 *   the same order, and the salt still keeps the selection unguessable from the
 *   bank alone.
 */
export function selectQuestionIds(o: {
  bank: Bank
  tier: Tier
  salt: string
  dropId: string
  walletAddress: string
  count: number
  exclude?: ReadonlySet<string>
}): string[] {
  const exclude = o.exclude ?? new Set<string>()
  const pool = questionsForTier(o.bank, o.tier).filter((q) => !exclude.has(q.id))
  if (pool.length === 0) throw new SelectionError(`no questions in tier ${o.tier}`)

  const byCategory = new Map<string, Question[]>()
  for (const q of pool) {
    const list = byCategory.get(q.category)
    if (list) list.push(q)
    else byCategory.set(q.category, [q])
  }

  const categories = [...byCategory.keys()].sort()
  if (categories.length < o.count) {
    // Reached by exhaustion as well as by a thin bank, and the two need different
    // answers from an operator — one is "add questions", the other is "this wallet
    // has played everything". The count of what is left says which.
    throw new SelectionError(
      `tier ${o.tier} has ${categories.length} categories left after excluding ` +
        `${exclude.size} already-seen questions, need ${o.count} distinct`,
    )
  }

  // The bank version stays in the seed so a re-import reshuffles, and the wallet
  // stays in it so two players sitting together do not get the same five.
  const seed = `${o.dropId} ${o.walletAddress} ${o.bank.version} ${o.tier} ${exclude.size}`

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
