/**
 * The contract under test is not "does it blur". It is **can this component
 * ever leave a sentence invisible**, which is the only way a decorative text
 * reveal turns into a product defect (`PRODUCT.md`: never let the visual layer
 * gate the content). Every test below is a different way of taking the
 * animation away — the preference, the media query, the observer, the frame
 * loop, the component's own lifetime — and asserting the words survived it.
 *
 * jsdom is a useful adversary rather than a limitation here. It ships no
 * `matchMedia` and no `IntersectionObserver`, so two of those environments are
 * real and not simulated; the stubs below exist only to *restore* capability
 * for the tests that need the animation to actually run.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import BlurText from './BlurText'

const TEXT = 'A sponsor funds one drop and a stranger claims it.'
const FAILSAFE_MS = 2000

/* -------------------------------------------------------------------------
 * The environment, one knob at a time
 * ---------------------------------------------------------------------- */

/** jsdom has no `matchMedia`; this is the whole of one, and it is live. */
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

/**
 * jsdom has no `IntersectionObserver` either, and unlike `matchMedia` there is
 * no way to make a real one report in a document that is never laid out. This
 * stub hands the test the trigger instead of guessing when it would fire.
 */
class StubObserver {
  static instances: StubObserver[] = []
  disconnected = false
  targets: Element[] = []
  readonly callback: IntersectionObserverCallback
  readonly options?: IntersectionObserverInit

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    StubObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.targets.push(el)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** The reader scrolls the paragraph into view. */
  enter(): void {
    const entries = this.targets.map((target) => ({ isIntersecting: true, target }))
    this.callback(entries as unknown as IntersectionObserverEntry[], this as never)
  }
}

function stubObserver(): void {
  StubObserver.instances = []
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: StubObserver,
  })
}

function dropObserver(): void {
  Reflect.deleteProperty(globalThis, 'IntersectionObserver')
}

/**
 * A host that never paints. GSAP captured its own reference to `rAF` when it
 * was imported, so this removes the component's ability to *ask* whether frames
 * exist without breaking the ticker for the rest of the file.
 */
const nativeAnimationFrame = window.requestAnimationFrame

function dropAnimationFrames(): void {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: undefined,
  })
}

function restoreAnimationFrames(): void {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: nativeAnimationFrame,
  })
}

/** The one observer the component under test created. */
function observer(): StubObserver {
  const [only] = StubObserver.instances
  if (!only) throw new Error('no IntersectionObserver was created')
  return only
}

function wordEls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-nd-blur-word]')]
}

function paragraph(): HTMLElement {
  return screen.getByTestId('blurred')
}

function subject(props: Partial<Parameters<typeof BlurText>[0]> = {}) {
  return render(<BlurText text={TEXT} data-testid="blurred" {...props} />)
}

/** No inline hiding left anywhere: the words are the cascade's again. */
function expectVisible(els: HTMLElement[]): void {
  expect(els.length).toBeGreaterThan(0)
  for (const el of els) {
    expect(el.style.opacity).toBe('')
    expect(el.style.filter).toBe('')
    expect(el.style.transform).toBe('')
    expect(el.style.willChange).toBe('')
    expect(getComputedStyle(el).opacity).not.toBe('0')
  }
}

/**
 * Visible, and never hidden in the first place.
 *
 * Hidden-then-restored inside one layout effect looks identical to untouched
 * once the effect returns, so `expectVisible` alone cannot tell a capability
 * check that declined to run from a `catch` that cleaned up after it. GSAP
 * stamps a `_gsap` cache on every element it writes to, and that is the
 * difference: no cache means no word was ever hidden.
 */
function expectUntouched(els: HTMLElement[]): void {
  expectVisible(els)
  for (const el of els) expect('_gsap' in el).toBe(false)
}

afterEach(() => {
  cleanup()
  gsap.globalTimeline.clear()
  gsap.ticker.wake()
  vi.useRealTimers()
  dropMatchMedia()
  dropObserver()
  restoreAnimationFrames()
  StubObserver.instances = []
  document.body.replaceChildren()
})

/* -------------------------------------------------------------------------
 * The text itself
 * ---------------------------------------------------------------------- */

describe('the sentence', () => {
  it('renders whole and readable, animation or no animation', () => {
    stubMotion(false)
    stubObserver()

    subject()

    // THE assertion of this file. Not "some words are present" — the exact
    // sentence, spaces and all, is what a screen reader reads out, what the
    // server-rendered HTML contains and what a crawler indexes.
    expect(paragraph().textContent).toBe(TEXT)
  })

  it('splits into whole words, never into letters', () => {
    stubMotion(false)
    stubObserver()

    subject()

    const words = wordEls().map((el) => el.textContent?.trim())
    // A per-letter split would read as gibberish to assistive technology and
    // would hand the compositor ten times as many blurred layers. There is one
    // node per word, holding that whole word.
    expect(words).toEqual(TEXT.split(' '))
    expect(words).toHaveLength(10)
  })

  it('carries each separator inside the word it follows', () => {
    stubMotion(false)
    stubObserver()

    subject({ text: 'two words' })

    // Not decoration, and not interchangeable with a text node between the two
    // spans: GSAP reparents an element it cannot measure — anything inside a
    // `display: none` ancestor, a collapsed accordion, a hidden tab panel — and
    // puts it back before its *element* sibling. A bare text node between spans
    // is not one, so it would not survive the round trip and the sentence would
    // lose a space. Inside the span, the space goes wherever the word goes.
    expect(wordEls().map((el) => el.textContent)).toEqual(['two ', 'words'])
    expect(paragraph().childNodes).toHaveLength(2)
  })

  it('keeps the sentence intact through every stage of the animation', () => {
    stubMotion(false)
    stubObserver()

    subject()

    // Hidden is a paint state, not a content state.
    expect(wordEls()[0]?.style.opacity).toBe('0')
    expect(paragraph().textContent).toBe(TEXT)

    // And intact after GSAP has had the words in its hands. jsdom lays nothing
    // out, so every element here is unmeasurable and takes the reparenting path
    // that a real browser takes for hidden content — which makes this the one
    // environment where that regression shows up for free.
    act(() => observer().enter())
    expect(paragraph().textContent).toBe(TEXT)
  })

  it('renders nothing at all rather than an empty span for empty copy', () => {
    stubMotion(false)
    stubObserver()

    subject({ text: '   ' })

    expect(wordEls()).toHaveLength(0)
    expect(() => cleanup()).not.toThrow()
  })
})

/* -------------------------------------------------------------------------
 * Environments where the effect must not run at all
 * ---------------------------------------------------------------------- */

describe('when motion is unwelcome or unmeasurable', () => {
  it('no-ops under prefers-reduced-motion: reduce', () => {
    stubMotion(true)
    // Available on purpose: the preference has to be the reason nothing ran.
    stubObserver()

    const { unmount } = subject()

    expectVisible(wordEls())
    expect(StubObserver.instances).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('does not throw, and does not hide, without matchMedia', () => {
    dropMatchMedia()
    stubObserver()

    const { unmount } = subject()

    expect(paragraph().textContent).toBe(TEXT)
    expectVisible(wordEls())
    expect(StubObserver.instances).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('does not throw, and does not hide, without IntersectionObserver', () => {
    stubMotion(false)
    dropObserver()

    const { unmount } = subject()

    // Nothing could ever report that the reader reached this paragraph, so
    // hiding it would be permanent. It is left alone — declined up front, not
    // hidden and then rescued by the catch.
    expect(paragraph().textContent).toBe(TEXT)
    expectUntouched(wordEls())
    expect(() => unmount()).not.toThrow()
  })

  it('does not throw, and does not hide, without a frame loop', () => {
    stubMotion(false)
    stubObserver()
    dropAnimationFrames()

    const { unmount } = subject()

    // A host that never paints a frame is a host where hiding a word is
    // permanent damage, whatever the tween believes it is doing.
    expect(paragraph().textContent).toBe(TEXT)
    expectUntouched(wordEls())
    expect(StubObserver.instances).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('hands a hidden paragraph back when reduce is switched on mid-animation', () => {
    const setReduce = stubMotion(false)
    stubObserver()

    subject()
    expect(wordEls()[0]?.style.opacity).toBe('0')

    // A preference that flips has to tear the effect down rather than strand
    // the words half-blurred with nothing left to finish them.
    act(() => setReduce(true))

    expectVisible(wordEls())
    expect(observer().disconnected).toBe(true)
  })
})

/* -------------------------------------------------------------------------
 * The effect, when it is allowed to run
 * ---------------------------------------------------------------------- */

describe('the reveal', () => {
  it('waits for the viewport instead of firing on mount', () => {
    stubMotion(false)
    stubObserver()

    subject()

    expect(observer().options?.threshold).toBe(0.1)
    expect(observer().targets).toEqual([paragraph()])

    for (const el of wordEls()) {
      expect(el.style.opacity).toBe('0')
      expect(el.style.filter).toBe('blur(10px)')
      expect(el.style.transform).toContain('50px')
      // Nothing is promoted while nothing is moving.
      expect(el.style.willChange).toBe('')
    }
    expect(gsap.getTweensOf(wordEls()[0])).toHaveLength(0)
  })

  it('starts one tween over the words when the paragraph enters the viewport', () => {
    stubMotion(false)
    stubObserver()

    subject()
    act(() => observer().enter())

    const words = wordEls()
    expect(gsap.getTweensOf(words[0]).length).toBeGreaterThan(0)
    for (const el of words) expect(el.style.willChange).toBe('transform, opacity, filter')
    // Once is enough; the observer has no second job.
    expect(observer().disconnected).toBe(true)
  })
})

/* -------------------------------------------------------------------------
 * The wall clock
 * ---------------------------------------------------------------------- */

describe('the failsafe', () => {
  /**
   * The failure `Landing.motion.ts` was written against, reproduced exactly: a
   * GSAP entrance that hid its elements and waited for a ticker that never
   * advanced. Nothing throws, so nothing but a clock independent of the frame
   * loop can notice.
   *
   * Only `setTimeout` and `clearTimeout` are faked. Faking
   * `requestAnimationFrame` both breaks jsdom and defeats the point — the
   * scenario *is* a frame that never arrives, so the test must not be able to
   * manufacture one.
   */
  it('reveals the words when no frame is ever produced', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMotion(false)
    stubObserver()

    subject()
    const words = wordEls()
    expect(words[0]?.style.opacity).toBe('0')

    act(() => observer().enter())
    // Creating a tween wakes GSAP's ticker, so it is stopped here rather than
    // before: from this point no frame can advance the tween that was supposed
    // to bring these words back.
    gsap.ticker.sleep()

    expect(words[0]?.style.opacity).toBe('0')
    expect(gsap.getTweensOf(words[0])[0]?.progress()).toBe(0)

    act(() => void vi.advanceTimersByTime(FAILSAFE_MS + 50))

    expectVisible(words)
  })

  it('reveals even if the observer never reports at all', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMotion(false)
    stubObserver()

    subject()
    const words = wordEls()
    expect(words[0]?.style.opacity).toBe('0')

    // An observer that is constructed, observes, and then stays silent — a
    // polyfill stub, or an element too tall to reach a 0.1 ratio. There is no
    // tween to stall because there is no tween.
    act(() => void vi.advanceTimersByTime(FAILSAFE_MS + 50))

    expectVisible(words)
  })

  it('does not fire while the paragraph is still below the fold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMotion(false)
    stubObserver()

    subject()
    const words = wordEls()
    // jsdom lays nothing out, so the only way to be genuinely off-screen is to
    // say so. A paragraph the reader has not reached is invisible either way,
    // and revealing it here would cost the effect on every section of a long
    // page.
    paragraph().getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5200, left: 0, right: 320, width: 320, height: 200 }) as DOMRect

    act(() => void vi.advanceTimersByTime(FAILSAFE_MS * 3))

    expect(words[0]?.style.opacity).toBe('0')
  })
})

/* -------------------------------------------------------------------------
 * Lifetime
 * ---------------------------------------------------------------------- */

describe('unmount', () => {
  it('disconnects the observer, kills the tween and hands the words back', () => {
    stubMotion(false)
    stubObserver()

    const { unmount } = subject()
    act(() => observer().enter())

    const words = wordEls()
    expect(gsap.getTweensOf(words[0]).length).toBeGreaterThan(0)

    unmount()

    expect(observer().disconnected).toBe(true)
    expect(gsap.getTweensOf(words[0])).toHaveLength(0)
    // Detached from the document by now, but a component that leaves inline
    // hiding behind is a component that would hide a recycled node.
    expectVisible(words)
  })

  it('cancels the failsafe, so nothing runs after the component is gone', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMotion(false)
    stubObserver()

    const { unmount } = subject()
    unmount()

    expect(vi.getTimerCount()).toBe(0)
    expect(() => vi.advanceTimersByTime(FAILSAFE_MS * 3)).not.toThrow()
  })

  it('survives having no element to animate', () => {
    stubMotion(false)
    stubObserver()

    expect(() => subject({ text: '' }).unmount()).not.toThrow()
    expect(StubObserver.instances).toHaveLength(0)
  })
})
