import { useState } from 'react'
import Board, { Panel, Pair } from './Board'
import { DROP, grain, TRIVIA } from './fixtures'

/**
 * DEV-ONLY MOCKUP — Direction B, "Ticket".
 *
 * Thesis: a drop is not a surprise, it is an entitlement, so hand people a
 * numbered claim ticket instead of a sealed envelope.
 *
 * Why this is the real alternative, not a restyle
 * -----------------------------------------------
 * The envelope's whole payload is CONCEALMENT, and NimDrops has deliberately
 * removed concealment. The amount is printed at 61px before you touch anything,
 * the split is fixed, and the existing study argues at length that hiding the
 * number is the lottery mechanic whether or not the number is random. So the
 * product's signature object is currently a metaphor for the one thing the
 * product refuses to do.
 *
 * A ticket says what the product actually is: fixed face value printed on the
 * front, one per bearer, first come first served, numbered. And it already
 * solves the receipt problem in the object. The gate keeps half, you keep half.
 *
 * The colour strategy is Committed, close to Drenched: the body IS Nimiq gold
 * (`#E9B213`, the brand's own token), and the ticket is Nimiq blue card stock.
 * That is a deliberate escape from the warm-near-white body background that
 * currently sits under the whole product and that reads, in 2026, as the
 * default rather than a decision. It is also the discipline every credible
 * fintech palette in the research shares: one owned hue against hard neutrals,
 * no decorative blend. Wise runs #9FE870 on #163300; Ramp puts chartreuse only
 * where money moves; Mercury reserves cobalt for one CTA.
 *
 * There is no glass anywhere in this direction and that is a real trade, stated
 * plainly. If "glass buttons" is a hard requirement, B is the wrong pick. Its
 * answer to "this looks like unstyled HTML" is print: a genuine die-cut, a
 * perforation, grain, tabular figures at 61px, and one saturated ink.
 */

const P = 'b'

export default function DirectionB() {
  return (
    <Board
      letter="B"
      name="Ticket: an entitlement, not a surprise"
      thesis="Fixed face value printed on the front. The stub is your receipt."
    >
      <style>{css()}</style>

      <Panel label="Claim, unvalidated, 390" note="the judged surface">
        <Claim />
      </Panel>

      <Panel label="Claim, unvalidated, desktop" mode="wide" height={820} note="a spread: the drop's ledger, then the ticket at its real size">
        <Claim />
      </Panel>

      <Pair>
        <Panel label="Claim, validated, 390" note="stamped, stub torn, hash printed on the stub">
          <Claim validated />
        </Panel>
        <Panel label="Trivia slot, 390" note="the gate question is printed on the stub">
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

function Claim({ validated = false, trivia = false }: { validated?: boolean; trivia?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null)
  const letters = ['A', 'B', 'C']
  // Claiming takes one. A receipt beside an unchanged count is a lie.
  const taken = DROP.claimCount - DROP.remaining + (validated ? 1 : 0)
  const left = DROP.claimCount - taken

  return (
    <div className={`${P}-root`}>
      <div className={`${P}-desk`}>
        <span className={`${P}-grain`} aria-hidden="true" />

        <div className={`${P}-spread`}>
          {/* Desktop only. On a phone this is printed on the ticket. */}
          <aside className={`${P}-ledger`}>
            <p className={`${P}-mast`}>NimDrops</p>
            <h2 className={`${P}-ledger-h`}>
              <b>{DROP.sponsor}</b> sent you a NimDrop
            </h2>
            <p className={`${P}-ledger-msg`}>{DROP.message}</p>
            <dl className={`${P}-table`}>
              <Cell k="Face value" v={`${DROP.amount} ${DROP.unit}`} />
              <Cell k="Split" v="Fixed and equal" />
              <Cell k="Shares" v={`${DROP.claimCount} issued, ${DROP.remaining} unclaimed`} />
              <Cell k="Per wallet" v="One" />
              <Cell k="Unclaimed shares go back in" v={DROP.expiresIn} />
              <Cell k="Held by" v="NimDrops, not a smart contract" />
            </dl>
            <p className={`${P}-ledger-note`}>
              Every figure here is the server&rsquo;s, not a rounded one. Funding, payouts and
              refunds are ordinary Nimiq transactions: public, permanent, readable by anyone.
            </p>
          </aside>

          <div className={`${P}-hold`}>
            <div className={`${P}-ticket`} data-validated={validated ? 'true' : 'false'}>
              <div className={`${P}-body`}>
                <p className={`${P}-rail`}>
                  <span className={`${P}-railbrand`}>NimDrops</span>
                  <span className={`${P}-serial`}>
                    Share {validated ? taken : taken + 1} of {DROP.claimCount}
                  </span>
                </p>

                <div className={`${P}-onticket`}>
                  <p className={`${P}-from`}>
                    <b>{DROP.sponsor}</b> sent you a NimDrop
                    <button type="button" className={`${P}-chip`}>
                      name unverified
                    </button>
                  </p>
                  <p className={`${P}-msg`}>{DROP.message}</p>
                </div>

                <div className={`${P}-facerow`}>
                  <p className={`${P}-face`}>
                    {DROP.amount}
                    <i>{DROP.unit}</i>
                  </p>
                  {validated ? (
                    <span className={`${P}-stamp`} aria-hidden="true">
                      <b>Validated</b>
                      <i>Nimiq mainnet</i>
                    </span>
                  ) : null}
                </div>
                <p className={`${P}-clause`}>
                  Fixed and equal for everyone who claims. Nothing here is drawn or ranked.
                </p>

                {/* Five marks for five shares. Not a progress bar: a count you
                    can read before you tap, which is the exact thing the Pratt
                    critique says a WeChat group packet fails to give you. */}
                <div className={`${P}-meter`} aria-hidden="true">
                  {Array.from({ length: DROP.claimCount }).map((_, i) => (
                    <span key={i} data-taken={i < taken ? 'true' : 'false'} />
                  ))}
                </div>
                <p className={`${P}-metercap`}>
                  {left} of {DROP.claimCount} unclaimed, goes back in {DROP.expiresIn}
                </p>

              </div>

              <div className={`${P}-perf`} aria-hidden="true" />

              <div className={`${P}-stub`}>
                {trivia ? (
                  <>
                    <p className={`${P}-stub-tag`}>Answer this to validate the ticket</p>
                    <p className={`${P}-stub-q`}>{TRIVIA.question}</p>
                    <div className={`${P}-opts`}>
                      {TRIVIA.options.map((o, i) => (
                        <button
                          key={o}
                          type="button"
                          className={`${P}-opt`}
                          aria-pressed={picked === i}
                          onClick={() => setPicked(i)}
                        >
                          <span aria-hidden="true">{letters[i]}</span>
                          {o}
                        </button>
                      ))}
                    </div>
                  </>
                ) : validated ? (
                  <>
                    <p className={`${P}-stub-tag`}>Your stub</p>
                    <StubRow k="Paid to" v="NQ07 8E9J … 4K2M" />
                    <StubRow k="Transaction" v={`${DROP.txHash.slice(0, 12)}…${DROP.txHash.slice(-8)}`} />
                    <StubRow k="Confirmed" v="26 Jul 2026, 21:04 UTC" />
                  </>
                ) : (
                  <>
                    <p className={`${P}-stub-tag`}>Bearer terms</p>
                    <p className={`${P}-stub-body`}>
                      One share per wallet. NimDrops holds the NIM until you claim it, then sends it
                      to the wallet that signs and to no address you can type.
                    </p>
                    <button type="button" className={`${P}-stub-link`}>
                      Read who is holding this NIM
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className={`${P}-act`}>
              {validated ? (
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
                    Claim {DROP.amount} {DROP.unit}
                  </button>
                  <p className={`${P}-acthelp`}>
                    {trivia
                      ? 'Answer, then Nimiq Pay opens. One signature validates the ticket.'
                      : 'Nimiq Pay opens next. One signature validates the ticket, no amount to type, no fee to pay.'}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className={`${P}-cell`}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

function StubRow({ k, v }: { k: string; v: string }) {
  return (
    <p className={`${P}-stubrow`}>
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
      <header className={`${P}-landbar`}>
        <span className={`${P}-mast`}>NimDrops</span>
        <button type="button" className={`${P}-secondary ${P}-sm`}>
          Open a drop
        </button>
      </header>

      <div className={`${P}-landgrid`}>
        <div>
          <h1 className={`${P}-h1`}>Five tickets. One price. Whoever opens the link.</h1>
          <p className={`${P}-sub`}>
            Fund one drop and paste one link into the group chat. Every ticket carries the same face
            value on the front. Nothing is drawn, nothing is ranked, and nobody finds out they got
            the small one.
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

        <div className={`${P}-fan`} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`${P}-mini`} data-i={i} data-taken={i < 2 ? 'true' : 'false'}>
              <b>
                2<i>NIM</i>
              </b>
              <em>Share {i + 1} of 5</em>
            </span>
          ))}
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
  --gold: #e9b213;
  --card: #f4f2ee;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}

/* Drenched: the body IS the brand's gold. Flat, with grain, no blend. */
.${P}-desk {
  --stub: 138px;
  --notch: 11px;
  --tear: 8px;
  position: relative;
  height: 100%; overflow: hidden;
  background: var(--gold);
  color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.${P}-grain {
  position: absolute; inset: 0; z-index: 1;
  background-image: ${grain()};
  opacity: 0.07; mix-blend-mode: multiply; pointer-events: none;
}
.${P}-spread { position: relative; z-index: 2; display: flex; height: 100%; min-width: 0; }
.${P}-hold {
  display: flex; flex: 1; flex-direction: column; min-width: 0;
  overflow-y: auto;
  padding: 20px clamp(16px, 5cqw, 24px) 26px;
}
.${P}-mast { margin: 0; font-size: 13px; font-weight: 700; }

/* --- the ledger pane (desktop only) --- */
.${P}-ledger { display: none; }
.${P}-ledger-h { margin: 36px 0 0; font-size: 20px; font-weight: 400; line-height: 1.45; color: rgb(31 35 72 / 0.82); text-wrap: balance; }
.${P}-ledger-h b { font-weight: 650; color: var(--ink); }
.${P}-ledger-msg {
  margin: 18px 0 0; padding-left: 16px;
  border-left: 1px solid rgb(31 35 72 / 0.4);
  font-size: 25px; line-height: 1.38; letter-spacing: -0.014em; max-width: 22ch;
  text-wrap: pretty;
}
.${P}-table { margin: 32px 0 0; border-top: 1px solid rgb(31 35 72 / 0.28); }
.${P}-cell {
  display: flex; justify-content: space-between; gap: 20px;
  padding: 11px 0; border-bottom: 1px solid rgb(31 35 72 / 0.18);
}
.${P}-cell dt { margin: 0; font-size: 16px; color: rgb(31 35 72 / 0.78); }
.${P}-cell dd { margin: 0; font-size: 16px; font-weight: 650; text-align: right; font-variant-numeric: tabular-nums; }
.${P}-ledger-note { margin: 24px 0 0; max-width: 50ch; font-size: 13px; line-height: 1.6; color: rgb(31 35 72 / 0.78); }

/* --- the ticket --- */
.${P}-ticket {
  position: relative;
  width: 100%; max-width: 440px; margin: 0 auto;
  border-radius: 14px;
  background: var(--ink);
  color: var(--card);
  /* A real die-cut: two notches punched out of the card at the perforation,
     composited with the rounded corners rather than faked with two circles
     painted in the field colour. */
  -webkit-mask-image:
    radial-gradient(circle var(--notch) at 0 calc(100% - var(--stub)), transparent 98%, #000 100%),
    radial-gradient(circle var(--notch) at 100% calc(100% - var(--stub)), transparent 98%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    radial-gradient(circle var(--notch) at 0 calc(100% - var(--stub)), transparent 98%, #000 100%),
    radial-gradient(circle var(--notch) at 100% calc(100% - var(--stub)), transparent 98%, #000 100%);
  mask-composite: intersect;
  filter: drop-shadow(0 14px 24px rgb(83 58 4 / 0.42));
}
.${P}-body { position: relative; padding: 18px 22px 26px; }
.${P}-ticket { padding-bottom: var(--tear); }

/* The ticket's own header rail. This is document furniture on a printed
   object rather than the small tracked all-caps label above a section that the
   rules ban: it is a full-width rail carrying the issuer and the serial, it
   sits inside the object, and it appears exactly once. */
.${P}-rail {
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  margin: 0; padding-bottom: 12px;
  border-bottom: 1px solid rgb(244 242 238 / 0.18);
  font-size: 13px; font-weight: 600;
  color: rgb(244 242 238 / 0.58);
}
.${P}-serial { font-variant-numeric: tabular-nums; }

.${P}-onticket { margin-top: 20px; }
.${P}-from { margin: 0; font-size: 16px; line-height: 1.5; color: rgb(244 242 238 / 0.72); }
.${P}-from b { font-weight: 650; color: var(--card); }
.${P}-chip {
  display: inline-block; margin-left: 8px; padding: 4px 10px; vertical-align: 1px;
  min-height: 28px;
  border: 1px solid rgb(244 242 238 / 0.3); border-radius: 999px;
  background: none; font: inherit; font-size: 13px;
  color: rgb(244 242 238 / 0.72); white-space: nowrap; cursor: pointer;
}
.${P}-msg {
  margin: 14px 0 0; padding-left: 14px;
  border-left: 1px solid var(--gold);
  font-size: 20px; line-height: 1.45; letter-spacing: -0.01em;
  color: rgb(244 242 238 / 0.9); text-wrap: pretty;
}
.${P}-facerow { margin-top: 26px; }
.${P}-face {
  margin: 0; font-size: 61px; font-weight: 600;
  line-height: 0.92; letter-spacing: -0.038em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.${P}-face i {
  margin-left: 10px; font-size: 0.28em; font-style: normal; font-weight: 600;
  letter-spacing: 0.14em; color: rgb(244 242 238 / 0.72);
}
.${P}-clause { margin: 12px 0 0; font-size: 13px; line-height: 1.55; color: rgb(244 242 238 / 0.72); }

.${P}-meter { display: flex; gap: 6px; margin-top: 22px; }
.${P}-meter span { height: 6px; flex: 1; border-radius: 999px; background: var(--gold); }
.${P}-meter span[data-taken='true'] { background: rgb(244 242 238 / 0.24); }
.${P}-metercap { margin: 10px 0 0; font-size: 13px; color: rgb(244 242 238 / 0.72); font-variant-numeric: tabular-nums; }

.${P}-facerow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.${P}-facerow .${P}-face { margin-top: 0; }
.${P}-stamp {
  flex: 0 0 auto; display: block; padding: 7px 12px 6px;
  border: 2px solid var(--gold); border-radius: 4px;
  color: var(--gold); text-align: center;
  transform: rotate(-7deg);
  animation: ${P}-stamp 220ms var(--ease) 1 both;
}
.${P}-stamp b { display: block; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
.${P}-stamp i { display: block; margin-top: 1px; font-size: 10px; font-style: normal; letter-spacing: 0.08em; }
@keyframes ${P}-stamp { from { transform: rotate(-7deg) scale(1.14); opacity: 0.4; } }

/* The tear. A perforation is dashes plus the gap that opens between them. */
.${P}-perf {
  height: 0; margin: 0 calc(var(--notch) + 4px);
  border-top: 2px dashed rgb(244 242 238 / 0.3);
}
.${P}-stub {
  padding: 16px 22px 20px; min-height: var(--stub);
  transition: translate 260ms var(--ease);
}
.${P}-ticket[data-validated='true'] .${P}-stub { translate: 0 var(--tear); }
.${P}-stub-tag { margin: 0; font-size: 13px; font-weight: 600; color: rgb(244 242 238 / 0.72); }
.${P}-stub-body { margin: 9px 0 0; font-size: 13px; line-height: 1.6; color: rgb(244 242 238 / 0.72); }
.${P}-stub-link {
  margin-top: 12px; min-height: 44px; padding: 0;
  border: 0; background: none;
  font: inherit; font-size: 16px; font-weight: 600; color: var(--gold);
  text-decoration: underline; text-underline-offset: 4px; cursor: pointer;
}
.${P}-stubrow {
  display: flex; justify-content: space-between; gap: 14px;
  margin: 0; padding: 9px 0; border-bottom: 1px solid rgb(244 242 238 / 0.12);
  font-size: 13px;
}
.${P}-stubrow span { color: rgb(244 242 238 / 0.72); }
.${P}-stubrow b { font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }

.${P}-stub-q { margin: 8px 0 0; font-size: 20px; font-weight: 600; line-height: 1.32; letter-spacing: -0.01em; text-wrap: balance; }
.${P}-opts { display: flex; flex-direction: column; gap: 8px; margin-top: 13px; }
.${P}-opt {
  display: flex; align-items: center; gap: 12px;
  min-height: 48px; padding: 11px 13px;
  border: 1px solid rgb(244 242 238 / 0.26); border-radius: 9px;
  background: none; font: inherit; font-size: 16px; text-align: left;
  color: var(--card); cursor: pointer;
  transition: border-color 180ms ease-out, background-color 180ms ease-out;
}
.${P}-opt > span {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 24px; height: 24px; border-radius: 5px;
  background: rgb(244 242 238 / 0.16);
  font-size: 13px; font-weight: 700;
}
.${P}-opt[aria-pressed='true'] { border-color: var(--gold); background: rgb(233 178 19 / 0.16); }
.${P}-opt[aria-pressed='true'] > span { background: var(--gold); color: var(--ink); }

.${P}-act { width: 100%; max-width: 440px; margin: 20px auto 0; }
.${P}-acthelp { margin: 11px 0 0; font-size: 13px; line-height: 1.5; text-align: center; color: rgb(31 35 72 / 0.78); }
.${P}-primary {
  display: block; width: 100%; min-height: 52px; padding: 14px 20px;
  border: 0; border-radius: 12px;
  background: var(--ink); color: var(--card);
  font: inherit; font-size: 17px; font-weight: 650; cursor: pointer;
  transition: opacity 160ms ease-out;
}
.${P}-primary:disabled { opacity: 0.42; cursor: default; }
.${P}-primary:not(:disabled):active { opacity: 0.86; }
.${P}-secondary {
  display: block; width: 100%; min-height: 52px; padding: 14px 20px;
  border: 1px solid rgb(31 35 72 / 0.42); border-radius: 12px;
  background: none; font: inherit; font-size: 17px; font-weight: 600;
  color: var(--ink); cursor: pointer;
  transition: border-color 160ms ease-out;
}
.${P}-secondary:hover { border-color: var(--ink); }
.${P}-secondary.${P}-sm { width: auto; min-height: 44px; padding: 10px 16px; font-size: 16px; border-radius: 9px; }
:where(.${P}-root, .${P}-land) :where(button):focus-visible {
  outline: 2px solid var(--ink); outline-offset: 2px;
}

/* --- desktop: a spread, not a wider ticket --- */
@container (min-width: 800px) {
  .${P}-ledger {
    display: flex; flex-direction: column;
    flex: 1 1 0; min-width: 0; max-width: 640px;
    padding: 40px 48px;
    border-right: 1px solid rgb(31 35 72 / 0.22);
  }
  .${P}-hold { flex: 0 0 auto; justify-content: center; padding: 40px 48px; }
  .${P}-ticket { width: 440px; }
  .${P}-onticket, .${P}-railbrand { display: none; }
  .${P}-rail { justify-content: flex-end; }
  .${P}-facerow { margin-top: 20px; }
  .${P}-face { font-size: 76px; }
}

/* --- landing: the same drench, so the brand is one decision --- */
.${P}-land {
  position: relative; overflow: hidden; min-height: 100%;
  padding: 20px clamp(20px, 5vw, 56px) 48px;
  background: var(--gold);
  color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.${P}-landbar { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.${P}-landgrid {
  position: relative; z-index: 2;
  display: grid; gap: 40px; align-items: center;
  margin-top: clamp(28px, 6vh, 68px);
}
.${P}-h1 {
  margin: 0; font-size: clamp(39px, 6.2vw, 76px); font-weight: 680;
  line-height: 1; letter-spacing: -0.038em; text-wrap: balance; max-width: 13ch;
}
.${P}-sub { margin: 24px 0 0; max-width: 52ch; font-size: 20px; line-height: 1.5; color: rgb(31 35 72 / 0.82); text-wrap: pretty; }
.${P}-cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.${P}-cta > * { width: auto; min-width: 176px; }
.${P}-fine { margin: 22px 0 0; max-width: 54ch; font-size: 13px; color: rgb(31 35 72 / 0.78); }

/* The product's core fact rendered as the image: five identical tickets, two
   already spent. Entrance moves them only; nothing here is invisible by
   default, so a headless render or a background tab still ships the picture. */
.${P}-fan { position: relative; height: 320px; }
.${P}-mini {
  position: absolute; top: 50%; left: 50%;
  display: flex; flex-direction: column; justify-content: center; gap: 5px;
  width: 142px; height: 200px; padding: 15px;
  border-radius: 11px; background: var(--ink); color: var(--card);
  filter: drop-shadow(0 12px 20px rgb(80 55 4 / 0.42));
  animation: ${P}-deal 420ms var(--ease) both;
}
.${P}-mini[data-i='0'] { transform: translate(-50%, -50%) rotate(-16deg) translateX(-208px); animation-delay: 0ms; }
.${P}-mini[data-i='1'] { transform: translate(-50%, -50%) rotate(-8deg) translateX(-104px); animation-delay: 40ms; }
.${P}-mini[data-i='2'] { transform: translate(-50%, -50%); animation-delay: 80ms; }
.${P}-mini[data-i='3'] { transform: translate(-50%, -50%) rotate(8deg) translateX(104px); animation-delay: 120ms; }
.${P}-mini[data-i='4'] { transform: translate(-50%, -50%) rotate(16deg) translateX(208px); animation-delay: 160ms; }
.${P}-mini[data-taken='true'] { opacity: 0.46; }
.${P}-mini b { font-size: 27px; font-weight: 620; letter-spacing: -0.035em; font-variant-numeric: tabular-nums; }
.${P}-mini b i { margin-left: 6px; font-size: 0.3em; font-style: normal; letter-spacing: 0.14em; color: rgb(244 242 238 / 0.72); }
.${P}-mini em { font-size: 13px; font-style: normal; font-weight: 600; color: rgb(244 242 238 / 0.72); font-variant-numeric: tabular-nums; }
@keyframes ${P}-deal { from { translate: 0 14px; } }

@media (min-width: 900px) {
  .${P}-landgrid { grid-template-columns: 1.05fr 0.95fr; gap: 56px; }
}

/* Reduced motion: the stamp is simply already on the ticket, the stub already
   torn, the five landing tickets already dealt. A finished frame. */
@media (prefers-reduced-motion: reduce) {
  .${P}-root *, .${P}-root *::before, .${P}-root *::after,
  .${P}-land *, .${P}-land *::before, .${P}-land *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
}
`
}
