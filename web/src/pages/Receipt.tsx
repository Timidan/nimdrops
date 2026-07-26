import { Link } from 'react-router-dom'
import { explorerTxUrl } from '../state/claim'

/**
 * The proof a claimant keeps (design §4.3 step 5, §4.4 "persistent artifact").
 *
 * It is only ever rendered once the server has said `paid`, and everything on
 * it is checkable by someone who does not trust NimDrops: the amount, the
 * sponsor label (marked unverified, because it is just text the sponsor typed),
 * and the transaction on a public explorer.
 *
 * It does not restate the amount as a headline. The envelope it rises into has
 * that number printed on its face, under the gold keyline; saying it twice at
 * two sizes would read as two different facts.
 */
export interface ReceiptProps {
  publicId: string
  /** Decimal NIM, exactly what the server paid. */
  amountEach: string
  txHash: string | null
  sponsorLabel: string
}

/** Enough hash to compare against an explorer, short enough to read on a phone. */
function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`
}

export default function Receipt({ publicId, amountEach, txHash, sponsorLabel }: ReceiptProps) {
  return (
    <section aria-label="Claim receipt">
      <header className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <p className="rounded-full bg-ink px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide text-paper">
          Paid
        </p>
        <span className="text-xs text-ink/45">on the Nimiq blockchain</span>
      </header>

      <p className="mt-4 text-center text-sm leading-relaxed text-ink/60">
        Sent to your wallet — the same one that approved the signature.
      </p>

      <dl className="mt-6 divide-y divide-ink/10 rounded-3xl border border-ink/10 bg-white text-sm">
        <div className="flex items-baseline justify-between gap-3 px-4 py-3">
          <dt className="shrink-0 text-ink/55">From</dt>
          <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
            {sponsorLabel} <span className="text-xs text-ink/40">(unverified)</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 px-4 py-3">
          <dt className="shrink-0 text-ink/55">Transaction</dt>
          <dd className="min-w-0 text-right font-mono text-xs [overflow-wrap:anywhere]">
            {txHash ? shortHash(txHash) : 'confirmed — id syncing'}
          </dd>
        </div>
      </dl>

      {txHash ? (
        <a
          href={explorerTxUrl(txHash)}
          target="_blank"
          rel="noreferrer noopener"
          /* py-3 keeps the tap target past 44px; a link is a control too. */
          className="mt-3 block py-3 text-center text-sm font-semibold text-gold-deep underline underline-offset-4"
        >
          View on the Nimiq explorer
        </a>
      ) : null}

      <Link
        to={`/create?amount=${encodeURIComponent(amountEach)}`}
        className="nd-primary mt-6 block w-full text-center"
      >
        Drop one back
      </Link>
      <p className="mt-3 text-center text-xs text-ink/45">
        Campaign <code className="font-mono">{publicId.slice(0, 8)}…</code>
      </p>
    </section>
  )
}
