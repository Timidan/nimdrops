/**
 * The one thing the sponsor cannot afford to lose: the drop they already paid
 * for.
 *
 * The share link is only ever shown for a funded drop, so the link now depends
 * on this screen surviving a reload, a return trip from Nimiq Pay, and the app
 * being closed and reopened. `localStorage` — the same store, and the same
 * guarded shape, `state/claim.ts` uses for a claim in flight.
 *
 * **Written only once a transaction hash exists.** Before the wallet reports
 * one there is nothing to recover: no money has provably moved, and a record
 * written earlier would let a returning sponsor be shown "detecting your
 * transaction" for a transaction that was never signed. The draft itself is
 * cheap to re-make — `POST /api/drops` is idempotent per attempt — so the
 * honest recovery boundary is the hash, not the draft.
 *
 * Nothing secret lives here. A `publicId`, a share URL and a funding memo are
 * all public by construction; the hash is on a public chain.
 */
import type { Draft } from '../api'
import { MAX_EXPIRY_HOURS } from '../money'

/** One in-flight or live drop per browser. A sponsor funds one at a time. */
export const FUNDING_STORAGE_KEY = 'nimdrops.funding'

/**
 * How long a record is worth acting on.
 *
 * It used to be 48 hours, on the reasoning that a drop expires 24 hours after
 * it goes live. The claim window is the sponsor's choice now and can be as long
 * as 14 days (`MAX_EXPIRY_HOURS`), which made 48 hours a bug rather than a
 * margin: a sponsor who funded a week-long drop and closed the app would come
 * back on day three to find the record gone, and the share link with it —
 * this browser holds the only copy, because the link is withheld until `live`.
 *
 * So it is the longest possible window plus a day for the slowest funding. A
 * forgotten record still falls off on its own, just after the last drop it
 * could possibly point at has closed.
 */
export const FUNDING_TTL_MS = (MAX_EXPIRY_HOURS + 24) * 60 * 60 * 1000

export interface FundedDraft {
  draft: Draft
  /** Exactly what the wallet handed back, verified or not. */
  txHash: string
  /** `Date.now()` at the moment the wallet answered. */
  savedAt: number
}

function isDraft(value: unknown): value is Draft {
  const d = value as Partial<Draft> | null
  return (
    typeof d?.publicId === 'string' &&
    typeof d.fundingAddress === 'string' &&
    typeof d.fundingMemo === 'string' &&
    typeof d.expectedFunding === 'string' &&
    typeof d.expectedFundingLuna === 'string' &&
    typeof d.shareUrl === 'string'
  )
}

/**
 * The funded drop this browser is responsible for, or `null`.
 *
 * A record that is malformed, hand-edited or past its TTL reads as "no drop
 * here" rather than as an error: there is nothing the sponsor did wrong and
 * nothing they can fix, and the create form is the useful answer either way.
 */
export function readFunding(): FundedDraft | null {
  try {
    const raw = localStorage.getItem(FUNDING_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FundedDraft>
    if (!isDraft(parsed?.draft)) return null
    if (typeof parsed.txHash !== 'string' || parsed.txHash === '') return null
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null
    if (Date.now() - parsed.savedAt > FUNDING_TTL_MS) {
      clearFunding()
      return null
    }
    return { draft: parsed.draft, txHash: parsed.txHash, savedAt: parsed.savedAt }
  } catch {
    // Private mode, quota, or a value someone edited by hand.
    return null
  }
}

export function writeFunding(record: FundedDraft): void {
  try {
    localStorage.setItem(FUNDING_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Storage denial costs recovery after a reload, not the funding in flight.
  }
}

export function clearFunding(): void {
  try {
    localStorage.removeItem(FUNDING_STORAGE_KEY)
  } catch {
    /* nothing to undo */
  }
}
