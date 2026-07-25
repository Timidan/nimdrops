import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { nimiqPayDeeplink, type BridgeResult } from '../sdk/adapter'
import { useClaim } from '../state/claim'
import StatusPill from '../ui/StatusPill'
import Receipt from './Receipt'

/**
 * The campaign page — the thing a stranger opens from a group chat
 * (design §4.1, §4.3, §4.4).
 *
 * Two decisions drive everything below.
 *
 * **The no-wallet screen is a first-class path, not an error.** Most people who
 * tap a link in a chat app land in that app's in-app browser, where there is no
 * Nimiq Pay provider. They get the deep link, the QR and a copy button, plus
 * the campaign itself, so they can see what they are being asked to open a
 * wallet for.
 *
 * **The copy never runs ahead of the money.** The button says *tap and
 * approve*, because a cold claimant may also meet a deep-link warning and a
 * native signature sheet. While the payout is in flight the page says "on its
 * way". The word "Paid" appears in exactly one place: the receipt, after the
 * server said so.
 */

export interface DropProps {
  /** Test seam; production uses the real provider discovery. */
  discoverBridge?: () => Promise<BridgeResult>
  pollMs?: number
}

export default function Drop({ discoverBridge, pollMs }: DropProps) {
  const { publicId = '' } = useParams()
  const claim = useClaim(publicId, {
    ...(discoverBridge ? { discoverBridge } : {}),
    ...(pollMs ? { pollMs } : {}),
  })
  const { state, drop, serverState, txHash, amountEach, notice } = claim

  const sponsor = drop?.sponsorLabel ?? ''
  const amount = amountEach ?? ''

  if (state === 'paid') {
    return (
      <Screen>
        <div className="py-10">
          <Receipt publicId={publicId} amountEach={amount} txHash={txHash} sponsorLabel={sponsor} />
          <ShareButton publicId={publicId} className="nd-secondary mt-3 w-full" />
          <p className="mt-6 text-center text-xs leading-relaxed text-ink/45">
            One share per wallet. NimDrops held this NIM until you claimed it; the transaction above is
            the whole story.
          </p>
        </div>
      </Screen>
    )
  }

  if (state === 'loading' && !drop) {
    return (
      <Screen>
        <div className="flex flex-1 flex-col justify-center py-16">
          <div className="nd-pulse h-1.5 w-16 rounded-full bg-gold" aria-hidden="true" />
          <p className="mt-6 text-sm text-ink/55">Opening this NimDrop…</p>
        </div>
      </Screen>
    )
  }

  if (state === 'paused') {
    return (
      <Outcome title="Claims are paused for safety">
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          NimDrops has stopped sending while the operator checks something.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          No NIM has been lost. Nothing was taken from your wallet, and any share already reserved for
          you stays reserved.
        </p>
      </Outcome>
    )
  }

  if (state === 'expired') {
    return (
      <Outcome title="This drop has ended">
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          Its 24 hours are up, so it is no longer accepting claims.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          Anything unclaimed is refunded to the wallet that funded it.
        </p>
        <DropOneBack amount={amount} />
      </Outcome>
    )
  }

  if (state === 'exhausted') {
    return (
      <Outcome title="You just missed it">
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          Every share in this drop has been claimed. Shares are fixed and first come, first served —
          there is nothing left to reserve here.
        </p>
        <DropOneBack amount={amount} />
      </Outcome>
    )
  }

  if (state === 'rejected') {
    return (
      <Outcome title="Not approved">
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          {notice || 'Your wallet closed without approving. Nothing was claimed.'}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          Your share is still here as long as the drop has one left.
        </p>
        <button type="button" onClick={claim.retry} className="nd-primary mt-8 w-full">
          Try again
        </button>
      </Outcome>
    )
  }

  if (state === 'reserved' || state === 'confirming') {
    const review = serverState === 'manual_review'
    return (
      <Screen>
        <div className="flex flex-1 flex-col justify-center py-16">
          <div>
            <StatusPill state={state} />
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">{amount} NIM is on its way</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink/60">
            Your share is reserved. NimDrops is sending it to the wallet that signed, and this screen
            updates itself — you can close this and come back to it.
          </p>
          {review ? (
            <p
              data-testid="manual-review"
              className="mt-5 rounded-2xl bg-ink/5 p-4 text-sm leading-relaxed text-ink/70"
            >
              This one is being reviewed by a person before it goes out. Your NIM is safe and your share
              stays reserved while that happens.
            </p>
          ) : (
            <p className="mt-5 text-xs leading-relaxed text-ink/45">
              A transaction has to be signed and confirmed by the network before it counts as sent, so
              this can take a moment.
            </p>
          )}
        </div>
      </Screen>
    )
  }

  // ---- the campaign card: ready, signing, degraded, no-wallet, funding ----------
  return (
    <Screen>
      <header className="flex items-center justify-between gap-3 pt-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink/70">{sponsor}</span>
          <span className="shrink-0 rounded-full border border-ink/15 px-2 py-0.5 text-[0.625rem] font-semibold tracking-wide text-ink/45 uppercase">
            unverified
          </span>
        </div>
        <StatusPill state={state} />
      </header>

      <div className="mt-6 rounded-3xl border border-ink/10 bg-white p-6 text-center">
        <p className="text-[0.6875rem] font-semibold tracking-[0.14em] text-ink/40 uppercase">
          Your share
        </p>
        <p
          data-testid="amount-hero"
          className="mt-2 text-5xl font-semibold tracking-tight tabular-nums"
        >
          {amount} <span className="text-2xl font-medium text-ink/55">NIM</span>
        </p>
        <p className="mt-2 text-xs text-ink/45">Fixed and equal for everyone who claims.</p>
        {drop ? (
          <p data-testid="remaining" className="mt-4 text-sm font-medium tabular-nums text-ink/70">
            {drop.remaining} of {drop.claimCount} shares left
          </p>
        ) : null}
      </div>

      {drop?.message ? (
        <p className="mt-5 rounded-2xl bg-ink/4 p-4 text-sm leading-relaxed text-ink/70">
          {drop.message}
        </p>
      ) : null}

      <Countdown expiresAt={drop?.expiresAt ?? null} />

      {state === 'degraded' ? (
        <p
          data-testid="degraded-banner"
          className="mt-5 rounded-2xl border border-gold/40 bg-gold/10 p-4 text-sm leading-relaxed text-ink/75"
        >
          NimDrops is having trouble reaching the network. Your share is not gone — try again shortly.
        </p>
      ) : null}

      {state === 'no-wallet' ? (
        <NoWallet publicId={publicId} />
      ) : (
        <>
          <button
            type="button"
            disabled={state !== 'ready'}
            onClick={() => void claim.claim()}
            className="nd-primary mt-6 w-full"
          >
            Claim {amount} NIM — tap and approve
          </button>
          <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
            {state === 'signing'
              ? 'Nimiq Pay is open. Approve the signature request there to reserve your share.'
              : 'Nimiq Pay opens next. You approve one signature — no amount to type, no fee to pay.'}
          </p>
        </>
      )}

      <p className="mt-8 text-center text-xs leading-relaxed text-ink/45">
        One share per wallet. NimDrops holds the NIM until it is claimed, then sends it to the wallet
        that signed.
      </p>
    </Screen>
  )
}

// ---- pieces ---------------------------------------------------------------------

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-paper px-6 pb-16 text-ink">
      {children}
    </main>
  )
}

function Outcome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center py-16">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </Screen>
  )
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
    <div className="mt-6">
      <a href={nimiqPayDeeplink(here)} className="nd-primary block w-full text-center">
        Open in Nimiq Pay
      </a>
      <p className="mt-3 text-center text-xs leading-relaxed text-ink/50">
        Claiming needs your own wallet to sign. This link keeps the drop — it opens this same campaign
        inside Nimiq Pay.
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
    typeof window === 'undefined' ? '' : `${window.location.origin}/d/${encodeURIComponent(publicId)}`
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
    <p className="mt-4 text-center text-xs text-ink/50">
      {remainingMs <= 0 ? 'Expired' : `Expires in ${humanize(remainingMs)}`}
    </p>
  )
}

function humanize(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 1) return `${hours}h ${minutes % 60}m`
  if (minutes >= 1) return `${minutes}m`
  return 'under a minute'
}
