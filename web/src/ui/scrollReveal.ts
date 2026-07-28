/**
 * Scroll motion for the landing page: Lenis for the scroll itself, GSAP
 * ScrollTrigger for the reveals. Isolated here so pages stay declarative.
 *
 * One rule outranks everything else in this file. **The page must be completely
 * legible with none of this running.** `PRODUCT.md` forbids letting the visual
 * layer gate content, and a reveal that hides an element and then never fires
 * does precisely that. Three consequences:
 *
 *  1. The hidden state is written by JavaScript, never by CSS. If this module
 *     fails to load or is stripped from the bundle, the markup was visible the
 *     whole time — there is no stylesheet holding it at `opacity: 0` waiting
 *     for a script that never arrived.
 *  2. Nothing is hidden until the ScrollTrigger that will reveal it exists and
 *     has reported a position. An element already past its start on load is
 *     revealed on the spot, because `onEnter` fires on a crossing and that
 *     crossing has already happened.
 *  3. Every construction sits in a `try`, and every exit path unhides. Smooth
 *     scroll and reveals are decoration; native scroll and readable text are
 *     the product.
 *
 * Motion also carries no information here (`PRODUCT.md`): these reveals change
 * when a paragraph appears, never whether it exists or what it says.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'

/* -------------------------------------------------------------------------
 * Whether motion is welcome
 * ---------------------------------------------------------------------- */

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

/**
 * `false` for three separate reasons — no `window` (the server renders this
 * app's shell, `server/src/http/ssr.ts`), no `matchMedia` (jsdom, an old
 * WebView), or an explicit `reduce` — because the safe answer is the same in
 * all three: leave the document alone.
 *
 * This is the one place that deviates from `readSurfaceEnv`, which treats an
 * unanswerable query as "fully capable". That default is right for glass, where
 * the fallback is a flat panel. It is wrong here, where the optimistic branch
 * hides content in an environment we cannot measure.
 */
export function motionAllowed(): boolean {
  // ui/surface.ts flips this for devices that should not pay for motion.
  // The media query below only hears the user's setting; both must refuse.
  if (typeof document !== 'undefined' && document.documentElement.dataset.ndMotion === 'off') {
    return false
  }
  const list = query()
  return list === null ? false : !list.matches
}

/**
 * The same answer, live, so switching `reduce` on mid-session takes effect —
 * and so does `ui/surface.ts` flipping `data-nd-motion` mid-session, which it
 * can: `(pointer: coarse)` is one of the signals it re-watches, so a tablet
 * that grows a mouse changes the runtime budget after this hook has already
 * mounted.
 */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(motionAllowed)
  useEffect(() => {
    // Re-derive through `motionAllowed()`, not `!list.matches` alone: the
    // runtime budget has to survive every reconciliation below, or a
    // low-end device with no reduced-motion preference gets Lenis back the
    // instant one of them fires.
    const settle = () => setAllowed(motionAllowed())
    settle()

    const offs: Array<() => void> = []

    const list = query()
    if (list) {
      if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', settle)
        offs.push(() => list.removeEventListener('change', settle))
      } else {
        // Safari <14's spelling. The WebView is the constraint.
        list.addListener?.(settle)
        offs.push(() => list.removeListener?.(settle))
      }
    }

    // `data-nd-motion` itself, for the reasons `motionAllowed` cannot see
    // from a media query: device memory, core count, Data Saver.
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(settle)
      observer.observe(document.documentElement, { attributeFilter: ['data-nd-motion'] })
      offs.push(() => observer.disconnect())
    }

    return () => {
      for (const off of offs) off()
    }
  }, [])
  return allowed
}

/** Layout timing in the browser, plain effects off it, so `window` is never read on import. */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/* -------------------------------------------------------------------------
 * Smooth scroll
 * ---------------------------------------------------------------------- */

/**
 * Lenis for the page, or nothing at all.
 *
 * `syncTouch` stays off (its default): touch scrolling remains entirely native,
 * so a thumb on a phone never fights an interpolator and a flick cannot be
 * swallowed. Lenis smooths the wheel; it does not take the gesture.
 */
export function useSmoothScroll(): void {
  const allowed = useMotionAllowed()

  useEffect(() => {
    if (!allowed) return

    let lenis: Lenis
    try {
      // `autoRaf` so Lenis owns its frame loop and cancels it in `destroy()`.
      // A hand-rolled loop is one more thing to leak on unmount.
      lenis = new Lenis({ autoRaf: true, lerp: 0.1 })
    } catch {
      // No `ResizeObserver`, no rAF, a hostile WebView. Native scroll is the
      // fallback and it was never taken away, so there is nothing to repair.
      return
    }

    // Without this, ScrollTrigger reads the scroll position from the native
    // event and lands a frame behind the interpolated one. Wrapped rather than
    // passed by reference because `update`'s first argument is meaningful.
    const detach = lenis.on('scroll', () => ScrollTrigger.update())

    return () => {
      detach()
      lenis.destroy()
    }
  }, [allowed])
}

/* -------------------------------------------------------------------------
 * Reveals
 * ---------------------------------------------------------------------- */

export interface ScrollRevealOptions {
  /** Upward travel in px. Small: a paragraph arriving, not a slide transition. */
  y?: number
  /** Seconds. */
  duration?: number
  /** ScrollTrigger's own `start` vocabulary. */
  start?: string
  /**
   * Position in a row, staggering the reveal, so three cards assemble rather
   * than arrive as a slab — the same reason `Landing.css` offsets by `--nd-i`.
   */
  index?: number
}

/** Beyond this the last card in a row waits long enough to read as broken. */
const MAX_STAGGER = 5
const STAGGER_S = 0.07

/**
 * Fade and lift `ref` as it enters the viewport. A no-op under reduced motion,
 * off the browser, and whenever anything in the chain throws — in each of those
 * cases the element keeps the styling its stylesheet gave it.
 */
export function useScrollReveal(
  ref: RefObject<HTMLElement | null>,
  options: ScrollRevealOptions = {},
): void {
  const allowed = useMotionAllowed()
  const { y = 24, duration = 0.55, start = 'top 88%', index = 0 } = options

  useBrowserLayoutEffect(() => {
    const el = ref.current
    if (!el || !allowed) return

    let trigger: ScrollTrigger | undefined
    let tween: gsap.core.Tween | undefined

    try {
      gsap.registerPlugin(ScrollTrigger)

      // `opacity` and `transform` only. Neither affects layout, so hiding the
      // element cannot move the start position that decides when to show it.
      gsap.set(el, { opacity: 0, y })

      trigger = ScrollTrigger.create({
        trigger: el,
        start,
        once: true,
        onEnter: () => {
          tween = gsap.to(el, {
            opacity: 1,
            y: 0,
            duration,
            delay: Math.min(index, MAX_STAGGER) * STAGGER_S,
            ease: 'power2.out',
            overwrite: 'auto',
          })
        },
      })

      // Anything above the fold begins already past its start, and an element
      // that never crosses its start is an element `onEnter` has no reason to
      // fire for — it would sit at `opacity: 0` for the life of the page. It is
      // also not worth animating: the reader is looking at it already, and the
      // load-time entrance belongs to `Landing.css`, which owns the fold.
      //
      // The tween is killed alongside the trigger because ScrollTrigger does
      // fire `onEnter` during creation for a trigger that starts out passed. It
      // would otherwise fade in from the value `unhide` just cleared.
      if (trigger.progress > 0 || trigger.isActive) {
        trigger.kill()
        trigger = undefined
        tween?.kill()
        tween = undefined
        unhide(el)
      }
    } catch {
      trigger?.kill()
      unhide(el)
      return
    }

    return () => {
      trigger?.kill()
      tween?.kill()
      // Also the path taken when `reduce` is switched on mid-reveal, which is
      // exactly when an element is most likely to be mid-fade.
      unhide(el)
    }
  }, [ref, allowed, y, duration, start, index])
}

/**
 * Hand-written rather than `gsap.set(…, { clearProps })`, so it still works when
 * gsap is what broke. The individual transform properties are here because gsap
 * writes `translate/rotate/scale: none` alongside the `transform` it actually
 * uses, and a leftover `none` would out-specify a stylesheet's own transform.
 */
function unhide(el: HTMLElement): void {
  el.style.opacity = ''
  el.style.transform = ''
  el.style.translate = ''
  el.style.rotate = ''
  el.style.scale = ''
}
