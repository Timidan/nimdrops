/**
 * The reveal's contrast, computed from the tokens, never eyeballed.
 *
 * Same machinery as `ui/surface.contrast.test.ts` — literally the same module,
 * `ui/contrast.ts` — and the same discipline: nothing here reads a rendered
 * pixel. The field is a bloom, so its brightness is a function of WHERE you
 * are on it, and a ratio measured off one screenshot is a ratio measured
 * against a coincidence.
 *
 * ## What the worst case is, and why there are three of them
 *
 * A single "brightest possible field" would be dishonest in both directions: it
 * would fail the countdown, which sits at the foot of the screen where the
 * bloom has died, and it would let the envelope off, which sits over the same
 * dark foot. So the field is derived at the three positions things actually
 * occupy:
 *
 *   BLOOM_LIVE   the bloom's own core, `#ff5a1e`. The brightest the field can
 *                be before a claim resolves.
 *   BLOOM_WARM   the same, with the post-claim warm layer at full strength.
 *                The brightest it can ever be, and the state the screen spends
 *                the rest of the session in.
 *   FOOT         the bottom band: the second, weaker light at its core with the
 *                scrim's bottom stop over it. Where the envelope, the live line
 *                and the countdown all sit.
 *
 * Blur is not modelled and does not need to be: averaging can only move a pixel
 * towards the mean, so the brightest unblurred pixel is an upper bound on the
 * brightest blurred one. The `saturate(150%)` a `backdrop-filter` applies IS
 * modelled, because it moves a colour AWAY from the mean and can therefore make
 * things worse.
 *
 * Every figure below is pessimistic, which is the correct direction to be wrong
 * in on a screen that hands out money.
 */
import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  over,
  parseColour,
  round2,
  saturate,
  type Rgb,
} from '../../ui/contrast'
import { revealCss } from './SealedReveal'
import { themeCss, T } from './theme'

const scheme = themeCss('x')
const reveal = revealCss('x')

/** A declared token's value, from whichever of the two stylesheets declares it. */
function token(name: string): string {
  const source = `${scheme}\n${reveal}`
  const value = source.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
  expect(value, `${name} should be declared`).toBeTruthy()
  return value!
}

/**
 * A token declared as `var(--outer, <literal>)`, which is how every one of the
 * envelope's own colours is written: it takes the shared scheme's value when
 * there is one and its own literal otherwise. The literal is what this
 * prototype renders, so the literal is what is measured.
 */
function fallback(name: string, depth = 0): string {
  let value = token(name)
  // `var(--a, var(--b, #literal))` unwinds to `#literal`.
  for (let i = 0; i < 8; i++) {
    const inner = value.match(/^var\(--[\w-]+,\s*(.+)\)$/)
    if (!inner) break
    value = inner[1].trim()
  }
  expect(value, `${name} should bottom out in a literal`).not.toMatch(/^var\(/)
  expect(depth).toBeLessThan(8)
  return value
}

const colour = (name: string) => parseColour(fallback(name))
const rgb = (value: string) => parseColour(value).rgb

/** Composite a token's own alpha over a background. */
function on(name: string, bg: Rgb): Rgb {
  const { rgb: fg, alpha } = colour(name)
  return over(fg, alpha, bg)
}

/** `color-mix(in srgb, a X%, b)` — a straight interpolation of sRGB values. */
function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return a.map((c, i) => c * weight + b[i] * (1 - weight)) as Rgb
}

// ---- the three fields, derived ---------------------------------------------

/** The bloom's core, before a claim. */
const BLOOM_LIVE: Rgb = rgb(T.bloomCore)

/** The same, with the post-claim warm layer over it at full opacity. */
const BLOOM_WARM: Rgb = (() => {
  const layer = scheme.match(/rgb\(255 122 40 \/ ([\d.]+)\)/)
  expect(layer, 'the warm layer should still be declared').toBeTruthy()
  return over([255, 122, 40], Number(layer![1]), BLOOM_LIVE)
})()

/** The foot of the screen: the weaker light's core, under the scrim's bottom. */
const FOOT: Rgb = (() => {
  const weak = over([255, 77, 20], 0.34, rgb(T.base))
  const bottom = scheme.match(/rgb\(8 5 4 \/ ([\d.]+)\) 100%/)
  expect(bottom, 'the scrim should still weight the foot').toBeTruthy()
  return over([8, 5, 4], Number(bottom![1]), weak)
})()

/** The card, at the thin end of its barrier, over a given field. */
function card(field: Rgb): Rgb {
  const { rgb: fill, alpha } = parseColour(T.card)
  return over(fill, alpha, saturate(field, 1.5))
}

const CARD_LIVE = card(BLOOM_LIVE)
const CARD_WARM = card(BLOOM_WARM)

// ---- the surfaces the ritual paints on -------------------------------------

/** The money's plate. Opaque, so it is its own background. */
const PLATE = rgb(fallback('--money-bg'))
/** The envelope's paper, at its LIGHTEST point: the 12%-white end of the face. */
const PAPER = mix(rgb(fallback('--face')), [255, 255, 255], 0.88)
/** The pocket, which is the only ground on the envelope that carries text. */
const POCKET = rgb(fallback('--foot'))
/** The wax. */
const WAX = rgb(fallback('--foil'))

const PAIRS: { what: string; fg: Rgb; bg: Rgb; floor: number }[] = [
  // --- the money, which is the whole point ---
  { what: 'THE AMOUNT, on its opaque plate', fg: on('--money-ink', PLATE), bg: PLATE, floor: 4.5 },
  { what: 'the plate note under it', fg: on('--money-ink-2', PLATE), bg: PLATE, floor: 4.5 },

  // --- the countdown and the share count, on the field itself ---
  { what: 'THE COUNTDOWN and the share count, on the field', fg: rgb(T.ink), bg: FOOT, floor: 4.5 },
  { what: 'the wordmark strapline, on the field', fg: over(...alpha(T.ink2), FOOT), bg: FOOT, floor: 4.5 },

  // --- the sealed envelope ---
  { what: "the envelope's label, on its pocket", fg: on('--face-ink', POCKET), bg: POCKET, floor: 4.5 },
  { what: "the envelope's second line, on its pocket", fg: on('--face-ink-2', POCKET), bg: POCKET, floor: 4.5 },
  { what: 'the mark in the wax (non-text)', fg: on('--on-foil', WAX), bg: WAX, floor: 3 },
  { what: 'THE PROGRESS RING, on the paper (non-text)', fg: rgb(T.ink), bg: PAPER, floor: 3 },

  // --- what a PC gets ---
  { what: 'the deep-link button label', fg: rgb(T.onAction), bg: rgb(T.action), floor: 4.5 },
  { what: 'the sealed-only explanation, on the card', fg: over(...alpha(T.ink2), CARD_LIVE), bg: CARD_LIVE, floor: 4.5 },

  // --- the copy around the ritual, in both field states ---
  { what: 'the hold hint, on the card, before the claim', fg: over(...alpha(T.ink2), CARD_LIVE), bg: CARD_LIVE, floor: 4.5 },
  { what: "the sponsor's message, on the card, after it", fg: rgb(T.ink), bg: CARD_WARM, floor: 4.5 },
]

/** `rgb(r g b / a)` split into the two arguments `over` wants. */
function alpha(value: string): [Rgb, number] {
  const { rgb: colours, alpha: a } = parseColour(value)
  return [colours, a]
}

describe('every pair the reveal ships', () => {
  it.each(PAIRS)('$what clears $floor:1', ({ fg, bg, floor }) => {
    expect(round2(contrastRatio(fg, bg))).toBeGreaterThanOrEqual(floor)
  })

  /**
   * The two the product holds to AA whatever their size, because misreading
   * them has financial consequences. Stated separately so nobody can relax them
   * to the 3:1 large-text allowance by pointing at the 61px numeral.
   */
  it('holds the amount and the countdown to AA regardless of size', () => {
    expect(round2(contrastRatio(on('--money-ink', PLATE), PLATE))).toBeGreaterThanOrEqual(4.5)
    expect(round2(contrastRatio(rgb(T.ink), FOOT))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the envelope reads as an object on a light', () => {
  /**
   * Not a WCAG floor — the paper carries no information the words do not also
   * carry — but it is the thing that decides whether the sealed state looks
   * like an envelope or like a smudge on the bloom. The paper has to be DEEPER
   * than the light it sits in, and it has to separate from the dark foot it
   * sits on.
   */
  it('separates from the field at the foot, where it actually sits', () => {
    const paper = rgb(fallback('--face'))
    expect(round2(contrastRatio(paper, FOOT))).toBeGreaterThanOrEqual(3)
  })

  it('is darker than the bloom it is lit by', () => {
    const paper = rgb(fallback('--face'))
    expect(contrastRatio(paper, BLOOM_WARM)).toBeGreaterThan(1)
    expect(luminance(paper)).toBeLessThan(luminance(BLOOM_LIVE))
  })

  /**
   * The wax is the only gold on the screen, and that is a colour decision with
   * a contrast consequence: gold on vermilion is 2.83:1, under the 3:1 a
   * meaningful graphic would need. It is allowed because the seal carries no
   * information — the label says "Hold to open" in words, the ring says whether
   * anything is happening, and both of those ARE held to their floors. What the
   * seal has instead is a dark rim of its own, from the outer stop of its own
   * radial, and that is what makes it an object rather than a contrast case.
   */
  it('separates the wax from the paper with a rim rather than with hue', () => {
    const paper = rgb(fallback('--face'))
    const rim = mix(WAX, [0, 0, 0], 0.72)
    expect(round2(contrastRatio(rim, paper))).toBeLessThan(2)
    expect(round2(contrastRatio(WAX, rim))).toBeGreaterThanOrEqual(1.8)
    // And the ring, which IS meaningful, does not rely on the wax at all.
    expect(round2(contrastRatio(rgb(T.ink), paper))).toBeGreaterThanOrEqual(3)
  })
})

/**
 * Printed rather than asserted, so the table in the report is generated from
 * the same numbers the build checks and cannot drift away from them.
 * `--reporter=verbose` shows it; a normal run does not.
 */
describe('the table', () => {
  it('prints', () => {
    const rows = PAIRS.map(
      ({ what, fg, bg, floor }) =>
        `${round2(contrastRatio(fg, bg)).toFixed(2).padStart(6)}:1  (floor ${floor})  ${what}`,
    )
    console.log(['', 'THE REVEAL, computed from the tokens', ...rows, ''].join('\n'))
    expect(rows).toHaveLength(PAIRS.length)
  })
})

function luminance(c: Rgb): number {
  return contrastRatio(c, [0, 0, 0])
}
