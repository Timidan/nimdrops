import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ClaimServerState, DropPublic } from '../api'
import { nimiqPayDeeplink } from '../sdk/adapter'
import type { ClaimUiState } from '../state/claim'
import Field, { Ripple, RIPPLE_MS } from '../ui/Field'
import GlassSheet from '../ui/GlassSheet'
import {
  ClockExpiryIcon,
  CustodyShieldIcon,
  InfoIcon,
  QrCodeIcon,
  WarningIcon,
  type IconComponent,
} from '../ui/icons'
import Sheet from '../ui/Sheet'
import StatusPill from '../ui/StatusPill'
import Receipt from './Receipt'

/**
 * Everything the drop page looks like, with none of what it knows.
 *
 * `Drop` owns the claim machine; this owns the surface. Splitting them is what
 * lets `/preview` render all thirteen states at once from fixtures, and it is
 * also what keeps the field MOUNTED across a state change — the ring can only
 * be seen to leave if the same DOM node was sealed a moment ago.
 *
 * ## The composition
 *
 * A `Field` with a single `GlassSheet` on it. The sheet holds the transaction:
 * who sent this, their words, the amount on its opaque plate, one caption, one
 * action. The drop's live facts and the custody disclosure sit on the field
 * itself, in the two poster slots, which is what makes the desktop layout a
 * composition rather than a 430px column with dead space around it.
 *
 * ## Two rules this file exists to keep
 *
 * **The money never depends on the visual layer.** Nothing here starts hidden.
 * There is no reveal that content waits behind, no `opacity: 0` that a class
 * has to clear, and the one animation that does exist — the ring — is an
 * `aria-hidden` decoration that is not rendered at all under reduced motion.
 * With CSS animation switched off entirely, every one of the thirteen states
 * renders complete. `DropView.test.tsx` proves it against all thirteen.
 *
 * **The amount is never hidden.** Someone deciding whether to open a wallet has
 * to see what they are being offered, before they are asked for anything.
 * Concealing the number until after the claim would reintroduce exactly the
 * lottery framing this product removed.
 */

/** The ring has left and the field keeps the warmer cast on exactly these. */
const OPENED: readonly ClaimUiState[] = ['reserved', 'confirming', 'paid']

/** Dead ends: no amount to offer, no action to take, no warmth. */
const OUTCOMES: readonly ClaimUiState[] = ['paused', 'expired', 'exhausted', 'rejected']

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
}: DropViewProps) {
  const sponsor = drop?.sponsorLabel ?? ''
  const amount = amountEach ?? ''
  const outcome = OUTCOMES.includes(state)
  const opened = OPENED.includes(state)
  const unfunded = state === 'awaiting-funding'

  return (
    <Field
      tone={outcome ? 'quiet' : opened ? 'warm' : 'live'}
      {...(drop && !outcome ? { topRight: <Facts drop={drop} /> } : {})}
      {...(unfunded ? {} : { bottomLeft: <CustodyDisclosure /> })}
    >
      <Reveal opened={opened} />
      <GlassSheet testId="claim-sheet">
        {outcome ? (
          <Outcome state={state} amount={amount} notice={notice} onRetry={onRetry} />
        ) : state === 'loading' && !drop ? (
          <Opening />
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
      </GlassSheet>
    </Field>
  )
}

/**
 * The ring, and only when the surface was sealed a moment ago.
 *
 * Landing straight on an opened claim — a reload that resumes one already in
 * flight — has nothing to break, so it gets the opened state with no theatre.
 * A status poll ticking `reserved → confirming → paid` must not re-fire it
 * either: this is an event, not a loop.
 */
function Reveal({ opened }: { opened: boolean }) {
  const mountedOpen = useRef(opened)
  const fired = useRef(false)
  const [ringing, setRinging] = useState(false)

  useEffect(() => {
    if (!opened || fired.current || mountedOpen.current) return
    fired.current = true
    setRinging(true)
    const timer = setTimeout(() => setRinging(false), RIPPLE_MS)
    return () => clearTimeout(timer)
  }, [opened])

  return ringing ? <Ripple /> : null
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
   * drop projection is right here, so the screen can say *which* wait this is
   * instead of showing the boot spinner's "Opening" for a minute.
   */
  const unfunded = state === 'awaiting-funding'
  const fundingConfirming = state === 'loading' && drop?.state === 'funding_pending'

  return (
    <>
      {/**
       * The order a stranger needs, and nothing else above the fold: who sent
       * this, their own words, how much, what it is in one clause, one action.
       */}
      {sponsor ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.9375rem] leading-relaxed">
          {/* Claimant-facing, sponsor-supplied text, and labelled as such. */}
          <span className="line-clamp-3 [overflow-wrap:anywhere]">
            <span className="font-semibold">{sponsor}</span>
            <span className="text-plate/76"> sent you a NimDrop</span>
          </span>
          <span className="shrink-0 rounded-full border border-plate/30 px-2 py-0.5 text-xs font-medium text-plate/76">
            name unverified
          </span>
        </p>
      ) : null}

      {drop?.message && !paid ? (
        <p className="mt-4 border-l border-gold pl-4 text-[1.25rem] leading-snug text-pretty -tracking-[0.01em] [overflow-wrap:anywhere]">
          {drop.message}
        </p>
      ) : null}

      <AmountPlate amount={amount} paid={paid} inFlight={inFlight} />

      {/* One caption slot, one sentence per state. Nothing stacks up here, and
          this is the slot the trivia gate takes: see `GlassSheet`. */}
      {paid ? null : (
        <p className="nd-caption nd-note">
          {inFlight
            ? `${amount} NIM is on its way.`
            : 'A fixed share of NIM. The same amount for everyone who opens this link.'}
        </p>
      )}

      {paid ? (
        <div className="nd-rise mt-6">
          <Receipt publicId={publicId} txHash={txHash} sponsorLabel={sponsor} />
          <Link
            to={`/create?amount=${encodeURIComponent(amount)}`}
            className="nd-action mt-5"
          >
            Drop one back
          </Link>
          <ShareButton className="nd-quiet mt-2" />
          <p className="nd-note mt-5 text-center">
            One share per wallet. The transaction above is the whole story.
          </p>
        </div>
      ) : inFlight ? (
        <div className="mt-6">
          <div className="flex justify-center">
            <StatusPill state={state} />
          </div>
          <p className="nd-note mt-4">
            Sending to the wallet that signed. This screen updates itself, so you can close it.
          </p>
          {review ? (
            <div data-testid="manual-review" className="nd-panel mt-4">
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
            <div data-testid="degraded-banner" className="nd-panel nd-panel--warn mt-5">
              <p className="text-[0.9375rem] leading-relaxed text-pretty">
                NimDrops is having trouble reaching the network. Your share is not gone, so try
                again shortly.
              </p>
            </div>
          ) : null}

          {state === 'no-wallet' ? (
            <NoWallet publicId={publicId} />
          ) : unfunded || fundingConfirming ? (
            <Funding confirming={fundingConfirming} />
          ) : (
            <div className="mt-6">
              {/* No pill on `ready`: "Live" would be the third statement of a
                  fact the button and the share count have already made. The
                  pill stays for the states nobody can infer. */}
              {state === 'ready' ? null : (
                <div className="mb-4 flex justify-center">
                  <StatusPill state={state} />
                </div>
              )}
              {/**
               * One word and the number, the way every incumbent does it
               * (Binance `Open`, WeChat 开, Ugly Cash `Open`). The amount stays
               * on the button because it is the number the reader checks
               * against the one they are pressing; the instruction does not,
               * because the line underneath already carries it, better.
               */}
              <button
                type="button"
                disabled={state !== 'ready'}
                onClick={onClaim}
                className="nd-action"
              >
                Open {amount} NIM
              </button>
              <p className="nd-note mt-3 text-center">
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

// ---- the money ------------------------------------------------------------------------

/**
 * The denomination on its opaque plate.
 *
 * The only fully opaque element on the screen is the money, and that is the
 * hierarchy statement of the whole direction. It is also the physical form of
 * the rule that matters most: the number a stranger is deciding about cannot
 * depend on what happens to be behind it, or on an animation having fired.
 *
 * The size steps down by character count rather than by media query, because
 * what overflows a 320px phone is `10000.00000`, not a narrow screen. If a
 * step-down still does not fit, `.nd-amount`'s `flex-wrap` drops the unit onto
 * its own centred line. The number itself never wraps and is never truncated.
 */
function AmountPlate({
  amount,
  paid,
  inFlight,
}: {
  amount: string
  paid: boolean
  inFlight: boolean
}) {
  const size = amount.length <= 6 ? 'lg' : amount.length <= 9 ? 'md' : 'sm'

  return (
    <div className="nd-plate">
      <h1
        data-testid="amount-hero"
        aria-label={`${amount} NIM`}
        className="nd-amount"
        data-size={size}
      >
        <span>{amount}</span>
        <span className="nd-unit" aria-hidden="true">
          NIM
        </span>
      </h1>
      {paid ? <div data-testid="paid-keyline" className="nd-keyline" /> : null}
      {/* Only once the number has a destination. Before that the caption
          under the plate already says what the number is, and printing the
          same fact twice at two sizes reads as two different facts. */}
      {paid || inFlight ? (
        <p className="nd-plate-note">
          {paid ? 'Sent to the wallet that signed.' : 'Reserved for the wallet that signed.'}
        </p>
      ) : null}
    </div>
  )
}

// ---- the field's furniture ----------------------------------------------------------

/**
 * The drop's live state, on the field rather than in the sheet.
 *
 * This is the whole reason the sheet is translucent: what is behind it is
 * changing while you read it. Under the sheet on a phone, top right on a
 * poster. One element, moved by a container query, so the count can never be
 * on screen twice.
 *
 * The marks cap at twelve. A hundred-share drop is a legitimate configuration
 * and a hundred tally marks is a texture, not a count; the words beside them
 * carry the exact figure either way.
 */
function Facts({ drop }: { drop: DropPublic }) {
  return (
    <p className="nd-facts">
      {drop.claimCount <= 12 ? (
        <span className="nd-marks" aria-hidden="true">
          {Array.from({ length: drop.claimCount }).map((_, i) => (
            <i key={i} data-taken={i >= drop.remaining ? 'true' : 'false'} />
          ))}
        </span>
      ) : null}
      <span data-testid="remaining">
        {drop.remaining} of {drop.claimCount} shares left
      </span>
      {drop.expiresAt ? <Countdown expiresAt={drop.expiresAt} /> : null}
    </p>
  )
}

/**
 * The claimant is the person being asked to trust a custodian, and until this
 * redesign they got two grey lines of footer while the sponsor got the whole
 * disclosure before funding. Ugly Cash's move is the one worth copying: take
 * the least reassuring fact about the product, make it the headline of a
 * tappable control, and put the rest one tap away.
 *
 * It stays a button on the poster layout rather than becoming a static line.
 * Moving the disclosure out of reach on a desktop would be a regression against
 * "reachable in one tap from the claim screen", and it is the same element in
 * both places, so there is nothing to keep in sync.
 *
 * The facts are not softened here and are not meant to be. Most of this text
 * already exists in `Create.tsx`'s `Disclosure`, in `README.md` and in
 * `PRIVACY.md`; it is lifted rather than rewritten so the two audiences are
 * told the same thing.
 */
function CustodyDisclosure() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-testid="custody-disclosure"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex w-full items-start gap-2.5 rounded-2xl border border-plate/16 bg-plate/6 p-3.5 text-left"
      >
        <CustodyShieldIcon size={18} className="mt-0.5 shrink-0 text-gold" />
        <span>
          <span className="block text-[0.8125rem] font-semibold">
            NimDrops is holding this NIM, not a smart contract
          </span>
          <span className="nd-note mt-1 block">Who holds it, and where it goes if nobody claims.</span>
        </span>
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
          <p className="mt-3">
            A drop stops accepting claims{' '}
            <strong className="font-semibold text-plate">24 hours</strong> after it goes live. Every
            unclaimed share is then refunded to the wallet that funded it.
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

function Opening() {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <div className="nd-pulse h-1.5 w-16 rounded-full bg-gold" aria-hidden="true" />
      <p className="nd-note mt-6">Opening this NimDrop…</p>
    </div>
  )
}

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
    <div data-testid={confirming ? 'funding-confirming' : 'awaiting-funding'} className="mt-6">
      <div className="mb-4 flex justify-center">
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

      {confirming ? null : <CopyLinkButton className="nd-quiet mt-4" />}
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
  // both, blaming the reader for our fault. The body copy below distinguishes
  // them; the heading only has to be true of either and reassure that nothing
  // was spent.
  rejected: 'Nothing was claimed',
}

/**
 * A word and a shape, never a hue on its own.
 *
 * No `StatusPill` here on purpose: the heading below already IS the state, and
 * a pill reading "Paused" above "Claims are paused for safety" says the same
 * word twice. The mark carries the non-colour half of the signal instead.
 */
const OUTCOME_MARKS: Partial<Record<ClaimUiState, IconComponent>> = {
  paused: WarningIcon,
  expired: ClockExpiryIcon,
  exhausted: InfoIcon,
  rejected: WarningIcon,
}

function Outcome({
  state,
  amount,
  notice,
  onRetry,
}: {
  state: ClaimUiState
  amount: string
  notice: string
  onRetry: () => void
}) {
  const Mark = OUTCOME_MARKS[state] ?? InfoIcon
  return (
    <div className="py-2">
      <Mark size={22} className="mb-3 text-gold" />
      <h1 className="text-[1.5625rem] font-semibold text-balance -tracking-[0.02em]">
        {OUTCOME_TITLES[state]}
      </h1>

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
          <Line>Its 24 hours are up, so it is no longer accepting claims.</Line>
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
          <button type="button" onClick={onRetry} className="nd-action mt-7">
            Try again
          </button>
        </>
      ) : null}
    </div>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <p className="nd-note mt-3 text-[0.9375rem]">{children}</p>
}

function DropOneBack({ amount }: { amount: string }) {
  return (
    <Link to={`/create?amount=${encodeURIComponent(amount)}`} className="nd-action mt-7">
      Drop one back
    </Link>
  )
}

/**
 * The most-travelled path for a shared link: a plain browser with no provider.
 * Deep link first, QR for the case where the phone holding Nimiq Pay is not the
 * device holding the link, copy as the fallback that always works.
 */
function NoWallet({ publicId }: { publicId: string }) {
  const here = typeof window === 'undefined' ? '' : window.location.href
  return (
    <div className="mt-6">
      <div className="mb-4 flex justify-center">
        <StatusPill state="no-wallet" />
      </div>
      <a href={nimiqPayDeeplink(here)} className="nd-action">
        Open in Nimiq Pay
      </a>
      <p className="nd-note mt-3 text-center">
        Claiming needs your own wallet to sign.
      </p>

      {/* The QR has to be readable by a camera, so it keeps a solid light
          surface of its own. Nothing translucent is stacked on the sheet. */}
      <div className="mt-5 rounded-2xl bg-plate p-4">
        <img
          src={`/drop/${publicId}/qr.svg`}
          alt="QR code for this drop's link"
          width={192}
          height={192}
          className="mx-auto h-auto w-full max-w-48"
        />
        <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-plate-ink/76">
          <QrCodeIcon size={14} />
          Scan with the phone that has Nimiq Pay
        </p>
      </div>

      <CopyLinkButton className="nd-quiet mt-4" />
    </div>
  )
}

function CopyLinkButton({ className }: { className: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const here = typeof window === 'undefined' ? '' : window.location.href
        void navigator.clipboard
          ?.writeText(here)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }}
    >
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  )
}

/**
 * Recommending the product, not passing on this drop.
 *
 * It used to share the drop's own link under a label that read like a
 * recommendation of the app, so a claimant who had just been paid and wanted to
 * tell a friend about NimDrops instead sent them to the very drop they had just
 * taken a share out of: one share emptier than it was a minute ago, and
 * possibly empty.
 *
 * The origin is the honest target. Sitting under "Drop one back", the label has
 * to name a different object than the button above it, which is why it is not
 * "Share this drop".
 *
 * `text` matters as much as the URL. WhatsApp routinely drops `title` and shows
 * a bare link, so the product's one-line description travels in the message
 * body or not at all.
 */
function ShareButton({ className }: { className: string }) {
  const [copied, setCopied] = useState(false)
  const url = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <button
      type="button"
      data-testid="share-app"
      className={className}
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
      {copied ? 'Link copied' : 'Share the app'}
    </button>
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
    <span className="inline-flex items-center gap-1.5">
      <ClockExpiryIcon size={14} />
      {remainingMs <= 0 ? 'Expired' : `Expires in ${humanize(remainingMs)}`}
    </span>
  )
}

function humanize(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 1) return `${hours}h ${minutes % 60}m`
  if (minutes >= 1) return `${minutes}m`
  return 'under a minute'
}
