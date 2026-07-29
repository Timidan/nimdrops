import { useState } from 'react'
import { useParams } from 'react-router-dom'
import type { BridgeResult } from '../sdk/adapter'
import { useClaim } from '../state/claim'
import { readFunding } from '../state/funding'
import DropView from './DropView'

/**
 * The campaign page — the thing a stranger opens from a group chat
 * (design §4.1, §4.3, §4.4).
 *
 * Two decisions drive the screen this renders.
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
 *
 * The pixels live in `DropView`. This file is the claim machine and nothing
 * else, which is what lets `DropView.test.tsx` drive every state from
 * fixtures without a live claim in flight.
 */

export interface DropProps {
  /** Test seam; production uses the real provider discovery. */
  discoverBridge?: () => Promise<BridgeResult>
  pollMs?: number
}

/**
 * Is this the browser that funded this drop?
 *
 * The funding record is the only thing on the client that knows, and it is
 * written by the create flow the moment a funding transaction hash exists. It
 * decides one thing and one thing only: whether the sponsor's close link is
 * offered here. Nothing about the close itself is trusted to it — the server
 * verifies a signature from the funding address — so a wrong answer here costs
 * a link, never a refund.
 *
 * Read once, on mount. A record cannot appear while this page is open.
 */
function fundedHere(publicId: string): boolean {
  return readFunding()?.draft.publicId === publicId
}

export default function Drop({ discoverBridge, pollMs }: DropProps) {
  const { publicId = '' } = useParams()
  const claim = useClaim(publicId, {
    ...(discoverBridge ? { discoverBridge } : {}),
    ...(pollMs ? { pollMs } : {}),
  })
  const [sponsorHere] = useState(() => fundedHere(publicId))

  return (
    <DropView
      publicId={publicId}
      state={claim.state}
      drop={claim.drop}
      serverState={claim.serverState}
      txHash={claim.txHash}
      amountEach={claim.amountEach}
      notice={claim.notice}
      onClaim={() => void claim.claim()}
      onRetry={claim.retry}
      {...(sponsorHere ? { sponsorCloseHref: `/drop/${publicId}/close` } : {})}
    />
  )
}
