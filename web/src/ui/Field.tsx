import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The field: the surface every NimDrops screen is composed on.
 *
 * A NimDrop is a live surface — while you are reading it, other people are
 * taking shares out of it — and the field is where that liveness lives. It is a
 * backdrop with a job, not decoration: the drift says the drop is still moving,
 * the hotter cast says you claimed, and the quiet tone says nothing here is
 * going to be opened.
 *
 * The field is one vermilion bloom over warm near-black, plus a static
 * counter-light that stops the bloom being a circle on a rectangle.
 *
 * ## What this component does NOT decide
 *
 * The composition on top of it. The field owns the light, the scrim, the grain,
 * the safe-area inset and the masthead, and then hands the rest of the screen
 * to `children` as a full-height flex column. The claim surface splits that
 * column into an open upper field and a sheet that rises over it (the s4
 * "Stack" system, `docs/design/samples/README.md`); the sealed gate uses the
 * same column for one envelope. There is no `variant` prop and there will not
 * be one — the two screens are two children, not two configurations.
 *
 * `.nd-field-inner` carries NO horizontal padding, which is what lets the sheet
 * go edge to edge on a phone. Every child pads itself.
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
 *     blurred, and it is `GlassSheet`. The sealed gate has no sheet at all, so
 *     the first screen a claimant sees costs no blur whatsoever.
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
   * learn what this is before being asked to sign — and on the sealed gate it
   * is the only thing that names the product at all.
   */
  brand?: boolean
  children: ReactNode
}

export default function Field({ tone = 'live', brand = true, children }: FieldProps) {
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
        {children}
      </div>
    </div>
  )
}
