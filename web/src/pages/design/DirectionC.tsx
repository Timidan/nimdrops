import { useState } from 'react'
import Board, { Panel, Pair } from './Board'
import { DROP, grain, TRIVIA } from './fixtures'

/**
 * DEV-ONLY MOCKUP — Direction C, "Field".
 *
 * Thesis: money moving between people is an event, not an object, so the whole
 * screen becomes the event and the controls float on top of it.
 *
 * Why glass, specifically, and why only here
 * ------------------------------------------
 * Glass is on the absolute-ban list when it is decoration. It is permitted when
 * translucency carries information the opaque version cannot. Here it does one
 * job: a NimDrop is a LIVE surface. While you are reading it, other people are
 * taking shares out of it, and the field behind the sheet is where that state
 * lives (the share marks, the warmth, the drift). A sheet you can see through
 * is a sheet that does not hide the thing that is changing. That is the same
 * argument Apple makes for Liquid Glass belonging to the controls layer over a
 * content layer, and this direction follows its rules rather than the 2021
 * Dribbble version of them:
 *
 *   - ONE glass sheet per view. Nothing translucent stacks on anything else.
 *   - Buttons inside the sheet are SOLID fills, per Apple's "nest buttons on
 *     solid fills inside the glass". The money button is never translucent.
 *   - A barrier fill under the blur, so text contrast is a property of the
 *     sheet and not of whatever happens to be behind it. Every pair in here is
 *     computed, not eyeballed: body lands at 10.9:1, the amount at 16.1:1.
 *   - `prefers-reduced-transparency` swaps glass for a solid surface outright,
 *     which is what the setting means. Not "slightly less blur".
 *   - `blur(16px) saturate(160%)`, not blur alone. Saturation is what stops
 *     frosted glass reading as grey plastic.
 *
 * The signature move is the ripple. Claiming sends one ring across the field
 * and the field keeps a warmer cast afterwards, so the screen remembers that
 * you claimed. One choreography idea, not motion scattered everywhere.
 *
 * Desktop is deliberately the centred column on a designed backdrop, and this
 * is the only one of the three where that answer is correct: the backdrop IS
 * the product here, so widening it is the composition rather than a fallback.
 * The drop's live facts move out onto the field around the sheet, poster-style.
 *
 * The honest risk: `backdrop-filter` over a moving backdrop is the expensive
 * case on a low-end Android WebView, because the blurred region is recomposited
 * whenever what is behind it changes. Mitigations are in the report.
 */

const P = 'c'

export default function DirectionC() {
  return (
    <Board
      letter="C"
      name="Field: the drop is a live surface"
      thesis="One sheet of glass over a surface that is still changing while you read it."
    >
      <style>{css()}</style>

      <Panel label="Claim, unclaimed, 390" note="the judged surface">
        <Claim />
      </Panel>

      <Panel label="Claim, unclaimed, desktop" mode="wide" height={820} note="the field goes full bleed and the facts move onto it">
        <Claim />
      </Panel>

      <Pair>
        <Panel label="Claim, claimed, 390" note="ripple spent, field holds the warmer cast">
          <Claim claimed />
        </Panel>
        <Panel label="Trivia slot, 390" note="the question takes the caption slot, answers are chips">
          <Claim trivia />
        </Panel>
      </Pair>

      <Panel label="Landing hero" mode="bleed" height={780} note="root route, responsive">
        <Landing />
      </Panel>

    </Board>
  )
}

// ---- the claim surface ---------------------------------------------------------

function Claim({ claimed = false, trivia = false }: { claimed?: boolean; trivia?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null)
  // Claiming takes one. A receipt beside an unchanged count is a lie.
  const taken = DROP.claimCount - DROP.remaining + (claimed ? 1 : 0)
  const left = DROP.claimCount - taken

  return (
    <div className={`${P}-root`}>
      <div className={`${P}-field`} data-claimed={claimed ? 'true' : 'false'}>
        <span className={`${P}-lt ${P}-lt1`} aria-hidden="true" />
        <span className={`${P}-lt ${P}-lt2`} aria-hidden="true" />
        <span className={`${P}-lt ${P}-lt3`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />
        {claimed ? <span className={`${P}-ripple`} aria-hidden="true" /> : null}

        {/* Field furniture. On a phone these are inside the sheet instead. */}
        <p className={`${P}-mast`}>NimDrops</p>
        <p className={`${P}-fieldcount`}>
          <span className={`${P}-marks`} aria-hidden="true">
            {Array.from({ length: DROP.claimCount }).map((_, i) => (
              <i key={i} data-taken={i < taken ? 'true' : 'false'} />
            ))}
          </span>
          {left} of {DROP.claimCount} shares left
        </p>
        <p className={`${P}-fieldnote`}>
          NimDrops is holding this NIM, not a smart contract. One share per wallet, first come,
          first served.
        </p>

        <div className={`${P}-stack`}>
          {/* The one glass sheet in the whole direction. */}
          <div className={`${P}-sheet`}>
            <p className={`${P}-from`}>
              <b>{DROP.sponsor}</b> sent you a NimDrop
              <button type="button" className={`${P}-chip`}>
                name unverified
              </button>
            </p>
            <p className={`${P}-msg`}>{DROP.message}</p>

            {/* The only fully opaque thing on the screen is the money. */}
            <div className={`${P}-plate`}>
              <h1>
                {DROP.amount}
                <span>{DROP.unit}</span>
              </h1>
              <p>{claimed ? 'Sent to the wallet that signed' : 'The same for everyone who opens this link'}</p>
            </div>

            {trivia ? (
              <div className={`${P}-quiz`}>
                <p className={`${P}-quiz-q`}>{TRIVIA.question}</p>
                <div className={`${P}-quiz-opts`}>
                  {TRIVIA.options.map((o, i) => (
                    <button
                      key={o}
                      type="button"
                      className={`${P}-quiz-opt`}
                      aria-pressed={picked === i}
                      onClick={() => setPicked(i)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className={`${P}-sheetcount`}>
                {left} of {DROP.claimCount} shares left, goes back in {DROP.expiresIn}
              </p>
            )}

            {claimed ? (
              <div className={`${P}-receipt`}>
                <Row k="Paid to" v="NQ07 8E9J … 4K2M" />
                <Row k="Transaction" v={`${DROP.txHash.slice(0, 10)}…${DROP.txHash.slice(-6)}`} />
                <Row k="Confirmed" v="26 Jul 2026, 21:04 UTC" />
                <button type="button" className={`${P}-secondary`}>
                  Share the app
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className={`${P}-primary`}
                  disabled={trivia && picked === null}
                >
                  Open {DROP.amount} {DROP.unit}
                </button>
                <p className={`${P}-help`}>
                  {trivia
                    ? 'Answer, then Nimiq Pay opens. One signature, no amount to type, no fee to pay.'
                    : 'Nimiq Pay opens next. One signature, no amount to type, no fee to pay.'}
                </p>
              </>
            )}
          </div>

          {/* Phone only: the custody line lives under the sheet, not on it,
              because nothing translucent may stack on the sheet. */}
          <button type="button" className={`${P}-custody`}>
            Read who is holding this NIM
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <p className={`${P}-row`}>
      <span>{k}</span>
      <b>{v}</b>
    </p>
  )
}

// ---- the landing -----------------------------------------------------------------

function Landing() {
  return (
    <div className={`${P}-land`}>
      <span className={`${P}-lt ${P}-lt1`} aria-hidden="true" />
      <span className={`${P}-lt ${P}-lt2`} aria-hidden="true" />
      <span className={`${P}-lt ${P}-lt3`} aria-hidden="true" />
      <span className={`${P}-grain`} aria-hidden="true" />

      <header className={`${P}-landbar`}>
        <span className={`${P}-mast ${P}-static`}>NimDrops</span>
        <button type="button" className={`${P}-secondary ${P}-sm`}>
          Open a drop
        </button>
      </header>

      <div className={`${P}-landgrid`}>
        <div>
          <h1 className={`${P}-h1`}>Put money in the group chat and watch it go.</h1>
          <p className={`${P}-sub`}>
            One link, one fixed share each, first come first served. The page is live: shares
            disappear from it while people open them, and the number you see is the number you get.
          </p>
          <div className={`${P}-cta`}>
            <button type="button" className={`${P}-primary`}>
              Send a drop
            </button>
            <button type="button" className={`${P}-secondary`}>
              Open the live one
            </button>
          </div>
          <p className={`${P}-fine`}>
            Live on Nimiq mainnet. NimDrops holds the NIM until it is claimed. Read how that works
            before you fund anything.
          </p>
        </div>

        <div className={`${P}-demo`}>
          <div className={`${P}-sheet ${P}-mini`}>
            <p className={`${P}-from`}>
              <b>Amara O.</b> sent you a NimDrop
            </p>
            <div className={`${P}-plate`}>
              <h1>
                2<span>NIM</span>
              </h1>
              <p>The same for everyone who opens this link</p>
            </div>
            <p className={`${P}-sheetcount`}>3 of 5 shares left, goes back in 3h 20m</p>
            <button type="button" className={`${P}-primary`}>
              Open 2 NIM
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- stylesheet ------------------------------------------------------------------

function css() {
  return `
.${P}-root { height: 100%; container-type: inline-size; }
.${P}-root *, .${P}-land * { box-sizing: border-box; }
.${P}-root, .${P}-land {
  --ink: #181430;
  --paperless: #f4f3f7;      /* chroma near 0, cool. Not a warm near-white. */
  --gold: #e9b213;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}

/* Committed dark. The base is Nimiq's own #260133 into #1F2348, pushed one
   step darker so the lights on top have somewhere to be bright. */
.${P}-field, .${P}-land {
  position: relative; overflow: hidden;
  background-color: #14112b;
  background-image: radial-gradient(120% 120% at bottom right, #260133 0%, #1b1b3d 52%, #12102a 100%);
  color: var(--paperless);
  font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.${P}-field { display: flex; flex-direction: column; height: 100%; padding: 18px 18px 22px; }

/* Three lights, moved with transform only so no gradient is re-rasterised per
   frame. Slow enough to be weather, not a screensaver. */
.${P}-lt {
  position: absolute; z-index: 0;
  width: 78vmax; height: 78vmax; border-radius: 50%;
  filter: blur(44px); pointer-events: none;
}
.${P}-lt1 {
  top: -32vmax; left: -24vmax; opacity: 0.52;
  background: radial-gradient(closest-side, rgba(5, 130, 202, 0.6), rgba(5, 130, 202, 0) 70%);
  animation: ${P}-d1 42s ease-in-out infinite alternate;
}
.${P}-lt2 {
  right: -28vmax; top: 4%; opacity: 0.4;
  background: radial-gradient(closest-side, rgba(95, 75, 139, 0.7), rgba(95, 75, 139, 0) 70%);
  animation: ${P}-d2 55s ease-in-out infinite alternate;
}
.${P}-lt3 {
  bottom: -34vmax; left: -8%; opacity: 0.36;
  background: radial-gradient(closest-side, rgba(233, 178, 19, 0.55), rgba(233, 178, 19, 0) 70%);
  animation: ${P}-d3 48s ease-in-out infinite alternate;
  transition: opacity 900ms ease-out;
}
@keyframes ${P}-d1 { to { transform: translate3d(16vmax, 10vmax, 0) scale(1.12); } }
@keyframes ${P}-d2 { to { transform: translate3d(-14vmax, 12vmax, 0) scale(1.08); } }
@keyframes ${P}-d3 { to { transform: translate3d(12vmax, -9vmax, 0) scale(1.14); } }
/* The field keeps a warmer cast after a claim. The screen remembers. */
.${P}-field[data-claimed='true'] .${P}-lt3 { opacity: 0.62; }

.${P}-grain {
  position: absolute; inset: 0; z-index: 1;
  background-image: ${grain()};
  opacity: 0.05; pointer-events: none;
}

/* One ring, once, from where the button was. */
.${P}-ripple {
  position: absolute; z-index: 1; left: 50%; bottom: 26%;
  width: 40px; height: 40px; margin: -20px 0 0 -20px;
  border: 1.5px solid rgb(233 178 19 / 0.7); border-radius: 50%;
  animation: ${P}-ring 900ms var(--ease) 1 both;
  pointer-events: none;
}
@keyframes ${P}-ring {
  from { transform: scale(0.4); opacity: 0.9; }
  to { transform: scale(22); opacity: 0; }
}

/* --- field furniture --- */
.${P}-mast { position: relative; z-index: 2; margin: 0; font-size: 13px; font-weight: 700; }
.${P}-fieldcount, .${P}-fieldnote { display: none; }
.${P}-marks { display: inline-flex; gap: 4px; }
.${P}-marks i { display: block; width: 16px; height: 4px; border-radius: 999px; background: var(--gold); }
.${P}-marks i[data-taken='true'] { background: rgb(244 243 247 / 0.24); }

.${P}-stack {
  position: relative; z-index: 2;
  display: flex; flex: 1; flex-direction: column; justify-content: center;
  min-height: 0; overflow-y: auto;
  padding: 18px 0 4px;
}

/* --- the sheet --- */
.${P}-sheet {
  width: 100%; max-width: 460px; margin: 0 auto;
  padding: 22px 22px 20px;
  border: 1px solid rgb(244 243 247 / 0.16);
  border-radius: 24px;
  /* Barrier fill FIRST. Contrast is a property of the sheet, not of the field
     behind it, so this value is what the ratios were computed against. */
  background: linear-gradient(rgb(20 16 42 / 0.82), rgb(20 16 42 / 0.74));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.14), 0 18px 40px -24px rgb(0 0 0 / 0.9);
}
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .${P}-sheet {
    background: linear-gradient(rgb(20 16 42 / 0.7), rgb(20 16 42 / 0.6));
    -webkit-backdrop-filter: blur(16px) saturate(160%);
    backdrop-filter: blur(16px) saturate(160%);
  }
}
/* Reduce Transparency means solid, not "a bit less blur". */
@media (prefers-reduced-transparency: reduce) {
  .${P}-sheet {
    background: #1a1636;
    -webkit-backdrop-filter: none; backdrop-filter: none;
  }
}

.${P}-from { margin: 0; font-size: 16px; line-height: 1.5; color: rgb(244 243 247 / 0.82); }
.${P}-from b { font-weight: 650; color: var(--paperless); }
.${P}-chip {
  display: inline-block; margin-left: 8px; padding: 4px 10px; vertical-align: 1px;
  min-height: 28px;
  border: 1px solid rgb(244 243 247 / 0.26); border-radius: 999px;
  background: none; font: inherit; font-size: 13px;
  color: rgb(244 243 247 / 0.82); white-space: nowrap; cursor: pointer;
}
.${P}-msg {
  margin: 16px 0 0; padding-left: 15px;
  border-left: 1px solid var(--gold);
  font-size: 20px; line-height: 1.45; letter-spacing: -0.01em;
  color: rgb(244 243 247 / 0.94); text-wrap: pretty;
}

/* Opaque, always. The number is the one thing that must never depend on what
   is behind it. */
.${P}-plate {
  margin-top: 22px; padding: 20px 20px 16px;
  border-radius: 18px;
  background: var(--paperless);
  color: var(--ink);
  text-align: center;
}
.${P}-plate h1 {
  margin: 0; font-size: 61px; font-weight: 600;
  line-height: 0.94; letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.${P}-plate h1 span {
  margin-left: 10px; font-size: 0.3em; font-weight: 600;
  letter-spacing: 0.14em; color: rgb(24 20 48 / 0.7);
}
.${P}-plate p { margin: 10px 0 0; font-size: 13px; line-height: 1.5; color: rgb(24 20 48 / 0.76); }

.${P}-sheetcount {
  margin: 18px 0 0; font-size: 13px; text-align: center;
  color: rgb(244 243 247 / 0.82); font-variant-numeric: tabular-nums;
}

.${P}-quiz { margin-top: 20px; }
.${P}-quiz-q { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.32; letter-spacing: -0.01em; text-wrap: balance; }
.${P}-quiz-opts { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.${P}-quiz-opt {
  min-height: 48px; padding: 12px 15px;
  border: 1px solid rgb(244 243 247 / 0.26); border-radius: 13px;
  /* Solid fill, not a second pane of glass. Apple's own rule: nest solid
     controls inside the sheet, never stack translucency. */
  background: rgb(244 243 247 / 0.08);
  font: inherit; font-size: 16px; text-align: left;
  color: var(--paperless); cursor: pointer;
  transition: border-color 180ms ease-out, background-color 180ms ease-out;
}
.${P}-quiz-opt[aria-pressed='true'] { border-color: var(--gold); background: rgb(233 178 19 / 0.2); font-weight: 600; }

.${P}-primary {
  display: block; width: 100%; min-height: 52px; margin-top: 20px; padding: 14px 20px;
  border: 0; border-radius: 15px;
  background: var(--gold); color: #1a1633;
  font: inherit; font-size: 17px; font-weight: 680; cursor: pointer;
  transition: opacity 160ms ease-out;
}
.${P}-primary:disabled { opacity: 0.42; cursor: default; }
.${P}-primary:not(:disabled):active { opacity: 0.88; }
.${P}-secondary {
  display: block; width: 100%; min-height: 52px; padding: 14px 20px;
  border: 1px solid rgb(244 243 247 / 0.3); border-radius: 15px;
  background: none; font: inherit; font-size: 17px; font-weight: 600;
  color: var(--paperless); cursor: pointer;
  transition: border-color 160ms ease-out;
}
.${P}-secondary:hover { border-color: rgb(244 243 247 / 0.6); }
.${P}-secondary.${P}-sm { width: auto; min-height: 44px; padding: 10px 18px; font-size: 16px; border-radius: 12px; }
.${P}-help { margin: 11px 0 0; font-size: 13px; line-height: 1.5; text-align: center; color: rgb(244 243 247 / 0.82); }

.${P}-receipt { margin-top: 20px; border-top: 1px solid rgb(244 243 247 / 0.16); }
.${P}-row {
  display: flex; justify-content: space-between; gap: 14px;
  margin: 0; padding: 10px 0; border-bottom: 1px solid rgb(244 243 247 / 0.1);
  font-size: 13px;
}
.${P}-row span { color: rgb(244 243 247 / 0.82); }
.${P}-row b { font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
.${P}-receipt .${P}-secondary { margin-top: 18px; }

.${P}-custody {
  width: 100%; max-width: 460px; margin: 14px auto 0;
  min-height: 44px; padding: 10px 8px;
  border: 0; background: none; font: inherit; font-size: 13px; font-weight: 600;
  color: rgb(244 243 247 / 0.82); text-decoration: underline; text-underline-offset: 4px;
  cursor: pointer;
}
:where(.${P}-root, .${P}-land) :where(button):focus-visible {
  outline: 2px solid var(--gold); outline-offset: 3px;
}

/* --- desktop: the backdrop IS the composition --- */
@container (min-width: 860px) {
  .${P}-field { padding: 32px 40px 34px; }
  .${P}-mast { font-size: 15px; }
  .${P}-fieldcount {
    display: flex; align-items: center; gap: 12px;
    position: absolute; z-index: 2; top: 30px; right: 40px;
    margin: 0; font-size: 15px; font-weight: 600;
    color: rgb(244 243 247 / 0.82); font-variant-numeric: tabular-nums;
  }
  .${P}-fieldnote {
    display: block;
    position: absolute; z-index: 2; bottom: 32px; left: 40px;
    margin: 0; max-width: 34ch; font-size: 13px; line-height: 1.6;
    color: rgb(244 243 247 / 0.82);
  }
  .${P}-sheet { max-width: 460px; padding: 28px 28px 24px; }
  .${P}-plate h1 { font-size: 76px; }
  /* The one that is now redundant with the field furniture. */
  .${P}-stack .${P}-custody { display: none; }
}

/* --- landing --- */
.${P}-land { min-height: 100%; padding: 20px clamp(20px, 5vw, 56px) 48px; }
.${P}-landbar { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.${P}-landgrid {
  position: relative; z-index: 2;
  display: grid; gap: 44px; align-items: center;
  margin-top: clamp(30px, 6vh, 68px);
}
.${P}-h1 {
  margin: 0; font-size: clamp(39px, 6vw, 76px); font-weight: 640;
  line-height: 1.03; letter-spacing: -0.03em; text-wrap: balance; max-width: 14ch;
}
.${P}-sub { margin: 22px 0 0; max-width: 52ch; font-size: 20px; line-height: 1.5; color: rgb(244 243 247 / 0.82); text-wrap: pretty; }
.${P}-cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.${P}-cta > * { width: auto; min-width: 176px; margin-top: 0; }
.${P}-fine { margin: 22px 0 0; max-width: 54ch; font-size: 13px; color: rgb(244 243 247 / 0.82); }
.${P}-land > .${P}-landgrid .${P}-cta .${P}-primary {
  background: var(--paperless); color: var(--ink);
}
.${P}-demo { display: flex; justify-content: center; }
.${P}-mini { max-width: 380px; }
.${P}-mini .${P}-plate h1 { font-size: 49px; }

@media (min-width: 900px) {
  .${P}-landgrid { grid-template-columns: 1.1fr 0.9fr; gap: 56px; }
}

/* Reduced motion: the lights hold a composed position instead of drifting, and
   the ripple lands on its finished state rather than expanding. The field keeps
   every bit of its colour; only the movement goes. */
@media (prefers-reduced-motion: reduce) {
  .${P}-root *, .${P}-root *::before, .${P}-root *::after,
  .${P}-land *, .${P}-land *::before, .${P}-land *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
  .${P}-lt1 { transform: translate3d(8vmax, 5vmax, 0); }
  .${P}-lt2 { transform: translate3d(-7vmax, 6vmax, 0); }
  .${P}-lt3 { transform: translate3d(6vmax, -4vmax, 0); }
  .${P}-ripple { display: none; }
}
`
}
