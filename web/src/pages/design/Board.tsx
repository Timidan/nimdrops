import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * DEV-ONLY. The chrome the three design directions are shown in.
 *
 * Mounted from `App.tsx` behind `import.meta.env.DEV`, which Vite substitutes
 * with the literal `false` in a production build, so the branch and this whole
 * module tree are dead code the bundler drops — the same guard `/preview` lives
 * under, verified the same way. `DESIGN_SENTINEL` is the string to grep
 * `web/dist` for; it must not be there.
 *
 * Every direction writes its own CSS into a `<style>` element it owns, scoped
 * under its own class prefix. Nothing here touches `index.css`, and the
 * directions deliberately use almost no Tailwind utilities: a utility written
 * in one of these files would be emitted into the PRODUCTION stylesheet by
 * Tailwind's source scan even though the component itself is tree-shaken away.
 * Dead JavaScript is free; dead CSS is not.
 */
export const DESIGN_SENTINEL = 'nd-design-only-surface'

/** The widths the board reports on, and the width the claim screen is judged at. */
export const PHONE = 390

export interface BoardProps {
  /** `A`, `B`, `C`. */
  letter: string
  /** The direction's name. */
  name: string
  /** One line: the bet this direction is making. */
  thesis: string
  children: ReactNode
}

/**
 * The board's own gutter, in px, and never more than the viewport can spare.
 *
 * The same measurement `Preview.tsx` makes, for the same reason: a 390px cell
 * in a 390px viewport has no room for a gutter, and a hardcoded one makes the
 * board scroll sideways while every surface inside it is behaving. It reads
 * `documentElement.clientWidth` rather than `100vw` because that is the only
 * one of the two that already excludes a classic scrollbar.
 */
function useGutter(cellWidth: number): number {
  const [gutter, setGutter] = useState(0)
  useEffect(() => {
    const measure = () =>
      setGutter(
        Math.max(0, Math.min(16, Math.floor((document.documentElement.clientWidth - cellWidth) / 2))),
      )
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [cellWidth])
  return gutter
}

export default function Board({ letter, name, thesis, children }: BoardProps) {
  const gutter = useGutter(PHONE)
  return (
    <div className={DESIGN_SENTINEL} style={{ '--db-gutter': `${gutter}px` } as CSSProperties}>
      <style>{boardCss()}</style>
      <header className="db-bar">
        <span className="db-letter">{letter}</span>
        <div className="db-titles">
          <h1>{name}</h1>
          <p>{thesis}</p>
        </div>
        <nav className="db-nav">
          <a href="/design/a">A</a>
          <a href="/design/b">B</a>
          <a href="/design/c">C</a>
          <a href="/preview">states</a>
        </nav>
      </header>
      <main className="db-main">{children}</main>
    </div>
  )
}

export interface PanelProps {
  label: string
  /** What this panel is here to answer. */
  note?: string
  /**
   * `phone` pins the surface to 390px whatever the viewport is. `wide` lets it
   * fill the board, so a surface with a container query in it renders its
   * desktop composition. `bleed` is `wide` with no frame — for the landing.
   */
  mode?: 'phone' | 'wide' | 'bleed'
  /** Frame height. Surfaces scroll inside their own frame, not the page. */
  height?: number
  children: ReactNode
}

export function Panel({ label, note, mode = 'phone', height = 780, children }: PanelProps) {
  return (
    <section className={`db-panel db-panel--${mode}`}>
      <p className="db-cap">
        <b>{label}</b>
        {note ? <span> · {note}</span> : null}
      </p>
      <div
        className="db-frame"
        style={mode === 'phone' ? { width: PHONE, height } : { height }}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * Two panels that must be read against each other: the same surface at phone
 * width and at board width. On a narrow viewport they stack, and the wide one
 * is honestly narrow — which is the point, because the surface should still be
 * right there.
 */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="db-pair">{children}</div>
}

function boardCss() {
  return `
.${DESIGN_SENTINEL} {
  min-height: 100dvh;
  background: #0c0e1f;
  color: #e7e4dc;
  font: 13px/1.45 system-ui, sans-serif;
}
.${DESIGN_SENTINEL} * { box-sizing: border-box; }
.${DESIGN_SENTINEL} .db-bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  padding: 12px var(--db-gutter, 16px);
  background: #0c0e1f;
  border-bottom: 1px solid #262b52;
}
.${DESIGN_SENTINEL} .db-letter {
  display: grid; place-items: center;
  width: 30px; height: 30px; flex: 0 0 auto;
  border-radius: 8px;
  background: #e9b213; color: #1f2348;
  font-weight: 700; font-size: 15px;
}
.${DESIGN_SENTINEL} .db-titles { min-width: 0; }
.${DESIGN_SENTINEL} .db-titles h1 { margin: 0; font-size: 14px; font-weight: 650; }
.${DESIGN_SENTINEL} .db-titles p { margin: 2px 0 0; color: #9aa0cc; }
.${DESIGN_SENTINEL} .db-nav { display: flex; gap: 6px; margin-left: auto; }
.${DESIGN_SENTINEL} .db-nav a {
  padding: 5px 10px; border-radius: 7px;
  border: 1px solid #343a70; color: #c9c6e6; text-decoration: none;
}
.${DESIGN_SENTINEL} .db-main {
  display: flex; flex-direction: column; gap: 28px;
  padding: 20px var(--db-gutter, 16px) 64px;
}
.${DESIGN_SENTINEL} .db-cap { margin: 0 0 7px; overflow-wrap: anywhere; }
.${DESIGN_SENTINEL} .db-cap b { font-weight: 650; }
.${DESIGN_SENTINEL} .db-cap span { color: #9aa0cc; }
.${DESIGN_SENTINEL} .db-frame {
  max-width: 100%;
  overflow: auto;
  border-radius: 12px;
  outline: 1px solid #262b52;
}
.${DESIGN_SENTINEL} .db-panel--bleed .db-frame { outline: none; border-radius: 0; }
.${DESIGN_SENTINEL} .db-pair {
  display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;
}
.${DESIGN_SENTINEL} .db-panel--phone { width: ${PHONE}px; max-width: 100%; }
.${DESIGN_SENTINEL} .db-pair > .db-panel--phone { flex: 0 0 auto; }
.${DESIGN_SENTINEL} .db-pair > .db-panel--wide { flex: 1 1 520px; min-width: 0; }
`
}
