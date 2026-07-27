import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import OpenInApp, {
  detectPlatform,
  GetNimiqPay,
  NIMIQ_PAY_APP_STORE_URL,
  NIMIQ_PAY_GOOGLE_PLAY_URL,
} from './OpenInApp'

afterEach(cleanup)

const DEEP_LINK = 'nimiqpay://miniapp?url=https%3A%2F%2Fnimdrops.example%2Fdrop%2Fabc'
const URL = 'https://nimdrops.example/drop/abc'

function gate(props: Partial<Parameters<typeof OpenInApp>[0]> = {}) {
  return render(
    <OpenInApp title="Open this in Nimiq Pay" deepLink={DEEP_LINK} url={URL} {...props}>
      <p>Claiming needs your own wallet to sign.</p>
    </OpenInApp>,
  )
}

describe('the way out, on every device', () => {
  it('offers the deep link, the link to type, and both stores', () => {
    gate()

    expect(screen.getByRole('link', { name: /open in nimiq pay/i }).getAttribute('href')).toBe(
      DEEP_LINK,
    )
    expect(screen.getByTestId('open-in-app-url').textContent).toContain(URL)
    expect(screen.getByRole('link', { name: /app store/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /google play/i })).toBeTruthy()
  })

  it('shows the stores on the first paint, behind no timer and no interaction', () => {
    gate()
    const stores = within(screen.getByTestId('get-nimiq-pay')).getAllByRole('link')
    expect(stores).toHaveLength(2)
    for (const store of stores) {
      expect(store.hasAttribute('hidden')).toBe(false)
      expect(store.getAttribute('aria-hidden')).toBeNull()
    }
  })

  it('links the store listings that were verified, with no tracking parameters', () => {
    gate()
    const apple = screen.getByRole('link', { name: /app store/i }).getAttribute('href')
    const google = screen.getByRole('link', { name: /google play/i }).getAttribute('href')

    expect(apple).toBe(NIMIQ_PAY_APP_STORE_URL)
    expect(google).toBe(NIMIQ_PAY_GOOGLE_PLAY_URL)
    expect(apple).toBe('https://apps.apple.com/app/id6471844738')
    expect(google).toBe('https://play.google.com/store/apps/details?id=com.nimiq.pay')
    expect(`${apple}${google}`).not.toMatch(/utm_|referrer|pcampaignid|[?&]ct=/)
  })

  it('opens the stores in a new tab, safely', () => {
    gate()
    for (const store of within(screen.getByTestId('get-nimiq-pay')).getAllByRole('link')) {
      expect(store.getAttribute('target')).toBe('_blank')
      expect(store.getAttribute('rel')).toMatch(/noopener/)
      expect(store.getAttribute('rel')).toMatch(/noreferrer/)
    }
    expect(screen.getByTestId('get-nimiq-pay').textContent).toMatch(
      /install Nimiq Pay, then return to this page/i,
    )
  })

  it('shows the QR when the surface has one, and the typed link when it breaks', () => {
    gate({ qrSrc: '/drop/abc/qr.svg' })
    const qr = screen.getByRole('img', { name: /qr/i })
    expect(qr.getAttribute('src')).toBe('/drop/abc/qr.svg')
    expect(screen.queryByTestId('open-in-app-url')).toBeNull()

    fireEvent.error(qr)

    expect(screen.queryByRole('img', { name: /qr/i })).toBeNull()
    expect(screen.getByTestId('open-in-app-url').textContent).toContain(URL)
    expect(screen.getByRole('link', { name: /google play/i })).toBeTruthy()
  })

  it('has no disabled control anywhere on it', () => {
    gate({ qrSrc: '/drop/abc/qr.svg' })
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
  })
})

describe('which store goes first', () => {
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  const MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  it('reads the obvious cases', () => {
    expect(detectPlatform(IPHONE, 5)).toBe('ios')
    expect(detectPlatform(ANDROID, 5)).toBe('android')
    expect(detectPlatform(MAC, 0)).toBe('other')
  })

  it('separates an iPad from a Mac by touch points alone', () => {
    expect(detectPlatform(MAC, 5)).toBe('ios')
  })

  it('answers "other" for anything it cannot place, rather than guessing', () => {
    expect(detectPlatform('', 0)).toBe('other')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)', 0)).toBe('other')
  })

  it('orders the stores by the guess and marks one, hiding neither', () => {
    render(<GetNimiqPay platform="android" />)
    const links = within(screen.getByTestId('get-nimiq-pay')).getAllByRole('link')
    expect(links.map((a) => a.querySelector('img')?.getAttribute('alt'))).toEqual([
      'Get it on Google Play',
      'Download on the App Store',
    ])
    expect(links[0]!.getAttribute('data-likely')).toBe('true')
    expect(links[1]!.getAttribute('data-likely')).toBe('false')
  })

  it('names each badge once, on the image', () => {
    render(<GetNimiqPay platform="other" />)
    for (const link of within(screen.getByTestId('get-nimiq-pay')).getAllByRole('link')) {
      const badge = link.querySelector('img')
      expect(badge?.getAttribute('alt')).toBeTruthy()
      expect(link.getAttribute('aria-label')).toBeNull()
      expect(link.textContent).toBe('')
    }
  })

  it('serves both badges from this origin', () => {
    render(<GetNimiqPay platform="other" />)
    const sources = within(screen.getByTestId('get-nimiq-pay'))
      .getAllByRole('img')
      .map((img) => img.getAttribute('src'))
    expect(sources).toEqual([
      '/badges/download-on-the-app-store.svg',
      '/badges/get-it-on-google-play.png',
    ])
    for (const src of sources) expect(src).not.toMatch(/^https?:/)
  })

  it('marks neither store when it cannot tell, and keeps both reachable', () => {
    render(<GetNimiqPay platform="other" />)
    const links = within(screen.getByTestId('get-nimiq-pay')).getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links.every((a) => a.getAttribute('data-likely') === 'false')).toBe(true)
  })
})
