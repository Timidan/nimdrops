import type { ClaimUiState } from '../state/claim'

/**
 * The one-word answer to "where is my claim right now".
 *
 * It is deliberately dull. The state it reports is a money fact, and the two
 * words that must never appear casually are "Paid" (only after backend
 * finality) and anything implying chance. `sending` and `manual_review` reach
 * this component already folded into `confirming` by `useClaim`, so there is no
 * label here that could imply a payout landed before it did.
 */
const LABELS: Record<ClaimUiState, string> = {
  loading: 'Opening',
  'awaiting-funding': 'Not funded yet',
  'no-wallet': 'Wallet needed',
  ready: 'Live',
  signing: 'Waiting for your wallet',
  reserved: 'Reserved',
  confirming: 'Confirming',
  paid: 'Paid',
  rejected: 'Not approved',
  exhausted: 'All claimed',
  expired: 'Ended',
  degraded: 'Network trouble',
  paused: 'Paused',
}

/** Gold = something is happening; ink = a settled fact; muted = a dead end. */
const TONES: Record<ClaimUiState, string> = {
  loading: 'bg-ink/8 text-ink/55',
  // Muted, not gold: nothing is happening yet. It is also not a dead end, so
  // the copy under it — not the pill — carries the "this can still go live".
  'awaiting-funding': 'bg-ink/8 text-ink/55',
  'no-wallet': 'bg-ink/8 text-ink/55',
  ready: 'bg-gold/18 text-gold-deep',
  signing: 'bg-gold/18 text-gold-deep',
  reserved: 'bg-gold/18 text-gold-deep',
  confirming: 'bg-gold/18 text-gold-deep',
  paid: 'bg-ink text-paper',
  rejected: 'bg-ink/8 text-ink/55',
  exhausted: 'bg-ink/8 text-ink/55',
  expired: 'bg-ink/8 text-ink/55',
  degraded: 'bg-ink/8 text-ink/55',
  paused: 'bg-ink/8 text-ink/55',
}

export interface StatusPillProps {
  state: ClaimUiState
}

export default function StatusPill({ state }: StatusPillProps) {
  return (
    <span
      data-testid="status-pill"
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide ${TONES[state]}`}
    >
      {LABELS[state]}
    </span>
  )
}
