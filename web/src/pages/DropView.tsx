import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ClaimServerState, DropPublic } from '../api'
import { expiryWindowAdjective, expiryWindowLabel } from '../money'
import { nimiqPayDeeplink } from '../sdk/adapter'
import { CLAIM_STORAGE_PREFIX, type ClaimUiState } from '../state/claim'
import Field from '../ui/Field'
import GlassSheet from '../ui/GlassSheet'
import {
  ClockExpiryIcon,
  CopyIcon,
  CustodyShieldIcon,
  InfoIcon,
  ShareIcon,
  WarningIcon,
  type IconComponent,
} from '../ui/icons'
import { Amount, Pips } from '../ui/Nim'
import { GetNimiqPay } from '../ui/OpenInApp'
import SealedEnvelope from '../ui/SealedEnvelope'
import Sheet from '../ui/Sheet'
import StatusPill from '../ui/StatusPill'
import Receipt from './Receipt'

/**
 * Everything the drop page looks like, with none of what it knows.
 *
 * `Drop` owns the claim machine; this owns the surface. Splitting them is what
 * lets `/preview` render all thirteen states at once from fixtures.
 *
 * ## The composition — s4 "Stack"
 *
 * The screen is two zones rather than one column. An open upper field carries
 * the money bare and oversized, pushed left past the gutter, with a vertical
 * rail of 44px circular buttons down its right edge and two fact tiles under
 * it. A sheet rises over the foot of that field carrying the transaction: who
 * sent this, their words, one caption, one action, and the custody disclosure.
 * At 54rem of the field's own width the same two zones become a poster: the
 * money large on the left, the sheet a column on the right.
 *
 * The upper field is invariant across all thirteen states and only the sheet's
 * contents change, which is what makes a new state a new sheet body and nothing
 * else.
 *
 * ## The sealed gate, in front of all of it
 *
 * A claimant does not land here. They land on a full-screen sealed envelope
 * with NO AMOUNT ON IT, hold it for two and a half seconds, and the screen
 * below is what the burst reveals. `ui/SealedEnvelope.tsx` has the ordering
 * argument; the derivation of "already opened" is `gateOpened` below, and it is
 * the part that has to be right or the burst re-fires on every poll tick.
 *
 * ## Three rules this file exists to keep
 *
 * **The money never depends on the visual layer.** Nothing in the claim surface
 * starts hidden. There is no reveal that content waits behind, no `opacity: 0`
 * that a class has to clear, and the one animation that exists — the sheet's
 * 30px dip — moves a surface that is already fully painted. With CSS animation
 * switched off entirely, every one of the thirteen states renders complete.
 * `DropView.test.tsx` proves it against all thirteen.
 *
 * **Revealed is a state, not the end of a keyframe.** A reload, a resumed claim
 * or a status poll tick lands on the opened surface with no theatre and no
 * re-fire.
 *
 * **The amount is never hidden once the envelope is open.** Someone deciding
 * whether to open a wallet has to see what they are being offered, before they
 * are asked for anything. Concealing the number until after the signature is
 * what a scam does; concealing it behind a gesture that costs nothing is a
 * ritual, and it ends before the signature is requested.
 */

/** The claim is in flight or settled: the field keeps the warmer cast. */
const OPENED: readonly ClaimUiState[] = ['reserved', 'confirming', 'paid']

/** Dead ends: no amount to offer, no action to take, no warmth. */
const OUTCOMES: readonly ClaimUiState[] = ['paused', 'expired', 'exhausted', 'rejected']

/**
 * Whether the envelope is already open, for a reason that is not the ritual.
 *
 * THE landmine of this whole feature, so it is a pure function with a test of
 * its own. Get it wrong in one direction and a claimant who reloads a settled
 * claim is asked to hold an envelope over their own receipt; get it wrong in
 * the other and the burst re-fires every 2.5 seconds as the status poll ticks.
 *
 * Three things mark a claim as past the envelope, and all three are read from
 * state that already existed before this feature:
 *
 *   1. **A stored claim token.** `useClaim` writes `nimdrops.claim:<publicId>`
 *      to `localStorage` the instant the server reserves a slot, and reads it
 *      back on boot to resume polling. It is THE marker of "this browser
 *      already holds a share", it is available synchronously in the first
 *      render, and it is the only one of the three that is true during the
 *      `loading` frame before the first status poll answers. Without it a
 *      resumed claim would show a sealed envelope for one round trip and then
 *      flip — which is exactly the transition the burst hangs off.
 *   2. **An in-flight or settled claim state.** `reserved`, `confirming`,
 *      `paid`.
 *   3. **A dead end.** `paused`, `expired`, `exhausted`, `rejected` have no
 *      amount to conceal and nothing to celebrate, and putting bad news behind
 *      a ritual is the cruellest thing this surface could do. They open the
 *      gate flat.
 *
 * `no-wallet` is deliberately absent: that device cannot sign, so the envelope
 * is a finished state there and never opens at all.
 *
 * The value may go from false to true at any moment — a drop projection landing
 * late and saying `expired` is the ordinary case — so `SealedEnvelope` treats
 * it as a state and fires the theatre only for the claimant's own thumb.
 */
export function gateOpened(state: ClaimUiState, resumed: boolean): boolean {
  if (state === 'no-wallet') return false
  return resumed || OPENED.includes(state) || OUTCOMES.includes(state)
}

/**
 * Is there a claim in this browser for this drop already?
 *
 * Reads the key `state/claim.ts` owns, rather than a second source of truth.
 * Storage can be denied outright (private mode, a locked-down WebView), and the
 * honest answer to that is "no resumed claim" — the surface then shows a sealed
 * envelope, which is one hold away from the same screen.
 */
export function hasResumableClaim(publicId: string): boolean {
  try {
    return localStorage.getItem(`${CLAIM_STORAGE_PREFIX}${publicId}`) !== null
  } catch {
    return false
  }
}

export interface DropViewProps {
  publicId: string
  state: ClaimUiState
  drop: DropPublic | null
  serverState: ClaimServerState | null
  txHash: string | null
  amountEach: string | null
  notice: string
  onClaim: () => void
  onRetry: () => void
  /**
   * Force the gate open, bypassing `gateOpened`.
   *
   * A dev and test seam, and the only prop on this component production does
   * not pass: `Drop.tsx` leaves it undefined, so the shipped screen derives the
   * gate and nothing else can. `/preview` sets it so all thirteen states can be
   * looked at without holding an envelope nineteen times, and the tests set it
   * to hold the claim surface to rule 1 on every state.
   */
  revealed?: boolean
}

export default function DropView({
  publicId,
  state,
  drop,
  serverState,
  txHash,
  amountEach,
  notice,
  onClaim,
  onRetry,
  revealed,
}: DropViewProps) {
  const sponsor = drop?.sponsorLabel ?? ''
  const amount = amountEach ?? ''
  const outcome = OUTCOMES.includes(state)
  const opened = OPENED.includes(state)

  /**
   * Read once, on mount. `localStorage` cannot change under this component
   * without the claim machine also moving state, and re-reading it on every
   * render of a screen that repaints on a 2.5s poll is work for nothing.
   */
  const [resumed] = useState(() => hasResumableClaim(publicId))

  /**
   * `sealed-only` versus `can-open` is decided by the wallet bridge and never
   * by a viewport width: a narrow desktop window is still a desktop, and a
   * phone browser outside Nimiq Pay also cannot sign. `useClaim` has already
   * asked the adapter and folded `kind === 'unavailable'` into `no-wallet`, so
   * this reads that one state rather than probing the SDK a second time.
   */
  const ability = state === 'no-wallet' ? 'sealed-only' : 'can-open'
  const here = typeof window === 'undefined' ? '' : window.location.href

  return (
    <Field tone={outcome ? 'quiet' : opened ? 'warm' : 'live'}>
      <SealedEnvelope
        ability={ability}
        opened={revealed ?? gateOpened(state, resumed)}
        {...(sponsor ? { sponsor } : {})}
        message={drop?.message ?? null}
        publicId={publicId}
        deepLink={nimiqPayDeeplink(here)}
      >
        <Upper state={state} drop={drop} amount={amount} outcome={outcome} />
        <GlassSheet
          testId="claim-sheet"
          dip={opened}
          header={<Sender state={state} drop={drop} sponsor={sponsor} />}
          caption={<Caption state={state} amount={amount} />}
        >
          {outcome ? (
            <Outcome
              state={state}
              amount={amount}
              notice={notice}
              onRetry={onRetry}
              expiryHours={drop?.expiryHours}
            />
          ) : (
            <Face
              publicId={publicId}
              state={state}
              drop={drop}
              serverState={serverState}
              txHash={txHash}
              amount={amount}
              sponsor={sponsor}
              onClaim={onClaim}
            />
          )}
          {state === 'awaiting-funding' ? null : (
            <CustodyDisclosure expiryHours={drop?.expiryHours} />
          )}
        </GlassSheet>
      </SealedEnvelope>
      {/*
        The third way out, for the visitor who has neither the wallet open nor a
        phone that has it. The sealed gate offers the deep link and the QR and
        stops there; a `nimiqpay://` scheme with no handler does NOTHING — no
        error, no navigation, nothing to catch — so without this block the
        stranger who has never installed Nimiq Pay presses a button, sees the
        page not move, and is finished with the product.

        A sibling rather than a slot: `SealedEnvelope` takes no children on this
        path and is owned elsewhere. It is rendered on exactly the state that
        needs it, and `ability` is the adapter's answer, never a viewport width.
      */}
      {ability === 'sealed-only' ? (
        <div className="nd-gate-getapp">
          <GetNimiqPay />
        </div>
      ) : null}
    </Field>
  )
}

// ---- the open upper field ------------------------------------------------------------

/**
 * The money, bare and oversized, plus the rail and the two fact tiles.
 *
 * Invariant across every state that has an offer, which is what makes the sheet
 * the only thing a new state has to think about. The four dead ends put the
 * outcome's mark and heading here instead: there is no amount to print, and a
 * heading in the open field is a stronger statement of "this is over" than the
 * same words in a sheet.
 */
function Upper({
  state,
  drop,
  amount,
  outcome,
}: {
  state: ClaimUiState
  drop: DropPublic | null
  amount: string
  outcome: boolean
}) {
  const paid = state === 'paid'
  const inFlight = state === 'reserved' || state === 'confirming'
  const booting = state === 'loading' && !drop

  return (
    <div className="nd-upper">
      {outcome ? (
        <div className="nd-headline">
          <OutcomeMark state={state} />
          <h1>{OUTCOME_TITLES[state]}</h1>
        </div>
      ) : booting ? (
        <div className="nd-headline">
          <div className="nd-pulse" aria-hidden="true" />
          <h1>Opening this NimDrop…</h1>
        </div>
      ) : (
        <div className="nd-money">
          {/**
           * The size steps down by character count rather than by media query,
           * because what overflows a 320px phone is `10000.00000`, not a narrow
           * screen. If a step-down still does not fit, `.nd-amount`'s
           * `flex-wrap` drops the unit onto its own line. The number itself
           * never wraps and is never truncated.
           *
           * `tone="ink"` and not gold. Nimiq gold is 2.74:1 on the field's
           * brightest pixel — under even the 3:1 non-text floor — and this
           * amount sits on the bare field rather than in a dark well. The mark
           * is near-white here and gold survives in exactly one place on this
           * screen, the custody shield, which sits on the card.
           *
           * The mark is also SMALLER than the s4 sample's 0.68. Gold at that
           * size reads as a currency mark because it is a different colour; the
           * same shape in the same near-white as the figure reads as a second
           * digit, which is not a thing to do to an amount. At 0.46 of the cap
           * height it is unmistakably a glyph beside the number rather than
           * part of it, and the word `NIM` carries the unit either way.
           */}
          <Amount
            value={amount}
            markScale={0.46}
            tone="ink"
            className="nd-amount"
            data-size={amount.length <= 6 ? 'lg' : amount.length <= 9 ? 'md' : 'sm'}
          />
          <p className="nd-moneycap">
            {paid
              ? 'sent to the wallet that signed'
              : inFlight
                ? 'reserved for the wallet that signed'
                : 'each, fixed and equal'}
          </p>
          {/* The one celebratory mark, and it is earned only after the backend
              has said `paid`. */}
          {paid ? <div data-testid="paid-keyline" className="nd-keyline" /> : null}
        </div>
      )}

      {/* One diameter, one hairline, every secondary affordance on the field.
          The custody control is deliberately NOT here: it belongs on the card,
          where its gold shield is 5.47:1 rather than 2.74:1. */}
      <nav className="nd-rail" aria-label="Drop actions">
        <ShareButton />
        <CopyLinkButton />
      </nav>

      {drop && !outcome ? <Tiles drop={drop} /> : null}
    </div>
  )
}

/**
 * The drop's live state, as two tiles in the open field.
 *
 * They are a RECESS and not a second pane of glass: exactly one element in the
 * tree is ever blurred, and it is the sheet. Subtracting light also buys the
 * headroom their muted labels need, which the bare field cannot give at any
 * alpha short of solid.
 *
 * The marks cap at twelve. A hundred-share drop is a legitimate configuration
 * and a hundred marks is a texture, not a count; the words above them carry the
 * exact figure either way.
 */
function Tiles({ drop }: { drop: DropPublic }) {
  return (
    <div className="nd-tiles">
      <div className="nd-tile">
        <p>Shares left</p>
        <b className="nd-num" data-testid="remaining">
          {drop.remaining} of {drop.claimCount}
        </b>
        <Pips total={drop.claimCount} left={drop.remaining} />
      </div>
      {drop.expiresAt ? (
        <div className="nd-tile">
          <p>Closes in</p>
          <Countdown expiresAt={drop.expiresAt} />
          <span className="nd-affordance" aria-hidden="true">
            <ClockExpiryIcon size={13} />
          </span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Wall-clock countdown from the server's `expiresAt`. Deliberately not block
 * heights: a claimant does not think in macro blocks, and the server's expiry
 * timestamp is the only deadline that decides anything.
 *
 * Tabular figures and full-strength ink, because a countdown is a money fact
 * and is held to AA regardless of size.
 */
function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [expiresAt])

  const remainingMs = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(remainingMs)) return null

  return (
    <b className="nd-num" data-testid="countdown">
      {remainingMs <= 0 ? 'Expired' : humanize(remainingMs)}
    </b>
  )
}

/**
 * The remaining window, in the coarsest unit that still says something.
 *
 * Days appear once there are two of them, and they appear because the claim
 * window is the sponsor's choice now: a fortnight-long drop read `335h 12m`
 * before this, which is a number nobody converts and which pushed the countdown
 * past the width its tabular figures are laid out for. Below two days the
 * hour-and-minute form is kept exactly as it was, because that is the range in
 * which a claimant is actually deciding whether to hurry.
 */
function humanize(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours >= 1) return `${hours}h ${minutes % 60}m`
  if (minutes >= 1) return `${minutes}m`
  return 'under a minute'
}

// ---- the sheet's header and caption ---------------------------------------------------

/**
 * Who sent this and what they said, at the top of the sheet.
 *
 * This is `GlassSheet`'s `header` slot, which is what puts the caption — the
 * slot a gated drop's question takes — directly underneath it. Neither line
 * survives into the paid state: by then the receipt below is the artefact, and
 * the sponsor is named on it.
 */
function Sender({
  state,
  drop,
  sponsor,
}: {
  state: ClaimUiState
  drop: DropPublic | null
  sponsor: string
}) {
  if (state === 'paid' || OUTCOMES.includes(state) || !sponsor) return null
  return (
    <>
      <p className="nd-from">
        {/* Claimant-facing, sponsor-supplied text, and labelled as such. */}
        <span className="line-clamp-3 [overflow-wrap:anywhere]">
          <b>{sponsor}</b> sent you a NimDrop
        </span>
        <span className="nd-chip">name unverified</span>
      </p>
      {drop?.message ? <p className="nd-message">{drop.message}</p> : null}
    </>
  )
}

/**
 * One caption slot, one sentence per state. Nothing stacks up here, and this is
 * the slot the trivia gate takes: see the contract on `GlassSheet`.
 *
 * It is not a restatement of the line under the amount. That one LABELS the
 * figure — "each, fixed and equal", three words attached to a number. This one
 * states the RULE the transaction runs under, in the sheet where the rest of
 * the transaction is, and it is the sentence a gated drop replaces with its
 * question.
 */
function Caption({ state, amount }: { state: ClaimUiState; amount: string }) {
  if (state === 'paid') return null
  if (state === 'reserved' || state === 'confirming')
    return <p className="nd-note">{amount} NIM is on its way.</p>
  if (OUTCOMES.includes(state)) return null
  if (state === 'loading' || state === 'awaiting-funding') return null
  return <p className="nd-note">A fixed share of NIM, the same for everyone who opens this link.</p>
}

// ---- the sheet's face ---------------------------------------------------------------

interface FaceProps {
  publicId: string
  state: ClaimUiState
  drop: DropPublic | null
  serverState: ClaimServerState | null
  txHash: string | null
  amount: string
  sponsor: string
  onClaim: () => void
}

function Face({ publicId, state, drop, serverState, txHash, amount, sponsor, onClaim }: FaceProps) {
  const paid = state === 'paid'
  const inFlight = state === 'reserved' || state === 'confirming'
  const review = inFlight && serverState === 'manual_review'

  /**
   * Two different pre-funding facts, told apart here because only one of them
   * has a transaction behind it.
   *
   * `awaiting-funding` is a state of its own. `funding_pending` stays folded
   * into `loading` in the machine — it genuinely resolves on its own — but the
   * drop projection is right here, so the screen can say *which* wait this is.
   */
  const unfunded = state === 'awaiting-funding'
  const fundingConfirming = state === 'loading' && drop?.state === 'funding_pending'

  return (
    <>
      {paid ? (
        <div className="nd-rise">
          <Receipt publicId={publicId} txHash={txHash} sponsorLabel={sponsor} />
          <Link to={`/create?amount=${encodeURIComponent(amount)}`} className="nd-action mt-5">
            Drop one back
          </Link>
          <p className="nd-note mt-4 text-center">
            One share per wallet. The transaction above is the whole story.
          </p>
        </div>
      ) : inFlight ? (
        <div className="mt-4">
          <div className="flex justify-center">
            <StatusPill state={state} />
          </div>
          <p className="nd-note mt-3">
            Sending to the wallet that signed. This screen updates itself, so you can close it.
          </p>
          {review ? (
            <div data-testid="manual-review" className="nd-panel mt-3">
              <p className="nd-note">
                A person is reviewing this one before it goes out. Your NIM is safe and your share
                stays reserved.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {state === 'degraded' ? (
            <div data-testid="degraded-banner" className="nd-panel nd-panel--warn mt-4">
              <p className="text-[0.9375rem] leading-relaxed text-pretty">
                NimDrops is having trouble reaching the network. Your share is not gone, so try
                again shortly.
              </p>
            </div>
          ) : null}

          {state === 'no-wallet' ? (
            <NoWallet />
          ) : unfunded || fundingConfirming ? (
            <Funding confirming={fundingConfirming} />
          ) : (
            <div className="mt-4">
              {/* No pill on `ready`: "Live" would be the third statement of a
                  fact the button and the share tile have already made. The pill
                  stays for the states nobody can infer. */}
              {state === 'ready' ? null : (
                <div className="mb-3 flex justify-center">
                  <StatusPill state={state} />
                </div>
              )}
              {/**
               * One word and the number, the way every incumbent does it
               * (Binance `Open`, WeChat 开, Ugly Cash `Open`). The amount stays
               * on the button because it is the number the reader checks
               * against the one they are pressing.
               */}
              <button type="button" disabled={state !== 'ready'} onClick={onClaim} className="nd-action">
                Open {amount} NIM
              </button>
              <p className="nd-note mt-2.5 text-center">
                {state === 'signing'
                  ? 'Nimiq Pay is open. Approve there to reserve your share.'
                  : 'Nimiq Pay opens next. You approve one signature, with no fee to pay.'}
              </p>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ---- the field's furniture ----------------------------------------------------------

/**
 * The claimant is the person being asked to trust a custodian, and until this
 * redesign they got two grey lines of footer while the sponsor got the whole
 * disclosure before funding. Ugly Cash's move is the one worth copying: take
 * the least reassuring fact about the product, make it the headline of a
 * tappable control, and put the rest one tap away.
 *
 * It sits at the foot of the sheet rather than on the field, and that is a
 * contrast decision as much as a compositional one: its shield is the last gold
 * on the claim screen, and gold is 5.47:1 on the card against 2.74:1 on the
 * field's brightest pixel.
 *
 * The facts are not softened here and are not meant to be. Most of this text
 * already exists in `Create.tsx`'s `Disclosure`, in `README.md` and in
 * `PRIVACY.md`; it is lifted rather than rewritten so the two audiences are
 * told the same thing.
 */
function CustodyDisclosure({ expiryHours }: { expiryHours?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-testid="custody-disclosure"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="nd-custody"
      >
        <CustodyShieldIcon size={16} />
        NimDrops is holding this NIM
      </button>

      <Sheet
        open={open}
        surface="field"
        title="Who is holding this NIM?"
        onClose={() => setOpen(false)}
      >
        <div className="text-[0.9375rem] leading-relaxed text-plate/76">
          <p>
            Until you claim it, this NIM sits in a wallet the{' '}
            <strong className="font-semibold text-plate">NimDrops operator controls</strong>. That
            is custody: not a smart contract, and not your wallet.
          </p>
          <p className="mt-3">
            When you claim, it is sent to the wallet that signed, and to no other address. Nothing
            you type into this app can change where it goes.
          </p>
          <p className="mt-3">
            Shares are fixed and first come, first served,{' '}
            <strong className="font-semibold text-plate">one per wallet</strong>. A signature proves
            control of one wallet. It does not prove one person, so anyone holding several wallets
            can take several shares.
          </p>
          {/* The window is the sponsor's choice, so it is read off THIS drop.
              Where the server has not said — an older build, or a body that
              did not parse — the sentence keeps the fact and drops the number,
              because a claimant told the wrong deadline is worse off than one
              told to look at the countdown. */}
          <p className="mt-3">
            {expiryHours === undefined ? (
              <>This drop stops accepting claims when its claim window ends.</>
            ) : (
              <>
                This drop stops accepting claims{' '}
                <strong className="font-semibold text-plate">
                  {expiryWindowLabel(expiryHours)}
                </strong>{' '}
                after it went live.
              </>
            )}{' '}
            Every unclaimed share is then refunded to the wallet that funded it.
          </p>
          <p className="mt-3">
            Payouts wait for the network to confirm them, and can go to a person for review during
            an incident. Nothing here says &ldquo;paid&rdquo; before the transaction is final.
          </p>
          <p className="mt-3">
            Funding, payouts and refunds are ordinary Nimiq transactions: public and permanent on
            the blockchain, and readable by anyone.
          </p>
        </div>
        {/* The scrim and Escape already dismiss; this is the thumb-reachable
            one, at the bottom of a sheet that is longer than a thumb. */}
        <button
          type="button"
          data-testid="disclosure-close"
          onClick={() => setOpen(false)}
          className="nd-quiet mt-6"
        >
          Close
        </button>
      </Sheet>
    </>
  )
}

// ---- the rest of the states --------------------------------------------------------

/**
 * The drop exists, the money does not, yet.
 *
 * There is no claim button here on purpose. A primary button that can never be
 * pressed is read as a broken page, and on `awaiting_funding` there is no
 * transaction anywhere to make it pressable. The amount, the sponsor and the
 * share count above are all real and stay on screen; this block replaces only
 * the affordance, with the plain reason and a working secondary action.
 *
 * The page goes on polling underneath, which is the only thing that makes the
 * last sentence true.
 */
function Funding({ confirming }: { confirming: boolean }) {
  return (
    <div data-testid={confirming ? 'funding-confirming' : 'awaiting-funding'} className="mt-4">
      <div className="mb-3 flex justify-center">
        <StatusPill state={confirming ? 'confirming' : 'awaiting-funding'} />
      </div>

      <div className="nd-panel">
        {confirming ? (
          <p className="text-[0.9375rem] leading-relaxed text-pretty">
            The sponsor&rsquo;s funding transaction is on the network and confirming now. There is
            nothing to do: this drop goes live the moment that transaction is final.
          </p>
        ) : (
          <p className="text-[0.9375rem] leading-relaxed text-pretty">
            The sponsor has not funded this NimDrop yet. Nothing is wrong with this link, and the
            claim button appears here as soon as the funding is confirmed.
          </p>
        )}
      </div>
    </div>
  )
}

const OUTCOME_TITLES: Partial<Record<ClaimUiState, string>> = {
  paused: 'Claims are paused for safety',
  expired: 'This drop has ended',
  exhausted: 'You just missed it',
  // Deliberately neutral: this heading is shared by two different outcomes —
  // the claimant declined in their wallet, and the server could not verify a
  // signature it did receive. "Not approved" states the first as though it were
  // both, blaming the reader for our fault. The body copy distinguishes them;
  // the heading only has to be true of either and reassure that nothing was
  // spent.
  rejected: 'Nothing was claimed',
}

/**
 * A word and a shape, never a hue on its own.
 *
 * No `StatusPill` on the dead ends: the heading beside this mark already IS the
 * state, and a pill reading "Paused" above "Claims are paused for safety" says
 * the same word twice.
 *
 * Near-white and not gold. It sits in the open field, where Nimiq gold is
 * 2.74:1 — under the 3:1 a non-text mark is held to — and the palette review
 * asked for three of the four golds to go near-white anyway.
 */
const OUTCOME_MARKS: Partial<Record<ClaimUiState, IconComponent>> = {
  paused: WarningIcon,
  expired: ClockExpiryIcon,
  exhausted: InfoIcon,
  rejected: WarningIcon,
}

function OutcomeMark({ state }: { state: ClaimUiState }) {
  const Mark = OUTCOME_MARKS[state] ?? InfoIcon
  return <Mark size={24} />
}

function Outcome({
  state,
  amount,
  notice,
  onRetry,
  expiryHours,
}: {
  state: ClaimUiState
  amount: string
  notice: string
  onRetry: () => void
  /** This drop's own claim window, when the server has said what it was. */
  expiryHours?: number
}) {
  return (
    <div>
      {state === 'paused' ? (
        <>
          <Line>NimDrops has stopped sending while the operator checks something.</Line>
          <Line>
            No NIM has been lost. Nothing was taken from your wallet, and any share already reserved
            for you stays reserved.
          </Line>
        </>
      ) : null}

      {state === 'expired' ? (
        <>
          <Line>
            {expiryHours === undefined
              ? 'Its claim window is up, so it is no longer accepting claims.'
              : `Its ${expiryWindowAdjective(expiryHours)} claim window is up, so it is no longer accepting claims.`}
          </Line>
          <Line>Anything unclaimed is refunded to the wallet that funded it.</Line>
          <DropOneBack amount={amount} />
        </>
      ) : null}

      {state === 'exhausted' ? (
        <>
          <Line>
            Every share in this drop has been claimed. Shares are fixed and first come, first
            served.
          </Line>
          <DropOneBack amount={amount} />
        </>
      ) : null}

      {state === 'rejected' ? (
        <>
          <Line>{notice || 'Your wallet closed without approving. Nothing was claimed.'}</Line>
          <Line>Your share is still here as long as the drop has one left.</Line>
          <button type="button" onClick={onRetry} className="nd-action mt-5">
            Try again
          </button>
        </>
      ) : null}
    </div>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <p className="nd-note mt-2.5 text-[0.9375rem]">{children}</p>
}

function DropOneBack({ amount }: { amount: string }) {
  return (
    <Link to={`/create?amount=${encodeURIComponent(amount)}`} className="nd-action mt-5">
      Drop one back
    </Link>
  )
}

/**
 * The claimant reached the claim screen and then turned out to have no wallet
 * to sign with — the bridge answered `unavailable` at claim time rather than at
 * boot. Landing here fresh gets the full-screen sealed envelope instead; this
 * is the mid-session fallback, so it is short and it is a deep link.
 */
function NoWallet() {
  const here = typeof window === 'undefined' ? '' : window.location.href
  return (
    <div className="mt-4">
      <div className="mb-3 flex justify-center">
        <StatusPill state="no-wallet" />
      </div>
      <a href={nimiqPayDeeplink(here)} className="nd-action">
        Open in Nimiq Pay
      </a>
      <p className="nd-note mt-2.5 text-center">Claiming needs your own wallet to sign.</p>
      {/* And if there is no wallet to open, the deep link above does nothing at
          all — silently. This is the same block the sealed gate carries. */}
      <GetNimiqPay />
    </div>
  )
}

/**
 * The two circular affordances on the rail.
 *
 * `CopyLinkButton` passes on THIS drop, which is what someone forwarding a link
 * to a friend wants. `ShareButton` recommends the PRODUCT: it used to share the
 * drop's own link under a label that read like a recommendation of the app, so
 * a claimant who had just been paid and wanted to tell a friend about NimDrops
 * instead sent them to the very drop they had just taken a share out of — one
 * share emptier than it was a minute ago, and possibly empty.
 *
 * `text` matters as much as the URL. WhatsApp routinely drops `title` and shows
 * a bare link, so the product's one-line description travels in the message
 * body or not at all.
 *
 * Both report back in a live region rather than by changing their own label: an
 * icon button has no label to change, and "copied" has to be announced.
 */
function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <button
        type="button"
        className="nd-round"
        data-testid="copy-link"
        aria-label="Copy the link to this drop"
        onClick={() => {
          const here = typeof window === 'undefined' ? '' : window.location.href
          void navigator.clipboard
            ?.writeText(here)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }}
      >
        <CopyIcon size={18} />
      </button>
      <span className="nd-sr" role="status">
        {copied ? 'Link copied' : ''}
      </span>
    </>
  )
}

function ShareButton() {
  const [copied, setCopied] = useState(false)
  const url = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <>
      <button
        type="button"
        data-testid="share-app"
        className="nd-round"
        aria-label="Share the app"
        onClick={() => {
          if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
            // A dismissed share sheet rejects with AbortError; that is a choice.
            void navigator
              .share({
                title: 'NimDrops',
                text: 'One link. A fixed share of NIM for everyone who opens it.',
                url,
              })
              .catch(() => {})
            return
          }
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }}
      >
        <ShareIcon size={18} />
      </button>
      <span className="nd-sr" role="status">
        {copied ? 'Link copied' : ''}
      </span>
    </>
  )
}
