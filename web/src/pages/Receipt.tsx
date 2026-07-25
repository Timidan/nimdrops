import { Link } from 'react-router-dom'
import { explorerTxUrl } from '../state/claim'

/**
 * The proof a claimant keeps (design §4.3 step 5, §4.4 "persistent artifact").
 *
 * It is only ever rendered once the server has said `paid`, and everything on
 * it is checkable by someone who does not trust NimDrops: the amount, the
 * sponsor label (marked unverified, because it is just text the sponsor typed),
 * and the transaction on a public explorer.
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
      <header className="flex items-center gap-3">
        <p className="rounded-full bg-ink px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide text-paper">
          Paid
        </p>
        <span className="text-xs text-ink/45">on the Nimiq blockchain</span>
      </header>

      <h1 className="mt-5 text-4xl font-semibold tracking-tight tabular-nums">
        {amountEach} <span className="text-2xl font-medium text-ink/60">NIM</span>
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink/60">
        Sent to your wallet — the same one that approved the signature.
      </p>

      <dl className="mt-7 divide-y divide-ink/10 rounded-3xl border border-ink/10 bg-white text-sm">
        <div className="flex items-baseline justify-between px-4 py-3">
          <dt className="text-ink/55">From</dt>
          <dd className="text-right">
            {sponsorLabel} <span className="text-xs text-ink/40">(unverified)</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between px-4 py-3">
          <dt className="text-ink/55">Transaction</dt>
          <dd className="text-right font-mono text-xs">
            {txHash ? shortHash(txHash) : 'confirmed — id syncing'}
          </dd>
        </div>
      </dl>

      {txHash ? (
        <a
          href={explorerTxUrl(txHash)}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 block text-center text-sm font-semibold text-gold-deep underline underline-offset-4"
        >
          View on the Nimiq explorer
        </a>
      ) : null}

      <Link
        to={`/create?amount=${encodeURIComponent(amountEach)}`}
        className="nd-primary mt-8 block w-full text-center"
      >
        Drop one back
      </Link>
      <p className="mt-3 text-center text-xs text-ink/45">
        Campaign <code className="font-mono">{publicId.slice(0, 8)}…</code>
      </p>
    </section>
  )
}
