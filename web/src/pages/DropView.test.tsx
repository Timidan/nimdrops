/**
 * The claim surface, state by state.
 *
 * `Drop.test.tsx` drives the claim machine through the network. This file
 * drives the SURFACE through every state the machine can hand it, from
 * fixtures, and defends the three rules the redesign is held to.
 *
 * jsdom has no CSS engine at all, which is exactly the property that makes it
 * the right harness for rule 1: nothing here can be made to appear by a
 * transition, a keyframe, a media query or a container query, because none of
 * those exist. If a state renders its amount and its action here, it renders
 * them in a headless renderer, in a background tab, and under reduced motion.
 * The stylesheet half of the same rule is in `ui/surface.test.ts`, and the
 * rendered-in-a-real-browser half is the animation-disabled screenshot pass in
 * `docs/design/shipped/`.
 *
 * Invariants carried over from `Envelope.test.tsx`, which this direction
 * deletes: the reveal fires exactly once on sealed → opened; resuming straight
 * into an opened claim has nothing to reveal; the amount is on screen before
 * anything is claimed, including on the no-wallet path; the type steps down so
 * a long amount cannot overflow a 320px screen; the one gold keyline is earned
 * only after the backend says paid.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { DropPublic } from '../api'
import type { ClaimUiState } from '../state/claim'
import GlassSheet from '../ui/GlassSheet'
import DropView, { type DropViewProps } from './DropView'

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const TX_HASH = 'b'.repeat(64)

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

const field = () => document.querySelector('.nd-field')!

afterEach(cleanup)

/**
 * All thirteen, and what each one owes the claimant.
 *
 * `amount: false` on the four dead ends and on the boot spinner is not an
 * exception to the honesty rule, it is the rule: there is no offer to state.
 * Every state where a share exists shows the number.
 */
const STATES: {
  state: ClaimUiState
  over?: Partial<DropViewProps>
  /** The amount must be on screen. */
  amount: boolean
  /** A control the claimant can act on must be on screen. */
  action: { role: 'button' | 'link'; name: RegExp } | null
  tone: 'live' | 'warm' | 'quiet'
}[] = [
  { state: 'loading', over: { drop: null }, amount: false, action: null, tone: 'live' },
  {
    state: 'loading',
    over: { drop: { ...DROP, state: 'funding_pending', remaining: 5, expiresAt: null } },
    amount: true,
    action: null,
    tone: 'live',
  },
  {
    state: 'awaiting-funding',
    over: { drop: { ...DROP, state: 'awaiting_funding', remaining: 5, expiresAt: null } },
    amount: true,
    action: { role: 'button', name: /copy link/i },
    tone: 'live',
  },
  { state: 'ready', amount: true, action: { role: 'button', name: /open 2 NIM/i }, tone: 'live' },
  { state: 'signing', amount: true, action: null, tone: 'live' },
  { state: 'no-wallet', amount: true, action: { role: 'link', name: /open in nimiq pay/i }, tone: 'live' },
  { state: 'degraded', amount: true, action: null, tone: 'live' },
  { state: 'reserved', over: { serverState: 'reserved' }, amount: true, action: null, tone: 'warm' },
  { state: 'confirming', over: { serverState: 'sending' }, amount: true, action: null, tone: 'warm' },
  {
    state: 'confirming',
    over: { serverState: 'manual_review' },
    amount: true,
    action: null,
    tone: 'warm',
  },
  {
    state: 'paid',
    over: { serverState: 'paid', txHash: TX_HASH },
    amount: true,
    action: { role: 'link', name: /drop one back/i },
    tone: 'warm',
  },
  {
    state: 'paid',
    over: { serverState: 'paid', txHash: null },
    amount: true,
    action: { role: 'link', name: /drop one back/i },
    tone: 'warm',
  },
  { state: 'rejected', amount: false, action: { role: 'button', name: /try again/i }, tone: 'quiet' },
  {
    state: 'exhausted',
    over: { drop: { ...DROP, remaining: 0 } },
    amount: false,
    action: { role: 'link', name: /drop one back/i },
    tone: 'quiet',
  },
  {
    state: 'expired',
    over: { drop: { ...DROP, state: 'settled' } },
    amount: false,
    action: { role: 'link', name: /drop one back/i },
    tone: 'quiet',
  },
  { state: 'paused', amount: false, action: null, tone: 'quiet' },
]

describe('the money never depends on the visual layer', () => {
  it.each(STATES)(
    'renders $state complete, with no CSS engine in the room',
    ({ state, over, amount, action, tone }) => {
      view(state, over)

      // The field is always there, and it always says which tone it is in.
      expect(field().getAttribute('data-tone')).toBe(tone)
      // The sheet is always there. It is a surface, never a reveal.
      expect(screen.getByTestId('claim-sheet')).toBeTruthy()

      if (amount) {
        const hero = screen.getByTestId('amount-hero')
        expect(hero.textContent).toMatch(/2\s*NIM/)
        expect(hero.getAttribute('aria-label')).toBe('2 NIM')
      } else {
        expect(screen.queryByTestId('amount-hero')).toBeNull()
      }

      if (action) {
        expect(screen.getByRole(action.role, { name: action.name })).toBeTruthy()
      }

      // Nothing is waiting behind a reveal: the ring only exists as a
      // transient decoration, and never on a state the surface mounted into.
      expect(screen.queryByTestId('ripple')).toBeNull()
    },
  )

  /**
   * The claim button in particular. A disabled one still has to be visible and
   * still has to say the number, because a claimant reads the label against the
   * amount above it before they decide anything.
   */
  it.each(['ready', 'signing', 'degraded'] as const)(
    'keeps a labelled claim button on %s',
    (state) => {
      view(state)
      const button = screen.getByRole('button', { name: /open 2 NIM/i })
      expect(button.textContent).toBe('Open 2 NIM')
      expect((button as HTMLButtonElement).disabled).toBe(state !== 'ready')
    },
  )

  /** No element on the claim path carries an inline style that could hide it. */
  it.each(STATES)('hides nothing inline on $state', ({ state, over }) => {
    view(state, over)
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.nd-field *'))) {
      expect(el.style.opacity, el.className.toString()).not.toBe('0')
      expect(el.style.display).not.toBe('none')
      expect(el.style.visibility).not.toBe('hidden')
    }
  })
})

describe('the reveal', () => {
  it('fires once, when a sealed surface is reserved', () => {
    const { rerender } = view('ready')
    expect(screen.queryByTestId('ripple')).toBeNull()
    expect(field().getAttribute('data-tone')).toBe('live')

    rerender(
      <MemoryRouter>
        <DropView {...props('reserved', { serverState: 'reserved' })} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('ripple')).toBeTruthy()
    expect(field().getAttribute('data-tone')).toBe('warm')
  })

  it('does not fire a second time as the claim moves on to confirming and paid', () => {
    const { rerender } = view('ready')
    const go = (state: ClaimUiState) =>
      rerender(
        <MemoryRouter>
          <DropView {...props(state, { serverState: 'reserved' })} />
        </MemoryRouter>,
      )

    go('reserved')
    expect(screen.getByTestId('ripple')).toBeTruthy()
    // The ring un-mounts on its own; the point is that moving through the
    // remaining opened states never mounts a second one.
    screen.getByTestId('ripple').remove()
    go('confirming')
    go('paid')
    expect(screen.queryByTestId('ripple')).toBeNull()
  })

  it('has nothing to reveal when a reload resumes an already-opened claim', () => {
    view('confirming', { serverState: 'sending' })
    expect(field().getAttribute('data-tone')).toBe('warm')
    expect(screen.queryByTestId('ripple')).toBeNull()
    // …and the state it landed in is fully stated anyway.
    expect(screen.getByText(/2 NIM is on its way/i)).toBeTruthy()
  })

  it('quiets the field on the dead ends rather than promising something to open', () => {
    view('exhausted', { drop: { ...DROP, remaining: 0 } })
    expect(field().getAttribute('data-tone')).toBe('quiet')
    expect(screen.queryByRole('button', { name: /^open/i })).toBeNull()
  })

  /** The ring is decoration and says so, so removing it costs nothing. */
  it('leaves the ring out of the accessibility tree', () => {
    const { rerender } = view('ready')
    rerender(
      <MemoryRouter>
        <DropView {...props('reserved', { serverState: 'reserved' })} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('ripple').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('the printed amount', () => {
  it('is on screen before anything is claimed, including with no wallet', () => {
    view('no-wallet')
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)
    expect(screen.getByRole('link', { name: /open in nimiq pay/i })).toBeTruthy()
    expect(screen.getByRole('img', { name: /qr/i }).getAttribute('src')).toBe(
      `/drop/${PUBLIC_ID}/qr.svg`,
    )
  })

  /**
   * Carried over from the envelope. What overflows a 320px screen is
   * `10000.00000`, not a narrow viewport, so the size steps by character count.
   */
  it('steps the type down so a long amount cannot overflow a 320px screen', () => {
    const size = () => screen.getByTestId('amount-hero').getAttribute('data-size')

    view('ready')
    expect(size()).toBe('lg')

    cleanup()
    view('ready', { drop: { ...DROP, amountEach: '1234.5678' }, amountEach: '1234.5678' })
    expect(size()).toBe('md')

    cleanup()
    view('ready', { drop: { ...DROP, amountEach: '10000.00000' }, amountEach: '10000.00000' })
    expect(size()).toBe('sm')
  })

  /** The number is one run of text and the unit is a separate one, so the unit
      can wrap on its own rather than the number breaking across two lines. */
  it('keeps the number whole and lets only the unit wrap', () => {
    view('ready', { drop: { ...DROP, amountEach: '10000.00000' }, amountEach: '10000.00000' })
    const hero = screen.getByTestId('amount-hero')
    expect(hero.children[0]!.textContent).toBe('10000.00000')
    expect(hero.children[1]!.textContent).toBe('NIM')
    // Read out once, as one fact.
    expect(hero.getAttribute('aria-label')).toBe('10000.00000 NIM')
    expect(hero.children[1]!.getAttribute('aria-hidden')).toBe('true')
  })

  it('earns its one gold keyline only after the backend says paid', () => {
    view('reserved', { serverState: 'reserved' })
    expect(screen.queryByTestId('paid-keyline')).toBeNull()

    cleanup()
    view('paid', { serverState: 'paid', txHash: TX_HASH })
    expect(screen.getByTestId('paid-keyline')).toBeTruthy()
  })
})

describe('the poster composition', () => {
  /**
   * Each fact is one element that a container query moves, not a phone copy and
   * a desktop copy. Rendering both and hiding one would put the count in the
   * accessibility tree twice and let the two drift apart.
   */
  it('renders the share count exactly once', () => {
    view('ready')
    expect(screen.getAllByTestId('remaining')).toHaveLength(1)
    expect(document.querySelectorAll('.nd-facts')).toHaveLength(1)
  })

  it('renders the custody disclosure exactly once, and as a control', () => {
    view('ready')
    const cards = screen.getAllByTestId('custody-disclosure')
    expect(cards).toHaveLength(1)
    // A control in both compositions: moving it out onto the field on a wide
    // screen must not turn it into a line of text nobody can open.
    expect(cards[0]!.tagName).toBe('BUTTON')
    expect(cards[0]!.getAttribute('aria-haspopup')).toBe('dialog')
  })

  /** Not shown while unfunded: NimDrops is holding nothing yet, and a
      disclosure that says otherwise would be the one invented fact on an
      otherwise honest screen. */
  it('does not claim to hold anything before the sponsor has funded it', () => {
    view('awaiting-funding', {
      drop: { ...DROP, state: 'awaiting_funding', remaining: 5, expiresAt: null },
    })
    expect(screen.queryByTestId('custody-disclosure')).toBeNull()
  })

  it('drops the live facts on the dead ends, where there is nothing live left', () => {
    view('expired', { drop: { ...DROP, state: 'settled' } })
    expect(screen.queryByTestId('remaining')).toBeNull()
  })

  it('names the product on the claim path, ahead of the signature request', () => {
    view('ready')
    const mast = document.querySelector('.nd-mast')!
    expect(mast.textContent).toMatch(/NimDrops/)
    expect(mast.textContent).toMatch(/one link, a fixed share each/i)
  })
})

describe('the tabular contract', () => {
  /** Amounts and counts never jitter, and never sit in a proportional font. */
  it.each([
    ['the amount', () => screen.getByTestId('amount-hero'), 'nd-amount'],
    ['the share count', () => document.querySelector('.nd-facts')!, 'nd-facts'],
  ])('gives %s the tabular class the stylesheet keys off', (_what, get, className) => {
    view('ready')
    expect((get() as HTMLElement).className).toContain(className)
  })
})

describe('the trivia slot', () => {
  /**
   * The contract another engineer is building `Trivia.tsx` against. It is
   * asserted here rather than described in a comment somewhere, so that
   * changing the claim surface out from under them fails a test.
   */
  it('puts one caption directly under the amount, and nothing else there', () => {
    view('ready')
    const sheet = screen.getByTestId('claim-sheet')
    const captions = sheet.querySelectorAll('.nd-caption')
    expect(captions).toHaveLength(1)

    const children = Array.from(sheet.children)
    const plate = sheet.querySelector('.nd-plate')!
    expect(children.indexOf(captions[0]! as Element)).toBe(children.indexOf(plate) + 1)
  })

  /**
   * The load-bearing half of the contract. Hiding the amount behind a question
   * would turn a fixed share into a prize for a correct answer, which is the
   * framing the competition rules and the product both push away from.
   */
  it.each(['ready', 'signing', 'degraded', 'reserved'] as const)(
    'keeps the amount above the caption on %s',
    (state) => {
      view(state, state === 'reserved' ? { serverState: 'reserved' } : {})
      const sheet = screen.getByTestId('claim-sheet')
      const amount = within(sheet).getByTestId('amount-hero')
      const caption = sheet.querySelector('.nd-caption')!
      expect(caption).toBeTruthy()
      expect(amount.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    },
  )

  /**
   * The slot's own API, exercised the way `Trivia.tsx` will: a question in
   * `caption` and solid-fill answers in `children`. `GlassSheet` takes no
   * trivia-specific prop and will not grow one.
   */
  it('takes a question and solid-fill answers with no new API', () => {
    const OPTIONS = ['About one second', 'About one minute', 'About ten minutes', 'About an hour']
    render(
      <GlassSheet
        testId="gated"
        header={<p>the amount goes here</p>}
        caption={<h2>How long does a Nimiq block take to confirm?</h2>}
      >
        <div className="mt-3.5 flex flex-col gap-2">
          {OPTIONS.map((option, i) => (
            <button key={option} type="button" className="nd-option" aria-pressed={i === 0}>
              {option}
            </button>
          ))}
        </div>
        <button type="button" className="nd-action mt-5">
          Open 2 NIM
        </button>
      </GlassSheet>,
    )

    const sheet = screen.getByTestId('gated')
    expect(within(sheet).getByRole('heading', { name: /nimiq block/i })).toBeTruthy()

    const answers = within(sheet).getAllByRole('button', { name: /^About/ })
    expect(answers).toHaveLength(4)
    // Solid fills nested in the sheet, never a second pane of glass.
    for (const answer of answers) expect(answer.className).toContain('nd-option')
    // Selection is carried by an ARIA state as well as by the fill, so it is
    // not colour-only and a screen reader hears it.
    expect(answers[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(answers[3]!.getAttribute('aria-pressed')).toBe('false')

    // The question sits between the amount and the action, in that order.
    const order = Array.from(sheet.children)
    expect(order.findIndex((el) => el.classList.contains('nd-caption'))).toBe(1)
  })
})
