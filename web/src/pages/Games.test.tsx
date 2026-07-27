/**
 * The catalogue of drops that ask something of you.
 *
 * What these tests defend:
 *  - the order is fixed, so the list cannot read as a slot machine;
 *  - a locked card stays visible WITH its payout and its requirement;
 *  - an empty list is a truthful answer, not a broken page;
 *  - no address and no phrase hash reaches the page;
 *  - amounts are exact.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Games from './Games'

function game(over: Record<string, unknown> = {}) {
  return {
    publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
    kind: 'trivia',
    tier: 'medium',
    amountEachLuna: '250000',
    slotsRemaining: 7,
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    unlockRequiresTier: null,
    hint: null,
    ...over,
  }
}

function installFetch(reply: { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    })),
  )
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/games']}>
      <Games />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Games', () => {
  it('groups by kind in a fixed order, whatever order they arrive in', async () => {
    installFetch({
      status: 200,
      body: {
        games: [
          game({ publicId: 'attested-one', kind: 'attested', tier: null }),
          game({ publicId: 'trivia-one', kind: 'trivia' }),
          game({ publicId: 'phrase-one', kind: 'passphrase', tier: null, hint: 'said at 3pm' }),
        ],
      },
    })
    mount()

    await screen.findByTestId('group-passphrase')
    const body = document.body.textContent ?? ''
    // passphrase, then trivia, then attested — the same order the server sorts by.
    expect(body.indexOf('Know the phrase')).toBeLessThan(body.indexOf('Answer five questions'))
    expect(body.indexOf('Answer five questions')).toBeLessThan(
      body.indexOf('Confirmed by the organiser'),
    )
  })

  it('shows the exact payout, the shares left, the expiry and the hint', async () => {
    installFetch({
      status: 200,
      body: {
        games: [
          game({
            publicId: 'phrase-one',
            kind: 'passphrase',
            tier: null,
            hint: 'said at the 3pm talk',
            amountEachLuna: '12345',
            slotsRemaining: 3,
          }),
        ],
      },
    })
    mount()

    const card = await screen.findByTestId('game-phrase-one')
    // Exact, not rounded to 0.12.
    expect(card.textContent).toMatch(/0\.12345\s*NIM/)
    expect(screen.getByTestId('slots-phrase-one').textContent).toMatch(/3 shares left/)
    // Wall clock, not block heights. The exact minute drifts with the test's own
    // elapsed time, so the shape is what matters.
    expect(card.textContent).toMatch(/ends in 1h 5\dm/i)
    expect(screen.getByTestId('hint-phrase-one').textContent).toBe('said at the 3pm talk')
    expect(card.getAttribute('href')).toBe('/game/phrase-one')
  })

  it('keeps a locked card visible, with its payout and its requirement', async () => {
    installFetch({
      status: 200,
      body: {
        games: [game({ publicId: 'hard-one', tier: 'hard', unlockRequiresTier: 'medium' })],
      },
    })
    mount()

    const card = await screen.findByTestId('game-hard-one')
    // The unreachable value is the whole point of showing it.
    expect(card.textContent).toMatch(/2\.5\s*NIM/)
    const locked = screen.getByTestId('locked-hard-one')
    expect(locked.textContent).toMatch(/locked until a medium round has been passed/i)
    // And it still leads somewhere: the server owns the reason, not this page.
    expect(card.getAttribute('href')).toBe('/game/hard-one')
  })

  it('says an empty list is empty, and why, without looking broken', async () => {
    installFetch({ status: 200, body: { games: [] } })
    mount()

    const empty = await screen.findByTestId('games-empty')
    expect(empty.textContent).toMatch(/nothing to earn right now/i)
    expect(empty.textContent).toMatch(/nothing is wrong with this page/i)
    expect(document.body.textContent ?? '').not.toMatch(/error|failed/i)
  })

  it('prints no address and no phrase hash', async () => {
    installFetch({
      status: 200,
      body: {
        games: [
          game({ publicId: 'phrase-one', kind: 'passphrase', tier: null, hint: 'said at 3pm' }),
          game({ publicId: 'trivia-one' }),
        ],
      },
    })
    mount()

    await screen.findByTestId('group-passphrase')
    const html = document.body.innerHTML
    expect(html).not.toMatch(/NQ[0-9A-Z]/i)
    expect(html).not.toMatch(/hash/i)
  })

  it('never promises one tap, and never mentions luck', async () => {
    installFetch({ status: 200, body: { games: [game()] } })
    mount()

    await screen.findByTestId('group-trivia')
    const body = document.body.textContent ?? ''
    expect(body).toMatch(/tap and approve/i)
    expect(body).not.toMatch(/one[\s-]?tap/i)
    expect(body).not.toMatch(/luck|random|jackpot/i)
  })

  it('is honest when the list itself cannot be read', async () => {
    installFetch({ status: 503, body: { error: { code: 'unavailable', message: 'not now' } } })
    mount()

    const panel = await screen.findByTestId('games-error')
    expect(panel.textContent).toMatch(/could not reach NimDrops/i)
    expect(screen.queryByTestId('games-empty')).toBe(null)
  })
})
