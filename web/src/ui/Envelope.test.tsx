/**
 * The signature moment (design §4.4): "a sealed paper envelope, passed around
 * one real group".
 *
 * The rules these tests exist to defend:
 *  - the seal breaks ONCE — a reveal is an event, not a loop, and a status poll
 *    ticking `reserved → confirming` must not re-fire it;
 *  - resuming straight into an opened envelope has no seal to break, so it gets
 *    the opened state with no theatre;
 *  - opened is a STATE, not a keyframe, which is what makes
 *    `prefers-reduced-motion` correct: with every duration crushed to nothing
 *    the opened envelope simply *is*, fully legible;
 *  - the amount is on the face BEFORE anything is claimed (§4.3 honesty rule),
 *    including on the no-wallet path, whose CTA has to keep working.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { DropPublic } from '../api'
import DropView, { type DropViewProps } from '../pages/DropView'
import type { ClaimUiState } from '../state/claim'

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'

const DROP: DropPublic = {
  publicId: PUBLIC_ID,
  sponsorLabel: 'Team NimDrops',
  message: 'Thanks for a good week',
  amountEach: '2',
  claimCount: 5,
  remaining: 3,
  state: 'live',
  expiresAt: new Date(Date.now() + 84_000_000).toISOString(),
}

function props(state: ClaimUiState, over: Partial<DropViewProps> = {}): DropViewProps {
  return {
    publicId: PUBLIC_ID,
    state,
    drop: DROP,
    serverState: null,
    txHash: null,
    amountEach: '2',
    notice: '',
    onClaim: () => {},
    onRetry: () => {},
    ...over,
  }
}

function view(state: ClaimUiState, over: Partial<DropViewProps> = {}) {
  return render(
    <MemoryRouter>
      <DropView {...props(state, over)} />
    </MemoryRouter>,
  )
}

function envelope() {
  return screen.getByTestId('envelope')
}

afterEach(cleanup)

describe('the seal', () => {
  it('breaks once, when a sealed envelope is reserved', () => {
    const { rerender } = view('ready')
    expect(envelope().getAttribute('data-envelope-open')).toBe('false')
    expect(screen.queryByTestId('seal-bloom')).toBeNull()

    rerender(
      <MemoryRouter>
        <DropView {...props('reserved', { serverState: 'reserved' })} />
      </MemoryRouter>,
    )
    expect(envelope().getAttribute('data-envelope-open')).toBe('true')
    expect(screen.getByTestId('seal-bloom')).toBeTruthy()
  })

  it('does not break a second time as the claim moves on to confirming', () => {
    const { rerender } = view('ready')
    const open = (state: ClaimUiState) =>
      rerender(
        <MemoryRouter>
          <DropView {...props(state, { serverState: 'reserved' })} />
        </MemoryRouter>,
      )

    open('reserved')
    expect(screen.getByTestId('seal-bloom')).toBeTruthy()

    // The bloom un-mounts on its own; the point is that moving through the
    // remaining opened states never mounts a second one.
    screen.getByTestId('seal-bloom').remove()
    open('confirming')
    open('paid')
    expect(screen.queryByTestId('seal-bloom')).toBeNull()
  })

  it('has nothing to break when a reload resumes an already-opened claim', () => {
    view('confirming', { serverState: 'sending' })
    expect(envelope().getAttribute('data-envelope-open')).toBe('true')
    expect(screen.queryByTestId('seal-bloom')).toBeNull()
    expect(screen.getByText(/2 NIM is on its way/i)).toBeTruthy()
  })

  it('greys the wax on the dead ends rather than promising something to open', () => {
    view('exhausted', { drop: { ...DROP, remaining: 0 } })
    expect(envelope().getAttribute('data-envelope-tone')).toBe('quiet')
    expect(envelope().getAttribute('data-envelope-open')).toBe('false')
  })
})

describe('prefers-reduced-motion', () => {
  /**
   * Opened has to be reachable with animation off. It is, because it is a plain
   * state: mounting straight into it produces the finished, legible opened
   * envelope with no animation involved at all — exactly what a reduced-motion
   * user sees once `index.css` zeroes the durations.
   */
  it('renders the opened envelope directly, with no animation in the way', () => {
    view('paid', { serverState: 'paid', txHash: 'b'.repeat(64) })

    expect(envelope().getAttribute('data-envelope-open')).toBe('true')
    expect(screen.queryByTestId('seal-bloom')).toBeNull()
    // Everything the opened state is for is on screen, unanimated.
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByText(/^Paid$/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /view on the nimiq explorer/i })).toBeTruthy()
  })

  it('states the open envelope declaratively, so zeroing durations lands on it', () => {
    // Vitest runs with `web/` as its root, so the stylesheet is right there.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(css.length).toBeGreaterThan(0)

    /**
     * The contract is the SHAPE of these rules, not the numbers in them: the
     * open flap and the split wax must be plain declarations sitting under the
     * open attribute, so that zeroing every duration lands on the finished
     * envelope. The angle itself is a token and free to be retuned.
     */
    const keyframeBlocks = css.match(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? []
    const outsideKeyframes = keyframeBlocks.reduce((rest, block) => rest.replace(block, ''), css)

    for (const rule of [
      /\[data-envelope-open='true'\]\s+\.nd-flap\s*\{[^}]*\btransform:\s*rotateX\(/,
      /\[data-envelope-open='true'\]\s+\.nd-wax-half\.is-left\s*\{[^}]*\bopacity:\s*0/,
      /\[data-envelope-open='true'\]\s+\.nd-face\s*\{[^}]*\btransform:\s*translateY\(/,
    ]) {
      expect(outsideKeyframes).toMatch(rule)
    }

    // …and the open angle is a real declared token, not an accident.
    expect(css).toMatch(/--nd-open-angle:\s*-?\d+(\.\d+)?deg/)

    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
  })

  /**
   * The trap in a staged reveal, and the reason the ladder and this assertion
   * had to ship together.
   *
   * Zeroing durations is not enough once anything is delayed. A reduced-motion
   * user would sit out the full 260ms of the ladder in front of a screen where
   * nothing had happened yet, then have the finished envelope appear all at
   * once — a *slower* reveal than the animated one, made of nothing. Both
   * delays have to be crushed alongside both durations.
   */
  it('zeroes the reveal delays too, not only the durations', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const reduced = css.slice(at)

    expect(reduced).toMatch(/transition-delay:\s*0m?s\s*!important/)
    expect(reduced).toMatch(/animation-delay:\s*0m?s\s*!important/)

    // …and on the universal selector, so nothing added later can escape it.
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-delay:\s*0m?s\s*!important/)
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-delay:\s*0m?s\s*!important/)
  })
})

/**
 * Nine animations used to fire on the same frame. The eye had no order to
 * follow, and the gold bloom peaked (38% of 900ms ≈ 340ms) while the flap was
 * halfway through its 640ms travel, so the warmth arrived before the thing it
 * was warming.
 *
 * These read the stylesheet rather than the DOM for the same reason the
 * overflow assertions above do: jsdom has no layout or animation engine, so a
 * timing assertion made against it would defend nothing.
 */
describe('the reveal is a sequence, not a chord', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  /** The delay in the `transition`/`animation` shorthand of one rule. */
  function delayOf(selector: string, property: 'transition' | 'animation'): number {
    const block = css.match(new RegExp(`\\n${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1]
    expect(block, `${selector} should exist`).toBeTruthy()
    // The delay is the SECOND bare time in the shorthand; the first is duration.
    const declaration = block!.match(new RegExp(`${property}:([^;]*);`))?.[1] ?? ''
    const times = [...declaration.matchAll(/(\d+(?:\.\d+)?)m?s/g)].map((m) => Number(m[1]))
    return times.length >= 2 ? times[1]! : 0
  }

  it('stages the seal, then the paper, then the depth, then the warmth', () => {
    const wax = delayOf('.nd-seal', 'transition')
    const flap = delayOf('.nd-flap', 'transition')
    const face = delayOf('.nd-face', 'transition')
    const liner = delayOf('.nd-liner', 'transition')
    const bloom = delayOf('.nd-bloom', 'animation')

    // The seal is the thing being broken, so it leads and nothing waits on it.
    expect(wax).toBe(0)
    // Paper follows the seal; the sheet lifts with the flap, not against it.
    expect(flap).toBeGreaterThan(wax)
    expect(face).toBe(flap)
    // Depth appears as the flap clears, and the warmth peaks as it lands.
    expect(liner).toBeGreaterThan(flap)
    expect(bloom).toBeGreaterThan(liner)

    // A reveal, not a wait: the last thing to start still starts inside 300ms.
    expect(bloom).toBeLessThanOrEqual(300)
  })

  it('keeps the bloom mounted for its delay as well as its duration', async () => {
    const rule = css.match(/\.nd-bloom\s*\{([^}]*)\}/)?.[1] ?? ''
    const times = [...(rule.match(/animation:([^;]*);/)?.[1] ?? '').matchAll(/(\d+(?:\.\d+)?)m?s/g)]
      .map((m) => Number(m[1]))
    expect(times.length).toBeGreaterThanOrEqual(2)

    const source = readFileSync(resolve(process.cwd(), 'src/ui/Envelope.tsx'), 'utf8')
    const mounted = Number(source.match(/const BLOOM_MS = (\d+)/)?.[1])
    // Unmounting early would cut the warmth off mid-fade.
    expect(mounted).toBeGreaterThanOrEqual(times[0]! + times[1]!)
  })
})

/**
 * The reveal once handed the page ~100px of horizontal scroll for the 900ms the
 * gold bloom was alive (measured: 88px at 320, 103 at 375, 107 at 390, 118 at
 * 430). The bloom hung 12% past each edge of the paper and then grew to
 * `scale(1.25)`, and an absolutely positioned, scaled decoration still counts
 * towards the document's scrollable overflow at its scaled size.
 *
 * These assertions read the stylesheet rather than the DOM ON PURPOSE. jsdom
 * has no layout engine: `scrollWidth`, `clientWidth` and every rect it hands
 * back are hardcoded zeros, so an overflow assertion here would pass whatever
 * the CSS said and defend nothing. The invariant is therefore checked where it
 * actually lives — in the declarations — and the measured version of the same
 * check lives in `/preview`, where each frame reports the worst overflow it saw
 * across the whole reveal and the bar reports the document's own sideways
 * scroll.
 */
describe('the reveal cannot make the page scroll sideways', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  it('still blooms — the fix is containment, not deletion', () => {
    const { rerender } = view('ready')
    rerender(
      <MemoryRouter>
        <DropView {...props('reserved', { serverState: 'reserved' })} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('seal-bloom')).toBeTruthy()
  })

  it('keeps the bloom inside the paper it blooms on', () => {
    const rule = css.match(/\.nd-bloom\s*\{([^}]*)\}/)?.[1]
    expect(rule).toBeTruthy()

    // Nothing hangs off the sides of a 320px sheet.
    for (const side of ['inset', 'left', 'right', 'inset-inline', 'inset-inline-start']) {
      const value = rule!.match(new RegExp(`(?:^|[;\\s])${side}:\\s*([^;]+)`))?.[1]
      if (value !== undefined) expect(value.trim()).not.toMatch(/-\s*\d/)
    }
  })

  it('never animates anything wider than its own box', () => {
    const blocks = css.match(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? []
    expect(blocks.length).toBeGreaterThan(0)

    for (const block of blocks) {
      const factors = [...block.matchAll(/\bscale(?:X|3d)?\(\s*([\d.]+)/g)].map((m) => Number(m[1]))
      for (const factor of factors) {
        // `scale(1.25)` on a full-bleed decoration is 25% of the viewport of
        // sideways scroll. Growth has to be spent getting UP to 1, not past it.
        expect(factor).toBeLessThanOrEqual(1)
      }
    }
  })

  it('clips the paper on the inline axis, so a future decoration cannot escape', () => {
    const face = css.match(/\n\.nd-face\s*\{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1]
    expect(face).toBeTruthy()
    // `clip`, not `hidden`: the sheet must not become a scroll container.
    expect(face).toMatch(/overflow-x:\s*clip/)
  })
})

describe('the printed amount', () => {
  it('is on the face before anything is claimed, and keeps the no-wallet CTA', () => {
    view('no-wallet')

    // §4.3: someone deciding whether to install a wallet can see what for.
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)

    const link = screen.getByRole('link', { name: /open in nimiq pay/i })
    expect(link.getAttribute('href')).toBe(
      `nimiqpay://miniapp?url=${encodeURIComponent(window.location.href)}`,
    )
    expect(screen.getByRole('img', { name: /qr/i }).getAttribute('src')).toBe(
      `/d/${PUBLIC_ID}/qr.svg`,
    )
    expect(screen.getByRole('button', { name: /copy link/i })).toBeTruthy()
  })

  it('steps the type down so a long amount cannot overflow a 320px face', () => {
    const size = () => screen.getByTestId('amount-hero').className

    view('ready')
    expect(size()).toContain('text-[3.5rem]')

    cleanup()
    view('ready', { drop: { ...DROP, amountEach: '10000.00000' }, amountEach: '10000.00000' })
    expect(size()).toContain('text-[2.125rem]')
    // A denomination never breaks across two lines.
    expect(size()).toContain('nd-amount')
  })

  it('earns its one gold keyline only after the backend says paid', () => {
    view('reserved', { serverState: 'reserved' })
    expect(screen.queryByTestId('paid-keyline')).toBeNull()

    cleanup()
    view('paid', { serverState: 'paid', txHash: 'b'.repeat(64) })
    expect(screen.getByTestId('paid-keyline')).toBeTruthy()
  })
})
