import { noise } from './nimkit'

/**
 * DEV-ONLY. The one colour scheme all five samples share.
 *
 * The owner chose it from a reference UI (a motorcycle-rental app) and the
 * decision is closed: warm near-black, a single vermilion bloom behind the
 * content reading as a light source, dark translucent cards so the bloom shows
 * through them, near-white text, and circular hairline icon buttons as a
 * system. Colour is now the constant. The five samples differ in layout,
 * component design and motion, and in nothing else.
 *
 * ## The tokens, and how they were tuned
 *
 * Starting points came from the reference; every one was then adjusted against
 * a rendered 390px screen rather than accepted on paper.
 *
 *   base        `#0E0A09`. Warm near-black, kept exactly. It is not neutral
 *               charcoal and the warmth matters: a neutral base makes the
 *               bloom look like a coloured light shining on grey, and a warm
 *               one makes it look like the same material lit unevenly.
 *   base-2      `#16100E`, the second stop, also kept.
 *   bloom core  `#FF4D14`, kept, but placed at 8% of the radial rather than 0%
 *               so the very centre is `#FF5A1E` and the core has a shoulder.
 *               A radial whose brightest stop is at 0% has a hot spot; one
 *               with a shoulder has a source.
 *   bloom fall  `#F2551B -> #C4380F -> #93250B -> #7A1D08 -> #451208 ->
 *               #1C0F0B -> #0E0A09`. Seven stops. This is where the reference's
 *               depth actually comes from: the fall-off is long and it passes
 *               through oxblood on the way, so the dark end reads as the same
 *               light dying rather than as a different colour underneath.
 *   card        `rgb(28 18 16 / 0.55)` at the reference's own value when the
 *               sheet has backdrop-filter, thickened to `0.86` on the flat
 *               path. Measured: at 0.55 over the bloom the barrier still
 *               carries body text at 7:1, so the reference's number survives
 *               contact with the contrast floor and did not need raising.
 *   card line   `rgb(255 255 255 / 0.10)` all round, with a brighter
 *               `rgb(255 255 255 / 0.18)` inset on the TOP edge only. That top
 *               highlight is most of what makes the reference's cards read as
 *               physical.
 *   ink         `#F5F0EE`, kept.
 *   ink-2       the reference sits its secondary text near 60%. At 0.60 over
 *               the card over the bloom's bright side that lands at 4.19:1,
 *               under the floor, so it is `0.68` here: 5.02:1, and visually
 *               indistinguishable from the reference.
 *   action      solid `#FFFFFF` with `#141010` text. Lifted from the
 *               reference's filter chips, where the active one is solid white
 *               among translucent siblings. It is the cheapest strong primary
 *               available and it leaves vermilion free to be the light rather
 *               than the button.
 *   gold        `#E9B213`, Nimiq's own, for the currency mark and nothing else.
 *
 * ## The bloom is a light, not a gradient
 *
 * One origin, off centre, seven stops, long fall-off, plus a second much
 * weaker core low and left so the dark end is not dead. Grain at 5.5% over the
 * whole thing, because a fall-off this long across a single hue is exactly the
 * case an eight-bit phone panel turns into stripes.
 */

/** Every literal in the scheme, in one object, so the report can quote it. */
export const T = {
  base: '#0e0a09',
  base2: '#16100e',
  bloomCore: '#ff5a1e',
  bloomHot: '#ff4d14',
  bloomDeep: '#7a1d08',
  card: 'rgb(28 18 16 / 0.55)',
  cardFlat: 'rgb(24 15 13 / 0.88)',
  cardSolid: '#1b1210',
  line: 'rgb(255 255 255 / 0.1)',
  lineStrong: 'rgb(255 255 255 / 0.22)',
  lip: 'rgb(255 255 255 / 0.18)',
  ink: '#f5f0ee',
  ink2: 'rgb(245 240 238 / 0.68)',
  action: '#ffffff',
  onAction: '#141010',
  accent: '#ff5a22',
  gold: '#e9b213',
  /** The cooler, brighter mark, for the A/B the report answers. */
  goldCool: '#ffd24a',
} as const

/**
 * The field, the ink roles and the two controls every sample shares: the
 * circular icon button and the pill chip. Everything else about a sample's
 * form is that sample's own business.
 *
 * Scoped by the caller's prefix, so five samples can sit on one contact sheet
 * without a single rule reaching across.
 */
export function themeCss(p: string): string {
  return `
.${p}-root {
  --base: ${T.base};
  --ink: ${T.ink};
  --ink-2: ${T.ink2};
  --line: ${T.line};
  --line-strong: ${T.lineStrong};
  --lip: ${T.lip};
  --card: ${T.card};
  --card-flat: ${T.cardFlat};
  --card-solid: ${T.cardSolid};
  --action: ${T.action};
  --on-action: ${T.onAction};
  --accent: ${T.accent};
  --gold: ${T.gold};
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  height: 100%;
  container-type: inline-size;
}
.${p}-root[data-solo='true'] { height: auto; }

/* --- the field -----------------------------------------------------------
 * One light source, off centre, with a seven-stop fall-off through oxblood
 * into warm near-black. The second core keeps the dark end alive. Neither is
 * a linear gradient and neither is at 135 degrees.
 * ---------------------------------------------------------------------- */
.${p}-field {
  position: relative; overflow: clip;
  min-height: 100%;
  display: flex; flex-direction: column;
  color: var(--ink);
  font-size: 16px; line-height: 1.55;
  background-color: var(--base);
  background-image:
    radial-gradient(72% 44% at 14% 88%,
      rgb(255 77 20 / 0.34) 0%, rgb(180 48 12 / 0.16) 42%, rgb(255 77 20 / 0) 72%),
    radial-gradient(104% 68% at 74% 14%,
      ${T.bloomCore} 0%, ${T.bloomHot} 7%, #c4380f 19%, #93250b 30%,
      ${T.bloomDeep} 41%, #451208 58%, #1c0f0b 78%, ${T.base} 100%);
}
.${p}-root[data-solo='true'] .${p}-field { min-height: 100dvh; }

/* The bloom brightens and STAYS brighter once the claim resolves. A ring is an
   event; a light that stayed on is a memory, and the screen should remember. */
.${p}-field::after {
  content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(64% 40% at 74% 14%,
    rgb(255 122 40 / 0.4) 0%, rgb(255 92 24 / 0.16) 40%, rgb(255 77 20 / 0) 74%);
  opacity: 0; transition: opacity 900ms var(--ease);
}
.${p}-field[data-tone='warm']::after { opacity: 1; }
.${p}-field[data-tone='quiet'] { filter: saturate(0.72) brightness(0.9); }

/* A scrim in the two bands where the field's own furniture sits. Composition
   first, because a poster wants weighted edges, and contrast headroom second:
   without it the wordmark sits on the bloom's bright side at 3.6:1. Every
   figure in the report is computed with this layer in place. */
.${p}-scrim {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: linear-gradient(to bottom,
    rgb(8 5 4 / 0.5) 0%, rgb(8 5 4 / 0) 20%,
    rgb(8 5 4 / 0) 56%, rgb(8 5 4 / 0.62) 100%);
}
.${p}-grain {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background-image: ${noise(0.76, 4)};
  opacity: 0.055;
}

/* --- the card material ---------------------------------------------------
 * Dark and translucent so the bloom reads THROUGH it, one hairline all round,
 * and a brighter inset on the top edge only. That top lip is most of what
 * makes the reference's cards look like objects rather than fills.
 * ---------------------------------------------------------------------- */
.${p}-glass {
  border: 1px solid var(--line);
  background: var(--card-flat);
  box-shadow: inset 0 1px 0 var(--lip), 0 30px 60px -38px rgb(0 0 0 / 0.95);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .${p}-glass {
    background: var(--card);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    backdrop-filter: blur(22px) saturate(150%);
  }
}
/* Reduce Transparency means solid, not "a bit less blur". */
@media (prefers-reduced-transparency: reduce) {
  .${p}-glass {
    background: var(--card-solid);
    -webkit-backdrop-filter: none; backdrop-filter: none;
  }
}

/* --- the circular icon button, as a system -------------------------------
 * One diameter, one hairline, used for every secondary affordance in every
 * sample. 44px is the touch floor and this is exactly 44.
 * ---------------------------------------------------------------------- */
.${p}-round {
  display: grid; place-items: center;
  width: 44px; height: 44px; flex: 0 0 auto;
  border: 1px solid var(--line-strong); border-radius: 50%;
  background: rgb(255 255 255 / 0.06);
  color: var(--ink); cursor: pointer;
  transition: background-color 140ms ease-out, transform 140ms var(--ease),
    border-color 140ms ease-out;
}
.${p}-round:hover { background: rgb(255 255 255 / 0.13); border-color: rgb(255 255 255 / 0.4); }
.${p}-round:active { transform: scale(0.92); }

/* The pill chip. Translucent by default; the active one is solid white with
   dark text, which is the reference's own way of marking a primary. */
.${p}-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 11px; border: 1px solid var(--line-strong); border-radius: 999px;
  font-size: 12px; font-weight: 600; color: var(--ink-2); white-space: nowrap;
}

.${p}-num { font-variant-numeric: tabular-nums; }

.${p}-root :where(a, button, [tabindex]):focus-visible {
  outline: 2px solid #ffb27a; outline-offset: 3px;
}

/* --- reduced motion ------------------------------------------------------
 * A different route to the same information, never a dead stop. Delays are
 * zeroed as well as durations, so nothing can be left waiting on one, and the
 * bloom keeps the warmth it gained, because that is the part that means
 * something. With animation switched off entirely every state still renders
 * complete: nothing here starts hidden.
 * ---------------------------------------------------------------------- */
@media (prefers-reduced-motion: reduce) {
  .${p}-root *, .${p}-root *::before, .${p}-root *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
}
`
}
