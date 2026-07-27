/**
 * The claim surface, state by state, and the sealed gate in front of it.
 *
 * `Drop.test.tsx` drives the claim machine through the network. This file
 * drives the SURFACE through every state the machine can hand it, from
 * fixtures, and defends the rules the redesign is held to.
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
 * ## Why the table passes `revealed`
 *
 * A claimant does not land on the claim surface. They land on a full-screen
 * sealed envelope and tap it. `revealed` is the dev and test seam that puts
 * the surface on screen without driving the ritual nineteen times, and the
 * derivation it bypasses — `gateOpened` — is tested directly, on its own,
 * below. Production never passes it: `Drop.tsx` leaves it undefined, and that
 * is asserted too.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DropPublic } from '../api'
import { CLAIM_STORAGE_PREFIX, type ClaimUiState } from '../state/claim'
import GlassSheet from '../ui/GlassSheet'
import DropView, { gateOpened, hasResumableClaim, type DropViewProps } from './DropView'

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

/** The surface behind the gate. Every rule-1 assertion is made against this. */
function view(state: ClaimUiState, over: Partial<DropViewProps> = {}) {
  return render(
    <MemoryRouter>
      <DropView {...props(state, { revealed: true, ...over })} />
    </MemoryRouter>,
  )
}

/** The surface as a claimant actually meets it: the gate derives itself. */
function land(state: ClaimUiState, over: Partial<DropViewProps> = {}) {
  return render(
    <MemoryRouter>
      <DropView {...props(state, over)} />
    </MemoryRouter>,
  )
}

const field = () => document.querySelector('.nd-field')!

beforeEach(() => localStorage.clear())
afterEach(cleanup)

/* -------------------------------------------------------------------------
 * The gate
 * ---------------------------------------------------------------------- */

describe('the sealed gate, in front of everything', () => {
  it('is the first thing a claimant sees, with no amount on it', () => {
    land('ready')
    expect(screen.getByTestId('hold-open')).toBeTruthy()
    expect(screen.queryByTestId('amount-hero')).toBeNull()
    expect(screen.queryByTestId('claim-sheet')).toBeNull()
    expect(screen.queryByRole('button', { name: /claim 2 NIM/i })).toBeNull()
  })

  /**
   * The product name is on the sealed screen, because a stranger has to learn
   * what this is before being asked to hold anything, and the fixed-and-equal
   * fact is on it, because that is what makes concealing a number a ritual
   * rather than a draw.
   */
  it('names the product and states the fixed-and-equal fact', () => {
    land('ready')
    expect(document.querySelector('.nd-mast')!.textContent).toMatch(/NimDrops/)
    expect(screen.getByTestId('reveal-stage').textContent).toMatch(/fixed share of NIM/i)
  })

  /**
   * Branching on the adapter and never on a viewport width. `useClaim` has
   * already folded `bridge.kind === 'unavailable'` into `no-wallet`, so that
   * one state is the whole signal — a narrow desktop window is still a desktop
   * and a phone browser outside Nimiq Pay has the same problem as a monitor.
   */
  it('gives a device that cannot sign the same seal, finished rather than disabled', () => {
    land('no-wallet')
    expect(screen.getByTestId('sealed-envelope')).toBeTruthy()
    expect(screen.queryByTestId('hold-open')).toBeNull()
    expect(screen.queryByTestId('amount-hero')).toBeNull()
    expect(screen.getByRole('link', { name: /open in nimiq pay/i })).toBeTruthy()
    expect(screen.getByRole('img', { name: /qr/i }).getAttribute('src')).toBe(
      `/drop/${PUBLIC_ID}/qr.svg`,
    )
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
  })
})

/**
 * THE landmine, tested as a pure function so it cannot be got wrong by
 * accident. Too eager and a claimant sees an envelope over their
 * own receipt; too shy and the burst re-fires on every status poll tick.
 */
describe('what counts as already opened', () => {
  it.each(['reserved', 'confirming', 'paid'] as const)(
    'opens the gate for an in-flight or settled claim: %s',
    (state) => {
      expect(gateOpened(state, false)).toBe(true)
    },
  )

  it.each(['paused', 'expired', 'exhausted', 'rejected'] as const)(
    'opens the gate flat on a dead end, because bad news must not sit behind a ritual: %s',
    (state) => {
      expect(gateOpened(state, false)).toBe(true)
    },
  )

  it.each(['loading', 'awaiting-funding', 'ready', 'signing', 'degraded'] as const)(
    'keeps the gate sealed while there is an offer to conceal: %s',
    (state) => {
      expect(gateOpened(state, false)).toBe(false)
    },
  )

  /**
   * The frame that would otherwise flash. On boot a resumed claim is `loading`
   * until the first status poll answers; without the stored token the gate
   * would be sealed for that round trip and then flip — and a flip is exactly
   * what the burst hangs off.
   */
  it('opens the gate from the stored claim token, before any poll has answered', () => {
    expect(gateOpened('loading', true)).toBe(true)
    expect(gateOpened('ready', true)).toBe(true)
  })

  /** A device that cannot sign never opens, whatever else is true. */
  it('never opens on a device with no wallet', () => {
    expect(gateOpened('no-wallet', true)).toBe(false)
  })

  it('reads the key the claim machine already owns', () => {
    expect(hasResumableClaim(PUBLIC_ID)).toBe(false)
    localStorage.setItem(
      `${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`,
      JSON.stringify({ claimId: 'c', statusToken: 't' }),
    )
    expect(hasResumableClaim(PUBLIC_ID)).toBe(true)
    expect(hasResumableClaim('some-other-drop')).toBe(false)
  })

  it('lands a resumed claim straight on the surface, with no envelope and no burst', () => {
    localStorage.setItem(
      `${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`,
      JSON.stringify({ claimId: 'c', statusToken: 't' }),
    )
    land('loading')
    expect(screen.queryByTestId('hold-open')).toBeNull()
    expect(screen.queryByTestId('burst')).toBeNull()
    expect(screen.getByTestId('claim-sheet')).toBeTruthy()
  })

  /** Production derives it. Only `/preview` and this file force it. */
  it('is not forced by the page that owns the claim machine', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/Drop.tsx'), 'utf8')
    expect(source).not.toMatch(/revealed/)
  })
})

/* -------------------------------------------------------------------------
 * All thirteen, behind the gate
 * ---------------------------------------------------------------------- */

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
    action: { role: 'button', name: /copy the link/i },
    tone: 'live',
  },
  { state: 'ready', amount: true, action: { role: 'button', name: /claim 2 NIM/i }, tone: 'live' },
  { state: 'signing', amount: true, action: null, tone: 'live' },
  {
    state: 'no-wallet',
    amount: true,
    action: { role: 'link', name: /open in nimiq pay/i },
    tone: 'live',
  },
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

      // Nothing is waiting behind the ritual: the burst is a transient
      // decoration and is never mounted on a state the surface landed in.
      expect(screen.queryByTestId('burst')).toBeNull()
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
      const button = screen.getByRole('button', { name: /claim 2 NIM/i })
      expect(button.textContent).toBe('Claim 2 NIM')
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

/* -------------------------------------------------------------------------
 * Revealed is a state
 * ---------------------------------------------------------------------- */

describe('revealed is a state, not the end of a keyframe', () => {
  it('has nothing to reveal when a reload resumes an already-opened claim', () => {
    land('confirming', { serverState: 'sending' })
    expect(field().getAttribute('data-tone')).toBe('warm')
    expect(screen.queryByTestId('burst')).toBeNull()
    expect(screen.queryByTestId('hold-open')).toBeNull()
    // …and the state it landed in is fully stated anyway.
    expect(screen.getByText(/2 NIM is on its way/i)).toBeTruthy()
  })

  /**
   * The beat that replaced the ring: the sheet dips once when the claim
   * resolves. It is a `data-` attribute on an already-painted surface, so with
   * animation switched off nothing about the sheet changes.
   */
  it('marks the sheet for one dip on the states the claim resolved into', () => {
    view('ready')
    expect(screen.getByTestId('claim-sheet').getAttribute('data-dip')).toBe('false')

    cleanup()
    view('reserved', { serverState: 'reserved' })
    expect(screen.getByTestId('claim-sheet').getAttribute('data-dip')).toBe('true')
  })

  it('quiets the field on the dead ends rather than promising something to open', () => {
    view('exhausted', { drop: { ...DROP, remaining: 0 } })
    expect(field().getAttribute('data-tone')).toBe('quiet')
    expect(screen.queryByRole('button', { name: /^open/i })).toBeNull()
  })

  /** A dead end must not be reached through a ritual. */
  it('does not seal a dead end behind an envelope', () => {
    land('expired', { drop: { ...DROP, state: 'settled' } })
    expect(screen.queryByTestId('hold-open')).toBeNull()
    expect(screen.getByText(/this drop has ended/i)).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------
 * The printed amount
 * ---------------------------------------------------------------------- */

describe('the printed amount', () => {
  it('is on screen before the signature is asked for, and after the seal is broken', () => {
    view('ready')
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)
    const hero = screen.getByTestId('amount-hero')
    const claim = screen.getByRole('button', { name: /claim 2 NIM/i })
    expect(hero.compareDocumentPosition(claim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  /** The number is one run of text and the unit is separate, so the unit can
      wrap on its own rather than the number breaking across two lines. */
  it('keeps the number whole and lets only the unit wrap', () => {
    view('ready', { drop: { ...DROP, amountEach: '10000.00000' }, amountEach: '10000.00000' })
    const hero = screen.getByTestId('amount-hero')
    expect(hero.querySelector('.nim-figure')!.textContent).toBe('10000.00000')
    expect(hero.querySelector('.nim-word')!.textContent).toBe('NIM')
    // Read out once, as one fact.
    expect(hero.getAttribute('aria-label')).toBe('10000.00000 NIM')
    expect(hero.querySelector('.nim-word')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('earns its one celebratory mark only after the backend says paid', () => {
    view('reserved', { serverState: 'reserved' })
    expect(screen.queryByTestId('paid-keyline')).toBeNull()

    cleanup()
    view('paid', { serverState: 'paid', txHash: TX_HASH })
    expect(screen.getByTestId('paid-keyline')).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------
 * Gold
 * ---------------------------------------------------------------------- */

describe('gold appears once on the claim screen, and on the card', () => {
  it('paints the currency mark in ink, not gold, now that it sits on the field', () => {
    view('ready')
    const mark = screen.getByTestId('amount-hero').querySelector('.nim-mark path')!
    expect(mark.getAttribute('fill')).toBe('currentColor')
  })

  it('keeps the shield gold, on the card', () => {
    view('ready')
    const shield = screen.getByTestId('custody-disclosure')
    // `.nd-custody` is a child of the sheet and colours its mark `--nd-accent`.
    expect(shield.className).toContain('nd-custody')
    expect(shield.closest('.nd-glass')).toBeTruthy()
    expect(shield.querySelector('svg')).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------
 * The composition
 * ---------------------------------------------------------------------- */

describe('the s4 composition', () => {
  /**
   * Each fact is one element that a container query moves, not a phone copy and
   * a desktop copy. Rendering both and hiding one would put the count in the
   * accessibility tree twice and let the two drift apart.
   */
  it('renders the share count exactly once', () => {
    view('ready')
    expect(screen.getAllByTestId('remaining')).toHaveLength(1)
    expect(document.querySelectorAll('.nd-tiles')).toHaveLength(1)
  })

  it('renders the custody disclosure exactly once, and as a control', () => {
    view('ready')
    const cards = screen.getAllByTestId('custody-disclosure')
    expect(cards).toHaveLength(1)
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

  it('drops the live tiles on the dead ends, where there is nothing live left', () => {
    view('expired', { drop: { ...DROP, state: 'settled' } })
    expect(screen.queryByTestId('remaining')).toBeNull()
  })

  it('names the product on the claim path, ahead of the signature request', () => {
    view('ready')
    const mast = document.querySelector('.nd-mast')!
    expect(mast.textContent).toMatch(/NimDrops/)
    expect(mast.textContent).toMatch(/one link, a fixed share each/i)
  })

  /** Two 44px circles, and each one has a name a screen reader can read. */
  it('gives every circular affordance an accessible name', () => {
    view('ready')
    const rail = document.querySelector('.nd-rail')!
    const buttons = Array.from(rail.querySelectorAll('button'))
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.className).toContain('nd-round')
    }
  })
})

describe('the tabular contract', () => {
  /** Amounts and counts never jitter, and never sit in a proportional font. */
  it('gives the amount the class the stylesheet keys tabular figures off', () => {
    view('ready')
    expect(screen.getByTestId('amount-hero').querySelector('.nim-figure')).toBeTruthy()
  })

  it.each([
    ['the share count', 'remaining'],
    ['the countdown', 'countdown'],
  ])('gives %s tabular figures', (_what, testId) => {
    view('ready')
    expect(screen.getByTestId(testId).className).toContain('nd-num')
  })
})

/* -------------------------------------------------------------------------
 * The trivia slot
 * ---------------------------------------------------------------------- */

describe('the trivia slot', () => {
  /**
   * The contract another engineer is building `Trivia.tsx` against. It is
   * asserted here rather than described in a comment somewhere, so that
   * changing the claim surface out from under them fails a test.
   *
   * RECONCILED 2026-07-27: the amount is no longer inside the sheet, because
   * the s4 layout puts it in the open field above it. The guarantee that
   * mattered is unchanged and is checked below against the whole screen rather
   * than against the sheet's own children. See the contract on `GlassSheet`.
   */
  it('puts one caption directly under the header, and nothing else there', () => {
    view('ready')
    const sheet = screen.getByTestId('claim-sheet')
    const captions = sheet.querySelectorAll('.nd-caption')
    expect(captions).toHaveLength(1)

    // The header is the sponsor line and their message; the caption is the
    // slot a gated drop's question takes, and it is DIRECTLY beneath it —
    // nothing may be inserted between the two.
    const caption = captions[0]!
    expect(caption.previousElementSibling!.className).toMatch(/nd-message|nd-from/)
    expect(sheet.querySelector('.nd-from')).toBeTruthy()
  })

  /** With no message, the caption still lands immediately under the header. */
  it('keeps the caption directly under the header when the sponsor wrote nothing', () => {
    view('ready', { drop: { ...DROP, message: null } })
    const caption = screen.getByTestId('claim-sheet').querySelector('.nd-caption')!
    expect(caption.previousElementSibling!.className).toContain('nd-from')
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
      const amount = screen.getByTestId('amount-hero')
      const caption = document.querySelector('.nd-caption')!
      expect(caption).toBeTruthy()
      expect(amount.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    },
  )

  /**
   * The slot's own API, exercised the way `Trivia.tsx` will: a question in
   * `caption` and solid-fill answers in `children`, ONE PER LINE. The s4 sample
   * laid them out as a 2x2 grid of tiles; that is not shipped, because the grid
   * is only safe while the option count is exactly four. `GlassSheet` takes no
   * trivia-specific prop and will not grow one.
   */
  it('takes a question and solid-fill answers with no new API', () => {
    const OPTIONS = ['About one second', 'About one minute', 'About ten minutes', 'About an hour']
    render(
      <GlassSheet
        testId="gated"
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
          Claim 2 NIM
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

    // The question comes first, then the answers, then the action.
    const order = Array.from(sheet.children)
    expect(order.findIndex((el) => el.classList.contains('nd-caption'))).toBe(0)
  })

  /** The grab handle is a pseudo-element, so it cannot shift those indices. */
  it('adds no element of its own above the caption', () => {
    render(
      <GlassSheet testId="bare" caption={<p>caption</p>}>
        <p>body</p>
      </GlassSheet>,
    )
    expect(screen.getByTestId('bare').children).toHaveLength(2)
  })
})
