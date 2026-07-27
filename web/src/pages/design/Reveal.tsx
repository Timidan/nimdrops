import { useSearchParams } from 'react-router-dom'
import { getBridge, nimiqPayDeeplink } from '../../sdk/adapter'
import Field from '../../ui/Field'
import { HOLD_OPTIONS, openAbility, resolveHoldMs, type OpenAbility } from '../../ui/reveal'
import SealedEnvelope from '../../ui/SealedEnvelope'
import { DESIGN_SENTINEL } from './Board'

/**
 * DEV-ONLY. The sealed-envelope reveal, as something to try with a thumb.
 *
 * ## What this route settled, and what it is for now
 *
 * The owner asked for a five-second hold. Press-and-hold convention puts
 * "deliberate but not broken" nearer 1.2s. That was a disagreement no amount of
 * writing settles, so all three were put one tap apart and the owner's own
 * thumb decided. **2500 won and is shipped** (`ui/reveal.ts`, `HOLD_MS`).
 *
 *   /design/reveal?hold=1200
 *   /design/reveal?hold=2500     (the default, and what ships)
 *   /design/reveal?hold=5000
 *
 * The route survives because the gesture is the one thing in the product that
 * cannot be judged from a screenshot, and because a hold has to be retried with
 * a thumb whenever anything about it changes.
 *
 * ## Everything else this route takes
 *
 *   ?state=opened  land on the revealed state with no theatre, which is what a
 *                  reload, a resumed claim or a poll tick must get.
 *   ?host=phone    force the openable state (a wallet is reachable).
 *   ?host=desktop  force the sealed-only state (no wallet can sign here).
 *   ?tall=1        pad the page until it scrolls, to prove the browser cannot
 *                  reinterpret a hold as the start of a pan.
 *
 * ## It renders the SHIPPED component
 *
 * `ui/SealedEnvelope.tsx` and `ui/reveal.ts`, on the real `Field` and the real
 * `--nd-*` tokens. There is no prototype copy of the envelope any more, so this
 * page cannot drift away from what a claimant gets. What it is not is the real
 * claim screen: `children` here is a stub, because the point of the route is
 * the gesture and `/preview` is where the claim states live.
 */

const DROP = {
  sponsor: 'Amara O.',
  message: 'Thanks for a good week. Small one, from all of us.',
  publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
} as const

export default function Reveal() {
  const [params, setParams] = useSearchParams()
  const holdMs = resolveHoldMs(params.get('hold'))
  const tall = params.get('tall') === '1'
  const opened = params.get('state') === 'opened'

  /**
   * Whether this device can open the envelope at all.
   *
   * Decided by the wallet bridge, never by a viewport width: a narrow desktop
   * window is still a desktop and a tablet is ambiguous. `unavailable` — no
   * Nimiq Pay provider — means no signature can complete here, so the packet
   * stays sealed, which is also the right answer for a phone browser outside
   * Nimiq Pay. The override exists because a DEV build always resolves the mock
   * bridge, so the sealed-only state would otherwise be unreachable here.
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

  return (
    <div className={DESIGN_SENTINEL}>
      <style>{barCss()}</style>
      <header className="rb-bar">
        <span className="rb-tag">reveal</span>
        <div className="rb-titles">
          <h1>Hold to open</h1>
          <p>
            Sealed envelope, hold, shake, burst, then the claim screen — and the signature only
            after that. This is the shipped component on the shipped field.
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
            <button type="button" aria-current={!opened || undefined} onClick={() => set('state', null)}>
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
          </Group>
        </nav>
      </header>

      <main className="rb-main">
        <Field tone={opened ? 'warm' : 'live'}>
          <SealedEnvelope
            ability={ability}
            opened={opened}
            holdMs={holdMs}
            sponsor={DROP.sponsor}
            message={DROP.message}
            publicId={DROP.publicId}
            deepLink={nimiqPayDeeplink(typeof window === 'undefined' ? '' : window.location.href)}
          >
            <div className="rb-stub">
              <p>the claim screen goes here</p>
              <span>
                /preview renders it for real, in all thirteen states. This route exists for the
                gesture.
              </span>
            </div>
          </SealedEnvelope>
        </Field>
        {/* Filler, so the page genuinely scrolls. A hold on a scrollable page is
            the case where the browser can decide the contact was the start of a
            pan and take the gesture away two seconds in. */}
        {tall ? <div style={{ height: 900 }} aria-hidden="true" /> : null}
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

function barCss(): string {
  return `
.${DESIGN_SENTINEL} {
  min-height: 100dvh; background: #08070f; color: #e7e5ef;
  font: 13px/1.45 var(--font-sans);
}
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
.${DESIGN_SENTINEL} .rb-main { min-height: 100dvh; }
.${DESIGN_SENTINEL} .rb-stub {
  display: flex; flex: 1; flex-direction: column; justify-content: center; align-items: center;
  gap: 6px; padding: 24px; text-align: center;
}
.${DESIGN_SENTINEL} .rb-stub p { margin: 0; font-size: 17px; font-weight: 800; color: #f5f0ee; }
.${DESIGN_SENTINEL} .rb-stub span { max-width: 40ch; font-size: 13px; color: rgb(245 240 238 / 0.7); }
`
}
