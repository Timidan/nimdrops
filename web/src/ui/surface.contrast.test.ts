/**
 * Contrast, computed from the tokens, never eyeballed off a screenshot.
 *
 * The field MOVES. A ratio measured against one frame of it is a ratio measured
 * against a coincidence, so nothing here looks at a rendered pixel. Instead the
 * worst case is DERIVED:
 *
 *   1. take the lightest stop of the field's own radial gradient;
 *   2. stack all three lights on it at their peak alpha times their peak layer
 *      opacity, gold at its post-claim value, which is the brightest the field
 *      can physically be at any point in the drift;
 *   3. for anything reading through the sheet, push that through
 *      `saturate(160%)` the way `backdrop-filter` does, then lay the barrier
 *      fill over it at its THINNER end;
 *   4. composite each foreground's own alpha over the result;
 *   5. compute WCAG 2.x relative luminance and the ratio.
 *
 * Blur is not modelled and does not need to be: averaging can only move a pixel
 * towards the mean, so the brightest unblurred pixel is an upper bound on the
 * brightest blurred one. The figures below are therefore pessimistic, which is
 * the correct direction to be wrong in on a screen that hands out money.
 *
 * Everything is read out of `index.css`, so retuning a light or thinning the
 * barrier fails this file rather than quietly failing a claimant.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

type Rgb = [number, number, number]

/** A token's value, following `var()` indirection to the literal underneath. */
function token(name: string, depth = 0): string {
  const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
  expect(value, `${name} should be declared`).toBeTruthy()
  const indirect = value!.match(/^var\((--[\w-]+)\)$/)
  if (indirect) {
    expect(depth, `${name} loops through var()`).toBeLessThan(8)
    return token(indirect[1], depth + 1)
  }
  return value!
}

function num(name: string): number {
  const value = Number(token(name))
  expect(Number.isFinite(value), `${name} should be a number`).toBe(true)
  return value
}

/** `#rrggbb` or `rgb(r g b / a)`. Returns the colour and its alpha. */
function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 }
  }
  const fn = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)/)
  expect(fn, `cannot parse colour ${value}`).toBeTruthy()
  return {
    rgb: [Number(fn![1]), Number(fn![2]), Number(fn![3])] as Rgb,
    alpha: fn![4] === undefined ? 1 : Number(fn![4]),
  }
}

const colour = (name: string) => parse(token(name))

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb
}

/**
 * `filter: saturate()`'s matrix, in sRGB, which is the space CSS filter
 * shorthand functions operate in. Clamped, because it can push a channel out of
 * gamut and the compositor clamps too.
 */
function saturate(rgb: Rgb, s: number): Rgb {
  const [r, g, b] = rgb.map((c) => c / 255) as Rgb
  const rows = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ]
  return rows.map(
    (row) => Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)) * 255,
  ) as Rgb
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Composite a foreground token over a background, honouring its own alpha. */
function on(fgToken: string, bg: Rgb): Rgb {
  const { rgb, alpha } = colour(fgToken)
  return over(rgb, alpha, bg)
}

const round = (n: number) => Math.round(n * 100) / 100

// ---- the worst case, derived ------------------------------------------------------

/** The brightest the field can be, anywhere, at any point in the drift. */
const FIELD_MAX: Rgb = (() => {
  let field = parse(token('--nd-field-base-max')).rgb
  const lights: [string, string][] = [
    ['--nd-light-1-fill', '--nd-light-1-o'],
    ['--nd-light-2-fill', '--nd-light-2-o'],
    // Gold at its post-claim value: the field keeps the warmer cast, so that is
    // the state it spends the rest of the session in.
    ['--nd-light-3-fill', '--nd-light-3-o-warm'],
  ]
  for (const [fill, opacity] of lights) {
    const { rgb, alpha } = colour(fill)
    field = over(rgb, alpha * num(opacity), field)
  }
  return field
})()

const SATURATE = Number(token('--nd-saturate').replace('%', '')) / 100

/**
 * The field where the sheet usually sits: the base gradient with no light on
 * it. Used ONLY to compare the three sheet paths against each other, never for
 * a contrast floor — floors are computed against the worst case above.
 */
const FIELD_TYPICAL = parse(token('--nd-field-base-max')).rgb

function sheetOver(field: Rgb, barrier: string, blurred: boolean): Rgb {
  const { rgb, alpha } = colour(barrier)
  return over(rgb, alpha, blurred ? saturate(field, SATURATE) : field)
}

/** What the sheet's text actually sits on, at the thin end of the barrier. */
const SHEET: Rgb = sheetOver(FIELD_MAX, '--nd-barrier-glass-bottom', true)

/** The same sheet with no `backdrop-filter` available. */
const SHEET_FLAT: Rgb = sheetOver(FIELD_MAX, '--nd-barrier-flat-bottom', false)

const SHEET_SOLID = parse(token('--color-sheet')).rgb
const PLATE = parse(token('--color-plate')).rgb
const ACTION = parse(token('--color-gold')).rgb

/** The solid fill of a trivia answer, which sits on the sheet. */
const OPTION: Rgb = over([244, 243, 247], 0.1, SHEET)
const OPTION_PICKED: Rgb = over([233, 178, 19], 0.22, SHEET)

describe('the derived worst case', () => {
  /**
   * `--nd-field-max` is a constant in the stylesheet so a reader can see what
   * the floors were computed against without running anything. If a light is
   * retuned and this constant is not, the comment becomes a lie; this is what
   * stops that.
   */
  it('matches the constant the stylesheet documents', () => {
    const declared = parse(token('--nd-field-max')).rgb
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(declared[i] - FIELD_MAX[i]), `channel ${i}`).toBeLessThanOrEqual(1)
    }
  })

  /**
   * Reduce Transparency and "no backdrop-filter" must not be the dim paths that
   * nobody checked. Compared over the field the sheet USUALLY sits on, which is
   * the honest comparison: the worst case is a moment at the edge of the drift,
   * and asking three surfaces to match there would only mean thickening the
   * barrier until the glass stopped being glass.
   *
   * 1.1:1 between two surfaces is far under the ~3:1 at which a boundary is
   * visible at all, so all three read as the same sheet.
   */
  it('lands the three sheet paths on the same reading', () => {
    const glass = sheetOver(FIELD_TYPICAL, '--nd-barrier-glass-bottom', true)
    const flat = sheetOver(FIELD_TYPICAL, '--nd-barrier-flat-bottom', false)
    expect(round(ratio(glass, flat))).toBeLessThan(1.1)
    expect(round(ratio(glass, SHEET_SOLID))).toBeLessThan(1.1)
  })
})

/**
 * Every foreground/background pair the claim surface ships. `PRODUCT.md`'s
 * floors: body 4.5:1, large text 3:1, placeholders held to the body standard,
 * and monetary amounts and countdowns held to AA regardless of size.
 */
const PAIRS: { what: string; fg: Rgb; bg: Rgb; floor: number }[] = [
  // --- on the sheet ---
  { what: 'sponsor line and body copy, on the sheet', fg: on('--nd-on-surface', SHEET), bg: SHEET, floor: 4.5 },
  { what: 'secondary copy and captions, on the sheet', fg: on('--nd-on-surface-muted', SHEET), bg: SHEET, floor: 4.5 },
  { what: "the sponsor's message, on the sheet", fg: on('--nd-on-surface', SHEET), bg: SHEET, floor: 4.5 },
  { what: 'the same, with no backdrop-filter', fg: on('--nd-on-surface-muted', SHEET_FLAT), bg: SHEET_FLAT, floor: 4.5 },
  { what: 'the same, under Reduce Transparency', fg: on('--nd-on-surface-muted', SHEET_SOLID), bg: SHEET_SOLID, floor: 4.5 },
  { what: 'gold, on the sheet', fg: ACTION, bg: SHEET, floor: 3 },

  // --- the money ---
  { what: 'THE AMOUNT, on its plate', fg: on('--nd-on-plate', PLATE), bg: PLATE, floor: 4.5 },
  { what: 'the plate note', fg: on('--nd-on-plate-muted', PLATE), bg: PLATE, floor: 4.5 },
  { what: 'the claim button label, on gold', fg: on('--nd-on-action', ACTION), bg: ACTION, floor: 4.5 },

  // --- straight onto the moving field ---
  { what: 'THE COUNTDOWN and the share count, on the field', fg: on('--nd-on-surface', FIELD_MAX), bg: FIELD_MAX, floor: 4.5 },
  { what: 'the wordmark strapline, on the field', fg: on('--nd-on-surface-muted', FIELD_MAX), bg: FIELD_MAX, floor: 4.5 },
  { what: 'the custody line, on the field', fg: on('--nd-on-surface-muted', FIELD_MAX), bg: FIELD_MAX, floor: 4.5 },
  { what: 'the share marks (non-text), on the field', fg: ACTION, bg: FIELD_MAX, floor: 3 },
  { what: 'the focus ring, on the field', fg: ACTION, bg: FIELD_MAX, floor: 3 },
  { what: 'the focus ring, on the plate', fg: parse(token('--color-gold-deep')).rgb, bg: PLATE, floor: 3 },

  // --- the trivia slot ---
  { what: 'a trivia answer, unpicked', fg: on('--nd-on-surface', OPTION), bg: OPTION, floor: 4.5 },
  { what: 'a trivia answer, picked', fg: on('--nd-on-surface', OPTION_PICKED), bg: OPTION_PICKED, floor: 4.5 },
]

describe('every pair the claim surface ships', () => {
  it.each(PAIRS)('$what clears $floor:1', ({ fg, bg, floor }) => {
    expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(floor)
  })

  /**
   * The two the product holds to AA whatever their size, because misreading
   * them has financial consequences. Stated separately so nobody can relax them
   * to the 3:1 large-text allowance by pointing at the 61px type.
   */
  it('holds the amount and the countdown to AA regardless of size', () => {
    expect(round(ratio(on('--nd-on-plate', PLATE), PLATE))).toBeGreaterThanOrEqual(4.5)
    expect(round(ratio(on('--nd-on-surface', FIELD_MAX), FIELD_MAX))).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * Printed rather than asserted: the table in the report is generated from this,
 * so the numbers there cannot drift away from the ones the build checks.
 * `--reporter=verbose` shows it; a normal run does not.
 */
describe('the table', () => {
  it('prints', () => {
    const rows = PAIRS.map(
      ({ what, fg, bg, floor }) =>
        `${round(ratio(fg, bg)).toFixed(2).padStart(6)}:1  (floor ${floor})  ${what}`,
    )
    console.log(['', 'CONTRAST, computed from the tokens', ...rows, ''].join('\n'))
    expect(rows).toHaveLength(PAIRS.length)
  })
})
