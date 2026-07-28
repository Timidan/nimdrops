import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicStats } from '../api'
import Landing from './Landing'
const css = readFileSync(resolve(process.cwd(), 'src/pages/Landing.css'), 'utf8')
function block(selector: string): string {
  const escaped = selector.replace(/[.[\]*+?^${}()|\\]/g, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^{}]*)\\}`))?.[1]
  expect(found, `${selector} should exist as a top-level rule`).toBeTruthy()
  return found!
}
function keyframes(name: string): string {
  const found = css.match(
    new RegExp(`@keyframes\\s+${name}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`),
  )?.[1]
  expect(found, `@keyframes ${name} should exist`).toBeTruthy()
  return found!
}

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
function row(key: string) {
  return document.querySelector(`[data-stat="${key}"]`) as HTMLElement
}
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
    expect(text).toMatch(/goes back to the sponsor when the claim window closes/i)
    expect(text).toMatch(/24 hours unless they change it/i)
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
  it('says "not measured yet" for an unavailable statistic, never zero', async () => {
    installStats({ body: TINY })
    mount()

    const cell = await waitFor(() =>
      within(row('questionsAnswered')).getByText(/not measured yet/i),
    )
    expect(cell).toBeTruthy()
    expect(within(row('questionsAnswered')).queryByText('0')).toBeNull()
  })
  it('treats a silently absent statistic as unmeasured rather than zero', async () => {
    installStats({
      body: {
        generatedAt: '2026-07-27T14:31:00.000Z',
        stats: {
          totalPaidOut: '2',
          totalPaidOutLuna: '200000',
          uniqueWalletsPaid: 1,
        },
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
    installStats({
      status: 503,
      body: { error: { code: 'stats_unavailable', message: 'no' } },
    })
    mount()

    const panel = await screen.findByTestId('stats-down')
    expect(panel.textContent).toMatch(/not loading right now/i)
    expect(screen.queryByTestId('stats')).toBeNull()
    expect(document.body.textContent).toMatch(/how a drop works/i)
  })

  it('recovers when the retry succeeds', async () => {
    installStats({
      status: 503,
      body: { error: { code: 'stats_unavailable', message: 'no' } },
    })
    mount()
    await screen.findByTestId('stats-down')

    installStats({ body: TINY })
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await money()).toBe('2 NIM')
    expect(screen.queryByTestId('stats-down')).toBeNull()
  })

  it('treats an unreadable body the same as an outage', async () => {
    installStats({
      body: { generatedAt: 'not a date', stats: {}, unavailable: [] },
    })
    mount()
    expect(await screen.findByTestId('stats-down')).toBeTruthy()
  })

  it('survives the request never reaching the server', async () => {
    installStats('network-error')
    mount()
    expect(await screen.findByTestId('stats-down')).toBeTruthy()
  })
})
describe('nothing on this page is revealed by an animation', () => {
  it('never gives an animated element a hidden resting state', () => {
    for (const selector of ['.nd-arrive', '.nd-settle', '.nd-land-packet']) {
      const rule = block(selector)
      expect(rule, selector).not.toMatch(/(^|[;\s])opacity:\s*0(\.0*)?\s*(;|$)/)
      expect(rule, selector).not.toMatch(/visibility:\s*hidden/)
      expect(rule, selector).not.toMatch(/display:\s*none/)
    }
  })

  it('gives the scroll reveal no resting rule at all to hide it with', () => {
    expect(css).not.toMatch(/\n\.nd-rise\s*\{/)
  })
  it('lands every reveal on the visible state', () => {
    for (const name of ['nd-land-arrive', 'nd-land-rise', 'nd-land-settle', 'nd-land-packet-in']) {
      const body = keyframes(name)
      expect(body, name).toMatch(/to\s*\{[^}]*transform:\s*none/)
      // A reveal that never touches opacity cannot hide anything, which is
      // stronger than ending at 1. Only fades have to prove where they land.
      if (/opacity/.test(body)) expect(body, name).toMatch(/to\s*\{[^}]*opacity:\s*1/)
    }
  })
  it('applies the scroll reveal only where the timeline is supported', () => {
    const guarded = css.match(/@supports \(animation-timeline: view\(\)\)\s*\{[\s\S]*?\n\}/)?.[0]
    expect(guarded, 'the view() timeline must sit behind @supports').toBeTruthy()
    expect(guarded).toMatch(/\.nd-rise\s*\{/)
    const unguarded = css.replace(guarded!, '')
    expect(unguarded).not.toMatch(/animation-timeline:\s*view\(\)/)
  })
  it('animates nothing but transform and opacity', () => {
    for (const [, body] of css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
      for (const prop of props) {
        expect(['opacity', 'transform'], `@keyframes property ${prop}`).toContain(prop)
      }
    }
  })
  it('gives reduced motion a fade, with the stagger removed', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0]
    expect(reduced).toBeTruthy()
    expect(reduced).toMatch(/animation:\s*nd-land-fade\s+\d+ms[^;]*!important/)
    expect(reduced).toMatch(/animation-delay:\s*0ms\s*!important/)
    expect(reduced).toMatch(/animation:\s*none\s*!important/)
    expect(keyframes('nd-land-fade')).not.toMatch(/transform/)
  })
  it('moves each reveal far enough to be seen', () => {
    // 18px was invisible on a real page. Anything that drifts back under 30
    // has regressed to a reveal nobody can perceive.
    const travel = (name: string) =>
      Number(keyframes(name).match(/translate3d\([^)]*?(\d+(?:\.\d+)?)px/)?.[1] ?? 0)
    expect(travel('nd-land-arrive')).toBeGreaterThanOrEqual(30)
    expect(travel('nd-land-packet-in')).toBeGreaterThanOrEqual(60)
    expect(keyframes('nd-land-rise')).toMatch(/--rise-y,\s*(?:[5-9]\d|\d{3})px/)
  })

  it('gives the reveal more scroll than the element is tall', () => {
    // An `entry`-relative range is exactly the element's own height, so a 93px
    // card finished its reveal inside 58px of scroll. `cover` is the viewport
    // plus the element, which is a gesture rather than a jump.
    const guarded = css.match(/@supports \(animation-timeline: view\(\)\)\s*\{[\s\S]*?\n\}/)![0]
    expect(guarded).toMatch(/animation-range:\s*cover/)
    expect(guarded).not.toMatch(/animation-range:\s*entry/)
  })

  it('hands the element back after an entrance, so a press can still move it', () => {
    for (const selector of ['.nd-arrive', '.nd-settle']) {
      expect(block(selector), selector).toMatch(/animation:[^;]*\bbackwards\b/)
    }
    const guarded = css.match(/@supports \(animation-timeline: view\(\)\)\s*\{[\s\S]*?\n\}/)![0]
    expect(guarded).toMatch(/animation:[^;]*\bbackwards\b/)
  })

  it('renders the glint only where its mask is supported', () => {
    expect(block('.nd-land-glint')).toMatch(/display:\s*none/)
    expect(css).toMatch(/@supports \(\s*\n?\s*mask-image: image-set\(/)
  })

  it('breathes the bloom without moving it', () => {
    const body = keyframes('nd-land-breathe')
    expect(body).toMatch(/transform:\s*scale\(/)
    expect(body).not.toMatch(/translate/)
  })
})

describe('the custody disclosure', () => {
  it('states the claim itself outside the disclosure', () => {
    installStats({ body: TINY })
    mount()
    const details = document.querySelector('.nd-land-plain-more')!
    const lead = document.querySelector('.nd-land-plain-lead')!
    expect(lead.textContent).toMatch(/custody: not a smart contract, and not your wallet/i)
    expect(details.contains(lead)).toBe(false)
  })
  it('keeps every custody fact reachable', () => {
    installStats({ body: TINY })
    mount()
    const text = document.querySelector('.nd-land-plain-more')!.textContent ?? ''
    expect(text).toMatch(/sent to the wallet that signed and to no other address/i)
    expect(text).toMatch(/anyone holding several wallets can take several shares/i)
    expect(text).toMatch(/public, permanent and readable by anyone/i)
    expect(text).toMatch(/before the network has confirmed it/i)
  })
  it('uses markup a reader can open with no script at all', () => {
    installStats({ body: TINY })
    mount()
    const details = document.querySelector('.nd-land-plain-more')
    expect(details?.tagName).toBe('DETAILS')
    expect(details?.querySelector('summary')?.textContent).toMatch(/what that means in practice/i)
  })
})
describe('the trivia section describes a capability, not a running feature', () => {
  const gate = () => document.querySelector('[aria-labelledby="gate"]')

  it('is on the page whatever the server reports', async () => {
    installStats({ body: TINY })
    mount()
    expect(gate(), 'present before the figures land').toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('stats')).toBeTruthy())
    expect(gate()).toBeTruthy()
  })

  it('survives the endpoint being down, because it never depended on it', async () => {
    installStats({
      status: 503,
      body: { error: { code: 'stats_unavailable', message: 'no' } },
    })
    mount()
    await screen.findByTestId('stats-down')
    expect(gate()).toBeTruthy()
  })

  it('states the mechanics the design fixes', () => {
    installStats({ body: TINY })
    mount()
    const text = gate()!.textContent ?? ''
    expect(text).toMatch(/five questions, four options/i)
    expect(text).toMatch(/one at a time/i)
    expect(text).toMatch(/stamped and timed by the server/i)
    expect(text).toMatch(/never which answer was wrong/i)
  })

  it('says on its face that nothing is running', () => {
    installStats({ body: TINY })
    mount()
    expect(gate()!.textContent).toMatch(/designed, not running yet/i)
  })

  it('sends nobody anywhere: the section holds no link and no button', () => {
    installStats({ body: TINY })
    mount()
    const section = gate()!
    expect(section.querySelectorAll('a')).toHaveLength(0)
    expect(section.querySelectorAll('button')).toHaveLength(0)
  })

  it('leaves the unmeasured figure unmeasured', async () => {
    installStats({ body: TINY })
    mount()
    await waitFor(() => expect(screen.getByTestId('stats')).toBeTruthy())
    expect(within(row('questionsAnswered')).getByText(/not measured yet/i)).toBeTruthy()
    expect(gate()).toBeTruthy()
  })

  it('makes no claim the design says must not be made', () => {
    installStats({ body: TINY })
    mount()

    // Scoped to the gate: "nothing to win by trying" is the custody
    // disclosure disclaiming a prize, which is the opposite failure.
    const text = (gate()!.textContent ?? '').toLowerCase()
    for (const banned of ['lucky', 'jackpot', 'prize', 'win', 'reward', 'bonus', 'streak']) {
      expect(text, `must not say "${banned}"`).not.toContain(banned)
    }
    expect(text).not.toMatch(/cheat|anti-?bot|proctor|fraud-proof|sybil|guarantee/)
    // Nor may it imply a visitor could go and play one.
    expect(text).not.toMatch(/try it|play|available now|live now|get started/)
  })
})

describe('the page is short', () => {
  it('keeps the first read under 340 words', () => {
    installStats({ body: TINY })
    mount()

    const main = document.querySelector('main')!
    const detail = main.querySelector('.nd-land-plain-detail')
    detail?.remove()

    const words = (main.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => /[a-z0-9]/i.test(w))

    expect(words.length).toBeLessThan(340)
  })
})
