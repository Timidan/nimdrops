/**
 * A line of text that arrives one word at a time: each word un-blurs, fades up
 * and settles, staggered a tenth of a second behind the word before it.
 *
 * The effect is borrowed from a Framer Motion original and rebuilt on GSAP,
 * which is what this app already ships (`package.json` has gsap and lenis and
 * nothing else animating). The reproduction is faithful in the values —
 * `blur(10px) → 0`, `opacity 0 → 1`, `y 50 → 0`, 0.7s a word, 0.1s apart — and
 * deliberately unfaithful in one respect: Motion's `whileInView` hides the
 * element the moment the component mounts and trusts its own frame loop to give
 * it back. This file does not extend that trust to anything.
 *
 * **The rule that outranks the effect: this text can never end up permanently
 * invisible.** `PRODUCT.md` forbids letting the visual layer gate content, and
 * `Landing.motion.ts` records what breaking that rule actually looked like — a
 * real page with no visible call to action, because a GSAP entrance hid its
 * elements and waited for a ticker that never advanced. Nothing threw. This
 * component hides text and waits for a ticker, so it inherits that failure mode
 * exactly, and it inherits the same defences:
 *
 *  1. **The hidden state is written by JavaScript, never by CSS.** The markup
 *     this component renders is fully legible with the effect absent, stripped
 *     from the bundle, or thrown out by an error. There is no stylesheet
 *     holding a word at `opacity: 0` waiting for a script that never arrived —
 *     which is also why this component has no CSS file of its own.
 *  2. **Nothing is hidden in an environment we cannot measure.** No `window`
 *     (the shell is server-rendered, `server/src/http/ssr.ts`), no `matchMedia`
 *     (jsdom, an old WebView), no `requestAnimationFrame`, no
 *     `IntersectionObserver` — in every one of those the words render plainly
 *     and this file does nothing at all. `motionAllowed()` is reused rather
 *     than re-derived, including its refusal to animate an unmeasurable host.
 *  3. **A wall-clock failsafe outlives the frame loop.** `setTimeout`, never
 *     another `requestAnimationFrame`, because the whole point is to be
 *     independent of the clock that failed. See `armFailsafe` below.
 *  4. **Every construction sits in a `try` and every exit path hands the words
 *     back visible** — throw, unmount, or the reader switching `reduce` on
 *     mid-animation, which is exactly when a word is most likely to be
 *     mid-blur.
 *
 * Only `filter`, `opacity` and `transform` are touched. None of the three
 * affects layout, so hiding a word cannot move the element whose position
 * decides when to show it.
 *
 * ## What a screen reader gets
 *
 * The whole sentence, as real text, at every moment — never a stream of
 * per-letter nodes that reads as gibberish. Each word is one span holding one
 * whole word **and the space that follows it**, so `textContent` is a sentence
 * rather than arunontrainwreck, for assistive technology, for the
 * server-rendered HTML and for a crawler.
 *
 * That the space lives *inside* the span rather than between two spans is the
 * one piece of this file that looks arbitrary and is not. GSAP cannot read a
 * computed transform off an element it cannot measure — zero width and no
 * `offsetParent`, which is any element inside a `display: none` ancestor, a
 * collapsed accordion or a hidden tab panel, and every element under jsdom — so
 * it briefly reparents that element to the document root and puts it back
 * before its `nextElementSibling`. A bare text node between two spans is not an
 * element sibling. It does not come back in the right place, and the sentence
 * quietly loses a space every time GSAP touches a word. Keeping the space
 * inside the span means the reparenting is a no-op: the only siblings are the
 * spans themselves, and they land exactly where they started.
 *
 * The trailing space costs nothing visually. It sits at the end of its flex
 * item's only line box, where CSS drops it; the gap you see is the word's own
 * `margin-right`.
 *
 * There is deliberately no `aria-label` carrying a duplicate copy of the text
 * and no `aria-hidden` on the words. Naming from the author is not honoured on
 * a paragraph, so that trick would trade real text for nothing.
 *
 * ## Laying it out
 *
 * The container is a flex row that wraps, so `text-align` does not apply to it.
 * Centre a headline with `justify-content` from the `className` instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import gsap from 'gsap'
import { useMotionAllowed } from './scrollReveal'

/** Layout timing in the browser, plain effects off it, so `window` is never read on import. */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** How the effect finds its own words without a class name or a CSS file. */
const WORD_ATTR = 'data-nd-blur-word'

/**
 * Whether a frame will ever be painted, and whether anything can tell us the
 * text has been scrolled to.
 *
 * `motionAllowed()` answers "is motion welcome"; this answers the separate
 * question "will the tween that un-hides these words actually run". A host with
 * no frame loop, or no way to report the element entering the viewport, is a
 * host where hiding anything is permanent damage.
 */
function canAnimate(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function' &&
    typeof window.matchMedia === 'function' &&
    typeof IntersectionObserver === 'function'
  )
}

/**
 * Hand-written rather than `gsap.set(…, { clearProps })`, for the reason
 * `scrollReveal.ts` gives: it has to work when GSAP is what broke. The
 * individual transform properties are cleared alongside `transform` because
 * gsap writes `translate/rotate/scale: none` next to it, and a leftover `none`
 * would out-specify a stylesheet's own transform.
 *
 * `will-change` goes with them. `filter: blur()` is expensive enough that
 * promoting a word for it is worth doing and worth undoing — the hint is armed
 * when the tween starts and dropped the instant the word has landed, so a
 * finished paragraph is not still holding a layer per word.
 */
function restore(el: HTMLElement): void {
  el.style.filter = ''
  el.style.opacity = ''
  el.style.transform = ''
  el.style.translate = ''
  el.style.rotate = ''
  el.style.scale = ''
  el.style.willChange = ''
}

/**
 * Is this element somewhere the reader cannot see, right now?
 *
 * Measured from the element itself rather than asked of the observer, because
 * the observer is one of the things that might have stopped answering. Two
 * deliberate biases, both toward the text being visible:
 *
 *  - An unmeasurable box — every rect zero, as under jsdom, or a throw from a
 *    hostile host — is **not** treated as off-screen. Not knowing where
 *    something is is not evidence that nobody is looking at it.
 *  - Any sliver counts as on-screen, well below the 0.1 threshold that starts
 *    the animation. A word peeking over the fold with the effect stalled is the
 *    case this whole function exists to catch.
 */
function offScreen(el: HTMLElement): boolean {
  if (typeof window === 'undefined') return false
  try {
    const box = el.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) return false
    const viewport = window.innerHeight || document.documentElement.clientHeight || 0
    if (viewport === 0) return false
    return box.bottom <= 0 || box.top >= viewport
  } catch {
    return false
  }
}

export type BlurTextTag = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4'

export interface BlurTextProps {
  /** The sentence. Rendered whole, whatever the animation does or fails to do. */
  text: string
  /** The element to render. A paragraph unless the copy is a heading. */
  as?: BlurTextTag
  className?: string
  /** Seconds are GSAP's unit; milliseconds are the unit the design was written in. */
  durationMs?: number
  /** Between one word and the next. */
  staggerMs?: number
  /** How far out of focus a word starts. */
  blurPx?: number
  /** How far below its resting place a word starts. */
  riseY?: number
  /**
   * How long the wall clock waits before overruling the frame loop. Also the
   * interval at which it re-checks a paragraph the reader has not reached yet.
   */
  failsafeMs?: number
  'data-testid'?: string
}

/** Whitespace is normalised: the layout owns the gaps, not the source string. */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0)
}

export default function BlurText({
  text,
  as = 'p',
  className,
  durationMs = 700,
  staggerMs = 100,
  blurPx = 10,
  riseY = 50,
  failsafeMs = 2000,
  'data-testid': testId,
}: BlurTextProps) {
  const allowed = useMotionAllowed()
  const rootRef = useRef<HTMLDivElement>(null)
  // Stable per sentence. A fresh array every render would re-run the effect
  // every render, and each run hides the words again.
  const words = useMemo(() => splitWords(text), [text])

  useBrowserLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !allowed || !canAnimate()) return

    const els = [...root.querySelectorAll<HTMLElement>(`[${WORD_ATTR}]`)]
    if (els.length === 0) return

    let observer: IntersectionObserver | undefined
    let tween: gsap.core.Tween | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    /**
     * GSAP's frame counter at the moment the tween was created. Comparing it
     * later is a liveness probe for the ticker that does not depend on the
     * ticker: if it has not moved, no frame has been produced and the tween
     * that was supposed to un-hide these words has not advanced a pixel.
     */
    let frameAtStart = -1

    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }

    /** Kill everything and give the words back to the cascade. */
    const handBack = () => {
      disarm()
      observer?.disconnect()
      observer = undefined
      tween?.kill()
      tween = undefined
      for (const el of els) restore(el)
    }

    /**
     * The wall clock, overruling the frame loop.
     *
     * Every stall between hiding a word and showing it again is silent: a
     * throttled `requestAnimationFrame` in a backgrounded tab, a compositor
     * that never produces a frame, an embedded WebView that paces rAF
     * differently, an `IntersectionObserver` that is present but never reports,
     * an element too tall to ever reach a 0.1 intersection ratio. None of those
     * raise, so a `catch` cannot see them — only a clock that is not the broken
     * one can.
     *
     * It re-arms rather than firing once, because the honest budget is not
     * "how long should an animation take" but "how long may a reader take to
     * scroll here", and that has no upper bound. So each tick asks a different
     * question depending on where the paragraph is:
     *
     *  - Off-screen: nothing hidden is anything anyone can see. Wait.
     *  - On-screen with frames flowing: the tween is running and will finish
     *    and restore itself. Wait, and check again in case it stops.
     *  - On-screen with no frame since the tween started, or with no tween at
     *    all because the observer never reported: this is the failure. Take the
     *    text back.
     *
     * The one cost is a race so narrow it is worth naming: a tick landing
     * inside the first frame of a healthy tween sees no frame yet and reveals
     * the words un-animated. Losing the effect is the correct direction to fail
     * in, and `failsafeMs` is long enough that it needs a tick to land in a
     * 16ms window seconds after mount.
     */
    const armFailsafe = () => {
      timer = setTimeout(() => {
        timer = undefined
        if (offScreen(root)) return armFailsafe()
        if (tween && gsap.ticker.frame > frameAtStart) return armFailsafe()
        handBack()
      }, failsafeMs)
    }

    const start = () => {
      try {
        observer?.disconnect()
        observer = undefined
        frameAtStart = gsap.ticker.frame

        // Promoted only for the length of the entrance. A blur is expensive to
        // rasterise, which is the argument for the hint and equally the
        // argument for dropping it the moment the word has landed.
        for (const el of els) el.style.willChange = 'transform, opacity, filter'

        tween = gsap.to(els, {
          filter: 'blur(0px)',
          opacity: 1,
          y: 0,
          duration: durationMs / 1000,
          stagger: staggerMs / 1000,
          ease: 'power2.out',
          overwrite: 'auto',
          onComplete: () => {
            // The words have landed; there is nothing left for the wall clock
            // to rescue them from.
            disarm()
            for (const el of els) restore(el)
          },
        })
      } catch {
        handBack()
      }
    }

    try {
      // `filter`, `opacity` and `transform` only. None affects layout, so
      // hiding a word cannot move the element whose position decides when to
      // show it.
      gsap.set(els, { filter: `blur(${blurPx}px)`, opacity: 0, y: riseY })

      // Armed at the same moment the words are hidden, not when the animation
      // starts, because "the observer never reported" is one of the failures
      // being insured against.
      armFailsafe()

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            start()
            return
          }
        },
        { threshold: 0.1 },
      )
      observer.observe(root)
    } catch {
      // `gsap.set` writes its values before anything else can throw, so a
      // failure part-way through leaves the words hidden. Undo all of it.
      handBack()
      return
    }

    // Also the path taken when `reduce` is switched on mid-animation, which is
    // exactly when a word is most likely to be mid-blur.
    return handBack
  }, [allowed, words, durationMs, staggerMs, blurPx, riseY, failsafeMs])

  // Every allowed tag is an `HTMLElement` and only `style`, `className` and the
  // element's own box are touched, so one concrete element type stands in for
  // the union rather than making the ref generic.
  const Tag = as as 'div'
  const last = words.length - 1

  return (
    <Tag ref={rootRef} className={className} style={CONTAINER} data-testid={testId}>
      {words.map((word, i) => (
        <span key={`${i}-${word}`} {...{ [WORD_ATTR]: '' }} style={i === last ? LAST_WORD : WORD}>
          {/* One text node, word and separator together. See the note above. */}
          {i === last ? word : `${word} `}
        </span>
      ))}
    </Tag>
  )
}

/**
 * `baseline` rather than the default `stretch`: flex items are blockified, and
 * stretched words sitting in a row of mixed font sizes would no longer share a
 * baseline the way the same words in a paragraph do.
 */
const CONTAINER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  rowGap: '0.1em',
}

/** The word gap. In `em`, so it tracks the type size wherever this is used. */
const WORD: CSSProperties = { display: 'inline-block', marginRight: '0.28em' }

/** The last word carries no trailing gap, which would push centred copy left. */
const LAST_WORD: CSSProperties = { display: 'inline-block' }
