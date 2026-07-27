import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The field: the surface every NimDrops screen is composed on.
 *
 * Direction C's thesis in one component. A NimDrop is a live surface — while
 * you are reading it, other people are taking shares out of it — and the field
 * is where that liveness lives. It is a backdrop with a job, not decoration:
 * the drift says the drop is still moving, the hotter cast says you claimed,
 * and the quiet tone says nothing here is going to be opened.
 *
 * The field is one vermilion bloom over warm near-black, plus a static
 * counter-light that stops the bloom being a circle on a rectangle. It was
 * three drifting lights; consolidating to one moving layer is where the frame
 * budget below comes from.
 *
 * Composition, not configuration. The claim screen, the create flow, the
 * landing page and the trivia session all put a `GlassSheet` in `children` and
 * their own facts in the two poster slots. There is no `variant` prop and there
 * will not be one.
 *
 * ## Layout contract
 *
 * On a phone this is one column: wordmark, sheet, `topRight`, `bottomLeft`. At
 * 54rem of the field's OWN width — a container query, so a 390px preview frame
 * inside a wide page still renders the phone composition — the same four
 * elements become a poster: field full bleed, sheet centred at its true size,
 * `topRight` in the top right, `bottomLeft` in the bottom left.
 *
 * Each slot is rendered exactly ONCE and moved by the container query. There is
 * no desktop copy and no mobile copy, so nothing can appear twice, fall out of
 * sync, or be announced twice by a screen reader.
 *
 * ## Performance contract
 *
 * The field is the moving half of the `backdrop-filter` risk, so it owns three
 * of the four mitigations:
 *
 *   - exactly ONE layer moves, and it moves on `transform` only, so nothing is
 *     re-rasterised per frame (`index.css`, `.nd-field-light.is-bloom`). The
 *     card's blurred region re-reads its backdrop once per moving layer, so
 *     this is the number that sets the frame cost — not the size of the
 *     gradient and not the blur radius;
 *   - the drift pauses when the document is hidden or the field is off screen,
 *     via `data-awake`;
 *   - it does not blur anything. Exactly one element in the tree is ever
 *     blurred, and it is `GlassSheet`, which is bounded.
 *
 * The fourth lives in `ui/surface.ts`, which flips `data-nd-motion` on the
 * document element for devices that should not pay for any of this.
 */
export interface FieldProps {
  /**
   * `live` while something can still happen. `warm` after a claim: the bloom
   * comes up and stays up, so the screen remembers. `quiet` for the dead
   * ends — ended, all claimed, paused — where the bloom falls back to a
   * quarter strength and the field stops promising anything.
   */
  tone?: 'live' | 'warm' | 'quiet'
  /**
   * The product's own mark, top left. On by default because a stranger has to
   * learn what this is before being asked to sign.
   */
  brand?: boolean
  /** The drop's live state. Under the sheet on a phone, top right on a poster. */
  topRight?: ReactNode
  /** The uncomfortable fact. Under that on a phone, bottom left on a poster. */
  bottomLeft?: ReactNode
  children: ReactNode
}

export default function Field({
  tone = 'live',
  brand = true,
  topRight,
  bottomLeft,
  children,
}: FieldProps) {
  const root = useRef<HTMLDivElement>(null)

  /**
   * Awake means "worth compositing". A hidden document or a field scrolled out
   * of the viewport is pure cost, and pausing a compositor animation stops the
   * sheet's blurred region being recomputed at all.
   *
   * `IntersectionObserver` is absent from jsdom and from some WebViews; the
   * fallback is simply to stay awake, which is today's behaviour.
   */
  useEffect(() => {
    const el = root.current
    if (!el) return

    let onScreen = true
    const settle = () => {
      el.dataset.awake = onScreen && !document.hidden ? 'true' : 'false'
    }

    document.addEventListener('visibilitychange', settle)

    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1]
          if (last) onScreen = last.isIntersecting
          settle()
        },
        { threshold: 0 },
      )
      observer.observe(el)
    }

    settle()
    return () => {
      document.removeEventListener('visibilitychange', settle)
      observer?.disconnect()
    }
  }, [])

  return (
    <div ref={root} className="nd-field" data-tone={tone} data-awake="true">
      <span className="nd-field-light is-bloom" aria-hidden="true" />
      <span className="nd-field-light is-counter" aria-hidden="true" />
      <span className="nd-field-scrim" aria-hidden="true" />
      <span className="nd-field-texture" aria-hidden="true" />

      <div className="nd-field-inner">
        {brand ? (
          <p className="nd-mast">
            <b>NimDrops</b>
            <span>One link, a fixed share each</span>
          </p>
        ) : null}

        {/**
         * `topRight` sits INSIDE the stage on a phone, so the sheet and the
         * drop's live facts centre as one group rather than the facts drifting
         * to the bottom of the screen away from the thing they describe. On the
         * poster the container query lifts it out with `position: absolute`,
         * which resolves against `.nd-field-inner`, so the same node lands top
         * right without a second copy.
         */}
        <div className="nd-stage">
          {children}
          {topRight ? <div className="nd-poster-tr">{topRight}</div> : null}
        </div>

        {bottomLeft ? <div className="nd-poster-bl">{bottomLeft}</div> : null}
      </div>
    </div>
  )
}

/**
 * The one ring, once.
 *
 * Mounted by the surface that owns the moment, unmounted when it has spent
 * itself, and hidden entirely under reduced motion. It is `aria-hidden` and
 * carries no information that is not also stated in words, which is what makes
 * removing it a free choice rather than a loss.
 *
 * `RIPPLE_MS` must cover the whole animation or the ring is cut off mid-fade;
 * `surface.test.ts` checks it against the stylesheet's own duration.
 */
export const RIPPLE_MS = 1000

export function Ripple() {
  return <span data-testid="ripple" className="nd-ripple" aria-hidden="true" />
}
