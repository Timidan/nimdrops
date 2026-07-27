/**
 * The landing page, and the rule that decides most of these tests: **no number
 * on this page may be invented.**
 *
 * `GET /api/stats` distinguishes "this measured zero" from "this cannot be
 * measured", and it does that by NAMING the unmeasurable statistic in
 * `unavailable` and leaving it out of `stats`. A client that substituted `0`
 * would erase the distinction the endpoint was built to keep, and would publish
 * a figure nobody computed. Four states are asserted below — populated, tiny,
 * unavailable, and the endpoint being down — because they are four different
 * sentences rather than four skins of one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicStats } from '../api'
import Landing from './Landing'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TINY: PublicStats = {
  generatedAt: '2026-07-27T14:31:00.000Z',
  stats: {
    totalPaidOut: '2',
    totalPaidOutLuna: '200000',
    uniqueWalletsPaid: 1,
    dropsFunded: 1,
    sharesClaimed: 1,
  },
  unavailable: ['questionsAnswered'],
}

function installStats(reply: { status?: number; body?: unknown } | 'network-error') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      if (!String(input).endsWith('/api/stats')) throw new Error(`unscripted fetch: ${input}`)
      if (reply === 'network-error') throw new TypeError('failed to fetch')
      return {
        ok: (reply.status ?? 200) < 400,
        status: reply.status ?? 200,
        json: async () => reply.body ?? {},
        headers: { get: () => null },
      }
    }),
  )
}

function mount() {
  return render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  )
}

/** The row for one statistic, by the key the API uses. */
function row(key: string) {
  return document.querySelector(`[data-stat="${key}"]`) as HTMLElement
}

/**
 * The money, read off the lead entry.
 *
 * `getByText` cannot see it: the figure and its unit are two elements so the
 * unit can be set at its own size, which is what keeps `1284.5` from having a
 * `NIM` the same height as the digits. The rendered text is still one string.
 */
async function money(): Promise<string> {
  const lead = await waitFor(() => {
    const el = row('totalPaidOut')
    if (!el || el.querySelector('.nd-ledger-wait')) throw new Error('still loading')
    return el
  })
  return (lead.querySelector('dd')?.textContent ?? '').trim()
}

describe('what a stranger is told', () => {
  it('states the whole product: one sponsor, equal shares, and the refund', async () => {
    installStats({ body: TINY })
    mount()

    const text = document.body.textContent ?? ''
    expect(text).toMatch(/fixed share of NIM for everyone who opens it/i)
    expect(text).toMatch(/one share per wallet, first come, first served/i)
    // The refund is stated as a window the sponsor sets, with the default
    // named. Asserting "24 hours" as the rule would be asserting something the
    // product stopped doing when the window became a choice.
    expect(text).toMatch(/goes back to the sponsor when the claim window closes/i)
    expect(text).toMatch(/24 hours unless they change it/i)
    // The uncomfortable fact is on the page, not one tap behind it.
    expect(text).toMatch(/custody: not a smart contract, and not your wallet/i)
    await waitFor(() => expect(screen.getByTestId('stats')).toBeTruthy())
  })

  it('has one first-level heading, and it is the product claim', () => {
    installStats({ body: TINY })
    mount()
    const h1s = document.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0]!.textContent).toMatch(/one link/i)
  })

  /** The landing is the one page a browser is allowed to read, so it carries
      the way into the app for someone who does not have the wallet. */
  it('carries the app-store block for a reader with no Nimiq Pay', () => {
    installStats({ body: TINY })
    mount()
    const block = screen.getByTestId('get-nimiq-pay')
    expect(within(block).getByRole('link', { name: /app store/i })).toBeTruthy()
    expect(within(block).getByRole('link', { name: /google play/i })).toBeTruthy()
  })
})

describe('the figures', () => {
  it('prints the real ones, however small they are', async () => {
    installStats({ body: TINY })
    mount()

    expect(await money()).toBe('2 NIM')
    expect(within(row('uniqueWalletsPaid')).getByText('1')).toBeTruthy()
    expect(within(row('sharesClaimed')).getByText('1')).toBeTruthy()
    expect(within(row('dropsFunded')).getByText('1')).toBeTruthy()
    expect(document.body.textContent).toMatch(/Read 27 July 2026 at 14:31 UTC/)
  })

  it('prints a populated deployment the same way, with grouped digits', async () => {
    installStats({
      body: {
        generatedAt: '2026-07-27T14:31:00.000Z',
        stats: {
          totalPaidOut: '1284.5',
          totalPaidOutLuna: '128450000',
          uniqueWalletsPaid: 412,
          dropsFunded: 63,
          sharesClaimed: 508,
          questionsAnswered: 1097,
        },
        unavailable: [],
      } satisfies PublicStats,
    })
    mount()

    expect(await money()).toBe('1284.5 NIM')
    expect(within(row('questionsAnswered')).getByText('1,097')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/not measured yet/i)
  })

  /**
   * THE rule. `questionsAnswered` has no backing table until the trivia
   * migration lands, so the server names it and omits it. Rendering `0` there
   * would state that nobody has answered a question, which is a measurement
   * nobody took.
   */
  it('says "not measured yet" for an unavailable statistic, never zero', async () => {
    installStats({ body: TINY })
    mount()

    const cell = await waitFor(() => within(row('questionsAnswered')).getByText(/not measured yet/i))
    expect(cell).toBeTruthy()
    expect(within(row('questionsAnswered')).queryByText('0')).toBeNull()
  })

  /** A key the server sent neither in `stats` nor in `unavailable`. Same answer:
      we did not measure it, so we do not print a number for it. */
  it('treats a silently absent statistic as unmeasured rather than zero', async () => {
    installStats({
      body: {
        generatedAt: '2026-07-27T14:31:00.000Z',
        stats: { totalPaidOut: '2', totalPaidOutLuna: '200000', uniqueWalletsPaid: 1 },
        unavailable: [],
      },
    })
    mount()

    expect(await money()).toBe('2 NIM')
    for (const key of ['sharesClaimed', 'dropsFunded', 'questionsAnswered']) {
      expect(within(row(key)).getByText(/not measured yet/i)).toBeTruthy()
      expect(within(row(key)).queryByText('0')).toBeNull()
    }
  })

  /** A genuine zero is a measurement and prints as one. This is the other half
      of the rule above: absent and zero must not collapse into each other. */
  it('prints a measured zero as zero', async () => {
    installStats({
      body: {
        generatedAt: '2026-07-27T14:31:00.000Z',
        stats: {
          totalPaidOut: '0',
          totalPaidOutLuna: '0',
          uniqueWalletsPaid: 0,
          dropsFunded: 0,
          sharesClaimed: 0,
        },
        unavailable: ['questionsAnswered'],
      } satisfies PublicStats,
    })
    mount()

    expect(await money()).toBe('0 NIM')
    expect(within(row('uniqueWalletsPaid')).getByText('0')).toBeTruthy()
    expect(within(row('questionsAnswered')).getByText(/not measured yet/i)).toBeTruthy()
  })

  it('shows no figure at all while the request is in flight', () => {
    installStats({ body: TINY })
    mount()
    expect(screen.getByTestId('stats').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('stats').textContent).not.toMatch(/\d/)
  })
})

describe('when the endpoint is down', () => {
  it('says so and offers a retry, instead of zeros or an empty table', async () => {
    installStats({ status: 503, body: { error: { code: 'stats_unavailable', message: 'no' } } })
    mount()

    const panel = await screen.findByTestId('stats-down')
    expect(panel.textContent).toMatch(/not loading right now/i)
    expect(screen.queryByTestId('stats')).toBeNull()
    // The rest of the page is unaffected: a missing figure is not an outage.
    expect(document.body.textContent).toMatch(/how a drop works/i)
  })

  it('recovers when the retry succeeds', async () => {
    installStats({ status: 503, body: { error: { code: 'stats_unavailable', message: 'no' } } })
    mount()
    await screen.findByTestId('stats-down')

    installStats({ body: TINY })
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await money()).toBe('2 NIM')
    expect(screen.queryByTestId('stats-down')).toBeNull()
  })

  it('treats an unreadable body the same as an outage', async () => {
    installStats({ body: { generatedAt: 'not a date', stats: {}, unavailable: [] } })
    mount()
    expect(await screen.findByTestId('stats-down')).toBeTruthy()
  })

  it('survives the request never reaching the server', async () => {
    installStats('network-error')
    mount()
    expect(await screen.findByTestId('stats-down')).toBeTruthy()
  })
})
