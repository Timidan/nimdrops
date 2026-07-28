/**
 * The origin is pinned to a realistic https host because the deeplink's whole
 * payload is this page's absolute URL, and asserting against jsdom's default
 * `http://localhost:<port>` would hide the scheme rule the component enforces.
 *
 * @vitest-environment-options { "url": "https://nimdrops.example/" }
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppDoor, { absoluteHttps, appDoorNav } from './AppDoor'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.nimiq
  delete window.nimiqPay
})

function door(props: Partial<Parameters<typeof AppDoor>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AppDoor to="/games" label="Answer five questions" {...props} />
    </MemoryRouter>,
  )
}

/** What Nimiq Pay is asked to open, spelled out rather than rebuilt from the source. */
const DEEPLINK = 'nimiqpay://miniapp?url=https%3A%2F%2Fnimdrops.example%2Fgames'

describe('a web visitor, outside the wallet', () => {
  it('hands the page to Nimiq Pay instead of navigating the site', () => {
    door()

    const link = screen.getByRole('link', { name: 'Answer five questions' })
    expect(link.getAttribute('href')).toBe(DEEPLINK)
    expect(link.getAttribute('href')).toContain('nimiqpay://miniapp?url=')
    expect(link.getAttribute('href')).toContain(
      encodeURIComponent('https://nimdrops.example/games'),
    )
    expect(link.getAttribute('data-nav')).toBe('deeplink')
  })

  it('keeps the visitor in the same tab, so the wallet does not leave one behind', () => {
    door()
    expect(screen.getByTestId('app-door').getAttribute('target')).toBeNull()
  })

  it('carries the query string of the destination into the encoded URL', () => {
    door({ to: '/create?amount=5' })
    expect(screen.getByTestId('app-door').getAttribute('href')).toBe(
      `nimiqpay://miniapp?url=${encodeURIComponent('https://nimdrops.example/create?amount=5')}`,
    )
  })
})

describe('already inside the Nimiq Pay WebView', () => {
  it('navigates in-app rather than asking the wallet to reopen itself', () => {
    window.nimiqPay = {} as Window['nimiqPay']
    door()

    const link = screen.getByRole('link', { name: 'Answer five questions' })
    expect(link.getAttribute('href')).toBe('/games')
    expect(link.getAttribute('href')).not.toContain('nimiqpay://')
    expect(link.getAttribute('data-nav')).toBe('inapp')
  })

  it('treats an injected provider under either name as being inside', () => {
    window.nimiq = {} as Window['nimiq']
    door({ to: '/create', label: 'Create a drop' })
    expect(screen.getByRole('link', { name: 'Create a drop' }).getAttribute('href')).toBe('/create')
  })
})

describe('the door itself', () => {
  it('renders its label as the accessible name', () => {
    door({ label: 'Create a drop' })
    expect(screen.getByRole('link', { name: 'Create a drop' }).textContent).toBe('Create a drop')
  })

  it('carries the emphasis it was given, defaulting to primary', () => {
    door()
    expect(screen.getByTestId('app-door').className).toContain('nd-action')
    cleanup()

    door({ tone: 'secondary', className: 'nd-land-foot-cta' })
    const quiet = screen.getByTestId('app-door')
    expect(quiet.className).toContain('nd-quiet')
    expect(quiet.className).toContain('nd-land-foot-cta')
  })
})

describe('rendered where there is no browser', () => {
  it('falls back to in-app navigation instead of throwing', () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('navigator', undefined)

    expect(() => appDoorNav('/games')).not.toThrow()
    expect(appDoorNav('/games')).toEqual({ kind: 'inapp' })
  })

  it('refuses to build a half link from an origin it cannot resolve', () => {
    // An opaque origin — a sandboxed frame or a file:// document — reports the
    // literal string "null", which URL() would happily accept as a base.
    expect(absoluteHttps('/games', '')).toBeNull()
    expect(absoluteHttps('/games', 'null')).toBeNull()
  })

  it('upgrades a plain-http origin, because the wallet only opens https', () => {
    expect(absoluteHttps('/games', 'http://localhost:5173')).toBe('https://localhost:5173/games')
  })
})
