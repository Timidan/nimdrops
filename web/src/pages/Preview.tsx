import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClaimServerState, DropPublic } from '../api'
import type { ClaimUiState } from '../state/claim'
import DropView from './DropView'

/**
 * DEV-ONLY. Every claim state, side by side, at the widths a phone actually is.
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
  {
    // The live-phone defect: a shared link to a campaign the sponsor created
    // but never paid for. No transaction exists, so there is no claim button.
    //
    // `expiresAt: null` because the server only sets an expiry at activation —
    // a countdown on these two would be a fixture inventing a fact.
    name: 'awaiting-funding',
    note: 'sponsor has not paid yet — sealed, no dead button',
    state: 'awaiting-funding',
    drop: drop({ state: 'awaiting_funding', remaining: 5, expiresAt: null }),
  },
  {
    // Still `loading` in the machine, because this one resolves on its own.
    name: 'funding confirming',
    note: "the sponsor's funding tx is on the network",
    state: 'loading',
    drop: drop({ state: 'funding_pending', remaining: 5, expiresAt: null }),
  },
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

/**
 * The phones this has to survive, plus the two widths that prove the poster:
 * 768 is where the container query has not fired and 1280 is where it has.
 */
const WIDTHS = [320, 375, 390, 430, 768, 1280] as const

/** How long each frame keeps watching after a (re)start of the reveal. */
const WATCH_MS = 4000

/**
 * A frame that reports on itself. Horizontal overflow at 320px is the mobile
 * bug you cannot see by looking — the container just scrolls — so the frame
 * measures its own content and says so out loud.
 *
 * It reports the WORST it has ever seen, sampled every animation frame, not
 * whatever happens to be true when a one-shot measurement lands. That is the
 * whole difference between catching the reveal's overflow and missing it: the
 * gold bloom that used to push the paper ~100px wide lived for 900ms and was
 * unmounted again long before a `setTimeout(400)` could see it. A surface that
 * scrolls sideways for half a second scrolled sideways.
 */
function Frame({
  width,
  resetKey,
  children,
}: {
  width: number
  resetKey: number
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(0)

  useEffect(() => {
    setOver(0)
    let raf = 0
    const until = performance.now() + WATCH_MS
    const tick = (now: number) => {
      const el = box.current
      // A functional max means React bails out on every frame that is no worse
      // than the last, so watching every frame costs no renders.
      if (el) setOver((worst) => Math.max(worst, el.scrollWidth - el.clientWidth))
      if (now < until) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [width, resetKey])

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

/**
 * The board's own sideways scroll, watched the same way.
 *
 * Each `.frame` is a scroll container, which means it ABSORBS the overflow it
 * measures — the cell reports 107px while the page underneath reports nothing.
 * That is the right answer for the app and the wrong answer for the board, so
 * the document gets its own readout. It is also the honest place to catch the
 * board's own layout: a 390px cell in a 390px viewport has no room for a
 * gutter, and a hardcoded one would make this page scroll sideways while the
 * cells all read "fits".
 */
function PageOverflow({ resetKey }: { resetKey: number }) {
  const [over, setOver] = useState(0)

  useEffect(() => {
    setOver(0)
    let raf = 0
    const until = performance.now() + WATCH_MS
    const tick = (now: number) => {
      const doc = document.documentElement
      const worstNow = Math.max(
        doc.scrollWidth - doc.clientWidth,
        document.body.scrollWidth - document.body.clientWidth,
      )
      setOver((worst) => Math.max(worst, worstNow))
      if (now < until) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [resetKey])

  return (
    <span
      data-testid="page-overflow"
      style={{
        marginLeft: 'auto',
        fontWeight: over > 0 ? 700 : 400,
        color: over > 0 ? '#ff8f6b' : '#6f77ab',
      }}
    >
      {over > 0 ? `PAGE SCROLLS SIDEWAYS by ${over}px` : 'page: no sideways scroll'}
    </span>
  )
}

/**
 * The board's gutter, in px, and never more than the viewport can spare.
 *
 * `documentElement.clientWidth` rather than `100vw` on purpose: it is the only
 * one of the two that already excludes a classic scrollbar, and a gutter
 * computed from the wrong number is exactly how a states board ends up
 * reporting a defect it caused itself.
 */
function useGutter(cellWidth: number): number {
  const [gutter, setGutter] = useState(0)

  useEffect(() => {
    const measure = () =>
      setGutter(Math.max(0, Math.min(16, Math.floor((document.documentElement.clientWidth - cellWidth) / 2))))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [cellWidth])

  return gutter
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
  const gutter = useGutter(width)

  // The reveal cell plays itself shortly after mount, so "replay reveal" is a
  // real replay and the moment is watchable without hunting for a button.
  //
  // `opened` has to be false in the SAME render that remounts the envelope.
  // Clearing it from an effect is a render too late: the fresh envelope mounts
  // already open, decides there is no seal left to break, and the bloom — the
  // one thing worth replaying — never appears at all.
  useEffect(() => {
    const timer = setTimeout(() => setOpened(true), 900)
    return () => clearTimeout(timer)
  }, [run])

  const replay = () => {
    setOpened(false)
    setRun((n) => n + 1)
  }

  return (
    <div className={PREVIEW_SENTINEL} style={{ background: '#0f1230', minHeight: '100vh' }}>
      <style>{`
        /* The board's own chrome, but the \`font\` shorthand cascades into the
           cells, so \`system-ui\` here silently re-imposed itself on every claim
           screen under review — and \`system-ui\` resolves to a MONOSPACE face on
           at least one machine this project is reviewed on. The app was right
           and the instrument was lying: the surface was judged as "basic" on a
           render the shipped page never produces. The board has to be held to
           the product's own stack. */
        .${PREVIEW_SENTINEL} { color: #e7e4dc; font: 13px/1.4 var(--font-sans); }
        .${PREVIEW_SENTINEL} .bar { position: sticky; top: 0; z-index: 10; display: flex;
          flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px;
          background: #0f1230; border-bottom: 1px solid #2a2f5c; }
        .${PREVIEW_SENTINEL} .bar button { border: 1px solid #3a4079; background: #1a1f47;
          color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; cursor: pointer; }
        .${PREVIEW_SENTINEL} .bar button[aria-pressed='true'] { background: #e9b213; color: #1f2348;
          border-color: #e9b213; }
        .${PREVIEW_SENTINEL} .rail { display: flex; flex-wrap: wrap; gap: 20px;
          padding: 20px 0 48px; align-items: flex-start; }
        .${PREVIEW_SENTINEL} .cell { flex: 0 0 auto; }
        .${PREVIEW_SENTINEL} .cap { margin-bottom: 6px; }
        .${PREVIEW_SENTINEL} .cap b { font-weight: 600; }
        .${PREVIEW_SENTINEL} .cap span { color: #9aa0cc; }
        .${PREVIEW_SENTINEL} .frame { height: 780px; overflow: auto; border-radius: 10px;
          outline: 1px solid #2a2f5c; }
        /* The field measures itself against the frame, not the viewport, so the
           poster composition can be watched at 1280 next to the phone at 390. */
        .${PREVIEW_SENTINEL} .frame .nd-field { min-height: 100%; }
        .${PREVIEW_SENTINEL} .over { margin-top: 5px; color: #6f77ab; font-size: 11px; }
        .${PREVIEW_SENTINEL} .over.bad { color: #ff8f6b; font-weight: 700; }
      `}</style>

      <div className="bar">
        <b>Claim states</b>
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
        <button type="button" onClick={replay}>
          replay reveal
        </button>
        <span style={{ color: '#9aa0cc' }}>
          dev-only route · reduced motion: toggle it in the OS and reload
        </span>
        <PageOverflow resetKey={run} />
      </div>

      <div className="rail" style={{ paddingLeft: gutter, paddingRight: gutter }}>
        {/* The signature moment goes first: one frame that starts sealed and
            opens on its own, so the ring and the field's warmer cast can be
            watched rather than inferred. */}
        <div className="cell" style={{ width }}>
          <p className="cap">
            <b>reveal</b> <span>— ready → reserved, the ring leaves once</span>
          </p>
          <Frame width={width} resetKey={run}>
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
            <Frame width={width} resetKey={run}>
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
