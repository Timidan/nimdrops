/**
 * The surface's engineering contract: the blur budget, and the containment and
 * reduced-motion invariants inherited from the envelope this direction deleted.
 *
 * Everything here that reads the stylesheet rather than the DOM does so ON
 * PURPOSE. jsdom has no layout engine and no animation engine: `scrollWidth`,
 * `clientWidth` and every rect it hands back are hardcoded zeros, so an
 * overflow assertion made against it would pass whatever the CSS said and
 * defend nothing. The invariants are therefore checked where they actually
 * live, in the declarations, and the measured versions live in `/preview` and
 * in the Playwright pass recorded in `docs/design/shipped/`.
 *
 * ## What was carried over from `Envelope.test.tsx`, and what was not
 *
 * Carried (behaviour):
 *   - the reveal is a STATE, not a keyframe: nothing on the claim path is
 *     hidden by default and revealed by a class-triggered transition;
 *   - `prefers-reduced-motion` zeroes DELAYS as well as durations, on the
 *     universal selector, so nothing added later can escape it;
 *   - a transient decoration is never unmounted before its animation has spent
 *     itself;
 *   - the reveal cannot hand the page sideways scroll.
 *
 * Dropped (envelope-specific):
 *   - the five-stage reveal ladder (wax → flap → face → liner → bloom) and its
 *     ordering assertions. Direction C has one choreography beat, so there is
 *     no order left to assert; what replaced it is the single-duration check
 *     below.
 *   - the assertions naming `.nd-flap`, `.nd-wax-half` and `.nd-face`'s
 *     `translateY`. Those are the create flow's furniture now and are covered
 *     by that flow's own task.
 *   - `scale <= 1 in EVERY keyframe`. The literal rule is wrong for this
 *     direction: the field's lights are 78vmax circles hung outside the box
 *     that must scale past 1 to drift convincingly, and they are safe because
 *     `.nd-field` clips. The purpose is preserved by two narrower assertions:
 *     the field declares the clip, and the one decoration that is mounted
 *     transiently over content grows only up to `scale(1)`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BURST_MS } from './reveal'
import { assessSurface, type SurfaceEnv } from './surface'

/** Vitest runs with `web/` as its root, so the stylesheet is right there. */
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

/** What actually ships: the stylesheet with its commentary removed. */
const shipped = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The stylesheet this direction owns, which is now all of it. There used to be
 * a quarantined block past a LEGACY marker — the create flow's paper, its
 * envelope and its wax — held to older rules because the screen that used it
 * could not be edited. That screen is on the field now and the block went with
 * it, so the rules below apply to the whole file.
 */
const owned = shipped

/** The body of one top-level rule, by selector. */
function block(selector: string): string {
  const escaped = selector.replace(/[.[\]*+?^${}()|\\]/g, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^{}]*)\\}`))?.[1]
  expect(found, `${selector} should exist as a top-level rule`).toBeTruthy()
  return found!
}

const full: SurfaceEnv = {
  reducedTransparency: false,
  reducedMotion: false,
  coarsePointer: false,
  deviceMemory: 8,
  cores: 8,
  saveData: false,
  supportsBackdropFilter: true,
}

describe('the blur budget', () => {
  it('gives a capable device the whole thing', () => {
    expect(assessSurface(full)).toEqual({ glass: true, drift: true, reasons: [] })
  })

  /**
   * Reduce Transparency means SOLID. Halving an opacity is the reading that
   * misses the point of the setting, and it is the one most implementations
   * ship. Motion is a separate preference and is left alone.
   */
  it('swaps glass for a solid surface outright when transparency is reduced', () => {
    const out = assessSurface({ ...full, reducedTransparency: true })
    expect(out.glass).toBe(false)
    expect(out.drift).toBe(true)
    expect(out.reasons).toContain('reduced-transparency')
  })

  it('stops the drift but keeps the glass when motion is reduced', () => {
    const out = assessSurface({ ...full, reducedMotion: true })
    expect(out.drift).toBe(false)
    expect(out.glass).toBe(true)
  })

  /**
   * The device profile the direction was flagged risky for: a phone-shaped
   * thing with very little to spend. Both halves of the cost go at once,
   * because on that device the blur and the drift are the same problem.
   */
  it.each([
    ['4 GiB of memory', { coarsePointer: true, deviceMemory: 4, cores: 8 }],
    ['four cores', { coarsePointer: true, deviceMemory: 8, cores: 4 }],
    ['both', { coarsePointer: true, deviceMemory: 2, cores: 2 }],
  ])('degrades a coarse-pointer device with %s', (_name, over) => {
    const out = assessSurface({ ...full, ...over })
    expect(out.glass).toBe(false)
    expect(out.drift).toBe(false)
    expect(out.reasons).toContain('low-end-device')
  })

  /**
   * A coarse pointer on its own is not evidence of a slow device. Every tablet
   * and every touchscreen laptop has one, and degrading all of them would be
   * the cautious mistake that quietly deletes the direction.
   */
  it('does not degrade a touch device that is not short of anything', () => {
    expect(assessSurface({ ...full, coarsePointer: true })).toEqual({
      glass: true,
      drift: true,
      reasons: [],
    })
  })

  /** `deviceMemory` is Chromium-only. Unknown is not the same as low. */
  it('does not guess when the device reports nothing', () => {
    const out = assessSurface({ ...full, coarsePointer: true, deviceMemory: null, cores: null })
    expect(out).toEqual({ glass: true, drift: true, reasons: [] })
  })

  it('takes Data Saver as the explicit request it is', () => {
    const out = assessSurface({ ...full, saveData: true })
    expect(out.glass).toBe(false)
    expect(out.drift).toBe(false)
  })

  it('reports every reason that applied, not just the first', () => {
    const out = assessSurface({
      ...full,
      reducedTransparency: true,
      reducedMotion: true,
      coarsePointer: true,
      cores: 2,
    })
    expect(out.reasons).toEqual(
      expect.arrayContaining(['reduced-transparency', 'reduced-motion', 'low-end-device']),
    )
  })
})

describe('the field costs what it says it costs', () => {
  /**
   * The single most important performance decision on the screen. A gradient
   * animated by moving its position or resizing it is re-rasterised every
   * frame; a gradient animated by transform is painted once and moved by the
   * compositor. With a `backdrop-filter` sheet over it, that is the difference
   * between the blurred region re-reading a freshly painted backdrop sixty
   * times a second and re-reading a moved layer.
   */
  it('drifts on transform only, so nothing is re-rasterised per frame', () => {
    // One bloom, not three lights. Measured: blur is nearly free but drift is
    // not — a static field with glass holds ~60fps at 6x CPU throttle while a
    // drifting one falls to ~29fps. Three animated layers cost roughly three
    // times as much as one, and the reference this palette came from is lit by
    // a single source anyway, so consolidating buys back frames AND is what the
    // design wanted. The rule this test defends is unchanged: whatever drifts,
    // drifts on the compositor.
    const drifts = css.match(/@keyframes\s+nd-drift\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? []
    expect(drifts.length).toBe(1)

    for (const frames of drifts) {
      const declarations = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
      expect(declarations.length).toBeGreaterThan(0)
      for (const property of declarations) {
        expect(['transform', 'opacity']).toContain(property)
      }
    }
  })

  /**
   * Exactly one element in the whole stylesheet is ever blurred by
   * `backdrop-filter`, and it is a bounded sheet rather than the page. Blurring
   * a second region, or the page itself, is the failure mode this direction was
   * flagged risky for.
   */
  it('blurs exactly one bounded element, and never the page', () => {
    const blurred = [...css.matchAll(/([^{}]*)\{[^{}]*backdrop-filter:\s*blur/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    )
    expect(blurred.length).toBeGreaterThan(0)
    for (const selector of blurred) {
      expect(selector).toContain('.nd-glass')
    }
    /**
     * Bounded on both compositions, and the bound is a different axis on each.
     * The s4 sheet is edge to edge on a phone, so `max-width` is not what holds
     * it — it is anchored to the foot of the field and bounded in HEIGHT by its
     * own content, which is what the blur bill is actually proportional to. On
     * the poster it becomes a column, and there the bound is a width.
     */
    expect(block('.nd-glass')).toMatch(/flex:\s*0 0 auto/)
    const poster = css.match(/@container nd-field \(min-width: 54rem\)\s*\{\s*\.nd-glass\s*\{([^}]*)\}/)
    expect(poster?.[1], 'the poster sheet should declare a width bound').toMatch(
      /max-width:\s*var\(--nd-sheet-w\)/,
    )
  })

  /**
   * `will-change` on many elements is worse than none: each one is a promise to
   * the compositor to hold a layer.
   *
   * Two elements have it, and they are the only two things in the product that
   * are written to every frame: the bloom, which drifts, and the envelope's
   * shake, which is a transform recomputed per frame for the length of a hold.
   * The counter-light is static and is deliberately not promoted just because
   * it is a sibling, and the sealed screen has no `backdrop-filter` on it at
   * all, so the shake's layer never costs a blurred region a re-read.
   */
  it('promotes only what is written to every frame', () => {
    const hits = [...css.matchAll(/([^{}]*)\{[^{}]*will-change:/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    )
    expect(hits).toEqual(['.nd-field-light.is-bloom', '.nd-env-shake'])
  })

  /** Cost nobody can see is cost worth removing. */
  it('pauses the drift when the field is not on screen', () => {
    expect(css).toMatch(
      /\.nd-field\[data-awake='false'\]\s+\.nd-field-light\s*\{[^}]*animation-play-state:\s*paused/,
    )
  })

  it('stops the drift outright on a device that should not pay for it', () => {
    expect(css).toMatch(/:root\[data-nd-motion='off'\]\s+\.nd-field-light\s*\{[^}]*animation:\s*none/)
  })

  it('keeps the field a solid surface when it cannot be glass', () => {
    for (const selector of [
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]{0,400}?\.nd-glass\s*\{([^}]*)\}/,
      /:root\[data-nd-glass='off'\]\s+\.nd-glass\s*\{([^}]*)\}/,
    ]) {
      const rule = css.match(selector)?.[1]
      expect(rule).toBeTruthy()
      // Solid, not "a bit less blur".
      expect(rule).toMatch(/background-color:\s*var\(--color-sheet\)/)
      expect(rule).toMatch(/backdrop-filter:\s*none/)
    }
  })
})

/**
 * The layer stack `surface.contrast.test.ts` computes its floors against.
 *
 * That file gives two pieces of secondary copy credit for sitting on a scrim,
 * and it composites a fully lit grain pixel onto everything. Both are claims
 * about what the field is physically made of, so both are checked here rather
 * than assumed there. If the stack changes and these fail, the contrast model
 * is wrong before any ratio is.
 */
describe('the field is stacked the way the contrast model says it is', () => {
  /**
   * The scrim has to hold FULL strength across the bands the masthead and the
   * custody line sit in, not peak at the very edge and immediately fade.
   * Furniture sits a few percent in from the edge, so a scrim that is already
   * half gone by then protects nothing — and the contrast model would be
   * claiming protection that is not there.
   */
  it('holds the top band at full strength across the masthead it protects', () => {
    const stops = block('.nd-field-scrim').match(/var\(--nd-scrim-[\w-]+\)\s+\d+%/g) ?? []
    const at = (token: string) =>
      stops
        .filter((s) => s.startsWith(`var(--nd-scrim-${token})`))
        .map((s) => Number(s.match(/(\d+)%/)![1]))

    /**
     * The masthead strapline is the ONLY secondary copy left on the bare field
     * — the s4 layout puts the sponsor block and the fact tiles on recesses and
     * the custody line on the card — and it is the one place the contrast model
     * takes credit for a scrim. So the top plateau has to outlast it.
     *
     * Measured in the owner's Chrome at 320x720, 390x844 and 1280x800: the
     * masthead occupies 2.1%-5.4% of the field's height.
     */
    const MASTHEAD_ENDS = 5.4
    const [topFrom, topTo] = at('top')
    expect(topFrom).toBe(0)
    expect(topTo, 'the top plateau must outlast the masthead').toBeGreaterThan(MASTHEAD_ENDS)

    /**
     * The bottom band takes no contrast credit at all any more: what sits in it
     * is the sheet, and everything on the sheet is computed against the
     * UNSCRIMMED field, which is pessimistic. It stays because a poster wants
     * weighted edges and because it darkens the backdrop the sheet blurs.
     */
    const [, bottomTo] = at('bottom')
    expect(bottomTo).toBe(100)
    expect(at('clear').length).toBeGreaterThan(0)
  })

  /**
   * The grain is the last layer under the content, above both the lights and
   * the scrim. That ORDER is what makes it part of every floor: it lifts the
   * scrimmed bands too, not only the bare field. Same z-index as the scrim, so
   * the order is decided by paint order in `Field.tsx`.
   */
  it('paints the grain above the scrim and below the content', () => {
    for (const selector of ['.nd-field-scrim', '.nd-field-texture']) {
      expect(block(selector)).toMatch(/z-index:\s*var\(--nd-z-texture\)/)
    }

    // The JSX only: the prose above it names the same classes in a different
    // order, and paint order is decided by the markup.
    const source = readFileSync(resolve(process.cwd(), 'src/ui/Field.tsx'), 'utf8')
    const field = source.slice(source.lastIndexOf('return ('))
    expect(field.indexOf('nd-field-scrim')).toBeLessThan(field.indexOf('nd-field-texture'))
    expect(field.indexOf('nd-field-texture')).toBeLessThan(field.indexOf('nd-field-inner'))
  })

  /**
   * The dither is not optional. It is the difference between a 100vmax gradient
   * that looks printed and one that rings on an 8-bit phone panel, and it is
   * also the layer that costs four points of bloom opacity. Deleting it to buy
   * that contrast back would be a real decision; it should not be reachable by
   * accident.
   */
  it('keeps the grain on, at an opacity the contrast model can read', () => {
    expect(block('.nd-field-texture')).toMatch(/opacity:\s*var\(--nd-grain-o\)/)
    expect(block('.nd-field-texture')).toContain('feTurbulence')
    expect(Number(owned.match(/--nd-grain-o:\s*([\d.]+);/)![1])).toBeGreaterThan(0)
  })
})

describe('nothing in the choreography can make the page scroll sideways', () => {
  /**
   * The dip replaced the ring, and it replaced the risk with it. An absolutely
   * positioned decoration counts towards the document's scrollable overflow at
   * its SCALED size, which is what made the ring's `scale(1)` bound a
   * correctness rule; a sheet that translates on Y cannot widen anything. The
   * assertion is therefore about the axis: the beat may move vertically and
   * must not move or scale horizontally.
   */
  it('moves the sheet on the vertical axis only', () => {
    const frames = css.match(/@keyframes\s+nd-dip\s*\{(?:[^{}]|\{[^{}]*\})*\}/)?.[0]
    expect(frames).toBeTruthy()
    const transforms = [...frames!.matchAll(/transform:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(transforms.length).toBeGreaterThan(0)
    for (const value of transforms) expect(value).toMatch(/^translateY\(-?[\d.]+px\)$/)
  })

  /**
   * The burst is the other new thing that could have done it: twenty-four
   * particles flying up to 160px from a point. `position: fixed` is what makes
   * that safe — a fixed element is outside the document's scrollable overflow
   * rectangle entirely — and it is a stronger guarantee than clipping, because
   * there is nothing left to escape from.
   */
  it('takes the burst out of the document overflow rectangle entirely', () => {
    expect(block('.nd-burst')).toMatch(/position:\s*fixed/)
    expect(block('.nd-burst')).toMatch(/pointer-events:\s*none/)
  })

  /**
   * The lights DO hang outside the box and DO scale past 1, which is why this
   * one matters more than it used to. `clip` rather than `hidden`, because the
   * field must not become a scroll container and take the page's own scrolling
   * away from it.
   */
  it('clips the field, so no light and no future decoration can escape it', () => {
    expect(block('.nd-field')).toMatch(/overflow:\s*clip/)
  })

  /** Unmounting early would cut a particle off mid-flight. */
  it('keeps the burst mounted for the whole of its longest particle', () => {
    const declared = block('.nd-bit').match(/animation:\s*nd-fly\s+var\((--[\w-]+)\)/)
    // The duration is a per-particle custom property, so the bound is the
    // constant the component unmounts on, checked against the reach of the
    // field in `SealedEnvelope.test.tsx`. Here: the class must not carry a
    // literal duration that could disagree with it.
    expect(declared ?? block('.nd-bit')).toBeTruthy()
    expect(BURST_MS).toBeGreaterThan(0)
  })
})

describe('prefers-reduced-motion', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

  it('is declared at all', () => {
    expect(css.indexOf('@media (prefers-reduced-motion: reduce)')).toBeGreaterThan(-1)
  })

  it('crushes the durations', () => {
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
  })

  /**
   * The trap, and the reason this is a separate assertion.
   *
   * Zeroing durations is not enough once anything is delayed. A reduced-motion
   * user would sit out the delay in front of a screen where nothing had
   * happened, then have the finished state appear all at once: a SLOWER reveal
   * than the animated one, made of nothing. Both delays have to be crushed
   * alongside both durations, and on the universal selector so that nothing
   * added later can escape it.
   */
  it('zeroes the delays too, not only the durations, and on the universal selector', () => {
    expect(reduced).toMatch(/transition-delay:\s*0m?s\s*!important/)
    expect(reduced).toMatch(/animation-delay:\s*0m?s\s*!important/)
    expect(reduced).toMatch(
      /\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-delay:\s*0m?s\s*!important/,
    )
    expect(reduced).toMatch(
      /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-delay:\s*0m?s\s*!important/,
    )
  })

  /** The field keeps its colour. Only the movement goes. */
  /**
   * Reduced motion must not mean a bare field. The bloom stops moving and holds
   * a *chosen* position, rather than freezing wherever its `from` frame happens
   * to sit — the difference between a composed still and an accident.
   *
   * The composed position is carried by `:root[data-nd-motion='off']` rather
   * than by the media block, because the same switch also serves the runtime
   * performance guard, which has to be able to stop the drift on a weak device
   * whose owner has expressed no motion preference at all. The media query is
   * still the thing that honours the preference: it crushes every duration to
   * 0.01ms, asserted above, so the drift is already dead by the time this
   * position applies. Both paths land on the same frame.
   */
  it('lands the bloom on a composed position rather than deleting it', () => {
    expect(css).toMatch(
      /:root\[data-nd-motion='off'\]\s+\.nd-field-light\.is-bloom\s*\{[^}]*transform:/,
    )
    expect(reduced).not.toMatch(/\.nd-field-light[^{]*\{[^}]*display:\s*none/)
  })

  it('drops the burst, which is the only thing with no still equivalent', () => {
    expect(reduced).toMatch(/\.nd-burst\s*\{[^}]*display:\s*none/)
  })

  /**
   * There is no hold under reduced motion — a plain tap opens the envelope — so
   * the two readings of the hold's progress have nothing to report and would be
   * two empty gauges under a control that does not use them.
   */
  it('drops both readings of a hold that no longer exists', () => {
    expect(reduced).toMatch(/\.nd-env-bar,\s*\n?\s*\.nd-env-ring\s*\{[^}]*display:\s*none/)
  })
})

describe('the money does not depend on the visual layer', () => {
  /**
   * The stylesheet half of rule 1. Nothing that carries money may start hidden,
   * because a transition that never fires — a headless renderer, a background
   * tab, reduced motion — then ships a blank claim screen. The rendered half is
   * in `pages/DropView.test.tsx`, against all thirteen states.
   */
  const CARRIERS = [
    '.nd-amount',
    '.nd-moneycap',
    '.nd-action',
    '.nd-glass',
    '.nd-field',
    '.nd-revealed',
    '.nd-upper',
    '.nd-money',
  ]

  it('never starts a money-carrying element hidden', () => {
    for (const selector of CARRIERS) {
      const rule = block(selector)
      expect(rule, selector).not.toMatch(/(^|[;\s])opacity:\s*0(\.0*)?\s*(;|$)/)
      expect(rule, selector).not.toMatch(/visibility:\s*hidden/)
      expect(rule, selector).not.toMatch(/display:\s*none/)
    }
  })

  it('puts no animation on any of them', () => {
    for (const selector of CARRIERS) {
      expect(block(selector), selector).not.toMatch(/(^|[;\s])animation(-name)?:/)
    }
  })

  /**
   * `nd-rise` is the one entrance left on the claim path, and it is on the
   * receipt. It must describe only where the element comes FROM: a `to` frame
   * setting opacity would make the resting state depend on the animation
   * having run.
   */
  it('describes only where an entrance comes from, never where it ends', () => {
    for (const name of ['nd-rise', 'nd-keyline', 'nd-dip']) {
      const frames = css.match(new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
      expect(frames, name).toBeTruthy()
      expect(frames, name).toMatch(/\bfrom\s*\{/)
      expect(frames, name).not.toMatch(/\bto\s*\{/)
      expect(frames, name).not.toMatch(/\b100%\s*\{/)
    }
  })
})

describe('the motion budget is one list, and everything picks from it', () => {
  it('states its durations and easings as tokens', () => {
    for (const token of [
      '--nd-ease',
      '--nd-ease-exit',
      '--nd-t-press',
      '--nd-t-state',
      '--nd-t-enter',
      '--nd-t-reveal',
      '--nd-t-dip',
    ]) {
      expect(css).toMatch(new RegExp(`${token}:\\s*\\S`))
    }
  })

  /**
   * One choreography idea per surface. Everything else is state feedback, and
   * state feedback that outlasts 300ms reads as lag rather than as polish.
   *
   * Two tokens are past 300ms and they are the two halves of ONE beat, fired by
   * one state transition: the sheet dips (`dip`) while the field's light comes
   * up and stays up (`reveal`). Adding a third name to this exception list
   * would be adding a second beat, which is the thing the rule exists to stop.
   */
  const CHOREOGRAPHY = ['reveal', 'dip']

  it('keeps every duration under 300ms except the one beat', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('html {'))
    const durations = [...root.matchAll(/--nd-t-([a-z]+):\s*(\d+)ms/g)]
    expect(durations.length).toBeGreaterThan(3)
    for (const [, name, value] of durations) {
      if (CHOREOGRAPHY.includes(name)) expect(Number(value), name).toBeLessThanOrEqual(1000)
      else expect(Number(value), name).toBeLessThanOrEqual(300)
    }
    expect(
      durations.filter(([, name]) => CHOREOGRAPHY.includes(name)).length,
      'the exception list is exactly the one beat',
    ).toBe(2)
  })

  /** No bounce, no elastic: the curve never overshoots. */
  it('uses an ease-out curve that does not overshoot', () => {
    const ease = css.match(/--nd-ease:\s*cubic-bezier\(([^)]*)\)/)?.[1]
    expect(ease).toBeTruthy()
    const points = ease!.split(',').map((n) => Number(n.trim()))
    expect(points).toHaveLength(4)
    expect(points[1]).toBeLessThanOrEqual(1)
    expect(points[3]).toBeLessThanOrEqual(1)
  })
})

describe('the z-index scale is semantic and complete', () => {
  it('declares every layer as a named token', () => {
    for (const token of [
      '--nd-z-base',
      '--nd-z-light',
      '--nd-z-texture',
      '--nd-z-content',
      '--nd-z-sticky',
      '--nd-z-scrim',
      '--nd-z-dialog',
      '--nd-z-toast',
    ]) {
      expect(css).toMatch(new RegExp(`${token}:\\s*\\d+`))
    }
  })

  /** No component invents a number, and nothing reaches for 999. */
  it('never writes a raw z-index in a rule', () => {
    const raw = [...owned.matchAll(/z-index:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((value) => !value.startsWith('var(--nd-z-'))
    expect(raw).toEqual([])
  })

  it('orders the scale the way the surfaces stack', () => {
    const value = (token: string) => Number(css.match(new RegExp(`${token}:\\s*(\\d+)`))![1])
    expect(value('--nd-z-light')).toBeLessThan(value('--nd-z-texture'))
    expect(value('--nd-z-texture')).toBeLessThan(value('--nd-z-content'))
    expect(value('--nd-z-content')).toBeLessThan(value('--nd-z-scrim'))
    expect(value('--nd-z-scrim')).toBeLessThan(value('--nd-z-dialog'))
    expect(value('--nd-z-dialog')).toBeLessThan(value('--nd-z-toast'))
  })
})

describe('the warm-neutral default is gone', () => {
  /**
   * `#fbf9f4` sat in the near-white warm band `PRODUCT.md` names as an
   * anti-reference, and the token name `--paper` is on the same list. The name
   * survives as a one-line bridge for the create flow, which may not be edited
   * from this task, but it resolves to the chroma-0 plate and the VALUE is
   * gone. The bridge line and this assertion go together.
   */
  it('has no #fbf9f4 anywhere in the shipped stylesheet', () => {
    // Commentary is allowed to name the value it replaced; CSS is not.
    expect(shipped.toLowerCase()).not.toContain('fbf9f4')
    expect(shipped.toLowerCase()).not.toContain('f0ebdd')
  })

  /**
   * The bridge is gone with the screen that needed it. `--color-paper` existed
   * for exactly one reason — `Create.tsx` still wrote `text-paper` while the
   * palette moved underneath it — and the stylesheet said to delete it with
   * that flow's redesign. This is that deletion, asserted so the name cannot
   * come back with the value behind it.
   */
  it('has no paper token, and no light paper surface for one to dress', () => {
    expect(css).not.toMatch(/--color-paper\s*:/)
    for (const gone of ['.nd-page', '.nd-envelope', '.nd-face', '.nd-wax', '.nd-flap']) {
      expect(shipped, `${gone} should be gone with the create flow's paper`).not.toContain(
        `${gone} {`,
      )
    }
  })
})
