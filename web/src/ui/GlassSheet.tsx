import type { ReactNode } from 'react'

/**
 * The sheet: the one glass surface in the product.
 *
 * Glass is banned as decoration. It is permitted when translucency carries
 * information the opaque version cannot, and here it does one job: the field
 * behind this sheet is where the drop's liveness lives, and a sheet you can see
 * through is a sheet that does not hide the thing that is changing. That is the
 * same argument Apple makes for the controls layer sitting over a content
 * layer, and this follows the actual rules rather than the 2021 version:
 *
 *   - ONE glass sheet per view. Nothing translucent stacks on anything else.
 *   - Every control inside is a SOLID fill. The money button is never glass.
 *   - A barrier fill under the blur, so contrast is a property of the sheet and
 *     not of whatever the field happens to be doing at that instant.
 *   - `prefers-reduced-transparency` swaps the glass for a solid surface
 *     outright, and so does `ui/surface.ts` on a device that cannot pay for it.
 *   - `blur(18px) saturate(120%)`. Saturation is what stops frosted glass
 *     reading as grey plastic over a GREY backdrop; over a vermilion one it
 *     runs the backdrop out of gamut instead, so 120% is a computed ceiling,
 *     not a preference. `index.css` has the arithmetic on `--nd-saturate`.
 *
 * All of that lives in `index.css` under `.nd-glass`, because it is material
 * rather than behaviour. This component is deliberately almost nothing: a
 * bounded box with a slot. Its value is that it is the ONLY blurred element in
 * the tree, which is the property the WebView budget depends on.
 *
 * ## The caption slot, and the contract `Trivia.tsx` can build against
 *
 * `caption` is the line directly under the amount. On an ordinary drop it is
 * one sentence of context. On a gated drop it is the question, and the answers
 * go in `children` right below it as `.nd-option` buttons.
 *
 * What a trivia surface can rely on, per
 * `docs/superpowers/specs/2026-07-26-nimdrops-trivia-gate-design.md` §4.6:
 *
 *   - the amount stays visible above the caption at all times, in every state.
 *     Hiding it behind a question would turn a fixed share into a prize for a
 *     correct answer, which is the framing this product refuses;
 *   - the caption slot takes a heading-weight question without any layout
 *     change: it is a block, it wraps, and it is not clamped;
 *   - answers are `<button class="nd-option" aria-pressed>`, one per line,
 *     48px tall with an 8px gap, already past the touch floor. Selection is
 *     carried by border, fill AND weight, so it survives colour blindness;
 *   - the sheet does not scroll internally. Five options and a deadline fit a
 *     320px screen without the money button leaving the page;
 *   - `GlassSheet` takes no trivia-specific prop, and will not. The gate is
 *     `caption` plus `children`.
 */
export interface GlassSheetProps {
  /**
   * Directly under the amount. One sentence on an ordinary drop; the question
   * on a gated one.
   */
  caption?: ReactNode
  /** Everything below the caption: the answers, the action, the receipt. */
  children: ReactNode
  /** The amount and everything above it. */
  header?: ReactNode
  /** Test hook, so a surface can name its own sheet. */
  testId?: string
}

export default function GlassSheet({ header, caption, children, testId }: GlassSheetProps) {
  return (
    <section className="nd-glass" {...(testId ? { 'data-testid': testId } : {})}>
      {header}
      {caption ? <div className="nd-caption">{caption}</div> : null}
      {children}
    </section>
  )
}
