/**
 * The blur budget, decided at runtime.
 *
 * `backdrop-filter` over a MOVING backdrop is the expensive case. The blurred
 * region has to be recomposited whenever what is behind it changes, and this
 * screen runs inside somebody's wallet WebView on a phone we do not get to
 * choose. The stylesheet does what it can — one bounded blurred element, lights
 * that move on `transform` only, a `@supports` gate — but three things can only
 * be known at runtime, and this module knows them:
 *
 *   1. the user has asked for less transparency, which means SOLID, not "a bit
 *      less blur";
 *   2. the user has asked for less motion;
 *   3. the device is a phone-shaped thing with very little memory or very few
 *      cores, or has Data Saver on, which is the closest signal a browser
 *      gives to "this is the low-end Android in the risk assessment".
 *
 * The result is two attributes on the document element, `data-nd-glass` and
 * `data-nd-motion`, which `index.css` keys off. Attributes rather than React
 * state because the field and the sheet are different components in different
 * parts of the tree and must never disagree, and because this has to be settled
 * before the first paint rather than after a hydration pass.
 *
 * Nothing here can hide content. Both degraded paths are still fully legible
 * surfaces: the sheet becomes solid and the lights hold a composed position.
 */

/** Why the surface was degraded. Reported, not just applied. */
export type SurfaceReason =
  | 'reduced-transparency'
  | 'reduced-motion'
  | 'low-end-device'
  | 'save-data'
  | 'no-backdrop-filter'

export interface SurfaceCapability {
  /** The sheet may use `backdrop-filter`. */
  glass: boolean
  /** The field's lights may drift. */
  drift: boolean
  /** Every reason that applied, in the order they were checked. */
  reasons: SurfaceReason[]
}

/** Everything `assessSurface` is allowed to look at. Injected, so it is testable. */
export interface SurfaceEnv {
  reducedTransparency: boolean
  reducedMotion: boolean
  /** `(pointer: coarse)` — a touch screen, so probably a phone. */
  coarsePointer: boolean
  /** `navigator.deviceMemory`, in GiB. Chromium only; `null` where unknown. */
  deviceMemory: number | null
  /** `navigator.hardwareConcurrency`; `null` where unknown. */
  cores: number | null
  /** `navigator.connection.saveData`. */
  saveData: boolean
  supportsBackdropFilter: boolean
}

/**
 * A coarse pointer alone is not evidence of a slow device — every tablet and
 * every touchscreen laptop has one. It is the CONJUNCTION that matters: a touch
 * device reporting 4 GiB or less, or four cores or fewer, is the phone this
 * direction was flagged risky for.
 *
 * Deliberately generous thresholds. `deviceMemory` is bucketed by the spec and
 * caps at 8, so 4 is genuinely low; four cores in 2026 is a budget handset.
 * Getting this wrong in the cautious direction costs a blur nobody notices was
 * missing. Getting it wrong the other way costs a claimant a janky money screen.
 */
const LOW_MEMORY_GIB = 4
const LOW_CORE_COUNT = 4

export function assessSurface(env: SurfaceEnv): SurfaceCapability {
  const reasons: SurfaceReason[] = []
  let glass = true
  let drift = true

  if (!env.supportsBackdropFilter) {
    // The `@supports` block in `index.css` already handles the paint; saying so
    // here keeps the reported reason honest and lets the field stop pretending
    // it is compositing over a blur.
    reasons.push('no-backdrop-filter')
    glass = false
  }

  if (env.reducedTransparency) {
    reasons.push('reduced-transparency')
    glass = false
  }

  if (env.reducedMotion) {
    reasons.push('reduced-motion')
    drift = false
  }

  if (env.saveData) {
    reasons.push('save-data')
    glass = false
    drift = false
  }

  const lowMemory = env.deviceMemory !== null && env.deviceMemory <= LOW_MEMORY_GIB
  const fewCores = env.cores !== null && env.cores <= LOW_CORE_COUNT
  if (env.coarsePointer && (lowMemory || fewCores)) {
    reasons.push('low-end-device')
    glass = false
    drift = false
  }

  return { glass, drift, reasons }
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number
  connection?: { saveData?: boolean }
}

/** Reads the live environment. Returns a fully-capable env off the browser. */
export function readSurfaceEnv(): SurfaceEnv {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return {
      reducedTransparency: false,
      reducedMotion: false,
      coarsePointer: false,
      deviceMemory: null,
      cores: null,
      saveData: false,
      supportsBackdropFilter: true,
    }
  }

  const nav = navigator as NavigatorWithHints
  const supports =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports('backdrop-filter', 'blur(1px)') ||
        CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
      : true

  return {
    reducedTransparency: window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    saveData: nav.connection?.saveData === true,
    supportsBackdropFilter: supports,
  }
}

export function applySurfaceCapability(root: HTMLElement, capability: SurfaceCapability): void {
  root.dataset.ndGlass = capability.glass ? 'on' : 'off'
  root.dataset.ndMotion = capability.drift ? 'on' : 'off'
}

/** The media queries whose answers can change while the page is open. */
const WATCHED = [
  '(prefers-reduced-transparency: reduce)',
  '(prefers-reduced-motion: reduce)',
  '(pointer: coarse)',
] as const

let started = false

/**
 * Settle the surface and keep it settled.
 *
 * Called at module scope from `main.tsx`, so the attributes are on the document
 * element before React renders anything and there is no frame of glass on a
 * device that cannot afford it. Idempotent, because a hot reload should not
 * stack listeners.
 */
export function startSurfaceGuard(): SurfaceCapability {
  const capability = assessSurface(readSurfaceEnv())
  if (typeof document === 'undefined') return capability

  applySurfaceCapability(document.documentElement, capability)
  if (started) return capability
  started = true

  const resettle = () => {
    applySurfaceCapability(document.documentElement, assessSurface(readSurfaceEnv()))
  }
  for (const query of WATCHED) {
    const list = window.matchMedia(query)
    // `addListener` is the Safari <14 spelling; the WebView is the constraint.
    if (typeof list.addEventListener === 'function') list.addEventListener('change', resettle)
    else if (typeof list.addListener === 'function') list.addListener(resettle)
  }

  return capability
}
