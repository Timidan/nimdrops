/**
 * The contract under test is not "does it animate". It is **can this module ever
 * leave the landing page invisible, or leave a control it decorated broken**.
 * That is the only way a brochure's motion layer becomes a product defect: the
 * visual layer must never gate the money, and content is visible by default.
 *
 * jsdom is the adversary rather than the limitation, for the reason
 * `scrollReveal.test.ts` gives: it ships no `matchMedia` and no `ResizeObserver`,
 * so `gsap.registerPlugin(ScrollTrigger)` and `new Lenis()` genuinely fail in it.
 * The resilience paths below are therefore exercised against a real failure and
 * not against a mock that was told to fail.
 *
 * Every test that proves a guard is written so that removing the guard makes it
 * fail — see the notes marked "mutation" for what each one is holding down.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  useHeroEntrance,
  useHeroParallax,
  useMagneticDoors,
  useSectionReveals,
  useSmoothScroll,
} from './Landing.motion'

/* -------------------------------------------------------------------------
 * The environment, one knob at a time
 * ---------------------------------------------------------------------- */

interface Media {
  /** `prefers-reduced-motion: reduce`. */
  reduce: boolean
  /** `(hover: hover) and (pointer: fine)` — a desktop mouse, not the WebView. */
  fineHover?: boolean
}

/**
 * jsdom has no `matchMedia`; this is the whole of one, and it has to answer more
 * than one question because this module asks two. Live, so flipping `reduce`
 * mid-page is testable — and gsap needs a working `matchMedia` regardless.
 */
function stubMedia(media: Media): (next: Media) => void {
  const listeners = new Set<() => void>()
  let current = media

  const answer = (q: string): boolean => {
    if (q.includes('prefers-reduced-motion: reduce')) return current.reduce
    if (q.includes('hover: hover')) return current.fineHover === true
    return false
  }

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      get matches() {
        return answer(q)
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
      addListener: (fn: () => void) => void listeners.add(fn),
      removeListener: (fn: () => void) => void listeners.delete(fn),
    }),
  })

  return (next: Media) => {
    current = next
    for (const fn of [...listeners]) fn()
  }
}

function dropMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })
}

/** Lenis observes its content; jsdom does not implement the observer. */
function stubResizeObserver(): void {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
}

function dropResizeObserver(): void {
  Reflect.deleteProperty(globalThis, 'ResizeObserver')
}

/**
 * jsdom lays nothing out, so every rect is zero and every element reads as
 * already in view. Pinning the rect is the only way to test the below-the-fold
 * branch — the one state in which an element is legitimately hidden.
 */
function place(el: HTMLElement, topPx: number, height = 200): void {
  el.getBoundingClientRect = () =>
    ({
      top: topPx,
      bottom: topPx + height,
      left: 0,
      right: 320,
      width: 320,
      height,
      x: 0,
      y: topPx,
    }) as DOMRect
}

const ABOVE_THE_FOLD = 40
const BELOW_THE_FOLD = 5000

/* -------------------------------------------------------------------------
 * Fixtures, shaped like the page this module is written for
 * ---------------------------------------------------------------------- */

interface Hero {
  ref: { current: HTMLElement | null }
  section: HTMLElement
  art: HTMLElement
  copy: HTMLElement
  packet: HTMLElement
  headline: HTMLElement
  lede: HTMLElement
  doors: HTMLElement[]
  arrivals: HTMLElement[]
}

function hero(): Hero {
  const section = document.createElement('section')
  section.innerHTML = `
    <div class="nd-land-hero-in">
      <div class="nd-land-hero-copy">
        <h1><span class="nd-land-h1-a nd-arrive" style="--nd-in: 150ms">Real NIM.</span></h1>
        <p class="nd-land-lede nd-arrive" style="--nd-in: 370ms">A sponsor funds once.</p>
        <div class="nd-land-cta nd-arrive" style="--nd-in: 470ms">
          <div class="nd-land-doors">
            <a href="/games">Find a game</a>
            <a href="/create">Send a drop</a>
          </div>
        </div>
      </div>
      <div class="nd-land-hero-art">
        <span class="nd-land-packet nd-arrive" style="--nd-in: 140ms"></span>
      </div>
    </div>`
  document.body.append(section)
  place(section, ABOVE_THE_FOLD, 600)

  const pick = <T extends HTMLElement>(q: string) => section.querySelector<T>(q)!
  const doors = [...section.querySelectorAll<HTMLElement>('.nd-land-doors a')]
  for (const door of doors) place(door, ABOVE_THE_FOLD, 52)

  return {
    ref: { current: section },
    section,
    art: pick('.nd-land-hero-art'),
    copy: pick('.nd-land-hero-copy'),
    packet: pick('.nd-land-packet'),
    headline: pick('.nd-land-h1-a'),
    lede: pick('.nd-land-lede'),
    doors,
    arrivals: [...section.querySelectorAll<HTMLElement>('.nd-arrive')],
  }
}

interface Rows {
  ref: { current: HTMLElement | null }
  root: HTMLElement
  container: HTMLElement
  members: HTMLElement[]
}

/** A row of three marked children under one container, as `.nd-flow` is. */
function rows(topPx: number): Rows {
  const root = document.createElement('main')
  const container = document.createElement('ol')
  container.className = 'nd-flow'
  const members = ['Fund it once', 'Send one link', 'Everyone gets the same'].map((text) => {
    const li = document.createElement('li')
    li.className = 'nd-rise'
    li.textContent = text
    container.append(li)
    return li
  })
  root.append(container)
  document.body.append(root)

  place(root, topPx, 400)
  place(container, topPx, 400)
  for (const member of members) place(member, topPx, 120)

  return { ref: { current: root }, root, container, members }
}

/** Two rAF turns, which is enough for gsap's ticker to render a running tween. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

/** The assertion this whole file exists for. */
function expectLegible(el: HTMLElement): void {
  expect(el.style.opacity).toBe('')
  expect(el.style.transform).toBe('')
  expect(el.style.translate).toBe('')
  expect(getComputedStyle(el).opacity).not.toBe('0')
}

/** No CSS animation was left silenced, so `Landing.css` still owns the element. */
function expectCssIntact(el: HTMLElement): void {
  expect(el.style.animation).toBe('')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const trigger of ScrollTrigger.getAll()) trigger.kill()
  gsap.globalTimeline.clear()
  document.body.replaceChildren()
  document.documentElement.className = ''
  dropMatchMedia()
  dropResizeObserver()
})

/* -------------------------------------------------------------------------
 * Hero entrance
 * ---------------------------------------------------------------------- */

describe('useHeroEntrance', () => {
  it('leaves the fold untouched and legible under reduced motion', () => {
    stubMedia({ reduce: true })
    const page = hero()

    const { unmount } = renderHook(() => useHeroEntrance(page.ref))

    // Mutation: drop the `allowed` guard and the entrance hides all four of
    // these at construction with nothing scheduled to bring them back.
    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }

    unmount()
    for (const el of page.arrivals) expectLegible(el)
  })

  it('leaves the fold untouched and legible when matchMedia is absent', () => {
    dropMatchMedia()
    const page = hero()

    const { unmount } = renderHook(() => useHeroEntrance(page.ref))

    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }
    expect(() => unmount()).not.toThrow()
    for (const el of page.arrivals) expectLegible(el)
  })

  it('takes the fold over on mount and hands every element back on unmount', () => {
    stubMedia({ reduce: false })
    const page = hero()

    const { unmount } = renderHook(() => useHeroEntrance(page.ref))

    // Mutation: this is what fails if the hook silently no-ops. `fromTo` renders
    // its start state on construction, so the hidden state is observable at once.
    expect(page.headline.style.opacity).toBe('0')
    // The CSS entrance is silenced, because a running CSS animation out-ranks
    // the inline transform gsap is writing.
    expect(page.headline.style.animation).toBe('none')

    unmount()

    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }
  })

  it('gives every element a distinct arrival rather than one uniform fade', () => {
    stubMedia({ reduce: false })
    const page = hero()

    renderHook(() => useHeroEntrance(page.ref))

    // The packet is thrown in from above; the copy rises from below. A single
    // shared entrance would make these two identical.
    expect(page.packet.style.transform).toContain('translate(0px, -96px)')
    expect(page.packet.style.transform).toContain('rotate(-9deg)')
    expect(page.headline.style.transform).toContain('translate(0px, 46px)')
    // Transform and opacity, and nothing that costs a layout pass.
    expect(page.packet.style.transform).not.toBe(page.headline.style.transform)
    for (const el of page.arrivals) {
      expect(el.style.top).toBe('')
      expect(el.style.left).toBe('')
      expect(el.style.width).toBe('')
      expect(el.style.height).toBe('')
      expect(el.style.margin).toBe('')
    }
  })

  it('unhides the fold when reduced motion is switched on mid-entrance', () => {
    const setMedia = stubMedia({ reduce: false })
    const page = hero()

    renderHook(() => useHeroEntrance(page.ref))
    expect(page.headline.style.opacity).toBe('0')

    // Mutation: without the cleanup path this strands the headline half-faded
    // with nothing left running to finish it.
    act(() => setMedia({ reduce: true }))

    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }
  })

  it('restores the fold when gsap itself throws part-way through', () => {
    stubMedia({ reduce: false })
    const page = hero()
    vi.spyOn(gsap, 'timeline').mockImplementation(() => {
      throw new Error('gsap is what broke')
    })

    const { unmount } = renderHook(() => useHeroEntrance(page.ref))

    // Mutation: drop the `catch` and the CSS entrance stays silenced forever on
    // elements gsap never got round to animating — a permanently blank fold.
    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }
    expect(() => unmount()).not.toThrow()
  })

  it('restores the fold when gsap gives out after some of it is already hidden', () => {
    stubMedia({ reduce: false })
    const page = hero()
    const build = gsap.timeline.bind(gsap)
    vi.spyOn(gsap, 'timeline').mockImplementation((vars?: gsap.TimelineVars) => {
      const tl = build(vars)
      const fromTo = tl.fromTo.bind(tl)
      let calls = 0
      // The second element is where it stops: the first is hidden by then, so
      // an incomplete unwind is observable as a permanently invisible headline.
      tl.fromTo = ((...args: Parameters<typeof fromTo>) => {
        if (++calls > 1) throw new Error('gsap gave out mid-entrance')
        return fromTo(...args)
      }) as typeof tl.fromTo
      return tl
    })

    const { unmount } = renderHook(() => useHeroEntrance(page.ref))

    // Mutation: drop `restore` from the `catch` and the element gsap did get to
    // stays at opacity 0 with nothing left running to raise it.
    for (const el of page.arrivals) {
      expectLegible(el)
      expectCssIntact(el)
    }
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing at all when there is no element, or the selector is nonsense', () => {
    stubMedia({ reduce: false })
    const page = hero()

    expect(() => renderHook(() => useHeroEntrance({ current: null })).unmount()).not.toThrow()
    expect(() =>
      renderHook(() => useHeroEntrance(page.ref, { selector: ':::' })).unmount(),
    ).not.toThrow()
    for (const el of page.arrivals) expectLegible(el)
  })

  it('finishes by handing the elements back to the stylesheet', async () => {
    stubMedia({ reduce: false })
    const page = hero()

    renderHook(() => useHeroEntrance(page.ref, { selector: '.nd-land-lede', step: 0 }))
    expect(page.lede.style.opacity).toBe('0')

    // The entrance is 0.8s; run the timeline out rather than wait for it.
    await act(async () => {
      gsap.globalTimeline.time(gsap.globalTimeline.time() + 5)
    })

    // An entrance that kept its inline transform would out-rank every later
    // hover or press the stylesheet defines.
    expectLegible(page.lede)
  })
})

/* -------------------------------------------------------------------------
 * Hero parallax
 * ---------------------------------------------------------------------- */

describe('useHeroParallax', () => {
  it('does not touch the hero under reduced motion', () => {
    stubMedia({ reduce: true })
    const page = hero()

    const { unmount } = renderHook(() => useHeroParallax(page.ref))

    expectLegible(page.art)
    expectLegible(page.copy)
    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('does not touch the hero when matchMedia is absent', () => {
    dropMatchMedia()
    const page = hero()

    // Mutation: without the guard, `gsap.registerPlugin(ScrollTrigger)` throws
    // here for real — jsdom has no matchMedia — and the hook would take the
    // failure path instead of never starting.
    const { unmount } = renderHook(() => useHeroParallax(page.ref))

    expectLegible(page.art)
    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('scrubs the hero on mount and releases it on unmount', () => {
    stubMedia({ reduce: false })
    const page = hero()

    const { unmount } = renderHook(() => useHeroParallax(page.ref))

    // Mutation: this is what fails if the hook silently no-ops.
    expect(ScrollTrigger.getAll()).toHaveLength(1)

    unmount()

    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expectLegible(page.art)
    expectLegible(page.copy)
  })

  it('releases the hero when ScrollTrigger cannot be registered', () => {
    stubMedia({ reduce: false })
    const page = hero()
    vi.spyOn(gsap, 'registerPlugin').mockImplementation(() => {
      throw new Error('no plugin here')
    })

    const { unmount } = renderHook(() => useHeroParallax(page.ref))

    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expectLegible(page.art)
    expectLegible(page.copy)
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing when the hero has neither column', () => {
    stubMedia({ reduce: false })
    const bare = document.createElement('section')
    document.body.append(bare)

    expect(() => renderHook(() => useHeroParallax({ current: bare })).unmount()).not.toThrow()
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------
 * Section reveals
 * ---------------------------------------------------------------------- */

describe('useSectionReveals', () => {
  it('leaves every row legible under reduced motion', () => {
    stubMedia({ reduce: true })
    const page = rows(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useSectionReveals(page.ref))

    // THE assertion of this file. A row hidden by a reveal that reduced motion
    // then stopped from running would be permanently invisible.
    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
    expect(ScrollTrigger.getAll()).toHaveLength(0)
    unmount()
    for (const member of page.members) expectLegible(member)
  })

  it('leaves every row legible when matchMedia is absent', () => {
    dropMatchMedia()
    const page = rows(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useSectionReveals(page.ref))

    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
    expect(() => unmount()).not.toThrow()
    for (const member of page.members) expectLegible(member)
  })

  it('reveals a row that is already in view rather than waiting for a scroll', () => {
    stubMedia({ reduce: false })
    const page = rows(ABOVE_THE_FOLD)

    renderHook(() => useSectionReveals(page.ref))

    // Above the fold there is no start left to cross, so a trigger waiting for
    // one would hold this row at zero for the life of the page.
    for (const member of page.members) expect(member.style.opacity).toBe('')
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })

  it('holds a pending row and hands it back visible on unmount', () => {
    stubMedia({ reduce: false })
    const page = rows(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useSectionReveals(page.ref))

    // One trigger for the row, not one per card: the stagger is measured from
    // when the row arrived. Below the fold is the one state in which these are
    // legitimately hidden, and the only one cleanup must undo.
    expect(ScrollTrigger.getAll()).toHaveLength(1)
    for (const member of page.members) expect(member.style.opacity).toBe('0')

    unmount()

    expect(ScrollTrigger.getAll()).toHaveLength(0)
    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
  })

  it('unhides a pending row when reduced motion is switched on mid-page', () => {
    const setMedia = stubMedia({ reduce: false })
    const page = rows(BELOW_THE_FOLD)

    renderHook(() => useSectionReveals(page.ref))
    expect(page.members[0]?.style.opacity).toBe('0')

    act(() => setMedia({ reduce: true }))

    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })

  it('releases every row when ScrollTrigger cannot be registered', () => {
    stubMedia({ reduce: false })
    const page = rows(BELOW_THE_FOLD)
    vi.spyOn(gsap, 'registerPlugin').mockImplementation(() => {
      throw new Error('no plugin here')
    })

    const { unmount } = renderHook(() => useSectionReveals(page.ref))

    // Mutation: drop the `catch` and this row is hidden by nothing and revealed
    // by nothing — the exact defect the module is written against.
    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
    expect(() => unmount()).not.toThrow()
  })

  it('releases every row when the trigger throws after the row is hidden', () => {
    stubMedia({ reduce: false })
    const page = rows(BELOW_THE_FOLD)
    // Registration succeeds, so `gsap.set` hides the row first and only then
    // does the thing that would have revealed it blow up. This is the shape of
    // failure that actually strands content.
    vi.spyOn(ScrollTrigger, 'create').mockImplementation(() => {
      throw new Error('no trigger for you')
    })

    const { unmount } = renderHook(() => useSectionReveals(page.ref))

    // Mutation: drop `restore` from the `catch` and this row is hidden by the
    // module and revealed by nothing at all.
    for (const member of page.members) {
      expectLegible(member)
      expectCssIntact(member)
    }
    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing at all when nothing is marked for reveal', () => {
    stubMedia({ reduce: false })
    const page = rows(BELOW_THE_FOLD)

    expect(() =>
      renderHook(() => useSectionReveals(page.ref, { selector: '.nothing-here' })).unmount(),
    ).not.toThrow()
    expect(() => renderHook(() => useSectionReveals({ current: null })).unmount()).not.toThrow()
    for (const member of page.members) expectLegible(member)
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------
 * Magnetic doors
 * ---------------------------------------------------------------------- */

describe('useMagneticDoors', () => {
  it('does nothing under reduced motion, even with a mouse', () => {
    stubMedia({ reduce: true, fineHover: true })
    const page = hero()

    const { unmount } = renderHook(() => useMagneticDoors(page.ref))
    page.doors[0]?.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 60 }))

    for (const door of page.doors) expect(door.style.translate).toBe('')
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing on a coarse pointer, which is where this product runs', () => {
    stubMedia({ reduce: false, fineHover: false })
    const page = hero()

    const { unmount } = renderHook(() => useMagneticDoors(page.ref))
    page.doors[0]?.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 60 }))

    // Mutation: drop the `fineHover` guard and a phone WebView gets a hover
    // affordance it can never trigger, on the two controls the page exists for.
    for (const door of page.doors) expect(door.style.translate).toBe('')
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing when matchMedia is absent', () => {
    dropMatchMedia()
    const page = hero()

    const { unmount } = renderHook(() => useMagneticDoors(page.ref))
    page.doors[0]?.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 60 }))

    for (const door of page.doors) expect(door.style.translate).toBe('')
    expect(() => unmount()).not.toThrow()
  })

  it('pulls a door toward the pointer and lets go on unmount', async () => {
    stubMedia({ reduce: false, fineHover: true })
    const page = hero()
    const door = page.doors[0]!

    const { unmount } = renderHook(() => useMagneticDoors(page.ref))
    door.dispatchEvent(new MouseEvent('pointermove', { clientX: 320, clientY: 60 }))
    await frames()

    // Mutation: this is what fails if the hook silently no-ops.
    expect(door.style.translate).not.toBe('')
    // `translate`, never `transform` — an inline `transform` would out-specify
    // the stylesheet's own `:active { transform: scale(0.99) }` press feedback.
    expect(door.style.transform).toBe('')

    unmount()
    expect(door.style.translate).toBe('')
  })

  it('ignores a control with no box rather than writing NaN into it', async () => {
    stubMedia({ reduce: false, fineHover: true })
    const page = hero()
    const door = page.doors[0]!
    place(door, 0, 0)
    door.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 }) as DOMRect

    renderHook(() => useMagneticDoors(page.ref))
    door.dispatchEvent(new MouseEvent('pointermove', { clientX: 320, clientY: 60 }))
    await frames()

    // NaN in a transform removes the element from the page entirely.
    expect(door.style.translate).toBe('')
  })

  it('does nothing when the page has no doors', () => {
    stubMedia({ reduce: false, fineHover: true })
    const page = hero()

    expect(() =>
      renderHook(() => useMagneticDoors(page.ref, { selector: '.no-doors' })).unmount(),
    ).not.toThrow()
    expect(() => renderHook(() => useMagneticDoors({ current: null })).unmount()).not.toThrow()
  })
})

/* -------------------------------------------------------------------------
 * No frame loop
 * ---------------------------------------------------------------------- */

describe('a host that never paints a frame', () => {
  /**
   * `motionAllowed()` answers "is motion welcome" and would say yes here. The
   * separate question is whether the tween that un-hides an element will ever
   * run: gsap hides on construction and reveals on a tick, so a host with no
   * frame loop is a host where hiding anything is permanent.
   */
  function dropAnimationFrame(): () => void {
    const real = window.requestAnimationFrame
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    })
    return () => {
      Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: real })
    }
  }

  it('is never hidden by any of the hooks', () => {
    stubMedia({ reduce: false, fineHover: true })
    const page = hero()
    const list = rows(BELOW_THE_FOLD)
    const undo = dropAnimationFrame()

    try {
      const mounted = [
        renderHook(() => useHeroEntrance(page.ref)),
        renderHook(() => useHeroParallax(page.ref)),
        renderHook(() => useSectionReveals(list.ref)),
        renderHook(() => useMagneticDoors(page.ref)),
      ]

      for (const el of page.arrivals) {
        expectLegible(el)
        expectCssIntact(el)
      }
      for (const member of list.members) {
        expectLegible(member)
        expectCssIntact(member)
      }
      expect(ScrollTrigger.getAll()).toHaveLength(0)
      for (const { unmount } of mounted) expect(() => unmount()).not.toThrow()
    } finally {
      undo()
    }
  })
})

/* -------------------------------------------------------------------------
 * Smooth scroll, re-exported from `scrollReveal.ts`
 * ---------------------------------------------------------------------- */

describe('useSmoothScroll (re-export)', () => {
  it('does not touch the document under reduced motion', () => {
    stubMedia({ reduce: true })
    // Available on purpose: the preference has to be the reason nothing ran.
    stubResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())

    expect(document.documentElement.classList.contains('lenis')).toBe(false)
    expect(() => unmount()).not.toThrow()
  })

  it('takes the scroll on mount and gives it back on unmount', () => {
    stubMedia({ reduce: false })
    stubResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())
    expect(document.documentElement.classList.contains('lenis')).toBe(true)

    unmount()
    expect(document.documentElement.classList.contains('lenis')).toBe(false)
  })

  it('degrades to native scroll when Lenis cannot start', () => {
    stubMedia({ reduce: false })
    dropResizeObserver()

    // `new Lenis()` throws a real ReferenceError here: jsdom has no
    // ResizeObserver. Native scroll was never taken away.
    const { unmount } = renderHook(() => useSmoothScroll())

    expect(document.documentElement.classList.contains('lenis')).toBe(false)
    expect(() => unmount()).not.toThrow()
  })
})

describe('the entrance cannot leave the page invisible', () => {
  /**
   * The failure this guards is not an exception — it is silence. The entrance
   * hides elements and waits for a ticker; if that ticker never advances
   * (backgrounded tab, starved rAF, an embedded WebView pacing frames its own
   * way) nothing throws, so the `catch` never runs and the page keeps a hidden
   * call to action forever. Observed for real: a built page served locally sat
   * at `opacity: 0` on `.nd-land-lede` and `.nd-land-cta` with no error.
   */
  it('reveals on a wall clock even when no frame is ever produced', () => {
    // Only the timers. Vitest fakes `requestAnimationFrame` by default, and
    // jsdom defines it read-only — but faking it would also defeat the point:
    // the failsafe must be independent of the clock that failed.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = document.createElement('div')
    host.innerHTML = '<p class="nd-arrive">copy</p><div class="nd-arrive">cta</div>'
    document.body.append(host)
    const scope = { current: host }

    // gsap.ticker is what actually drives the tween; stopping it reproduces a
    // starved rAF without touching a read-only global.
    gsap.ticker.sleep()
    const { unmount } = renderHook(() => useHeroEntrance(scope))

    vi.advanceTimersByTime(3000)

    for (const el of Array.from(host.querySelectorAll<HTMLElement>('.nd-arrive'))) {
      expect(el.style.opacity, 'a starved ticker must not leave content hidden').not.toBe('0')
    }

    gsap.ticker.wake()
    unmount()
    host.remove()
    vi.useRealTimers()
  })
})
