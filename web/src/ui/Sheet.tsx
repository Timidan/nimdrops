import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * A bottom sheet: the review surface of the create flow.
 *
 * It is a real modal dialog — labelled, escapable, focus moved into it on open,
 * page scroll locked while it is up. The slide-in is CSS only and is disabled
 * by `prefers-reduced-motion` in `index.css` (design §4.4), so the sheet is
 * fully usable with animation off.
 */
export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

export default function Sheet({ open, title, onClose, children }: SheetProps) {
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
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Scrim. A click here is a dismissal, same as Escape. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="nd-sheet relative w-full max-w-[430px] rounded-t-3xl bg-paper px-6 pt-5 pb-8 text-ink shadow-2xl outline-none"
      >
        <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink/15" />
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
