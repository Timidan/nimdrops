import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * A bottom sheet: the modal both sides of the link read a disclosure in.
 *
 * It is a real modal dialog — labelled, escapable, focus moved into it on open,
 * page scroll locked while it is up. The slide-in is CSS only and is disabled
 * by `prefers-reduced-motion` in `index.css` (design §4.4), so the sheet is
 * fully usable with animation off.
 *
 * It is a SOLID panel rather than a second pane of glass: nothing translucent
 * stacks on the sheet, and a modal that blurred what is behind it would be the
 * second blurred region on the screen, which is the thing the WebView budget
 * cannot afford.
 *
 * It used to press a disc of gold wax with the sponsor's initial above the
 * title of the review sheet, on the argument that this was the moment the
 * sponsor sealed an envelope the claimant would open. The claim surface's
 * packet carries the Nimiq signet and never an initial, so the two seals were
 * never the same object; the wax went with the create flow's redesign.
 */
export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  /**
   * Kept as a named surface rather than assumed, because a sheet opening over
   * something other than the field would need its own contrast pass.
   */
  surface?: 'field'
  children: ReactNode
}

export default function Sheet({ open, title, onClose, surface = 'field', children }: SheetProps) {
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
        <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded-full bg-plate/25" />
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
