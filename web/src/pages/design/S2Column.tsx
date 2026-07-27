import { useState } from 'react'
import { ChevronRightIcon, CustodyShieldIcon, QrCodeIcon } from '../../ui/icons'
import { CUSTODY, DROP, GAMES, MockQr, TRIVIA } from './content'
import { Amount, NimMark } from './nim'
import { kitCss } from './nimkit'
import type { SampleMeta, SampleProps } from './screens'
import { themeCss } from './theme'

/**
 * DEV-ONLY SAMPLE — s2, "Column".
 *
 * ## The form
 *
 * **No container anywhere.** Not a sheet, not a tile, not a panel. Every other
 * sample in the set puts something under the content; this one puts nothing.
 * The bloom is the only surface, and the content is type and hairlines on it.
 * That is the answer to "the card is the laziest available answer", and it is
 * also the hardest of the five to get right, because a card is what usually
 * rescues contrast.
 *
 * **The amount is the screen.** 116px on a phone, centred, deliberately wider
 * than the reading column so it breaks the measure the rest of the page keeps.
 * The mark sits at full cap height beside it, so the pair reads as one glyph
 * pair rather than a number with a badge.
 *
 * **The primary is one large pill**, 62px tall, fully rounded, solid white,
 * with generous space above and below it. It is the only rounded thing on the
 * screen, which is what makes it unmissable without any colour work at all.
 *
 * **Spacious.** This is the roomy one. Type sizes jump hard (116 / 20 / 13)
 * with nothing in between, so hierarchy comes from scale rather than from
 * boxes.
 *
 * ## The motion character: nearly still, one decisive beat
 *
 * Almost nothing moves. The press is a 90ms scale to 0.975 on the pill and
 * that is the entire interactive vocabulary. There is exactly one beat in the
 * whole system: when the claim resolves, a vermilion rule DRAWS beneath the
 * amount over 560ms and then stays there permanently. It is the only animation
 * in the sample, so it lands.
 *
 * ## Trivia, and the silence
 *
 * Options are plain rows separated by hairlines with no boxes at all. Selecting
 * one turns that row solid white and pushes the others to 45% ink, so the
 * choice is unmistakable and nothing suggests a verdict.
 *
 * This system answers the never-reveal rule with **progress as the only
 * feedback**: a row of five marks at the top, filled for answered and hollow
 * for not, and the words `3 of 5 answered`, which is honest where `3 of 5
 * correct` is forbidden. Committing an answer fills a mark. That is the whole
 * response, and its restraint is consistent with a system that only animates
 * once.
 *
 * ## The thirteen claim states
 *
 * All thirteen fit, with one caveat worth naming: with no container, the four
 * outcome states have nothing to sit in, so they are carried by the same
 * enormous-type treatment as the amount, with the outcome sentence at 34px in
 * the amount's slot. That works and it is arguably better than a card, but it
 * does mean the outcome copy must stay under about eight words. `rejected`'s
 * notice string is server-supplied and can be longer, so it drops to 20px
 * below the headline rather than replacing it.
 */

export const S2_META: SampleMeta = {
  id: 's2',
  name: 'Column',
  thesis: 'No container at all. The numeral is the screen and one pill is the only rounded thing on it.',
  form: 'One large pill · amount at 116px breaking the measure · no card, no tile, no panel · pill corners only · centred · spacious',
  motion: 'Nearly still. One 90ms press, and exactly one beat: a rule that draws under the amount and stays.',
  silence: 'Progress is the feedback. Five marks, filled as answered, and the words "3 of 5 answered".',
}

const P = 's2'

export default function S2Column({ screen, solo, pressed }: SampleProps) {
  const [picked, setPicked] = useState<number | null>(TRIVIA.picked)
  const [open, setOpen] = useState(false)
  const claimed = screen === 'claimed'
  const left = claimed ? DROP.left - 1 : DROP.left

  return (
    <div className={`${P}-root`} data-solo={solo ? 'true' : 'false'}>
      <style>{kitCss(P)}</style>
      <style>{themeCss(P)}</style>
      <style>{css()}</style>

      <div className={`${P}-field`} data-tone={claimed || screen === 'passed' ? 'warm' : 'live'}>
        <span className={`${P}-scrim`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />

        <div className={`${P}-inner`}>
          <p className={`${P}-mast`}>NimDrops</p>

          <div className={`${P}-body`}>
            {screen === 'question' ? (
              <Question picked={picked} onPick={setPicked} />
            ) : screen === 'games' ? (
              <Games />
            ) : screen === 'gate' ? (
              <Gate />
            ) : screen === 'failed' ? (
              <Failed />
            ) : screen === 'sealed' ? (
              <Sealed />
            ) : (
              <>
                <p className={`${P}-from`}>
                  <b>{DROP.sponsor}</b> sent you a NimDrop
                </p>
                <div className={`${P}-money`} data-drawn={claimed ? 'true' : 'false'}>
                  <Amount value={DROP.amount} markScale={1} className={`${P}-amount`} />
                  <span className={`${P}-rule`} aria-hidden="true" />
                </div>
                <p className={`${P}-cap`}>
                  {claimed
                    ? 'Sent to the wallet that signed'
                    : screen === 'passed'
                      ? 'Gate cleared. The share is yours to take.'
                      : 'The same for everyone who opens this link'}
                </p>
                {claimed ? null : <p className={`${P}-msg`}>{DROP.message}</p>}
              </>
            )}
          </div>

          <footer className={`${P}-foot`}>
            {screen === 'sealed' ? null : (
              <p className={`${P}-live`}>
                <span className={`${P}-marks`} aria-hidden="true">
                  {Array.from({ length: DROP.shares }).map((_, i) => (
                    <i key={i} data-on={i < left ? 'true' : 'false'} />
                  ))}
                </span>
                <span className={`${P}-num`}>
                  {left} of {DROP.shares} left
                </span>
                <span className={`${P}-dot`} aria-hidden="true" />
                <span className={`${P}-num`}>{DROP.expiresIn}</span>
              </p>
            )}

            <Action screen={screen} pressed={pressed} picked={picked} />

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
          </footer>
        </div>
      </div>
    </div>
  )
}

function Action({
  screen,
  pressed,
  picked,
}: {
  screen: string
  pressed?: boolean
  picked: number | null
}) {
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

function Sealed() {
  return (
    <>
      <p className={`${P}-from`}>
        <b>{DROP.sponsor}</b> sent you a NimDrop
      </p>
      <div className={`${P}-money`}>
        <Amount value={DROP.amount} markScale={1} className={`${P}-amount`} />
      </div>
      <p className={`${P}-cap`}>Fixed and equal. The same for everyone who opens this link.</p>
      <div className={`${P}-qrblock`}>
        <div className={`${P}-qr`}>
          <MockQr size={158} />
        </div>
        <div>
          <h2>Open this on your phone</h2>
          <p>
            Claiming needs a wallet to sign and Nimiq Pay is a phone app. There is nothing to press
            here.
          </p>
        </div>
      </div>
    </>
  )
}

function Gate() {
  return (
    <>
      <p className={`${P}-from`}>
        <b>{DROP.sponsor}</b> gated this NimDrop at {TRIVIA.tier}
      </p>
      <div className={`${P}-money`}>
        <Amount value={DROP.amount} markScale={1} className={`${P}-amount`} />
      </div>
      <p className={`${P}-cap`}>Five questions, fifteen seconds each. The amount does not change.</p>
      <p className={`${P}-msg`}>
        One wrong or late answer ends the session. You are never told which answers were right, only
        whether the session cleared.
      </p>
    </>
  )
}

function Question({ picked, onPick }: { picked: number | null; onPick: (i: number) => void }) {
  return (
    <>
      <div className={`${P}-prog`}>
        <span className={`${P}-marks`} aria-hidden="true">
          {Array.from({ length: TRIVIA.total }).map((_, i) => (
            <i key={i} data-on={i < TRIVIA.index - 1 ? 'true' : 'false'} />
          ))}
        </span>
        <span className={`${P}-num`}>{TRIVIA.index - 1} of {TRIVIA.total} answered</span>
        <span className={`${P}-dot`} aria-hidden="true" />
        <span className={`${P}-num`}>{TRIVIA.category}</span>
      </div>

      {/* One hairline that shortens, and the words that say whose clock it is.
          Nothing about the deadline is animated in the browser, because the
          browser is not the authority on it. */}
      <div className={`${P}-deadline`}>
        <span aria-hidden="true">
          <i style={{ width: `${(TRIVIA.secondsLeft / TRIVIA.secondsPerQuestion) * 100}%` }} />
        </span>
        <p className={`${P}-num`}>{TRIVIA.secondsLeft}s on the server clock</p>
      </div>

      <h1 className={`${P}-q`}>{TRIVIA.question}</h1>

      <ul className={`${P}-opts`} data-chosen={picked !== null ? 'true' : 'false'}>
        {TRIVIA.options.map((o, i) => (
          <li key={o}>
            <button
              type="button"
              className={`${P}-opt`}
              aria-pressed={picked === i}
              onClick={() => onPick(i)}
            >
              {o}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function Failed() {
  return (
    <>
      <p className={`${P}-from`}>Session closed</p>
      <h1 className={`${P}-big`}>It did not clear.</h1>
      <p className={`${P}-cap`}>
        Which answers were wrong is not something NimDrops reports, for any session.
      </p>
      <p className={`${P}-msg`}>
        The drop is still live with {DROP.left} of {DROP.shares} shares left and it closes in{' '}
        {DROP.expiresIn}. The questions will be the same ones.
      </p>
    </>
  )
}

function Games() {
  return (
    <>
      <h1 className={`${P}-big`}>Gated drops.</h1>
      <ul className={`${P}-list`}>
        {GAMES.map((g) => (
          <li key={g.tier}>
            <button type="button" className={`${P}-listrow`} disabled={Boolean(g.locked)}>
              <span>
                <b>{g.tier}</b>
                <span className={`${P}-num`}>
                  {g.left} of {g.of} left · {g.expires}
                </span>
              </span>
              <span className={`${P}-listamt`}>
                <b className={`${P}-num`}>{g.amount}</b>
                <NimMark height="0.8em" />
              </span>
              <span className={`${P}-listlock`}>{g.locked || 'Open'}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function css() {
  return `
/* =========================================================================
 * s2 "Column" — no container, the number is the screen, nearly still.
 * ====================================================================== */
.${P}-root { --gut: 22px; }
.${P}-inner {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  padding: 20px var(--gut) 22px; overflow-y: auto;
}
.${P}-root[data-solo='true'] .${P}-inner { padding-bottom: max(22px, env(safe-area-inset-bottom)); }
.${P}-mast { margin: 0; font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
.${P}-body { display: flex; flex-direction: column; justify-content: center; flex: 1; min-height: 0; padding: 22px 0; }
.${P}-foot { flex: 0 0 auto; }

.${P}-from { margin: 0 0 6px; font-size: 15px; color: var(--ink-2); }
.${P}-from b { font-weight: 800; color: var(--ink); }

/* The amount breaks the measure the rest of the column keeps. Negative margins
   let it reach past the gutter, which is the whole gesture. */
.${P}-money { position: relative; margin: 0 calc(var(--gut) * -0.6); }
.${P}-amount {
  display: flex; align-items: baseline; justify-content: center; flex-wrap: nowrap;
  margin: 0; font-size: 116px; font-weight: 800; line-height: 0.86; letter-spacing: -0.055em;
}
.${P}-amount .nim-word { font-size: 0.19em; letter-spacing: 0.06em; }
/* The one beat in the system. It draws once and it stays. */
.${P}-rule {
  display: block; height: 3px; margin: 18px auto 0; width: 62%;
  background: var(--accent); transform: scaleX(0); transform-origin: center;
}
.${P}-money[data-drawn='true'] .${P}-rule {
  transform: scaleX(1);
  animation: ${P}-draw 560ms var(--ease) 1 both;
}
@keyframes ${P}-draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }

.${P}-cap {
  margin: 20px 0 0; font-size: 15px; line-height: 1.5;
  color: var(--ink-2); text-align: center; text-wrap: balance;
}
.${P}-msg {
  margin: 20px auto 0; max-width: 34ch;
  font-size: 20px; line-height: 1.4; letter-spacing: -0.015em;
  text-align: center; text-wrap: pretty;
}
.${P}-big { margin: 0; font-size: 44px; font-weight: 800; line-height: 1.02; letter-spacing: -0.04em; text-wrap: balance; }

/* --- the live line, marks not pips --- */
.${P}-live, .${P}-prog {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 9px;
  margin: 0 0 16px; font-size: 13px; font-weight: 700; color: var(--ink);
}
.${P}-prog { justify-content: flex-start; margin-bottom: 12px; }
.${P}-marks { display: inline-flex; gap: 4px; }
.${P}-marks i { width: 16px; height: 3px; background: rgb(255 255 255 / 0.2); }
.${P}-marks i[data-on='true'] { background: var(--ink); }
.${P}-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-2); }

/* --- the one pill --- */
.${P}-go {
  display: block; width: 100%; min-height: 62px; padding: 18px 22px;
  border: 0; border-radius: 999px;
  background: var(--action); color: var(--on-action);
  font: inherit; font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
  cursor: pointer; transition: transform 90ms ease-out, background-color 90ms ease-out;
}
.${P}-go:disabled { background: rgb(255 255 255 / 0.16); color: var(--ink-2); cursor: default; }
.${P}-go:not(:disabled):active, .${P}-go[data-pressed='true'] { transform: scale(0.975); background: #e9e2df; }
.${P}-go[data-quiet='true'] {
  background: none; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong);
}
.${P}-sealedline {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 62px; margin: 0; font-size: 14px; font-weight: 700; color: var(--ink-2);
  text-align: center; text-wrap: balance;
}
.${P}-sealedline svg { color: var(--accent); flex: 0 0 auto; }

/* --- custody --- */
.${P}-disc { margin-top: 12px; }
.${P}-discbtn {
  display: flex; align-items: center; gap: 9px;
  width: 100%; min-height: 46px; padding: 12px 0;
  border: 0; background: none; font: inherit; font-size: 13px; font-weight: 700;
  color: var(--ink-2); cursor: pointer;
}
.${P}-discbtn > svg:first-child { color: var(--accent); flex: 0 0 auto; }
.${P}-caret { margin-left: auto; transition: transform 180ms var(--ease); }
.${P}-discbtn[aria-expanded='true'] .${P}-caret { transform: rotate(90deg); }
.${P}-facts p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }
.${P}-facts b { color: var(--ink); font-weight: 800; }

/* --- trivia: rows, not boxes --- */
.${P}-deadline { margin-bottom: 18px; }
.${P}-deadline span {
  display: block; height: 2px; background: rgb(255 255 255 / 0.16);
}
.${P}-deadline i { display: block; height: 2px; background: var(--accent); }
.${P}-deadline p { margin: 7px 0 0; font-size: 12px; font-weight: 700; color: var(--ink-2); }
.${P}-q {
  margin: 0 0 6px; font-size: 27px; font-weight: 800;
  line-height: 1.18; letter-spacing: -0.028em; text-wrap: balance;
}
.${P}-opts { list-style: none; margin: 10px 0 0; padding: 0; }
.${P}-opt {
  display: block; width: 100%; min-height: 56px; padding: 15px 2px;
  border: 0; border-bottom: 1px solid var(--line); background: none;
  font: inherit; font-size: 16px; color: var(--ink); text-align: left; cursor: pointer;
  transition: color 140ms ease-out, background-color 140ms ease-out, padding 140ms var(--ease);
}
.${P}-opts[data-chosen='true'] .${P}-opt { color: rgb(245 240 238 / 0.45); }
/* Selection: solid, dark text, heavier. Three carriers, none of them hue.
   This has to out-specify the dimming rule directly above it. It did not,
   once: at (0,2,0) against the dimmer's (0,3,0) the CHOSEN row inherited 45%
   near-white and rendered on its own white fill at about 1.05:1, i.e. the one
   thing on the screen the player needs to read was invisible. Matching the
   dimmer's own descendant shape is what keeps that from coming back. */
.${P}-opts[data-chosen='true'] .${P}-opt[aria-pressed='true'],
.${P}-opt[aria-pressed='true'] {
  background: var(--action); color: var(--on-action); font-weight: 800;
  padding-left: 14px; padding-right: 14px; border-radius: 999px; border-bottom-color: transparent;
}

/* --- the sealed block --- */
.${P}-qrblock { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-top: 24px; text-align: center; }
.${P}-qr { padding: 9px; background: #fff; border-radius: 14px; line-height: 0; }
.${P}-qrblock h2 { margin: 0; font-size: 19px; font-weight: 800; letter-spacing: -0.02em; }
.${P}-qrblock p { margin: 6px auto 0; max-width: 34ch; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }

/* --- the list --- */
.${P}-list { list-style: none; margin: 18px 0 0; padding: 0; }
.${P}-listrow {
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 14px;
  width: 100%; min-height: 66px; padding: 14px 0;
  border: 0; border-bottom: 1px solid var(--line); background: none;
  font: inherit; color: var(--ink); text-align: left; cursor: pointer;
}
.${P}-listrow:disabled { cursor: default; color: var(--ink-2); }
.${P}-listrow > span:first-child { display: flex; flex-direction: column; gap: 2px; }
.${P}-listrow b { font-size: 17px; font-weight: 800; }
.${P}-listrow span span { font-size: 12.5px; color: var(--ink-2); }
.${P}-listamt { display: inline-flex; align-items: baseline; gap: 5px; font-size: 22px; font-weight: 800; }
.${P}-listlock { grid-column: 2; font-size: 12.5px; font-weight: 700; color: var(--ink-2); text-align: right; }

/* --- the poster --- */
@container (min-width: 54rem) {
  .${P}-inner { padding: 30px 48px 32px; }
  .${P}-amount { font-size: 168px; }
  .${P}-body { padding: 10px 0; }
  .${P}-msg { font-size: 22px; max-width: 40ch; }
  .${P}-qrblock { flex-direction: row; justify-content: center; gap: 26px; text-align: left; }
  .${P}-qrblock p { margin-left: 0; }
  .${P}-go, .${P}-sealedline { max-width: 26rem; margin-left: auto; margin-right: auto; }
  .${P}-disc { max-width: 26rem; margin-left: auto; margin-right: auto; }
  .${P}-opts { max-width: 40rem; }
  .${P}-list { max-width: 44rem; }
}

@media (prefers-reduced-motion: reduce) {
  .${P}-rule { transform: scaleX(1); animation: none; }
}
`
}
