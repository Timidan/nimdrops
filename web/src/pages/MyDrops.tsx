import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getCreatorDrops,
  requestCreatorChallenge,
  type CreatorDrop,
  type CreatorDropList,
} from '../api'
import { canonicalDropUrl, dropShareData, shareOrCopy } from '../integrations/share'
import { nimiqPayDeeplink, resolveBridge, type BridgeResult } from '../sdk/adapter'
import Field from '../ui/Field'
import OpenInApp from '../ui/OpenInApp'

type Stage = 'idle' | 'connecting' | 'signing' | 'loading' | 'ready' | 'no-wallet'

export interface MyDropsProps {
  discoverBridge?: () => Promise<BridgeResult>
}

export default function MyDrops({ discoverBridge = resolveBridge }: MyDropsProps) {
  const [stage, setStage] = useState<Stage>('idle')
  const [result, setResult] = useState<CreatorDropList | null>(null)
  const [notice, setNotice] = useState('')
  const [sharedId, setSharedId] = useState<string | null>(null)
  const here = typeof window === 'undefined' ? '' : window.location.href

  async function load(): Promise<void> {
    setNotice('')
    setStage('connecting')

    let bridge: BridgeResult
    try {
      bridge = await discoverBridge()
    } catch {
      setStage('no-wallet')
      return
    }
    if (bridge.kind === 'unavailable') {
      setStage('no-wallet')
      return
    }

    try {
      await bridge.bridge.address()
      const challenge = await requestCreatorChallenge()
      setStage('signing')
      const signed = await bridge.bridge.sign(challenge.message)
      setStage('loading')
      setResult(
        await getCreatorDrops({
          message: challenge.message,
          publicKey: signed.publicKey,
          signature: signed.signature,
        }),
      )
      setStage('ready')
    } catch {
      setNotice('We could not verify that wallet. Nothing was sent. Try again when you are ready.')
      setStage('idle')
    }
  }

  if (stage === 'no-wallet') {
    return (
      <Field tone="quiet">
        <OpenInApp title="Manage your drops in Nimiq Pay" deepLink={nimiqPayDeeplink(here)} url={here}>
          <p>The funding wallet signs once so NimDrops can find the drops it paid for.</p>
          <p>No transaction is created and no NIM leaves your wallet.</p>
        </OpenInApp>
      </Field>
    )
  }

  const busy = stage === 'connecting' || stage === 'signing' || stage === 'loading'
  const liveCount = result?.drops.filter((drop) => drop.state === 'live').length ?? 0

  return (
    <Field tone={liveCount > 0 || result === null ? 'live' : 'quiet'}>
      <div className="nd-column">
        <main className="flex flex-1 flex-col px-5 pt-9 pb-12 text-chalk">
          <h1 className="text-2xl font-semibold tracking-tight">Your drops</h1>

          {stage !== 'ready' || result === null ? (
            <section data-testid="creator-auth" className="mt-5">
              <p className="max-w-[65ch] text-sm leading-relaxed text-chalk/65">
                Approve wallet access, then one signature, to see every funded drop from that
                account. This reads your history. It does not create a transaction or send NIM.
              </p>
              <button type="button" className="nd-action mt-7" disabled={busy} onClick={() => void load()}>
                {stage === 'signing'
                  ? 'Waiting for wallet…'
                  : stage === 'loading'
                    ? 'Loading your drops…'
                    : stage === 'connecting'
                      ? 'Opening wallet…'
                      : 'Show my drops'}
              </button>
              {notice ? (
                <p role="status" className="mt-4 text-sm leading-relaxed text-chalk/65">
                  {notice}
                </p>
              ) : null}
              <Link to="/create" className="nd-textlink mt-4 block text-center">
                Send a new drop instead
              </Link>
            </section>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-chalk/55">
                <span>{shortAddress(result.walletAddress)}</span>
                <span>
                  {result.drops.length} {result.drops.length === 1 ? 'drop' : 'drops'} · {liveCount} live
                </span>
              </div>

              {result.drops.length === 0 ? (
                <div data-testid="creator-empty" className="mt-10 border-y border-chalk/10 py-6">
                  <p className="text-sm font-semibold text-chalk/80">No funded drops from this wallet yet.</p>
                  <p className="mt-2 text-sm leading-relaxed text-chalk/60">
                    A drop appears here after its funding transaction is confirmed.
                  </p>
                  <Link to="/create" className="nd-action mt-6 text-center">
                    Send your first drop
                  </Link>
                </div>
              ) : (
                <ul data-testid="creator-drops" className="mt-7 divide-y divide-chalk/10 border-y border-chalk/10">
                  {result.drops.map((drop) => (
                    <li key={drop.publicId} className="py-5">
                      <DropRow
                        drop={drop}
                        shared={sharedId === drop.publicId}
                        onShare={() => {
                          const url = canonicalDropUrl(drop.publicId)
                          void shareOrCopy(dropShareData({ url, amount: drop.amountEach })).then((shareResult) => {
                            if (shareResult === 'shared' || shareResult === 'copied') setSharedId(drop.publicId)
                          })
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {result.truncated ? (
                <p className="mt-4 text-xs leading-relaxed text-chalk/55">
                  Showing your 100 most recent drops.
                </p>
              ) : null}

              <Link to="/create" className="nd-quiet mt-7 text-center">
                Send another drop
              </Link>
              <button
                type="button"
                className="nd-textlink mt-3 w-full text-center"
                onClick={() => {
                  setResult(null)
                  setStage('idle')
                  setSharedId(null)
                }}
              >
                Check another wallet
              </button>
            </>
          )}
        </main>
      </div>
    </Field>
  )
}

function DropRow({ drop, shared, onShare }: { drop: CreatorDrop; shared: boolean; onShare: () => void }) {
  const claimed =
    drop.claimCount === null || drop.remaining === null ? null : Math.max(0, drop.claimCount - drop.remaining)
  const canShare = drop.state === 'live'

  return (
    <article data-testid={`creator-drop-${drop.publicId}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight text-chalk/90">{drop.sponsorLabel}</h2>
          <p className="mt-1 text-xs text-chalk/50">Created {formatDate(drop.createdAt)}</p>
        </div>
        <span className="shrink-0 rounded-full border border-chalk/15 px-2.5 py-1 text-[0.6875rem] font-semibold text-chalk/70">
          {statusLabel(drop)}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-5 gap-y-2">
        <p>
          <strong className="nd-num text-xl font-semibold text-chalk">{drop.amountEach} NIM</strong>
          <span className="ml-1.5 text-xs text-chalk/50">each</span>
        </p>
        <p className="text-xs tabular-nums text-chalk/60">
          {claimed === null ? 'Open drop' : `${claimed} of ${drop.claimCount} claimed`}
        </p>
      </div>

      {drop.message ? <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-chalk/65">{drop.message}</p> : null}
      <p className="mt-3 text-xs text-chalk/50">{timingLabel(drop)}</p>

      <div className="mt-3 flex flex-wrap gap-x-5">
        <Link to={`/drop/${drop.publicId}`} className="nd-textlink">
          Open details
        </Link>
        {canShare ? (
          <button type="button" className="nd-textlink" onClick={onShare}>
            {shared ? 'Link ready' : 'Share link'}
          </button>
        ) : null}
        {drop.state === 'live' ? (
          <Link to={`/drop/${drop.publicId}/close`} className="nd-textlink">
            Close and refund
          </Link>
        ) : null}
      </div>
    </article>
  )
}

function shortAddress(address: string): string {
  const compact = address.replace(/\s/g, '')
  return compact.length > 12 ? `${compact.slice(0, 8)}…${compact.slice(-4)}` : compact
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'recently'
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

function statusLabel(drop: CreatorDrop): string {
  if (drop.state === 'live') return 'Live'
  if (drop.state === 'funding_pending') return 'Confirming'
  if (drop.state === 'closing') return 'Closing'
  if (drop.state === 'paused' || drop.state === 'manual_review') return 'Needs review'
  if (drop.closingReason === 'exhausted') return 'Claimed out'
  if (drop.closingReason === 'closed_by_sponsor') return 'Closed'
  if (drop.closingReason === 'expired') return 'Expired'
  if (drop.state === 'refunded') return 'Refunded'
  if (drop.state === 'cancelled') return 'Cancelled'
  return 'Finished'
}

function timingLabel(drop: CreatorDrop): string {
  if (drop.state === 'live' && drop.expiresAt) return `Ends ${formatDate(drop.expiresAt)}`
  if (drop.state === 'closing') return 'Unclaimed NIM is being returned'
  if (drop.state === 'refunded') return 'Unclaimed NIM returned to the funding wallet'
  if (drop.closingReason === 'exhausted') return 'Every share was claimed'
  return 'This drop is no longer accepting claims'
}
