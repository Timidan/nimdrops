import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { QrCodeIcon } from '../../ui/icons'
import { Amount, NimMark } from './nim'
import {
  BURST_MS,
  buzzPlan,
  canVibrate,
  confetti,
  HOLD_MS,
  OPEN_BUZZ,
  RELEASE_MS,
  shakeAt,
  shards,
  SLOP_PX,
  type OpenAbility,
  type Piece,
  type RevealPhase,
} from './reveal'

/**
 * DEV-ONLY. The sealed envelope, and the hold that opens it.
 *
 * ## The sequence, and the one rule that fixes it
 *
 *   sealed envelope → hold → shake and haptics → burst → THE AMOUNT → claim →
 *   Nimiq Pay signs
 *
 * The amount is revealed BEFORE the wallet signature and never after. Asking a
 * stranger to approve a transaction blind and then telling them what they got
 * is what a scam does. So the ritual runs in front of the money action; it does
 * not replace it and it does not gate it. Opening the envelope spends nothing,
 * signs nothing and cannot fail.
 *
 * ## Why concealing the amount is allowed here at all
 *
 * `docs/research/red-packet-ui-study.md` argues that concealment IS the lottery
 * mechanic. That is true of WeChat, whose group packets split a sum at random,
 * so the covered number is a gamble. NimDrops shares are fixed, equal and
 * pre-committed, and the screen says so in words while the envelope is still
 * sealed. Concealing a number that cannot vary risks nothing; it only delays a
 * fact by a couple of seconds, which is the difference between a ritual and a
 * draw.
 *
 * ## Thumb-first, because this is a phone
 *
 * The envelope IS the control — a 292x200 object, not a button under a picture
 * — so there is nothing to aim at. It sits in the bottom half of the stage,
 * inside a one-handed thumb's arc. `touch-action: none` on it means the browser
 * cannot decide mid-hold that the contact was the start of a scroll, and the
 * long-press furniture that Android and iOS fire on a held element (context
 * menu, callout, magnifier, text selection) is suppressed in CSS and in the
 * `contextmenu` handler. The pointer is captured and the slop radius is a
 * generous `SLOP_PX`, because a five-second hold from an ordinary thumb drifts.
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
 * ## Opened is a STATE
 *
 * `initialOpened` lands straight on the revealed amount with no burst and no
 * theatre, which is what a reload, a resumed claim or a poll tick must get. The
 * burst fires on the sealed → opened TRANSITION only. Nothing that carries
 * money is behind a transition, an `opacity: 0`, or a class that arrives later:
 * switch CSS animation off entirely and the revealed state still renders
 * complete.
 */

export interface SealedRevealProps {
  /** The figure, already formatted. Never rounded, never abbreviated. */
  amount: string
  /** The hold, in ms. Tunable — that is the entire point of the prototype. */
  holdMs?: number
  /** Whether a wallet can sign here at all. `sealed-only` never opens. */
  ability: OpenAbility
  /** Land on the opened state, with nothing to reveal. */
  initialOpened?: boolean
  /** For the sealed-only path: the QR the phone scans, and the deep link. */
  publicId?: string
  deepLink?: string
  /**
   * Where the QR comes from. Defaults to the server route the real claim screen
   * already uses, so integrating changes nothing; the dev route overrides it
   * because a Vite dev server has no backend behind it to render one.
   */
  qrSrc?: string
  /** Fires once, on the transition. */
  onOpen?: () => void
  /** True while the particles are alive, so the page can pause the field. */
  onBurst?: (bursting: boolean) => void
  /** The money action. Rendered only once the amount is on screen. */
  action?: ReactNode
  /** The palette's class prefix, so two of these on one page cannot collide. */
  prefix: string
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

export default function SealedReveal({
  amount,
  holdMs = HOLD_MS,
  ability,
  initialOpened = false,
  publicId,
  deepLink,
  qrSrc,
  onOpen,
  onBurst,
  action,
  prefix: p,
}: SealedRevealProps) {
  const reduced = useReducedMotion()
  const [opened, setOpened] = useState(initialOpened)
  const [phase, setPhase] = useState<RevealPhase>(initialOpened ? 'opened' : 'sealed')
  const [released, setReleased] = useState(false)
  const [burst, setBurst] = useState(false)
  const [qrBroken, setQrBroken] = useState(false)

  const button = useRef<HTMLButtonElement>(null)
  const shake = useRef<HTMLSpanElement>(null)
  const openedPane = useRef<HTMLDivElement>(null)
  const hintId = useId()

  /** True only for the sealed → opened transition, never for a mount. */
  const transitioned = useRef(false)
  const burstTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const open = useCallback(() => {
    if (transitioned.current || opened) return
    transitioned.current = true
    setPhase('opened')
    setOpened(true)
    onOpen?.()
  }, [onOpen, opened])

  const hold = useHoldToOpen({
    holdMs,
    enabled: ability === 'can-open' && !opened,
    reduced,
    button,
    shake,
    onFinish: open,
    onHoldingChange: (holding) => setPhase(holding ? 'holding' : 'sealed'),
    onRelease: () => setReleased(true),
  })

  /**
   * The burst, and the focus move, both hang off the transition rather than off
   * the phase, so mounting into `opened` does neither.
   */
  useEffect(() => {
    if (!opened || !transitioned.current) return
    openedPane.current?.focus()
    if (reduced) return
    setBurst(true)
    onBurst?.(true)
    burstTimer.current = setTimeout(() => {
      setBurst(false)
      onBurst?.(false)
    }, BURST_MS)
    return () => clearTimeout(burstTimer.current)
  }, [opened, reduced, onBurst])

  useEffect(() => () => clearTimeout(burstTimer.current), [])

  if (opened) {
    return (
      <div className={`${p}-rv-stage`} data-phase="opened" data-testid="reveal-stage">
        {/*
          The money. No animation on it, no transition it depends on, no class
          that arrives a frame later — it is simply here, the moment the state
          says it is. `tabIndex={-1}` so the opening can hand focus to it, which
          is what carries the reveal to a screen reader.
        */}
        <div className={`${p}-rv-plate`} ref={openedPane} tabIndex={-1} data-testid="revealed">
          <Amount value={amount} className={`${p}-rv-amount`} />
          <p className={`${p}-rv-platecap`}>The same for everyone who opens this link</p>
        </div>
        {burst ? <Burst p={p} /> : null}
        <p className={`${p}-rv-sr`} role="status">
          Envelope opened.
        </p>
        {action}
      </div>
    )
  }

  if (ability === 'sealed-only') {
    return (
      <div className={`${p}-rv-stage`} data-phase="sealed-only" data-testid="reveal-stage">
        {/*
          A PC cannot open this, because opening it ends in a Nimiq Pay
          signature and Nimiq Pay is a phone app. So the envelope here is a
          finished state and not a broken one: no press affordance, because an
          affordance that cannot fire is worse than none, and no warning colour
          and no "unsupported", because nothing has gone wrong.
        */}
        <div className={`${p}-rv-env`} data-static="true" data-testid="sealed-envelope">
          <Envelope p={p} label="Sealed" sub="A fixed share of NIM" />
        </div>
        <p className={`${p}-rv-desktop`} data-testid="sealed-only">
          Every share in this drop is the same size. Open it on the phone that has Nimiq Pay, and
          the envelope tells you the amount before you sign anything.
        </p>
        {deepLink ? (
          <a className={`${p}-rv-go`} href={deepLink}>
            Open in Nimiq Pay
          </a>
        ) : null}
        {publicId ? (
          <div className={`${p}-rv-qr`}>
            {/*
              A QR that fails to load must not leave a broken-image icon on the
              one screen a PC ever sees. The server renders this route, so it can
              be missing for an id it will not encode, for a stale cache, or for
              no network — and in every one of those cases the link is still the
              thing the person needs. So the fallback is the link itself, in
              text, selectable and wrapped, rather than an apology.
            */}
            {qrBroken ? (
              <p className={`${p}-rv-qr-fallback`} data-testid="qr-fallback">
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
      </div>
    )
  }

  const seconds = (holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)

  return (
    <div className={`${p}-rv-stage`} data-phase={phase} data-testid="reveal-stage">
      <button
        type="button"
        ref={button}
        className={`${p}-rv-env`}
        data-phase={phase}
        data-testid="hold-open"
        aria-describedby={hintId}
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
          p={p}
          ref={shake}
          label={reduced ? 'Open the envelope' : 'Hold to open'}
          sub={reduced ? undefined : 'Nothing is signed yet'}
          progress
        />
      </button>

      <p className={`${p}-rv-hint`} id={hintId}>
        {reduced
          ? 'A fixed share of NIM, the same for everyone. Opening it signs nothing.'
          : `Press and hold the envelope for ${seconds} seconds, or press Enter. Opening it signs nothing.`}
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
        className={`${p}-rv-escape`}
        data-shown={released ? 'true' : 'false'}
        data-testid="open-without-holding"
        onClick={open}
      >
        Open it without holding
      </button>
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
  button: React.RefObject<HTMLButtonElement | null>
  shake: React.RefObject<HTMLSpanElement | null>
  onFinish: () => void
  onHoldingChange: (holding: boolean) => void
  onRelease: () => void
}

/**
 * Press, progress, release, repeat.
 *
 * Progress is written straight onto the DOM as a custom property and a
 * transform inside one `requestAnimationFrame` loop. It is deliberately NOT
 * React state: a hold is sixty renders a second for up to five seconds, and the
 * only things that change are one number and one transform.
 *
 * Everything that can end a hold ends it the same way — pointer up, pointer
 * cancel, losing capture, drifting past the slop radius, `Escape`, the tab
 * going away, the window losing focus. There is one `cancel`.
 */
function useHoldToOpen({
  holdMs,
  enabled,
  reduced,
  button,
  shake,
  onFinish,
  onHoldingChange,
  onRelease,
}: HoldArgs) {
  const frame = useRef(0)
  const startedAt = useRef(0)
  const progress = useRef(0)
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

  const paint = useCallback(
    (value: number, elapsed: number) => {
      button.current?.style.setProperty('--hold', value.toFixed(4))
      const el = shake.current
      if (!el) return
      if (reduced || value === 0) {
        el.style.transform = ''
        return
      }
      const { x, y, deg } = shakeAt(value, elapsed)
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${deg.toFixed(3)}deg)`
    },
    [button, shake, reduced],
  )

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])

  /** Unwinds what was held, so letting go reads as "not finished", not "no". */
  const unwind = useCallback(() => {
    const from = progress.current
    const at = now()
    const step = () => {
      const t = (now() - at) / RELEASE_MS
      const value = t >= 1 ? 0 : from * (1 - t) * (1 - t)
      progress.current = value
      paint(value, 0)
      if (value > 0) frame.current = requestAnimationFrame(step)
      else frame.current = 0
    }
    frame.current = requestAnimationFrame(step)
  }, [paint])

  const cancel = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    stop()
    buzz(0)
    onHoldingChange(false)
    onRelease()
    unwind()
  }, [stop, buzz, onHoldingChange, onRelease, unwind])

  const finish = useCallback(() => {
    holding.current = false
    stop()
    progress.current = 1
    paint(1, holdMs)
    buzz([...OPEN_BUZZ])
    onHoldingChange(false)
    onFinish()
  }, [stop, paint, holdMs, buzz, onHoldingChange, onFinish])

  const tick = useCallback(() => {
    const elapsed = now() - startedAt.current
    const value = Math.min(1, elapsed / holdMs)
    progress.current = value
    paint(value, elapsed)

    while (rung.current < plan.length && value >= plan[rung.current].at) {
      buzz(plan[rung.current].ms)
      rung.current += 1
    }

    if (value >= 1) finish()
    else frame.current = requestAnimationFrame(tick)
  }, [holdMs, paint, plan, buzz, finish])

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
      progress.current = 0
      rung.current = 0
      holding.current = true
      onHoldingChange(true)
      // Progress from the first millisecond: paint frame zero before waiting
      // for one, so the control is never a press with nothing happening.
      paint(0.0001, 0)
      frame.current = requestAnimationFrame(tick)
    },
    [enabled, reduced, stop, onHoldingChange, paint, tick],
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
  p: string
  label: string
  sub?: string
  /** Draws the ring and the foil bar that fill as the hold progresses. */
  progress?: boolean
  ref?: React.Ref<HTMLSpanElement>
}

/**
 * The envelope, in five spans and one circle.
 *
 * Not one hex anywhere: the face, the flap, the foil and the ink are all
 * palette tokens, because the owner has not chosen a palette and this has to
 * survive whichever they pick. Vermilion (s5) is its natural home — a red
 * packet's lacquer and gold foil are already that palette's whole argument —
 * but nothing here knows that.
 */
function Envelope({ p, label, sub, progress, ref }: EnvelopeProps) {
  return (
    <>
      {/* Everything that moves is inside this one span, so the button's own
          hit area never moves under the thumb that is holding it. */}
      <span className={`${p}-rv-shake`} ref={ref} aria-hidden="true">
        <span className={`${p}-rv-face`} />
        <span className={`${p}-rv-flap`} />
        <span className={`${p}-rv-seal`}>
          {progress ? (
            <svg className={`${p}-rv-ring`} viewBox="0 0 100 100" aria-hidden="true">
              <circle className={`${p}-rv-ring-track`} cx="50" cy="50" r="45" />
              <circle className={`${p}-rv-ring-fill`} cx="50" cy="50" r="45" />
            </svg>
          ) : null}
          <NimMark tone="ink" height="21px" />
        </span>
      </span>
      <span className={`${p}-rv-label`}>
        {label}
        {sub ? <em>{sub}</em> : null}
      </span>
      {progress ? (
        <span className={`${p}-rv-bar`} aria-hidden="true">
          <span className={`${p}-rv-fill`} />
        </span>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------------
 * The burst
 * ---------------------------------------------------------------------- */

/**
 * Confetti and paper, as DOM nodes on `transform` and `opacity`.
 *
 * No canvas and no dependency: twenty-four absolutely positioned spans, each
 * running one keyframe, all of them inside a container the stage clips. Bounded
 * count, bounded reach, and the whole thing unmounts itself on a timer in the
 * component above — a particle field that outlives its moment is a leak that
 * happens to be pretty.
 *
 * `aria-hidden`, and every fact it celebrates is also on screen in words, which
 * is what makes deleting it under reduced motion a free choice rather than a
 * loss.
 */
function Burst({ p }: { p: string }) {
  const field = useMemo(() => [...shards(), ...confetti()], [])
  return (
    <span className={`${p}-rv-burst`} aria-hidden="true" data-testid="burst">
      {field.map((piece, i) => (
        <span key={i} className={`${p}-rv-bit`} data-tone={piece.tone} style={vars(piece)} />
      ))}
    </span>
  )
}

function vars(piece: Piece): React.CSSProperties {
  return {
    '--dx': `${piece.dx}px`,
    '--dy': `${piece.dy}px`,
    '--rot': `${piece.rot}deg`,
    '--dur': `${piece.dur}ms`,
    '--delay': `${piece.delay}ms`,
    '--size': `${piece.size}px`,
    '--round': piece.round ? '50%' : '2px',
  } as React.CSSProperties
}

/* -------------------------------------------------------------------------
 * The CSS
 * ---------------------------------------------------------------------- */

/**
 * Every colour below is a custom property the palette sets, with a fallback
 * only so the component still renders outside a palette.
 *
 * The envelope has four tokens of its own — `--env-face`, `--env-ink`,
 * `--env-foil`, `--env-on-foil` — because the paper and the amount plate are
 * different objects and the approved scheme colours them differently: a
 * vermilion envelope with a gold wax seal, sitting on an opaque near-black
 * plate once it is open. Each falls back to the plate and action tokens, so a
 * palette that has not thought about envelopes still gets a coherent one.
 */
export function revealCss(p: string): string {
  return `
.${p}-rv-stage {
  /* The envelope's own tokens, each falling back through the shared scheme in
     theme.ts and then to a literal, so this renders correctly inside any of
     the layout variants and still renders standalone.

     Vermilion paper, gold wax. The paper is DEEPER than the field's bloom on
     purpose: an object lit by a light cannot be the same value as the light, or
     it stops reading as an object. The wax is Nimiq gold and it is the only
     gold on the screen, which is what makes it read as foil rather than as a
     highlight colour — and it is why the primary action in the approved scheme
     is white rather than gold. */
  --face: var(--env-face, #c2360f);
  /* The pocket. A red packet has a front panel, and giving this one a real
     panel is not decoration: it is the only ground on the envelope dark enough
     to carry the label at 4.5:1, and it is the scheme's own oxblood. */
  --foot: var(--env-face-foot, #7a1d08);
  --face-ink: var(--env-ink, #ffeadd);
  --face-ink-2: var(--env-ink-2, rgb(255 234 221 / 0.76));
  --foil: var(--env-foil, var(--gold, #e9b213));
  --foil-lit: var(--env-foil-lit, #ffd24a);
  --on-foil: var(--env-on-foil, #2a1505);

  /* The money's surface. Opaque, always: whatever the bloom is doing behind it,
     the number does not depend on it. */
  --money-bg: var(--plate-bg, var(--card-solid, #1b1210));
  --money-ink: var(--plate-ink, var(--ink, #f5f0ee));
  --money-ink-2: var(--plate-ink-2, var(--ink-2, rgb(245 240 238 / 0.68)));
  --money-line: var(--plate-rule, var(--line, rgb(255 255 255 / 0.1)));
  position: relative;
  /* The burst lives in here, and clip is what stops eighteen particles handing
     the document horizontal scroll at the exact second everyone is looking. */
  overflow: clip;
  display: flex; flex-direction: column; align-items: center;
  padding: 4px 0 2px;
}

/* --- the envelope --------------------------------------------------------
 * The whole object is the control. 292x201 at phone width, which is 44px of
 * touch target about thirty times over, and it sits in the bottom half of the
 * stage where a one-handed thumb already is.
 * ---------------------------------------------------------------------- */
.${p}-rv-env {
  position: relative; display: block;
  width: min(100%, 292px); aspect-ratio: 1.45;
  margin: 0 auto; padding: 0; border: 0; background: none;
  font: inherit; color: var(--ink, #f5f0ee);
  cursor: pointer;
  /* The browser must not decide, three seconds in, that this was a scroll. */
  touch-action: none;
  /* The long-press furniture: Android's context menu, iOS's callout and
     magnifier, and the text selection both of them start with. */
  user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.${p}-rv-env[data-static='true'] { cursor: default; }

.${p}-rv-shake {
  position: absolute; inset: 0;
  display: block;
  /* transform only, written per frame from JS. Nothing else animates. */
  will-change: transform;
}

.${p}-rv-face {
  position: absolute; inset: 0;
  border-radius: 16px;
  background:
    /* the pocket's foil edge */
    linear-gradient(to bottom, transparent 0 calc(66% - 1px),
      color-mix(in srgb, var(--foil) 46%, transparent) calc(66% - 1px) 66%,
      transparent 66%),
    /* the pocket itself, a hard edge because it is a real fold */
    linear-gradient(to bottom, transparent 0 66%, var(--foot) 66% 100%),
    linear-gradient(150deg,
      color-mix(in srgb, var(--face) 88%, #fff 12%) 0%,
      var(--face) 46%,
      color-mix(in srgb, var(--face) 86%, #000 14%) 100%);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--foil) 34%, transparent),
    0 26px 44px -30px rgb(0 0 0 / 0.95);
}

/* The flap: one clipped span, its point landing dead centre where the seal is.
 *
 * The foil crease is TWO stacked triangles, not one self-intersecting outline.
 * A polygon that traces an outer ring and then an inner one is the usual CSS
 * trick for a hairline border on a clipped shape, and it does not work here:
 * clip-path fills with the NONZERO rule, so the inner contour does not subtract
 * and the "hairline" paints as a solid gold triangle over the whole flap. The
 * only gold on the screen is supposed to be the wax. Declaring evenodd would
 * fix the rule but leaves a seam along the segment joining the contours,
 * so instead: the flap itself is the foil, and a second triangle inset by the
 * crease width sits on top of it carrying the paper. The gold that survives is
 * exactly the 1.5px that misses.
 */
.${p}-rv-flap {
  position: absolute; inset: 0 0 auto; height: 62%;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  border-radius: 16px 16px 0 0;
  background: color-mix(in srgb, var(--foil) 55%, transparent);
}
.${p}-rv-flap::after {
  content: ''; position: absolute;
  /* Bottom inset is doubled: at the apex two edges meet at a shallow angle, so
     a uniform inset thins the crease to nothing exactly where the eye is, which
     is the point the seal sits on. */
  inset: 1.5px 1.5px 3px;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  border-radius: 15px 15px 0 0;
  background:
    linear-gradient(170deg,
      color-mix(in srgb, var(--face) 76%, #fff 24%) 0%,
      color-mix(in srgb, var(--face) 92%, #000 8%) 78%);
}

.${p}-rv-seal {
  position: absolute; left: 50%; top: 62%;
  width: 74px; height: 74px; margin: -37px 0 0 -37px;
  display: grid; place-items: center;
  border-radius: 50%;
  background: radial-gradient(120% 120% at 34% 26%,
    var(--foil-lit) 0%, var(--foil) 58%,
    color-mix(in srgb, var(--foil) 72%, #000 28%) 100%);
  color: var(--on-foil);
  box-shadow: 0 6px 14px -8px rgb(0 0 0 / 0.9);
}

/* The progress ring, on the seal, because that is where the thumb is looking.
   Unwrapping a stroke is the one progress form that reads as "a thing is being
   undone" rather than as a download. */
.${p}-rv-ring { position: absolute; inset: -9px; transform: rotate(-90deg); }
.${p}-rv-ring circle {
  fill: none; stroke-width: 5; stroke-linecap: round;
  --c: 283;
  stroke-dasharray: var(--c);
}
.${p}-rv-ring-track { stroke: color-mix(in srgb, var(--ink, #f5f0ee) 22%, transparent); }
.${p}-rv-ring-fill {
  /* Near-white, not gold. This is the one meaningful non-text graphic on the
     screen — it is the answer to "is anything happening" — so it is held to
     3:1 against the paper, and gold on vermilion does not get there. It also
     leaves the wax as the only gold, which is what makes the wax read as foil. */
  stroke: var(--ink, #f5f0ee);
  stroke-dashoffset: calc(var(--c) * (1 - var(--hold, 0)));
}

.${p}-rv-label {
  position: absolute; left: 0; right: 0; bottom: 13px;
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  font-size: 15px; font-weight: 800; letter-spacing: -0.01em;
  color: var(--face-ink);
}
.${p}-rv-label em {
  font-style: normal; font-size: 12px; font-weight: 600;
  color: var(--face-ink-2);
}

/* The second reading of the same progress, along the envelope's foot, for the
   thumb that is covering the seal. scaleX, so it costs a composite and not a
   layout. */
.${p}-rv-bar {
  position: absolute; left: 14px; right: 14px; bottom: 7px; height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--ink, #f5f0ee) 16%, transparent);
  overflow: hidden;
}
.${p}-rv-fill {
  display: block; height: 100%; border-radius: 2px;
  background: var(--ink, #f5f0ee);
  transform: scaleX(var(--hold, 0)); transform-origin: left center;
}

.${p}-rv-env[data-phase='holding'] .${p}-rv-seal {
  box-shadow: 0 2px 8px -6px rgb(0 0 0 / 0.9),
    0 0 0 calc(var(--hold, 0) * 5px) color-mix(in srgb, var(--foil) 26%, transparent);
}

.${p}-rv-hint {
  max-width: 32ch; margin: 12px auto 0;
  font-size: 13px; line-height: 1.45; text-align: center;
  color: var(--ink-2, rgb(245 240 238 / 0.68)); text-wrap: pretty;
}

/* --- the way out --------------------------------------------------------- */
.${p}-rv-escape {
  display: block; margin: 8px auto 0; padding: 12px 16px; min-height: 44px;
  border: 0; background: none; font: inherit; font-size: 14px; font-weight: 700;
  color: var(--ink, #f5f0ee); text-decoration: underline; text-underline-offset: 3px;
  cursor: pointer;
}
/* Present for assistive technology from the first render; on screen for
   everyone the moment a hold ends early. Clipped rather than displaced, so it
   is still focusable and still announced. */
.${p}-rv-escape[data-shown='false'] {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

/* --- the money ----------------------------------------------------------- */
.${p}-rv-plate {
  position: relative; z-index: 1;
  width: 100%; padding: 18px 18px 14px;
  border-radius: 22px;
  background: var(--money-bg); color: var(--money-ink);
  box-shadow: inset 0 0 0 1px var(--money-line);
  text-align: center;
}
.${p}-rv-plate:focus { outline: none; }
.${p}-rv-plate:focus-visible { outline: 2px solid var(--focus, #ffb27a); outline-offset: 3px; }
.${p}-rv-amount {
  display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap;
  margin: 0;
  font-size: var(--amount-size, 61px); font-weight: 700;
  line-height: 0.96; letter-spacing: -0.035em;
}
.${p}-rv-platecap {
  margin: 9px 0 0; font-size: 13px; line-height: 1.45;
  color: var(--money-ink-2); text-wrap: balance;
}

/* --- the burst ----------------------------------------------------------- */
.${p}-rv-burst {
  position: absolute; left: 50%; top: 46%; z-index: 2;
  width: 0; height: 0; pointer-events: none;
}
.${p}-rv-bit {
  position: absolute;
  width: var(--size); height: var(--size);
  margin: calc(var(--size) / -2) 0 0 calc(var(--size) / -2);
  border-radius: var(--round);
  animation: ${p}-rv-fly var(--dur) cubic-bezier(0.16, 0.9, 0.36, 1) var(--delay) 1 both;
}
/* Value contrast, not hue. On a warm dark field with a vermilion bloom in it,
   a warm particle is invisible — it is the same lightness as what it is flying
   over. So the confetti is near-white and gold, and never orange. */
.${p}-rv-bit[data-tone='0'] { background: var(--ink, #f5f0ee); }
.${p}-rv-bit[data-tone='1'] { background: var(--foil-lit); }
.${p}-rv-bit[data-tone='2'] { background: #ffffff; }
.${p}-rv-bit[data-tone='3'] { background: var(--foil); }
/* The paper: the envelope's own face, coming apart. It reads against the bloom
   by its gold keyline rather than by its fill, for the same reason. */
.${p}-rv-bit[data-tone='4'] {
  background: var(--face);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foil) 62%, transparent);
}
@keyframes ${p}-rv-fly {
  from { transform: translate3d(0, 0, 0) scale(0.4) rotate(0deg); opacity: 1; }
  62% { opacity: 1; }
  to {
    transform: translate3d(var(--dx), var(--dy), 0) scale(1) rotate(var(--rot));
    opacity: 0;
  }
}

/* --- the state a PC gets ------------------------------------------------- */
.${p}-rv-desktop {
  max-width: 40ch; margin: 16px auto 0;
  font-size: 14px; line-height: 1.5; text-align: center;
  color: var(--ink-2, rgb(245 240 238 / 0.68)); text-wrap: pretty;
}
.${p}-rv-go {
  display: block; width: 100%; min-height: 52px; margin-top: 16px; padding: 15px 20px;
  border-radius: 15px; border: 0;
  background: var(--action, #ffffff); color: var(--on-action, #141010);
  font: inherit; font-size: 17px; font-weight: 800; text-align: center;
  text-decoration: none;
}
.${p}-rv-qr {
  margin-top: 14px; padding: 14px; border-radius: 22px;
  background: var(--money-bg); text-align: center;
}
.${p}-rv-qr img { width: 100%; max-width: 168px; height: auto; margin: 0 auto; display: block; }
.${p}-rv-qr p {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  margin: 8px 0 0; font-size: 12px; color: var(--money-ink-2);
}
.${p}-rv-qr-fallback {
  display: block; margin: 0; font-size: 13px; line-height: 1.5;
  color: var(--money-ink-2);
}
.${p}-rv-qr-fallback code {
  display: block; margin-top: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  color: var(--money-ink);
  /* A link that has to be typed is read one character at a time, so it breaks
     anywhere rather than overflowing, and it is selectable. */
  overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
}

/* --- announced, not shown ------------------------------------------------ */
.${p}-rv-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

/* --- reduced motion ------------------------------------------------------
 * No shake, no burst, and NO HOLD: the envelope becomes a plain tap that lands
 * directly on the revealed state. A reduced-motion user who is also asked to
 * sustain a multi-second gesture has been given the worst of both. Delays are
 * crushed alongside durations, so nothing can be left waiting on one.
 * ---------------------------------------------------------------------- */
@media (prefers-reduced-motion: reduce) {
  .${p}-rv-stage *, .${p}-rv-stage *::before, .${p}-rv-stage *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
  .${p}-rv-burst { display: none; }
  .${p}-rv-bar, .${p}-rv-ring { display: none; }
}
`
}
