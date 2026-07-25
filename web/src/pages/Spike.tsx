/**
 * Task 7 device spike (design §2). Not product UI — this page exists to prove,
 * on a real phone inside Nimiq Pay, exactly what the provider returns from
 * `sign()` and `sendBasicTransactionWithData()`, and exactly how the
 * `nimiqpay://miniapp?url=…` deep link behaves on a cold open.
 *
 * The no-wallet branch is NOT throwaway: it is the production no-wallet screen
 * from design §4.1 being rehearsed early.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  BridgeError,
  getBridge,
  nimiqPayDeeplink,
  resolveBridge,
  type BridgeKind,
  type WalletBridge,
} from '../sdk/adapter'

/** 0.1 NIM in luna (1 NIM = 100_000 luna). */
const SPIKE_VALUE_LUNA = 10_000n
/** Funding memo shape is `ND1:<publicId>`; the spike uses a reserved public ID. */
const SPIKE_MEMO = 'ND1:spiketest'

/**
 * A frozen sample of the server's canonical challenge JSON
 * (`server/src/auth/challenge.ts` — ASCII-sorted keys, no whitespace). Fixed
 * values keep the captured device fixture reproducible.
 */
const CANONICAL_TEST_MESSAGE = JSON.stringify({
  action: 'claim',
  aud: 'https://nimdrops.example',
  drop: 'spiketest',
  exp: 1_800_000_300,
  iat: 1_800_000_000,
  net: 'TestAlbatross',
  nonce: 'c3Bpa2UtZml4ZWQtbm9uY2U',
  v: 1,
})

type Panel = { label: string; body: unknown } | null

function jsonify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v),
    2,
  )
}

function describeError(error: unknown): unknown {
  if (error instanceof BridgeError) {
    return { error: { name: error.name, type: error.type, op: error.op, message: error.message } }
  }
  if (error instanceof Error) return { error: { name: error.name, message: error.message } }
  return { error: String(error) }
}

function custodyFromQuery(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('custody')?.trim() ?? ''
}

const KIND_COPY: Record<BridgeKind, string> = {
  real: 'Nimiq Pay provider detected — calls hit the real wallet.',
  mock: 'No provider. DEV build, so a mock wallet is answering (never in production).',
  unavailable: 'No Nimiq Pay provider on this page.',
}

export function Spike() {
  const [kind, setKind] = useState<BridgeKind>(() => getBridge().kind)
  const [bridge, setBridge] = useState<WalletBridge | null>(() => {
    const initial = getBridge()
    return initial.kind === 'unavailable' ? null : initial.bridge
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [copied, setCopied] = useState(false)
  const custody = custodyFromQuery()
  const pageUrl = typeof window === 'undefined' ? '' : window.location.href
  const deeplink = nimiqPayDeeplink(pageUrl)

  // The synchronous snapshot above can miss a provider that is injected a beat
  // late; re-resolve once with the SDK's polling init().
  useEffect(() => {
    let live = true
    void resolveBridge().then((result) => {
      if (!live) return
      setKind(result.kind)
      setBridge(result.kind === 'unavailable' ? null : result.bridge)
    })
    return () => {
      live = false
    }
  }, [])

  const run = useCallback(
    async (label: string, fn: (b: WalletBridge) => Promise<unknown>) => {
      if (!bridge) {
        setPanel({ label, body: { error: 'no wallet bridge available' } })
        return
      }
      setBusy(label)
      setPanel(null)
      const startedAt = performance.now()
      try {
        const body = await fn(bridge)
        setPanel({ label, body: { ok: true, ms: Math.round(performance.now() - startedAt), body } })
      } catch (error) {
        setPanel({
          label,
          body: { ok: false, ms: Math.round(performance.now() - startedAt), ...(describeError(error) as object) },
        })
      } finally {
        setBusy(null)
      }
    },
    [bridge],
  )

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(pageUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [pageUrl])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 p-6 text-neutral-900">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">NimDrops device spike</h1>
        <p className="text-sm text-neutral-600">
          Records the provider shapes the adapter has to normalize.
        </p>
      </header>

      <section
        className="rounded-lg border border-neutral-300 bg-neutral-50 p-4"
        aria-live="polite"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Bridge</p>
        <p className="mt-1 font-mono text-sm">{kind}</p>
        <p className="mt-1 text-sm text-neutral-600">{KIND_COPY[kind]}</p>
      </section>

      {kind === 'unavailable' ? (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-4">
          <h2 className="text-base font-semibold">Open in Nimiq Pay</h2>
          <p className="text-sm text-neutral-600">
            This page needs the Nimiq Pay wallet. Open the link in Nimiq Pay, or copy it and paste
            it there.
          </p>
          <a
            className="rounded-md bg-neutral-900 px-4 py-3 text-center text-sm font-medium text-white"
            href={deeplink}
          >
            Open in Nimiq Pay
          </a>
          <button
            type="button"
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm font-medium"
            onClick={copyLink}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <p className="break-all font-mono text-xs text-neutral-500">{deeplink}</p>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <button
            type="button"
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm font-medium disabled:opacity-50"
            disabled={busy !== null}
            onClick={() =>
              void run('ready', async (b) => {
                await b.ready()
                return { ready: true }
              })
            }
          >
            1. init / ready state
          </button>

          <button
            type="button"
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm font-medium disabled:opacity-50"
            disabled={busy !== null}
            onClick={() =>
              void run('sign', async (b) => ({
                message: CANONICAL_TEST_MESSAGE,
                response: await b.sign(CANONICAL_TEST_MESSAGE),
              }))
            }
          >
            2. Sign canonical test message
          </button>

          <button
            type="button"
            className="rounded-md border border-neutral-300 px-4 py-3 text-sm font-medium disabled:opacity-50"
            disabled={busy !== null || custody === ''}
            onClick={() =>
              void run('sendWithData', async (b) => ({
                request: { recipient: custody, valueLuna: SPIKE_VALUE_LUNA, data: SPIKE_MEMO },
                response: await b.sendWithData({
                  recipient: custody,
                  valueLuna: SPIKE_VALUE_LUNA,
                  data: SPIKE_MEMO,
                }),
              }))
            }
          >
            3. Send 0.1 NIM with memo {SPIKE_MEMO}
          </button>
          <p className="text-xs text-neutral-500">
            {custody === '' ? (
              <>
                Add <code className="font-mono">?custody=NQ…</code> to the URL to enable the send
                test.
              </>
            ) : (
              <>
                Recipient <code className="font-mono break-all">{custody}</code>
              </>
            )}
          </p>
        </section>
      )}

      {busy !== null && <p className="text-sm text-neutral-600">Waiting on the wallet: {busy}…</p>}

      {panel !== null && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{panel.label} response</h2>
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-4 font-mono text-xs text-neutral-100">
            {jsonify(panel.body)}
          </pre>
        </section>
      )}

      <footer className="mt-auto text-xs text-neutral-500">
        <p className="break-all">Page URL: {pageUrl}</p>
        <p>
          Raw provider calls are also on <code className="font-mono">window.__nimiqRawLog</code>;
          mock calls on <code className="font-mono">window.__mockBridgeLog</code>.
        </p>
      </footer>
    </main>
  )
}

export default Spike
