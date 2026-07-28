/**
 * The landing page's motion layer.
 *
 * `Landing.css` already choreographs this page with CSS animations and a
 * `view()` scroll timeline. That layer is the floor, not the ceiling: it is what
 * renders when this module is absent, stripped, or broken. Everything here is
 * the storey above it — GSAP takes the same beats and gives them easing CSS
 * cannot express, a scroll-linked parallax `view()` cannot express, and a
 * pointer-driven pull no stylesheet can express at all.
 *
 * Three rules bound the whole file.
 *
 * **1. Motion carries no information** (`PRODUCT.md`). Every hook here changes
 * *when* something appears and *how* it arrives. None of them changes whether it
 * exists, what it says, or what a number reads. There is no counter climbing to
 * an amount, nothing that fires on success, and nothing celebratory: the
 * celebration belongs to the moment of receiving, and this is a brochure.
 *
 * **2. Content is never gated on a trigger firing** (`PRODUCT.md` principle 4).
 * This is the failure this file is written against. A reveal that hides an
 * element and then never un-hides it is a blank page. So, exactly as
 * `scrollReveal.ts` argues: the hidden state is written by JavaScript and never
 * by CSS; anything already past its trigger on load is revealed on the spot and
 * un-animated; every construction sits in a `try`; and every exit path — throw,
 * unmount, or the reader switching `reduce` on mid-page — hands the element back
 * visible. `motionAllowed()` is reused rather than re-derived, including its
 * refusal to animate an environment it cannot measure (no `window`, as under
 * `server/src/http/ssr.ts`; no `matchMedia`, as under jsdom and old WebViews).
 *
 * **3. Transform and opacity only.** Nothing here reads or writes a layout
 * property, so nothing here can move the trigger position that decides when to
 * show an element, and everything composites off the main thread.
 *
 * Where GSAP takes over an element, it first silences that element's CSS
 * animation inline — otherwise a running CSS animation out-ranks the inline
 * styles GSAP writes and the two fight for the same transform. The silencing is
 * reversed on every exit path, which is what makes the CSS layer the floor
 * rather than a casualty.
 */
import { useEffect, useLayoutEffect, type RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useMotionAllowed } from '../ui/scrollReveal'

/**
 * Re-exported, not re-implemented. Lenis wiring is already solved next door and
 * a second instance would fight the first for the scroll; `Landing.tsx` gets one
 * import surface for its motion instead.
 */
export { motionAllowed, useMotionAllowed, useSmoothScroll } from '../ui/scrollReveal'

/** Every hook takes the element it is allowed to touch, and nothing outside it. */
export type MotionScope = RefObject<HTMLElement | null>

/* -------------------------------------------------------------------------
 * Shared safety
 * ---------------------------------------------------------------------- */

/** Layout timing in the browser, plain effects off it, so `window` is never read on import. */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Whether a frame will ever be painted.
 *
 * `motionAllowed()` answers "is motion welcome"; this answers the separate
 * question "will the tween that un-hides this element actually run". GSAP hides
 * on construction and reveals on a tick, so a host with no frame loop is a host
 * where hiding anything is permanent damage.
 */
function canAnimate(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function' &&
    typeof window.matchMedia === 'function'
  )
}

/** `gsap.registerPlugin` reads `matchMedia` and throws where there is none. */
function scrollTriggerReady(): boolean {
  try {
    gsap.registerPlugin(ScrollTrigger)
    return true
  } catch {
    return false
  }
}

/**
 * Hand-written rather than `gsap.set(…, { clearProps })`, for the reason
 * `scrollReveal.ts` gives: it has to work when GSAP is what broke. The
 * individual transform properties are cleared alongside `transform` because gsap
 * writes `translate/rotate/scale: none` next to it, and a leftover `none` would
 * out-specify a stylesheet's own transform.
 *
 * Deliberately duplicated from `scrollReveal.ts` instead of imported: that module
 * is not mine to change, and a private helper is a smaller cost than an edit to a
 * file whose whole value is that it is stable.
 */
function restore(el: HTMLElement): void {
  el.style.opacity = ''
  el.style.transform = ''
  el.style.translate = ''
  el.style.rotate = ''
  el.style.scale = ''
  el.style.willChange = ''
}

/**
 * Take the CSS animation off these elements, reversibly.
 *
 * A CSS animation in its active or fill phase beats inline styles in the
 * cascade, so leaving `.nd-arrive` running while GSAP writes the same transform
 * produces a fight that GSAP loses for 780ms and then wins abruptly. Silencing
 * is inline, so it only exists while this module does.
 */
function silenceCss(els: readonly HTMLElement[]): () => void {
  const before = els.map((el) => el.style.animation)
  for (const el of els) el.style.animation = 'none'
  return () => {
    els.forEach((el, i) => {
      el.style.animation = before[i] ?? ''
    })
  }
}

/**
 * Elements inside the scope, or none.
 *
 * The `try` is not defensive noise: the selector is caller-supplied, and an
 * invalid one throws. Returning nothing makes a bad selector a page with no
 * enhancement rather than a page with no content.
 */
function within(scope: MotionScope, selector: string): HTMLElement[] {
  const root = scope.current
  if (!root) return []
  try {
    return [...root.querySelectorAll<HTMLElement>(selector)]
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------
 * Hero entrance
 * ---------------------------------------------------------------------- */

/** How one element arrives. Transform and opacity, nothing else. */
interface Entrance {
  y: number
  scale: number
  rotate: number
  duration: number
  ease: string
}

/**
 * Arrival is by role, because a uniform fade on eight elements is the thing that
 * makes a page feel templated. The packet is the subject of the brand page and
 * is thrown onto its mark with an overshoot; the headline is snapped in with an
 * exponential ease so it is legible almost immediately and only the last few
 * pixels are motion; supporting copy is quieter than either.
 */
const ROLES: readonly { selector: string; entrance: Entrance }[] = [
  {
    selector: '.nd-land-packet',
    entrance: { y: -96, scale: 0.78, rotate: -9, duration: 1.15, ease: 'back.out(1.35)' },
  },
  {
    selector: '.nd-land-h1-a, .nd-land-h1-b',
    entrance: { y: 46, scale: 0.965, rotate: 0, duration: 0.95, ease: 'expo.out' },
  },
  {
    selector: '.nd-land-lede, .nd-land-cta',
    entrance: { y: 28, scale: 1, rotate: 0, duration: 0.8, ease: 'power3.out' },
  },
]

/** Nav, brand, anything else wearing the entrance class. */
const PLAIN_ENTRANCE: Entrance = { y: 18, scale: 1, rotate: 0, duration: 0.6, ease: 'power2.out' }

function entranceFor(el: HTMLElement): Entrance {
  for (const role of ROLES) {
    try {
      if (el.matches(role.selector)) return role.entrance
    } catch {
      /* A malformed selector in this table is a bug, not a reason to hide copy. */
    }
  }
  return PLAIN_ENTRANCE
}

/**
 * When this element is due, in seconds.
 *
 * Read from the `--nd-in` custom property `Landing.tsx` already sets inline for
 * the CSS entrance, so the two layers share one choreography instead of drifting
 * into two. DOM order is the fallback for an element that carries no beat.
 */
function beatSeconds(el: HTMLElement, index: number, step: number): number {
  const raw = el.style.getPropertyValue('--nd-in').trim()
  const ms = raw === '' ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(ms) ? Math.max(0, ms) / 1000 : index * step
}

export interface HeroEntranceOptions {
  /** What arrives. Defaults to the class `Landing.tsx` already marks entrances with. */
  selector?: string
  /** Seconds between elements that carry no `--nd-in` of their own. */
  step?: number
}

/**
 * The load-time entrance: a staggered timeline over the elements above the fold.
 *
 * Runs on mount rather than on scroll, because the fold has no trigger to cross
 * — the reader is already looking at it. The timeline restores every element
 * when it finishes, handing the fold back to the cascade so a later hover or
 * press can transform it (the same reason `Landing.css` fills `backwards` rather
 * than `both`).
 */
/**
 * Force everything visible after `ms`, whatever the tween thinks.
 *
 * The entrance hides elements up front and relies on a ticker to bring them
 * back. Every stall in that chain leaves the page with no visible call to
 * action: a throttled `requestAnimationFrame` in a backgrounded tab, a
 * compositor that never produces a frame, a headless or embedded WebView that
 * paces rAF differently, or simply a device slow enough that GSAP's ticker is
 * starved. None of those raise, so the existing `catch` cannot see them.
 *
 * This is deliberately wall-clock (`setTimeout`) rather than another rAF: the
 * whole point is to be independent of the clock that failed. Restoring twice is
 * harmless — `restore` only clears inline properties.
 */
function failsafeReveal(
  els: readonly HTMLElement[],
  ms: number,
  handBack: () => void,
): () => void {
  const timer = setTimeout(() => {
    for (const el of els) restore(el)
    // Deliberately NOT un-silencing. Tried, and it is worse: `.nd-arrive`
    // fills `backwards`, so re-arming the CSS animation restarts its delay from
    // now and the element goes straight back to its hidden from-state. Leaving
    // `animation: none` in place is what keeps it visible — the element rests at
    // its natural styles, which is exactly where the entrance would have ended.
    void handBack
  }, ms)
  return () => clearTimeout(timer)
}

export function useHeroEntrance(scope: MotionScope, options: HeroEntranceOptions = {}): void {
  const allowed = useMotionAllowed()
  const { selector = '.nd-arrive', step = 0.09 } = options

  useBrowserLayoutEffect(() => {
    if (!allowed || !canAnimate()) return

    const els = within(scope, selector)
    if (els.length === 0) return

    let unsilence: (() => void) | undefined
    let timeline: gsap.core.Timeline | undefined
    // 2.6s covers the longest authored beat plus its duration, with room to
    // spare. If the tween is healthy it has finished long before this fires.
    const cancelFailsafe = failsafeReveal(els, 2600, () => unsilence?.())

    try {
      unsilence = silenceCss(els)

      const tl = gsap.timeline({
        onComplete: () => {
          for (const el of els) restore(el)
        },
      })
      timeline = tl

      els.forEach((el, i) => {
        const spec = entranceFor(el)
        // Promoted only for the length of the entrance; `restore` clears it.
        el.style.willChange = 'transform, opacity'
        tl.fromTo(
          el,
          { opacity: 0, y: spec.y, scale: spec.scale, rotate: spec.rotate },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            rotate: 0,
            duration: spec.duration,
            ease: spec.ease,
            overwrite: 'auto',
          },
          beatSeconds(el, i, step),
        )
      })
    } catch {
      // `fromTo` renders its start state on construction, so a throw part-way
      // through the loop leaves some elements hidden. Undo all of it.
      cancelFailsafe()
      timeline?.kill()
      for (const el of els) restore(el)
      unsilence?.()
      return
    }

    return () => {
      cancelFailsafe()
      timeline?.kill()
      for (const el of els) restore(el)
      unsilence?.()
    }
  }, [scope, allowed, selector, step])
}

/* -------------------------------------------------------------------------
 * Hero parallax
 * ---------------------------------------------------------------------- */

export interface HeroParallaxOptions {
  /** The artwork's container. It must not be the element the CSS float animates. */
  art?: string
  /** The copy column, which leads the artwork slightly. */
  copy?: string
  /** Pixels the artwork lags by across the hero's exit. */
  lag?: number
}

/**
 * Depth on the fold: the artwork lags the scroll, the copy leads it slightly.
 *
 * Two containers, not the packet itself, and that is load-bearing. `Landing.tsx`
 * nests three elements for exactly this reason — `.nd-land-hero-art` (this
 * hook's parallax), `.nd-land-packet` (the entrance above), and
 * `.nd-land-packet-float` (the CSS idle float). One element cannot hold three
 * transforms; three nested elements compose them for free.
 *
 * Transform only and no fade, so a scrub caught at an arbitrary progress by a
 * full-page capture shows offset copy rather than transparent copy.
 */
export function useHeroParallax(scope: MotionScope, options: HeroParallaxOptions = {}): void {
  const allowed = useMotionAllowed()
  const { art = '.nd-land-hero-art', copy = '.nd-land-hero-copy', lag = 72 } = options

  useBrowserLayoutEffect(() => {
    if (!allowed || !canAnimate()) return

    const root = scope.current
    if (!root) return

    const artEl = within(scope, art)[0]
    const copyEl = within(scope, copy)[0]
    const els = [artEl, copyEl].filter((el): el is HTMLElement => el !== undefined)
    if (els.length === 0) return

    let timeline: gsap.core.Timeline | undefined

    try {
      if (!scrollTriggerReady()) throw new Error('ScrollTrigger unavailable')

      timeline = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root, start: 'top top', end: 'bottom top', scrub: true },
      })
      if (artEl) timeline.to(artEl, { y: lag }, 0)
      if (copyEl) timeline.to(copyEl, { y: -lag * 0.28 }, 0)
    } catch {
      timeline?.scrollTrigger?.kill()
      timeline?.kill()
      for (const el of els) restore(el)
      return
    }

    return () => {
      timeline?.scrollTrigger?.kill()
      timeline?.kill()
      for (const el of els) restore(el)
    }
  }, [scope, allowed, art, copy, lag])
}

/* -------------------------------------------------------------------------
 * Section reveals
 * ---------------------------------------------------------------------- */

export interface SectionRevealOptions {
  /** What reveals. Defaults to the class `Landing.tsx` already marks reveals with. */
  selector?: string
  /** Upward travel in px. A paragraph arriving, not a slide transition. */
  y?: number
  /** Seconds. */
  duration?: number
  /** ScrollTrigger's own `start` vocabulary, measured on the group's container. */
  start?: string
  /** Seconds between siblings, so a row assembles rather than arriving as a slab. */
  stagger?: number
}

/**
 * Reveal each group of marked elements as its container enters the viewport,
 * staggered across the group.
 *
 * Grouped by parent rather than run per element, because the per-element form
 * already exists (`useScrollReveal`) and the thing it cannot do is make three
 * cards read as one gesture: a shared trigger means the stagger is measured from
 * when the *row* arrived, not from when each card independently crossed a line a
 * few pixels apart.
 *
 * The two hazards are handled exactly as `scrollReveal.ts` handles them. A group
 * already past its start on load is revealed immediately and un-animated,
 * because `onEnter` fires on a crossing and that crossing has happened. And a
 * finished group is restored, handing the elements back to the cascade so the
 * ledger's own hover styling still works.
 */
export function useSectionReveals(scope: MotionScope, options: SectionRevealOptions = {}): void {
  const allowed = useMotionAllowed()
  const {
    selector = '.nd-rise',
    y = 44,
    duration = 0.7,
    start = 'top 86%',
    stagger = 0.08,
  } = options

  useBrowserLayoutEffect(() => {
    if (!allowed || !canAnimate()) return

    const els = within(scope, selector)
    if (els.length === 0) return

    const triggers: ScrollTrigger[] = []
    const tweens: gsap.core.Tween[] = []
    let unsilence: (() => void) | undefined

    try {
      if (!scrollTriggerReady()) throw new Error('ScrollTrigger unavailable')

      // The CSS `view()` reveal owns these elements until this line.
      unsilence = silenceCss(els)
      // `opacity` and `transform` only. Neither affects layout, so hiding an
      // element cannot move the start position that decides when to show it.
      gsap.set(els, { opacity: 0, y })

      const groups = new Map<Element, HTMLElement[]>()
      for (const el of els) {
        const container = el.parentElement ?? el
        const bucket = groups.get(container)
        if (bucket) bucket.push(el)
        else groups.set(container, [el])
      }

      for (const [container, members] of groups) {
        let tween: gsap.core.Tween | undefined

        const trigger = ScrollTrigger.create({
          trigger: container,
          start,
          once: true,
          onEnter: () => {
            tween = gsap.to(members, {
              opacity: 1,
              y: 0,
              duration,
              stagger,
              ease: 'power2.out',
              overwrite: 'auto',
              onComplete: () => {
                for (const el of members) restore(el)
              },
            })
            tweens.push(tween)
          },
        })

        if (trigger.progress > 0 || trigger.isActive) {
          // ScrollTrigger does fire `onEnter` during creation for a trigger that
          // starts out passed, so the tween it made has to go with it — it would
          // otherwise fade in from the value `restore` just cleared.
          trigger.kill()
          tween?.kill()
          for (const el of members) restore(el)
        } else {
          triggers.push(trigger)
        }
      }
    } catch {
      for (const trigger of triggers) trigger.kill()
      for (const tween of tweens) tween.kill()
      for (const el of els) restore(el)
      unsilence?.()
      return
    }

    return () => {
      for (const trigger of triggers) trigger.kill()
      for (const tween of tweens) tween.kill()
      // Also the path taken when `reduce` is switched on mid-reveal, which is
      // exactly when an element is most likely to be mid-fade.
      for (const el of els) restore(el)
      unsilence?.()
    }
  }, [scope, allowed, selector, y, duration, start, stagger])
}

/* -------------------------------------------------------------------------
 * Magnetic calls to action
 * ---------------------------------------------------------------------- */

/**
 * Hover is a pointer luxury and this product runs in a phone WebView
 * (`PRODUCT.md`: no feature may depend on hover). A coarse pointer gets nothing,
 * which is correct rather than degraded — there is no hover state to enhance.
 */
function fineHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
  } catch {
    return false
  }
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value))
}

export interface MagneticOptions {
  /** Which controls pull. Defaults to the hero's two doors. */
  selector?: string
  /** Maximum displacement in px. Small on purpose: the target must stay under the cursor. */
  pull?: number
}

/**
 * Give one control a spring toward the pointer.
 *
 * Written to `translate`, not `transform`, and that is the whole subtlety here.
 * `index.css` gives `.nd-action` a press state of `transform: scale(0.99)`; an
 * inline `transform` would out-specify that stylesheet rule and silently delete
 * the press feedback from the most important control on the page. The individual
 * transform properties compose with `transform` instead of replacing it, so the
 * pull and the press coexist.
 */
function magnetise(el: HTMLElement, pull: number): () => void {
  const at = { x: 0, y: 0 }

  const write = () => {
    el.style.translate = `${at.x.toFixed(2)}px ${at.y.toFixed(2)}px`
  }
  const settle = () => {
    if (at.x === 0 && at.y === 0) el.style.translate = ''
  }
  const tune = { duration: 0.45, ease: 'power3.out', onUpdate: write, onComplete: settle }
  const toX = gsap.quickTo(at, 'x', tune)
  const toY = gsap.quickTo(at, 'y', tune)

  const follow = (event: Event) => {
    const point = event as PointerEvent
    const box = el.getBoundingClientRect()
    // A zero box means an unlaid-out or hidden control; dividing by it is NaN,
    // and NaN in a transform removes the element from the page.
    if (box.width === 0 || box.height === 0) return
    toX(clamp(((point.clientX - box.left) / box.width - 0.5) * 2 * pull, pull))
    toY(clamp(((point.clientY - box.top) / box.height - 0.5) * 2 * pull, pull))
  }

  // Keyboard focus deliberately does not move the control: motion on a keyboard
  // interaction is disorienting and this one would also be pointing nowhere.
  const home = () => {
    toX(0)
    toY(0)
  }

  el.addEventListener('pointermove', follow)
  el.addEventListener('pointerleave', home)
  el.addEventListener('pointercancel', home)

  return () => {
    el.removeEventListener('pointermove', follow)
    el.removeEventListener('pointerleave', home)
    el.removeEventListener('pointercancel', home)
    gsap.killTweensOf(at)
    el.style.translate = ''
  }
}

/**
 * The hero's two doors lean toward the pointer and spring back.
 *
 * Capped at a few pixels: the cap is not timidity, it is that a control which
 * runs away from the cursor is a control that is harder to click, and these two
 * are the page's only job.
 */
export function useMagneticDoors(scope: MotionScope, options: MagneticOptions = {}): void {
  const allowed = useMotionAllowed()
  const { selector = '.nd-land-doors a, .nd-land-doors button', pull = 5 } = options

  useEffect(() => {
    if (!allowed || !canAnimate() || !fineHover()) return

    const els = within(scope, selector)
    if (els.length === 0) return

    const detach: (() => void)[] = []
    try {
      for (const el of els) detach.push(magnetise(el, pull))
    } catch {
      for (const undo of detach) undo()
      for (const el of els) restore(el)
      return
    }

    return () => {
      for (const undo of detach) undo()
    }
  }, [scope, allowed, selector, pull])
}
