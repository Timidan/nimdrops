import type { ReactNode } from 'react'

/**
 * The deep blue field every NimDrops screen sits on (design §4.4).
 *
 * Its only job is the part a phone gets wrong: `env(safe-area-inset-*)` so the
 * paper never runs under a notch or a home indicator, and a 430px column so the
 * same markup is honest at 320px and at tablet width.
 */
export default function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="nd-field">
      <div className="nd-column">{children}</div>
    </div>
  )
}
