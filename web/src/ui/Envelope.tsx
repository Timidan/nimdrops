import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * The signature surface (design §4.4): "a sealed paper envelope, passed around
 * one real group".
 *
 * Three decisions are worth defending.
 *
 * **The envelope is the screen, not a card on it.** The paper column runs
 * edge to edge; the deep blue field shows only as the safe-area frame and as
 * the headroom above the flap. There is no white rounded box in the middle of
 * a coloured page, because a physical object handed to you does not sit inside
 * a container.
 *
 * **Opened is a state, not a keyframe.** The flap angle, the split wax and the
 * lifted face are declarations under `[data-envelope-open='true']`, reached by
 * CSS transition. That is what makes `prefers-reduced-motion` correct for free:
 * with durations crushed to nothing the opened envelope simply *is*, fully
 * legible, instead of an animation being skipped and leaving nothing behind.
 *
 * **The amount is never hidden.** Design §4.3's honesty rule: someone deciding
 * whether to open a wallet has to see what they are being offered. Concealing
 * the number until after the claim would reintroduce exactly the lottery
 * framing this product removed.
 */
export interface EnvelopeProps {
  /** Reserved, confirming, paid: the seal is broken and the flap stands open. */
  open: boolean
  /**
   * `quiet` greys the wax for the dead ends — ended, all claimed, paused.
   * Nothing there is going to be opened, and the wax should not promise it.
   */
  tone?: 'live' | 'quiet'
  /** One character pressed into the wax: the sponsor's initial. */
  sealMark?: string
  children: ReactNode
}

/**
 * How long the gold bloom is mounted: `nd-bloom`'s 260ms delay plus its 900ms
 * duration, with a frame to spare. Unmounting before the animation has spent
 * itself would cut the warmth off mid-fade.
 */
const BLOOM_MS = 1200

export default function Envelope({ open, tone = 'live', sealMark, children }: EnvelopeProps) {
  /**
   * A reveal is a seal coming apart, and it happens once. Landing straight on
   * an opened envelope — a reload that resumes a claim already in flight — has
   * no seal to break, so it gets the opened state with no theatre.
   */
  const mountedOpen = useRef(open)
  const revealed = useRef(false)
  const [bloom, setBloom] = useState(false)

  useEffect(() => {
    if (!open || revealed.current || mountedOpen.current) return
    revealed.current = true
    setBloom(true)
    const timer = setTimeout(() => setBloom(false), BLOOM_MS)
    return () => clearTimeout(timer)
  }, [open])

  return (
    <div
      data-testid="envelope"
      data-envelope-open={open ? 'true' : 'false'}
      data-envelope-tone={tone}
      className="nd-envelope"
    >
      <div className="nd-flap" aria-hidden="true">
        <div className="nd-flap-face" />
      </div>
      <div className="nd-seal">
        <Wax mark={sealMark} />
      </div>
      <div className="nd-face nd-face--sealed">
        <span className="nd-liner" aria-hidden="true" />
        {bloom ? <span data-testid="seal-bloom" className="nd-bloom" aria-hidden="true" /> : null}
        {children}
      </div>
    </div>
  )
}

export interface WaxProps {
  /** The sponsor's initial, or nothing for a blank press. */
  mark?: string
  /** CSS length; defaults to the envelope's own 3.5rem disc. */
  size?: string
}

/** A disc of gold wax. Pure CSS — no image, no icon font, no dependency. */
export function Wax({ mark, size }: WaxProps) {
  const style = size ? ({ '--nd-wax-size': size } as CSSProperties) : undefined
  return (
    <span className="nd-wax" style={style} aria-hidden="true">
      <span className="nd-wax-half is-left" />
      <span className="nd-wax-half is-right" />
      {mark ? <span className="nd-wax-mark">{mark}</span> : null}
    </span>
  )
}

export interface EnvelopeAmountProps {
  /** Decimal NIM, exactly as the server said it. */
  amount: string
  /** Adds the one gold keyline in the product. Only ever true after `paid`. */
  paid?: boolean
}

/**
 * The denomination printed on the face.
 *
 * The size steps down by character count rather than by media query, because
 * what overflows a 320px phone is `10000.00000`, not a narrow screen. Eleven
 * tabular characters at 34px are ~210px wide, which clears the 280px a 320px
 * screen leaves inside the gutters — with `nowrap` guaranteeing a number never
 * breaks across two lines.
 */
export function EnvelopeAmount({ amount, paid }: EnvelopeAmountProps) {
  const size =
    amount.length <= 6
      ? 'text-[3.5rem]'
      : amount.length <= 9
        ? 'text-[2.75rem]'
        : 'text-[2.125rem]'

  return (
    <div className="mt-6 text-center">
      <h1
        data-testid="amount-hero"
        aria-label={`${amount} NIM`}
        className={`nd-amount text-ink ${size}`}
      >
        {amount}
        <span className="ml-2 text-[0.34em] font-semibold tracking-[0.16em] text-ink/45">NIM</span>
      </h1>
      {paid ? <div data-testid="paid-keyline" className="nd-keyline" /> : null}
    </div>
  )
}
