import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Wax } from './Envelope'

/**
 * A bottom sheet: the review surface of the create flow.
 *
 * It is a real modal dialog — labelled, escapable, focus moved into it on open,
 * page scroll locked while it is up. The slide-in is CSS only and is disabled
 * by `prefers-reduced-motion` in `index.css` (design §4.4), so the sheet is
 * fully usable with animation off.
 *
 * `sealMark` puts the same wax on it that a claimant will break. This is the
 * moment the sponsor seals the envelope, so it should look like the same
 * object from the other side.
 */
export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  /** The sponsor's initial, pressed into the wax above the title. */
  sealMark?: string
  /**
   * Which surface the sheet is opening over.
   *
   * `plate` is the create flow's paper. `field` is the claim surface's dark
   * field, and it is a SOLID panel rather than a second pane of glass: nothing
   * translucent stacks on the sheet, and a modal that blurs what is behind it
   * would be the second blurred region on the screen, which is the thing the
   * WebView budget cannot afford.
   */
  surface?: 'plate' | 'field'
  children: ReactNode
}

export default function Sheet({
  open,
  title,
  onClose,
  sealMark,
  surface = 'plate',
  children,
}: SheetProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ zIndex: 'var(--nd-z-dialog)' }}
    >
      {/* Scrim. A click here is a dismissal, same as Escape. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/55"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        /**
         * The sheet scrolls itself rather than the page. The sponsor's
         * disclosure is longer than a phone, and its fund button sits under
         * the last point on purpose — reaching the button means the points
         * have been past the eye. `overscroll-contain` keeps that scroll from
         * escaping into the page behind the scrim once it hits the end.
         */
        className={`nd-sheet nd-sheet--${surface} relative max-h-[86svh] w-full max-w-[430px] overflow-y-auto overscroll-contain rounded-t-3xl px-6 pt-5 pb-8 shadow-2xl outline-none`}
      >
        <div
          aria-hidden="true"
          className={`mx-auto mb-4 h-1 w-10 rounded-full ${surface === 'field' ? 'bg-plate/25' : 'bg-ink/15'}`}
        />
        <div className="flex items-center gap-3">
          {sealMark !== undefined ? <Wax mark={sealMark} size="2.25rem" /> : null}
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
