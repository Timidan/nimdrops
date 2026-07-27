import { explorerTxUrl } from '../state/claim'
import { SuccessCheckIcon } from '../ui/icons'

/**
 * The proof a claimant keeps.
 *
 * It is only ever rendered once the server has said `paid`, and everything on
 * it is checkable by someone who does not trust NimDrops: the amount, the
 * sponsor label (marked unverified, because it is just text the sponsor typed),
 * and the transaction on a public explorer.
 *
 * It does not restate the amount as a headline. The plate it rises under has
 * that number on it, under the gold keyline; saying it twice at two sizes would
 * read as two different facts.
 */
export interface ReceiptProps {
  publicId: string
  txHash: string | null
  sponsorLabel: string
}

/** Enough hash to compare against an explorer, short enough to read on a phone. */
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
          <dd className="font-normal">
            {sponsorLabel} <span className="text-plate/60">(name unverified)</span>
          </dd>
        </div>
        <div className="nd-row">
          <dt>Transaction</dt>
          <dd className="font-mono text-xs">
            {txHash ? shortHash(txHash) : 'confirmed, id syncing'}
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
        Drop <code className="font-mono">{publicId.slice(0, 8)}…</code>
      </p>
    </section>
  )
}
