import type { ReactNode } from 'react'

/**
 * LEGACY. The create flow's page frame.
 *
 * A deep blue page with a 430px paper column on it, absorbing
 * `env(safe-area-inset-*)` so the paper never runs under a notch or a home
 * indicator. The claim surface no longer uses it: `DropView` composes `Field`,
 * which owns the safe areas itself and is full bleed rather than a column.
 *
 * This goes with the create flow's redesign, together with `Envelope.tsx` and
 * the legacy block at the foot of `index.css`.
 */
export default function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="nd-page">
      <div className="nd-page-column">{children}</div>
    </div>
  )
}
