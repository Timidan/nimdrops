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
 * bounded box with slots. Its value is that it is the ONLY blurred element in
 * the tree, which is the property the WebView budget depends on.
 *
 * ## The form: a bottom sheet, not a centred card
 *
 * On a phone the sheet is anchored to the foot of the field, edge to edge, with
 * 28px top corners (`--nd-radius-sheet`); at 54rem of the FIELD's own width it becomes a right-hand
 * column of 27rem. That is the s4 "Stack" layout the owner chose. The blurred
 * region is bounded on both: bounded in height on a phone, bounded in width on
 * a poster, and never the page.
 *
 * ## The caption slot, and the contract `Trivia.tsx` builds against
 *
 * `caption` is the line directly under the header. On an ordinary drop it is
 * one sentence of context. On a gated drop it is the question, and the answers
 * go in `children` right below it as `.nd-option` buttons.
 *
 * ### RECONCILED 2026-07-27 — one structural change, everything else kept
 *
 * The s4 layout moves THE AMOUNT OUT OF THE SHEET and onto the open upper field
 * above it. The published contract said the amount sits in `header`, directly
 * above `caption`; it now sits in the field, still directly above the sheet in
 * both reading order and visual order. The guarantee the trivia gate actually
 * needs — *the amount is on screen, above the question, in every state* — is
 * unchanged and is still asserted, in `DropView.test.tsx`, against the whole
 * screen rather than against the sheet's own children.
 *
 * Everything else in the contract is kept deliberately, INCLUDING the two
 * things the s4 sample departed from. The sample laid the four options out as a
 * 2x2 grid of 84px tiles; that is not shipped, because the grid is only safe
 * while the option count is exactly four and a tier that ever needs five would
 * break it silently. Options stay one per line.
 *
 * What a trivia surface can rely on, per
 * `docs/superpowers/specs/2026-07-26-nimdrops-trivia-gate-design.md` §4.6:
 *
 *   - the amount stays visible ABOVE the caption at all times, in every state.
 *     It is now rendered by the surface into the field above the sheet, not
 *     into `header`. Hiding it behind a question would turn a fixed share into
 *     a prize for a correct answer, which is the framing this product refuses;
 *   - the caption slot takes a heading-weight question without any layout
 *     change: it is a block, it wraps, and it is not clamped. It is still the
 *     FIRST child of the sheet when `header` is empty, and directly after
 *     `header` otherwise;
 *   - answers are `<button class="nd-option" aria-pressed>`, ONE PER LINE, 48px
 *     tall with an 8px gap, already past the touch floor. Selection is carried
 *     by border, fill AND weight, so it survives colour blindness;
 *   - the sheet does not scroll internally. Five options and a deadline fit a
 *     320px screen without the money button leaving the page;
 *   - `GlassSheet` takes no trivia-specific prop, and will not. The gate is
 *     `caption` plus `children`.
 *
 * The one prop added since the contract was published is `dip`, below, and it
 * carries no content.
 */
export interface GlassSheetProps {
  /**
   * Directly under `header`. One sentence on an ordinary drop; the question on
   * a gated one.
   */
  caption?: ReactNode
  /** Everything below the caption: the answers, the action, the receipt. */
  children: ReactNode
  /** Anything the sheet wants above the caption — the sponsor line, a status. */
  header?: ReactNode
  /**
   * The surface's one choreography beat: the sheet dips 30px and returns when a
   * state resolves. It is a `data-` attribute rather than a class so it can
   * never be confused with something that reveals content — nothing inside the
   * sheet waits on it, and with animation disabled the sheet simply does not
   * move.
   */
  dip?: boolean
  /** Test hook, so a surface can name its own sheet. */
  testId?: string
}

export default function GlassSheet({ header, caption, children, dip, testId }: GlassSheetProps) {
  return (
    <section
      className="nd-glass"
      data-dip={dip ? 'true' : 'false'}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {/* The grab handle is `.nd-glass::before`, not an element, so the sheet's
          child order stays exactly what the contract above describes. */}
      {header}
      {caption ? <div className="nd-caption">{caption}</div> : null}
      {children}
    </section>
  )
}
