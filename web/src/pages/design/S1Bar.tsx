import { useState } from 'react'
import { ChevronRightIcon, CustodyShieldIcon, InfoIcon, QrCodeIcon } from '../../ui/icons'
import { CUSTODY, DROP, GAMES, MockQr, TRIVIA } from './content'
import { Amount, NimMark } from './nim'
import { kitCss } from './nimkit'
import type { SampleMeta, SampleProps } from './screens'
import { themeCss } from './theme'

/**
 * DEV-ONLY SAMPLE — s1, "Bar".
 *
 * ## The form
 *
 * **Sharp.** Six-pixel corners and hairline rules, everywhere, with no
 * exceptions. It is the only one of the five with a hard edge language and it
 * is what makes it read as an instrument rather than an app.
 *
 * **No sheet.** There is no card holding the transaction. The content is a
 * top-weighted stack of hairline-ruled blocks and a two-up tile row, sitting
 * directly on the bloom. Translucency is used only where the reference uses it
 * for tiles, so the light reads through them.
 *
 * **The amount is bare**, top-left, at 68px, with the unit stacked under the
 * numeral rather than beside it. Nothing frames it. What keeps it legible is a
 * local scrim, not a plate, which is the point: on this system the money is
 * part of the field rather than an object placed on it.
 *
 * **The primary is a full-bleed bar** welded to the bottom edge of the screen,
 * square, edge to edge, solid white on the warm black. It is not a button
 * floating in a layout; it is the bottom of the screen.
 *
 * ## The motion character: mechanical
 *
 * Nothing eases. Press is an instant inversion with no transition at all,
 * because a 120ms fade on a button that is taking somebody's money reads as
 * lag. The deadline is a row of fifteen cells that go out one at a time on a
 * hard step. State changes are a single 1px rule sweeping the full width at a
 * constant speed. There is no bounce, no spring and no fade anywhere in this
 * system, and that consistency is what gives it a character rather than an
 * absence of one.
 *
 * ## Trivia, and the silence
 *
 * The gate's problem is that per-question correctness is never revealed, so
 * the entire tick-and-cross vocabulary is unavailable. This system answers it
 * with **receipt, not verdict**: committing an answer stamps a cell in the
 * progress bar and prints `Answer 3 recorded` on a hairline row that stays on
 * screen for the rest of the session. You accumulate a visible record of what
 * you submitted and learn nothing about whether it was right, which is exactly
 * the honest reading of the rule.
 *
 * ## The thirteen claim states
 *
 * All thirteen fit. The bar is the only element that changes between them: it
 * carries the primary on `ready`, a status line on `signing`, `reserved` and
 * `confirming`, and disappears entirely on the four outcome states, where the
 * stack ends with a hairline row instead. No state needs a shape this system
 * does not already have.
 */

export const S1_META: SampleMeta = {
  id: 's1',
  name: 'Bar',
  thesis: 'Hard edges, no card, and a primary welded to the bottom of the screen.',
  form: 'Full-bleed bottom bar · bare amount with the unit stacked · no sheet, two-up tiles · 6px corners · top-weighted · dense',
  motion: 'Mechanical. Linear and stepped, never eased. Instant press inversion, cells that snap, one rule that sweeps.',
  silence: 'Receipt, not verdict. Each committed answer stamps a cell and prints a recorded line that stays.',
}

const P = 's1'

export default function S1Bar({ screen, solo, pressed }: SampleProps) {
  const [picked, setPicked] = useState<number | null>(TRIVIA.picked)
  const [open, setOpen] = useState(false)
  const claimed = screen === 'claimed'

  return (
    <div className={`${P}-root`} data-solo={solo ? 'true' : 'false'}>
      <style>{kitCss(P)}</style>
      <style>{themeCss(P)}</style>
      <style>{css()}</style>

      <div className={`${P}-field`} data-tone={claimed || screen === 'passed' ? 'warm' : 'live'}>
        <span className={`${P}-scrim`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />
        {claimed ? <span className={`${P}-sweep`} aria-hidden="true" /> : null}

        <div className={`${P}-inner`}>
          <header className={`${P}-head`}>
            <p className={`${P}-mast`}>
              NimDrops<span>{screenLabel(screen)}</span>
            </p>
            <button type="button" className={`${P}-round`} aria-label="About NimDrops">
              <InfoIcon size={19} />
            </button>
          </header>

          <main className={`${P}-main`}>
            {screen === 'question' ? (
              <Question picked={picked} onPick={setPicked} />
            ) : screen === 'games' ? (
              <Games />
            ) : screen === 'gate' ? (
              <Gate />
            ) : screen === 'failed' ? (
              <Failed />
            ) : (
              <Claim screen={screen} open={open} onToggle={() => setOpen((v) => !v)} />
            )}
          </main>
        </div>

        <Bar screen={screen} pressed={pressed} picked={picked} />
      </div>
    </div>
  )
}

function screenLabel(screen: string) {
  if (screen === 'question' || screen === 'gate') return `${TRIVIA.tier} tier`
  if (screen === 'games') return 'Gated drops'
  return 'One link, a fixed share each'
}

// ---- the claim, the sealed state, and the outcome ---------------------------------

function Claim({
  screen,
  open,
  onToggle,
}: {
  screen: string
  open: boolean
  onToggle: () => void
}) {
  const claimed = screen === 'claimed'
  const sealed = screen === 'sealed'
  const passed = screen === 'passed'
  const left = claimed ? DROP.left - 1 : DROP.left

  return (
    <>
      <p className={`${P}-from`}>
        <b>{DROP.sponsor}</b> sent you a NimDrop
        <span className={`${P}-chip`}>name unverified</span>
      </p>

      {/* Bare on the field. A local scrim rather than a plate is what keeps it
          legible, and it is what makes the money part of the light instead of
          an object sitting on top of it. */}
      <div className={`${P}-money`}>
        <span className={`${P}-moneyscrim`} aria-hidden="true" />
        <Amount value={DROP.amount} unit="mark" markScale={0.6} className={`${P}-amount`} />
        <p className={`${P}-unit`}>NIM {claimed ? 'sent' : 'each'}</p>
        <p className={`${P}-moneycap`}>
          {claimed
            ? 'Sent to the wallet that signed'
            : sealed
              ? 'Fixed and equal. The same for everyone who opens this link'
              : passed
                ? 'Gate cleared. The share is yours to take'
                : 'The same for everyone who opens this link'}
        </p>
      </div>

      {sealed ? (
        <div className={`${P}-sealed`}>
          <div className={`${P}-qr`}>
            <MockQr size={150} />
          </div>
          <div>
            <h2>Open this on your phone</h2>
            <p>
              Claiming needs a wallet to sign, and Nimiq Pay is a phone app. Scan this with the
              phone that has it.
            </p>
            <p className={`${P}-link`}>{DROP.link}</p>
          </div>
        </div>
      ) : (
        <div className={`${P}-tiles`}>
          <Tile label="Shares left" value={`${left} of ${DROP.shares}`}>
            <span className={`${P}-seg`} aria-hidden="true">
              {Array.from({ length: DROP.shares }).map((_, i) => (
                <i key={i} data-on={i < left ? 'true' : 'false'} />
              ))}
            </span>
          </Tile>
          <Tile label="Closes in" value={DROP.expiresIn} live />
        </div>
      )}

      {claimed ? (
        <dl className={`${P}-rows`}>
          <Row k="Paid to" v={`${DROP.address.slice(0, 19)}…`} />
          <Row k="Transaction" v={`${DROP.txHash.slice(0, 10)}…${DROP.txHash.slice(-6)}`} />
          <Row k="Confirmed" v="26 Jul, 21:04 UTC" />
        </dl>
      ) : (
        <p className={`${P}-msg`}>{DROP.message}</p>
      )}

      <div className={`${P}-disc`}>
        <button type="button" className={`${P}-discbtn`} aria-expanded={open} onClick={onToggle}>
          <CustodyShieldIcon size={18} />
          NimDrops is holding this NIM
          <ChevronRightIcon size={16} className={`${P}-caret`} />
        </button>
        {open ? (
          <dl className={`${P}-rows`}>
            {CUSTODY.map((f) => (
              <Row key={f.k} k={f.k} v={f.v} wrap />
            ))}
          </dl>
        ) : null}
      </div>
    </>
  )
}

function Tile({
  label,
  value,
  live,
  children,
}: {
  label: string
  value: string
  live?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`${P}-tile`}>
      <p className={`${P}-tilelabel`}>{label}</p>
      <p className={`${P}-tilevalue ${P}-num`}>{value}</p>
      {children}
      {/* A marker, not a control. It reports that the value is live; it does
          not pretend to be tappable, which a fake affordance would. */}
      <span className={`${P}-marker`} data-live={live ? 'true' : 'false'} aria-hidden="true" />
    </div>
  )
}

function Row({ k, v, wrap }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div className={`${P}-row`} data-wrap={wrap ? 'true' : 'false'}>
      <dt>{k}</dt>
      <dd className={`${P}-num`}>{v}</dd>
    </div>
  )
}

// ---- the gate, the question, the outcome, the list ---------------------------------

function Gate() {
  return (
    <>
      <p className={`${P}-from`}>
        <b>{DROP.sponsor}</b> gated this NimDrop
        <span className={`${P}-chip`}>{TRIVIA.tier} tier</span>
      </p>
      <div className={`${P}-money`}>
        <span className={`${P}-moneyscrim`} aria-hidden="true" />
        <Amount value={DROP.amount} unit="mark" markScale={0.6} className={`${P}-amount`} />
        <p className={`${P}-unit`}>NIM each</p>
        <p className={`${P}-moneycap`}>Answer five to open it. The amount does not change.</p>
      </div>
      <dl className={`${P}-rows`}>
        <Row k="Questions" v="5, one at a time" />
        <Row k="Categories" v="5, all different" />
        <Row k="Per question" v={`${TRIVIA.secondsPerQuestion} seconds`} />
        <Row k="One wrong or late" v="Ends the session" />
      </dl>
      <p className={`${P}-note`}>
        You will not be told which answers were right. Only whether the session cleared. If it does
        not, you can start again in {TRIVIA.cooldownMinutes} minutes.
      </p>
    </>
  )
}

function Question({ picked, onPick }: { picked: number | null; onPick: (i: number) => void }) {
  const cells = TRIVIA.secondsPerQuestion
  return (
    <>
      <div className={`${P}-qhead`}>
        <p className={`${P}-tilelabel`}>
          Question {TRIVIA.index} of {TRIVIA.total} · {TRIVIA.category}
        </p>
        <span className={`${P}-seg ${P}-seg--wide`} aria-hidden="true">
          {Array.from({ length: TRIVIA.total }).map((_, i) => (
            <i key={i} data-on={i < TRIVIA.index - 1 ? 'true' : 'false'} data-now={i === TRIVIA.index - 1 ? 'true' : 'false'} />
          ))}
        </span>
      </div>

      {/* The deadline is the server's, and the row says so. Fifteen cells that
          go out one at a time on a hard step: no easing, because a smoothly
          draining bar suggests the browser is the clock, and it is not. */}
      <div className={`${P}-clock`}>
        <span className={`${P}-cells`} aria-hidden="true">
          {Array.from({ length: cells }).map((_, i) => (
            <i key={i} data-on={i < TRIVIA.secondsLeft ? 'true' : 'false'} />
          ))}
        </span>
        <p className={`${P}-num`} aria-live="off">
          {TRIVIA.secondsLeft}s · server clock
        </p>
      </div>

      <h1 className={`${P}-q`}>{TRIVIA.question}</h1>

      <ul className={`${P}-opts`}>
        {TRIVIA.options.map((o, i) => (
          <li key={o}>
            <button
              type="button"
              className={`${P}-opt`}
              aria-pressed={picked === i}
              onClick={() => onPick(i)}
            >
              <span className={`${P}-letter`}>{'ABCD'[i]}</span>
              {o}
            </button>
          </li>
        ))}
      </ul>

      {/* Receipt, not verdict. It says what was received and nothing about
          whether it was right, and it stays on screen for the session. */}
      <dl className={`${P}-rows ${P}-receipt`}>
        <Row k="Answer 1" v="Recorded" />
        <Row k="Answer 2" v="Recorded" />
      </dl>
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
      <h1 className={`${P}-q ${P}-q--tight`}>This session did not clear.</h1>
      <p className={`${P}-note`}>
        Which answers were wrong is not something NimDrops reports, for any session. The drop is
        still live and the questions will be the same ones.
      </p>
      <dl className={`${P}-rows`}>
        <Row k="Try again in" v={`${TRIVIA.cooldownMinutes}:00`} />
        <Row k="Drop closes in" v={DROP.expiresIn} />
        <Row k="Shares left" v={`${DROP.left} of ${DROP.shares}`} />
      </dl>
    </>
  )
}

function Games() {
  return (
    <>
      <h1 className={`${P}-q ${P}-q--tight`}>Gated drops, open now.</h1>
      <ul className={`${P}-list`}>
        {GAMES.map((g) => (
          <li key={g.tier}>
            <button type="button" className={`${P}-listrow`} disabled={Boolean(g.locked)}>
              <span className={`${P}-listtier`}>{g.tier}</span>
              <span className={`${P}-listamt`}>
                <b className={`${P}-num`}>{g.amount}</b>
                <NimMark height="0.85em" />
              </span>
              <span className={`${P}-listmeta ${P}-num`}>
                {g.left} of {g.of} left · {g.expires}
              </span>
              <span className={`${P}-listlock`}>{g.locked || 'Open'}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className={`${P}-note`}>
        Higher tiers pay more and are published in advance. Nothing here is random and no amount
        varies. Addresses of people who claimed are never listed.
      </p>
    </>
  )
}

// ---- the bar --------------------------------------------------------------------

function Bar({
  screen,
  pressed,
  picked,
}: {
  screen: string
  pressed?: boolean
  picked: number | null
}) {
  if (screen === 'sealed') {
    // A finished state, not a disabled one. There is no primary here at all,
    // because there is nothing on this device that could sign.
    return (
      <div className={`${P}-bar ${P}-bar--flat`}>
        <QrCodeIcon size={18} />
        Scan with the phone that has Nimiq Pay
      </div>
    )
  }
  if (screen === 'claimed') {
    return (
      <div className={`${P}-bar`}>
        <button type="button" className={`${P}-go ${P}-go--quiet`}>
          Send a drop back
        </button>
      </div>
    )
  }
  if (screen === 'failed') {
    return (
      <div className={`${P}-bar ${P}-bar--flat`}>Starting again unlocks in {TRIVIA.cooldownMinutes}:00</div>
    )
  }
  const label =
    screen === 'question'
      ? 'Lock in answer'
      : screen === 'gate'
        ? 'Start the five questions'
        : screen === 'games'
          ? 'Open a gated drop'
          : `Open ${DROP.amount} NIM`
  return (
    <div className={`${P}-bar`}>
      <button
        type="button"
        className={`${P}-go`}
        data-pressed={pressed ? 'true' : undefined}
        disabled={screen === 'question' && picked === null}
      >
        {label}
      </button>
    </div>
  )
}

// ---- stylesheet ------------------------------------------------------------------

function css() {
  return `
/* =========================================================================
 * s1 "Bar" — sharp, top-weighted, no card, mechanical motion.
 * ====================================================================== */
.${P}-root { --r: 6px; --gut: 20px; }
.${P}-inner {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  padding: 16px var(--gut) 18px;
  /* overflow-y alone computes overflow-x to auto, and the money's local scrim
     is deliberately wider than the column, so the claim screen was reserving a
     15px horizontal scrollbar across the bottom of the phone. The scrim is
     decorative and aria-hidden; clipping it at the edge is what it wanted. */
  overflow-y: auto; overflow-x: hidden;
}
.${P}-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-bottom: 13px; border-bottom: 1px solid var(--line);
}
.${P}-mast { display: flex; flex-direction: column; margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.012em; }
.${P}-mast span { font-size: 12px; font-weight: 500; color: var(--ink-2); letter-spacing: 0; }
.${P}-round { border-radius: 50%; }
.${P}-main { display: flex; flex-direction: column; padding-top: 16px; }

.${P}-from {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px;
  margin: 0; font-size: 14px; color: var(--ink-2);
}
.${P}-from b { font-weight: 800; color: var(--ink); }
.${P}-chip { border-radius: var(--r); }

/* --- the money, bare --- */
.${P}-money { position: relative; margin: 14px -6px 0; padding: 8px 6px 12px; }
.${P}-moneyscrim {
  position: absolute; inset: -14px -20px -6px;
  background: radial-gradient(72% 100% at 22% 50%, rgb(8 5 4 / 0.72), rgb(8 5 4 / 0) 76%);
  pointer-events: none;
}
.${P}-amount {
  position: relative;
  display: flex; align-items: baseline; margin: 0;
  font-size: 68px; font-weight: 800; line-height: 0.9; letter-spacing: -0.04em;
}
/* The unit is STACKED under the numeral rather than set beside it. Nothing
   else in the set does this and it is half of why the block reads as an
   instrument reading rather than a price. */
.${P}-unit {
  position: relative;
  margin: 6px 0 0; font-size: 13px; font-weight: 800; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--ink);
}
.${P}-moneycap {
  position: relative; margin: 8px 0 0; max-width: 34ch;
  font-size: 13px; line-height: 1.45; color: var(--ink-2); text-wrap: pretty;
}

/* --- two-up tiles --- */
.${P}-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 18px; }
.${P}-tile {
  position: relative; padding: 12px 12px 11px; border-radius: var(--r);
  border: 1px solid var(--line); background: var(--card-flat);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .${P}-tile {
    background: var(--card);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    backdrop-filter: blur(22px) saturate(150%);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .${P}-tile { background: var(--card-solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
.${P}-tilelabel { margin: 0; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.${P}-tilevalue { margin: 3px 0 0; font-size: 19px; font-weight: 800; letter-spacing: -0.015em; }
.${P}-marker {
  position: absolute; top: 10px; right: 10px; width: 10px; height: 10px;
  border: 1px solid var(--line-strong); border-radius: 50%;
}
.${P}-marker[data-live='true'] { background: var(--accent); border-color: var(--accent); animation: ${P}-blink 2s steps(1, end) infinite; }
@keyframes ${P}-blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.3; } }

/* Hard segments. No radius, no easing: they are on or they are off. */
.${P}-seg { display: flex; gap: 3px; margin-top: 9px; }
.${P}-seg i { flex: 1; height: 4px; background: rgb(255 255 255 / 0.16); }
.${P}-seg i[data-on='true'] { background: var(--ink); }
.${P}-seg--wide { margin-top: 8px; }
.${P}-seg--wide i[data-now='true'] { background: var(--accent); }

.${P}-msg {
  margin: 18px 0 0; padding: 13px 0 0; border-top: 1px solid var(--line);
  font-size: 17px; line-height: 1.45; letter-spacing: -0.012em; text-wrap: pretty;
}

/* --- hairline rows, reused for the receipt, the facts and the disclosure --- */
.${P}-rows { margin: 16px 0 0; border-top: 1px solid var(--line); }
.${P}-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13.5px;
}
.${P}-row[data-wrap='true'] { flex-direction: column; gap: 3px; }
.${P}-row dt { margin: 0; color: var(--ink-2); white-space: nowrap; }
.${P}-row dd { margin: 0; font-weight: 700; text-align: right; overflow-wrap: anywhere; }
.${P}-row[data-wrap='true'] dd { text-align: left; font-weight: 500; color: var(--ink-2); line-height: 1.5; }
.${P}-receipt { margin-top: 18px; }

.${P}-disc { margin-top: 18px; }
.${P}-discbtn {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 48px; padding: 12px 0;
  border: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  background: none; font: inherit; font-size: 13.5px; font-weight: 700; color: var(--ink);
  text-align: left; cursor: pointer;
}
.${P}-discbtn > svg:first-child { color: var(--accent); flex: 0 0 auto; }
.${P}-caret { margin-left: auto; color: var(--ink-2); transition: none; }
.${P}-discbtn[aria-expanded='true'] .${P}-caret { transform: rotate(90deg); }
.${P}-note { margin: 14px 0 0; max-width: 46ch; font-size: 13px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }

/* --- the sealed composition --- */
.${P}-sealed { display: flex; gap: 16px; align-items: flex-start; margin-top: 18px; }
.${P}-qr { flex: 0 0 auto; padding: 8px; background: #fff; border-radius: var(--r); line-height: 0; }
.${P}-sealed h2 { margin: 0; font-size: 17px; font-weight: 800; letter-spacing: -0.015em; }
.${P}-sealed p { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }
.${P}-link { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; color: var(--ink) !important; }

/* --- trivia --- */
.${P}-qhead { margin-bottom: 14px; }
.${P}-clock {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
}
.${P}-cells { display: flex; gap: 2px; flex: 1; }
.${P}-cells i { flex: 1; height: 10px; background: rgb(255 255 255 / 0.14); }
.${P}-cells i[data-on='true'] { background: var(--accent); }
.${P}-clock p { margin: 0; font-size: 12px; font-weight: 700; color: var(--ink-2); white-space: nowrap; }
.${P}-q {
  margin: 16px 0 0; font-size: 25px; font-weight: 800;
  line-height: 1.2; letter-spacing: -0.025em; text-wrap: balance;
}
.${P}-q--tight { font-size: 22px; }
.${P}-opts { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.${P}-opt {
  display: flex; align-items: center; gap: 12px;
  width: 100%; min-height: 52px; padding: 11px 13px;
  border: 1px solid var(--line-strong); border-radius: var(--r);
  background: rgb(255 255 255 / 0.05);
  font: inherit; font-size: 15px; color: var(--ink); text-align: left; cursor: pointer;
  transition: none;
}
/* Selection is fill AND weight AND the letter tile inverting, never hue alone. */
.${P}-opt[aria-pressed='true'] { background: var(--action); color: var(--on-action); font-weight: 800; border-color: var(--action); }
.${P}-letter {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 26px; height: 26px; border: 1px solid var(--line-strong); border-radius: 3px;
  font-size: 12px; font-weight: 800;
}
.${P}-opt[aria-pressed='true'] .${P}-letter { background: var(--on-action); color: var(--action); border-color: var(--on-action); }

/* --- the list --- */
.${P}-list { list-style: none; margin: 16px 0 0; padding: 0; border-top: 1px solid var(--line); }
.${P}-listrow {
  display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: baseline;
  width: 100%; min-height: 60px; padding: 11px 0;
  border: 0; border-bottom: 1px solid var(--line); background: none;
  font: inherit; color: var(--ink); text-align: left; cursor: pointer;
}
.${P}-listrow:disabled { cursor: default; }
.${P}-listtier { font-size: 15px; font-weight: 800; }
.${P}-listamt { display: inline-flex; align-items: baseline; gap: 5px; font-size: 19px; font-weight: 800; justify-self: end; }
.${P}-listmeta { grid-column: 1; font-size: 12.5px; color: var(--ink-2); }
.${P}-listlock { grid-column: 2; justify-self: end; font-size: 12.5px; font-weight: 700; color: var(--ink-2); }

/* --- the bar: welded to the bottom edge, full bleed, square --- */
.${P}-bar {
  position: relative; z-index: 3; flex: 0 0 auto;
  border-top: 1px solid var(--line);
  background: rgb(10 6 5 / 0.82);
  padding-bottom: env(safe-area-inset-bottom);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .${P}-bar { background: rgb(10 6 5 / 0.6); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); }
}
.${P}-bar--flat {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 58px; padding: 14px var(--gut);
  font-size: 14px; font-weight: 700; color: var(--ink-2);
}
.${P}-bar--flat svg { color: var(--accent); }
.${P}-go {
  display: block; width: 100%; min-height: 62px; padding: 18px var(--gut);
  border: 0; border-radius: 0;
  background: var(--action); color: var(--on-action);
  font: inherit; font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
  cursor: pointer; transition: none;
}
.${P}-go:disabled { background: rgb(255 255 255 / 0.16); color: var(--ink-2); cursor: default; }
/* Instant inversion. No transition at all: a fade on the button that moves
   somebody's money reads as lag, and this system does not fade. */
.${P}-go:not(:disabled):active, .${P}-go[data-pressed='true'] {
  background: var(--accent); color: #fff;
}
.${P}-go--quiet {
  background: none; color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.${P}-go--quiet:active { background: var(--action); color: var(--on-action); }

/* --- the signature beat: one rule, one pass, constant speed --- */
.${P}-sweep {
  position: absolute; left: 0; top: 0; z-index: 4; height: 2px; width: 100%;
  background: var(--ink); transform-origin: left;
  animation: ${P}-sweep 420ms linear 1 both;
}
@keyframes ${P}-sweep {
  0% { transform: scaleX(0); opacity: 1; }
  70% { transform: scaleX(1); opacity: 1; }
  100% { transform: scaleX(1); opacity: 0; }
}

/* --- the poster: sealed is the only desktop composition --- */
@container (min-width: 54rem) {
  .${P}-inner { padding: 26px 40px 24px; }
  .${P}-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 26rem); gap: 40px; align-items: start; }
  .${P}-from, .${P}-money { grid-column: 1; }
  .${P}-amount { font-size: 96px; }
  .${P}-tiles, .${P}-sealed, .${P}-rows, .${P}-msg, .${P}-disc, .${P}-note, .${P}-opts, .${P}-list { grid-column: 2; }
  .${P}-q, .${P}-qhead, .${P}-clock { grid-column: 1; }
  .${P}-sealed { flex-direction: column; }
  .${P}-msg { margin-top: 0; border-top: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .${P}-sweep, .${P}-marker[data-live='true'] { animation: none; }
  .${P}-sweep { display: none; }
}
`
}
