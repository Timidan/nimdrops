import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from 'react'

/**
 * The manifold: one link, one hub, six equal shares.
 *
 * ## What it is for
 *
 * This is the landing page's hero graphic, and it exists to replace a
 * photograph of a red envelope. The photograph said GIFT. It did not say what
 * the product does, and "gift" is the one thing about NimDrops that needs no
 * explaining — a link arriving in a group chat already reads as a gift. What
 * needs explaining is the mechanism: ONE approval becomes MANY equal payments,
 * fixed in advance. So the hero draws the mechanism instead of the wrapping.
 *
 * Read top to bottom it is a sentence: a link, a trunk down into a hub that
 * bears an `=`, and six identical cards fanned out below it, each holding a
 * gold bar of exactly the same width as the bar in the `=` itself. Nothing on
 * it is a number and nothing on it is a promise; it is a distribution
 * instrument, drawn.
 *
 * ## The one motion rule
 *
 * The six branches draw TOGETHER and the six nodes settle TOGETHER. They are
 * never staggered. A stagger is cheap and it looks good and it is wrong here:
 * whichever recipient animates first reads as the first, the nearest, or the
 * favoured one, and "shares are fixed and equal by design" is the entire
 * claim this page is making. The
 * equality has to survive the animation, so all six share one CSS rule — one
 * duration, one delay, one keyframe name — and there is no per-index delay
 * anywhere in this file to drift out of sync later.
 *
 * The cascade is between STAGES, not between peers:
 *
 *   capsule  0 → 420ms      the link lands
 *   trunk    160 → 520ms    it draws down into the hub
 *   hub      300 → 720ms    the `=` resolves
 *   branches 430 → 1070ms   all six, one frame
 *   nodes    720 → 1140ms   all six, one frame
 *
 * Everything eases on `--nd-ease`, the product's one entering curve. Nothing
 * rotates, nothing spins, nothing is random, nothing bursts: wheel and
 * slot-machine language is barred outright, and a fan of equal spokes is one
 * bad instinct away from a prize wheel. Only `transform`, `opacity` and
 * `stroke-dashoffset` are animated, so the whole sequence is compositor work
 * and paint, never layout.
 *
 * ## Reduced motion, and every other way this can fail
 *
 * The static markup IS the finished diagram. Every colour, width and dash on
 * it is an SVG presentation attribute, and the only thing the injected
 * stylesheet does is add animation to elements that are already fully drawn.
 * Delete the stylesheet, run with JavaScript off, render it on the server,
 * render it in jsdom, or run it for a reader who asked for reduced motion, and
 * the same complete graphic appears — never blank, never half-drawn, never a
 * dash waiting for a frame that will not come. Motion is opt-IN: the gate only
 * opens after `matchMedia` has been found AND has said the reader has no
 * preference against it. The rule that content must never be gated on a
 * trigger firing is written about the claim screen, but a hero that ships
 * blank is the same bug in a cheaper place.
 *
 * The guard is belt and braces on purpose. The JS gate is what jsdom and the
 * server hit; the `prefers-reduced-motion` block in the stylesheet is what
 * catches a reader who flips the setting while the page is open, and what
 * keeps the contract legible to anyone reading the CSS rather than the hook.
 *
 * ## Accessibility: `aria-hidden`, deliberately
 *
 * The graphic is decorative and it is hidden from assistive technology. That is
 * a choice, not an omission. Any honest description of it — "one link becomes
 * six equal shares" — is a restatement of the heading it sits beside, so
 * describing it would make a screen reader say the same sentence twice, and the
 * second telling would be the worse one. The six nodes are also
 * REPRESENTATIVE: a drop can be funded for two people or for two hundred, and
 * an accessible name saying "six" would be a claim the product does not make.
 * There is no text in this subtree at all, so there is no count to leak.
 *
 * The rule this follows is that the page must carry its meaning in words and
 * this must only illustrate them. If the hero copy ever stops saying what the
 * product does, fix the copy — do not caption the picture.
 *
 * ## Colour
 *
 * Nothing new is invented; the tokens come from `index.css` and are mapped once
 * on the root element so the SVG can read them, with each token's own value as
 * the fallback for anywhere the stylesheet has not loaded.
 *
 * The dark hub is load-bearing rather than styling. Gold is 2.74:1 on the
 * field's brightest pixel — under even the 3:1 non-text floor — which is why
 * `index.css` says gold may never sit on the bare field, and why the vermilion
 * bloom would otherwise swallow the one mark on this graphic that has to read.
 * So the gold disc sits on an 84px disc of `--color-field` with a soft halo
 * behind it, exactly the way the custody shield sits on the claim card: on that
 * ground the disc measures about 9.5:1 and the mark survives the light behind
 * it. The spokes are near-white at 70%, which is the alpha at which a hairline
 * still clears 3:1 against the brightest the field can get.
 */

/* ---- geometry ------------------------------------------------------------
 *
 * One coordinate system, in SVG user units, with a `viewBox` and no fixed
 * pixel size anywhere: the whole figure is fluid from a 320px phone to a wide
 * desktop and the caller sizes it with CSS. Margins around the drawn content
 * are ~16px horizontally and ~18px vertically, which is why the viewBox is
 * 440x408 rather than a round number.
 */

const VIEW_W = 440
const VIEW_H = 408

/** The hub, and the axis everything else is built on. */
const HUB_X = 220
const HUB_Y = 188
/** The dark disc that carries the gold, and the gold itself. */
const HUB_R = 42
const HALO_R = 78
const DISC_R = 25

/** The link, at the top. */
const CAP_W = 112
const CAP_H = 48
const CAP_R = CAP_H / 2
const TRUNK_LEN = 80
const CAP_TOP = HUB_Y - HUB_R - TRUNK_LEN - CAP_H
const CAP_X = HUB_X - CAP_W / 2
const CAP_MID = CAP_TOP + CAP_H / 2

/** A recipient card. */
const NODE_W = 60
const NODE_H = 46
const NODE_R = 14

/**
 * Six is a COMPOSITION, not a count. A drop is funded for whatever headcount
 * the sponsor chose; six is simply the number of cards that fills a 130-degree
 * fan without crowding. Nothing in the rendered markup states it.
 */
const FAN_COUNT = 6
/**
 * Measured from the +x axis with y running down, so the fan opens BELOW the
 * hub: 25 degrees is out to the right and slightly down, 155 is its mirror.
 */
const FAN_FROM = 25
const FAN_TO = 155

/**
 * Every spoke starts and ends at the same radius, so all six are the same
 * length (114) with the same stroke and the same endpoint. Cards are then
 * placed so that their EDGE — not their centre — sits on `SPOKE_OUTER`, which
 * is what keeps the six connections identical where it counts.
 *
 * The alternative, centres on one exact circle, was tried and rejected: an
 * axis-aligned card presents a different amount of itself to a radial line
 * depending on its angle, so the six connections would have differed in
 * visible length by ~8% — on a graphic whose whole subject is that they do
 * not differ. Card centres instead land between 183.6 and 192.2, averaging
 * 188.4, which is the "~188px radius" this was drawn to.
 */
const SPOKE_INNER = 46
const SPOKE_OUTER = 160
export const SPOKE_LEN = SPOKE_OUTER - SPOKE_INNER

/** The `=` bar, and the share bar inside every card. Same width on purpose. */
const BAR_W = 26
const BAR_H = 5
const EQ_GAP = 6.5
/**
 * The recipient mark, above the share bar. A DOT rather than a second bar:
 * two stacked bars inside a card read as a small `=`, which made every card
 * look like a copy of the hub instead of like somebody holding a share.
 */
const DOT_R = 3.75
const DOT_GAP = 6
const CARD_STACK = 2 * DOT_R + DOT_GAP + BAR_H

/** How far a card travels on its own radius as it settles. Identical for six. */
const NODE_TRAVEL = 8

/* ---- timing --------------------------------------------------------------
 * Stages cascade; peers never do. See the header.
 */
const D_CAPSULE = 420
const T_TRUNK = 160
const D_TRUNK = 360
const T_HUB = 300
const D_HUB = 420
const T_SPOKE = 430
const D_SPOKE = 640
const T_NODE = 720
const D_NODE = 420

const RAD = Math.PI / 180

/** Three decimals is plenty at this scale and keeps the DOM readable. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Distance from a card's centre to its rounded-rectangle boundary along a unit
 * vector — the card treated as a `(a x b)` rectangle grown by `NODE_R`, which
 * is what a rounded rect is. Three cases: out through a side, out through the
 * top, or out through a corner arc.
 */
function edgeDistance(ux: number, uy: number): number {
  const a = NODE_W / 2 - NODE_R
  const b = NODE_H / 2 - NODE_R
  const px = Math.abs(ux)
  const py = Math.abs(uy)

  const throughSide = NODE_W / 2 / px
  if (throughSide * py <= b) return throughSide

  const throughTop = NODE_H / 2 / py
  if (throughTop * px <= a) return throughTop

  const k = a * px + b * py
  return k + Math.sqrt(k * k - (a * a + b * b - NODE_R * NODE_R))
}

interface FanNode {
  /** Card centre. */
  cx: number
  cy: number
  /** Spoke, hub end and card end. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Where the card comes FROM as it settles: inward along its own radius. */
  inX: string
  inY: string
}

const FAN: readonly FanNode[] = Array.from({ length: FAN_COUNT }, (_, i) => {
  const deg = FAN_FROM + (i * (FAN_TO - FAN_FROM)) / (FAN_COUNT - 1)
  const ux = Math.cos(deg * RAD)
  const uy = Math.sin(deg * RAD)
  const centre = SPOKE_OUTER + edgeDistance(ux, uy)

  return {
    cx: round(HUB_X + centre * ux),
    cy: round(HUB_Y + centre * uy),
    x1: round(HUB_X + SPOKE_INNER * ux),
    y1: round(HUB_Y + SPOKE_INNER * uy),
    x2: round(HUB_X + SPOKE_OUTER * ux),
    y2: round(HUB_Y + SPOKE_OUTER * uy),
    inX: `${round(-NODE_TRAVEL * ux)}px`,
    inY: `${round(-NODE_TRAVEL * uy)}px`,
  }
})

/* ---- motion --------------------------------------------------------------
 *
 * Exported so the test can assert the shape of the contract rather than trying
 * to read a cascade jsdom does not have. Every rule that starts an animation is
 * scoped under `[data-animate='true']`, which is an attribute this component
 * only ever sets after it has proved there is a `matchMedia` and that it does
 * not report `prefers-reduced-motion: reduce`.
 */
export const MANIFOLD_CSS = `
.nd-manifold[data-animate='true'] .mf-capsule,
.nd-manifold[data-animate='true'] .mf-trunk,
.nd-manifold[data-animate='true'] .mf-hub,
.nd-manifold[data-animate='true'] .mf-spoke,
.nd-manifold[data-animate='true'] .mf-node {
  animation-timing-function: var(--mf-ease);
  animation-fill-mode: both;
}

.nd-manifold[data-animate='true'] .mf-capsule {
  animation-name: mf-capsule-in;
  animation-duration: ${D_CAPSULE}ms;
}

.nd-manifold[data-animate='true'] .mf-trunk {
  animation-name: mf-draw;
  animation-duration: ${D_TRUNK}ms;
  animation-delay: ${T_TRUNK}ms;
}

.nd-manifold[data-animate='true'] .mf-hub {
  animation-name: mf-hub-in;
  animation-duration: ${D_HUB}ms;
  animation-delay: ${T_HUB}ms;
  transform-box: view-box;
  transform-origin: ${HUB_X}px ${HUB_Y}px;
}

/* All six branches, one rule. No per-index selector, no per-index delay. */
.nd-manifold[data-animate='true'] .mf-spoke {
  animation-name: mf-draw;
  animation-duration: ${D_SPOKE}ms;
  animation-delay: ${T_SPOKE}ms;
}

/* All six cards, one rule. Same. */
.nd-manifold[data-animate='true'] .mf-node {
  animation-name: mf-node-in;
  animation-duration: ${D_NODE}ms;
  animation-delay: ${T_NODE}ms;
}

@media (prefers-reduced-motion: reduce) {
  .nd-manifold[data-animate='true'] .mf-capsule,
  .nd-manifold[data-animate='true'] .mf-trunk,
  .nd-manifold[data-animate='true'] .mf-hub,
  .nd-manifold[data-animate='true'] .mf-spoke,
  .nd-manifold[data-animate='true'] .mf-node {
    animation: none;
  }
}

@keyframes mf-capsule-in {
  from { opacity: 0; transform: translateY(-14px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes mf-hub-in {
  from { opacity: 0; transform: scale(0.86); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes mf-draw {
  from { stroke-dashoffset: var(--mf-draw); }
  to { stroke-dashoffset: 0; }
}

@keyframes mf-node-in {
  from { opacity: 0; transform: translate(var(--mf-in-x), var(--mf-in-y)); }
  to { opacity: 1; transform: translate(0, 0); }
}
`

/** Style objects that also carry custom properties. */
type StyleVars = CSSProperties & { [key: `--${string}`]: string }

/**
 * `useLayoutEffect` so the gate opens before the first paint and the finished
 * diagram is never briefly visible under the animation's own start frame. On
 * the server there is no layout to read and React warns about it, so the plain
 * effect is used there and the server simply renders the finished graphic,
 * which is the correct output for a renderer that will never animate anyway.
 */
const useGate = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface ManifoldProps {
  className?: string
  style?: CSSProperties
}

export default function Manifold({ className, style }: ManifoldProps) {
  const [animate, setAnimate] = useState(false)
  /* `useId` emits colons, which are legal in an id and in `url(#...)` but not
     in a selector. Stripped so the id stays usable either way. */
  const halo = `mf-halo-${useId().replace(/:/g, '')}`

  useGate(() => {
    /* An old WebView, jsdom and the SSR shell all land here with no
       `matchMedia`. None of them animate, all of them get the finished
       diagram, and none of them throw. */
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    setAnimate(true)
    /* No subscription: this is a one-shot 1140ms entrance, so a preference
       change could only ever arrive after it had finished. A reader who flips
       the setting mid-flight is caught by the stylesheet's own media block. */
  }, [])

  const root: StyleVars = {
    display: 'block',
    width: '100%',
    /* Every token is `index.css`'s, with its own value as the fallback so the
       graphic is still correct outside the app shell. `--nd-accent` rather
       than `--color-gold` directly, because it resolves to gold by default and
       follows the owner's bright-accent switch when that is on. */
    '--mf-ink': 'var(--color-field, #0e0a09)',
    '--mf-gold': 'var(--nd-accent, var(--color-gold, #e9b213))',
    '--mf-mark': 'var(--color-chalk, #f5f0ee)',
    '--mf-rule': 'var(--nd-rule-strong, rgb(245 240 238 / 0.28))',
    '--mf-ease': 'var(--nd-ease, cubic-bezier(0.16, 1, 0.3, 1))',
    ...style,
  }

  return (
    <div
      className={['nd-manifold', className].filter(Boolean).join(' ')}
      data-animate={animate ? 'true' : 'false'}
      style={root}
    >
      <style>{MANIFOLD_CSS}</style>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        /* Decorative. See the header for why this is hidden rather than
           described: the sentence it would say is the heading beside it, and
           the six cards are a composition rather than a headcount. */
        aria-hidden="true"
        focusable="false"
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <defs>
          <radialGradient id={halo}>
            <stop offset="0%" stopColor="var(--mf-ink)" stopOpacity="0.92" />
            <stop offset="52%" stopColor="var(--mf-ink)" stopOpacity="0.78" />
            <stop offset="100%" stopColor="var(--mf-ink)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* The hub. Drawn before the spokes, which it never touches: the disc
            ends at 42 and the nearest spoke starts at 46. */}
        <g className="mf-hub">
          <circle cx={HUB_X} cy={HUB_Y} r={HALO_R} fill={`url(#${halo})`} />
          <circle cx={HUB_X} cy={HUB_Y} r={HUB_R} fill="var(--mf-ink)" />
          <circle
            cx={HUB_X}
            cy={HUB_Y}
            r={HUB_R - 0.75}
            fill="none"
            stroke="var(--mf-rule)"
            strokeWidth={1.5}
          />
          <circle cx={HUB_X} cy={HUB_Y} r={DISC_R} fill="var(--mf-gold)" />
          {/* A literal `=`, drawn rather than typeset: two bars hold their
              position and their weight at every size, where a glyph would sit
              wherever the host font's metrics put it. */}
          <rect
            x={HUB_X - BAR_W / 2}
            y={HUB_Y - EQ_GAP / 2 - BAR_H}
            width={BAR_W}
            height={BAR_H}
            rx={BAR_H / 2}
            fill="var(--mf-ink)"
          />
          <rect
            x={HUB_X - BAR_W / 2}
            y={HUB_Y + EQ_GAP / 2}
            width={BAR_W}
            height={BAR_H}
            rx={BAR_H / 2}
            fill="var(--mf-ink)"
          />
        </g>

        {/* The trunk: the link's one funding approval, reaching the hub. */}
        <line
          className="mf-trunk"
          x1={HUB_X}
          y1={CAP_TOP + CAP_H}
          x2={HUB_X}
          y2={HUB_Y - HUB_R}
          stroke="var(--mf-mark)"
          strokeOpacity={0.7}
          strokeWidth={2}
          strokeDasharray={TRUNK_LEN}
          style={{ '--mf-draw': `${TRUNK_LEN}px` } as StyleVars}
        />

        {/* Six branches. Identical start radius, identical end radius,
            identical stroke, identical dash — so identical length. */}
        {FAN.map((node) => (
          <line
            key={`${node.x2},${node.y2}`}
            className="mf-spoke"
            x1={node.x1}
            y1={node.y1}
            x2={node.x2}
            y2={node.y2}
            stroke="var(--mf-mark)"
            strokeOpacity={0.7}
            strokeWidth={2}
            strokeDasharray={SPOKE_LEN}
            style={{ '--mf-draw': `${SPOKE_LEN}px` } as StyleVars}
          />
        ))}

        {/* Six recipients. Each holds one gold bar, and every bar is the width
            of the bar in the `=` above it. */}
        {FAN.map((node) => (
          <g
            key={`${node.cx},${node.cy}`}
            className="mf-node"
            style={{ '--mf-in-x': node.inX, '--mf-in-y': node.inY } as StyleVars}
          >
            <rect
              x={node.cx - NODE_W / 2}
              y={node.cy - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={NODE_R}
              fill="var(--mf-ink)"
              fillOpacity={0.92}
              stroke="var(--mf-rule)"
              strokeWidth={1.5}
            />
            <circle
              cx={node.cx}
              cy={node.cy - CARD_STACK / 2 + DOT_R}
              r={DOT_R}
              fill="var(--mf-mark)"
              fillOpacity={0.4}
            />
            <rect
              x={node.cx - BAR_W / 2}
              y={node.cy + CARD_STACK / 2 - BAR_H}
              width={BAR_W}
              height={BAR_H}
              rx={BAR_H / 2}
              fill="var(--mf-gold)"
            />
          </g>
        ))}

        {/* The link. One of them, which is the point. */}
        <g className="mf-capsule">
          <rect
            x={CAP_X}
            y={CAP_TOP}
            width={CAP_W}
            height={CAP_H}
            rx={CAP_R}
            fill="var(--mf-ink)"
            fillOpacity={0.92}
            stroke="var(--mf-rule)"
            strokeWidth={1.5}
          />
          <g
            transform={`translate(181 ${CAP_MID - 14}) scale(${round(28 / 24)})`}
            fill="none"
            stroke="var(--mf-mark)"
            strokeOpacity={0.78}
            strokeWidth={1.8}
            strokeLinecap="round"
          >
            <path d="M9 17H7A5 5 0 0 1 7 7h2" />
            <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
            <path d="M8 12h8" />
          </g>
          <rect
            x={218.667}
            y={CAP_MID - 2.5}
            width={38}
            height={5}
            rx={2.5}
            fill="var(--mf-mark)"
            fillOpacity={0.42}
          />
        </g>
      </svg>
    </div>
  )
}
