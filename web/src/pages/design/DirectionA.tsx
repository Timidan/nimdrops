import { useState } from 'react'
import Board, { Panel, Pair } from './Board'
import { DROP, grain, TRIVIA } from './fixtures'

/**
 * DEV-ONLY MOCKUP — Direction A, "Sealed".
 *
 * Thesis: the gift is a physical object, so make the object worth the money in
 * it, and give it a room to sit in.
 *
 * The bet
 * -------
 * The envelope stays. What changes is that it stops being a flat sheet on a
 * flat colour and becomes a lit object in a room: the field takes Nimiq's own
 * `--nimiq-blue-bg` token (`radial-gradient(100% 100% at bottom right, #260133,
 * #1F2348)`, verbatim from `nimiq/nimiq-style/src/theme.css`), the sheet gets
 * fibre, the wax gets a single foil pass, and everything gets grain so no large
 * field bands on a phone panel.
 *
 * Two decisions here are answers to specific criticism, not styling.
 *
 * **The stock is chroma-0, not warm.** `--color-paper: #fbf9f4` sits in the
 * warm-near-white band (OKLCH L .84-.97, C < .06, hue 40-100) that is now the
 * saturated AI default, and the token name `--paper` is itself on the tell
 * list. So the sheet here is `#f2f2f1`, a true neutral, and every bit of warmth
 * on it comes from *light*: a warm top-lamp gradient and the gold accent. It
 * still reads as paper. It is no longer sitting on the tell.
 *
 * **No glass.** Direction A's answer to "this looks like plain HTML" is
 * material, light, and type: fibre in the sheet, a real cast shadow, a foil
 * sweep, a 61px tabular denomination. The action bar is an opaque printed band.
 * Only Direction C makes glass its material, so the owner gets a real choice
 * rather than three tinted variants of the same idea. Adding a blurred dock
 * here later costs one `@supports` block.
 *
 * Desktop is a two-pane composition, not a widened column. An envelope at
 * 1100px stops being an envelope, so the object keeps 430px and the room around
 * it gets a job: sponsor, message and custody move off the paper and onto the
 * field. That is Stripe Checkout's shape, and Stripe's own guidance is that
 * desktop and mobile checkout are composed separately rather than reflowed.
 */

const P = 'a'

export default function DirectionA() {
  return (
    <Board
      letter="A"
      name="Sealed: the envelope, made properly"
      thesis="The gift is a physical object. Give it fibre, foil, and a room to sit in."
    >
      <style>{css()}</style>

      <Panel label="Claim, sealed, 390" note="the judged surface">
        <Claim />
      </Panel>

      <Panel label="Claim, sealed, desktop" mode="wide" height={820} note="two panes: the room carries the story, the object holds the money">
        <Claim />
      </Panel>

      <Pair>
        <Panel label="Claim, opened, 390" note="seal broken, share reserved, receipt on the sheet">
          <Claim opened />
        </Panel>
        <Panel label="Trivia slot, 390" note="the question is a card tucked under the flap">
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

function Claim({ opened = false, trivia = false }: { opened?: boolean; trivia?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null)
  // Opening takes one. A receipt beside an unchanged count is a lie.
  const left = DROP.remaining - (opened ? 1 : 0)

  return (
    <div className={`${P}-root`}>
      <div className={`${P}-stage`}>
        <span className={`${P}-grain`} aria-hidden="true" />

        {/* Desktop only. On a phone this content is printed on the sheet. */}
        <aside className={`${P}-room`}>
          <p className={`${P}-mast`}>NimDrops</p>
          <h2 className={`${P}-roomline`}>
            <b>{DROP.sponsor}</b> sent you a NimDrop
          </h2>
          <p className={`${P}-roommsg`}>{DROP.message}</p>
          <div className={`${P}-custody`}>
            <p className={`${P}-custody-h`}>NimDrops is holding this NIM, not a smart contract</p>
            <p className={`${P}-custody-b`}>
              Who holds it, why one share per wallet is not one person, and where it goes if nobody
              claims.
            </p>
          </div>
        </aside>

        <div className={`${P}-objectwrap`}>
          <div className={`${P}-env`} data-open={opened ? 'true' : 'false'}>
            <div className={`${P}-flap`} aria-hidden="true">
              <span className={`${P}-flap-face`} />
            </div>
            <div className={`${P}-seal`} aria-hidden="true">
              <span className={`${P}-wax`}>
                <span className={`${P}-wax-h ${P}-l`} />
                <span className={`${P}-wax-h ${P}-r`} />
                <span className={`${P}-wax-mark`}>{DROP.initial}</span>
                <span className={`${P}-foil`} />
              </span>
            </div>

            <span className={`${P}-tooth`} aria-hidden="true" />
            <span className={`${P}-fibre`} aria-hidden="true" />
            <div className={`${P}-paper`}>
              <span className={`${P}-liner`} aria-hidden="true" />

              <div className={`${P}-scroll`}>
                {/* Phone only. The room pane carries this on desktop. */}
                <div className={`${P}-onpaper`}>
                  <p className={`${P}-from`}>
                    <b>{DROP.sponsor}</b> sent you a NimDrop
                    <button type="button" className={`${P}-chip`}>
                      name unverified
                    </button>
                  </p>
                  <p className={`${P}-msg`}>{DROP.message}</p>
                </div>

                {trivia ? (
                  <div className={`${P}-card`}>
                    <p className={`${P}-card-tag`}>One question before this opens</p>
                    <p className={`${P}-card-q`}>{TRIVIA.question}</p>
                    <div className={`${P}-card-opts`}>
                      {TRIVIA.options.map((o, i) => (
                        <button
                          key={o}
                          type="button"
                          aria-pressed={picked === i}
                          onClick={() => setPicked(i)}
                          className={`${P}-opt`}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={`${P}-amount`}>
                  <h1>
                    {DROP.amount}
                    <span>{DROP.unit}</span>
                  </h1>
                  {opened ? <span className={`${P}-keyline`} /> : null}
                </div>

                <p className={`${P}-clause`}>
                  {opened
                    ? `${DROP.amount} NIM is on its way to the wallet that signed.`
                    : 'A fixed share of NIM. The same amount for everyone who opens this link.'}
                </p>

                <p className={`${P}-facts`}>
                  <span>
                    {left} of {DROP.claimCount} shares left
                  </span>
                  <i aria-hidden="true">·</i>
                  <span>Goes back in {DROP.expiresIn}</span>
                </p>

                {opened ? (
                  <div className={`${P}-receipt`}>
                    <Row k="Sent to" v="NQ07 8E9J … 4K2M" />
                    <Row k="Transaction" v={`${DROP.txHash.slice(0, 10)}…${DROP.txHash.slice(-6)}`} />
                    <Row k="Status" v="Confirmed on Nimiq mainnet" />
                  </div>
                ) : (
                  <button type="button" className={`${P}-quiet`}>
                    <span>NimDrops is holding this NIM, not a smart contract</span>
                    <em>
                      Who holds it, why one share per wallet is not one person, and where it goes if
                      nobody claims.
                    </em>
                  </button>
                )}
              </div>

              {/* An opaque printed band, not glass. It docks so the money button
                  is never below the fold on a long sheet. */}
              <div className={`${P}-dock`}>
                {opened ? (
                  <button type="button" className={`${P}-secondary`}>
                    Share the app
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`${P}-primary`}
                      disabled={trivia && picked === null}
                    >
                      Open {DROP.amount} {DROP.unit}
                    </button>
                    <p className={`${P}-dockhelp`}>
                      {trivia
                        ? 'Answer, then Nimiq Pay opens. One signature, no amount to type, no fee to pay.'
                        : 'Nimiq Pay opens next. One signature, no amount to type, no fee to pay.'}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
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
      <span className={`${P}-grain`} aria-hidden="true" />
      <span className={`${P}-lamp ${P}-lamp1`} aria-hidden="true" />
      <span className={`${P}-lamp ${P}-lamp2`} aria-hidden="true" />

      <header className={`${P}-landbar`}>
        <span className={`${P}-mast`}>NimDrops</span>
        <button type="button" className={`${P}-ghost`}>
          Open a drop
        </button>
      </header>

      <div className={`${P}-landgrid`}>
        <div>
          <h1 className={`${P}-h1`}>One link. One share each. Nobody gets less.</h1>
          <p className={`${P}-sub`}>
            Fund one drop, paste one link into the group chat. Everyone who opens it gets the same
            amount of NIM. Nothing is drawn, nothing is ranked, and the number is printed on the
            envelope before you tap it.
          </p>
          <div className={`${P}-cta`}>
            <button type="button" className={`${P}-primary`}>
              Send a drop
            </button>
            <button type="button" className={`${P}-ghost`}>
              Open the live one
            </button>
          </div>
          <p className={`${P}-fine`}>
            Live on Nimiq mainnet. NimDrops holds the NIM until it is claimed. Read how that works
            before you fund anything.
          </p>
        </div>

        <div className={`${P}-hero`}>
          <div className={`${P}-heroenv`} aria-hidden="true">
            <span className={`${P}-heroflap`} />
            <span className={`${P}-herowax`}>
              <span className={`${P}-foil`} />
            </span>
            <span className={`${P}-heroamt`}>
              2<i>NIM</i>
            </span>
            <span className={`${P}-herofoot`}>3 of 5 shares left</span>
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
  --ink: #1f2348;
  --stock: #f2f2f1;          /* chroma 0. The warmth is light, not pigment. */
  --gold: #e9b213;
  --gold-deep: #c8960b;
  /* ease-out-expo. No overshoot, no elastic. */
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}

/* The field: Nimiq's own --nimiq-blue-bg stops, anchored bottom-right. */
.${P}-stage {
  position: relative;
  display: flex;
  height: 100%;
  overflow: hidden;
  background-color: #1f2348;
  background-image: radial-gradient(115% 115% at bottom right, #260133 0%, #1f2348 58%, #171a38 100%);
  color: var(--stock);
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.${P}-grain {
  position: absolute; inset: 0; z-index: 1;
  background-image: ${grain()};
  opacity: 0.04; pointer-events: none;
}

/* --- the room (desktop only) --- */
.${P}-room { display: none; }
.${P}-mast { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.005em; }
.${P}-roomline {
  margin: 40px 0 0; font-size: 20px; font-weight: 400; line-height: 1.45;
  color: rgb(242 242 241 / 0.78); text-wrap: balance;
}
.${P}-roomline b { font-weight: 650; color: var(--stock); }
.${P}-roommsg {
  margin: 20px 0 0; padding-left: 18px;
  border-left: 1px solid var(--gold);
  font-size: 25px; line-height: 1.4; letter-spacing: -0.012em;
  color: rgb(242 242 241 / 0.92); text-wrap: pretty; max-width: 22ch;
}
.${P}-custody {
  margin-top: auto; padding: 16px 18px;
  border: 1px solid rgb(242 242 241 / 0.16); border-radius: 14px;
}
.${P}-custody-h { margin: 0; font-size: 16px; font-weight: 600; }
.${P}-custody-b { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: rgb(242 242 241 / 0.66); }

/* --- the object --- */
.${P}-objectwrap {
  position: relative; z-index: 2;
  display: flex; flex: 1; min-width: 0; justify-content: center;
}
.${P}-env {
  --fh: clamp(6.5rem, 26cqw, 8.125rem);
  --gut: clamp(1.25rem, 6cqw, 1.5rem);
  position: relative;
  display: flex; flex: 1; flex-direction: column;
  min-width: 0; max-width: 430px;
  margin-top: calc(var(--fh) * 0.68);
  perspective: 900px;
}
.${P}-paper {
  position: relative;
  display: flex; flex: 1; flex-direction: column;
  min-width: 0; overflow: hidden;
  border-radius: 14px 14px 0 0;
  background-color: var(--stock);
  color: var(--ink);
  filter: drop-shadow(0 16px 28px rgb(8 6 24 / 0.55));
  transition: transform 560ms var(--ease) 80ms;
}
.${P}-env[data-open='true'] .${P}-paper { transform: translateY(-6px); }

/* Fibre plus a warm lamp. This is where the "paper" reading comes from now
   that the stock itself is a true neutral. */
/* The lamp. This is where the sheet's warmth comes from now that the stock is
   a true neutral, so it is a light source and not a pigment. */
.${P}-tooth {
  position: absolute; inset: 0; z-index: 5;
  border-radius: 14px 14px 0 0;
  background-image: radial-gradient(130% 68% at 50% -14%, rgb(255 231 180 / 0.5) 0%, rgb(255 231 180 / 0) 64%);
  mix-blend-mode: multiply;
  pointer-events: none;
}
/* Fibre, over the flap AND the sheet, because they are one piece of paper.
   8.5% is the whole budget: at anything above about 12% fractal noise stops
   reading as tooth and starts reading as sensor grain. */
.${P}-fibre {
  position: absolute; inset: 0; z-index: 6;
  border-radius: 14px 14px 0 0;
  background-image: ${grain()};
  opacity: 0.085; mix-blend-mode: multiply; pointer-events: none;
}
.${P}-liner {
  position: absolute; top: 0; right: 0; left: 0; z-index: 2;
  height: calc(var(--fh) + 4px);
  border-radius: 14px 14px 0 0;
  background-image: linear-gradient(180deg, rgb(70 58 40 / 0.2), rgb(70 58 40 / 0.06) 44%, rgb(70 58 40 / 0) 100%);
  opacity: 0;
  transition: opacity 460ms ease-out 200ms;
  pointer-events: none;
}
.${P}-env[data-open='true'] .${P}-liner { opacity: 1; }

.${P}-scroll {
  position: relative; z-index: 3;
  flex: 1; min-height: 0; overflow-y: auto;
  padding: calc(var(--fh) + 42px) var(--gut) 22px;
}

.${P}-flap {
  position: absolute; top: 0; right: 0; left: 0; z-index: 4;
  height: var(--fh);
  transform-origin: top center;
  transition: transform 560ms var(--ease) 80ms;
  pointer-events: none;
}
.${P}-env[data-open='true'] .${P}-flap { transform: rotateX(-132deg); }
.${P}-flap-face {
  display: block; height: 100%;
  border-radius: 14px 14px 0 0;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  background-image: linear-gradient(176deg, #eaeae7 0%, #dfdfda 58%, #d1d1cb 100%);
  filter: drop-shadow(0 3px 6px rgb(31 35 72 / 0.22));
}
.${P}-env[data-open='true'] .${P}-flap-face { filter: drop-shadow(0 6px 12px rgb(10 12 30 / 0.4)) brightness(0.9); }

/* --- the foil seal --- */
.${P}-seal {
  position: absolute; top: calc(var(--fh) - 28px); left: 50%; z-index: 7;
  transform: translateX(-50%);
  transition: transform 380ms var(--ease);
  pointer-events: none;
}
.${P}-env[data-open='true'] .${P}-seal { transform: translateX(-50%) scale(0.86); }
.${P}-wax { position: relative; display: block; width: 56px; height: 56px; transform: rotate(-7deg); }
.${P}-wax-h {
  position: absolute; inset: 0;
  border-radius: 47% 53% 52% 48% / 51% 49% 51% 49%;
  background-image:
    radial-gradient(ellipse 70% 60% at 38% 30%, rgb(255 249 219 / 0.5) 0%, rgb(255 249 219 / 0) 62%),
    radial-gradient(circle at 50% 44%, #e8b422 0%, #d9a412 58%, #ab7f08 100%);
  box-shadow:
    inset 0 1px 1px rgb(255 244 205 / 0.5),
    inset 0 -2px 4px rgb(96 62 2 / 0.45),
    0 1px 2px rgb(31 35 72 / 0.3),
    0 5px 10px -5px rgb(31 35 72 / 0.5);
  transition: transform 420ms var(--ease), opacity 320ms ease-out;
}
.${P}-l { clip-path: inset(0 49.6% 0 0); }
.${P}-r { clip-path: inset(0 0 0 49.6%); }
.${P}-env[data-open='true'] .${P}-l { transform: translateX(-0.6rem) rotate(-13deg); opacity: 0; }
.${P}-env[data-open='true'] .${P}-r { transform: translateX(0.6rem) rotate(13deg); opacity: 0; }
.${P}-wax-mark {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 20px; font-weight: 700;
  color: rgb(31 35 72 / 0.75);
  text-shadow: 0 1px 0 rgb(255 244 205 / 0.4);
  transition: opacity 220ms ease-out;
}
.${P}-env[data-open='true'] .${P}-wax-mark { opacity: 0; }

/* One specular pass across the disc, once, on arrival. It is decoration over an
   already-visible object, never a gate on content. */
.${P}-foil {
  position: absolute; inset: 0;
  border-radius: 47% 53% 52% 48% / 51% 49% 51% 49%;
  overflow: hidden;
  background-image: linear-gradient(102deg, rgb(255 250 224 / 0) 40%, rgb(255 250 224 / 0.7) 50%, rgb(255 250 224 / 0) 60%);
  background-size: 260% 100%;
  background-position: 130% 0;
  animation: ${P}-sweep 1600ms var(--ease) 700ms 1 both;
  mix-blend-mode: screen;
}
@keyframes ${P}-sweep { to { background-position: -130% 0; } }

/* --- printed content --- */
.${P}-from { margin: 0; font-size: 16px; line-height: 1.5; text-align: center; color: rgb(31 35 72 / 0.75); }
.${P}-from b { font-weight: 650; color: rgb(31 35 72 / 0.92); }
.${P}-chip {
  display: inline-block; margin-left: 8px; padding: 4px 10px; vertical-align: 1px;
  min-height: 28px;
  border: 1px solid rgb(31 35 72 / 0.22); border-radius: 999px;
  background: none; font: inherit; font-size: 13px;
  color: rgb(31 35 72 / 0.66); white-space: nowrap; cursor: pointer;
}
.${P}-msg {
  margin: 18px 0 0; padding-left: 15px;
  border-left: 1px solid var(--gold);
  font-size: 20px; line-height: 1.45; letter-spacing: -0.01em;
  color: rgb(31 35 72 / 0.88); text-wrap: pretty;
}
.${P}-amount { margin-top: 28px; text-align: center; }
.${P}-amount h1 {
  margin: 0; font-size: 61px; font-weight: 600;
  line-height: 0.95; letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.${P}-amount h1 span {
  margin-left: 10px; font-size: 0.32em; font-weight: 600;
  letter-spacing: 0.14em; color: rgb(31 35 72 / 0.66);
}
.${P}-keyline {
  display: block; width: 52px; height: 2px; margin: 14px auto 0;
  border-radius: 999px; background: var(--gold);
  animation: ${P}-key 420ms var(--ease) 1 both;
}
@keyframes ${P}-key { from { transform: scaleX(0.15); opacity: 0.4; } }
.${P}-clause { margin: 14px 0 0; font-size: 13px; line-height: 1.55; text-align: center; color: rgb(31 35 72 / 0.66); }
.${P}-facts {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 9px;
  margin: 16px 0 0; font-size: 13px; color: rgb(31 35 72 / 0.66);
  font-variant-numeric: tabular-nums;
}
.${P}-facts i { color: rgb(31 35 72 / 0.3); font-style: normal; }

.${P}-quiet {
  display: block; width: 100%; margin-top: 28px; padding: 15px 16px;
  border: 1px solid rgb(31 35 72 / 0.14); border-radius: 14px;
  background: none; font: inherit; text-align: left; cursor: pointer;
}
.${P}-quiet span { display: block; font-size: 16px; font-weight: 600; color: rgb(31 35 72 / 0.88); }
.${P}-quiet em { display: block; margin-top: 5px; font-size: 13px; font-style: normal; line-height: 1.5; color: rgb(31 35 72 / 0.66); }

.${P}-receipt { margin-top: 26px; border-top: 1px solid rgb(31 35 72 / 0.14); }
.${P}-row {
  display: flex; justify-content: space-between; gap: 14px;
  margin: 0; padding: 12px 0;
  border-bottom: 1px solid rgb(31 35 72 / 0.09);
  font-size: 13px;
}
.${P}-row span { color: rgb(31 35 72 / 0.66); }
.${P}-row b { font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }

/* --- the trivia card, tucked in the envelope's mouth --- */
.${P}-card {
  margin-top: 22px; padding: 16px 16px 15px;
  border-radius: 12px;
  background: #eceae4;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.8), 0 1px 2px rgb(31 35 72 / 0.12);
}
.${P}-card-tag { margin: 0; font-size: 13px; font-weight: 600; color: rgb(31 35 72 / 0.66); }
.${P}-card-q { margin: 7px 0 0; font-size: 20px; font-weight: 600; line-height: 1.32; letter-spacing: -0.01em; text-wrap: balance; }
.${P}-card-opts { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.${P}-opt {
  min-height: 48px; padding: 12px 14px;
  border: 1px solid rgb(31 35 72 / 0.18); border-radius: 11px;
  background: var(--stock); font: inherit; font-size: 16px; text-align: left;
  color: var(--ink); cursor: pointer;
  transition: border-color 180ms ease-out, background-color 180ms ease-out;
}
.${P}-opt[aria-pressed='true'] { border-color: var(--gold-deep); background: rgb(233 178 19 / 0.16); font-weight: 600; }

/* --- the dock: an opaque printed band --- */
.${P}-dock {
  position: relative; z-index: 4; flex: 0 0 auto;
  padding: 14px var(--gut) 18px;
  border-top: 1px solid rgb(31 35 72 / 0.1);
  background: #eceae4;
}
.${P}-dockhelp { margin: 10px 0 0; font-size: 13px; line-height: 1.5; text-align: center; color: rgb(31 35 72 / 0.68); }

.${P}-primary {
  display: block; width: 100%; min-height: 52px; padding: 14px 20px;
  border: 0; border-radius: 14px;
  background: var(--ink); color: var(--stock);
  font: inherit; font-size: 17px; font-weight: 650; cursor: pointer;
  transition: opacity 160ms ease-out;
}
.${P}-primary:disabled { opacity: 0.4; cursor: default; }
.${P}-primary:not(:disabled):active { opacity: 0.86; }
.${P}-secondary {
  display: block; width: 100%; min-height: 52px; padding: 14px 20px;
  border: 1px solid rgb(31 35 72 / 0.26); border-radius: 14px;
  background: none; font: inherit; font-size: 17px; font-weight: 600;
  color: var(--ink); cursor: pointer;
}
.${P}-ghost {
  min-height: 48px; padding: 12px 20px;
  border: 1px solid rgb(242 242 241 / 0.3); border-radius: 14px;
  background: none; font: inherit; font-size: 16px; font-weight: 600;
  color: var(--stock); cursor: pointer;
  transition: border-color 160ms ease-out;
}
.${P}-ghost:hover { border-color: rgb(242 242 241 / 0.6); }
:where(.${P}-root, .${P}-land) :where(button):focus-visible {
  outline: 2px solid var(--gold); outline-offset: 2px;
}

/* --- desktop: two panes, not a wider column --- */
@container (min-width: 760px) {
  .${P}-stage { justify-content: center; align-items: stretch; }
  .${P}-room {
    display: flex; flex-direction: column;
    position: relative; z-index: 2;
    flex: 0 1 560px; min-width: 0;
    padding: 44px 48px 44px;
  }
  .${P}-objectwrap { flex: 0 0 auto; align-items: center; padding: 40px 48px; }
  /**
   * On a phone the sheet runs off the bottom of the screen, because a phone IS
   * the envelope. On a desktop there is a room around it, so the envelope has
   * to become a finished object: a fixed height, four rounded corners, a
   * bottom edge, and a shadow it casts onto the field. A sheet that bleeds off
   * a 1280px stage reads as a broken mobile layout, which is the exact defect
   * this direction is here to fix.
   */
  .${P}-env {
    flex: 0 0 auto; width: 430px; margin: 0;
    --fh: 118px; --gut: 26px;
  }
  .${P}-paper { flex: 0 0 auto; border-radius: 14px; }
  .${P}-scroll { flex: 0 0 auto; overflow: visible; padding-top: calc(var(--fh) + 56px); padding-bottom: 26px; }
  .${P}-dock { border-radius: 0 0 14px 14px; }
  /* The room carries the sponsor, the message and the custody card, so the
     sheet must not repeat any of them. */
  .${P}-onpaper, .${P}-quiet { display: none; }
  .${P}-amount { margin-top: 8px; }
  .${P}-amount h1 { font-size: 76px; }
}

/* --- landing --- */
.${P}-land {
  position: relative; overflow: hidden; min-height: 100%;
  padding: 20px clamp(20px, 5vw, 56px) 48px;
  background-color: #1f2348;
  background-image: radial-gradient(115% 115% at bottom right, #260133 0%, #1f2348 56%, #14172f 100%);
  color: var(--stock);
  font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
/* Two slow lights, moved with transforms only, so nothing is re-rasterised per
   frame. This is the whole "animated and colourful" budget for this direction. */
.${P}-lamp {
  position: absolute; z-index: 0;
  width: 60vmax; height: 60vmax; border-radius: 50%;
  filter: blur(48px); opacity: 0.36; pointer-events: none;
}
.${P}-lamp1 {
  top: -26vmax; left: -16vmax;
  background: radial-gradient(closest-side, rgba(5, 130, 202, 0.55), rgba(5, 130, 202, 0) 70%);
  animation: ${P}-drift1 38s ease-in-out infinite alternate;
}
.${P}-lamp2 {
  right: -20vmax; bottom: -28vmax;
  background: radial-gradient(closest-side, rgba(233, 178, 19, 0.45), rgba(233, 178, 19, 0) 70%);
  animation: ${P}-drift2 46s ease-in-out infinite alternate;
}
@keyframes ${P}-drift1 { to { transform: translate3d(13vmax, 8vmax, 0) scale(1.1); } }
@keyframes ${P}-drift2 { to { transform: translate3d(-11vmax, -7vmax, 0) scale(1.07); } }

.${P}-landbar { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.${P}-landgrid {
  position: relative; z-index: 2;
  display: grid; gap: 44px; align-items: center;
  margin-top: clamp(32px, 7vh, 76px);
}
.${P}-h1 {
  margin: 0; font-size: clamp(39px, 6vw, 76px); font-weight: 640;
  line-height: 1.02; letter-spacing: -0.032em; text-wrap: balance; max-width: 15ch;
}
.${P}-sub { margin: 22px 0 0; max-width: 52ch; font-size: 20px; line-height: 1.5; color: rgb(242 242 241 / 0.74); text-wrap: pretty; }
.${P}-cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.${P}-cta > * { width: auto; min-width: 176px; }
.${P}-fine { margin: 22px 0 0; max-width: 54ch; font-size: 13px; color: rgb(242 242 241 / 0.66); }

.${P}-hero { display: flex; justify-content: center; }
.${P}-heroenv {
  position: relative;
  width: min(330px, 80%); aspect-ratio: 5 / 6;
  border-radius: 16px;
  background-color: var(--stock);
  background-image: radial-gradient(120% 60% at 50% -10%, rgb(255 233 186 / 0.5), rgb(255 233 186 / 0) 62%);
  transform: rotate(-4deg);
  filter: drop-shadow(0 24px 38px rgb(6 4 20 / 0.6));
}
.${P}-heroflap {
  position: absolute; top: 0; right: 0; left: 0; height: 44%;
  border-radius: 16px 16px 0 0;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  background-image: linear-gradient(176deg, #eaeae7, #d4d4ce);
}
.${P}-herowax {
  position: absolute; top: 38%; left: 50%; width: 52px; height: 52px;
  transform: translateX(-50%) rotate(-7deg);
  border-radius: 47% 53% 52% 48% / 51% 49% 51% 49%;
  background-image: radial-gradient(circle at 50% 44%, #e8b422, #d9a412 58%, #ab7f08);
  box-shadow: inset 0 -2px 4px rgb(96 62 2 / 0.45), 0 4px 9px -4px rgb(31 35 72 / 0.5);
}
.${P}-heroamt {
  position: absolute; right: 0; bottom: 21%; left: 0;
  text-align: center; color: var(--ink);
  font-size: 49px; font-weight: 620; letter-spacing: -0.035em; font-variant-numeric: tabular-nums;
}
.${P}-heroamt i { margin-left: 8px; font-size: 0.3em; font-style: normal; font-weight: 600; letter-spacing: 0.14em; color: rgb(31 35 72 / 0.66); }
.${P}-herofoot {
  position: absolute; right: 0; bottom: 11%; left: 0;
  text-align: center; font-size: 13px; color: rgb(31 35 72 / 0.66);
  font-variant-numeric: tabular-nums;
}

@media (min-width: 900px) {
  .${P}-landgrid { grid-template-columns: 1.15fr 0.85fr; gap: 56px; }
}

/* Reduced motion: every stage lands on its finished frame, delays included. The
   two landing lamps hold the position they were composed at rather than
   vanishing, so the field keeps its colour. */
@media (prefers-reduced-motion: reduce) {
  .${P}-root *, .${P}-root *::before, .${P}-root *::after,
  .${P}-land *, .${P}-land *::before, .${P}-land *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
  .${P}-foil { opacity: 0; }
  .${P}-lamp1 { transform: translate3d(6vmax, 4vmax, 0); }
  .${P}-lamp2 { transform: translate3d(-5vmax, -3vmax, 0); }
}
`
}
