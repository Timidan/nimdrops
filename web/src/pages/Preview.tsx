import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClaimServerState, DropPublic } from '../api'
import type { ClaimUiState } from '../state/claim'
import DropView from './DropView'

/**
 * DEV-ONLY. Every state of the envelope, side by side, at the widths a phone
 * actually is.
 *
 * `App.tsx` mounts this behind `import.meta.env.DEV`, which Vite replaces with
 * the literal `false` in a production build, so the branch and this whole
 * module are dead code the bundler drops. `PREVIEW_SENTINEL` exists so that
 * claim is verifiable rather than assumed: grep `web/dist` for it after a
 * build and it must not be there.
 */
const PREVIEW_SENTINEL = 'nd-preview-only-surface'

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const TX_HASH = 'b'.repeat(64)

function drop(over: Partial<DropPublic> = {}): DropPublic {
  return {
    publicId: PUBLIC_ID,
    sponsorLabel: 'Team NimDrops',
    message: 'Thanks for a good week',
    amountEach: '2',
    claimCount: 5,
    remaining: 3,
    state: 'live',
    expiresAt: new Date(Date.now() + 84_000_000).toISOString(),
    ...over,
  }
}

interface Case {
  name: string
  note?: string
  state: ClaimUiState
  drop?: DropPublic | null
  serverState?: ClaimServerState | null
  txHash?: string | null
  amountEach?: string | null
  notice?: string
}

const LONG_SPONSOR =
  'The Thursday Evening Nimiq Meetup, Community Chapter of Greater Amsterdam and Surrounds'

const LONG_MESSAGE =
  'Thanks for a genuinely good week, everyone. This is a small thank-you from the whole team for shipping the migration on time, staying calm through the incident on Tuesday, and covering for each other while half of us were out sick. Enjoy.'

const CASES: Case[] = [
  { name: 'loading', state: 'loading', drop: null },
  { name: 'ready', state: 'ready' },
  { name: 'signing', state: 'signing' },
  { name: 'no-wallet', state: 'no-wallet' },
  { name: 'degraded', state: 'degraded' },
  { name: 'reserved', state: 'reserved', serverState: 'reserved' },
  { name: 'confirming', state: 'confirming', serverState: 'sending' },
  { name: 'confirming (manual review)', state: 'confirming', serverState: 'manual_review' },
  { name: 'paid', state: 'paid', serverState: 'paid', txHash: TX_HASH },
  {
    name: 'paid (hash still syncing)',
    state: 'paid',
    serverState: 'paid',
    txHash: null,
  },
  { name: 'rejected', state: 'rejected', notice: 'Your wallet closed without approving.' },
  { name: 'exhausted', state: 'exhausted', drop: drop({ remaining: 0 }) },
  { name: 'expired', state: 'expired', drop: drop({ state: 'settled' }) },
  { name: 'paused', state: 'paused' },
  {
    name: 'ready · long sponsor + 240-char message',
    note: 'three-line label, clamped to two; message wraps',
    state: 'ready',
    drop: drop({ sponsorLabel: LONG_SPONSOR, message: LONG_MESSAGE }),
  },
  {
    name: 'ready · 10000.00000 NIM',
    note: 'longest amount the create cap allows to be typed',
    state: 'ready',
    drop: drop({ amountEach: '10000.00000', claimCount: 100, remaining: 97 }),
  },
  {
    name: 'ready · no message, expiring soon',
    state: 'ready',
    drop: drop({ message: null, expiresAt: new Date(Date.now() + 240_000).toISOString() }),
  },
]

/** The phones this has to survive: smallest, iPhone SE/mini, the 390 reference, largest. */
const WIDTHS = [320, 375, 390, 430] as const

/**
 * A frame that reports on itself. Horizontal overflow at 320px is the mobile
 * bug you cannot see by looking — the container just scrolls — so the frame
 * measures its own content and says so out loud.
 */
function Frame({ width, children }: { width: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(0)

  useEffect(() => {
    const measure = () => {
      const el = box.current
      if (el) setOver(Math.max(0, el.scrollWidth - el.clientWidth))
    }
    measure()
    // Web fonts and the countdown both settle a tick late.
    const timer = setTimeout(measure, 400)
    return () => clearTimeout(timer)
  })

  return (
    <>
      <div ref={box} className="frame" style={{ width }}>
        {children}
      </div>
      <p className={over > 0 ? 'over bad' : 'over'}>
        {over > 0 ? `overflows by ${over}px` : `fits ${width}px`}
      </p>
    </>
  )
}

/** `?w=320` so a specific width can be linked, screenshotted, or shared. */
function initialWidth(): number {
  const asked = Number(new URLSearchParams(window.location.search).get('w'))
  return WIDTHS.includes(asked as (typeof WIDTHS)[number]) ? asked : 390
}

export default function Preview() {
  const [width, setWidth] = useState<number>(initialWidth)
  /** Bumping this remounts every frame, which replays the reveal. */
  const [run, setRun] = useState(0)
  const [opened, setOpened] = useState(false)

  // The reveal cell plays itself shortly after mount, so "replay reveal" is a
  // real replay and the moment is watchable without hunting for a button.
  useEffect(() => {
    setOpened(false)
    const timer = setTimeout(() => setOpened(true), 900)
    return () => clearTimeout(timer)
  }, [run])

  return (
    <div className={PREVIEW_SENTINEL} style={{ background: '#0f1230', minHeight: '100vh' }}>
      <style>{`
        .${PREVIEW_SENTINEL} { color: #e7e4dc; font: 13px/1.4 system-ui, sans-serif; }
        .${PREVIEW_SENTINEL} .bar { position: sticky; top: 0; z-index: 10; display: flex;
          flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px;
          background: #0f1230; border-bottom: 1px solid #2a2f5c; }
        .${PREVIEW_SENTINEL} .bar button { border: 1px solid #3a4079; background: #1a1f47;
          color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; cursor: pointer; }
        .${PREVIEW_SENTINEL} .bar button[aria-pressed='true'] { background: #e9b213; color: #1f2348;
          border-color: #e9b213; }
        .${PREVIEW_SENTINEL} .rail { display: flex; flex-wrap: wrap; gap: 20px;
          padding: 20px 16px 48px; align-items: flex-start; }
        .${PREVIEW_SENTINEL} .cell { flex: 0 0 auto; }
        .${PREVIEW_SENTINEL} .cap { margin-bottom: 6px; }
        .${PREVIEW_SENTINEL} .cap b { font-weight: 600; }
        .${PREVIEW_SENTINEL} .cap span { color: #9aa0cc; }
        .${PREVIEW_SENTINEL} .frame { height: 780px; overflow: auto; border-radius: 10px;
          outline: 1px solid #2a2f5c; }
        .${PREVIEW_SENTINEL} .frame .nd-field { min-height: 100%; }
        .${PREVIEW_SENTINEL} .over { margin-top: 5px; color: #6f77ab; font-size: 11px; }
        .${PREVIEW_SENTINEL} .over.bad { color: #ff8f6b; font-weight: 700; }
      `}</style>

      <div className="bar">
        <b>Envelope states</b>
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={width === w}
            onClick={() => setWidth(w)}
          >
            {w}px
          </button>
        ))}
        <button type="button" aria-pressed={opened} onClick={() => setOpened((v) => !v)}>
          {opened ? 'sealed → opened (on)' : 'force open transition'}
        </button>
        <button type="button" onClick={() => setRun((n) => n + 1)}>
          replay reveal
        </button>
        <span style={{ color: '#9aa0cc' }}>
          dev-only route · reduced motion: toggle it in the OS and reload
        </span>
      </div>

      <div className="rail">
        {/* The signature moment goes first: one frame that starts sealed and
            opens on its own, so the flap, the breaking wax and the single gold
            bloom can all be watched rather than inferred. */}
        <div className="cell" style={{ width }}>
          <p className="cap">
            <b>reveal</b> <span>— ready → reserved, seal breaks once</span>
          </p>
          <Frame width={width}>
            <DropView
              key={`reveal:${run}`}
              publicId={PUBLIC_ID}
              state={opened ? 'reserved' : 'ready'}
              drop={drop()}
              serverState={opened ? 'reserved' : null}
              txHash={null}
              amountEach="2"
              notice=""
              onClaim={() => setOpened(true)}
              onRetry={() => setOpened(false)}
            />
          </Frame>
        </div>

        {CASES.map((c) => (
          <div className="cell" key={c.name} style={{ width }}>
            <p className="cap">
              <b>{c.name}</b>
              {c.note ? <span> — {c.note}</span> : null}
            </p>
            <Frame width={width}>
              <DropView
                key={`${c.name}:${run}`}
                publicId={PUBLIC_ID}
                state={c.state}
                drop={c.drop === undefined ? drop() : c.drop}
                serverState={c.serverState ?? null}
                txHash={c.txHash ?? null}
                amountEach={(c.drop === undefined ? drop() : c.drop)?.amountEach ?? '2'}
                notice={c.notice ?? ''}
                onClaim={() => {}}
                onRetry={() => {}}
              />
            </Frame>
          </div>
        ))}
      </div>
    </div>
  )
}
