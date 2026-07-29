import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { QrCodeIcon } from './icons'
import { NimMark } from './Nim'
import { GetNimiqPay } from './OpenInApp'
import {
  BURST_MS,
  buzzPlan,
  canVibrate,
  HOLD_MS,
  OPEN_BUZZ,
  SLOP_PX,
  type OpenAbility,
  type RevealPhase,
} from './reveal'

/**
 * The sealed envelope, the hold that opens it, and the gate they form in front
 * of the claim surface.
 *
 * ## The sequence, and the one rule that fixes it
 *
 *   full-screen sealed envelope → hold 2.5s → shake and haptics → burst →
 *   THE CLAIM SCREEN, with the amount → the primary action → Nimiq Pay signs
 *
 * The amount is revealed AFTER the envelope opens and BEFORE the wallet
 * signature. Both halves of that ordering are load-bearing. Holding the
 * envelope costs nothing, so gating the number behind it is ritual rather than
 * risk; asking a stranger to approve a transaction blind and telling them what
 * they got afterwards is what a scam does. So the ritual runs in front of the
 * money action, it does not replace it, and it does not gate it.
 *
 * ## Why concealing the amount is allowed here at all
 *
 * Concealment IS the lottery mechanic in WeChat's red packets, whose group
 * packets split a sum at random, so the covered number is a gamble. NimDrops
 * shares are fixed, equal and
 * pre-committed, and the sealed screen says so in words while the envelope is
 * still shut. Concealing a number that cannot vary risks nothing; it only
 * delays a fact by a couple of seconds, which is the difference between a
 * ritual and a draw.
 *
 * ## Thumb-first, because this is a phone
 *
 * The envelope IS the control — a 292x201 object, not a button under a picture
 * — so there is nothing to aim at. It sits in the bottom half of the screen,
 * inside a one-handed thumb's arc. `touch-action: none` on it means the browser
 * cannot decide mid-hold that the contact was the start of a scroll, and the
 * long-press furniture that Android and iOS fire on a held element (context
 * menu, callout, magnifier, text selection) is suppressed in CSS and in the
 * `contextmenu` handler. The pointer is captured and the slop radius is a
 * generous `SLOP_PX`, because a two-and-a-half-second hold from an ordinary
 * thumb drifts.
 *
 * ## The path that is not a hold
 *
 * With VoiceOver or TalkBack running, a plain press-and-hold never reaches this
 * element: the assistive layer intercepts touch, and the user would have to
 * know about double-tap-and-hold and be able to sustain it. That is a lockout
 * on the primary device, not a desktop inconvenience. So:
 *
 *   - the control is a real `<button>` whose name says what will happen;
 *   - a plain `click` — which is what an assistive double-tap, `Enter` and
 *     `Space` all produce — opens it with no timed gesture at all;
 *   - a second, plainly-labelled control ("Open it without holding") is in the
 *     DOM from the first render for assistive technology, and becomes visible
 *     to everyone after one early release, so a thumb that cannot sustain the
 *     hold is never stuck either.
 *
 * ## Opened is a STATE, and there are two ways to be in it
 *
 * `opened` is derived by the caller from whatever already marks the claim
 * resumed or settled — `gateOpened` in `pages/DropView.tsx` does it — and lands
 * straight on `children` with no burst, no focus move and no announcement. That
 * is what a reload, a resumed claim and every status poll tick must get. The
 * burst hangs off the USER's transition only, held in a ref that a re-render
 * cannot reset, so a poll ticking `reserved → confirming → paid` cannot re-fire
 * it, and neither can a drop projection arriving late and saying `expired`.
 *
 * Nothing that carries money is behind a transition, an `opacity: 0`, or a
 * class that arrives later: switch CSS animation off entirely and the opened
 * state still renders complete.
 */

export interface SealedEnvelopeProps {
  /** Whether a wallet can sign here at all. `sealed-only` never opens. */
  ability: OpenAbility
  /**
   * Opened for a reason that is not the ritual: a resumed claim, a settled one,
   * a dead end. Sets the state with no theatre, and may flip to true at any
   * time — a poll tick landing on `expired` must not fire a burst.
   */
  opened?: boolean
  /** The hold, in ms. `HOLD_MS` is what ships. */
  holdMs?: number
  /** Who sent this. Shown on the seal, because it is not the amount. */
  sponsor?: string
  /** Their own words. Also not the amount. */
  message?: string | null
  /**
   * The drop's payout is a score-derived fraction of the share (the trivia
   * gate). Only the sealed-only copy reads it: "every share is the same size"
   * is a promise this component must not make on a scored drop.
   */
  scored?: boolean
  /** For the sealed-only path: the QR and deep link. */
  publicId?: string
  deepLink?: string
  /**
   * Where the QR comes from. Defaults to the server route the claim screen
   * already uses; the dev route overrides it because a Vite dev server has no
   * backend behind it to render one.
   */
  qrSrc?: string
  /** Fires once, on the user's transition. */
  onOpen?: () => void
  /** The claim surface. Rendered only once the envelope is open. */
  children?: ReactNode
}

/** `(prefers-reduced-motion: reduce)`, live. Absent in jsdom, so guarded. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const list = query()
    if (!list) return
    const settle = () => setReduced(list.matches)
    settle()
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', settle)
      return () => list.removeEventListener('change', settle)
    }
    // Safari <14's spelling. The WebView is the constraint.
    list.addListener?.(settle)
    return () => list.removeListener?.(settle)
  }, [])
  return reduced
}

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

export default function SealedEnvelope({
  ability,
  opened: openedByClaim = false,
  holdMs = HOLD_MS,
  sponsor,
  message,
  scored = false,
  publicId,
  deepLink,
  qrSrc,
  onOpen,
  children,
}: SealedEnvelopeProps) {
  const reduced = useReducedMotion()
  const [openedByHand, setOpenedByHand] = useState(false)
  const [phase, setPhase] = useState<RevealPhase>('sealed')
  const [released, setReleased] = useState(false)
  const [burst, setBurst] = useState(false)
  const [qrBroken, setQrBroken] = useState(false)

  const button = useRef<HTMLButtonElement>(null)
  const openedPane = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const burstOrigin = useRef<BurstOrigin | null>(null)

  const opened = openedByClaim || openedByHand
  const openedNow = useRef(opened)
  openedNow.current = opened

  /**
   * The one flag the theatre hangs off, and the reason it is a ref rather than
   * derived state: it must survive every re-render a status poll causes, and it
   * must be false for every route into `opened` that the claimant did not take
   * with their own thumb.
   */
  const byHand = useRef(false)
  const burstTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const open = useCallback(() => {
    if (byHand.current || openedNow.current) return
    const rect = button.current?.getBoundingClientRect()
    if (rect?.width && rect.height) {
      burstOrigin.current = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
    }
    byHand.current = true
    setPhase('opened')
    setOpenedByHand(true)
    onOpen?.()
  }, [onOpen])

  const hold = useHoldToOpen({
    holdMs,
    enabled: ability === 'can-open' && !opened,
    reduced,
    onFinish: open,
    onHoldingChange: (holding) => setPhase(holding ? 'holding' : 'sealed'),
    onRelease: () => setReleased(true),
  })

  /**
   * The burst, the focus move and the announcement all hang off `byHand`, so
   * mounting into `opened` — or arriving there because the server said the
   * claim is already settled — does none of the three.
   */
  useEffect(() => {
    if (!opened || !byHand.current) return
    openedPane.current?.focus()
    if (reduced) return
    setBurst(true)
    burstTimer.current = setTimeout(() => setBurst(false), BURST_MS)
    return () => clearTimeout(burstTimer.current)
  }, [opened, reduced])

  useEffect(() => () => clearTimeout(burstTimer.current), [])

  if (opened) {
    return (
      <>
        {/*
          The claim surface, the moment the state says so. No animation on it,
          no transition it depends on, no class that arrives a frame later.
          `tabIndex={-1}` so the opening can hand focus to it, which is what
          carries the reveal to a screen reader.
        */}
        <div
          className="nd-revealed"
          ref={openedPane}
          tabIndex={-1}
          data-theatre={byHand.current ? 'true' : 'false'}
          data-testid="revealed"
        >
          {children}
        </div>
        {burst ? <Burst origin={burstOrigin.current} /> : null}
        {byHand.current ? (
          <p className="nd-sr" role="status">
            Envelope opened.
          </p>
        ) : null}
      </>
    )
  }

  const seconds = (holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)
  /*
   * Keep the sender recess in the layout from the first paint. `drop` can land
   * one request after the gate, and mounting this block only when that happens
   * made it look as though touching the envelope had summoned the sponsor.
   */
  const from = <Sender sponsor={sponsor} message={message} />

  if (ability === 'sealed-only') {
    return (
      <div className="nd-gate" data-phase="sealed-only" data-testid="reveal-stage">
        {from}
        {/*
          A PC cannot open this, because opening it ends in a Nimiq Pay
          signature and Nimiq Pay is a phone app. A phone browser outside the
          wallet has exactly the same problem, which is why this branches on the
          adapter and never on a viewport. So the envelope here is a FINISHED
          state and not a broken one: no press affordance, because an affordance
          that cannot fire is worse than none, and no warning colour and no
          "unsupported", because nothing has gone wrong.
        */}
        <div className="nd-env" data-static="true" data-testid="sealed-envelope">
          <Envelope label="Sealed" sub={scored ? 'A share of NIM' : 'A fixed share of NIM'} />
        </div>
        <p className="nd-gate-hint" data-testid="sealed-only">
          {scored
            ? 'Your score set the size of your share. Open it on the phone that has Nimiq Pay, and the envelope tells you the amount before you sign anything.'
            : 'Every share in this drop is the same size. Open it on the phone that has Nimiq Pay, and the envelope tells you the amount before you sign anything.'}
        </p>
        <div className="nd-gate-out">
          {deepLink ? (
            <a className="nd-action" href={deepLink}>
              Open in Nimiq Pay
            </a>
          ) : null}
          {publicId ? (
            <div className="nd-gate-qr">
              {/*
                A QR that fails to load must not leave a broken-image icon on
                the one screen a PC ever sees. The server renders this route, so
                it can be missing for an id it will not encode, for a stale
                cache, or for no network — and in every one of those cases the
                link is still the thing the person needs. So the fallback is the
                link itself, in text, selectable and wrapped, not an apology.
              */}
              {qrBroken ? (
                <p className="nd-gate-qr-fallback" data-testid="qr-fallback">
                  Type this link into the phone that has Nimiq Pay
                  <code>{claimUrl(publicId)}</code>
                </p>
              ) : (
                <>
                  <img
                    src={qrSrc ?? `/drop/${publicId}/qr.svg`}
                    alt="QR code for this drop's link"
                    width={168}
                    height={168}
                    onError={() => setQrBroken(true)}
                  />
                  <p>
                    <QrCodeIcon size={14} />
                    Scan with the phone that has Nimiq Pay
                  </p>
                </>
              )}
            </div>
          ) : null}
          <GetNimiqPay className="nd-gate-getapp" />
        </div>
      </div>
    )
  }

  return (
    <div className="nd-gate" data-phase={phase} data-testid="reveal-stage">
      {from}

      <button
        type="button"
        ref={button}
        className="nd-env"
        data-phase={phase}
        data-testid="hold-open"
        aria-describedby={hintId}
        style={{ '--hold-ms': `${holdMs}ms` } as CSSProperties}
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onLostPointerCapture={hold.onLostPointerCapture}
        onKeyDown={hold.onKeyDown}
        onClick={hold.onClick}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Envelope
          label={reduced ? 'Open the envelope' : 'Hold to open'}
          sub={reduced ? undefined : 'Nothing is signed yet'}
          progress
        />
      </button>

      <p className="nd-gate-hint" id={hintId}>
        {reduced
          ? 'A fixed share of NIM, the same for everyone who opens this link. Opening it signs nothing.'
          : `Press and hold the envelope for ${seconds} seconds, or press Enter. A fixed share of NIM, the same for everyone. Opening it signs nothing.`}
      </p>

      {/*
        The path that is not a hold, for anyone the hold does not work for: a
        screen reader intercepting the press, a thumb that cannot sustain it, a
        hand that shakes. In the accessibility tree from the first render, and
        on screen for everyone the moment one attempt ends early. No error copy
        and no penalty — letting go is not a mistake.
      */}
      <button
        type="button"
        className="nd-env-escape"
        data-shown={released ? 'true' : 'false'}
        data-testid="open-without-holding"
        onClick={open}
      >
        Open it without holding
      </button>
    </div>
  )
}

/**
 * Who sent this, and what they said. Neither is the amount, so both are allowed
 * on the sealed screen — and a stranger deciding whether to hold a thing for
 * two and a half seconds should know whose thing it is.
 *
 * On a recess rather than on the bare field: the "name unverified" chip is
 * secondary copy, the field's brightest pixel cannot carry secondary copy at
 * any alpha short of solid, and this block sits mid-screen where no scrim band
 * reaches it. `surface.contrast.test.ts` computes it there.
 */
function Sender({ sponsor, message }: { sponsor?: string; message?: string | null }) {
  return (
    <div className="nd-gate-from">
      <p className="nd-gate-who">
        {sponsor ? (
          <>
            <b>{sponsor}</b> sent you a NimDrop
            <span className="nd-chip">name unverified</span>
          </>
        ) : (
          <b>Sender details are arriving…</b>
        )}
      </p>
      {message ? <p className="nd-gate-msg">{message}</p> : null}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * The hold
 * ---------------------------------------------------------------------- */

interface HoldArgs {
  holdMs: number
  enabled: boolean
  reduced: boolean
  onFinish: () => void
  onHoldingChange: (holding: boolean) => void
  onRelease: () => void
}

/**
 * Press, progress, release, repeat.
 *
 * One `requestAnimationFrame` loop owns only the clock and the haptic rungs.
 * The material strain, shake, cracks and progress are CSS keyframes started by
 * the `holding` phase, so React renders twice per attempt and JavaScript never
 * writes a per-frame transform.
 *
 * Everything that can end a hold ends it the same way — pointer up, pointer
 * cancel, losing capture, drifting past the slop radius, `Escape`, the tab
 * going away, the window losing focus. There is one `cancel`.
 */
function useHoldToOpen({
  holdMs,
  enabled,
  reduced,
  onFinish,
  onHoldingChange,
  onRelease,
}: HoldArgs) {
  const frame = useRef(0)
  const startedAt = useRef(0)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const rung = useRef(0)
  const holding = useRef(false)
  const plan = useMemo(buzzPlan, [])

  const buzz = useCallback((pattern: number | number[]) => {
    if (typeof navigator === 'undefined' || !canVibrate(navigator)) return
    // Never read the return value: Chromium on a desktop returns `true` and
    // does nothing, and a WebView may accept the call and drop it.
    try {
      navigator.vibrate(pattern)
    } catch {
      /* A blocked or permission-gated vibrate must not take the hold with it. */
    }
  }, [])

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])

  const cancel = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    stop()
    buzz(0)
    onHoldingChange(false)
    onRelease()
  }, [stop, buzz, onHoldingChange, onRelease])

  const finish = useCallback(() => {
    holding.current = false
    stop()
    buzz([...OPEN_BUZZ])
    onHoldingChange(false)
    onFinish()
  }, [stop, buzz, onHoldingChange, onFinish])

  const tick = useCallback(() => {
    const elapsed = now() - startedAt.current
    const value = Math.min(1, elapsed / holdMs)

    while (rung.current < plan.length && value >= plan[rung.current].at) {
      buzz(plan[rung.current].ms)
      rung.current += 1
    }

    if (value >= 1) finish()
    else frame.current = requestAnimationFrame(tick)
  }, [holdMs, plan, buzz, finish])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Under reduced motion there is no hold at all; the click below opens it.
      if (!enabled || reduced) return
      // Only the primary contact, and never a right-click.
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      stop()
      origin.current = { x: event.clientX, y: event.clientY }
      startedAt.current = now()
      rung.current = 0
      holding.current = true
      onHoldingChange(true)
      frame.current = requestAnimationFrame(tick)
    },
    [enabled, reduced, stop, onHoldingChange, tick],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const from = origin.current
      if (!holding.current || !from) return
      const dx = event.clientX - from.x
      const dy = event.clientY - from.y
      if (dx * dx + dy * dy > SLOP_PX * SLOP_PX) cancel()
    },
    [cancel],
  )

  const onPointerUp = useCallback(() => cancel(), [cancel])
  const onPointerCancel = useCallback(() => cancel(), [cancel])
  const onLostPointerCapture = useCallback(() => cancel(), [cancel])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape') cancel()
    },
    [cancel],
  )

  /**
   * The path that is not a hold.
   *
   * `detail === 0` is a click that came from a key or from assistive
   * technology rather than from a pointer, which is precisely the case that
   * must not require a sustained gesture. A pointer's own click — `detail >= 1`
   * — is the tail of a press this hook has already handled, and is ignored.
   *
   * Under reduced motion every click opens it, because there is no hold to be
   * the tail of.
   */
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!enabled) return
      if (reduced || event.detail === 0) onFinish()
    },
    [enabled, reduced, onFinish],
  )

  /** A hold cannot survive the tab going away or the window losing focus. */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bail = () => cancel()
    window.addEventListener('blur', bail)
    document.addEventListener('visibilitychange', bail)
    return () => {
      window.removeEventListener('blur', bail)
      document.removeEventListener('visibilitychange', bail)
    }
  }, [cancel])

  /** A server state can open the gate while a thumb is still down. Stop that
      stale clock before it can later misclassify the poll tick as a hand-open. */
  useEffect(() => {
    if (enabled || !holding.current) return
    holding.current = false
    stop()
    buzz(0)
  }, [enabled, stop, buzz])

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      if (typeof navigator !== 'undefined' && canVibrate(navigator)) {
        try {
          navigator.vibrate(0)
        } catch {
          /* nothing to undo */
        }
      }
    },
    [],
  )

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onKeyDown,
    onClick,
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** The link the QR encodes, for when the QR itself cannot be drawn. */
function claimUrl(publicId: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/drop/${publicId}`
}

/* -------------------------------------------------------------------------
 * The paper
 * ---------------------------------------------------------------------- */

interface EnvelopeProps {
  label: string
  sub?: string
  /** Draws the ring and the foil bar that fill as the hold progresses. */
  progress?: boolean
}

/**
 * The envelope, in five spans and one circle.
 *
 * Not one hex anywhere: the face, the flap, the foil and the ink are all
 * palette tokens (`--nd-env-*` in `index.css`), because the wax is the last
 * gold on the surface and its legality is arithmetic rather than taste.
 */
function Envelope({ label, sub, progress }: EnvelopeProps) {
  return (
    <>
      {/* The button stays still under the thumb; the physical packet moves
          inside it. Every decorative layer is hidden from the accessibility
          tree because the control's name carries the instruction. */}
      <span className="nd-env-aura" aria-hidden="true" />
      <span className="nd-env-shake" aria-hidden="true">
        <span className="nd-env-contact" />
        <span className="nd-env-object">
          <span className="nd-env-back" />
          <span className="nd-env-liner" />
          <span className="nd-env-flap">
            <span className="nd-env-flap-front" />
            <span className="nd-env-flap-back" />
          </span>
          <span className="nd-env-pocket">
            <span className="nd-env-fold is-left" />
            <span className="nd-env-fold is-right" />
            <span className="nd-env-paper-grain" />
          </span>
          <span className="nd-env-paper-edge" />
          <span className="nd-env-seal">
            {progress ? (
              <svg className="nd-env-ring" viewBox="0 0 100 100" aria-hidden="true">
                <circle className="nd-env-ring-track" cx="50" cy="50" r="45" />
                <circle className="nd-env-ring-fill" cx="50" cy="50" r="45" />
              </svg>
            ) : null}
            <span className="nd-env-seal-foil">
              <NimMark tone="ink" height="21px" />
            </span>
            <span className="nd-env-crack is-one" />
            <span className="nd-env-crack is-two" />
          </span>
        </span>
      </span>
      <span className="nd-env-label">
        {label}
        {sub ? <em>{sub}</em> : null}
      </span>
      {progress ? (
        <span className="nd-env-bar" aria-hidden="true">
          <span className="nd-env-fill" />
        </span>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------------
 * The burst
 * ---------------------------------------------------------------------- */

/**
 * A breaking packet, four foil shards and eight high-value particles.
 *
 * No canvas and no dependency: twelve absolutely positioned pieces, each
 * running one keyframe. The physical packet is four spans; its faces and edge
 * are pseudo-elements, so the entire burst subtree is seventeen elements
 * including its root. It unmounts itself on the timer in the component above.
 *
 * The container is fixed and clipped to the viewport, which is what stops the
 * pieces handing the document horizontal scroll at the exact second everyone
 * is looking.
 *
 * `aria-hidden`, and every fact it celebrates is also on screen in words, which
 * is what makes deleting it under reduced motion a free choice rather than a
 * loss.
 */
interface BurstOrigin {
  left: number
  top: number
  width: number
  height: number
}

function Burst({ origin }: { origin: BurstOrigin | null }) {
  const style = origin
    ? ({
        '--burst-left': `${origin.left}px`,
        '--burst-top': `${origin.top}px`,
        '--burst-width': `${origin.width}px`,
        '--burst-height': `${origin.height}px`,
        '--burst-x': `${origin.left + origin.width / 2}px`,
        '--burst-y': `${origin.top + origin.height * 0.62}px`,
      } as CSSProperties)
    : undefined

  return (
    <span className="nd-burst" aria-hidden="true" data-testid="burst" style={style}>
      <span className="nd-break">
        <span className="nd-break-object">
          <span className="nd-break-liner" />
          <span className="nd-break-flap" />
        </span>
      </span>
      {BURST_FIELD.map((piece, i) => (
        <span
          key={i}
          className="nd-bit"
          data-kind={piece.kind}
          data-tone={piece.tone}
          style={vars(piece)}
        />
      ))}
    </span>
  )
}

interface BurstPiece {
  kind: 'wax' | 'confetti'
  tone: number
  round: 0 | 1
  /** First 60–120ms: the violent release. */
  x1: number
  y1: number
  /** Apex after horizontal velocity has already started bleeding off. */
  mx: number
  my: number
  /** Resting fall position. The clipped field owns anything beyond it. */
  dx: number
  dy: number
  mrot: number
  rot: number
  dur: number
  delay: number
  size: number
  ease: string
}

/*
 * Hand-authored rather than evenly fanned. Departures cluster at
 * 0/7/13ms and 9/16/24ms, then break into an irregular tail. The values are
 * deliberately asymmetric: each piece has its own launch, apex, fall, spin,
 * size, duration and hard-out curve, while remaining deterministic.
 */
const BURST_FIELD: readonly BurstPiece[] = [
  {
    kind: 'wax',
    tone: 4,
    round: 0,
    x1: -58,
    y1: -35,
    mx: -101,
    my: -79,
    dx: -142,
    dy: 132,
    mrot: -84,
    rot: -286,
    dur: 680,
    delay: 0,
    size: 29,
    ease: 'cubic-bezier(0.12, 0.82, 0.22, 1)',
  },
  {
    kind: 'wax',
    tone: 4,
    round: 0,
    x1: 47,
    y1: -48,
    mx: 83,
    my: -118,
    dx: 119,
    dy: 164,
    mrot: 71,
    rot: 238,
    dur: 810,
    delay: 7,
    size: 20,
    ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  {
    kind: 'wax',
    tone: 4,
    round: 0,
    x1: -31,
    y1: -58,
    mx: -55,
    my: -96,
    dx: -78,
    dy: 96,
    mrot: 126,
    rot: 402,
    dur: 735,
    delay: 13,
    size: 32,
    ease: 'cubic-bezier(0.1, 0.86, 0.24, 1)',
  },
  {
    kind: 'wax',
    tone: 4,
    round: 0,
    x1: 61,
    y1: -24,
    mx: 108,
    my: -61,
    dx: 154,
    dy: 181,
    mrot: -46,
    rot: -173,
    dur: 915,
    delay: 61,
    size: 24,
    ease: 'cubic-bezier(0.14, 0.92, 0.28, 1)',
  },
  {
    kind: 'confetti',
    tone: 0,
    round: 0,
    x1: -68,
    y1: -51,
    mx: -119,
    my: -131,
    dx: -166,
    dy: 156,
    mrot: -102,
    rot: -338,
    dur: 745,
    delay: 9,
    size: 15,
    ease: 'cubic-bezier(0.13, 0.9, 0.2, 1)',
  },
  {
    kind: 'confetti',
    tone: 2,
    round: 1,
    x1: -39,
    y1: -31,
    mx: -70,
    my: -82,
    dx: -104,
    dy: 108,
    mrot: 76,
    rot: 267,
    dur: 690,
    delay: 16,
    size: 10,
    ease: 'cubic-bezier(0.18, 1, 0.28, 1)',
  },
  {
    kind: 'confetti',
    tone: 1,
    round: 0,
    x1: -12,
    y1: -63,
    mx: -24,
    my: -151,
    dx: -41,
    dy: 191,
    mrot: -164,
    rot: -512,
    dur: 902,
    delay: 24,
    size: 13,
    ease: 'cubic-bezier(0.11, 0.84, 0.23, 1)',
  },
  {
    kind: 'confetti',
    tone: 3,
    round: 0,
    x1: 23,
    y1: -45,
    mx: 43,
    my: -101,
    dx: 66,
    dy: 137,
    mrot: 119,
    rot: 386,
    dur: 778,
    delay: 43,
    size: 8,
    ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  {
    kind: 'confetti',
    tone: 0,
    round: 1,
    x1: 54,
    y1: -55,
    mx: 96,
    my: -124,
    dx: 139,
    dy: 174,
    mrot: -97,
    rot: -309,
    dur: 842,
    delay: 71,
    size: 16,
    ease: 'cubic-bezier(0.12, 0.88, 0.21, 1)',
  },
  {
    kind: 'confetti',
    tone: 2,
    round: 0,
    x1: 67,
    y1: -26,
    mx: 119,
    my: -69,
    dx: 169,
    dy: 101,
    mrot: 68,
    rot: 221,
    dur: 716,
    delay: 78,
    size: 11,
    ease: 'cubic-bezier(0.17, 0.96, 0.31, 1)',
  },
  {
    kind: 'confetti',
    tone: 1,
    round: 1,
    x1: 34,
    y1: -66,
    mx: 62,
    my: -143,
    dx: 91,
    dy: 207,
    mrot: 151,
    rot: 489,
    dur: 936,
    delay: 123,
    size: 14,
    ease: 'cubic-bezier(0.1, 0.86, 0.22, 1)',
  },
  {
    kind: 'confetti',
    tone: 3,
    round: 0,
    x1: -51,
    y1: -39,
    mx: -91,
    my: -109,
    dx: -134,
    dy: 219,
    mrot: -132,
    rot: -431,
    dur: 904,
    delay: 169,
    size: 9,
    ease: 'cubic-bezier(0.15, 0.94, 0.26, 1)',
  },
] as const

function vars(piece: BurstPiece): CSSProperties {
  return {
    '--x1': `${piece.x1}px`,
    '--y1': `${piece.y1}px`,
    '--mx': `${piece.mx}px`,
    '--my': `${piece.my}px`,
    '--r1': `${piece.mrot * 0.3}deg`,
    '--dx': `${piece.dx}px`,
    '--dy': `${piece.dy}px`,
    '--mrot': `${piece.mrot}deg`,
    '--rot': `${piece.rot}deg`,
    '--dur': `${piece.dur}ms`,
    '--delay': `${piece.delay}ms`,
    '--size': `${piece.size}px`,
    '--round': piece.round ? '50%' : '2px',
    '--fly-ease': piece.ease,
  } as CSSProperties
}
