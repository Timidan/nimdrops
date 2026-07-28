import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInNimiqPay, storeUrlFor } from './openApp'
import { NIMIQ_PAY_APP_STORE_URL, NIMIQ_PAY_GOOGLE_PLAY_URL } from '../ui/OpenInApp'

/**
 * A window stub whose `location.href` is a plain writable string, so a test can
 * read what the last navigation was without a real navigation happening.
 */
function fakeWindow(visibility: 'visible' | 'hidden' = 'visible') {
  const listeners: Record<string, Set<() => void>> = {}
  const doc = {
    visibilityState: visibility,
    addEventListener: (t: string, f: () => void) => (listeners[`d:${t}`] ??= new Set()).add(f),
    removeEventListener: (t: string, f: () => void) => listeners[`d:${t}`]?.delete(f),
  }
  const win = {
    document: doc,
    location: { href: '' },
    addEventListener: (t: string, f: () => void) => (listeners[`w:${t}`] ??= new Set()).add(f),
    removeEventListener: (t: string, f: () => void) => listeners[`w:${t}`]?.delete(f),
    setTimeout: ((fn: () => void, ms: number) =>
      Number(globalThis.setTimeout(fn, ms))) as unknown as Window['setTimeout'],
    clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as unknown as Window['clearTimeout'],
  }
  const fire = (target: 'd' | 'w', type: string) => {
    for (const f of listeners[`${target}:${type}`] ?? []) f()
  }
  return { win: win as unknown as Window, doc, fire }
}

const DEEPLINK = 'nimiqpay://miniapp?url=https%3A%2F%2Fnimdrops.example%2Fgame%2Fx'

afterEach(() => vi.useRealTimers())

describe('storeUrlFor', () => {
  it('sends Android to Google Play and everyone else to the App Store', () => {
    expect(storeUrlFor('android')).toBe(NIMIQ_PAY_GOOGLE_PLAY_URL)
    expect(storeUrlFor('ios')).toBe(NIMIQ_PAY_APP_STORE_URL)
    expect(storeUrlFor('other')).toBe(NIMIQ_PAY_APP_STORE_URL)
  })
})

describe('openInNimiqPay', () => {
  it('fires the deeplink immediately', () => {
    const { win } = fakeWindow()
    openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win })
    expect((win as unknown as { location: { href: string } }).location.href).toBe(DEEPLINK)
  })

  it('redirects to the store when the app never takes focus', () => {
    vi.useFakeTimers()
    const { win } = fakeWindow('visible')
    let t = 1000
    openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win, now: () => t })
    // The app did not open: the page stayed visible and time advanced normally.
    t = 2200
    vi.advanceTimersByTime(1200)
    expect((win as unknown as { location: { href: string } }).location.href).toBe('https://store')
  })

  it('does NOT redirect when the page is hidden (the app took focus)', () => {
    vi.useFakeTimers()
    const { win } = fakeWindow('hidden')
    openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win })
    vi.advanceTimersByTime(1200)
    // The last navigation is still the deeplink — no store redirect.
    expect((win as unknown as { location: { href: string } }).location.href).toBe(DEEPLINK)
  })

  it('does NOT redirect when visibilitychange fired before the timer', () => {
    vi.useFakeTimers()
    const { win, fire } = fakeWindow('visible')
    openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win })
    fire('d', 'visibilitychange') // app opened, cancels the fallback
    vi.advanceTimersByTime(1200)
    expect((win as unknown as { location: { href: string } }).location.href).toBe(DEEPLINK)
  })

  it('does NOT redirect when the tab was suspended past the delay', () => {
    vi.useFakeTimers()
    const { win } = fakeWindow('visible')
    let t = 1000
    openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win, now: () => t })
    // The timer runs, but the clock shows far more elapsed than scheduled — the
    // tab was frozen while the app was foregrounded.
    t = 5000
    vi.advanceTimersByTime(1200)
    expect((win as unknown as { location: { href: string } }).location.href).toBe(DEEPLINK)
  })

  it('cancels the fallback when cleaned up before it fires', () => {
    vi.useFakeTimers()
    const { win } = fakeWindow('visible')
    let t = 1000
    const cancel = openInNimiqPay({ deeplink: DEEPLINK, storeUrl: 'https://store', win, now: () => t })
    cancel()
    t = 2200
    vi.advanceTimersByTime(1200)
    expect((win as unknown as { location: { href: string } }).location.href).toBe(DEEPLINK)
  })

  it('is a no-op with no window rather than throwing', () => {
    expect(() =>
      openInNimiqPay({ deeplink: DEEPLINK, win: undefined as unknown as Window }),
    ).not.toThrow()
  })
})
