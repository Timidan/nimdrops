import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  closeDrop,
  getDrop,
  requestCloseChallenge,
  type CloseAccepted,
  type DropPublic,
} from '../api'
import { formatNim, lunaFromNim } from '../money'
import { nimiqPayDeeplink, resolveBridge, type BridgeResult } from '../sdk/adapter'
import { closeFailureNotice } from '../state/close'
import Field from '../ui/Field'
import GlassSheet from '../ui/GlassSheet'
import { WarningIcon } from '../ui/icons'
import { Amount } from '../ui/Nim'
import { GetNimiqPay } from '../ui/OpenInApp'

/**
 * The sponsor's way out: end a drop you funded and take back what nobody took.
 *
 * It is a screen of its own rather than a control on the claim page, for one
 * reason: it is irreversible, and the sentence that says so has to be read
 * before the wallet opens, not after. A confirm dialog on a shared surface would
 * put "this cannot be undone" in the smallest type on the page.
 *
 * **What it promises, in the order a sponsor needs it.** How much comes back and
 * where it goes; that anyone who already claimed is still paid; that everyone
 * else will find the drop closed; and that none of it can be reversed. Only then
 * a button, and the button names the amount rather than saying "Confirm".
 *
 * **What it never says.** That the refund has arrived. Closing commits the
 * intent; the transfer is the worker's, and this screen says "on its way back"
 * for exactly as long as that is the true sentence.
 *
 * Authorization is a signature from the funding wallet — the server checks the
 * signing address against the sender of the verified funding transaction, under
 * the same lock the close takes — so this page needs no session, no token and no
 * secret. Anyone may open it; only one wallet can finish it.
 */

type Stage = 'loading' | 'unreadable' | 'confirm' | 'signing' | 'closing' | 'closed'

export interface CloseDropProps {
  /** Test seam; production uses the real provider discovery. */
  discoverBridge?: () => Promise<BridgeResult>
}

/**
 * What is still unclaimed, in NIM, or `null` when it cannot be computed
 * exactly.
 *
 * A figure this screen cannot derive without rounding is not shown at all. The
 * server returns the authoritative refund on the 202, so the preview's only job
 * is to let a sponsor recognise the size of what they are about to do — and a
 * preview that quietly rounded a sponsor's money would fail at exactly that.
 */
export function unclaimedNim(drop: DropPublic): string | null {
  const each = lunaFromNim(drop.amountEach)
  if (each === null || drop.remaining <= 0) return null
  return formatNim(each * BigInt(drop.remaining))
}

export default function CloseDrop({ discoverBridge = resolveBridge }: CloseDropProps) {
  const { publicId = '' } = useParams()

  const [stage, setStage] = useState<Stage>('loading')
  const [drop, setDrop] = useState<DropPublic | null>(null)
  const [result, setResult] = useState<CloseAccepted | null>(null)
  const [notice, setNotice] = useState('')
  const bridgeRef = useRef<BridgeResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const latest = await getDrop(publicId)
        if (cancelled) return
        setDrop(latest)
        setStage(latest.state === 'live' ? 'confirm' : 'unreadable')
        if (latest.state !== 'live') setNotice(alreadyOverNotice(latest))
      } catch (err) {
        if (cancelled) return
        setNotice(closeFailureNotice(err))
        setStage('unreadable')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicId])

  const close = useCallback(async () => {
    setNotice('')
    const bridge = bridgeRef.current ?? (await discoverBridge().catch(() => null))
    if (bridge) bridgeRef.current = bridge
    if (!bridge || bridge.kind === 'unavailable') {
      setNotice('Open this page in Nimiq Pay to approve with the wallet that funded the drop.')
      setStage('confirm')
      return
    }

    setStage('signing')
    let challenge
    try {
      challenge = await requestCloseChallenge(publicId)
    } catch (err) {
      setNotice(closeFailureNotice(err))
      setStage('confirm')
      return
    }

    let signed
    try {
      signed = await bridge.bridge.sign(challenge.message)
    } catch {
      // Closed, cancelled or refused in the wallet. Nothing was signed, so the
      // drop is untouched and this is a retry rather than a failure.
      setNotice('Your wallet closed without approving. The drop is still running.')
      setStage('confirm')
      return
    }

    setStage('closing')
    try {
      const accepted = await closeDrop(publicId, {
        challengeId: challenge.challengeId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      })
      setResult(accepted)
      setStage('closed')
    } catch (err) {
      setNotice(closeFailureNotice(err))
      // An `already_closed` is not something to try again — reload the drop so
      // the screen tells the truth about what it now is.
      if (err instanceof ApiError && (err.code === 'already_closed' || err.code === 'drop_not_funded')) {
        setStage('unreadable')
        return
      }
      setStage('confirm')
    }
  }, [discoverBridge, publicId])

  const unclaimed = drop ? unclaimedNim(drop) : null

  return (
    <Field tone={stage === 'closed' || stage === 'unreadable' ? 'quiet' : 'live'}>
      <div className="nd-stack">
        {stage === 'closed' && result ? (
          <Closed publicId={publicId} result={result} />
        ) : stage === 'unreadable' ? (
          <Unavailable publicId={publicId} notice={notice} />
        ) : (
          <Confirm
            drop={drop}
            unclaimed={unclaimed}
            busy={stage === 'signing' || stage === 'closing'}
            stage={stage}
            notice={notice}
            onClose={() => void close()}
            publicId={publicId}
          />
        )}
      </div>
    </Field>
  )
}

/** What to say about a drop that is already over by the time this page loads. */
function alreadyOverNotice(drop: DropPublic): string {
  if (drop.state === 'awaiting_funding' || drop.state === 'funding_pending') {
    return 'This drop was never funded, so there is nothing to close and nothing to refund.'
  }
  return 'This drop is already closed. Anything nobody claimed is on its way back to the wallet that funded it.'
}

function Confirm({
  drop,
  unclaimed,
  busy,
  stage,
  notice,
  onClose,
  publicId,
}: {
  drop: DropPublic | null
  unclaimed: string | null
  busy: boolean
  stage: Stage
  notice: string
  onClose: () => void
  publicId: string
}) {
  const claimed = drop ? drop.claimCount - drop.remaining : 0

  return (
    <GlassSheet
      testId="close-confirm"
      header={
        <div className="nd-headline">
          <h1>Close this drop</h1>
        </div>
      }
      caption={
        drop
          ? `${drop.sponsorLabel} · ${drop.remaining} of ${drop.claimCount} shares are still unclaimed`
          : 'Reading this drop…'
      }
    >
      {unclaimed ? <Amount value={unclaimed} className="nd-amount" data-size="md" /> : null}

      <div className="nd-panel mt-3">
        <p className="nd-note">
          {claimed === 0
            ? 'Nobody has claimed a share yet.'
            : `${claimed} ${claimed === 1 ? 'person has' : 'people have'} already claimed. They are still paid in full — closing never takes a claimed share back.`}
        </p>
        <p className="nd-note mt-3">
          {unclaimed
            ? `The ${unclaimed} NIM nobody has claimed goes back to the wallet that funded this drop.`
            : 'Every share has been claimed, so there is nothing left to refund.'}
        </p>
        <p className="nd-note mt-3">
          Anyone who opens the link after this finds the drop closed. The link keeps working; there
          is simply nothing left to claim.
        </p>
      </div>

      <div data-testid="close-irreversible" className="nd-panel nd-panel--warn mt-4">
        <p className="text-[0.9375rem] leading-relaxed text-pretty">
          <WarningIcon size={16} /> This cannot be undone. A closed drop cannot be reopened, and
          starting another one means funding it again.
        </p>
      </div>

      {notice ? (
        <div data-testid="close-notice" className="nd-panel mt-3">
          <p className="nd-note" role="status">
            {notice}
          </p>
        </div>
      ) : null}

      <button type="button" className="nd-action mt-5" onClick={onClose} disabled={busy || !drop}>
        {stage === 'signing'
          ? 'Waiting for your wallet…'
          : stage === 'closing'
            ? 'Closing…'
            : unclaimed
              ? `Close and send back ${unclaimed} NIM`
              : 'Close this drop'}
      </button>

      <p className="nd-note">
        You will be asked to approve with the wallet that funded this drop. No other wallet can
        close it.
      </p>

      <p className="nd-note mt-3">
        <Link to={`/drop/${publicId}`}>Leave it running</Link>
      </p>

      {/* The deep link reopens THIS page inside Nimiq Pay, so a sponsor who
          followed their own share link in an ordinary browser can still sign. */}
      <p className="nd-note mt-3">
        <a href={nimiqPayDeeplink(pageUrl(publicId))}>Open this page in Nimiq Pay</a>
      </p>
      <GetNimiqPay className="nd-gate-getapp" />
    </GlassSheet>
  )
}

function Closed({ publicId, result }: { publicId: string; result: CloseAccepted }) {
  return (
    <GlassSheet
      testId="close-done"
      header={
        <div className="nd-headline">
          <h1>Drop closed</h1>
        </div>
      }
      caption="Nobody else can claim from this drop."
    >
      <Amount value={result.refund} className="nd-amount" data-size="md" />
      <p className="nd-note">
        {result.refundLuna === '0'
          ? 'Every share had been claimed, so there was nothing left to send back.'
          : 'is on its way back to the wallet that funded this drop. It is sent as an ordinary transaction, so it lands once the network confirms it.'}
      </p>
      {result.claimedShares > 0 ? (
        <p className="nd-note">
          The {result.claimedShares} {result.claimedShares === 1 ? 'share' : 'shares'} already
          claimed {result.claimedShares === 1 ? 'is' : 'are'} still being paid out in full.
        </p>
      ) : null}
      <p className="nd-note">
        <Link to={`/drop/${publicId}`}>See the drop</Link>
      </p>
    </GlassSheet>
  )
}

function Unavailable({ publicId, notice }: { publicId: string; notice: string }) {
  return (
    <GlassSheet
      testId="close-unavailable"
      header={
        <div className="nd-headline">
          <h1>Nothing to close</h1>
        </div>
      }
      caption={notice || 'This drop cannot be closed.'}
    >
      <p className="nd-note">
        <Link to={`/drop/${publicId}`}>See the drop</Link>
      </p>
    </GlassSheet>
  )
}

function pageUrl(publicId: string): string {
  if (typeof window === 'undefined') return `/drop/${publicId}/close`
  return `${window.location.origin}/drop/${publicId}/close`
}
