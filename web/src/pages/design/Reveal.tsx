import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getBridge, nimiqPayDeeplink } from '../../sdk/adapter'
import { ClockExpiryIcon } from '../../ui/icons'
import { DESIGN_SENTINEL } from './Board'
import { Pips } from './nim'
import { kitCss } from './nimkit'
import { HOLD_OPTIONS, openAbility, resolveHoldMs, type OpenAbility } from './reveal'
import SealedReveal, { revealCss } from './SealedReveal'
import { themeCss } from './theme'

/**
 * DEV-ONLY. The sealed-envelope reveal, as something to try with a thumb.
 *
 * ## The one thing this route exists to settle
 *
 * The owner asked for a five-second hold. Press-and-hold convention puts
 * "deliberate but not broken" nearer 1.2s, and at 5s a lot of people let go
 * early because they conclude the control is dead. The usual argument for a
 * long hold — preventing an accidental activation — does not apply, because
 * opening the envelope spends nothing and signs nothing. That is a
 * disagreement no amount of writing settles, so all three are one tap apart and
 * the owner's own thumb decides:
 *
 *   /design/reveal?hold=1200
 *   /design/reveal?hold=2500     (the default)
 *   /design/reveal?hold=5000
 *
 * ## Everything else this route takes
 *
 *   ?state=opened  land on the revealed amount with no theatre, which is what a
 *                  reload, a resumed claim or a poll tick must get.
 *   ?host=phone    force the openable state (a wallet is reachable).
 *   ?host=desktop  force the sealed-only state (no wallet can sign here).
 *   ?solo=1        the surface alone, full viewport, no dev chrome. Every
 *                  screenshot in `docs/design/reveal/` is a solo capture.
 *   ?tall=1        pad the page until it scrolls, to prove the browser cannot
 *                  reinterpret a hold as the start of a pan.
 *
 * ## Colour
 *
 * The scheme is `theme.ts`, which the owner has approved and which a parallel
 * effort is building five layout variants against. Nothing here restates a
 * colour: the envelope's own six tokens fall back through that scheme, so the
 * sealed object drops into whichever variant wins.
 *
 * ## Not wired into the claim screen
 *
 * `DropView.tsx` is untouched. This proves the interaction, the choreography
 * and the frame cost first; what integrating it would take is in the report.
 */

const P = 'rev'

/**
 * The QR the sealed-only state shows, as a data URI.
 *
 * The component's default is `/drop/:publicId/qr.svg` — the same server route
 * the real claim screen already uses — and integrating it changes nothing. But
 * a Vite dev server has no backend behind that route, so on this route the
 * image 404s and the one screen a PC ever sees would be captured with a broken
 * image in the middle of it. This is the fixture's QR, generated once with the
 * `qrcode` package the server already depends on, encoding the drop link below.
 */
const QR_FIXTURE =
  'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 35 35%22 shape-rendering%3D%22crispEdges%22%3E%3Cpath stroke%3D%22%23F5F0EE%22 d%3D%22M1 1.5h7m1 0h2m1 0h3m1 0h6m2 0h1m2 0h7M1 2.5h1m5 0h1m1 0h4m1 0h1m2 0h1m1 0h1m3 0h2m2 0h1m5 0h1M1 3.5h1m1 0h3m1 0h1m3 0h1m4 0h3m2 0h1m2 0h1m2 0h1m1 0h3m1 0h1M1 4.5h1m1 0h3m1 0h1m1 0h1m1 0h1m1 0h1m1 0h3m2 0h2m1 0h1m1 0h1m1 0h1m1 0h3m1 0h1M1 5.5h1m1 0h3m1 0h1m2 0h2m3 0h1m2 0h1m2 0h2m1 0h2m1 0h1m1 0h3m1 0h1M1 6.5h1m5 0h1m11 0h4m4 0h1m5 0h1M1 7.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M9 8.5h2m1 0h2m4 0h1m2 0h1m1 0h2M1 9.5h1m1 0h2m1 0h3m1 0h1m4 0h1m2 0h3m1 0h1m1 0h2m1 0h1m2 0h1m1 0h2M2 10.5h1m1 0h1m3 0h1m3 0h2m6 0h1m2 0h2m2 0h2m1 0h2m1 0h1M3 11.5h1m1 0h3m4 0h1m2 0h1m2 0h1m2 0h4m3 0h3m1 0h2M1 12.5h1m2 0h2m2 0h1m1 0h8m1 0h2m2 0h1m1 0h1m2 0h1m1 0h1M1 13.5h1m5 0h1m3 0h2m3 0h1m2 0h1m6 0h1m1 0h1m1 0h1m1 0h1M3 14.5h4m1 0h3m1 0h1m4 0h3m3 0h1m4 0h1m3 0h1M1 15.5h1m1 0h6m2 0h2m2 0h4m4 0h1m3 0h1m3 0h1M3 16.5h1m1 0h2m1 0h1m1 0h2m5 0h1m1 0h4m3 0h2m3 0h1M1 17.5h7m1 0h4m2 0h2m2 0h2m1 0h2m2 0h2m1 0h1m1 0h1M1 18.5h2m1 0h1m5 0h1m1 0h1m1 0h3m1 0h1m2 0h2m1 0h4m1 0h2m1 0h1M2 19.5h2m3 0h1m5 0h6m3 0h1m4 0h3m1 0h2M3 20.5h2m1 0h1m1 0h2m1 0h2m8 0h1m1 0h3m3 0h1m3 0h1M1 21.5h2m2 0h4m1 0h2m1 0h3m3 0h3m2 0h1m1 0h1m1 0h1m1 0h2M1 22.5h3m2 0h1m2 0h2m1 0h1m1 0h3m1 0h2m2 0h1m1 0h1m1 0h3m1 0h2m1 0h1M3 23.5h6m1 0h3m4 0h1m1 0h1m2 0h1m1 0h3m5 0h2M2 24.5h3m4 0h1m1 0h5m1 0h1m1 0h2m3 0h1m1 0h2m2 0h1m1 0h1M1 25.5h1m2 0h1m1 0h3m3 0h1m1 0h1m1 0h1m1 0h1m2 0h1m2 0h6m1 0h1M9 26.5h1m2 0h1m1 0h2m1 0h4m1 0h1m1 0h2m3 0h2m1 0h1M1 27.5h7m1 0h3m1 0h2m5 0h3m1 0h2m1 0h1m1 0h1m2 0h1M1 28.5h1m5 0h1m1 0h5m3 0h1m4 0h4m3 0h3M1 29.5h1m1 0h3m1 0h1m2 0h1m3 0h3m1 0h1m2 0h1m2 0h6m1 0h3M1 30.5h1m1 0h3m1 0h1m1 0h1m1 0h2m1 0h1m4 0h6m3 0h1m1 0h1m2 0h1M1 31.5h1m1 0h3m1 0h1m1 0h1m1 0h1m7 0h2m2 0h1m3 0h2m1 0h1M1 32.5h1m5 0h1m3 0h2m1 0h1m1 0h3m1 0h1m3 0h1m1 0h4m3 0h1M1 33.5h7m1 0h1m2 0h2m2 0h3m3 0h1m1 0h1m2 0h1m1 0h1m1 0h1%22%2F%3E%3C%2Fsvg%3E'

const DROP = {
  sponsor: 'Amara O.',
  message: 'Thanks for a good week. Small one, from all of us.',
  amount: '5',
  shares: 5,
  left: 3,
  publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
} as const

export default function Reveal() {
  const [params, setParams] = useSearchParams()
  const holdMs = resolveHoldMs(params.get('hold'))
  const solo = params.get('solo') === '1'
  const tall = params.get('tall') === '1'
  const opened = params.get('state') === 'opened'
  /**
   * `?bloom=with` fires the field's warm-up AT THE SAME TIME as the burst
   * instead of after it. It exists to be measured against the default, because
   * "stacking them is the heaviest frame in the product" was an assertion until
   * someone put a frame counter on it. The numbers are in
   * `docs/design/reveal/notes.md`.
   */
  const bloomWithBurst = params.get('bloom') === 'with'

  /**
   * Whether this device can open the envelope at all.
   *
   * Decided by the wallet bridge, never by a viewport width: a narrow desktop
   * window is still a desktop and a tablet is ambiguous. `unavailable` — no
   * Nimiq Pay provider — means no signature can complete here, so the packet
   * stays sealed, which is also the right answer for a phone browser outside
   * Nimiq Pay. The override exists because a DEV build always resolves the mock
   * bridge, so the sealed-only state would otherwise be unreachable on this
   * machine and the 1280px capture has to come from somewhere.
   */
  const host = params.get('host')
  const ability: OpenAbility =
    host === 'desktop'
      ? 'sealed-only'
      : host === 'phone'
        ? 'can-open'
        : openAbility(getBridge().kind)

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  if (solo) {
    return (
      <div className={DESIGN_SENTINEL} data-solo="true">
        <Surface
          holdMs={holdMs}
          ability={ability}
          opened={opened}
          tall={tall}
          bloomWithBurst={bloomWithBurst}
          solo
        />
      </div>
    )
  }

  const soloParams = new URLSearchParams(params)
  soloParams.set('solo', '1')

  return (
    <div className={DESIGN_SENTINEL}>
      <style>{barCss()}</style>
      <header className="rb-bar">
        <span className="rb-tag">reveal</span>
        <div className="rb-titles">
          <h1>Hold to open</h1>
          <p>
            Sealed envelope, hold, shake, burst, then the amount — and the signature only after
            that. Try all three hold lengths with a thumb; the right one is the one you stop
            noticing.
          </p>
        </div>
        <nav className="rb-nav">
          <Group label="hold">
            {HOLD_OPTIONS.map((ms) => (
              <button
                key={ms}
                type="button"
                aria-current={ms === holdMs || undefined}
                onClick={() => set('hold', String(ms))}
              >
                {ms / 1000}s
              </button>
            ))}
          </Group>
          <Group label="state">
            <button
              type="button"
              aria-current={!opened || undefined}
              onClick={() => set('state', null)}
            >
              sealed
            </button>
            <button
              type="button"
              aria-current={opened || undefined}
              onClick={() => set('state', 'opened')}
            >
              opened
            </button>
          </Group>
          <Group label="host">
            <button
              type="button"
              aria-current={ability === 'can-open' || undefined}
              onClick={() => set('host', 'phone')}
            >
              phone
            </button>
            <button
              type="button"
              aria-current={ability === 'sealed-only' || undefined}
              onClick={() => set('host', 'desktop')}
            >
              PC
            </button>
          </Group>
          <Group label="page">
            <button
              type="button"
              aria-current={tall || undefined}
              onClick={() => set('tall', tall ? null : '1')}
            >
              scrollable
            </button>
            <a href={`/design/reveal?${soloParams}`}>solo</a>
          </Group>
        </nav>
      </header>
      <main className="rb-main">
        <section className="rb-panel">
          <p className="rb-cap">
            <b>390px, on a phone</b>
            <span> · the judged width, and the only device that can open it</span>
          </p>
          <div className="rb-frame" style={{ width: 390, height: 844 }}>
            <Surface
              holdMs={holdMs}
              ability="can-open"
              opened={opened}
              tall={tall}
              bloomWithBurst={bloomWithBurst}
            />
          </div>
        </section>
        <section className="rb-panel">
          <p className="rb-cap">
            <b>The same drop, on a PC</b>
            <span> · 1280px, sealed, because nothing here can sign</span>
          </p>
          <div className="rb-frame" style={{ width: 1280, height: 820 }}>
            <Surface holdMs={holdMs} ability="sealed-only" opened={false} tall={false} />
          </div>
        </section>
      </main>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="rb-group">
      <em>{label}</em>
      {children}
    </span>
  )
}

interface SurfaceProps {
  holdMs: number
  ability: OpenAbility
  opened: boolean
  tall: boolean
  /** Measurement only: warm the field DURING the burst rather than after it. */
  bloomWithBurst?: boolean
  solo?: boolean
}

/**
 * The claim surface, cut down to what the ritual needs.
 *
 * Deliberately not one of the five layout samples: those are a parallel effort
 * and they are the thing being chosen between. This shares their scheme —
 * `themeCss` verbatim, same field, same card material, same tokens — so what is
 * being judged here is the interaction and the choreography, not a sixth
 * layout.
 */
function Surface({ holdMs, ability, opened, tall, bloomWithBurst, solo }: SurfaceProps) {
  const [isOpen, setIsOpen] = useState(opened)
  const [bursting, setBursting] = useState(false)

  /**
   * The bloom warms up AFTER the particles have gone, not with them.
   *
   * The reason is choreography and ONLY choreography: the paper should fly and
   * then the room should warm, because simultaneous is a chord and this project
   * has already learned that a chord reads as noise.
   *
   * It was also claimed here to be the cheaper of the two, on the grounds that a
   * 900ms opacity transition over a viewport-sized radial stacked on two dozen
   * animating nodes must be the heaviest frame in the product. That was a guess,
   * and `?bloom=with` exists so it could stop being one. Measured at 1x, 6x and
   * 20x CPU throttling, deferring the bloom changes the frame timing by nothing
   * at all — both are one opacity animation on a composited layer, and the
   * compositor does not care how big the layer is. The numbers, and where the
   * frames actually go, are in `docs/design/reveal/notes.md`. Keep the deferral
   * because it looks better, not because it is faster.
   *
   * It is a state and not a keyframe either way: under reduced motion no burst
   * is ever mounted, so `bursting` is never true and the field is warm the
   * instant the envelope opens.
   */
  const warm = isOpen && (bloomWithBurst === true || !bursting)
  const onBurst = useCallback((on: boolean) => setBursting(on), [])

  return (
    <div className={`${P}-root`} data-solo={solo ? 'true' : 'false'}>
      <style>{kitCss(P)}</style>
      <style>{themeCss(P)}</style>
      <style>{composeCss(P)}</style>
      <style>{revealCss(P)}</style>

      <div className={`${P}-field`} data-tone={warm ? 'warm' : 'live'}>
        <span className={`${P}-scrim`} aria-hidden="true" />
        <span className={`${P}-grain`} aria-hidden="true" />

        <div className={`${P}-inner`}>
          <p className={`${P}-mast`}>
            NimDrops<span>One link, a fixed share each</span>
          </p>

          <div className={`${P}-stage`}>
            <section className={`${P}-sheet ${P}-glass`}>
              <p className={`${P}-from`}>
                <b>{DROP.sponsor}</b> sent you a NimDrop
                <span className={`${P}-chip`}>name unverified</span>
              </p>
              <p className={`${P}-msg`}>{DROP.message}</p>

              <SealedReveal
                prefix={P}
                amount={DROP.amount}
                holdMs={holdMs}
                ability={ability}
                initialOpened={opened}
                publicId={DROP.publicId}
                qrSrc={QR_FIXTURE}
                deepLink={nimiqPayDeeplink(
                  typeof window === 'undefined' ? '' : window.location.href,
                )}
                onOpen={() => setIsOpen(true)}
                onBurst={onBurst}
                action={
                  <>
                    <button type="button" className={`${P}-go`}>
                      Open {DROP.amount} NIM
                    </button>
                    <p className={`${P}-after`}>Nimiq Pay opens for one signature.</p>
                  </>
                }
              />
            </section>

            <p className={`${P}-live`}>
              <Pips total={DROP.shares} left={DROP.left} />
              <span className={`${P}-num`}>
                {DROP.left} of {DROP.shares} left
              </span>
              <span className={`${P}-tick`} aria-hidden="true" />
              <ClockExpiryIcon size={15} />
              <span className={`${P}-num`}>3h 20m</span>
            </p>
          </div>

          {/* Filler, so the page genuinely scrolls. A hold on a scrollable page
              is the case where the browser can decide the contact was the start
              of a pan and take the gesture away three seconds in. */}
          {tall ? <div className={`${P}-tall`} aria-hidden="true" /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The composition around the envelope.
 *
 * Bottom-weighted, and that is the whole layout decision. The envelope is the
 * gesture target, it is 292px across, and it has to land inside the arc a thumb
 * sweeps on a one-handed grip — which on an 844px screen is the bottom third,
 * clear of the notch and clear of the home indicator. A ritual at the top of
 * the viewport is a two-handed design for a one-handed moment.
 */
function composeCss(p: string): string {
  return `
.${p}-inner {
  position: relative; z-index: 2; display: flex; flex-direction: column; flex: 1;
  gap: 16px; padding: 20px 20px 24px; min-height: 0;
}
.${p}-root[data-solo='true'] .${p}-inner { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
.${p}-mast {
  display: flex; align-items: baseline; gap: 9px; margin: 0;
  font-size: 15px; font-weight: 800; letter-spacing: -0.012em;
}
.${p}-mast span { font-size: 13px; font-weight: 500; color: var(--ink-2); }
.${p}-stage {
  display: flex; flex-direction: column; gap: 14px; flex: 1;
  justify-content: flex-end; min-height: 0; padding-bottom: 2px;
}
.${p}-sheet {
  width: 100%; max-width: 25.5rem; margin: 0 auto; padding: 20px;
  border-radius: 28px;
}
.${p}-from {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px;
  margin: 0; font-size: 15px; color: var(--ink-2);
}
.${p}-from b { font-weight: 800; color: var(--ink); }
.${p}-msg {
  margin: 14px 0 18px; padding-left: 14px; border-left: 1px solid var(--gold);
  font-size: 17px; line-height: 1.42; letter-spacing: -0.012em; color: var(--ink);
  text-wrap: pretty; overflow-wrap: anywhere;
}
.${p}-go {
  display: block; width: 100%; min-height: 52px; margin-top: 18px; padding: 14px 20px;
  border-radius: 15px; border: 0; font: inherit; font-size: 17px; font-weight: 800;
  letter-spacing: -0.005em; cursor: pointer;
  background: var(--action); color: var(--on-action);
  box-shadow: 0 10px 24px -18px rgb(0 0 0 / 0.9), inset 0 1px 0 rgb(255 255 255 / 0.5);
  transition: transform 120ms ease-out, background-color 120ms ease-out;
}
.${p}-go:active { transform: translateY(1px); }
.${p}-after {
  margin: 10px 0 0; font-size: 13px; line-height: 1.45; text-align: center;
  /* Not --ink-2. At 0.68 over the card over the brightest the bloom can be
     this line lands at 4.43:1, and it is the line that tells a stranger a
     wallet is about to open. 0.8 clears the floor at 5.4:1. */
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-variant-numeric: tabular-nums; text-wrap: pretty;
}
.${p}-live {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px;
  width: 100%; max-width: 25.5rem; margin: 0 auto;
  font-size: 13.5px; font-weight: 700; color: var(--ink);
}
.${p}-live > svg { color: var(--gold); }
.${p}-tick {
  width: 4px; height: 4px; border-radius: 50%; background: var(--gold);
  animation: ${p}-pulse 4s ease-in-out infinite;
}
@keyframes ${p}-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.${p}-tall { height: 900px; }
@media (prefers-reduced-motion: reduce) { .${p}-tick { opacity: 1; } }
`
}

function barCss(): string {
  return `
.${DESIGN_SENTINEL} {
  min-height: 100dvh; background: #08070f; color: #e7e5ef;
  font: 13px/1.45 'Mulish', ui-sans-serif, system-ui, sans-serif;
}
.${DESIGN_SENTINEL}[data-solo] { background: transparent; }
.${DESIGN_SENTINEL} * { box-sizing: border-box; }
.${DESIGN_SENTINEL} .rb-bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;
  padding: 11px 16px; background: #08070f; border-bottom: 1px solid #23203f;
}
.${DESIGN_SENTINEL} .rb-tag {
  display: grid; place-items: center; height: 26px; padding: 0 9px; margin-top: 2px;
  border-radius: 7px; background: #e9b213; color: #1a1633; font-weight: 800;
}
.${DESIGN_SENTINEL} .rb-titles { min-width: 0; flex: 1 1 30ch; }
.${DESIGN_SENTINEL} .rb-titles h1 { margin: 0; font-size: 14px; font-weight: 800; }
.${DESIGN_SENTINEL} .rb-titles p { margin: 2px 0 0; color: #9d99c4; max-width: 92ch; }
.${DESIGN_SENTINEL} .rb-nav { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap; }
.${DESIGN_SENTINEL} .rb-group { display: flex; gap: 5px; align-items: center; }
.${DESIGN_SENTINEL} .rb-group em { font-style: normal; color: #7d79a8; margin-right: 2px; }
.${DESIGN_SENTINEL} .rb-nav button, .${DESIGN_SENTINEL} .rb-nav a {
  min-width: 34px; min-height: 30px; padding: 6px 10px; border-radius: 7px;
  border: 1px solid #322e5e; background: transparent; color: #c8c4e4;
  font: inherit; text-decoration: none; text-align: center; cursor: pointer;
}
.${DESIGN_SENTINEL} .rb-nav [aria-current] { background: #322e5e; color: #fff; }
.${DESIGN_SENTINEL} .rb-main {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 22px;
  padding: 20px 16px 64px;
}
.${DESIGN_SENTINEL} .rb-panel { flex: 0 0 auto; max-width: 100%; }
.${DESIGN_SENTINEL} .rb-cap { margin: 0 0 7px; }
.${DESIGN_SENTINEL} .rb-cap b { font-weight: 800; }
.${DESIGN_SENTINEL} .rb-cap span { color: #9d99c4; }
.${DESIGN_SENTINEL} .rb-frame {
  max-width: 100%; overflow: auto; border-radius: 14px; outline: 1px solid #23203f;
}
`
}
