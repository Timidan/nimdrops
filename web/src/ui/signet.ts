/**
 * The real Nimiq mark, and the geometry the amount lockup is built on.
 *
 * Promoted out of `pages/design/nimkit.ts` when the claim surface started
 * printing the mark for real. Production may not import from a dev-only
 * directory, so the constants live here and the dev boards import them back.
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
 * Hexagon motifs are banned under "crypto-dark", and that ban is about
 * hexagons used as *atmosphere*: tessellated backdrops, hexagonal frames,
 * hex-shaped avatars. One instance, at unit size, standing for the unit, is the
 * opposite of atmosphere. The surface uses the shape once and never as
 * wallpaper.
 *
 * ## The optical rule
 *
 * A flat-topped, flat-bottomed hexagon next to lining figures needs no
 * overshoot: its extremes are flat, the way a capital H is flat, so matching
 * cap height exactly is correct. Round and pointed forms (O, S, a circle) would
 * need 1.5-2% of overshoot; this one does not.
 *
 * So the rule is: **mark height = the cap height of the text it sits beside,
 * bottom on that text's baseline.** An `inline-block` already sits on the
 * baseline, so there is no magic translate anywhere, and nothing to retune if
 * the type scale changes.
 *
 * Mulish's cap height is 0.72em (720/1000 units), which is `CAP` below and the
 * one number every lockup is derived from.
 */

/** `nimiq/designs`, `nimiq_signet_rgb_base_size.svg`. Verbatim. */
export const SIGNET_PATH =
  'M71.2,29l-15-26A6,6,0,0,0,51,0H21a6,6,0,0,0-5.19,3L.8,29a6,6,0,0,0,0,6l15,26A6,6,0,0,0,21,64H51a6,6,0,0,0,5.19-3l15-26A6,6,0,0,0,71.2,29Z'

/** Mulish cap height, as a fraction of the em. Every lockup derives from this. */
export const CAP = 0.72

/** The signet's own aspect. Width is always height x this. */
export const SIGNET_RATIO = 72 / 64
