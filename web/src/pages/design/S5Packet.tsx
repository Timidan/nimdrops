import { useState } from 'react'
import { ChevronRightIcon, CustodyShieldIcon, InfoIcon, QrCodeIcon } from '../../ui/icons'
import { CUSTODY, DROP, GAMES, MockQr, TRIVIA } from './content'
import { Amount, NimMark } from './nim'
import { kitCss } from './nimkit'
import type { SampleMeta, SampleProps } from './screens'
import { themeCss } from './theme'

/**
 * DEV-ONLY SAMPLE — s5, "Packet".
 *
 * ## The form
 *
 * **The content is an object, not a layout.** A portrait packet, taller than
 * any card in the set, centred on the bloom, with a fold line across it and a
 * die-cut notch at each end of the fold. Everything lives on one of its two
 * halves. It is the only sample where the container has a shape rather than a
 * radius, and the only one whose proportions are fixed rather than driven by
 * their contents.
 *
 * **The primary is a circular seal**, 104px across, solid white, carrying the
 * Nimiq mark, sitting ON the fold so it belongs to both halves at once. It is
 * a target more than twice the floor in both directions and it is the only
 * control on the screen, which is the point: there is one thing to do and it
 * looks like one thing.
 *
 * **The amount is on the packet's upper face**, inside a hairline keyline box
 * with nothing behind it. The keyline is the only piece of chrome the object
 * has, so the number gets it.
 *
 * ## The Nimiq mark, and the one place this palette and the currency interact
 *
 * The seal is solid white and the mark on it is Nimiq gold, so the only gold
 * on the entire screen is the currency's own. Against vermilion that reads as
 * foil, which is the classic red-and-gold-leaf pairing and is exactly on theme
 * for an object shaped like this. The report gives the numbers for this and for
 * the cooler alternative.
 *
 * ## The motion character: still, then decisive
 *
 * Nothing idles. There is no breathing capsule, no blinking marker, no drift
 * that is visible at rest. The seal depresses 2px on press over 100ms and
 * that is the only feedback until something actually happens. When it does,
 * one thing happens hard: the seal **rotates 60 degrees**. A hexagon has
 * six-fold symmetry, so it lands exactly on itself, which makes the gesture
 * read as a stamp being turned rather than as a graphic spinning. The fold's
 * hairline flashes once at the same moment and the bloom comes up and stays.
 *
 * ## Trivia, and the silence
 *
 * This is the system the never-reveal rule fits best, because the metaphor
 * already contains it. **One question per packet.** The prompt is on the upper
 * face, the four options are hairline rows on the lower face, and committing
 * turns the seal, at which point that packet is sealed and the next slides up
 * from beneath. Five sealed packets and no marks on any of them.
 *
 * Progress is five small packet marks on the fold line, filled for sealed.
 * There is no score, no tick, no cross, and nothing that could be read as one,
 * and unlike the other four this system does not have to suppress that
 * vocabulary because it never had it.
 *
 * The options are hairline rows at 52px with an 8px gap, which stays inside the
 * published `GlassSheet` option contract.
 *
 * ## The thirteen claim states
 *
 * Twelve fit cleanly. The one that fights the form is `no-wallet` on a phone,
 * because the QR wants roughly the same area as the packet's upper face and
 * the two cannot both be the subject. The sample resolves it by turning the
 * packet over: the QR takes the upper face and the amount drops to a line
 * above the fold. That is a real compromise and it is stated rather than
 * hidden. The other twelve are the packet with a different lower face.
 */

export const S5_META: SampleMeta = {
  id: 's5',
  name: 'Packet',
  thesis: 'The content is a physical object with a fold, and the only control is a seal sitting on it.',
  form: '104px circular seal on the fold · amount keylined on the upper face · a packet, not a card · a shape rather than a radius · centred object · medium',
  motion: 'Still, then decisive. Nothing idles. The seal depresses 2px, then turns 60 degrees and lands on itself.',
  silence: 'One question per packet. You seal it and it carries no mark. The metaphor already contains the rule.',
}

const P = 's5'

export default function S5Packet({ screen, solo, pressed }: SampleProps) {
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
          <header className={`${P}-head`}>
            <p className={`${P}-mast`}>NimDrops</p>
            <button type="button" className={`${P}-round`} aria-label="About NimDrops">
              <InfoIcon size={18} />
            </button>
          </header>

          <div className={`${P}-stage`}>
            <article className={`${P}-packet ${P}-glass`} data-turned={claimed ? 'true' : 'false'}>
              {/* --- the upper face --- */}
              <div className={`${P}-face`}>
                {sealed ? (
                  <div className={`${P}-qr`}>
                    <MockQr size={140} />
                  </div>
                ) : trivia ? (
                  <>
                    <p className={`${P}-eyebrow`}>
                      {TRIVIA.category} · question {TRIVIA.index} of {TRIVIA.total}
                    </p>
                    <h1 className={`${P}-q`}>{TRIVIA.question}</h1>
                  </>
                ) : screen === 'games' ? (
                  <>
                    <p className={`${P}-eyebrow`}>Gated drops</p>
                    <h1 className={`${P}-q`}>Answer five, take a share.</h1>
                  </>
                ) : screen === 'failed' ? (
                  <>
                    <p className={`${P}-eyebrow`}>{TRIVIA.tier} tier</p>
                    <h1 className={`${P}-q`}>This packet stayed shut.</h1>
                  </>
                ) : (
                  <>
                    <p className={`${P}-from`}>
                      <b>{DROP.sponsor}</b>
                      <span className={`${P}-chip`}>
                        {screen === 'gate' ? `${TRIVIA.tier} tier` : 'name unverified'}
                      </span>
                    </p>
                    <div className={`${P}-keyline`}>
                      <Amount value={DROP.amount} markScale={0.66} className={`${P}-amount`} />
                    </div>
                    <p className={`${P}-cap`}>
                      {claimed
                        ? 'Sent to the wallet that signed'
                        : screen === 'gate'
                          ? 'Answer five to open it. The amount does not change.'
                          : screen === 'passed'
                            ? 'Gate cleared. The share is yours to take.'
                            : 'The same for everyone who opens this link'}
                    </p>
                  </>
                )}
              </div>

              {/* --- the fold: notches, hairline, progress marks --- */}
              <div className={`${P}-fold`} data-flash={claimed ? 'true' : 'false'}>
                <span className={`${P}-notch ${P}-notch--l`} aria-hidden="true" />
                <span className={`${P}-notch ${P}-notch--r`} aria-hidden="true" />
                <span className={`${P}-foldline`} aria-hidden="true" />
                {trivia ? (
                  <span className={`${P}-sealmarks`} aria-hidden="true">
                    {Array.from({ length: TRIVIA.total }).map((_, i) => (
                      <i key={i} data-on={i < TRIVIA.index - 1 ? 'true' : 'false'} />
                    ))}
                  </span>
                ) : null}

                {/* The seal is a child of the fold rather than of the packet,
                    so it is centred on the crease by construction. Anchoring it
                    to a percentage of the packet instead looked right only for
                    the one screen it was eyeballed on: the faces are flex, the
                    crease moves with their content, and the disc drifted off it
                    onto the answer rows as soon as anything else changed. */}
                <Seal screen={screen} pressed={pressed} armed={!trivia || picked !== null} />
              </div>

              {/* --- the lower face --- */}
              <div className={`${P}-face ${P}-face--low`}>
                {sealed ? (
                  <>
                    <p className={`${P}-amountline`}>
                      <b className={`${P}-num`}>{DROP.amount}</b>
                      <NimMark height="0.8em" />
                      <span>each, fixed and equal</span>
                    </p>
                    <p className={`${P}-msg`}>
                      Claiming needs a wallet to sign, and Nimiq Pay is a phone app. Scan this with
                      the phone that has it.
                    </p>
                  </>
                ) : trivia ? (
                  <ul className={`${P}-opts`}>
                    {TRIVIA.options.map((o, i) => (
                      <li key={o}>
                        <button
                          type="button"
                          className={`${P}-opt`}
                          aria-pressed={picked === i}
                          onClick={() => setPicked(i)}
                        >
                          {o}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : screen === 'games' ? (
                  <ul className={`${P}-list`}>
                    {GAMES.map((g) => (
                      <li key={g.tier}>
                        <button
                          type="button"
                          className={`${P}-listrow`}
                          disabled={Boolean(g.locked)}
                        >
                          <b>{g.tier}</b>
                          <span className={`${P}-listamt`}>
                            <b className={`${P}-num`}>{g.amount}</b>
                            <NimMark height="0.78em" />
                          </span>
                          <span className={`${P}-num ${P}-listmeta`}>
                            {g.left} of {g.of} · {g.expires}
                          </span>
                          <span className={`${P}-listlock`}>{g.locked || 'Open'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : screen === 'failed' ? (
                  <p className={`${P}-msg`}>
                    Which answers were wrong is not something NimDrops reports, for any session.
                    You can start again in {TRIVIA.cooldownMinutes} minutes and the questions will
                    be the same ones.
                  </p>
                ) : claimed ? (
                  <p className={`${P}-msg ${P}-msg--small`}>
                    {DROP.address.slice(0, 19)}… · confirmed 26 Jul, 21:04 UTC
                  </p>
                ) : (
                  <p className={`${P}-msg`}>{DROP.message}</p>
                )}

                <p className={`${P}-live`}>
                  <span className={`${P}-num`}>
                    {trivia ? `${TRIVIA.secondsLeft}s on the server clock` : `${left} of ${DROP.shares} left`}
                  </span>
                  <span className={`${P}-sep`} aria-hidden="true" />
                  <span className={`${P}-num`}>
                    {trivia ? `${TRIVIA.index} of ${TRIVIA.total}` : DROP.expiresIn}
                  </span>
                </p>
              </div>
            </article>
          </div>

          <div className={`${P}-disc`}>
            <button
              type="button"
              className={`${P}-discbtn`}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <CustodyShieldIcon size={17} />
              NimDrops is holding this NIM
              <ChevronRightIcon size={16} className={`${P}-caret`} />
            </button>
            {open ? (
              <div className={`${P}-facts`}>
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

function Seal({
  screen,
  pressed,
  armed,
}: {
  screen: string
  pressed?: boolean
  armed: boolean
}) {
  if (screen === 'sealed') {
    return (
      <div className={`${P}-seal ${P}-seal--flat`} aria-hidden="true">
        <QrCodeIcon size={26} />
      </div>
    )
  }
  if (screen === 'failed') {
    return (
      <div className={`${P}-seal ${P}-seal--flat`}>
        <span className={`${P}-num`}>{TRIVIA.cooldownMinutes}:00</span>
      </div>
    )
  }
  const label =
    screen === 'claimed'
      ? 'Send a drop back'
      : screen === 'question'
        ? 'Seal this answer'
        : screen === 'gate'
          ? 'Start'
          : screen === 'games'
            ? 'Open'
            : `Open ${DROP.amount} NIM`
  const short =
    screen === 'claimed' ? 'Again' : screen === 'question' ? 'Seal' : screen === 'gate' ? 'Start' : 'Open'
  return (
    <button
      type="button"
      className={`${P}-seal`}
      aria-label={label}
      disabled={!armed}
      data-pressed={pressed ? 'true' : undefined}
      data-turned={screen === 'claimed' ? 'true' : undefined}
    >
      <NimMark height="30px" className={`${P}-sealmark`} />
      <span>{short}</span>
    </button>
  )
}

function css() {
  return `
/* =========================================================================
 * s5 "Packet" — an object with a fold, one circular seal, still then decisive.
 * ====================================================================== */
.${P}-root { --gut: 20px; --seal: 104px; }
.${P}-inner {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  gap: 14px; padding: 18px var(--gut) 20px; overflow-y: auto;
}
.${P}-root[data-solo='true'] .${P}-inner { padding-bottom: max(20px, env(safe-area-inset-bottom)); }
.${P}-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.${P}-mast { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.012em; }
.${P}-stage { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 0; }

/* --- the object ----------------------------------------------------------
 * Fixed proportions rather than content-driven height, because an object has
 * a size. The notches are two circles punched out of the edges at the fold,
 * which is what makes it read as folded stock rather than as a divided card.
 * ---------------------------------------------------------------------- */
.${P}-packet {
  position: relative;
  width: 100%; max-width: 22.5rem; min-height: 34rem; margin: 0 auto;
  display: flex; flex-direction: column;
  border-radius: 22px;
}
/* The seal is a 104px disc centred on the fold, so it eats 52px of each face
   and it is absolutely positioned, which means nothing reflows around it. Both
   faces therefore keep a clear band: without it the disc lands on the caption
   on the claim and on the first two answer rows on the question, which is the
   worst possible place for an opaque white circle to sit. */
.${P}-face {
  display: flex; flex-direction: column; justify-content: center;
  flex: 1 1 44%; padding: 22px 20px 58px; min-height: 0;
}
.${P}-face--low {
  flex: 1 1 56%; justify-content: flex-start;
  padding-top: 62px; padding-bottom: 26px;
}

.${P}-from { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; font-size: 14px; }
.${P}-from b { font-weight: 800; }
.${P}-eyebrow { margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: var(--ink-2); }

/* The keyline is the object's only chrome, and the money gets it. */
.${P}-keyline {
  padding: 14px 12px 12px;
  border: 1px solid var(--line-strong); border-radius: 14px;
}
.${P}-amount {
  display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap;
  margin: 0; font-size: 58px; font-weight: 700; line-height: 0.95; letter-spacing: -0.035em;
}
.${P}-cap { margin: 12px 0 0; font-size: 13px; line-height: 1.45; color: var(--ink-2); text-align: center; text-wrap: balance; }
.${P}-q { margin: 0; font-size: 22px; font-weight: 800; line-height: 1.2; letter-spacing: -0.024em; text-wrap: balance; }
.${P}-msg { margin: 0; font-size: 15.5px; line-height: 1.45; text-wrap: pretty; }
.${P}-msg--small { font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.${P}-qr { align-self: center; padding: 8px; background: #fff; border-radius: 14px; line-height: 0; }
.${P}-amountline { display: flex; align-items: baseline; gap: 6px; margin: 0 0 10px; font-size: 22px; font-weight: 800; }
.${P}-amountline span { font-size: 13px; font-weight: 600; color: var(--ink-2); }

/* --- the fold --- */
.${P}-fold { position: relative; height: 0; }
.${P}-foldline {
  position: absolute; left: 14px; right: 14px; top: 0; height: 1px;
  background: var(--line-strong);
}
.${P}-fold[data-flash='true'] .${P}-foldline { animation: ${P}-flash 520ms linear 1 both; }
@keyframes ${P}-flash {
  0% { background: var(--line-strong); }
  22% { background: var(--gold); box-shadow: 0 0 14px 1px rgb(233 178 19 / 0.6); }
  100% { background: var(--line-strong); box-shadow: none; }
}
/* Punched out of the edges, so the silhouette is the packet's, not a card's. */
.${P}-notch {
  position: absolute; top: -11px; width: 22px; height: 22px; border-radius: 50%;
  background: var(--base);
  box-shadow: inset 0 0 0 1px var(--line);
}
.${P}-notch--l { left: -12px; }
.${P}-notch--r { right: -12px; }
.${P}-sealmarks { position: absolute; left: 20px; top: 14px; display: flex; gap: 5px; }
.${P}-sealmarks i { width: 14px; height: 4px; border-radius: 1px; background: rgb(255 255 255 / 0.2); }
.${P}-sealmarks i[data-on='true'] { background: var(--ink); }

/* --- the seal ------------------------------------------------------------
 * On the fold, belonging to both halves. Solid white, and the mark on it is
 * the only gold anywhere on the screen.
 * ---------------------------------------------------------------------- */
.${P}-seal {
  /* Anchored to the fold, which is a zero-height element sitting exactly on
     the crease, so "centred on the fold" is geometry rather than a number that
     has to be re-tuned every time a face's content changes. */
  position: absolute; top: 0; right: 20px; z-index: 3;
  display: grid; place-items: center; gap: 1px;
  width: var(--seal); height: var(--seal); margin-top: calc(var(--seal) / -2);
  border: 0; border-radius: 50%;
  background: var(--action); color: var(--on-action);
  font: inherit; font-size: 13px; font-weight: 800; letter-spacing: -0.005em;
  cursor: pointer;
  box-shadow: 0 10px 26px -10px rgb(0 0 0 / 0.9), inset 0 0 0 1px rgb(0 0 0 / 0.08);
  transition: transform 100ms ease-out, background-color 100ms ease-out;
}
.${P}-seal:disabled { background: rgb(255 255 255 / 0.2); color: var(--ink-2); cursor: default; }
.${P}-seal:disabled .${P}-sealmark { opacity: 0.5; }
/* Press: 2px down, nothing else. This system does not idle and does not fade. */
.${P}-seal:not(:disabled):active, .${P}-seal[data-pressed='true'] {
  transform: translateY(2px); background: #eae3e0;
}
/* The beat: 60 degrees. A hexagon has six-fold symmetry, so it lands exactly
   on itself and the gesture reads as a stamp turning rather than a spin. */
.${P}-seal[data-turned='true'] .${P}-sealmark { animation: ${P}-turn 620ms var(--ease) 1 both; }
@keyframes ${P}-turn { from { transform: rotate(0deg); } to { transform: rotate(60deg); } }
.${P}-seal--flat { background: rgb(255 255 255 / 0.1); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.${P}-seal--flat svg { color: var(--accent); }

/* --- options: hairline rows, inside the published option contract --- */
.${P}-opts { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.${P}-opt {
  width: 100%; min-height: 52px; padding: 13px 14px;
  border: 1px solid var(--line-strong); border-radius: 12px;
  background: rgb(255 255 255 / 0.05);
  font: inherit; font-size: 14.5px; color: var(--ink); text-align: left; cursor: pointer;
  transition: background-color 160ms ease-out, border-color 160ms ease-out;
}
.${P}-opt[aria-pressed='true'] {
  background: var(--action); color: var(--on-action); border-color: var(--action); font-weight: 800;
}

.${P}-live {
  display: flex; align-items: center; gap: 9px; margin: 14px 0 0;
  font-size: 12.5px; font-weight: 700; color: var(--ink-2);
}
.${P}-sep { flex: 1; height: 1px; background: var(--line); }

/* --- the list --- */
.${P}-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.${P}-listrow {
  display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center;
  width: 100%; min-height: 54px; padding: 9px 12px;
  border: 1px solid var(--line); border-radius: 12px;
  background: rgb(255 255 255 / 0.05); font: inherit; color: var(--ink);
  text-align: left; cursor: pointer;
}
.${P}-listrow:disabled { cursor: default; opacity: 0.66; }
.${P}-listrow > b { font-size: 14.5px; font-weight: 800; }
.${P}-listamt { display: inline-flex; align-items: baseline; gap: 4px; font-size: 17px; font-weight: 800; justify-self: end; }
.${P}-listmeta { font-size: 11.5px; color: var(--ink-2); }
.${P}-listlock { justify-self: end; font-size: 11.5px; font-weight: 700; color: var(--ink-2); }

/* --- custody --- */
.${P}-disc { width: 100%; max-width: 22.5rem; margin: 0 auto; }
.${P}-discbtn {
  display: flex; align-items: center; gap: 9px;
  width: 100%; min-height: 46px; padding: 11px 14px;
  border: 1px solid var(--line); border-radius: 12px;
  background: rgb(18 10 9 / 0.5);
  font: inherit; font-size: 13px; font-weight: 700; color: var(--ink);
  text-align: left; cursor: pointer;
}
.${P}-discbtn > svg:first-child { color: var(--accent); flex: 0 0 auto; }
.${P}-caret { margin-left: auto; color: var(--ink-2); transition: transform 200ms var(--ease); }
.${P}-discbtn[aria-expanded='true'] .${P}-caret { transform: rotate(90deg); }
.${P}-facts { padding: 12px 14px 2px; }
.${P}-facts p { margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }
.${P}-facts b { color: var(--ink); font-weight: 800; }

/* --- the poster: the object turns landscape and the seal goes to the fold --- */
@container (min-width: 54rem) {
  .${P}-inner { padding: 30px 44px 32px; }
  .${P}-packet {
    max-width: 46rem; min-height: 25rem;
    flex-direction: row;
  }
  /* The fold turns vertical here, so the seal's clear band turns with it. */
  .${P}-face { flex: 1 1 50%; padding: 32px 62px 32px 30px; }
  .${P}-face--low {
    padding: 32px 30px 32px 62px; justify-content: center;
  }
  .${P}-fold { height: auto; width: 0; }
  .${P}-foldline { left: 50%; top: 14px; bottom: 14px; right: auto; width: 1px; height: auto; }
  .${P}-notch { top: auto; left: -11px; }
  .${P}-notch--l { top: -12px; }
  .${P}-notch--r { bottom: -12px; top: auto; }
  .${P}-sealmarks { left: -30px; top: 30px; flex-direction: column; }
  .${P}-sealmarks i { width: 4px; height: 14px; }
  /* The fold is now a zero-WIDTH flex item, so the seal centres on it the same
     way, one axis over. */
  .${P}-seal { top: 50%; right: auto; left: 0; margin-left: calc(var(--seal) / -2); }
  .${P}-amount { font-size: 72px; }
  .${P}-q { font-size: 30px; }
  .${P}-disc { max-width: 46rem; }
}

@media (prefers-reduced-motion: reduce) {
  .${P}-seal[data-turned='true'] .${P}-sealmark { animation: none; transform: rotate(60deg); }
  .${P}-fold[data-flash='true'] .${P}-foldline { animation: none; background: var(--gold); }
}
`
}
