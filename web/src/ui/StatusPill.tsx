import type { ClaimUiState } from '../state/claim'
import { ClockExpiryIcon, InfoIcon, SuccessCheckIcon, WarningIcon } from './icons'
import type { IconComponent } from './icons'

/**
 * The one-word answer to "where is my claim right now".
 *
 * It is deliberately dull. The state it reports is a money fact, and the two
 * words that must never appear casually are "Paid" (only after backend
 * finality) and anything implying chance. `sending` and `manual_review` reach
 * this component already folded into `confirming` by `useClaim`, so there is no
 * label here that could imply a payout landed before it did.
 *
 * Colour is never the only carrier. Every pill has a word, and every pill has
 * a mark: a clock while something is in flight, a tick once it is final, a
 * warning triangle on the states that need attention, and an information dot
 * on the ones that are simply waiting. Assume the tones are indistinguishable.
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
  rejected: 'Not claimed',
  exhausted: 'All claimed',
  expired: 'Ended',
  degraded: 'Network trouble',
  paused: 'Paused',
}

/** Gold = something is happening; solid = a settled fact; quiet = a dead end. */
type Tone = 'live' | 'settled' | 'quiet'

const TONES: Record<ClaimUiState, Tone> = {
  loading: 'quiet',
  // Quiet, not gold: nothing is happening yet. It is also not a dead end, so
  // the copy under it — not the pill — carries the "this can still go live".
  'awaiting-funding': 'quiet',
  'no-wallet': 'quiet',
  ready: 'live',
  signing: 'live',
  reserved: 'live',
  confirming: 'live',
  paid: 'settled',
  rejected: 'quiet',
  exhausted: 'quiet',
  expired: 'quiet',
  degraded: 'quiet',
  paused: 'quiet',
}

const MARKS: Record<ClaimUiState, IconComponent> = {
  loading: InfoIcon,
  'awaiting-funding': InfoIcon,
  'no-wallet': InfoIcon,
  ready: SuccessCheckIcon,
  signing: ClockExpiryIcon,
  reserved: ClockExpiryIcon,
  confirming: ClockExpiryIcon,
  paid: SuccessCheckIcon,
  rejected: WarningIcon,
  exhausted: InfoIcon,
  expired: ClockExpiryIcon,
  degraded: WarningIcon,
  paused: WarningIcon,
}

export interface StatusPillProps {
  state: ClaimUiState
}

export default function StatusPill({ state }: StatusPillProps) {
  const Mark = MARKS[state]
  return (
    <span data-testid="status-pill" className="nd-pill" data-tone={TONES[state]}>
      <Mark size={13} />
      {LABELS[state]}
    </span>
  )
}
