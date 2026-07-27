/**
 * Contrast, computed from the tokens, never eyeballed off a screenshot.
 *
 * The field MOVES. A ratio measured against one frame of it is a ratio measured
 * against a coincidence, so nothing here looks at a rendered pixel. Instead the
 * worst case is DERIVED, in the order the browser actually composites:
 *
 *   1. the lightest stop of the field's own base radial;
 *   2. the static counter-light over it;
 *   3. the bloom's CORE stop at its peak alpha times its post-claim layer
 *      opacity, which is the brightest the field can physically be at any point
 *      in the drift;
 *   4. the scrim, for the two bands that have one;
 *   5. the GRAIN, at a fully lit pixel — it is the last layer under the content,
 *      so it lifts everything below it before any text is drawn;
 *   6. for anything reading through the card, push that through `saturate()`
 *      the way `backdrop-filter` does, then lay the barrier fill over it at its
 *      THINNER end;
 *   7. composite each foreground's own alpha over the result;
 *   8. compute WCAG 2.x relative luminance and the ratio.
 *
 * Blur is not modelled and does not need to be: averaging can only move a pixel
 * towards the mean, so the brightest unblurred pixel is an upper bound on the
 * brightest blurred one. The figures below are therefore pessimistic, which is
 * the correct direction to be wrong in on a screen that hands out money.
 *
 * ## Why the grain is in the model
 *
 * It was the omission that mattered. `.nd-field-texture` is three octaves of
 * `feTurbulence` at `--nd-grain-o`, and `feTurbulence` can emit a near-white
 * pixel, so the honest upper bound for that layer is white at its own opacity.
 * At 5% that is about three points per channel — small, and decisive: it took
 * near-white on the field from 4.56:1 to 4.43:1 and put the countdown under the
 * floor it is held to whatever its size. The response was to spend four points
 * of `--nd-bloom-o-warm`, not to drop the dither and not to move the floor.
 *
 * ## Where the model gives credit for a scrim, and where it refuses to
 *
 * The two pieces of SECONDARY copy that sit on the field are computed against
 * the field WITH THE SCRIM, because the scrim is what they physically sit on.
 * That is a claim about layout, so it is earned rather than asserted: the
 * masthead is the first element in `.nd-field-inner` and the custody line is
 * the last; `.nd-field-scrim` covers the field edge to edge and holds
 * `--nd-scrim-top` through the first 10% and `--nd-scrim-bottom` through the
 * last 10%. `surface.test.ts` checks those held bands are still declared, so
 * the model cannot quietly stop being true.
 *
 * Everything at FULL strength on the field — the countdown, the share count,
 * the share marks — is computed against the bare, unscrimmed worst case,
 * because on a phone those sit mid-screen where no scrim reaches them. That
 * pair is what caps how bright the bloom is allowed to be.
 *
 * ## Three card paths, two accent options, one table
 *
 * Every card-borne pair is checked on all three rendering paths — glass with
 * `backdrop-filter`, the flat fallback, and the Reduce Transparency solid swap
 * — rather than on the glass path with the other two spot-checked. A floor
 * verified on one path is not verified. And the whole table runs twice, once
 * for each unresolved answer to the gold-versus-vermilion question, so the
 * owner's choice between them is a design judgement made on complete numbers
 * and not a compliance gamble.
 *
 * Everything is read out of `index.css`, so retuning the bloom or thinning the
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

/** A literal colour written inline in a rule rather than held as a token. */
function literal(value: string, alpha: number, bg: Rgb): Rgb {
  const { rgb } = parse(value)
  return over(rgb, alpha, bg)
}

/**
 * `filter: saturate()`'s matrix, in sRGB, which is the space CSS filter
 * shorthand functions operate in. Clamped, because it can push a channel out of
 * gamut and the compositor clamps too. On a vermilion backdrop that clamp is
 * not theoretical: at 160% the blue channel pins at zero, which is part of why
 * `--nd-saturate` is 120%.
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

const round = (n: number) => Math.round(n * 100) / 100
const hex = (rgb: Rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')

// ---- the field, layer by layer ----------------------------------------------------

const GRAIN_O = num('--nd-grain-o')

/**
 * The grain, as its honest upper bound. `feTurbulence`'s output is noise across
 * all four channels, so the brightest pixel it can hand the compositor is an
 * opaque white one; at `--nd-grain-o` that is what every layer beneath has to
 * survive. Modelling the tile's MEAN instead would be modelling the average
 * case, and the average case is not what a floor is for.
 */
const grained = (rgb: Rgb): Rgb => over([255, 255, 255], GRAIN_O, rgb)

/**
 * The lit field before the grain: the base radial's lightest stop, the static
 * counter-light, then the bloom's core at its post-claim opacity. The bloom's
 * outer stops are all dimmer than its core by construction, so the core is the
 * only one that can set this.
 */
const FIELD_LIT: Rgb = (() => {
  let field = parse(token('--nd-field-base-max')).rgb
  const lights: [string, string][] = [
    ['--nd-counter-fill', '--nd-counter-o'],
    // The bloom at its post-claim value: the field keeps the hotter cast, so
    // that is the state it spends the rest of the session in.
    ['--nd-bloom-core', '--nd-bloom-o-warm'],
  ]
  for (const [fill, opacity] of lights) {
    const { rgb, alpha } = colour(fill)
    field = over(rgb, alpha * num(opacity), field)
  }
  return field
})()

/** The brightest pixel the field can reach, grain included. */
const FIELD_MAX = grained(FIELD_LIT)

/**
 * The same field under each scrim band, at the band's declared strength, and
 * then under the grain — that is the paint order, since `.nd-field-texture`
 * follows `.nd-field-scrim` at the same z-index. Used ONLY for the two pieces
 * of secondary copy that physically sit in those bands.
 */
const scrimmed = (band: string): Rgb => {
  const { rgb, alpha } = colour(band)
  return grained(over(rgb, alpha, FIELD_LIT))
}
const FIELD_TOP = scrimmed('--nd-scrim-top')
const FIELD_BOTTOM = scrimmed('--nd-scrim-bottom')

const SATURATE = Number(token('--nd-saturate').replace('%', '')) / 100

// ---- the card, on each of its three rendering paths --------------------------------

/** Everything that sits on the card, derived for one rendering path. */
interface Card {
  path: string
  sheet: Rgb
  well: Rgb
  option: Rgb
  optionPicked: Rgb
  pillLive: Rgb
  pillQuiet: Rgb
  panel: Rgb
  panelWarn: Rgb
}

const HOT = parse(token('--nd-hot')).rgb

function card(path: string, sheet: Rgb): Card {
  return {
    path,
    sheet,
    /**
     * The amount's well: a 34% warm-black RECESS inside the card. It is
     * translucent, so it is derived on each path rather than being a colour —
     * and it is the reason the well subtracts light rather than adding it,
     * since a near-white lift put the plate note under the floor.
     */
    well: literal('rgb(12 7 6)', 0.34, sheet),
    /** The solid fill of a trivia answer. */
    option: literal('rgb(245 240 238)', 0.1, sheet),
    optionPicked: literal('rgb(245 240 238)', 0.18, sheet),
    pillLive: over(HOT, 0.16, sheet),
    /** A recess, for the same arithmetic as the well. */
    pillQuiet: literal('rgb(12 7 6)', 0.32, sheet),
    panel: literal('rgb(12 7 6)', 0.32, sheet),
    /** The warn wash is a background image ON the panel, so it composites over it. */
    panelWarn: over(HOT, 0.11, literal('rgb(12 7 6)', 0.32, sheet)),
  }
}

function sheetOver(field: Rgb, barrier: string, blurred: boolean): Rgb {
  const { rgb, alpha } = colour(barrier)
  return over(rgb, alpha, blurred ? saturate(field, SATURATE) : field)
}

const GLASS = card('glass', sheetOver(FIELD_MAX, '--nd-barrier-glass-bottom', true))
const FLAT = card('no backdrop-filter', sheetOver(FIELD_MAX, '--nd-barrier-flat-bottom', false))
const SOLID = card('Reduce Transparency', parse(token('--color-sheet')).rgb)
const PATHS = [GLASS, FLAT, SOLID]

// ---- the two answers to the gold-versus-vermilion question -------------------------

/**
 * Option 2's overrides, read out of the `[data-nd-accent='bright']` block so
 * the alternative is measured from the stylesheet that ships it rather than
 * from a number retyped into a test.
 */
const BRIGHT_BLOCK = css.match(/:root\[data-nd-accent='bright'\]\s*\{([^}]*)\}/)?.[1]

function accentToken(name: string, overridden: boolean): Rgb {
  if (overridden) {
    expect(BRIGHT_BLOCK, "the bright accent block should exist").toBeTruthy()
    const found = BRIGHT_BLOCK!.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
    expect(found, `${name} should be declared in the bright accent block`).toBeTruthy()
    // An override may itself point at a `@theme` colour, as `--nd-on-action`
    // does; follow it the same way a root token is followed.
    const indirect = found!.match(/^var\((--[\w-]+)\)$/)
    return parse(indirect ? token(indirect[1]) : found!).rgb
  }
  return parse(token(name)).rgb
}

interface Option {
  label: string
  /** The NIM currency mark. */
  accent: Rgb
  /** The primary action's fill, which is also the focus ring. */
  action: Rgb
  onAction: Rgb
  focus: Rgb
  /** The share marks on the bare field. */
  mark: Rgb
}

const option = (label: string, bright: boolean): Option => ({
  label,
  accent: accentToken('--nd-accent', bright),
  action: accentToken('--nd-action', bright),
  onAction: accentToken('--nd-on-action', bright),
  focus: accentToken('--nd-focus', bright),
  mark: accentToken('--nd-mark', bright),
})

const OPTION_1 = option('option 1 — near-white everywhere, gold only on the mark', false)
const OPTION_2 = option('option 2 — one brighter accent doing every job', true)

// ---- the pairs ---------------------------------------------------------------------

interface Pair {
  what: string
  fg: Rgb
  bg: Rgb
  floor: number
}

/** Composite a foreground token over a background, honouring its own alpha. */
function on(fgToken: string, bg: Rgb): Rgb {
  const { rgb, alpha } = colour(fgToken)
  return over(rgb, alpha, bg)
}

const INK = '--nd-on-surface'
const MUTED = '--nd-on-surface-muted'

/**
 * Everything that sits on the card, for one path and one accent option.
 * `PRODUCT.md`'s floors: body 4.5:1, large text 3:1, placeholders held to the
 * body standard, and monetary amounts and countdowns held to AA regardless of
 * size.
 */
function cardPairs(c: Card, o: Option): Pair[] {
  return [
    { what: 'sponsor line and body copy', fg: on(INK, c.sheet), bg: c.sheet, floor: 4.5 },
    { what: 'secondary copy and captions', fg: on(MUTED, c.sheet), bg: c.sheet, floor: 4.5 },

    // --- the money ---
    { what: 'THE AMOUNT, in its well', fg: on(INK, c.well), bg: c.well, floor: 4.5 },
    { what: 'THE NIM MARK, in the well', fg: o.accent, bg: c.well, floor: 4.5 },
    { what: 'the plate note', fg: on(MUTED, c.well), bg: c.well, floor: 4.5 },
    { what: 'the claim button label', fg: o.onAction, bg: o.action, floor: 4.5 },
    { what: 'the claim button itself (non-text)', fg: o.action, bg: c.sheet, floor: 3 },
    { what: 'the paid keyline (non-text)', fg: HOT, bg: c.sheet, floor: 3 },
    { what: 'the focus ring (non-text)', fg: o.focus, bg: c.sheet, floor: 3 },

    // --- the small parts ---
    { what: 'a trivia answer, unpicked', fg: on(INK, c.option), bg: c.option, floor: 4.5 },
    { what: 'a trivia answer, picked', fg: on(INK, c.optionPicked), bg: c.optionPicked, floor: 4.5 },
    { what: 'a live status pill', fg: on(INK, c.pillLive), bg: c.pillLive, floor: 4.5 },
    { what: 'a quiet status pill', fg: on(MUTED, c.pillQuiet), bg: c.pillQuiet, floor: 4.5 },
    { what: 'an explanation panel', fg: on(MUTED, c.panel), bg: c.panel, floor: 4.5 },
    { what: 'a warning panel', fg: on(MUTED, c.panelWarn), bg: c.panelWarn, floor: 4.5 },
  ]
}

/** Everything that sits on the field itself. Path-independent. */
function fieldPairs(o: Option): Pair[] {
  return [
    // straight onto the moving field, with no scrim credit
    {
      what: 'THE COUNTDOWN and the share count, on the bare field',
      fg: on(INK, FIELD_MAX),
      bg: FIELD_MAX,
      floor: 4.5,
    },
    { what: 'the share marks (non-text), on the bare field', fg: o.mark, bg: FIELD_MAX, floor: 3 },
    { what: 'the focus ring, on the bare field', fg: o.focus, bg: FIELD_MAX, floor: 3 },

    // inside a scrim band
    {
      what: 'the masthead strapline, in the top scrim band',
      fg: on(MUTED, FIELD_TOP),
      bg: FIELD_TOP,
      floor: 4.5,
    },
    {
      what: 'the custody line, in the bottom scrim band',
      fg: on(MUTED, FIELD_BOTTOM),
      bg: FIELD_BOTTOM,
      floor: 4.5,
    },
  ]
}

/** The one surface that is not on the field at all. */
const LEGACY: Pair[] = [
  {
    what: "the settled pill, and the action label on near-white",
    fg: parse(token('--color-chalk-ink')).rgb,
    bg: parse(token('--color-chalk')).rgb,
    floor: 4.5,
  },
  {
    what: "the focus ring, on the create flow's paper",
    fg: parse(token('--color-gold-deep')).rgb,
    bg: parse(token('--color-plate')).rgb,
    floor: 3,
  },
]

// ---- the derivation itself ---------------------------------------------------------

describe('the derived worst case', () => {
  /**
   * `--nd-field-max` is a constant in the stylesheet so a reader can see what
   * the floors were computed against without running anything. If the bloom is
   * retuned and this constant is not, the comment becomes a lie; this is what
   * stops that. Exact to the rounded channel, not within a tolerance — a
   * tolerance is a place for a drift to hide.
   */
  it('matches the constant the stylesheet documents', () => {
    expect(hex(parse(token('--nd-field-max')).rgb)).toBe(hex(FIELD_MAX))
  })

  /**
   * The grain has to be ON, and it has to be in the model. If someone deletes
   * the dither to buy back the contrast this test costs, that is a different
   * decision from the one that was made, and it should have to be made
   * deliberately.
   */
  it('composites the grain, and the grain is what the bloom peak is set by', () => {
    expect(GRAIN_O).toBeGreaterThan(0)
    expect(css).toContain('opacity: var(--nd-grain-o)')
    expect(relativeLuminance(FIELD_MAX)).toBeGreaterThan(relativeLuminance(FIELD_LIT))
    // Without the grain the bloom could sit hotter. That is the trade, stated.
    const ungrained = round(ratio(parse(token(INK)).rgb, FIELD_LIT))
    const grained_ = round(ratio(parse(token(INK)).rgb, FIELD_MAX))
    expect(grained_).toBeLessThan(ungrained)
    expect(grained_).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * The bloom's own stops have to descend. A fall-off is what makes the thing
   * read as a light source rather than a wash, and it is also what lets the
   * core alone stand in for the whole gradient in the derivation above.
   */
  it('falls off monotonically from the core, so the core is the worst case', () => {
    const stops = ['core', 'hot', 'mid', 'deep', 'edge', 'fade'].map((name) => {
      const { rgb, alpha } = colour(`--nd-bloom-${name}`)
      return relativeLuminance(rgb) * alpha
    })
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i], `stop ${i}`).toBeLessThan(stops[i - 1])
    }
  })

  /**
   * The post-claim peak is the state the worst case is derived at, so it has to
   * BE the peak. If a future tone were given a hotter bloom than `warm`, every
   * floor in this file would be computed at the wrong brightness.
   */
  it('derives at the hottest bloom opacity the stylesheet declares', () => {
    const peak = num('--nd-bloom-o-warm')
    for (const name of ['--nd-bloom-o', '--nd-bloom-o-quiet']) {
      expect(num(name), `${name} must not exceed the peak`).toBeLessThanOrEqual(peak)
    }
  })

  /**
   * The two fallbacks are the paths nobody looks at, so they are checked
   * against each other rather than assumed: the flat card and the solid card
   * must be the same surface, since one is the stand-in for the other.
   */
  it('lands the two opaque paths on the same reading', () => {
    expect(round(ratio(FLAT.sheet, SOLID.sheet))).toBeLessThan(1.1)
  })

  /**
   * The glass path is legitimately brighter than its fallbacks at the worst
   * case, and pretending otherwise would be the fudge. A translucent card over
   * the bloom's core IS lighter than an opaque one; the previous version of
   * this test hid that by comparing all three over a bloom-free patch of the
   * base gradient, where any barrier alpha whatsoever agrees to three decimal
   * places. That comparison could not fail and so was not a test.
   *
   * What is worth holding is that the glass card stays the SAME MATERIAL as its
   * fallback rather than becoming a different one. Two surfaces become legibly
   * distinct boundaries at around 3:1; 2:1 keeps the three paths recognisably
   * one card while leaving the glass free to actually be glass. Every floor
   * above is separately cleared on all three, which is the property that
   * matters and is checked directly rather than inferred from this.
   */
  it('keeps the glass card the same material as its fallbacks', () => {
    expect(round(ratio(GLASS.sheet, FLAT.sheet))).toBeLessThan(2)
    expect(round(ratio(GLASS.sheet, SOLID.sheet))).toBeLessThan(2)
  })
})

// ---- every pair, every path, both options ------------------------------------------

for (const o of [OPTION_1, OPTION_2]) {
  describe(o.label, () => {
    for (const c of PATHS) {
      describe(`on the card — ${c.path}`, () => {
        it.each(cardPairs(c, o))('$what clears $floor:1', ({ fg, bg, floor }) => {
          expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(floor)
        })
      })
    }

    describe('on the field', () => {
      it.each(fieldPairs(o))('$what clears $floor:1', ({ fg, bg, floor }) => {
        expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(floor)
      })
    })

    /**
     * The two the product holds to AA whatever their size, because misreading
     * them has financial consequences. Stated separately from the table so
     * nobody can relax them to the 3:1 large-text allowance by pointing at the
     * 61px type, and asserted on every path, because the amount is not less
     * money on a renderer without `backdrop-filter`.
     */
    it('holds the amount, the mark and the countdown to AA regardless of size', () => {
      for (const c of PATHS) {
        expect(round(ratio(on(INK, c.well), c.well)), `the amount, ${c.path}`).toBeGreaterThanOrEqual(4.5)
        expect(round(ratio(o.accent, c.well)), `the NIM mark, ${c.path}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(round(ratio(on(INK, FIELD_MAX), FIELD_MAX))).toBeGreaterThanOrEqual(4.5)
    })
  })
}

describe('the surfaces that are not on the field', () => {
  it.each(LEGACY)('$what clears $floor:1', ({ fg, bg, floor }) => {
    expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(floor)
  })
})

/**
 * The gold-versus-vermilion collision, as numbers rather than as an opinion.
 *
 * Nimiq gold is 30 degrees of hue from the bloom's core and only about 3.5x its
 * luminance, so on the bare field it is a warm patch on a warm field. These are
 * the facts the shipped resolution rests on, and they are asserted rather than
 * printed so that a future retune of the bloom cannot invalidate the decision
 * without failing the build.
 */
describe('the gold-versus-vermilion collision', () => {
  const GOLD = parse(token('--color-gold')).rgb

  it('cannot put Nimiq gold on the bare field at all', () => {
    expect(round(ratio(GOLD, FIELD_MAX))).toBeLessThan(3)
  })

  it('can put it on the dark well, which is where the currency mark lives', () => {
    for (const c of PATHS) {
      expect(round(ratio(GOLD, c.well)), c.path).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * Option 2's brighter accent does clear the field for non-text, which is the
   * whole point of it, so the choice between the two is a design judgement and
   * not a compliance one.
   *
   * What it does NOT do is clear 4.5:1, and that is the finding that decides
   * it. The countdown and the share count are held to AA whatever their size,
   * so they stay near-white under option 2 as well. Option 2 therefore does not
   * buy a single-accent system — it puts a second bright colour beside the
   * first, inside the same `.nd-facts` row. Option 1 spends one hue on the one
   * element that is half of the money and leaves the field with exactly one
   * bright on it.
   */
  it('clears the field for non-text with the brighter accent, and only for non-text', () => {
    const bright = OPTION_2.accent
    expect(round(ratio(bright, FIELD_MAX))).toBeGreaterThanOrEqual(3)
    expect(round(ratio(bright, FIELD_MAX))).toBeLessThan(4.5)
    // It still has to be legible as a button fill, which is the job option 2
    // keeps giving it and option 1 takes away.
    expect(round(ratio(OPTION_2.onAction, OPTION_2.action))).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * Printed rather than asserted: the table in the report is generated from this,
 * so the numbers there cannot drift away from the ones the build checks.
 * `--reporter=verbose` shows it; a normal run does not.
 */
describe('the table', () => {
  it('prints', () => {
    const line = (p: Pair) =>
      `${round(ratio(p.fg, p.bg)).toFixed(2).padStart(6)}:1  (floor ${p.floor})  ${p.what}`

    const out: string[] = [
      '',
      `FIELD_LIT  ${hex(FIELD_LIT)}  ->  FIELD_MAX ${hex(FIELD_MAX)} (grain ${GRAIN_O})`,
      `FIELD_TOP  ${hex(FIELD_TOP)}      FIELD_BOTTOM ${hex(FIELD_BOTTOM)}`,
      `SHEET glass ${hex(GLASS.sheet)}   flat ${hex(FLAT.sheet)}   solid ${hex(SOLID.sheet)}`,
      `WELL  glass ${hex(GLASS.well)}   flat ${hex(FLAT.well)}   solid ${hex(SOLID.well)}`,
    ]
    for (const o of [OPTION_1, OPTION_2]) {
      out.push('', `=== ${o.label} ===`)
      for (const c of PATHS) {
        out.push(`--- the card, ${c.path} ---`, ...cardPairs(c, o).map(line))
      }
      out.push('--- the field ---', ...fieldPairs(o).map(line))
    }
    out.push('--- elsewhere ---', ...LEGACY.map(line), '')
    console.log(out.join('\n'))

    expect(out.length).toBeGreaterThan(0)
  })
})
