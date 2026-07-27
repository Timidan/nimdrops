import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ClaimServerState, DropPublic } from '../api'
import { nimiqPayDeeplink } from '../sdk/adapter'
import type { ClaimUiState } from '../state/claim'
import Envelope, { EnvelopeAmount } from '../ui/Envelope'
import Screen from '../ui/Screen'
import Sheet from '../ui/Sheet'
import StatusPill from '../ui/StatusPill'
import Receipt from './Receipt'

/**
 * Everything the drop page looks like, with none of what it knows.
 *
 * `Drop` owns the claim machine; this owns the envelope. Splitting them is what
 * lets `/preview` render all thirteen states at once from fixtures, and it is
 * also what keeps the envelope MOUNTED across a state change — the seal can
 * only be seen to break if the same DOM node was sealed a moment ago.
 */

/** The seal is broken on exactly these. */
const OPENED: readonly ClaimUiState[] = ['reserved', 'confirming', 'paid']

/** Dead ends: no amount to offer, no action to take, grey wax. */
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
  const mark = sponsor.trim().slice(0, 1).toUpperCase()
  const outcome = OUTCOMES.includes(state)

  return (
    <Screen>
      <Envelope
        open={OPENED.includes(state)}
        tone={outcome ? 'quiet' : 'live'}
        {...(mark ? { sealMark: mark } : {})}
      >
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
      </Envelope>
    </Screen>
  )
}

// ---- the sealed / opening / opened face ------------------------------------------

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

function Face({
  publicId,
  state,
  drop,
  serverState,
  txHash,
  amount,
  sponsor,
  onClaim,
}: FaceProps) {
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
    <div className="flex flex-1 flex-col pb-12">
      {/**
       * The order a stranger needs, and nothing else above the fold: who sent
       * this, their own words, how much, what it is in one clause, one action.
       *
       * The sponsor's message used to sit sixth, below the share count and the
       * countdown, which put the mechanics of the gift ahead of the greeting.
       */}
      {sponsor ? (
        <div className="flex flex-wrap items-baseline justify-center gap-x-2 gap-y-1">
          {/* Claimant-facing, sponsor-supplied text, and labelled as such. */}
          <p className="line-clamp-3 max-w-full text-center text-sm leading-relaxed text-ink/65 [overflow-wrap:anywhere]">
            <span className="font-semibold text-ink/85">{sponsor}</span> sent you a NimDrop
          </p>
          <span className="shrink-0 rounded-full border border-ink/15 px-2 py-0.5 text-[0.6875rem] font-medium text-ink/45">
            name unverified
          </span>
        </div>
      ) : null}

      {drop?.message && !paid ? (
        <p className="mt-5 border-l-2 border-gold/45 pl-4 text-sm leading-relaxed text-ink/70 [overflow-wrap:anywhere]">
          {drop.message}
        </p>
      ) : null}

      <EnvelopeAmount amount={amount} paid={paid} />

      {/* One caption slot, one sentence per state. Nothing stacks up here. */}
      {inFlight ? (
        <p className="mt-4 text-center text-[0.9375rem] leading-relaxed font-medium text-ink/75">
          {amount} NIM is on its way.
        </p>
      ) : paid ? null : (
        <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
          A fixed share of NIM — the same amount for everyone who opens this link.
        </p>
      )}

      {!paid && (drop || state === 'no-wallet') ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-ink/55">
          {drop ? (
            <span data-testid="remaining" className="tabular-nums">
              {drop.remaining} of {drop.claimCount} shares left
            </span>
          ) : null}
          {drop?.expiresAt ? (
            <span aria-hidden="true" className="text-ink/25">
              ·
            </span>
          ) : null}
          <Countdown expiresAt={drop?.expiresAt ?? null} />
        </div>
      ) : null}

      {paid ? (
        <div className="nd-rise mt-8">
          <Receipt publicId={publicId} amountEach={amount} txHash={txHash} sponsorLabel={sponsor} />
          <ShareButton className="nd-secondary mt-3 w-full" />
          <p className="mt-6 text-center text-xs leading-relaxed text-ink/45">
            One share per wallet. NimDrops held this NIM until you claimed it; the transaction above
            is the whole story.
          </p>
        </div>
      ) : inFlight ? (
        <div className="mt-7">
          <div className="flex justify-center">
            <StatusPill state={state} />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink/60">
            Your share is reserved. NimDrops is sending it to the wallet that signed, and this screen
            updates itself — you can close this and come back to it.
          </p>
          {review ? (
            <p
              data-testid="manual-review"
              className="mt-5 rounded-2xl bg-ink/5 p-4 text-sm leading-relaxed text-ink/70"
            >
              This one is being reviewed by a person before it goes out. Your NIM is safe and your
              share stays reserved while that happens.
            </p>
          ) : (
            <p className="mt-4 text-xs leading-relaxed text-ink/45">
              A transaction has to be signed and confirmed by the network before it counts as sent,
              so this can take a moment.
            </p>
          )}
        </div>
      ) : (
        <>
          {state === 'degraded' ? (
            <p
              data-testid="degraded-banner"
              className="mt-6 rounded-2xl border border-gold/40 bg-gold/10 p-4 text-sm leading-relaxed text-ink/75"
            >
              NimDrops is having trouble reaching the network. Your share is not gone — try again
              shortly.
            </p>
          ) : null}

          {state === 'no-wallet' ? (
            <NoWallet publicId={publicId} />
          ) : unfunded || fundingConfirming ? (
            <Funding confirming={fundingConfirming} />
          ) : (
            <div className="mt-7">
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
                className="nd-primary w-full"
              >
                Open — {amount} NIM
              </button>
              <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
                {state === 'signing'
                  ? 'Nimiq Pay is open. Approve the signature request there to reserve your share.'
                  : 'Nimiq Pay opens next. You approve one signature — no amount to type, no fee to pay.'}
              </p>
            </div>
          )}

          {/* Not shown while unfunded: NimDrops is holding nothing yet, and a
              disclosure that says otherwise would be the one invented fact on
              an otherwise honest screen. */}
          {unfunded ? null : <CustodyDisclosure />}
        </>
      )}
    </div>
  )
}

// ---- the custody disclosure ----------------------------------------------------------

/**
 * The claimant is the person being asked to trust a custodian, and until now
 * they got two grey lines of footer while the sponsor got the whole disclosure
 * before funding. Ugly Cash's move is the one worth copying: take the least
 * reassuring fact about the product, make it the headline of a tappable card,
 * and put the rest one tap away.
 *
 * The facts are not softened here and are not meant to be. Most of this text
 * already exists in `Create.tsx`'s `Disclosure`, in `README.md` and in
 * `PRIVACY.md`; it is lifted rather than rewritten so the two audiences are
 * told the same thing.
 */
function CustodyDisclosure() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-auto pt-8">
      <button
        type="button"
        data-testid="custody-disclosure"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="block w-full rounded-2xl border border-ink/10 bg-ink/4 p-4 text-left"
      >
        <span className="block text-sm font-semibold text-ink/80">
          NimDrops is holding this NIM, not a smart contract
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink/55">
          Who holds it, why one share per wallet is not one person, and where it goes if nobody
          claims.
        </span>
      </button>

      <Sheet open={open} title="Who is holding this NIM?" onClose={() => setOpen(false)}>
        <div className="text-sm leading-relaxed text-ink/70">
          <p>
            Until you claim it, this NIM sits in a wallet the{' '}
            <strong className="font-semibold text-ink">NimDrops operator controls</strong>. That is
            custody — not a smart contract, and not your wallet.
          </p>
          <p className="mt-3">
            When you claim, it is sent to the wallet that signed, and to no other address. Nothing
            you type into this app can change where it goes.
          </p>
          <p className="mt-3">
            Shares are fixed and first come, first served —{' '}
            <strong className="font-semibold text-ink">one per wallet</strong>. A signature proves
            control of one wallet. It does not prove one person, so anyone holding several wallets
            can take several shares.
          </p>
          <p className="mt-3">
            A drop stops accepting claims{' '}
            <strong className="font-semibold text-ink">24 hours</strong> after it goes live. Every
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
          className="nd-secondary mt-6 w-full"
        >
          Close
        </button>
      </Sheet>
    </div>
  )
}

// ---- the rest of the states --------------------------------------------------------

function Opening() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-24 text-center">
      <div className="nd-pulse h-1.5 w-16 rounded-full bg-gold" aria-hidden="true" />
      <p className="mt-6 text-sm text-ink/55">Opening this NimDrop…</p>
    </div>
  )
}

/**
 * The drop exists, the money does not — yet.
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
    <div data-testid={confirming ? 'funding-confirming' : 'awaiting-funding'} className="mt-7">
      <div className="mb-4 flex justify-center">
        <StatusPill state={confirming ? 'confirming' : 'awaiting-funding'} />
      </div>

      <div className="rounded-2xl bg-ink/5 p-4">
        {confirming ? (
          <>
            <p className="text-sm leading-relaxed text-ink/75">
              The sponsor&rsquo;s funding transaction is on the network and confirming now.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink/60">
              There is nothing to do. This drop goes live the moment that transaction is final, and
              this page updates itself.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-ink/75">
              The sponsor has not funded this NimDrop yet. Until they send the NIM, there is nothing
              here to claim.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink/60">
              Nothing is wrong with this link. The page keeps checking on its own, and the claim
              button appears here as soon as the funding is confirmed.
            </p>
          </>
        )}
      </div>

      {confirming ? null : (
        <>
          <CopyLinkButton className="nd-secondary mt-5 w-full" />
          <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
            Keep the link if you would rather come back later — it stays the same.
          </p>
        </>
      )}
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
  return (
    <div className="flex flex-1 flex-col justify-center pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">{OUTCOME_TITLES[state]}</h1>

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
            Every share in this drop has been claimed. Shares are fixed and first come, first served
            — there is nothing left to reserve here.
          </Line>
          <DropOneBack amount={amount} />
        </>
      ) : null}

      {state === 'rejected' ? (
        <>
          <Line>{notice || 'Your wallet closed without approving. Nothing was claimed.'}</Line>
          <Line>Your share is still here as long as the drop has one left.</Line>
          <button type="button" onClick={onRetry} className="nd-primary mt-8 w-full">
            Try again
          </button>
        </>
      ) : null}
    </div>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-ink/60">{children}</p>
}

function DropOneBack({ amount }: { amount: string }) {
  return (
    <Link
      to={`/create?amount=${encodeURIComponent(amount)}`}
      className="nd-primary mt-8 block w-full text-center"
    >
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
    <div className="mt-7">
      <div className="mb-4 flex justify-center">
        <StatusPill state="no-wallet" />
      </div>
      <a href={nimiqPayDeeplink(here)} className="nd-primary block w-full text-center">
        Open in Nimiq Pay
      </a>
      <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
        Claiming needs your own wallet to sign. This link keeps your place — it opens this same drop
        inside Nimiq Pay.
      </p>

      <div className="mt-6 rounded-3xl border border-ink/10 bg-white p-5">
        <img
          src={`/drop/${publicId}/qr.svg`}
          alt="QR code for this drop's link"
          width={200}
          height={200}
          className="mx-auto h-auto w-full max-w-[200px]"
        />
        <p className="mt-3 text-center text-xs text-ink/50">
          Scan it with the phone that has Nimiq Pay.
        </p>
      </div>

      <CopyLinkButton className="nd-secondary mt-4 w-full" />
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
 * It used to share `/d/{publicId}` under the label "Share NimDrops", so a
 * claimant who had just been paid and wanted to tell a friend about the app
 * instead sent them to the very drop they had just taken a share out of — one
 * share emptier than it was a minute ago, and possibly empty.
 *
 * The origin is the honest target: `/` is the create screen, so the friend
 * lands on the thing the recommender is recommending. Sitting under "Drop one
 * back", the label has to name a different object than the button above it,
 * which is why it is not "Share this drop".
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
 */
function Countdown({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (!expiresAt) return null
  const remainingMs = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(remainingMs)) return null

  return (
    <span className="tabular-nums">
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
