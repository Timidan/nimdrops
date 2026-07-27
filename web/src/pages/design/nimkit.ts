/**
 * DEV-ONLY. The real Nimiq mark, and the amount lockup built on it.
 *
 * ## Where this path came from
 *
 * It is not drawn here and it is not a generic crypto coin. It is Nimiq's own
 * signet, taken verbatim from two official sources that agree with each other:
 *
 *   - `nimiq/nimiq-style`, `src/icons/hexagon.svg` — the icon the Nimiq style
 *     framework itself ships, in a 27x24 viewBox, filled with `currentColor`;
 *   - `nimiq/designs`, `logo/RGB/colored/svg/nimiq_signet_rgb_base_size.svg` —
 *     the brand asset repository's signet, in a 72x64 viewBox, filled with the
 *     official radial gradient `#EC991C -> #E9B213`.
 *
 * The 72x64 outline is the one below, because it is the brand file rather than
 * the UI icon and it carries the gradient's own geometry (`cx 54.17 cy 63.17
 * r 72.02`, in user space, which is why the warm stop sits low and right).
 * Scaled to 27x24 the two paths are the same shape to within a rounding error.
 *
 * The signet is also what the NIM asset icon is everywhere it appears: the
 * Nimiq Wallet, Nimiq Pay, and every exchange listing. So using it next to a
 * number is not borrowing the company's logo to decorate a figure; it is the
 * currency's actual mark, in the position a currency mark goes.
 *
 * ## Why it is a hexagon and not a coin
 *
 * `PRODUCT.md` bans hexagon motifs under "crypto-dark", and that ban is about
 * hexagons used as *atmosphere*: tessellated backdrops, hexagonal frames,
 * hex-shaped avatars. One instance, at unit size, standing for the unit, is the
 * opposite of atmosphere. None of these treatments uses the shape as wallpaper.
 *
 * ## The optical rule
 *
 * A flat-topped, flat-bottomed hexagon next to lining figures needs no
 * overshoot: its extremes are flat, the way a capital H is flat, so matching
 * cap height exactly is correct. Round and pointed forms (O, S, a circle)
 * would need 1.5-2% of overshoot; this one does not.
 *
 * So the rule is: **mark height = the cap height of the text it sits beside,
 * bottom on that text's baseline.** An `inline-block` already sits on the
 * baseline, so there is no magic translate anywhere in this file, and nothing
 * to retune if the type scale changes.
 *
 * Mulish's cap height is 0.72em (720/1000 units), which is `CAP` below and the
 * one number every lockup in these samples is derived from.
 */

/** `nimiq/designs`, `nimiq_signet_rgb_base_size.svg`. Verbatim. */
export const SIGNET_PATH =
  'M71.2,29l-15-26A6,6,0,0,0,51,0H21a6,6,0,0,0-5.19,3L.8,29a6,6,0,0,0,0,6l15,26A6,6,0,0,0,21,64H51a6,6,0,0,0,5.19-3l15-26A6,6,0,0,0,71.2,29Z'

/** Mulish cap height, as a fraction of the em. Every lockup derives from this. */
export const CAP = 0.72

/** The signet's own aspect. Width is always height x this. */
export const SIGNET_RATIO = 72 / 64

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
