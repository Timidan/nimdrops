import type { CSSProperties, ReactNode } from 'react'

/**
 * LEGACY. The create flow's envelope, and nothing else.
 *
 * The claim surface no longer has an envelope. Direction C replaced it with a
 * field and one sheet of glass, and the reasoning is in
 * `docs/design/direction-options.md`: the envelope's entire payload is
 * concealment, and this product deliberately refuses to conceal — the amount is
 * printed at full size before anyone touches anything. A signature object that
 * means the opposite of what the product does had to go.
 *
 * What is left here is the *sponsor's* side. `Create.tsx` still renders a
 * sealed envelope at the moment the sponsor seals one, and `Sheet.tsx` still
 * presses the same wax onto the review panel. Both belong to the create flow,
 * which is a separate task, so this file survives exactly as long as that flow
 * does and goes with it.
 *
 * Two things are gone with the claim surface:
 *
 *   - `EnvelopeAmount`, which was the claim screen's printed denomination. Its
 *     replacement is the opaque plate in `DropView`, whose behaviour (step the
 *     type down by character count, never break a number across two lines,
 *     never truncate) is carried over intact and re-tested there.
 *   - `Envelope.test.tsx`, 346 lines. Every invariant in it that was about
 *     BEHAVIOUR rather than about the envelope's own DOM has been carried over
 *     to `ui/surface.test.ts` and `pages/DropView.test.tsx`; the ones that were
 *     about the flap, the wax and the bloom specifically went with them.
 *
 * The one behaviour still worth stating here: opened is a STATE, not a
 * keyframe. The flap angle, the split wax and the lifted face are plain
 * declarations under `[data-envelope-open='true']`, so crushing every duration
 * lands on the finished, legible opened envelope rather than skipping past it.
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

export default function Envelope({ open, tone = 'live', sealMark, children }: EnvelopeProps) {
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
