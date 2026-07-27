/**
 * DEV-ONLY. The sealed-envelope reveal, as numbers and pure functions.
 *
 * Everything the ritual can be tuned by lives here and nowhere else, because
 * the whole point of this prototype is that the owner tries the hold with their
 * own thumb and picks a duration. A tunable buried in a component is not a
 * tunable.
 *
 * The functions are pure and take their time as an argument, so the shake, the
 * haptic ladder and the confetti field can all be asserted in jsdom, which has
 * no clock, no CSS engine and no compositor.
 */
import type { BridgeKind } from '../../sdk/adapter'

/* -------------------------------------------------------------------------
 * The hold
 * ---------------------------------------------------------------------- */

/**
 * How long the seal has to be held. THE constant.
 *
 * The owner asked for five seconds. The three values below are what the dev
 * route offers so that can be settled with a thumb rather than an argument:
 *
 *   1200  the press-and-hold convention. Deliberate, and nobody thinks it broke.
 *   2500  ceremonial. Long enough that the shake has somewhere to go.
 *   5000  the owner's ask.
 *
 * The usual reason to make a hold long — stopping an accidental activation —
 * does not apply here: opening the envelope spends nothing and signs nothing.
 * So the only thing length buys is ceremony, and the only thing it costs is
 * people letting go early because they think the control is dead.
 */
export const HOLD_MS = 2500

/** What `/design/reveal?hold=` accepts. Anything else falls back to `HOLD_MS`. */
export const HOLD_OPTIONS = [1200, 2500, 5000] as const

export function resolveHoldMs(raw: string | null | undefined): number {
  const value = Number(raw)
  return (HOLD_OPTIONS as readonly number[]).includes(value) ? value : HOLD_MS
}

/**
 * How long the progress takes to unwind after an early release.
 *
 * Not zero. A bar that snaps to empty reads as a rejection; one that drains
 * reads as "that did not finish, go again". Short enough that a second attempt
 * never has to wait for it — the next press takes over from wherever the unwind
 * had got to.
 */
export const RELEASE_MS = 200

/**
 * Thumb slop. A five-second hold on a phone, one-handed, drifts several pixels
 * — often tens of them on a bumpy bus — and cancelling on that would make the
 * gesture fail constantly for ordinary hands. The pointer is captured, so this
 * is the only thing that can cancel a drift, and it is deliberately generous:
 * past 72px the contact has left the envelope entirely and the person has
 * plainly changed their mind.
 */
export const SLOP_PX = 72

/* -------------------------------------------------------------------------
 * The shake
 * ---------------------------------------------------------------------- */

/**
 * Peak amplitude, in px, at the instant before the seal gives.
 *
 * Small. This is a sealed thing straining, not a phone ringing on a table, and
 * anything past ~4px at 390px turns the label under the seal into mush.
 */
export const SHAKE_PEAK_PX = 3.6

/** The shake's frequency, in Hz, at the start and at the end of the hold. */
const SHAKE_HZ_FROM = 7
const SHAKE_HZ_TO = 17

export interface Shake {
  x: number
  y: number
  deg: number
}

/**
 * Where the envelope is, this frame.
 *
 * Amplitude is `progress²`, not `progress`, so the first half of the hold is
 * almost still and the last quarter is visibly straining. A linear ramp reads
 * as a constant buzz that happens to get bigger; the square reads as pressure
 * building, which is the thing being expressed.
 *
 * Vertical travel is a third of the horizontal and the rotation is a fraction
 * of a degree: the envelope is being held down, so it fights sideways.
 *
 * `transform` only, and computed rather than keyframed, because the amplitude
 * has to change every frame and a keyframe whose values depend on a custom
 * property restarts its interpolation each time that property is written.
 */
export function shakeAt(progress: number, elapsedMs: number): Shake {
  const p = Math.min(1, Math.max(0, progress))
  const amplitude = SHAKE_PEAK_PX * p * p
  const hz = SHAKE_HZ_FROM + (SHAKE_HZ_TO - SHAKE_HZ_FROM) * p
  const phase = (elapsedMs / 1000) * hz * Math.PI * 2
  return {
    x: amplitude * Math.sin(phase),
    y: amplitude * 0.34 * Math.sin(phase * 1.7 + 0.9),
    deg: amplitude * 0.18 * Math.sin(phase * 0.8),
  }
}

/* -------------------------------------------------------------------------
 * The haptics
 * ---------------------------------------------------------------------- */

export interface Buzz {
  /** Fraction of the hold at which this pulse fires. */
  at: number
  /** Its length in ms. */
  ms: number
}

/**
 * The haptic ladder: six pulses, getting longer and closer together, so the
 * hold feels like it is winding up rather than ticking.
 *
 * Stated as fractions of the hold rather than as absolute times, so the same
 * ladder works at 1.2s and at 5s. Nothing about the experience depends on any
 * of it firing — see `canVibrate`.
 */
export function buzzPlan(): Buzz[] {
  return [
    { at: 0.0, ms: 8 },
    { at: 0.22, ms: 10 },
    { at: 0.42, ms: 13 },
    { at: 0.6, ms: 17 },
    { at: 0.76, ms: 22 },
    { at: 0.89, ms: 28 },
  ]
}

/** The pattern the seal gives way with. Two knocks and a release. */
export const OPEN_BUZZ = [18, 30, 12, 48] as const

/**
 * `navigator.vibrate` is ANDROID ONLY in practice.
 *
 * Safari has never shipped it, no iOS browser has it because they are all
 * WebKit, and a wallet WebView may withhold it or drop it on the floor.
 * Chromium exposes the method on desktop too, where it returns `true` and does
 * nothing at all, so a truthy return proves nothing. Feature-detect, call, and
 * never read anything back.
 */
export function canVibrate(nav: Navigator | undefined): boolean {
  return typeof nav?.vibrate === 'function'
}

/* -------------------------------------------------------------------------
 * The burst
 * ---------------------------------------------------------------------- */

/** How long the particles stay mounted. Must outlast the longest one. */
export const BURST_MS = 1100

/** Bounded, and small. Eighteen reads as a burst; sixty reads as a screensaver. */
export const CONFETTI_COUNT = 18

/** The envelope's own paper, coming apart. Fewer, bigger, slower. */
export const SHARD_COUNT = 6

export interface Piece {
  /** Where it ends up, relative to the seal, in px. */
  dx: number
  /** How high it goes first. Negative is up. */
  dy: number
  /** Total spin, in degrees. */
  rot: number
  /** Its own duration and stagger, in ms. Both inside `BURST_MS`. */
  dur: number
  delay: number
  /** px. */
  size: number
  /** Which of the palette's four particle colours it takes. */
  tone: number
  /** 0 or 1: half the confetti is a rectangle, half is a disc. */
  round: number
}

/** Mulberry32. Seeded, so a screenshot of the burst is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The confetti field, computed once at burst time.
 *
 * Every value is bounded so the particles cannot leave the stage: the stage
 * clips, but a particle that flies 900px also costs the compositor a 900px
 * layer for a second, and the phone this runs on cannot spare it.
 */
export function confetti(count = CONFETTI_COUNT, seed = 0x1de4): Piece[] {
  const random = rng(seed)
  return Array.from({ length: count }, (_, i) => {
    // Fan the pieces evenly around the circle first, then jitter, so eighteen
    // random angles cannot all end up on one side of the seal.
    const angle = (i / count) * Math.PI * 2 + (random() - 0.5) * 0.6
    const reach = 66 + random() * 76
    return {
      dx: Math.round(Math.cos(angle) * reach),
      dy: Math.round(Math.sin(angle) * reach * 0.82 - 46 - random() * 34),
      rot: Math.round((random() - 0.5) * 620),
      dur: Math.round(620 + random() * 340),
      delay: Math.round(random() * 90),
      size: Math.round(6 + random() * 5),
      tone: i % 4,
      round: i % 3 === 0 ? 1 : 0,
    }
  })
}

/** The paper. Six pieces, going out and down, in the envelope's own colour. */
export function shards(count = SHARD_COUNT, seed = 0x5ea1): Piece[] {
  const random = rng(seed)
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (random() - 0.5) * 0.4
    const reach = 74 + random() * 58
    return {
      dx: Math.round(Math.cos(angle) * reach),
      dy: Math.round(Math.sin(angle) * reach * 0.7 - 18),
      rot: Math.round((random() - 0.5) * 240),
      dur: Math.round(520 + random() * 240),
      delay: 0,
      size: Math.round(16 + random() * 12),
      tone: 4,
      round: 0,
    }
  })
}

/* -------------------------------------------------------------------------
 * Who is allowed to open it
 * ---------------------------------------------------------------------- */

/**
 * `can-open` or `sealed-only`, decided by whether a wallet can sign here.
 *
 * You cannot open a packet on a PC, because claiming needs a Nimiq Pay
 * signature and Nimiq Pay is a phone app. That is a fact about the platform,
 * not a viewport width, so this branches on the bridge and never on a media
 * query: a narrow desktop window is still a desktop, a tablet is ambiguous, and
 * a phone browser outside Nimiq Pay also cannot sign and correctly gets the
 * sealed state with a deep link out to the app.
 *
 * `mock` counts as openable because in a DEV build the mock IS the claim path.
 */
export type OpenAbility = 'can-open' | 'sealed-only'

export function openAbility(kind: BridgeKind): OpenAbility {
  return kind === 'unavailable' ? 'sealed-only' : 'can-open'
}

/* -------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------- */

/**
 * Three phases, and `opened` is a STATE.
 *
 * A reload, a resumed claim or a poll tick lands on `opened` with no theatre:
 * the burst is fired by the sealed → opened TRANSITION, never by being in
 * `opened`. Nothing that carries money is ever gated on the transition having
 * happened.
 */
export type RevealPhase = 'sealed' | 'holding' | 'opened'
