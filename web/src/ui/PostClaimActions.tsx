import { NIMIQ_ECOSYSTEM_LINKS } from '../integrations/nimiq'

const EXTERNAL_LINK_PROPS = {
  target: '_blank',
  rel: 'noopener noreferrer',
  referrerPolicy: 'no-referrer',
} as const

export default function PostClaimActions() {
  return (
    <section className="nd-panel mt-4" aria-labelledby="use-your-nim" data-testid="post-claim-actions">
      <h2 id="use-your-nim" className="text-center text-base font-semibold text-plate">
        Your NIM is ready to use
      </h2>
      <p className="nd-note mt-2 text-center">
        Keep it there, send NIM, or return to the wallet scanner to pay a NIM or supported Bitcoin
        Lightning request. You can also choose an independent next step below.
      </p>
      <div className="mt-4 grid gap-2">
        <a className="nd-quiet" href={NIMIQ_ECOSYSTEM_LINKS.spend.href} {...EXTERNAL_LINK_PROPS}>
          {NIMIQ_ECOSYSTEM_LINKS.spend.label}
        </a>
        <a className="nd-quiet" href={NIMIQ_ECOSYSTEM_LINKS.sell.href} {...EXTERNAL_LINK_PROPS}>
          {NIMIQ_ECOSYSTEM_LINKS.sell.label}
        </a>
      </div>
      <p className="nd-note mt-3 text-center">
        Selling leaves NimDrops and is handled by the provider you choose. Availability, minimums,
        fees, and identity checks vary. Your claim details are not added to either link.
      </p>
    </section>
  )
}
