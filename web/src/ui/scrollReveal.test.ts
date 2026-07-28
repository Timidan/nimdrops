/**
 * The contract under test is not "does it animate". It is **can this module
 * ever leave content invisible**, which is the only way a decorative scroll
 * reveal turns into a product defect (`PRODUCT.md`: never let the visual layer
 * gate the money).
 *
 * jsdom is a useful adversary here rather than a limitation. It has no
 * `matchMedia` and no `ResizeObserver`, so both libraries genuinely fail in it —
 * `gsap.registerPlugin(ScrollTrigger)` throws on the first, `new Lenis()` on the
 * second — which means the resilience paths below are exercised for real and not
 * against a mock that was told to fail.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { motionAllowed, useScrollReveal, useSmoothScroll } from './scrollReveal'

/* -------------------------------------------------------------------------
 * The environment, one knob at a time
 * ---------------------------------------------------------------------- */

/**
 * jsdom has no `matchMedia`; this is the whole of one. It is live — the returned
 * setter flips the answer and notifies, because a preference the reader changes
 * mid-page is a real case and gsap needs a working `matchMedia` regardless.
 */
function stubMotion(reduce: boolean): (next: boolean) => void {
  const listeners = new Set<() => void>()
  let current = reduce

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      get matches() {
        return current && q.includes('prefers-reduced-motion')
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
      addListener: (fn: () => void) => void listeners.add(fn),
      removeListener: (fn: () => void) => void listeners.delete(fn),
    }),
  })

  return (next: boolean) => {
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

function target(topPx: number): { el: HTMLElement; ref: { current: HTMLElement | null } } {
  const el = document.createElement('section')
  el.textContent = 'A sponsor funds once.'
  document.body.append(el)
  // jsdom lays nothing out, so every rect is zero and every element reads as
  // already in view. This is the only way to test the below-the-fold branch.
  el.getBoundingClientRect = () =>
    ({
      top: topPx,
      bottom: topPx + 200,
      left: 0,
      right: 320,
      width: 320,
      height: 200,
      x: 0,
      y: topPx,
    }) as DOMRect
  return { el, ref: { current: el } }
}

const ABOVE_THE_FOLD = 40
const BELOW_THE_FOLD = 5000

afterEach(() => {
  cleanup()
  for (const trigger of ScrollTrigger.getAll()) trigger.kill()
  document.body.replaceChildren()
  document.documentElement.className = ''
  dropMatchMedia()
  dropResizeObserver()
})

/* -------------------------------------------------------------------------
 * The decision
 * ---------------------------------------------------------------------- */

describe('motionAllowed', () => {
  it('refuses when the platform cannot answer the question', () => {
    dropMatchMedia()
    expect(motionAllowed()).toBe(false)
  })

  it('refuses under prefers-reduced-motion: reduce', () => {
    stubMotion(true)
    expect(motionAllowed()).toBe(false)
  })

  it('allows motion only on an explicit no-preference', () => {
    stubMotion(false)
    expect(motionAllowed()).toBe(true)
  })

  it('treats the runtime motion budget as a refusal', () => {
    document.documentElement.dataset.ndMotion = 'off'
    try {
      expect(motionAllowed()).toBe(false)
    } finally {
      delete document.documentElement.dataset.ndMotion
    }
  })
})

/* -------------------------------------------------------------------------
 * Smooth scroll
 * ---------------------------------------------------------------------- */

describe('useSmoothScroll', () => {
  it('does not touch the document under reduced motion', () => {
    stubMotion(true)
    // Available on purpose: the preference has to be the reason nothing ran.
    stubResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())

    expect(document.documentElement.classList.contains('lenis')).toBe(false)
    expect(() => unmount()).not.toThrow()
  })

  it('does not touch the document when matchMedia is absent', () => {
    dropMatchMedia()
    stubResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())

    expect(document.documentElement.classList.contains('lenis')).toBe(false)
    expect(() => unmount()).not.toThrow()
  })

  it('takes the scroll on mount and gives it back on unmount', () => {
    stubMotion(false)
    stubResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())
    // Lenis marks the root element for as long as it is driving the scroll, so
    // this asserts the instance exists without reaching for a private field.
    expect(document.documentElement.classList.contains('lenis')).toBe(true)

    unmount()
    expect(document.documentElement.classList.contains('lenis')).toBe(false)
  })

  it('does not touch the document under the runtime motion budget, even once the media query settles', () => {
    // No preference either way — reduced motion alone would allow this — but
    // the runtime budget (`ui/surface.ts`, a low-end device) has to win.
    stubMotion(false)
    stubResizeObserver()
    document.documentElement.dataset.ndMotion = 'off'

    try {
      const { unmount } = renderHook(() => useSmoothScroll())

      // The effect that reconciles with the live media query must not
      // clobber the runtime refusal on mount.
      expect(document.documentElement.classList.contains('lenis')).toBe(false)
      expect(() => unmount()).not.toThrow()
    } finally {
      delete document.documentElement.dataset.ndMotion
    }
  })

  it('picks up the runtime motion budget mid-session, the way it already does for reduced motion', async () => {
    // `ui/surface.ts` re-watches `(pointer: coarse)`, so `data-nd-motion` can
    // flip after this hook has already mounted — a media-query listener alone
    // would miss that. The observer callback is a microtask, so the
    // assertions after each mutation need to wait for it.
    stubMotion(false)
    stubResizeObserver()
    document.documentElement.dataset.ndMotion = 'off'

    try {
      const { unmount } = renderHook(() => useSmoothScroll())
      expect(document.documentElement.classList.contains('lenis')).toBe(false)

      await act(async () => {
        document.documentElement.dataset.ndMotion = 'on'
        await Promise.resolve()
      })
      expect(document.documentElement.classList.contains('lenis')).toBe(true)

      await act(async () => {
        document.documentElement.dataset.ndMotion = 'off'
        await Promise.resolve()
      })
      expect(document.documentElement.classList.contains('lenis')).toBe(false)

      unmount()
    } finally {
      delete document.documentElement.dataset.ndMotion
    }
  })

  it('degrades to native scroll when Lenis cannot start', () => {
    stubMotion(false)
    dropResizeObserver()

    const { unmount } = renderHook(() => useSmoothScroll())

    expect(document.documentElement.classList.contains('lenis')).toBe(false)
    expect(() => unmount()).not.toThrow()
  })
})

/* -------------------------------------------------------------------------
 * Reveals
 * ---------------------------------------------------------------------- */

describe('useScrollReveal', () => {
  it('leaves the element untouched and legible under reduced motion', () => {
    stubMotion(true)
    const { el, ref } = target(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useScrollReveal(ref))

    // THE assertion of this file. An element hidden by a reveal that reduced
    // motion then stopped from running would be permanently invisible.
    expect(el.style.opacity).toBe('')
    expect(getComputedStyle(el).opacity).not.toBe('0')
    expect(ScrollTrigger.getAll()).toHaveLength(0)
    unmount()
    expect(el.style.opacity).toBe('')
  })

  it('leaves the element untouched and legible when matchMedia is absent', () => {
    dropMatchMedia()
    const { el, ref } = target(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useScrollReveal(ref))

    expect(el.style.opacity).toBe('')
    expect(getComputedStyle(el).opacity).not.toBe('0')
    expect(() => unmount()).not.toThrow()
    expect(el.style.opacity).toBe('')
  })

  it('reveals an element that is already in view rather than waiting for a scroll', () => {
    stubMotion(false)
    const { el, ref } = target(ABOVE_THE_FOLD)

    renderHook(() => useScrollReveal(ref))

    // Above the fold there is no start left to cross, so a trigger waiting for
    // one would hold this at zero for the life of the page.
    expect(el.style.opacity).toBe('')
    expect(getComputedStyle(el).opacity).not.toBe('0')
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })

  it('kills its ScrollTrigger on unmount and hands the element back visible', () => {
    stubMotion(false)
    const { el, ref } = target(BELOW_THE_FOLD)

    const { unmount } = renderHook(() => useScrollReveal(ref))

    // Below the fold the reveal is pending, so this is the one state in which
    // the element is legitimately hidden — and the only one cleanup must undo.
    expect(ScrollTrigger.getAll()).toHaveLength(1)
    expect(el.style.opacity).toBe('0')

    unmount()

    expect(ScrollTrigger.getAll()).toHaveLength(0)
    expect(el.style.opacity).toBe('')
    expect(el.style.transform).toBe('')
    expect(getComputedStyle(el).opacity).not.toBe('0')
  })

  it('unhides a pending reveal when reduced motion is switched on mid-page', () => {
    const setReduce = stubMotion(false)
    const { el, ref } = target(BELOW_THE_FOLD)

    renderHook(() => useScrollReveal(ref))
    expect(el.style.opacity).toBe('0')

    // A preference that flips has to tear the reveal down rather than strand
    // the element half-faded with nothing left to finish it.
    act(() => setReduce(true))

    expect(el.style.opacity).toBe('')
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })

  it('does nothing at all when there is no element', () => {
    stubMotion(false)
    const ref = { current: null }

    expect(() => renderHook(() => useScrollReveal(ref)).unmount()).not.toThrow()
    expect(ScrollTrigger.getAll()).toHaveLength(0)
  })
})
