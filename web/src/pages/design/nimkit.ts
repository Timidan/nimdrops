/**
 * DEV-ONLY. What the sample boards need on top of the shipped signet.
 *
 * The mark's outline, its provenance, its cap height and the optical rule the
 * lockup is built on all moved to `ui/signet.ts` when the claim surface started
 * printing the mark for real — production may not import from a dev-only
 * directory, so the constants live there and the boards re-export them here.
 * There is one path and one cap height in the codebase.
 */
export { CAP, SIGNET_PATH, SIGNET_RATIO } from '../../ui/signet'

/**
 * Grain, as an SVG data URI, at a caller-chosen frequency.
 *
 * A large flat field of one colour bands on an 8-bit phone panel and a gradient
 * over it bands worse. This is the cheapest fix that is not a raster download:
 * one composited layer, no request, no dependency. Higher `freq` is finer.
 */
export function noise(freq = 0.8, octaves = 3): string {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${octaves}' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`
}

/**
 * The CSS every treatment shares: the type family, the lockup's geometry, the
 * pips, and the focus ring. Scoped by the caller's own prefix so two treatments
 * on one page cannot collide.
 *
 * Mulish is declared explicitly rather than through `--font-sans`, which still
 * resolves to `system-ui` in `index.css` while the foundation work lands. On at
 * least one machine this project was reviewed on, `system-ui` resolved to a
 * MONOSPACE face, and a 61px monospace amount is what half the rejected
 * screenshots actually showed. The samples must not inherit that.
 */
export function kitCss(p: string): string {
  return `
.${p}-root, .${p}-root * { box-sizing: border-box; }
.${p}-root {
  font-family: 'Mulish', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-optical-sizing: auto;
  -webkit-font-smoothing: antialiased;
}

/* --- the amount lockup ---------------------------------------------------
   Figure, mark, word, on one baseline. The mark's size and lift are computed
   in the Amount component from the figure's cap height, so nothing here
   hardcodes a nudge; these rules handle spacing and the no-wrap contract. */
.${p}-root .nim-figure {
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: 'tnum' 1, 'lnum' 1;
  white-space: nowrap;
}
/* Optical, not metric: the hexagon's left vertex is a point, so the gap before
   it can be tighter than the gap after it without the pair looking cramped. */
.${p}-root .nim-mark { margin: 0 0.17em 0 0.13em; }
.${p}-root .nim-word {
  font-size: 0.3em; font-weight: 800; letter-spacing: 0.015em;
  white-space: nowrap;
}

/* --- the share marks ------------------------------------------------------ */
.${p}-root .nim-pips { display: inline-flex; align-items: center; gap: 3.5px; }
.${p}-root .nim-pip { transition: opacity var(--${p}-t-state, 180ms) ease-out; }
.${p}-root .nim-pip.is-spent { opacity: 0.45; }

/* --- focus ---------------------------------------------------------------- */
.${p}-root :where(a, button, [tabindex]):focus-visible {
  outline: 2px solid #ffcf3d;
  outline-offset: 3px;
  border-radius: 4px;
}
`
}
