import { explorerTxUrl } from '../state/claim'
import { SuccessCheckIcon } from '../ui/icons'

export interface ReceiptProps {
  publicId: string
  txHash: string | null
  sponsorLabel: string
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`
}

export default function Receipt({ publicId, txHash, sponsorLabel }: ReceiptProps) {
  return (
    <section aria-label="Claim receipt">
      <header className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <p className="nd-pill" data-tone="settled">
          <SuccessCheckIcon size={13} />
          Paid
        </p>
        <span className="nd-note">on the Nimiq blockchain</span>
      </header>

      <dl className="nd-rows mt-5">
        <div className="nd-row">
          <dt>From</dt>
          <dd>
            {sponsorLabel} <span className="text-(--nd-on-surface-muted)">(name unverified)</span>
          </dd>
        </div>
        <div className="nd-row">
          <dt>Transaction</dt>
          <dd className="nd-num text-xs">
            {txHash ? shortHash(txHash) : 'confirmed, waiting for the id'}
          </dd>
        </div>
      </dl>

      {txHash ? (
        <a
          href={explorerTxUrl(txHash)}
          target="_blank"
          rel="noreferrer noopener"
          /* `nd-textlink` keeps the tap target past 44px; a link is a control. */
          className="nd-textlink mt-1 block w-full text-center"
        >
          View on the Nimiq explorer
        </a>
      ) : null}

      {/* "Drop", not "Campaign": a gift is not a campaign, and "campaign" is
          sponsor-side vocabulary that a claimant never asked for.

          The two closing actions are NOT here. They belong to the screen, not
          to the receipt, and rendering one of them mid-artifact put the drop's
          id between two buttons. */}
      <p className="nd-note mt-1 text-center">
        Drop <span className="nd-num">{publicId.slice(0, 8)}…</span>
      </p>
    </section>
  )
}
