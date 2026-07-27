/**
 * The reveal, held to the same three rules the claim surface is held to.
 *
 * jsdom has no CSS engine, no compositor and no clock, which is exactly the
 * property that makes it the right harness for the rule that matters most:
 * nothing here can be made to appear by a transition, a keyframe or a media
 * query, because none of those exist. If the revealed state renders its amount
 * here, it renders it in a headless renderer, in a background tab, and under
 * reduced motion.
 *
 * The rules, restated because this file exists to defend them:
 *
 *   1. the amount renders with CSS animation and transitions disabled ENTIRELY,
 *      and is never gated on a class-triggered transition;
 *   2. `opened` is a STATE — a reload, a resumed claim or a poll tick lands on
 *      it with no theatre and no re-fire;
 *   3. the ritual runs BEFORE the wallet signature, never after, and never
 *      gates it;
 *   4. there is a path to the money that is not a sustained gesture, because on
 *      a phone with VoiceOver or TalkBack running a press-and-hold never
 *      reaches the element at all.
 *
 * What is checked against the stylesheet rather than the DOM is checked there
 * on purpose: jsdom returns hardcoded zeros for every rect, so an overflow or
 * a touch-target assertion made against it would pass whatever the CSS said.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SealedReveal, { revealCss } from './SealedReveal'
import {
  BURST_MS,
  buzzPlan,
  canVibrate,
  confetti,
  CONFETTI_COUNT,
  HOLD_MS,
  HOLD_OPTIONS,
  openAbility,
  resolveHoldMs,
  shakeAt,
  SHAKE_PEAK_PX,
  shards,
  SHARD_COUNT,
} from './reveal'

afterEach(cleanup)

const css = revealCss('x')

/** The body of one top-level rule in the generated stylesheet, by selector. */
function block(selector: string): string {
  const escaped = selector.replace(/[.[\]*+?^${}()|\\]/g, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^{}]*)\\}`))?.[1]
  expect(found, `${selector} should exist as a top-level rule`).toBeTruthy()
  return found!
}

function view(over: Partial<React.ComponentProps<typeof SealedReveal>> = {}) {
  return render(
    <SealedReveal
      prefix="x"
      amount="5"
      ability="can-open"
      publicId="Ab3Cd4Ef5Gh6Ij7Kl8Mn9O"
      deepLink="nimiqpay://miniapp?url=https%3A%2F%2Fexample.test%2Fdrop%2F1"
      action={<button type="button">Open 5 NIM</button>}
      {...over}
    />,
  )
}

/* -------------------------------------------------------------------------
 * The tunable
 * ---------------------------------------------------------------------- */

describe('the hold duration is one named constant', () => {
  it('offers exactly the three the owner is choosing between', () => {
    expect([...HOLD_OPTIONS]).toEqual([1200, 2500, 5000])
    expect(HOLD_OPTIONS).toContain(HOLD_MS)
  })

  it('falls back to the default rather than trusting a query string', () => {
    expect(resolveHoldMs('1200')).toBe(1200)
    expect(resolveHoldMs('5000')).toBe(5000)
    for (const junk of [null, undefined, '', 'forever', '-1', '99999', '0'])
      expect(resolveHoldMs(junk)).toBe(HOLD_MS)
  })
})

/* -------------------------------------------------------------------------
 * The money
 * ---------------------------------------------------------------------- */

describe('the money never depends on the visual layer', () => {
  it('renders the revealed amount complete, with no CSS engine in the room', () => {
    view({ initialOpened: true })
    const hero = screen.getByTestId('amount-hero')
    expect(hero.textContent).toMatch(/5\s*NIM/)
    expect(hero.getAttribute('aria-label')).toBe('5 NIM')
  })

  it('hides nothing inline on the revealed state', () => {
    view({ initialOpened: true })
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="reveal-stage"] *'))) {
      expect(el.style.opacity, el.className.toString()).not.toBe('0')
      expect(el.style.display).not.toBe('none')
      expect(el.style.visibility).not.toBe('hidden')
    }
  })

  /**
   * The stylesheet half of the same rule. Nothing that carries the amount may
   * start hidden or carry an animation, because a transition that never fires —
   * headless, background tab, reduced motion — would then ship a blank claim
   * screen, which is a financial bug wearing a costume.
   */
  it.each(['.x-rv-plate', '.x-rv-amount', '.x-rv-platecap'])(
    'never starts %s hidden, and never animates it',
    (selector) => {
      const rule = block(selector)
      expect(rule).not.toMatch(/(^|[;\s])opacity:\s*0(\.0*)?\s*(;|$)/)
      expect(rule).not.toMatch(/visibility:\s*hidden/)
      expect(rule).not.toMatch(/display:\s*none/)
      expect(rule).not.toMatch(/(^|[;\s])animation(-name)?:/)
      expect(rule).not.toMatch(/(^|[;\s])transition:/)
    },
  )

  it('gives the amount tabular figures, so it cannot jitter', () => {
    // The lockup's own contract, from `nimkit.ts`: the figure is a `.nim-figure`
    // run and the shared kit gives that class `tabular-nums`.
    view({ initialOpened: true })
    expect(document.querySelector('.nim-figure')?.textContent).toBe('5')
  })

  /**
   * Rule 3, and the reason the whole thing is arranged this way: the ritual
   * runs in FRONT of the money action. Asking a stranger to approve a
   * transaction blind and then telling them what they got is what a scam does,
   * so there is no claim button on screen at all until the number is.
   */
  it('shows the claim action only once the amount is on screen', () => {
    view()
    expect(screen.queryByRole('button', { name: /open 5 nim/i })).toBeNull()

    fireEvent.click(screen.getByTestId('hold-open'), { detail: 0 })

    const hero = screen.getByTestId('amount-hero')
    const claim = screen.getByRole('button', { name: /open 5 nim/i })
    expect(hero.compareDocumentPosition(claim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------
 * Opened is a state
 * ---------------------------------------------------------------------- */

describe('opened is a state, not the end of a keyframe', () => {
  it('lands a resumed claim on the opened state with no theatre', () => {
    view({ initialOpened: true })
    expect(screen.getByTestId('revealed')).toBeTruthy()
    expect(screen.queryByTestId('burst')).toBeNull()
    expect(screen.queryByTestId('hold-open')).toBeNull()
  })

  it('does not move focus when it merely mounted opened', () => {
    view({ initialOpened: true })
    expect(document.activeElement).toBe(document.body)
  })

  it('fires the burst once, on the transition, and never again', () => {
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 0 })
    expect(screen.getByTestId('burst')).toBeTruthy()

    // Moving on through the surface's later states must not mount a second one.
    screen.getByTestId('burst').remove()
    fireEvent.click(screen.getByTestId('revealed'))
    expect(screen.queryByTestId('burst')).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * The path that is not a hold
 * ---------------------------------------------------------------------- */

describe('a screen reader must not be locked out of the money', () => {
  it('is a real button that says what will happen', () => {
    view()
    const control = screen.getByRole('button', { name: /hold to open/i })
    expect(control.tagName).toBe('BUTTON')
    expect(control.getAttribute('type')).toBe('button')
    // The hold length and the reassurance are in the description, not the name.
    const described = document.getElementById(control.getAttribute('aria-describedby')!)
    expect(described?.textContent).toMatch(/2\.5 seconds/)
    expect(described?.textContent).toMatch(/signs nothing/i)
  })

  /**
   * `detail === 0` is a click with no pointer behind it: a key, or the
   * synthesised activation an assistive double-tap produces. It must reach the
   * money with no sustained gesture at all.
   */
  it('opens on a keyboard or assistive activation, with no hold', () => {
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 0 })
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/5\s*NIM/)
  })

  it('announces the opening, and puts focus on the amount', () => {
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 0 })
    expect(screen.getByRole('status').textContent).toMatch(/opened/i)
    expect(document.activeElement).toBe(screen.getByTestId('revealed'))
  })

  /** A pointer's own click is the tail of a press the hold already owns. */
  it('does not open on a plain tap', () => {
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 1 })
    expect(screen.queryByTestId('amount-hero')).toBeNull()
  })

  /**
   * The belt to that braces. The detail heuristic is right for every assistive
   * layer that synthesises a click, but TalkBack can pass a real gesture
   * through instead, and a hand that shakes cannot hold anything for two
   * seconds. So there is a second, plainly-labelled control, in the
   * accessibility tree from the first render.
   */
  it('always offers a way out that is not a gesture', () => {
    view()
    const escape = screen.getByRole('button', { name: /open it without holding/i })
    expect(escape.getAttribute('data-shown')).toBe('false')
    fireEvent.click(escape)
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/5\s*NIM/)
  })

  it('brings that way out on screen after one early release, with no error copy', () => {
    view()
    const control = screen.getByTestId('hold-open')
    fireEvent.pointerDown(control, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(control, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })

    expect(screen.getByTestId('open-without-holding').getAttribute('data-shown')).toBe('true')
    // Still openable, immediately, with no penalty and nothing scolding.
    expect(screen.getByTestId('hold-open')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/failed|error|try again|too short/i)
  })

  /** Under reduced motion there is no hold at all: a tap lands on the amount. */
  it('drops the hold requirement entirely under reduced motion', () => {
    stubMotion(true)
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 1 })
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/5\s*NIM/)
    // And no particles, ever.
    expect(screen.queryByTestId('burst')).toBeNull()
    stubMotion(false)
  })
})

/* -------------------------------------------------------------------------
 * A PC cannot open a packet
 * ---------------------------------------------------------------------- */

describe('the state a PC gets', () => {
  it('is decided by whether a wallet can sign, not by a viewport', () => {
    expect(openAbility('unavailable')).toBe('sealed-only')
    expect(openAbility('real')).toBe('can-open')
    expect(openAbility('mock')).toBe('can-open')
  })

  it('shows a sealed envelope with no press affordance on it', () => {
    view({ ability: 'sealed-only' })
    expect(screen.getByTestId('sealed-envelope')).toBeTruthy()
    expect(screen.queryByTestId('hold-open')).toBeNull()
    expect(screen.queryByRole('button', { name: /hold/i })).toBeNull()
  })

  /** The seal is the seal. The number waits for the device that can act on it. */
  it('keeps the amount concealed, while saying what kind of thing is inside', () => {
    view({ ability: 'sealed-only' })
    expect(screen.queryByTestId('amount-hero')).toBeNull()
    expect(screen.getByTestId('sealed-only').textContent).toMatch(/same size/i)
  })

  /**
   * The QR is server-rendered, so it can be absent: an id the route will not
   * encode, a stale cache, no network. A broken-image icon in the middle of the
   * only screen a PC ever sees is worse than no QR, and the link is what the
   * person actually needs, so that is what the failure resolves to.
   */
  it('falls back to the link itself when the QR cannot be drawn', () => {
    view({ ability: 'sealed-only' })
    const qr = screen.getByRole('img', { name: /qr/i })
    expect(qr.getAttribute('src')).toBe('/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O/qr.svg')

    fireEvent.error(qr)

    expect(screen.queryByRole('img', { name: /qr/i })).toBeNull()
    const fallback = screen.getByTestId('qr-fallback')
    expect(fallback.textContent).toMatch(/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O/)
    expect(fallback.textContent).not.toMatch(/error|failed|sorry|unable/i)
  })

  it('is an invitation and not a failure', () => {
    view({ ability: 'sealed-only' })
    const text = screen.getByTestId('reveal-stage').textContent ?? ''
    expect(text).not.toMatch(/unsupported|not supported|error|cannot|unavailable|sorry/i)
    expect(screen.getByRole('link', { name: /open in nimiq pay/i })).toBeTruthy()
    expect(screen.getByRole('img', { name: /qr/i })).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------
 * The gesture, on a phone
 * ---------------------------------------------------------------------- */

describe('the gesture is built for a thumb', () => {
  /**
   * The three declarations without which the ritual is interrupted by the
   * platform: a scroll the browser decides to start three seconds in, Android's
   * context menu, and iOS's callout and magnifier.
   */
  it('refuses to let the platform steal a held contact', () => {
    const rule = block('.x-rv-env')
    expect(rule).toMatch(/touch-action:\s*none/)
    expect(rule).toMatch(/user-select:\s*none/)
    expect(rule).toMatch(/-webkit-touch-callout:\s*none/)
    expect(rule).toMatch(/-webkit-tap-highlight-color:/)
  })

  it('suppresses the long-press context menu in script as well as in CSS', () => {
    view()
    const menu = fireEvent.contextMenu(screen.getByTestId('hold-open'))
    // `fireEvent` returns false when a handler called preventDefault.
    expect(menu).toBe(false)
  })

  /**
   * The whole envelope is the target, so there is nothing to aim at: 292px
   * across at an aspect of 1.45, which is 292x201. jsdom cannot measure it, so
   * the declaration is what is checked.
   */
  it('makes the envelope itself the target, far past the 44px floor', () => {
    const rule = block('.x-rv-env')
    const width = rule.match(/width:\s*min\(100%,\s*(\d+)px\)/)?.[1]
    const aspect = rule.match(/aspect-ratio:\s*([\d.]+)/)?.[1]
    expect(Number(width)).toBeGreaterThanOrEqual(44)
    expect(Number(width) / Number(aspect)).toBeGreaterThanOrEqual(44)
    // And the way out is a control in its own right, not a 20px link.
    expect(block('.x-rv-escape')).toMatch(/min-height:\s*44px/)
  })

  /**
   * A regression, and it shipped looking plausible.
   *
   * The flap's foil crease was one `clip-path` polygon tracing an outer
   * triangle and then an inner one — the usual CSS trick for a hairline border
   * on a clipped shape. `clip-path` fills with the NONZERO rule, so the inner
   * contour does not subtract and the hairline painted as a solid gold triangle
   * across the whole flap. Nothing failed; the envelope simply stopped being a
   * red packet and became a gold one, and the wax stopped being the only gold
   * on the screen.
   *
   * jsdom cannot see it, and neither can a human reading the polygon. What can
   * be checked is the shape of the rule: a clipped hairline is an inset overlay
   * here, and any polygon complex enough to be attempting the ring trick has to
   * say `evenodd` out loud.
   */
  it('draws the foil crease as an inset, not a self-intersecting outline', () => {
    const crease = block('.x-rv-flap::after')
    expect(crease).toMatch(/inset:\s*[\d.]+px/)

    for (const [, points] of css.matchAll(/clip-path:\s*polygon\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      const corners = points.split(',').length
      if (corners > 4) expect(points.trimStart().startsWith('evenodd')).toBe(true)
    }
  })

  it('grows the shake with the hold, and keeps it small enough to read past', () => {
    const at = (p: number) => Math.abs(shakeAt(p, 37).x)
    expect(shakeAt(0, 0)).toEqual({ x: 0, y: 0, deg: 0 })
    // Amplitude is progress squared: nearly still early, straining late.
    expect(at(0.9)).toBeGreaterThan(at(0.5))
    expect(at(0.5)).toBeGreaterThan(at(0.2))
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      for (const t of [0, 11, 37, 120, 480, 2500]) {
        const { x, y, deg } = shakeAt(p, t)
        expect(Math.abs(x)).toBeLessThanOrEqual(SHAKE_PEAK_PX)
        expect(Math.abs(y)).toBeLessThanOrEqual(SHAKE_PEAK_PX)
        expect(Math.abs(deg)).toBeLessThan(1)
      }
    }
  })

  it('clamps out of range rather than flying apart', () => {
    expect(Math.abs(shakeAt(4, 100).x)).toBeLessThanOrEqual(SHAKE_PEAK_PX)
    const below = shakeAt(-3, 100)
    for (const value of [below.x, below.y, below.deg]) expect(Math.abs(value)).toBe(0)
  })
})

/* -------------------------------------------------------------------------
 * Haptics
 * ---------------------------------------------------------------------- */

describe('vibration is garnish, and is detected rather than assumed', () => {
  it('escalates, in both length and cadence', () => {
    const plan = buzzPlan()
    expect(plan.length).toBeGreaterThan(3)
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].at).toBeGreaterThan(plan[i - 1].at)
      expect(plan[i].ms).toBeGreaterThan(plan[i - 1].ms)
      // Closer together as it goes: the gap shrinks.
      if (i > 1) {
        expect(plan[i].at - plan[i - 1].at).toBeLessThanOrEqual(plan[i - 1].at - plan[i - 2].at)
      }
    }
    // Nothing long enough to be a buzzer.
    for (const step of plan) expect(step.ms).toBeLessThanOrEqual(30)
  })

  it('feature-detects, because iOS has never had it', () => {
    expect(canVibrate(undefined)).toBe(false)
    expect(canVibrate({} as Navigator)).toBe(false)
    expect(canVibrate({ vibrate: () => true } as unknown as Navigator)).toBe(true)
  })

  it('never lets a blocked vibrate take the hold with it', () => {
    const vibrate = vi.fn(() => {
      throw new Error('blocked by the host')
    })
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    view()
    const control = screen.getByTestId('hold-open')
    expect(() =>
      fireEvent.pointerDown(control, { button: 0, pointerId: 1, clientX: 5, clientY: 5 }),
    ).not.toThrow()
    fireEvent.pointerUp(control, { button: 0, pointerId: 1 })
    // The gesture still ran, and the way out still appeared.
    expect(screen.getByTestId('open-without-holding').getAttribute('data-shown')).toBe('true')
    Reflect.deleteProperty(navigator, 'vibrate')
  })
})

/* -------------------------------------------------------------------------
 * The burst
 * ---------------------------------------------------------------------- */

describe('the burst cannot hand the page sideways scroll', () => {
  it('clips the stage it lives in', () => {
    expect(block('.x-rv-stage')).toMatch(/overflow:\s*clip/)
  })

  it('is bounded in count', () => {
    expect(confetti()).toHaveLength(CONFETTI_COUNT)
    expect(shards()).toHaveLength(SHARD_COUNT)
    expect(CONFETTI_COUNT + SHARD_COUNT).toBeLessThanOrEqual(32)
  })

  /**
   * Bounded in reach as well as in count. A particle that flies 900px costs the
   * compositor a 900px layer for a second, on the phone that can least spare
   * it, and it is also the thing that would escape the clip on a short screen.
   */
  it('is bounded in reach', () => {
    for (const piece of [...confetti(), ...shards()]) {
      expect(Math.abs(piece.dx)).toBeLessThanOrEqual(160)
      expect(Math.abs(piece.dy)).toBeLessThanOrEqual(180)
      expect(piece.size).toBeLessThanOrEqual(30)
    }
  })

  /** Nothing may still be moving when the field unmounts itself. */
  it('finishes inside the window it is mounted for', () => {
    for (const piece of [...confetti(), ...shards()]) {
      expect(piece.delay + piece.dur).toBeLessThanOrEqual(BURST_MS)
    }
  })

  it('animates on transform and opacity only', () => {
    const frames = css.match(/@keyframes\s+x-rv-fly\s*\{(?:[^{}]|\{[^{}]*\})*\}/)?.[0]
    expect(frames).toBeTruthy()
    const properties = [...frames!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
    expect(properties.length).toBeGreaterThan(0)
    for (const property of properties) expect(['transform', 'opacity']).toContain(property)
  })

  it('is decoration, and says so', () => {
    view()
    fireEvent.click(screen.getByTestId('hold-open'), { detail: 0 })
    expect(screen.getByTestId('burst').getAttribute('aria-hidden')).toBe('true')
  })

  it('is deterministic, so a screenshot of it is reproducible', () => {
    expect(confetti()).toEqual(confetti())
    expect(confetti(4, 1)).not.toEqual(confetti(4, 2))
  })
})

/* -------------------------------------------------------------------------
 * Reduced motion
 * ---------------------------------------------------------------------- */

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
   * The trap. Zeroing durations is not enough once anything is delayed: the
   * reduced-motion user would sit out the delay in front of a screen where
   * nothing had happened, then have the finished state appear all at once — a
   * SLOWER reveal than the animated one, made of nothing. Both delays go too,
   * and on the universal selector, so nothing added later can escape it.
   */
  it('zeroes the delays too, on the universal selector', () => {
    expect(reduced).toMatch(
      /\*,\s*\.x-rv-stage \*::before,\s*\.x-rv-stage \*::after\s*\{[^}]*animation-delay:\s*0m?s\s*!important/,
    )
    expect(reduced).toMatch(/transition-delay:\s*0m?s\s*!important/)
  })

  it('drops the burst, which is the only thing with no still equivalent', () => {
    expect(reduced).toMatch(/\.x-rv-burst\s*\{[^}]*display:\s*none/)
  })
})

/** jsdom has no `matchMedia`; this is the whole of one. */
function stubMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: reduce && q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
}
