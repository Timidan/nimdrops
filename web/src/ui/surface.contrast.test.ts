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
 * Exactly ONE pair takes credit for a scrim: the masthead strapline, which is
 * the only secondary copy left on the bare field. That is a claim about layout,
 * so it is earned rather than asserted — the masthead is the first element in
 * `.nd-field-inner` and `.nd-field-scrim` holds `--nd-scrim-top` at full
 * strength through the first 10%, which `surface.test.ts` checks is still
 * declared.
 *
 * Nothing else does. The s4 layout puts the sponsor block and the two fact
 * tiles on RECESSES rather than on the bare field, and the custody line on the
 * card, so the scrim is back to being composition. Everything at full strength
 * on the field — the amount, its caption, the sealed gate's hint — is computed
 * against the bare, unscrimmed worst case, because those sit mid-screen where
 * no scrim reaches them. That group is what caps how bright the bloom is
 * allowed to be.
 *
 * ## The money moved onto the field, and that is the biggest change here
 *
 * The amount used to sit in a dark well inside the card, at 12.38:1. It is now
 * bare on the field at 88px, which is 4.70:1 against the brightest pixel the
 * bloom can physically reach with a fully lit grain pixel on top of it. That
 * clears the 4.5:1 the product holds money to whatever its size, and it is the
 * reason the currency mark is near-white rather than Nimiq gold: gold is
 * 2.74:1 there, under even the 3:1 a non-text mark is held to.
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
import {
  contrastRatio as ratio,
  over,
  parseColour,
  relativeLuminance,
  round2 as round,
  saturate,
  type Rgb,
} from './contrast'

/**
 * The colour maths is `ui/contrast.ts`, shared rather than reimplemented:
 * source-over compositing, `filter: saturate()`'s sRGB matrix, WCAG relative
 * luminance and the ratio. This file is only the model — which surfaces exist,
 * in what order the browser paints them, and what each foreground sits on.
 */
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

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

const parse = parseColour
const colour = (name: string) => parse(token(name))

/** A literal colour written inline in a rule rather than held as a token. */
function literal(value: string, alpha: number, bg: Rgb): Rgb {
  const { rgb } = parse(value)
  return over(rgb, alpha, bg)
}

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

/**
 * A RECESS on the field: the two fact tiles and the sealed gate's sender block.
 *
 * They are not bare field and they are not a second pane of glass. Every nested
 * surface on this palette has to pick a direction, and over a field this bright
 * the only direction with headroom in it is down: at `--nd-recess-field` the
 * muted label on a tile clears 4.5:1, where on the bare field it cannot at any
 * alpha short of solid.
 */
const FIELD_RECESS: Rgb = (() => {
  const { rgb, alpha } = colour('--nd-recess-field')
  return over(rgb, alpha, FIELD_MAX)
})()

/**
 * The opposite direction, and the one place it is still allowed: the 44px
 * circular buttons on the rail are a 6% near-white LIFT, because a control has
 * to read as raised. Nothing but an icon and a hairline sits on them, so they
 * are held to the 3:1 non-text floor rather than to 4.5:1 — which is the whole
 * reason the custody control is not one of them.
 */
const FIELD_ROUND: Rgb = literal('rgb(245 240 238)', 0.06, FIELD_MAX)

const SATURATE = Number(token('--nd-saturate').replace('%', '')) / 100

// ---- the card, on each of its three rendering paths --------------------------------

/** Everything that sits on the card, derived for one rendering path. */
interface Card {
  path: string
  sheet: Rgb
  option: Rgb
  optionPicked: Rgb
  pillLive: Rgb
  pillQuiet: Rgb
  panel: Rgb
  panelWarn: Rgb
  round: Rgb
}

const HOT = parse(token('--nd-hot')).rgb

function card(path: string, sheet: Rgb): Card {
  return {
    path,
    sheet,
    /** The solid fill of a trivia answer. */
    option: literal('rgb(245 240 238)', 0.1, sheet),
    optionPicked: literal('rgb(245 240 238)', 0.18, sheet),
    pillLive: over(HOT, 0.16, sheet),
    /** A recess, for the same arithmetic as the well. */
    pillQuiet: literal('rgb(12 7 6)', 0.32, sheet),
    panel: literal('rgb(12 7 6)', 0.32, sheet),
    /** The warn wash is a background image ON the panel, so it composites over it. */
    panelWarn: over(HOT, 0.11, literal('rgb(12 7 6)', 0.32, sheet)),
    /**
     * The 44px circle, on the sheet rather than on the field. The create flow's
     * people stepper is the only place it carries TEXT — a minus sign and a
     * plus sign — so unlike the claim screen's icon rail it is held to 4.5:1.
     */
    round: literal('rgb(245 240 238)', 0.06, sheet),
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
const RULE_STRONG = '--nd-rule-strong'

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
    { what: "the sponsor's message keyline (non-text)", fg: o.mark, bg: c.sheet, floor: 3 },

    // --- the action ---
    { what: 'the claim button label', fg: o.onAction, bg: o.action, floor: 4.5 },
    { what: 'the claim button itself (non-text)', fg: o.action, bg: c.sheet, floor: 3 },
    { what: 'the focus ring (non-text)', fg: o.focus, bg: c.sheet, floor: 3 },

    // --- the last gold in the product, and the reason it is on the card ---
    { what: 'THE CUSTODY SHIELD (non-text)', fg: o.accent, bg: c.sheet, floor: 3 },
    { what: 'the custody label beside it', fg: on(MUTED, c.sheet), bg: c.sheet, floor: 4.5 },

    // --- the small parts ---
    { what: 'a trivia answer, unpicked', fg: on(INK, c.option), bg: c.option, floor: 4.5 },

    // --- the create form, whose fields are wells rather than tiles ---
    { what: "a form field's own value", fg: on(INK, c.panel), bg: c.panel, floor: 4.5 },
    {
      // Held to the BODY floor, not to a muted-grey default. A placeholder
      // nobody can read is a label nobody has. On the trivia answer's 10% lift
      // this lands at 4.01:1, which is why the fields are recessed instead.
      what: "a form field's placeholder",
      fg: on(MUTED, c.panel),
      bg: c.panel,
      floor: 4.5,
    },
    { what: "the amount field's NIM suffix", fg: on(INK, c.panel), bg: c.panel, floor: 4.5 },
    { what: "the stepper's minus and plus glyphs", fg: on(INK, c.round), bg: c.round, floor: 4.5 },
    { what: "a stepper button's hairline (non-text)", fg: on(RULE_STRONG, c.sheet), bg: c.sheet, floor: 1.4 },
    { what: "the custody control's headline, on its recess", fg: on(INK, c.panel), bg: c.panel, floor: 4.5 },
    { what: 'a trivia answer, picked', fg: on(INK, c.optionPicked), bg: c.optionPicked, floor: 4.5 },
    { what: 'a live status pill', fg: on(INK, c.pillLive), bg: c.pillLive, floor: 4.5 },
    { what: 'a quiet status pill', fg: on(MUTED, c.pillQuiet), bg: c.pillQuiet, floor: 4.5 },
    { what: 'an explanation panel', fg: on(MUTED, c.panel), bg: c.panel, floor: 4.5 },
    { what: 'a warning panel', fg: on(MUTED, c.panelWarn), bg: c.panelWarn, floor: 4.5 },
    { what: "a warning panel's hot edge (non-text)", fg: HOT, bg: c.panel, floor: 3 },
  ]
}

/**
 * Everything that sits on the field itself. Path-independent.
 *
 * This list grew by most of the money when the s4 layout moved the amount out
 * of the card's dark well and onto the open field. Every one of these is
 * computed against the UNSCRIMMED worst case, because they sit mid-screen where
 * no scrim band reaches them, and that pair — the amount and the countdown — is
 * what caps how bright the bloom is allowed to be.
 */
function fieldPairs(o: Option): Pair[] {
  return [
    // --- the money, bare on the moving field, with no scrim credit ---
    { what: 'THE AMOUNT, on the bare field', fg: on(INK, FIELD_MAX), bg: FIELD_MAX, floor: 4.5 },
    {
      what: 'THE NIM MARK beside it, which is half the money',
      fg: on(INK, FIELD_MAX),
      bg: FIELD_MAX,
      floor: 4.5,
    },
    {
      what: "the amount's caption, at full strength because muted cannot reach the floor here",
      fg: on(INK, FIELD_MAX),
      bg: FIELD_MAX,
      floor: 4.5,
    },
    { what: 'the paid keyline (non-text)', fg: o.mark, bg: FIELD_MAX, floor: 3 },

    // --- the sealed gate's own copy ---
    {
      what: "THE GATE'S HINT and the fixed-and-equal fact, on the bare field",
      fg: on(INK, FIELD_MAX),
      bg: FIELD_MAX,
      floor: 4.5,
    },

    // --- the recesses ---
    {
      what: "THE COUNTDOWN and the share count, on a tile's recess",
      fg: on(INK, FIELD_RECESS),
      bg: FIELD_RECESS,
      floor: 4.5,
    },
    {
      what: "a tile's label, on the same recess",
      fg: on(MUTED, FIELD_RECESS),
      bg: FIELD_RECESS,
      floor: 4.5,
    },
    { what: 'the share marks (non-text), on the same recess', fg: o.mark, bg: FIELD_RECESS, floor: 3 },
    {
      what: "the sealed gate's sponsor line, on its recess",
      fg: on(INK, FIELD_RECESS),
      bg: FIELD_RECESS,
      floor: 4.5,
    },
    {
      what: 'the unverified-name chip, on the same recess',
      fg: on(MUTED, FIELD_RECESS),
      bg: FIELD_RECESS,
      floor: 4.5,
    },

    // --- the rail ---
    { what: 'a rail icon (non-text), on its 6% lift', fg: on(INK, FIELD_ROUND), bg: FIELD_ROUND, floor: 3 },
    { what: "a rail button's hairline (non-text)", fg: on(RULE_STRONG, FIELD_MAX), bg: FIELD_MAX, floor: 1.4 },

    // --- the create flow's field furniture ---
    {
      what: "THE CREATE TOTAL and the limits ledger's figures, on the field's recess",
      fg: on(INK, FIELD_RECESS),
      bg: FIELD_RECESS,
      floor: 4.5,
    },
    {
      what: "a closed-funding alert's hot edge (non-text), on the field's recess",
      fg: HOT,
      bg: FIELD_RECESS,
      floor: 3,
    },
    {
      what: "the waiting beacon and an outcome mark (non-text), on the bare field",
      fg: o.mark,
      bg: FIELD_MAX,
      floor: 3,
    },

    // --- worst case, bare ---
    { what: 'the focus ring, on the bare field', fg: o.focus, bg: FIELD_MAX, floor: 3 },

    // --- inside a scrim band ---
    {
      what: 'the masthead strapline, in the top scrim band',
      fg: on(MUTED, FIELD_TOP),
      bg: FIELD_TOP,
      floor: 4.5,
    },
  ]
}

/**
 * The sealed envelope, which is the first thing every claimant sees.
 *
 * It sits DIRECTLY on the field — the sealed screen has no card, which is what
 * makes it cost no blur — so the worst case behind it is the bloom's own core,
 * and the paper is within 1.03:1 of that. What carries the object is therefore
 * its EDGE and not its fill, and what carries the information on it is held to
 * the ordinary floors on the surfaces it is actually printed on.
 */
function envelopePairs(): Pair[] {
  const FACE = parse(token('--nd-env-face')).rgb
  const POCKET = parse(token('--nd-env-face-foot')).rgb
  const WAX = parse(token('--nd-env-foil')).rgb
  const EDGE = (() => {
    const { rgb, alpha } = colour('--nd-env-edge')
    return over(rgb, alpha, FIELD_MAX)
  })()
  /** The paper at its LIGHTEST point: the 12%-white end of the face gradient. */
  const PAPER = literal('rgb(255 255 255)', 0.12, FACE)

  return [
    { what: "THE ENVELOPE'S EDGE against the field (non-text)", fg: EDGE, bg: FIELD_MAX, floor: 3 },
    { what: "THE ENVELOPE'S EDGE against its own paper (non-text)", fg: EDGE, bg: PAPER, floor: 3 },
    { what: "the envelope's label, on its pocket", fg: on('--nd-env-ink', POCKET), bg: POCKET, floor: 4.5 },
    {
      what: "the envelope's second line, on its pocket",
      fg: on('--nd-env-ink-2', POCKET),
      bg: POCKET,
      floor: 4.5,
    },
    { what: 'THE PROGRESS RING, on the paper (non-text)', fg: parse(token(INK)).rgb, bg: PAPER, floor: 3 },
    { what: 'the mark in the wax (non-text)', fg: parse(token('--nd-env-on-foil')).rgb, bg: WAX, floor: 3 },
  ]
}

/**
 * The one surface in the product that is near-white rather than near-black: the
 * chalk fill of a primary action, of a settled pill, and of the current step on
 * the create flow's funding rail.
 *
 * The pair that used to sit beside it — deep gold on the create flow's paper —
 * went with the paper. There is no light surface left for a gold ring to be
 * legible on, and no gold ring.
 */
const ON_CHALK: Pair[] = [
  {
    what: 'the settled pill, the action label, and the current funding step',
    fg: parse(token('--color-chalk-ink')).rgb,
    bg: parse(token('--color-chalk')).rgb,
    floor: 4.5,
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
     * The three the product holds to AA whatever their size, because misreading
     * them has financial consequences. Stated separately from the table so
     * nobody can relax them to the 3:1 large-text allowance by pointing at the
     * 88px type.
     *
     * All three now sit on the FIELD rather than on the card, so they are
     * path-independent and there is only one number to check — but it is the
     * pessimistic one, computed against the brightest pixel the bloom can
     * physically reach with the grain fully lit on top of it.
     */
    it('holds the amount, the mark and the countdown to AA regardless of size', () => {
      expect(round(ratio(on(INK, FIELD_MAX), FIELD_MAX)), 'the amount on the field')
        .toBeGreaterThanOrEqual(4.5)
      expect(round(ratio(on(INK, FIELD_RECESS), FIELD_RECESS)), 'the countdown on its tile')
        .toBeGreaterThanOrEqual(4.5)
    })
  })
}

describe('the sealed envelope', () => {
  it.each(envelopePairs())('$what clears $floor:1', ({ fg, bg, floor }) => {
    expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(floor)
  })

  /**
   * The wax is the last gold in the product and it is 2.83:1 on its own paper,
   * under the 3:1 a meaningful graphic would need. That is allowed because the
   * seal carries NO information: the label says "Hold to open" in words, the
   * progress ring answers "is anything happening", and both of those ARE held
   * to their floors above. What the seal has instead is a dark rim of its own,
   * from the outer stop of its radial, and that is what makes it an object
   * rather than a contrast case.
   */
  it('separates the wax from the paper with a rim rather than with hue', () => {
    const face = parse(token('--nd-env-face')).rgb
    const wax = parse(token('--nd-env-foil')).rgb
    const rim = wax.map((c) => c * 0.72) as Rgb
    expect(round(ratio(wax, face)), 'gold on vermilion, stated rather than hidden').toBeLessThan(3)
    expect(round(ratio(wax, rim))).toBeGreaterThanOrEqual(1.8)
  })
})

describe('the surfaces that are not on the field', () => {
  it.each(ON_CHALK)('$what clears $floor:1', ({ fg, bg, floor }) => {
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

  /**
   * Where the one gold on the claim screen actually is, and where it cannot be.
   *
   * The s4 layout moved the money out of the card's dark well and onto the open
   * field, so the currency mark went near-white with it, and every other gold
   * the render used to carry — the message keyline, the opening pulse, the
   * outcome mark, the paid keyline — went with it for the same reason. What is
   * left is the CUSTODY SHIELD, on the card, and it is now literally true that
   * gold appears once on the claim screen.
   *
   * That claim is pinned here because the stylesheet's commentary once made it
   * and the render disagreed. A statement about how rare a colour is should
   * fail a build when it stops being true, not age quietly in a comment.
   */
  it('keeps the one gold mark legal where it actually sits', () => {
    for (const c of PATHS) {
      expect(round(ratio(GOLD, c.sheet)), `the custody shield, ${c.path}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('counts the golds in the shipped stylesheet, and there are two', () => {
    /**
     * `--nd-accent` dresses the custody shield and nothing else; `--nd-env-foil`
     * dresses the wax on the envelope and nothing else. Two rules, on two
     * different screens. Anything that adds a third has to change this number
     * and say why.
     */
    const shipped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const uses = [...shipped.matchAll(/(?:color|background(?:-color)?|stroke|fill):\s*var\(--nd-accent\)/g)]
    // One declaration, on a grouped selector: the claimant's custody line and
    // the sponsor's custody control are the same mark on the same surface.
    expect(uses).toHaveLength(1)
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
      `RECESS ${hex(FIELD_RECESS)}       ROUND ${hex(FIELD_ROUND)}`,
      `SHEET glass ${hex(GLASS.sheet)}   flat ${hex(FLAT.sheet)}   solid ${hex(SOLID.sheet)}`,
    ]
    for (const o of [OPTION_1, OPTION_2]) {
      out.push('', `=== ${o.label} ===`)
      for (const c of PATHS) {
        out.push(`--- the card, ${c.path} ---`, ...cardPairs(c, o).map(line))
      }
      out.push('--- the field ---', ...fieldPairs(o).map(line))
    }
    out.push('--- the sealed envelope ---', ...envelopePairs().map(line))
    out.push('--- elsewhere ---', ...ON_CHALK.map(line), '')
    console.log(out.join('\n'))

    expect(out.length).toBeGreaterThan(0)
  })
})
