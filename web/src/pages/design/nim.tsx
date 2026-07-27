import { useId } from 'react'
import { CAP, SIGNET_PATH, SIGNET_RATIO } from './nimkit'

/**
 * DEV-ONLY. The three things drawn with Nimiq's own signet: the mark itself,
 * the amount lockup, and the row of share pips.
 *
 * The provenance of the outline, the official gradient stops and the optical
 * rule the lockup is built on all live in `nimkit.ts` beside the constants they
 * describe. This file is only the components.
 */

export interface NimMarkProps {
  /**
   * `gold` is the official radial gradient, for the mark standing alone as the
   * unit. `ink` takes `currentColor`, for the mark inside a control whose text
   * colour it must match. `hollow` is the outline, used only by the share pips
   * where filled and empty have to be told apart without relying on hue.
   */
  tone?: 'gold' | 'ink' | 'hollow'
  /** CSS length. Defaults to `1em`, i.e. the caller sets it in `font-size`. */
  height?: string
  className?: string
  style?: React.CSSProperties
}

export function NimMark({ tone = 'gold', height = '1em', className, style }: NimMarkProps) {
  const gradientId = useId()
  return (
    <svg
      viewBox="0 0 72 64"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        height,
        width: `calc(${height} * ${SIGNET_RATIO})`,
        display: 'inline-block',
        verticalAlign: 'baseline',
        flex: '0 0 auto',
        ...style,
      }}
    >
      {tone === 'gold' ? (
        <defs>
          {/* Official stops and official geometry, in user space, from the
              brand file. Not an approximation and not a linear-gradient. */}
          <radialGradient
            id={gradientId}
            cx="54.17"
            cy="63.17"
            r="72.02"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#ec991c" />
            <stop offset="1" stopColor="#e9b213" />
          </radialGradient>
        </defs>
      ) : null}
      <path
        d={SIGNET_PATH}
        fill={tone === 'gold' ? `url(#${gradientId})` : tone === 'ink' ? 'currentColor' : 'none'}
        {...(tone === 'hollow'
          ? { stroke: 'currentColor', strokeWidth: 7, strokeLinejoin: 'round' }
          : {})}
      />
    </svg>
  )
}

export interface AmountProps {
  /** The figure, already formatted. Never abbreviated, never rounded. */
  value: string
  /**
   * `lockup` prints the mark and the letters `NIM` together, which is the
   * unambiguous form: a stranger who has never seen the signet still reads the
   * unit. `mark` prints the signet alone, which is the committed form, and
   * moves the word into the caption below.
   */
  unit?: 'lockup' | 'mark'
  /**
   * The mark's height as a fraction of the figure's CAP HEIGHT. `1` makes the
   * signet exactly as tall as the digit, which is right when it is standing in
   * for the word. `0.62` is the lockup value: unmistakably the Nimiq mark, and
   * still subordinate to the number, which is the thing being decided about.
   */
  markScale?: number
  /** Class on the `<h1>`; each treatment sizes and colours its own. */
  className?: string
}

/**
 * The money.
 *
 * ## The lockup's geometry
 *
 * Three inline pieces on one baseline: the figure, the mark, the word. The mark
 * is NOT sized off the word, which was the first attempt and produced a 13px
 * dot beside a 61px numeral; it is sized off the figure's cap height and its
 * optical centre is placed on the figure's cap-height MIDLINE. Both numbers
 * come from `CAP`, so the pair cannot drift apart when the type scale changes:
 *
 *   mark height  = CAP x markScale x 1em
 *   lift         = CAP/2 x (markScale - 1) x 1em
 *
 * The lift is negative for any `markScale` under 1, which is what raises the
 * mark off the baseline and onto the middle of the digit. At `markScale: 1` the
 * lift is zero and the mark sits on the baseline at full cap height, which is
 * exactly where a capital letter sits, which is the point.
 *
 * ## Accessibility
 *
 * `aria-label` carries `5 NIM` in words in both forms, so the mark-only version
 * is not a screen-reader regression. The spans are `aria-hidden` because the
 * label already replaced them; announcing both reads the amount twice.
 *
 * The figure never wraps and never truncates. If the lockup cannot fit, the
 * `flex-wrap` in each treatment's CSS drops the unit onto its own line.
 */
export function Amount({ value, unit = 'lockup', markScale = 0.62, className }: AmountProps) {
  const height = `${CAP * markScale}em`
  const lift = `${((CAP / 2) * (markScale - 1)).toFixed(4)}em`
  return (
    <h1 className={className} aria-label={`${value} NIM`} data-testid="amount-hero">
      <span className="nim-figure" aria-hidden="true">
        {value}
      </span>
      <NimMark
        height={height}
        className="nim-mark"
        style={{ transform: `translateY(${lift})` }}
      />
      {unit === 'lockup' ? (
        <span className="nim-word" aria-hidden="true">
          NIM
        </span>
      ) : null}
    </h1>
  )
}

export interface PipsProps {
  total: number
  /** How many are still available. The rest render hollow. */
  left: number
  /** px. 13 is the size these were checked at. */
  size?: number
}

/**
 * The share count as a row of signets: one mark per share, filled while it is
 * still there.
 *
 * Filled and empty differ by fill AND by stroke, never by hue alone, so the row
 * survives on a monochrome display and for a reader who cannot separate gold
 * from grey. The exact figure is always printed beside it in words, because a
 * row of marks is a texture and not a number.
 *
 * Caps at twelve. A hundred-share drop is a legitimate configuration and a
 * hundred marks is a smear.
 */
export function Pips({ total, left, size = 13 }: PipsProps) {
  if (total > 12) return null
  return (
    <span className="nim-pips" aria-hidden="true">
      {Array.from({ length: total }).map((_, i) => (
        <NimMark
          key={i}
          tone={i < left ? 'gold' : 'hollow'}
          height={`${size}px`}
          className={i < left ? 'nim-pip is-live' : 'nim-pip is-spent'}
        />
      ))}
    </span>
  )
}


