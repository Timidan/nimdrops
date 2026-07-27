import { useState } from 'react'
import {
  ClockExpiryIcon,
  CopyIcon,
  CustodyShieldIcon,
  InfoIcon,
  QrCodeIcon,
  ShareIcon,
} from '../../ui/icons'
import { CUSTODY, DROP, GAMES, MockQr, TRIVIA } from './content'
import { Amount, NimMark } from './nim'
import { kitCss } from './nimkit'
import type { SampleMeta, SampleProps } from './screens'
import { themeCss } from './theme'

/**
 * DEV-ONLY SAMPLE — s4, "Stack".
 *
 * ## The form
 *
 * **Asymmetric, and split.** The screen is two zones rather than one column:
 * an open upper field where the amount lives bare and oversized, pushed left
 * past the gutter, and a bottom sheet that rises over it carrying the sponsor,
 * the message and the action. Nothing else in the set is split this way, and
 * it is the only one where the money and the transaction are in different
 * places.
 *
 * **A vertical rail of circular icon buttons** runs down the right edge of the
 * upper field. That is the reference's clearest reusable idea: one diameter,
 * one hairline, used for every secondary affordance, so share, details and QR
 * stop being three differently-shaped one-offs. All three are 44px.
 *
 * **Tight.** This is the dense one. 12px rhythm inside the sheet against the
 * 22px the roomy sample uses, and the type steps by 1.2 rather than by 1.5.
 *
 * ## The motion character: sheet-driven, fluid
 *
 * Everything is anchored to the sheet. The primary compresses on the Y axis
 * rather than scaling uniformly, which reads as a physical button on a surface
 * rather than a shrinking rectangle. Circular buttons scale to 0.92. When a
 * state resolves the whole sheet **dips 30px and returns** over 620ms on an
 * expo curve, and the bloom behind it comes up and stays up. That dip is the
 * signature beat: the surface acknowledges, the light remembers.
 *
 * ## Trivia, and the silence
 *
 * The question sits bare in the upper field where the amount usually is, and
 * the four options are **two-up tiles in the sheet**, a 2x2 grid with a small
 * circular affordance in the corner of each, taken directly from the
 * reference's metric tiles. Selecting one turns that tile solid white.
 *
 * **This is the one sample that steps outside the published `GlassSheet`
 * option contract**, which specifies one option per line at 48px with an 8px
 * gap. A 2x2 grid is a real departure and the other worker should know: the
 * tiles are 84px tall and 8px apart, so the touch floor is met with room, but
 * a four-line option would be tight and this layout is only safe because the
 * spec fixes the count at four. If a tier ever needs five, this grid breaks
 * and the sample would fall back to rows.
 *
 * The never-reveal rule is answered by **the sheet dipping on commit**. The
 * surface visibly receives the answer and says nothing about it, then the next
 * question arrives in the upper field. Acknowledgement without evaluation, as
 * a physical gesture rather than a message.
 *
 * ## The thirteen claim states
 *
 * All thirteen fit. The upper field is invariant across every one of them and
 * only the sheet's contents change, which is the property that makes this the
 * cheapest of the five to extend: a new state is a new sheet body and nothing
 * else. The four outcome states drop the primary and the sheet shortens.
 */

export const S4_META: SampleMeta = {
  id: 's4',
  name: 'Stack',
  thesis: 'Split the screen: the money in the open field, the transaction in a sheet that rises over it.',
  form: 'Full-width pill in a bottom sheet · amount bare and bleeding left · sheet plus a circular icon rail · 30px top corners and circles · asymmetric · tight',
  motion: 'Sheet-driven. The primary compresses on Y, circles scale to 0.92, and the whole sheet dips 30px on a state change.',
  silence: 'The sheet dips to acknowledge the answer and says nothing about it. Receipt as a physical gesture.',
}

const P = 's4'

export default function S4Stack({ screen, solo, pressed }: SampleProps) {
  const [picked, setPicked] = useState<number | null>(TRIVIA.picked)
  const [open, setOpen] = useState(false)
  const claimed = screen === 'claimed'
  const left = claimed ? DROP.left - 1 : DROP.left
  const trivia = screen === 'question'
  const sealed = screen === 'sealed'

  return (
    <div className={`${P}-root`} data-solo={solo ? 'true' : 'false'}>
      <style>{kitCss(P)}</style>
      <style>{themeCss(P)}</style>
      <style>{css()}</style>

      <div className={`${P}-field`} data-tone={claimed || screen === 'passed' ? 'warm' : 'live'}>
        <span className={`${P}-scrim`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />

        <div className={`${P}-inner`}>
          <div className={`${P}-upper`}>
            <p className={`${P}-mast`}>NimDrops</p>

            {trivia ? (
              <div className={`${P}-qzone`}>
                <p className={`${P}-eyebrow`}>
                  {TRIVIA.index - 1} of {TRIVIA.total} answered · {TRIVIA.category}
                </p>
                <h1 className={`${P}-q`}>{TRIVIA.question}</h1>
              </div>
            ) : screen === 'games' ? (
              <div className={`${P}-qzone`}>
                <p className={`${P}-eyebrow`}>Gated drops, open now</p>
                <h1 className={`${P}-q`}>Answer five, take a share.</h1>
              </div>
            ) : screen === 'failed' ? (
              <div className={`${P}-qzone`}>
                <p className={`${P}-eyebrow`}>{TRIVIA.tier} tier</p>
                <h1 className={`${P}-q`}>This session did not clear.</h1>
              </div>
            ) : (
              <div className={`${P}-money`}>
                <Amount value={DROP.amount} markScale={0.68} className={`${P}-amount`} />
                <p className={`${P}-moneycap`}>
                  {claimed ? 'sent to the wallet that signed' : 'each, fixed and equal'}
                </p>
              </div>
            )}

            {/* One diameter, one hairline, every secondary affordance. */}
            <nav className={`${P}-rail`} aria-label="Drop actions">
              <button type="button" className={`${P}-round`} aria-label="Share the app">
                <ShareIcon size={18} />
              </button>
              <button type="button" className={`${P}-round`} aria-label="Copy the link">
                <CopyIcon size={18} />
              </button>
              <button
                type="button"
                className={`${P}-round`}
                aria-label="Who is holding this NIM"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                <InfoIcon size={18} />
              </button>
            </nav>

            {sealed ? null : (
              <div className={`${P}-tiles ${P}-tiles--live`}>
                <div className={`${P}-tile`}>
                  <p>Shares left</p>
                  <b className={`${P}-num`}>
                    {left} of {DROP.shares}
                  </b>
                  <span className={`${P}-affordance`} aria-hidden="true" />
                </div>
                <div className={`${P}-tile`}>
                  <p>{trivia ? 'On the server clock' : 'Closes in'}</p>
                  <b className={`${P}-num`}>{trivia ? `${TRIVIA.secondsLeft}s` : DROP.expiresIn}</b>
                  <span className={`${P}-affordance`} data-ring="true" aria-hidden="true">
                    <ClockExpiryIcon size={13} />
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* The sheet. It dips when a state resolves and the light stays up. */}
          <section className={`${P}-sheet ${P}-glass`} data-dip={claimed ? 'true' : 'false'}>
            <span className={`${P}-grab`} aria-hidden="true" />

            {open ? (
              <div className={`${P}-facts`}>
                {CUSTODY.map((f) => (
                  <p key={f.k}>
                    <b>{f.k}.</b> {f.v}
                  </p>
                ))}
              </div>
            ) : trivia ? (
              <>
                <div className={`${P}-tiles`}>
                  {TRIVIA.options.map((o, i) => (
                    <button
                      key={o}
                      type="button"
                      className={`${P}-tile ${P}-opt`}
                      aria-pressed={picked === i}
                      onClick={() => setPicked(i)}
                    >
                      <b>{o}</b>
                      <span className={`${P}-affordance`} aria-hidden="true">
                        {'ABCD'[i]}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : screen === 'games' ? (
              <div className={`${P}-list`}>
                {GAMES.map((g) => (
                  <button
                    key={g.tier}
                    type="button"
                    className={`${P}-listrow`}
                    disabled={Boolean(g.locked)}
                  >
                    <b>{g.tier}</b>
                    <span className={`${P}-listamt`}>
                      <b className={`${P}-num`}>{g.amount}</b>
                      <NimMark height="0.8em" />
                    </span>
                    <span className={`${P}-num ${P}-listmeta`}>
                      {g.left} of {g.of} · {g.expires}
                    </span>
                    <span className={`${P}-chip`}>{g.locked || 'Open'}</span>
                  </button>
                ))}
              </div>
            ) : screen === 'failed' ? (
              <p className={`${P}-msg`}>
                Which answers were wrong is not something NimDrops reports, for any session. The
                drop is still live and the questions will be the same ones.
              </p>
            ) : sealed ? (
              <div className={`${P}-sealed`}>
                <div className={`${P}-qr`}>
                  <MockQr size={132} />
                </div>
                <div>
                  <h2>Open this on your phone</h2>
                  <p>
                    Claiming needs a wallet to sign and Nimiq Pay is a phone app. There is nothing
                    to press here.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className={`${P}-from`}>
                  <b>{DROP.sponsor}</b> sent you a NimDrop
                  <span className={`${P}-chip`}>name unverified</span>
                </p>
                {claimed ? (
                  <p className={`${P}-msg ${P}-msg--small`}>
                    {DROP.address.slice(0, 19)}… · confirmed 21:04 UTC
                  </p>
                ) : (
                  <p className={`${P}-msg`}>{DROP.message}</p>
                )}
              </>
            )}

            <Primary screen={screen} pressed={pressed} picked={picked} open={open} />

            {open ? null : (
              <button
                type="button"
                className={`${P}-custody`}
                onClick={() => setOpen(true)}
              >
                <CustodyShieldIcon size={16} />
                NimDrops is holding this NIM
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function Primary({
  screen,
  pressed,
  picked,
  open,
}: {
  screen: string
  pressed?: boolean
  picked: number | null
  open: boolean
}) {
  if (open) {
    return null
  }
  if (screen === 'sealed') {
    return (
      <p className={`${P}-flat`}>
        <QrCodeIcon size={16} />
        Scan with the phone that has Nimiq Pay
      </p>
    )
  }
  if (screen === 'failed') {
    return <p className={`${P}-flat`}>Starting again unlocks in {TRIVIA.cooldownMinutes}:00</p>
  }
  const label =
    screen === 'claimed'
      ? 'Send a drop back'
      : screen === 'question'
        ? 'Lock in answer'
        : screen === 'gate'
          ? 'Start the five questions'
          : screen === 'games'
            ? 'Open a gated drop'
            : `Open ${DROP.amount} NIM`
  return (
    <button
      type="button"
      className={`${P}-go`}
      data-quiet={screen === 'claimed' ? 'true' : undefined}
      data-pressed={pressed ? 'true' : undefined}
      disabled={screen === 'question' && picked === null}
    >
      {label}
    </button>
  )
}

function css() {
  return `
/* =========================================================================
 * s4 "Stack" — split screen, bottom sheet, circular rail, tight, fluid.
 * ====================================================================== */
.${P}-root { --gut: 20px; }
.${P}-inner {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
}
.${P}-upper {
  position: relative;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  padding: 18px var(--gut) 18px;
}
.${P}-mast { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.012em; }

/* The money, bare, pushed past the left gutter. */
.${P}-money { margin-top: auto; margin-left: calc(var(--gut) * -0.5); }
.${P}-amount {
  display: flex; align-items: baseline; margin: 0;
  font-size: 88px; font-weight: 800; line-height: 0.88; letter-spacing: -0.05em;
}
.${P}-amount .nim-word { font-size: 0.2em; letter-spacing: 0.05em; }
.${P}-moneycap {
  margin: 8px 0 0; padding-left: calc(var(--gut) * 0.5);
  font-size: 13.5px; color: var(--ink-2);
}

.${P}-qzone { margin-top: auto; padding-right: 56px; }
.${P}-eyebrow { margin: 0 0 8px; font-size: 12.5px; font-weight: 700; color: var(--ink-2); }
.${P}-q { margin: 0; font-size: 26px; font-weight: 800; line-height: 1.16; letter-spacing: -0.03em; text-wrap: balance; }

/* The circular rail. */
.${P}-rail {
  position: absolute; top: 56px; right: var(--gut); z-index: 3;
  display: flex; flex-direction: column; gap: 8px;
}

/* --- tiles: two up, with a corner affordance --- */
.${P}-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.${P}-tiles--live { margin-top: 16px; }
.${P}-tile {
  position: relative; min-height: 68px; padding: 11px 12px 10px;
  border: 1px solid var(--line); border-radius: 18px;
  background: rgb(24 15 13 / 0.62);
  text-align: left;
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .${P}-tile { background: rgb(28 18 16 / 0.42); -webkit-backdrop-filter: blur(18px) saturate(150%); backdrop-filter: blur(18px) saturate(150%); }
}
@media (prefers-reduced-transparency: reduce) {
  .${P}-tile { background: var(--card-solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
.${P}-tile p { margin: 0; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.${P}-tile b { display: block; margin-top: 3px; font-size: 18px; font-weight: 800; letter-spacing: -0.015em; }
.${P}-affordance {
  position: absolute; top: 9px; right: 9px;
  display: grid; place-items: center;
  width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--line-strong);
  font-size: 10px; font-weight: 800; color: var(--ink-2);
}
.${P}-affordance[data-ring='true'] { color: var(--accent); border-color: var(--accent); }

/* The 2x2 answer grid. 84px tall, 8px apart: past the touch floor with room.
   It only works because the spec fixes the option count at four. */
.${P}-opt {
  min-height: 84px; padding: 13px 13px 12px;
  border-color: var(--line-strong); cursor: pointer;
  font: inherit; color: var(--ink);
  transition: background-color 220ms var(--ease), border-color 220ms var(--ease), transform 200ms var(--ease);
}
.${P}-opt b { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.3; letter-spacing: -0.005em; }
.${P}-opt:active { transform: scale(0.98); }
.${P}-opt[aria-pressed='true'] {
  background: var(--action); border-color: var(--action);
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
.${P}-opt[aria-pressed='true'] b { color: var(--on-action); font-weight: 800; }
.${P}-opt[aria-pressed='true'] .${P}-affordance { color: var(--on-action); border-color: rgb(20 16 16 / 0.4); }

/* --- the sheet --- */
.${P}-sheet {
  position: relative; z-index: 4; flex: 0 0 auto;
  padding: 10px var(--gut) 18px;
  border-radius: 30px 30px 0 0; border-bottom: 0;
}
.${P}-root[data-solo='true'] .${P}-sheet { padding-bottom: max(18px, env(safe-area-inset-bottom)); }
/* The signature beat: the surface acknowledges by moving, once. */
.${P}-sheet[data-dip='true'] { animation: ${P}-dip 620ms var(--ease) 1 both; }
@keyframes ${P}-dip {
  0% { transform: translateY(30px); }
  100% { transform: translateY(0); }
}
.${P}-grab {
  display: block; width: 38px; height: 4px; margin: 0 auto 12px;
  border-radius: 999px; background: rgb(255 255 255 / 0.24);
}

.${P}-from { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin: 0 0 10px; font-size: 14px; color: var(--ink-2); }
.${P}-from b { font-weight: 800; color: var(--ink); }
.${P}-msg { margin: 0; font-size: 16px; line-height: 1.4; letter-spacing: -0.01em; text-wrap: pretty; }
.${P}-msg--small { font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.${P}-facts p { margin: 0 0 9px; font-size: 13.5px; line-height: 1.45; color: var(--ink-2); text-wrap: pretty; }
.${P}-facts b { color: var(--ink); font-weight: 800; }

/* Compresses on Y rather than scaling uniformly, which is what a physical
   button on a surface does. */
.${P}-go {
  display: block; width: 100%; min-height: 56px; margin-top: 12px; padding: 16px 20px;
  border: 0; border-radius: 999px;
  background: var(--action); color: var(--on-action);
  font: inherit; font-size: 16.5px; font-weight: 800; letter-spacing: -0.008em;
  cursor: pointer; transform-origin: center bottom;
  transition: transform 140ms var(--ease), background-color 140ms ease-out;
}
.${P}-go:disabled { background: rgb(255 255 255 / 0.16); color: var(--ink-2); cursor: default; }
.${P}-go:not(:disabled):active, .${P}-go[data-pressed='true'] { transform: scaleY(0.94) scaleX(0.995); background: #e9e2df; }
.${P}-go[data-quiet='true'] { background: none; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.${P}-flat {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 56px; margin: 12px 0 0; font-size: 13.5px; font-weight: 700;
  color: var(--ink-2); text-align: center; text-wrap: balance;
}
.${P}-flat svg { color: var(--accent); flex: 0 0 auto; }
.${P}-custody {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; min-height: 44px; margin-top: 4px;
  border: 0; background: none; font: inherit; font-size: 12.5px; font-weight: 700;
  color: var(--ink-2); cursor: pointer;
}
.${P}-custody svg { color: var(--accent); }

/* --- sealed --- */
.${P}-sealed { display: flex; gap: 14px; align-items: flex-start; }
.${P}-qr { flex: 0 0 auto; padding: 8px; background: #fff; border-radius: 16px; line-height: 0; }
.${P}-sealed h2 { margin: 0; font-size: 16px; font-weight: 800; letter-spacing: -0.02em; }
.${P}-sealed p { margin: 5px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--ink-2); text-wrap: pretty; }

/* --- the list --- */
.${P}-list { display: flex; flex-direction: column; gap: 6px; }
.${P}-listrow {
  display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center;
  width: 100%; min-height: 58px; padding: 10px 14px;
  border: 1px solid var(--line); border-radius: 18px;
  background: rgb(255 255 255 / 0.05); font: inherit; color: var(--ink);
  text-align: left; cursor: pointer;
  transition: background-color 200ms var(--ease);
}
.${P}-listrow:hover:not(:disabled) { background: rgb(255 255 255 / 0.11); }
.${P}-listrow:disabled { cursor: default; opacity: 0.66; }
.${P}-listrow > b { font-size: 15px; font-weight: 800; }
.${P}-listamt { display: inline-flex; align-items: baseline; gap: 4px; font-size: 18px; font-weight: 800; justify-self: end; }
.${P}-listmeta { font-size: 12px; color: var(--ink-2); }
.${P}-listrow .${P}-chip { justify-self: end; }

/* --- the poster --- */
@container (min-width: 54rem) {
  .${P}-inner { flex-direction: row; align-items: stretch; }
  /* The icon rail turns horizontal and parks bottom-left here, which is where
     the amount's caption already was. The rail is absolute, so nothing reflows
     around it and the two simply stacked; the field reserves the band instead. */
  .${P}-upper { flex: 1 1 auto; padding: 34px 40px 96px; }
  .${P}-amount { font-size: 132px; }
  .${P}-rail { flex-direction: row; top: auto; bottom: 34px; right: auto; left: 40px; }
  .${P}-tiles--live { max-width: 26rem; }
  .${P}-sheet {
    flex: 0 0 27rem; align-self: stretch;
    border-radius: 30px 0 0 30px; border-bottom: 1px solid var(--line);
    display: flex; flex-direction: column; justify-content: center;
    padding: 30px 26px;
  }
  .${P}-grab { display: none; }
  .${P}-qzone { padding-right: 0; max-width: 22ch; }
  .${P}-q { font-size: 40px; }
}

@media (prefers-reduced-motion: reduce) {
  .${P}-sheet[data-dip='true'] { animation: none; }
}
`
}
