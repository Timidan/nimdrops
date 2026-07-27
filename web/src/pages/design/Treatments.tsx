import { type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { DESIGN_SENTINEL, PHONE } from './Board'
import S1Bar, { S1_META } from './S1Bar'
import S2Column, { S2_META } from './S2Column'
import S3Rail, { S3_META } from './S3Rail'
import S4Stack, { S4_META } from './S4Stack'
import S5Packet, { S5_META } from './S5Packet'
import { SCREENS, type SampleMeta, type SampleProps, type Screen } from './screens'

/**
 * DEV-ONLY. Five design systems for NimDrops, on one colour scheme.
 *
 * The palette is settled: warm near-black, a single vermilion bloom behind the
 * content reading as a light source, dark translucent cards so the bloom shows
 * through, near-white text, circular hairline icon buttons. It is in `theme.ts`
 * and it is identical in all five. Colour is the constant here, deliberately,
 * because the round before this one varied nothing else and that was the
 * complaint.
 *
 * What differs is everything about the form:
 *
 *   s1 Bar      full-bleed bottom bar · no card · sharp · top-weighted · mechanical
 *   s2 Column   one pill · no container at all · the numeral is the screen · nearly still
 *   s3 Rail     slide to confirm · one glass sheet · soft · spacious · fluid
 *   s4 Stack    bottom sheet · split screen · circular icon rail · tight · sheet-driven
 *   s5 Packet   circular seal on a fold · an object, not a card · still, then decisive
 *
 * Each covers all eight screens in `screens.ts`, including the trivia gate, so
 * that what is being compared is a system and not a screenshot.
 *
 * ## The guard
 *
 * Mounted from `App.tsx` behind `import.meta.env.DEV`, which Vite substitutes
 * with the literal `false` in a production build, so this whole module tree is
 * dead code the bundler drops. It carries `Board.tsx`'s existing sentinel,
 * `nd-design-only-surface`, so the same `grep web/dist` proves the same thing
 * about these as it does about `/design/a|b|c`.
 *
 * ## Routes, all under the one `/design/:treatment` line in `App.tsx`
 *
 *   /design/s1                    the board: all eight screens, framed
 *   /design/s1?solo=claim         one screen alone, full viewport, no chrome
 *   /design/s1?solo=claim&press=1 the same, with the primary held down
 *   /design/all                   the contact sheet: five claim screens side by side
 *   /design/all?screen=question   the contact sheet for any other screen
 */

const SAMPLES: (SampleMeta & { Surface: (p: SampleProps) => ReactNode })[] = [
  { ...S1_META, Surface: S1Bar },
  { ...S2_META, Surface: S2Column },
  { ...S3_META, Surface: S3Rail },
  { ...S4_META, Surface: S4Stack },
  { ...S5_META, Surface: S5Packet },
]

const NOTE: Record<Screen, string> = {
  claim: 'the judged surface',
  claimed: 'the beat, spent, and the receipt',
  sealed: 'no wallet provider. Every desktop is this',
  gate: 'a gated drop, before the session starts',
  question: 'the trivia workhorse: prompt, four options, deadline, progress',
  passed: 'the gate cleared, leading into the claim',
  failed: 'did not clear, with the cooldown and no dead button',
  games: 'the discovery list, and the tier each drop needs',
}

export default function Treatment() {
  const { treatment } = useParams()
  const [params] = useSearchParams()

  if (treatment === 'all') return <ContactSheet screen={pickScreen(params.get('screen'))} />

  const sample = SAMPLES.find((s) => s.id === treatment)
  if (!sample) return <Index />

  const solo = params.get('solo')
  if (solo && (SCREENS as string[]).includes(solo)) {
    return (
      <div className={DESIGN_SENTINEL} data-solo={solo}>
        <sample.Surface screen={solo as Screen} solo pressed={params.get('press') === '1'} />
      </div>
    )
  }

  return (
    <div className={DESIGN_SENTINEL}>
      <style>{boardCss()}</style>
      <Bar sample={sample} />
      <main className="tb-main">
        {SCREENS.map((screen) => (
          <Panel key={screen} label={screen} note={NOTE[screen]} width={PHONE} height={844}>
            <sample.Surface screen={screen} />
          </Panel>
        ))}
        <Panel label="sealed" note="the only desktop composition there is" height={760} wide>
          <sample.Surface screen="sealed" />
        </Panel>
        <Panel label="question" note="the trivia workhorse at full width" height={760} wide>
          <sample.Surface screen="question" />
        </Panel>
      </main>
    </div>
  )
}

function pickScreen(v: string | null): Screen {
  return v && (SCREENS as string[]).includes(v) ? (v as Screen) : 'claim'
}

/**
 * The contact sheet. Five systems at phone width in one image, which is the
 * only way to judge them: a form decision is a comparative judgement and five
 * separate files are five separate first impressions.
 */
function ContactSheet({ screen }: { screen: Screen }) {
  return (
    <div className={DESIGN_SENTINEL} data-contact="true">
      <style>{boardCss()}</style>
      <style>{contactCss()}</style>
      <header className="cs-head">
        <h1>Five design systems, one colour scheme</h1>
        <p>
          Warm near-black, one vermilion bloom, dark translucent cards, near-white text, circular
          hairline icon buttons. Identical in all five. What changes is the primary action, the
          amount, the containment, the corners, the anchor, the density and the motion.
        </p>
        <nav className="cs-nav">
          {SCREENS.map((s) => (
            <a key={s} href={`/design/all?screen=${s}`} aria-current={s === screen || undefined}>
              {s}
            </a>
          ))}
        </nav>
      </header>
      <div className="cs-row">
        {SAMPLES.map((sample) => (
          <figure key={sample.id} className="cs-cell">
            <div className="cs-frame">
              <sample.Surface screen={screen} />
            </div>
            <figcaption>
              <b>
                {sample.id} {sample.name}
              </b>
              <em>{sample.thesis}</em>
              <span>{sample.form}</span>
              <span>
                <i>Motion.</i> {sample.motion}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

function Bar({ sample }: { sample: SampleMeta }) {
  return (
    <header className="tb-bar">
      <span className="tb-tag">{sample.id}</span>
      <div className="tb-titles">
        <h1>{sample.name}</h1>
        <p>{sample.thesis}</p>
        <p className="tb-dim">{sample.form}</p>
        <p className="tb-dim">
          <b>Motion.</b> {sample.motion}
        </p>
        <p className="tb-dim">
          <b>Silence.</b> {sample.silence}
        </p>
      </div>
      <nav className="tb-nav">
        {SAMPLES.map((s) => (
          <a key={s.id} href={`/design/${s.id}`} aria-current={s.id === sample.id || undefined}>
            {s.id}
          </a>
        ))}
        <a href="/design/all">all</a>
        <a href={`/design/${sample.id}?solo=claim`}>solo</a>
      </nav>
    </header>
  )
}

function Index() {
  return (
    <div className={DESIGN_SENTINEL}>
      <style>{boardCss()}</style>
      <main className="tb-main tb-index">
        <h1>Five design systems, one colour scheme</h1>
        <ul>
          <li>
            <a href="/design/all">
              <b>all · contact sheet</b>
              <span>Five claim screens side by side, which is the way to judge them.</span>
            </a>
          </li>
          {SAMPLES.map((s) => (
            <li key={s.id}>
              <a href={`/design/${s.id}`}>
                <b>
                  {s.id} {s.name}
                </b>
                <span>{s.thesis}</span>
              </a>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

interface PanelProps {
  label: string
  note: string
  width?: number
  height: number
  wide?: boolean
  children: ReactNode
}

function Panel({ label, note, width, height, wide, children }: PanelProps) {
  return (
    <section className={wide ? 'tb-panel tb-panel--wide' : 'tb-panel'}>
      <p className="tb-cap">
        <b>{label}</b>
        <span> · {note}</span>
      </p>
      <div className="tb-frame" style={width ? { width, height } : { height }}>
        {children}
      </div>
    </section>
  )
}

function boardCss() {
  return `
.${DESIGN_SENTINEL} {
  min-height: 100dvh;
  background: #070504;
  color: #ece7e4;
  font: 13px/1.45 'Mulish', ui-sans-serif, system-ui, sans-serif;
}
.${DESIGN_SENTINEL}[data-solo] { background: transparent; }
.${DESIGN_SENTINEL} * { box-sizing: border-box; }
.${DESIGN_SENTINEL} .tb-bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;
  padding: 11px 16px;
  background: #070504; border-bottom: 1px solid #2a1d19;
}
.${DESIGN_SENTINEL} .tb-tag {
  display: grid; place-items: center;
  width: 34px; height: 26px; flex: 0 0 auto; margin-top: 2px;
  border-radius: 7px; background: #ff5a22; color: #140c0a;
  font-weight: 800; font-size: 13px;
}
.${DESIGN_SENTINEL} .tb-titles { min-width: 0; flex: 1 1 34ch; }
.${DESIGN_SENTINEL} .tb-titles h1 { margin: 0; font-size: 15px; font-weight: 800; }
.${DESIGN_SENTINEL} .tb-titles p { margin: 2px 0 0; color: #b6a49d; max-width: 100ch; }
.${DESIGN_SENTINEL} .tb-dim { color: #8b7a74 !important; }
.${DESIGN_SENTINEL} .tb-dim b { color: #b6a49d; font-weight: 700; }
.${DESIGN_SENTINEL} .tb-nav { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.${DESIGN_SENTINEL} .tb-nav a {
  min-width: 34px; padding: 6px 10px; border-radius: 7px; text-align: center;
  border: 1px solid #3d2a24; color: #d9cbc5; text-decoration: none;
}
.${DESIGN_SENTINEL} .tb-nav a[aria-current] { background: #3d2a24; color: #fff; }
.${DESIGN_SENTINEL} .tb-main {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 22px;
  padding: 20px 16px 64px;
}
.${DESIGN_SENTINEL} .tb-panel { flex: 0 0 auto; max-width: 100%; }
.${DESIGN_SENTINEL} .tb-panel--wide { flex: 1 1 100%; min-width: 0; }
.${DESIGN_SENTINEL} .tb-cap { margin: 0 0 7px; overflow-wrap: anywhere; }
.${DESIGN_SENTINEL} .tb-cap b { font-weight: 800; }
.${DESIGN_SENTINEL} .tb-cap span { color: #8b7a74; }
.${DESIGN_SENTINEL} .tb-frame {
  max-width: 100%; overflow: hidden; border-radius: 14px; outline: 1px solid #2a1d19;
}
.${DESIGN_SENTINEL} .tb-index { display: block; max-width: 72ch; }
.${DESIGN_SENTINEL} .tb-index h1 { font-size: 25px; }
.${DESIGN_SENTINEL} .tb-index ul { list-style: none; padding: 0; }
.${DESIGN_SENTINEL} .tb-index a {
  display: block; padding: 14px 0; border-top: 1px solid #2a1d19;
  color: inherit; text-decoration: none;
}
.${DESIGN_SENTINEL} .tb-index b { display: block; font-size: 16px; }
.${DESIGN_SENTINEL} .tb-index span { color: #8b7a74; }
`
}

function contactCss() {
  return `
.${DESIGN_SENTINEL}[data-contact] { padding: 26px 26px 40px; }
.${DESIGN_SENTINEL} .cs-head { max-width: 100ch; margin-bottom: 20px; }
.${DESIGN_SENTINEL} .cs-head h1 { margin: 0; font-size: 23px; font-weight: 800; letter-spacing: -0.02em; }
.${DESIGN_SENTINEL} .cs-head p { margin: 6px 0 0; color: #b6a49d; text-wrap: pretty; }
.${DESIGN_SENTINEL} .cs-nav { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.${DESIGN_SENTINEL} .cs-nav a {
  padding: 5px 11px; border-radius: 999px; border: 1px solid #3d2a24;
  color: #d9cbc5; text-decoration: none; font-size: 12px;
}
.${DESIGN_SENTINEL} .cs-nav a[aria-current] { background: #fff; color: #140c0a; border-color: #fff; font-weight: 700; }
.${DESIGN_SENTINEL} .cs-row { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
.${DESIGN_SENTINEL} .cs-cell { flex: 0 0 auto; width: ${PHONE}px; max-width: 100%; margin: 0; }
.${DESIGN_SENTINEL} .cs-frame {
  width: 100%; height: 844px; overflow: hidden;
  border-radius: 18px; outline: 1px solid #33231e;
}
.${DESIGN_SENTINEL} .cs-cell figcaption { display: block; padding: 10px 2px 0; }
.${DESIGN_SENTINEL} .cs-cell figcaption b { font-size: 15px; font-weight: 800; }
.${DESIGN_SENTINEL} .cs-cell figcaption em {
  display: block; margin-top: 3px; font-style: normal; color: #b6a49d; text-wrap: pretty;
}
.${DESIGN_SENTINEL} .cs-cell figcaption span {
  display: block; margin-top: 5px; color: #8b7a74; text-wrap: pretty;
}
.${DESIGN_SENTINEL} .cs-cell figcaption i { font-style: normal; color: #b6a49d; font-weight: 700; }
`
}
