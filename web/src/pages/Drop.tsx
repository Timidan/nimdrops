import { useParams } from 'react-router-dom'
import type { BridgeResult } from '../sdk/adapter'
import { useClaim } from '../state/claim'
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
 * else, which is what lets `/preview` render every state from fixtures.
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
    />
  )
}
