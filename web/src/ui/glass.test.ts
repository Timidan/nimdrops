/**
 * The liquid-glass surface's contract: the fallback chain, the masked stroke,
 * the blur budget, and the display face.
 *
 * Everything here reads the STYLESHEET rather than the DOM, for the reason
 * `surface.test.ts` gives at length: jsdom has no layout engine, no cascade
 * worth the name, no `@supports` evaluation and no `backdrop-filter`, so an
 * assertion made against a rendered node would pass whatever the CSS said and
 * defend nothing. The invariants are checked where they live.
 *
 * Three groups, and they are not the same kind of claim:
 *
 *   TEXT       the rules exist, in the right guards, with the right
 *              declarations. Cheap, and it is what catches a fallback quietly
 *              deleted during a refactor.
 *   ARITHMETIC the contrast floors, recomputed from `index.css`'s own tokens
 *              through the same compositing order `surface.contrast.test.ts`
 *              uses. Retuning the bloom fails this file rather than quietly
 *              failing a reader.
 *   DISK       the font and its licence are actually there, at a size a phone
 *              on a bad connection can afford.
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  over,
  parseColour,
  round2,
  saturate,
  type Rgb,
} from './contrast'

/** Vitest runs with `web/` as its root, so both stylesheets are right there. */
const raw = readFileSync(resolve(process.cwd(), 'src/ui/glass.css'), 'utf8')
const indexRaw = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '')

/** What actually ships: the stylesheet with its commentary removed. */
const css = strip(raw)
const indexCss = strip(indexRaw)

// ---- a small rule reader ----------------------------------------------------------
//
// `surface.test.ts` matches top-level rules with a regex, which is enough there
// because nothing it asserts is nested. Half of this file's rules live inside an
// `@supports` or an `@media`, and WHICH guard a rule sits in is the assertion —
// so the rules are read with their ancestry attached instead.

interface Rule {
  /** The selector list, or the at-rule prelude, whitespace collapsed. */
  prelude: string
  /** Everything between this rule's braces, nested rules included. */
  body: string
  /** The preludes of every enclosing at-rule, outermost first. */
  ancestry: string[]
}

function parseRules(source: string): Rule[] {
  const out: Rule[] = []
  const stack: { prelude: string; start: number; ancestry: string[] }[] = []
  let buffer = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '{') {
      stack.push({
        prelude: buffer.trim().replace(/\s+/g, ' '),
        start: i + 1,
        ancestry: stack.map((frame) => frame.prelude),
      })
      buffer = ''
    } else if (char === '}') {
      const frame = stack.pop()
      if (frame) {
        out.push({ prelude: frame.prelude, body: source.slice(frame.start, i), ancestry: frame.ancestry })
      }
      buffer = ''
    } else {
      buffer += char
    }
  }
  expect(stack, 'glass.css should have balanced braces').toHaveLength(0)
  return out
}

const rules = parseRules(css)

/** This rule's own declarations, with any nested rule removed. */
const declarations = (rule: Rule) => rule.body.replace(/[^{}]*\{[^{}]*\}/g, '')

const unguarded = (ancestry: string[]) => ancestry.length === 0
const inside = (needle: string) => (ancestry: string[]) =>
  ancestry.some((prelude) => prelude.includes(needle))

/** Every rule whose selector list mentions `selector` anywhere. */
function selecting(selector: string): Rule[] {
  return rules.filter(
    (rule) => !rule.prelude.startsWith('@') && rule.prelude.includes(selector),
  )
}

/**
 * Every rule that styles exactly `selector` inside a guard, in source order.
 * A compound match rather than a substring one, so `.nd-glass-subtle` does not
 * also collect `:root[data-nd-glass='off'] .nd-glass-subtle`.
 */
function stackFor(selector: string, within: (ancestry: string[]) => boolean): Rule[] {
  const found = rules.filter(
    (rule) =>
      !rule.prelude.startsWith('@') &&
      rule.prelude.split(',').some((part) => part.trim() === selector) &&
      within(rule.ancestry),
  )
  expect(found.length, `expected at least one rule for \`${selector}\``).toBeGreaterThan(0)
  return found
}

/** The one rule that styles `selector` inside a guard. */
function ruleFor(selector: string, within: (ancestry: string[]) => boolean): Rule {
  const found = stackFor(selector, within)
  expect(found.length, `expected exactly one rule for \`${selector}\``).toBe(1)
  return found[0]
}

/** A property's effective value for `selector` in a guard, last declaration wins. */
function effective(
  selector: string,
  within: (ancestry: string[]) => boolean,
  property: string,
): string | undefined {
  let value: string | undefined
  for (const rule of stackFor(selector, within)) {
    if (declares(rule, property)) value = declaration(rule, property)
  }
  return value
}

/** A declaration's value, from a rule's own declarations. */
function declaration(rule: Rule, property: string): string {
  const found = declarations(rule).match(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`))
  expect(found?.[1], `${rule.prelude} should declare ${property}`).toBeTruthy()
  return found![1].trim().replace(/\s+/g, ' ')
}

const declares = (rule: Rule, property: string) =>
  new RegExp(`(?:^|[;{\\s])${property}:`).test(declarations(rule))

// ---- tokens -----------------------------------------------------------------------

/**
 * A token's literal value. `glass.css` first, then `index.css`, because this
 * file deliberately reuses the claim surface's tokens rather than restating
 * them — and a reuse that silently fell back to a default would be a reuse in
 * name only.
 */
function token(name: string, depth = 0): string {
  const pattern = new RegExp(`${name}:\\s*([^;]+);`)
  const value = (css.match(pattern) ?? indexCss.match(pattern))?.[1]?.trim()
  expect(value, `${name} should be declared in glass.css or index.css`).toBeTruthy()
  const indirect = value!.replace(/\s+/g, ' ').match(/^var\((--[\w-]+)\)$/)
  if (indirect) {
    expect(depth, `${name} loops through var()`).toBeLessThan(8)
    return token(indirect[1], depth + 1)
  }
  return value!.replace(/\s+/g, ' ')
}

const num = (name: string) => Number(token(name))

/** A colour value, following `var()` first. */
function colour(value: string): { rgb: Rgb; alpha: number } {
  const indirect = value.trim().match(/^var\((--[\w-]+)\)$/)
  return parseColour(indirect ? token(indirect[1]) : value.trim())
}

/** Every colour in a value, gradients included. */
function colours(value: string): { rgb: Rgb; alpha: number }[] {
  const found = value.match(/var\(--[\w-]+\)|rgba?\([^)]*\)|#[0-9a-f]{6}/gi) ?? []
  return found
    .filter((item) => {
      if (!item.startsWith('var(')) return true
      // A radius or a duration is not a colour; only follow tokens that are.
      try {
        colour(item)
        return true
      } catch {
        return false
      }
    })
    .map(colour)
}

// ---- the field, and the panels on it ----------------------------------------------

/**
 * The brightest pixel the field can physically reach, derived in the order the
 * browser composites, exactly as `surface.contrast.test.ts` derives it: the base
 * radial's lightest stop, the static counter-light, the bloom's core at its
 * post-claim peak, then a fully lit grain pixel on top of all of it.
 *
 * Blur is not modelled and does not need to be — averaging can only move a
 * pixel towards the mean, so the brightest unblurred pixel bounds the brightest
 * blurred one, and being wrong in that direction is the correct direction.
 */
const FIELD_MAX: Rgb = (() => {
  let field = colour(token('--nd-field-base-max')).rgb
  for (const [fill, opacity] of [
    ['--nd-counter-fill', '--nd-counter-o'],
    ['--nd-bloom-core', '--nd-bloom-o-warm'],
  ] as const) {
    const { rgb, alpha } = colour(token(fill))
    field = over(rgb, alpha * num(opacity), field)
  }
  return over([255, 255, 255], num('--nd-grain-o'), field)
})()

/** The field as `backdrop-filter`'s own `saturate()` hands it to the fill. */
const THROUGH = saturate(FIELD_MAX, Number(token('--nd-saturate').replace('%', '')) / 100)

/** A fill composited over a backdrop, at whatever alpha it declares. */
const on = (value: string, backdrop: Rgb): Rgb => {
  const { rgb, alpha } = colour(value)
  return over(rgb, alpha, backdrop)
}

const INK = colour(token('--nd-on-surface')).rgb
const MUTED = colour(token('--nd-on-surface-muted'))
const GOLD = colour(token('--nd-lg-accent-ok')).rgb

const inkOn = (bg: Rgb) => round2(contrastRatio(INK, bg))
const mutedOn = (bg: Rgb) => round2(contrastRatio(over(MUTED.rgb, MUTED.alpha, bg), bg))
const goldOn = (bg: Rgb) => round2(contrastRatio(GOLD, bg))

/**
 * The six surfaces this file can produce, on the field's worst case. The strong
 * panel's fills are gradients and are taken at their THINNER end, which is the
 * one every floor is computed against.
 */
const SUBTLE_GLASS = on(token('--nd-lg-fill'), THROUGH)
const STRONG_GLASS = on(token('--nd-lg-fill-strong-bottom'), THROUGH)
const SUBTLE_FLAT = colour(token('--color-field')).rgb
const STRONG_FLAT = on(token('--nd-barrier-flat-bottom'), FIELD_MAX)
const SUBTLE_SOLID = colour(token('--color-field')).rgb
const STRONG_SOLID = colour(token('--color-sheet')).rgb

// ===================================================================================

describe('the names', () => {
  /**
   * `.nd-glass` is the claim card in `index.css` and its `::before` is already
   * the sheet's grab handle. This file introduces a `::before` of its own, so a
   * class named `.nd-glass` here would delete that handle and re-pad the surface
   * that hands out money — from a file the card's tests do not read.
   */
  it('does not redefine the claim card', () => {
    for (const rule of rules) {
      if (rule.prelude.startsWith('@')) continue
      for (const selector of rule.prelude.split(',')) {
        expect(selector.trim(), 'glass.css must not restyle .nd-glass').not.toMatch(
          /(^|[\s>+~])\.nd-glass(?![\w-])/,
        )
      }
    }
    expect(indexRaw).toContain('.nd-glass::before')
  })

  it('offers both variants', () => {
    expect(selecting('.nd-glass-subtle').length).toBeGreaterThan(0)
    expect(selecting('.nd-glass-strong').length).toBeGreaterThan(0)
  })
})

describe('the fallback chain', () => {
  /**
   * Near-opaque means every colour a rule can paint is at 90% alpha or more.
   * The gradients are checked stop by stop rather than at their darkest, since
   * the thinnest stop is what a reader actually gets at the panel's thin end.
   */
  function expectNearlyOpaque(selector: string, within: (ancestry: string[]) => boolean) {
    const values = ['background-color', 'background-image']
      .map((property) => effective(selector, within, property))
      .filter((value): value is string => value !== undefined && value !== 'none')
    expect(values.length, `${selector} should paint something opaque`).toBeGreaterThan(0)
    for (const value of values) {
      for (const { alpha } of colours(value)) {
        expect(alpha, `${selector}: ${value} should be nearly opaque`).toBeGreaterThanOrEqual(0.9)
      }
    }
  }

  /**
   * The base rules ARE the no-`backdrop-filter` path. `index.css` arranges it
   * the same way and the arrangement is the point: the blur is added inside
   * `@supports` rather than subtracted inside `@supports not`, so a renderer
   * nobody anticipated lands on the legible path by default instead of by a
   * second declaration that has to be kept in agreement with the first.
   */
  it('gives a renderer with no backdrop-filter a nearly opaque panel', () => {
    expectNearlyOpaque('.nd-glass-subtle', unguarded)
    expectNearlyOpaque('.nd-glass-strong', unguarded)

    const blurred = rules.filter((rule) => /backdrop-filter:\s*blur/.test(declarations(rule)))
    expect(blurred.length).toBeGreaterThan(0)
    for (const rule of blurred) {
      expect(rule.ancestry.join(' '), `${rule.prelude} must be guarded`).toMatch(
        /@supports.*backdrop-filter/,
      )
      // And gated a second time, on the runtime having decided this device can
      // afford it. `ui/surface.ts` owns that attribute.
      expect(rule.prelude).toContain("[data-nd-glass='on']")
    }
  })

  it('gives Reduce Transparency a nearly opaque panel', () => {
    const guard = inside('prefers-reduced-transparency: reduce')
    for (const selector of ['.nd-glass-subtle', '.nd-glass-strong']) {
      expectNearlyOpaque(selector, guard)
      // Solid means solid, not "a bit less blur".
      expect(effective(selector, guard, 'background-image')).toBe('none')
      expect(effective(selector, guard, 'backdrop-filter')).toBe('none')
      expect(effective(selector, guard, '-webkit-backdrop-filter')).toBe('none')
      // The masked ring is transparency in the sense the setting means.
      expect(declaration(ruleFor(`${selector}::before`, guard), 'display')).toBe('none')
    }
  })

  it('gives the runtime kill switch a nearly opaque panel', () => {
    for (const selector of [
      ":root[data-nd-glass='off'] .nd-glass-subtle",
      ":root[data-nd-glass='off'] .nd-glass-strong",
    ]) {
      expectNearlyOpaque(selector, unguarded)
      expect(effective(selector, unguarded, 'background-image')).toBe('none')
      expect(effective(selector, unguarded, 'backdrop-filter')).toBe('none')
      expect(effective(selector, unguarded, '-webkit-backdrop-filter')).toBe('none')
      expect(declaration(ruleFor(`${selector}::before`, unguarded), 'display')).toBe('none')
    }
  })
})

describe('the gradient stroke', () => {
  const stroke = () => ruleFor('.nd-glass-strong::before', inside('mask-composite'))

  /**
   * The technique itself: a filled, radius-inheriting pseudo-element whose own
   * middle is cut out by two masks composited with `xor`/`exclude`. What
   * survives is exactly the padding, which is the only way to draw a gradient
   * that follows a `border-radius`.
   */
  it('draws a masked ring rather than a border', () => {
    const rule = stroke()
    expect(declaration(rule, 'content')).toBe("''")
    expect(declaration(rule, 'position')).toBe('absolute')
    expect(declaration(rule, 'inset')).toBe('0')
    expect(declaration(rule, 'border-radius')).toBe('inherit')
    expect(declaration(rule, 'padding')).toBe('var(--nd-lg-stroke)')
    expect(declaration(rule, 'pointer-events')).toBe('none')

    for (const property of ['-webkit-mask', 'mask']) {
      const value = declaration(rule, property)
      expect(value).toContain('linear-gradient(#fff 0 0) content-box')
      expect(value.match(/linear-gradient\(#fff 0 0\)/g)).toHaveLength(2)
    }
    expect(declaration(rule, '-webkit-mask-composite')).toBe('xor')
    expect(declaration(rule, 'mask-composite')).toBe('exclude')
  })

  /**
   * Unmasked, this pseudo-element is a filled rectangle sitting on top of the
   * panel's content — a headline that has vanished. A renderer that cannot cut
   * the hole must not be given the ring at all; it keeps the plain hairline the
   * base rules already drew.
   */
  it('is not drawn at all where the mask cannot be composited', () => {
    for (const rule of rules) {
      if (!/::before/.test(rule.prelude)) continue
      if (!declares(rule, 'content')) continue
      expect(rule.ancestry.join(' '), `${rule.prelude} must be guarded`).toMatch(
        /@supports.*mask-composite/,
      )
    }
    // Both spellings, because Firefox implements `mask-composite: exclude` and
    // not `-webkit-mask-composite`, and WebKit the other way round.
    const guard = rules.find((rule) => rule.prelude.includes('mask-composite'))!.prelude
    expect(guard).toContain('-webkit-mask-composite: xor')
    expect(guard).toContain('mask-composite: exclude')
  })

  /** Bright at the top, bright again at the foot, effectively nothing between. */
  it('runs bright at both ends and transparent through the middle', () => {
    const gradient = declaration(stroke(), 'background')
    expect(gradient).toMatch(/linear-gradient\(\s*180deg/)
    const stops = colours(gradient).map(({ alpha }) => alpha)
    expect(stops.length).toBeGreaterThanOrEqual(4)
    const [top, ...rest] = stops
    const foot = rest.pop()!
    expect(top).toBeGreaterThan(0.3)
    expect(foot).toBeGreaterThan(0.15)
    expect(foot, 'the bounce is always weaker than the source').toBeLessThan(top)
    for (const middle of rest) {
      expect(middle, 'the middle should read as transparent').toBeLessThan(0.05)
    }
  })

  /** The inside of the same edge: the lit top catching the bloom. */
  it('lights the inside of the edge too', () => {
    for (const selector of ['.nd-glass-subtle', '.nd-glass-strong']) {
      const shadow = effective(selector, unguarded, 'box-shadow')
      expect(shadow, `${selector} should carry the inset highlight`).toBeTruthy()
      expect(shadow).toMatch(/inset 0 1px 1px/)
      expect(colour(shadow!.replace(/^inset 0 1px 1px /, ''))).toEqual({
        rgb: [255, 255, 255],
        alpha: 0.1,
      })
    }
  })
})

describe('the blur budget', () => {
  /**
   * Two radii and no dial. A 4px frost lets you read what is behind it; 44px
   * destroys the backdrop and leaves only its light. Anything between is a 4px
   * panel that costs more.
   */
  it('spends only at the two ends', () => {
    const subtle = Number(token('--nd-lg-blur').replace('px', ''))
    const strong = Number(token('--nd-lg-blur-strong').replace('px', ''))
    expect(subtle).toBeGreaterThan(0)
    expect(subtle).toBeLessThanOrEqual(8)
    expect(strong).toBeGreaterThanOrEqual(40)
    expect(strong).toBeLessThanOrEqual(50)
  })

  /**
   * `saturate()` is what stops frosted glass reading as grey plastic over a GREY
   * backdrop, and does the opposite over this one. `index.css` measured 120% as
   * the ceiling — 160% clips the blue channel flat and takes secondary copy on
   * the card under its floor — and the same backdrop is behind these panels.
   */
  it('never saturates past the ceiling index.css computed', () => {
    for (const rule of rules) {
      for (const value of declarations(rule).match(/backdrop-filter:\s*([^;]+);/g) ?? []) {
        const saturation = value.match(/saturate\((var\(--[\w-]+\)|[^)]+)\)/)
        if (!saturation) continue
        expect(saturation[1]).toBe('var(--nd-saturate)')
      }
    }
    expect(Number(token('--nd-saturate').replace('%', ''))).toBeLessThanOrEqual(120)
  })

  /**
   * `will-change` on many elements is worse than none: each one is a promise to
   * the compositor to hold a layer. `index.css` makes exactly two, for the two
   * things written every frame. A landing panel is not one of them.
   */
  it('promotes nothing and animates nothing', () => {
    expect(css).not.toContain('will-change')
    expect(css).not.toMatch(/(^|[;\s])animation(-name)?:/)
  })

  /**
   * `PRODUCT.md` allows motion past 300ms at exactly one moment, and it is the
   * reveal. A surface transition is functional feedback.
   */
  it('keeps its transitions inside the functional-feedback budget', () => {
    const durations = [...css.matchAll(/transition:[^;]*?var\((--nd-t-[\w-]+)\)/g)].map((m) => m[1])
    expect(durations.length).toBeGreaterThan(0)
    for (const name of new Set(durations)) {
      expect(Number(token(name).replace('ms', '')), name).toBeLessThan(300)
    }
  })
})

describe('contrast, computed from the tokens', () => {
  /**
   * The strong panel is the one that may carry a paragraph, so the whole ink
   * system has to clear 4.5:1 on it — at its thinner end, over the brightest
   * pixel the field can physically reach, through `saturate()`.
   */
  it('holds every ink role on the strong panel', () => {
    expect(inkOn(STRONG_GLASS)).toBeGreaterThanOrEqual(4.5)
    expect(mutedOn(STRONG_GLASS)).toBeGreaterThanOrEqual(4.5)
    expect(goldOn(STRONG_GLASS)).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * The subtle panel is a shape, not a page: full-strength ink and hairlines.
   * What it must never do is be WORSE than the bare field it sits on, which is
   * the failure a near-invisible fill invites — and it is not, because the fill
   * subtracts light where the field's own worst case adds it.
   */
  it('leaves the subtle panel better than the field it sits on', () => {
    expect(inkOn(SUBTLE_GLASS)).toBeGreaterThanOrEqual(4.5)
    expect(inkOn(SUBTLE_GLASS)).toBeGreaterThanOrEqual(inkOn(FIELD_MAX))
  })

  /**
   * Degrading may not cost a reader anything. Each of the two opaque paths is
   * checked against the glass path it replaces, pair by pair, rather than
   * assumed from the fact that the fills are thicker.
   */
  it('never regresses on a fallback path', () => {
    for (const [name, glass, fallback] of [
      ['subtle / flat', SUBTLE_GLASS, SUBTLE_FLAT],
      ['subtle / solid', SUBTLE_GLASS, SUBTLE_SOLID],
      ['strong / flat', STRONG_GLASS, STRONG_FLAT],
      ['strong / solid', STRONG_GLASS, STRONG_SOLID],
    ] as const) {
      expect(inkOn(fallback), `${name}: ink`).toBeGreaterThanOrEqual(inkOn(glass))
      expect(mutedOn(fallback), `${name}: muted`).toBeGreaterThanOrEqual(mutedOn(glass))
    }
  })
})

describe('the display face', () => {
  const face = css.match(/@font-face\s*\{([^}]*)\}/)?.[1] ?? ''

  it('declares one italic face, swapped, self-hosted', () => {
    expect(face).toMatch(/font-family:\s*'Instrument Serif'/)
    expect(face).toMatch(/font-style:\s*italic/)
    /* One weight is loaded, so `.nd-display` has to pin it — see below. */
    expect(face).toMatch(/font-weight:\s*400/)
    expect(face).toMatch(/font-display:\s*swap/)
    expect(face).toMatch(/src:\s*url\('\/fonts\/[\w-]+\.woff2'\) format\('woff2'\)/)
    /* One face, not a family's worth. */
    expect(css.match(/@font-face/g)).toHaveLength(1)
  })

  /**
   * The latin subset's own range, copied from the subset the file contains.
   * Anything outside it falls through to Mulish — which does ship latin-ext —
   * rather than dragging a second file down a phone connection for headings
   * that are our own English copy.
   */
  it('declares the range the file actually covers', () => {
    const range = face.match(/unicode-range:\s*([^;]+);/)?.[1].replace(/\s+/g, ' ')
    expect(range).toBeTruthy()
    expect(range).toContain('U+0000-00FF')
    /* Curly quotes, the en and em dashes, the ellipsis. */
    expect(range).toContain('U+2000-206F')
    expect(range).not.toContain('U+1E00-1E9F')
  })

  /**
   * The app runs in the Nimiq Pay WebView. A third-party font request there is
   * a render-blocking dependency on a host, a network and a CSP we do not
   * control, and it hands that host a request-time log of every claimant.
   */
  it('depends on no third party', () => {
    for (const source of [css, html]) {
      expect(source).not.toContain('fonts.googleapis.com')
      expect(source).not.toContain('fonts.gstatic.com')
    }
    expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
    expect(css).not.toMatch(/url\(\s*['"]?https?:/)
  })

  it('ships the font and its licence, at a size a phone can afford', () => {
    const file = face.match(/url\('(\/fonts\/[\w-]+\.woff2)'\)/)![1]
    const bytes = statSync(resolve(process.cwd(), 'public', file.slice(1))).size
    expect(bytes).toBeGreaterThan(0)
    expect(bytes, 'a display face is not worth more than the UI face').toBeLessThan(60_000)
    /* The licence travels with the file, exactly as `mulish-OFL.txt` does. */
    expect(statSync(resolve(process.cwd(), 'public/fonts/instrument-serif-OFL.txt')).size)
      .toBeGreaterThan(1000)
    expect(
      readFileSync(resolve(process.cwd(), 'public/fonts/instrument-serif-OFL.txt'), 'utf8'),
    ).toContain('SIL Open Font License')
  })

  it('exposes the face as a token and a class', () => {
    expect(token('--nd-font-display')).toContain("'Instrument Serif'")
    /* No `system-ui`: a token whose meaning the host decides resolved to a
       MONOSPACE face during this project's own review. */
    expect(token('--nd-font-display')).not.toContain('system-ui')
    expect(token('--nd-font-display')).toMatch(/serif\s*$/)

    const display = ruleFor('.nd-display', unguarded)
    expect(declaration(display, 'font-family')).toBe('var(--nd-font-display)')
    expect(declaration(display, 'font-style')).toBe('italic')
    /**
     * Load-bearing. Headings default to bold and exactly one weight of this
     * face is loaded, so an unpinned heading asks for a bold that does not
     * exist and gets a synthesised smear at display size.
     */
    expect(declaration(display, 'font-weight')).toBe('400')
    /**
     * Unitless, which is what makes the box's height a multiple of its
     * font-size rather than a function of the font's metrics — and therefore
     * what lets `font-display: swap` land without moving anything vertically.
     */
    expect(declaration(display, 'line-height')).toMatch(/^[\d.]+$/)
  })
})
