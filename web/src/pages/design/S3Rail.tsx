import { useCallback, useRef, useState } from 'react'
import {
  ChevronRightIcon,
  ClockExpiryIcon,
  CustodyShieldIcon,
  QrCodeIcon,
  ShareIcon,
} from '../../ui/icons'
import { CUSTODY, DROP, GAMES, MockQr, TRIVIA } from './content'
import { Amount, NimMark, Pips } from './nim'
import { kitCss } from './nimkit'
import type { SampleMeta, SampleProps } from './screens'
import { themeCss } from './theme'

/**
 * DEV-ONLY SAMPLE — s3, "Rail".
 *
 * ## The form
 *
 * **One glass sheet, done properly.** This is the sample that takes the
 * reference's own material seriously: a dark translucent card at 55% over the
 * bloom, a hairline all round, a brighter inset on the top edge only, and a
 * real `backdrop-filter` so the light is genuinely visible THROUGH it rather
 * than approximated with a flat dark fill. If the owner picked the reference
 * for its cards, this is the sample that is actually about them.
 *
 * **Soft everywhere.** 30px on the sheet, 999px on every control. It is the
 * opposite corner language to `s1` and nothing in it is allowed a hard edge.
 *
 * **The amount is outlined, not plated.** A hairline above and below it and
 * nothing behind, so the bloom passes through the money too. That is only safe
 * because the sheet's barrier fill is what the contrast was computed against;
 * on a sample with no sheet it would not be.
 *
 * **The primary is a slide-to-confirm rail.** A 62px pill with a circular
 * white knob carrying the Nimiq mark, dragged left to right. This is the one
 * deliberate friction in the whole set, and it is defensible on exactly one
 * screen in this product: a stranger is about to hand a wallet a signature
 * request, and a slide cannot be triggered by a mis-tap on a link they just
 * opened. It is also the pattern the category already uses for send.
 *
 * **Spacious.** Generous padding, one thing per band, nothing crowded.
 *
 * ## The motion character: fluid
 *
 * Everything follows the finger or eases out of a spring-free expo curve.
 * The knob tracks the pointer one to one with no lag and no smoothing; let go
 * short of the end and it returns over 380ms; carry it past 78% and the rail
 * fills white left to right over 420ms and settles into a confirmation. Share
 * marks scale to nothing over 300ms as they are taken rather than blinking
 * out. The countdown capsule breathes on a four second cycle. Nothing steps,
 * nothing snaps, and nothing bounces.
 *
 * ## Trivia, and the silence
 *
 * The options are soft pills at 52px with an 8px gap, which is inside the
 * `GlassSheet` contract the foundation work already published (48px minimum,
 * 8px gap, selection carried by border, fill and weight rather than colour).
 * **This sample stays inside that contract**, so the other worker's trivia
 * surface can adopt it without renegotiation.
 *
 * The never-reveal rule is answered by **committing with the same rail**. The
 * label reads `Slide to lock in`, and the gesture makes the submission
 * physical and final without evaluating it. You sealed it. The rail then
 * resets for the next question and the progress capsule advances. It is the
 * closest thing in the set to the sealed-envelope feeling the rule wants.
 *
 * ## The thirteen claim states
 *
 * All thirteen fit. The rail is the only element that varies: it is present
 * and armed on `ready`, replaced by a status capsule on the in-flight states,
 * and replaced by a single quiet pill on the outcomes. Nothing else in the
 * sheet has to move.
 */

export const S3_META: SampleMeta = {
  id: 's3',
  name: 'Rail',
  thesis: 'One properly built glass sheet, and a slide rather than a tap on the one screen that earns it.',
  form: 'Slide-to-confirm rail · amount outlined with hairlines, no plate · one glass sheet · 30px and pill corners · centred · spacious',
  motion: 'Fluid. The knob tracks the finger one to one, returns over 380ms, and the rail fills left to right over 420ms.',
  silence: 'The same slide commits the answer. Sealing a submission, firmly, without evaluating it.',
}

const P = 's3'
/** Past this fraction of the rail the gesture counts as committed. */
const COMMIT = 0.78

export default function S3Rail({ screen, solo, pressed }: SampleProps) {
  const [picked, setPicked] = useState<number | null>(TRIVIA.picked)
  const [open, setOpen] = useState(false)
  const claimed = screen === 'claimed'
  const left = claimed ? DROP.left - 1 : DROP.left
  const trivia = screen === 'question'

  return (
    <div className={`${P}-root`} data-solo={solo ? 'true' : 'false'}>
      <style>{kitCss(P)}</style>
      <style>{themeCss(P)}</style>
      <style>{css()}</style>

      <div className={`${P}-field`} data-tone={claimed || screen === 'passed' ? 'warm' : 'live'}>
        <span className={`${P}-scrim`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />

        <div className={`${P}-inner`}>
          <header className={`${P}-head`}>
            <p className={`${P}-mast`}>NimDrops</p>
            <button type="button" className={`${P}-round`} aria-label="Share the app">
              <ShareIcon size={18} />
            </button>
          </header>

          <div className={`${P}-stage`}>
            <section className={`${P}-sheet ${P}-glass`}>
              {screen === 'games' ? (
                <Games />
              ) : trivia ? (
                <Question picked={picked} onPick={setPicked} />
              ) : screen === 'failed' ? (
                <Failed />
              ) : (
                <>
                  <p className={`${P}-from`}>
                    <b>{DROP.sponsor}</b>
                    <span className={`${P}-chip`}>
                      {screen === 'gate' ? `${TRIVIA.tier} tier` : 'name unverified'}
                    </span>
                  </p>

                  {/* Outlined, not plated. Two hairlines and the bloom in
                      between, which only works because the sheet's barrier is
                      what the ratio was computed against. */}
                  <div className={`${P}-band`}>
                    <Amount value={DROP.amount} markScale={0.66} className={`${P}-amount`} />
                  </div>
                  <p className={`${P}-cap`}>
                    {claimed
                      ? 'Sent to the wallet that signed'
                      : screen === 'sealed'
                        ? 'Fixed and equal, for everyone who opens this link'
                        : screen === 'gate'
                          ? 'Answer five to open it. The amount does not change.'
                          : screen === 'passed'
                            ? 'Gate cleared. The share is yours to take.'
                            : 'The same for everyone who opens this link'}
                  </p>

                  {screen === 'sealed' ? (
                    <div className={`${P}-qrblock`}>
                      <div className={`${P}-qr`}>
                        <MockQr size={144} />
                      </div>
                      <p>Claiming needs a wallet to sign, and Nimiq Pay is a phone app.</p>
                    </div>
                  ) : claimed ? (
                    <div className={`${P}-facts`}>
                      <p>
                        <b>Paid to.</b> {DROP.address.slice(0, 19)}…
                      </p>
                      <p>
                        <b>Confirmed.</b> 26 Jul, 21:04 UTC
                      </p>
                    </div>
                  ) : (
                    <p className={`${P}-msg`}>{DROP.message}</p>
                  )}
                </>
              )}

              <Rail screen={screen} pressed={pressed} armed={!trivia || picked !== null} />
            </section>

            {screen === 'sealed' || screen === 'games' ? null : (
              <div className={`${P}-live`}>
                <span className={`${P}-capsule`}>
                  <Pips total={DROP.shares} left={left} size={12} />
                  <span className={`${P}-num`}>
                    {left} of {DROP.shares} left
                  </span>
                </span>
                <span className={`${P}-capsule ${P}-capsule--breathe`}>
                  <ClockExpiryIcon size={14} />
                  <span className={`${P}-num`}>
                    {trivia ? `${TRIVIA.secondsLeft}s` : DROP.expiresIn}
                  </span>
                </span>
              </div>
            )}
          </div>

          <div className={`${P}-disc`}>
            <button
              type="button"
              className={`${P}-discbtn`}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <CustodyShieldIcon size={18} />
              NimDrops is holding this NIM
              <ChevronRightIcon size={16} className={`${P}-caret`} />
            </button>
            {open ? (
              <div className={`${P}-discbody ${P}-glass`}>
                {CUSTODY.map((f) => (
                  <p key={f.k}>
                    <b>{f.k}.</b> {f.v}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The slide.
 *
 * Pointer events rather than a library: `setPointerCapture` gives the knob the
 * stream even when the finger leaves it, which is the whole reliability
 * problem with hand-rolled sliders, and it is eleven lines. No dependency
 * earns its place here.
 *
 * It is not the only way to act. A keyboard user tabs to the knob and presses
 * Enter or Space, which commits directly, because a drag gesture is not an
 * accessible sole path to somebody's money.
 */
function Rail({
  screen,
  pressed,
  armed,
}: {
  screen: string
  pressed?: boolean
  armed: boolean
}) {
  const track = useRef<HTMLDivElement>(null)
  const [x, setX] = useState(0)
  const [done, setDone] = useState(false)
  const [dragging, setDragging] = useState(false)

  const travel = useCallback((clientX: number) => {
    const el = track.current
    if (!el) return 0
    const box = el.getBoundingClientRect()
    const usable = Math.max(1, box.width - 56)
    return Math.min(1, Math.max(0, (clientX - box.left - 28) / usable))
  }, [])

  if (screen === 'sealed') {
    return (
      <p className={`${P}-sealedline`}>
        <QrCodeIcon size={17} />
        Scan with the phone that has Nimiq Pay
      </p>
    )
  }
  if (screen === 'failed') {
    return <p className={`${P}-sealedline`}>Starting again unlocks in {TRIVIA.cooldownMinutes}:00</p>
  }
  if (screen === 'claimed' || screen === 'games') {
    return (
      <button type="button" className={`${P}-quiet`}>
        {screen === 'claimed' ? 'Send a drop back' : 'Open a gated drop'}
      </button>
    )
  }

  const label =
    screen === 'question'
      ? 'Slide to lock in'
      : screen === 'gate'
        ? 'Slide to start'
        : `Slide to open ${DROP.amount} NIM`
  const p = done || pressed ? 1 : x

  return (
    <div
      ref={track}
      className={`${P}-rail`}
      data-done={done ? 'true' : 'false'}
      data-dragging={dragging || pressed ? 'true' : 'false'}
      data-armed={armed ? 'true' : 'false'}
    >
      <span className={`${P}-railfill`} style={{ transform: `scaleX(${p})` }} aria-hidden="true" />
      <span className={`${P}-raillabel`}>{done ? 'Locked in' : label}</span>
      <button
        type="button"
        className={`${P}-knob`}
        style={{ '--p': p } as React.CSSProperties}
        aria-label={label}
        disabled={!armed}
        onPointerDown={(e) => {
          if (!armed) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (!dragging) return
          setX(travel(e.clientX))
        }}
        onPointerUp={(e) => {
          if (!dragging) return
          e.currentTarget.releasePointerCapture(e.pointerId)
          setDragging(false)
          const at = travel(e.clientX)
          if (at >= COMMIT) {
            setDone(true)
            setX(1)
          } else {
            setX(0)
          }
        }}
        onKeyDown={(e) => {
          // A drag is not an accessible sole path to somebody's money.
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setDone(true)
            setX(1)
          }
        }}
      >
        <NimMark height="18px" />
      </button>
    </div>
  )
}

function Question({ picked, onPick }: { picked: number | null; onPick: (i: number) => void }) {
  return (
    <>
      <p className={`${P}-from`}>
        <b>
          Question {TRIVIA.index} of {TRIVIA.total}
        </b>
        <span className={`${P}-chip`}>{TRIVIA.category}</span>
      </p>
      <span className={`${P}-progbar`} aria-hidden="true">
        {Array.from({ length: TRIVIA.total }).map((_, i) => (
          <i key={i} data-on={i < TRIVIA.index - 1 ? 'true' : 'false'} />
        ))}
      </span>
      {/* The caption slot directly under the amount is where the question goes
          on a gated claim; here the session runs on its own screen, so the
          question takes the sheet's own heading slot at the same weight. */}
      <h1 className={`${P}-q`}>{TRIVIA.question}</h1>
      <div className={`${P}-opts`}>
        {TRIVIA.options.map((o, i) => (
          <button
            key={o}
            type="button"
            className={`${P}-opt`}
            aria-pressed={picked === i}
            onClick={() => onPick(i)}
          >
            {o}
          </button>
        ))}
      </div>
      <p className={`${P}-tiny`}>
        The deadline is the server&rsquo;s. A late answer ends the session the same way a wrong one
        does, and neither is reported back to you.
      </p>
    </>
  )
}

function Failed() {
  return (
    <>
      <p className={`${P}-from`}>
        <b>Session closed</b>
        <span className={`${P}-chip`}>{TRIVIA.tier} tier</span>
      </p>
      <h1 className={`${P}-q`}>This session did not clear.</h1>
      <p className={`${P}-msg`}>
        Which answers were wrong is not something NimDrops reports, for any session. The drop is
        still live and the questions will be the same ones.
      </p>
      <div className={`${P}-facts`}>
        <p>
          <b>Try again in.</b> {TRIVIA.cooldownMinutes}:00
        </p>
        <p>
          <b>Drop closes in.</b> {DROP.expiresIn}
        </p>
      </div>
    </>
  )
}

function Games() {
  return (
    <>
      <p className={`${P}-from`}>
        <b>Gated drops</b>
        <span className={`${P}-chip`}>open now</span>
      </p>
      <div className={`${P}-list`}>
        {GAMES.map((g) => (
          <button key={g.tier} type="button" className={`${P}-listrow`} disabled={Boolean(g.locked)}>
            <span className={`${P}-listtier`}>{g.tier}</span>
            <span className={`${P}-listamt`}>
              <b className={`${P}-num`}>{g.amount}</b>
              <NimMark height="0.78em" />
            </span>
            <span className={`${P}-num ${P}-listmeta`}>
              {g.left} of {g.of} · {g.expires}
            </span>
            <span className={`${P}-chip`}>{g.locked || 'Open'}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function css() {
  return `
/* =========================================================================
 * s3 "Rail" — one glass sheet, slide to confirm, fluid, spacious.
 * ====================================================================== */
.${P}-root { --gut: 20px; --sheet: 26rem; }
.${P}-inner {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  gap: 18px; padding: 20px var(--gut) 24px; overflow-y: auto;
}
.${P}-root[data-solo='true'] .${P}-inner { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
.${P}-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.${P}-mast { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.012em; }
.${P}-stage { display: flex; flex-direction: column; gap: 14px; flex: 1; justify-content: center; min-height: 0; }

.${P}-sheet {
  width: 100%; max-width: var(--sheet); margin: 0 auto;
  padding: 24px 22px 22px; border-radius: 30px;
}

.${P}-from { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; font-size: 15px; }
.${P}-from b { font-weight: 800; }

/* The outlined band. No fill: the bloom passes through the money. */
.${P}-band {
  margin: 20px 0 0; padding: 16px 0 14px;
  border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong);
}
.${P}-amount {
  display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap;
  margin: 0; font-size: 64px; font-weight: 700; line-height: 0.94; letter-spacing: -0.038em;
}
.${P}-cap { margin: 14px 0 0; font-size: 14px; line-height: 1.5; color: var(--ink-2); text-align: center; text-wrap: balance; }
.${P}-msg { margin: 18px 0 0; font-size: 17px; line-height: 1.45; text-wrap: pretty; }
.${P}-facts { margin-top: 16px; }
.${P}-facts p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
.${P}-facts b { color: var(--ink); font-weight: 800; }
.${P}-tiny { margin: 14px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }

/* --- the rail ------------------------------------------------------------
 * 62px, fully rounded, with a 56px knob inside a 3px inset. The fill is a
 * transform on a pseudo-layer, so dragging never touches layout.
 * ---------------------------------------------------------------------- */
.${P}-rail {
  /* The rail is its own container, so the knob's travel can be expressed as
     100cqw minus 60px and stay a transform. Animating left would be a layout
     property on every frame of a drag, which is the one thing a drag cannot
     afford. */
  container-type: inline-size;
  position: relative; overflow: hidden;
  height: 62px; margin-top: 22px; border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgb(255 255 255 / 0.07);
  touch-action: pan-y;
}
.${P}-rail[data-armed='false'] { opacity: 0.45; }
.${P}-railfill {
  position: absolute; inset: 0; transform-origin: left;
  background: var(--action);
  transition: transform 380ms var(--ease);
}
.${P}-rail[data-dragging='true'] .${P}-railfill { transition: none; }
.${P}-rail[data-done='true'] .${P}-railfill { transition: transform 420ms var(--ease); }
.${P}-raillabel {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 15.5px; font-weight: 800; letter-spacing: -0.005em;
  color: var(--ink); pointer-events: none;
  transition: color 280ms var(--ease);
}
.${P}-rail[data-done='true'] .${P}-raillabel { color: var(--on-action); }
.${P}-knob {
  position: absolute; top: 3px; left: 3px;
  transform: translateX(calc((100cqw - 60px) * var(--p, 0)));
  display: grid; place-items: center;
  width: 54px; height: 54px; border-radius: 50%;
  border: 0; background: var(--action); color: var(--on-action);
  cursor: grab; touch-action: none;
  box-shadow: 0 4px 14px -6px rgb(0 0 0 / 0.8);
  transition: transform 380ms var(--ease), box-shadow 200ms ease-out;
}
/* While the finger is down the knob tracks it one to one. Any transition here
   is lag, and lag on a drag is the difference between a control that feels
   attached to the thumb and one that does not. */
.${P}-rail[data-dragging='true'] .${P}-knob { transition: none; cursor: grabbing; box-shadow: 0 8px 22px -8px rgb(0 0 0 / 0.9); }

.${P}-quiet {
  display: block; width: 100%; min-height: 56px; margin-top: 22px; padding: 15px 20px;
  border: 1px solid var(--line-strong); border-radius: 999px;
  background: none; color: var(--ink);
  font: inherit; font-size: 16px; font-weight: 700; cursor: pointer;
  transition: background-color 200ms var(--ease), border-color 200ms var(--ease);
}
.${P}-quiet:hover { background: rgb(255 255 255 / 0.08); border-color: rgb(255 255 255 / 0.4); }
.${P}-sealedline {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 56px; margin: 18px 0 0; font-size: 13.5px; font-weight: 700;
  color: var(--ink-2); text-align: center; text-wrap: balance;
}
.${P}-sealedline svg { color: var(--accent); flex: 0 0 auto; }

/* --- capsules --- */
.${P}-live { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
.${P}-capsule {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 34px; padding: 6px 14px; border-radius: 999px;
  border: 1px solid var(--line); background: rgb(20 12 10 / 0.5);
  font-size: 13px; font-weight: 700;
}
.${P}-capsule svg { color: var(--accent); }
.${P}-capsule--breathe { animation: ${P}-breathe 4s ease-in-out infinite; }
@keyframes ${P}-breathe { 0%, 100% { opacity: 0.72; } 50% { opacity: 1; } }

/* --- custody --- */
.${P}-disc { width: 100%; max-width: var(--sheet); margin: 0 auto; }
.${P}-discbtn {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 48px; padding: 12px 16px;
  border: 1px solid var(--line); border-radius: 999px;
  background: rgb(20 12 10 / 0.45);
  font: inherit; font-size: 13.5px; font-weight: 700; color: var(--ink);
  text-align: left; cursor: pointer;
  transition: background-color 200ms var(--ease), border-color 200ms var(--ease);
}
.${P}-discbtn:hover { background: rgb(20 12 10 / 0.7); }
.${P}-discbtn > svg:first-child { color: var(--accent); flex: 0 0 auto; }
.${P}-caret { margin-left: auto; color: var(--ink-2); transition: transform 260ms var(--ease); }
.${P}-discbtn[aria-expanded='true'] .${P}-caret { transform: rotate(90deg); }
.${P}-discbody { margin-top: 8px; padding: 16px 18px 8px; border-radius: 24px; }
.${P}-discbody p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }
.${P}-discbody b { color: var(--ink); font-weight: 800; }

/* --- trivia: soft pills, inside the published GlassSheet option contract --- */
.${P}-progbar { display: flex; gap: 5px; margin-top: 14px; }
.${P}-progbar i { flex: 1; height: 4px; border-radius: 999px; background: rgb(255 255 255 / 0.18); transition: background-color 300ms var(--ease); }
.${P}-progbar i[data-on='true'] { background: var(--ink); }
.${P}-q { margin: 18px 0 0; font-size: 23px; font-weight: 800; line-height: 1.22; letter-spacing: -0.024em; text-wrap: balance; }
.${P}-opts { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.${P}-opt {
  width: 100%; min-height: 52px; padding: 13px 18px;
  border: 1px solid var(--line-strong); border-radius: 999px;
  background: rgb(255 255 255 / 0.05);
  font: inherit; font-size: 15px; color: var(--ink); text-align: left; cursor: pointer;
  transition: background-color 220ms var(--ease), border-color 220ms var(--ease), transform 220ms var(--ease);
}
.${P}-opt:hover { background: rgb(255 255 255 / 0.11); }
.${P}-opt[aria-pressed='true'] {
  background: var(--action); color: var(--on-action); border-color: var(--action); font-weight: 800;
}
.${P}-opt:active { transform: scale(0.985); }

/* --- sealed --- */
.${P}-qrblock { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 20px; }
.${P}-qr { padding: 9px; background: #fff; border-radius: 20px; line-height: 0; }
.${P}-qrblock p { margin: 0; max-width: 30ch; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); text-align: center; text-wrap: pretty; }

/* --- the list --- */
.${P}-list { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.${P}-listrow {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center;
  width: 100%; min-height: 64px; padding: 12px 18px;
  border: 1px solid var(--line-strong); border-radius: 22px;
  background: rgb(255 255 255 / 0.05);
  font: inherit; color: var(--ink); text-align: left; cursor: pointer;
  transition: background-color 220ms var(--ease);
}
.${P}-listrow:hover:not(:disabled) { background: rgb(255 255 255 / 0.11); }
.${P}-listrow:disabled { cursor: default; opacity: 0.66; }
.${P}-listtier { font-size: 16px; font-weight: 800; }
.${P}-listamt { display: inline-flex; align-items: baseline; gap: 5px; font-size: 20px; font-weight: 800; justify-self: end; }
.${P}-listmeta { font-size: 12.5px; color: var(--ink-2); }
.${P}-listrow .${P}-chip { justify-self: end; }

/* --- the poster --- */
@container (min-width: 54rem) {
  .${P}-inner { padding: 32px 44px 34px; }
  .${P}-stage { justify-content: center; }
  .${P}-sheet { padding: 30px 28px 26px; }
  .${P}-amount { font-size: 76px; }
  .${P}-live { position: absolute; top: 30px; right: 44px; z-index: 3; }
  .${P}-disc { position: absolute; bottom: 34px; left: 44px; z-index: 3; width: auto; max-width: 30rem; }
}

@media (prefers-reduced-motion: reduce) {
  .${P}-capsule--breathe { animation: none; opacity: 1; }
}
`
}
