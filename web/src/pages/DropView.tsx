import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ClaimServerState, DropPublic } from '../api'
import { nimiqPayDeeplink } from '../sdk/adapter'
import type { ClaimUiState } from '../state/claim'
import Envelope, { EnvelopeAmount } from '../ui/Envelope'
import Screen from '../ui/Screen'
import StatusPill from '../ui/StatusPill'
import Receipt from './Receipt'

/**
 * Everything the campaign page looks like, with none of what it knows.
 *
 * `Drop` owns the claim machine; this owns the envelope. Splitting them is what
 * lets `/preview` render all twelve states at once from fixtures, and it is
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

  return (
    <div className="flex flex-1 flex-col pb-12">
      {/* Who handed this to you. Claimant-supplied text, and labelled as such. */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="line-clamp-2 max-w-full text-sm font-medium text-ink/65 [overflow-wrap:anywhere]">
          {sponsor}
        </span>
        <span className="shrink-0 rounded-full border border-ink/15 px-2 py-0.5 text-[0.6875rem] font-medium text-ink/45">
          unverified
        </span>
      </div>

      <EnvelopeAmount amount={amount} paid={paid} />

      {/* One caption slot, one sentence per state. Nothing stacks up here. */}
      {inFlight ? (
        <p className="mt-4 text-center text-[0.9375rem] leading-relaxed font-medium text-ink/75">
          {amount} NIM is on its way.
        </p>
      ) : paid ? null : (
        <p className="mt-3 text-center text-xs text-ink/50">
          Fixed and equal for everyone who claims.
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

      {drop?.message && !paid ? (
        <p className="mt-6 border-l-2 border-gold/45 pl-4 text-sm leading-relaxed text-ink/70 [overflow-wrap:anywhere]">
          {drop.message}
        </p>
      ) : null}

      {paid ? (
        <div className="nd-rise mt-8">
          <Receipt publicId={publicId} amountEach={amount} txHash={txHash} sponsorLabel={sponsor} />
          <ShareButton publicId={publicId} className="nd-secondary mt-3 w-full" />
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
          ) : (
            <div className="mt-7">
              <div className="mb-4 flex justify-center">
                <StatusPill state={state} />
              </div>
              <button
                type="button"
                disabled={state !== 'ready'}
                onClick={onClaim}
                className="nd-primary w-full"
              >
                Claim {amount} NIM — tap and approve
              </button>
              <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
                {state === 'signing'
                  ? 'Nimiq Pay is open. Approve the signature request there to reserve your share.'
                  : 'Nimiq Pay opens next. You approve one signature — no amount to type, no fee to pay.'}
              </p>
            </div>
          )}

          <p className="mt-auto pt-8 text-center text-xs leading-relaxed text-ink/45">
            One share per wallet. NimDrops holds the NIM until it is claimed, then sends it to the
            wallet that signed.
          </p>
        </>
      )}
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

const OUTCOME_TITLES: Partial<Record<ClaimUiState, string>> = {
  paused: 'Claims are paused for safety',
  expired: 'This drop has ended',
  exhausted: 'You just missed it',
  rejected: 'Not approved',
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
        Claiming needs your own wallet to sign. This link keeps the drop — it opens this same
        campaign inside Nimiq Pay.
      </p>

      <div className="mt-6 rounded-3xl border border-ink/10 bg-white p-5">
        <img
          src={`/d/${publicId}/qr.svg`}
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

function ShareButton({ publicId, className }: { publicId: string; className: string }) {
  const url =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/d/${encodeURIComponent(publicId)}`
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
          // A dismissed share sheet rejects with AbortError; that is a choice.
          void navigator.share({ title: 'A NimDrop for you', url }).catch(() => {})
          return
        }
        void navigator.clipboard?.writeText(url).catch(() => {})
      }}
    >
      Share NimDrops
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
