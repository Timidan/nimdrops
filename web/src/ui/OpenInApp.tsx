import { useState, type ReactNode } from 'react'
import { QrCodeIcon } from './icons'
import './OpenInApp.css'

// Store links stay visible because browsers cannot reliably detect a failed custom-scheme launch.
export const NIMIQ_PAY_APP_STORE_URL = 'https://apps.apple.com/app/id6471844738'
export const NIMIQ_PAY_GOOGLE_PLAY_URL =
  'https://play.google.com/store/apps/details?id=com.nimiq.pay'

export type Platform = 'ios' | 'android' | 'other'

interface Store {
  id: Platform
  name: string
  url: string
  badge: string
  width: number
  height: number
}

const APPLE: Store = {
  id: 'ios',
  name: 'Download on the App Store',
  url: NIMIQ_PAY_APP_STORE_URL,
  badge: '/badges/download-on-the-app-store.svg',
  width: 120,
  height: 40,
}

const GOOGLE: Store = {
  id: 'android',
  name: 'Get it on Google Play',
  url: NIMIQ_PAY_GOOGLE_PLAY_URL,
  badge: '/badges/get-it-on-google-play.png',
  width: 646,
  height: 250,
}

// Platform detection only changes ordering; both stores remain available.
export function detectPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
): Platform {
  if (/android/i.test(userAgent)) return 'android'
  if (/iphone|ipod|ipad/i.test(userAgent)) return 'ios'
  if (/mac(intosh| os x)/i.test(userAgent) && maxTouchPoints > 1) return 'ios'
  return 'other'
}

export interface GetNimiqPayProps {
  platform?: Platform
  className?: string
}

export function GetNimiqPay({ platform, className }: GetNimiqPayProps) {
  const guess = platform ?? detectPlatform()
  const stores = guess === 'android' ? [GOOGLE, APPLE] : [APPLE, GOOGLE]

  return (
    <div className={['nd-getapp', className].filter(Boolean).join(' ')} data-testid="get-nimiq-pay">
      <p className="nd-getapp-head">No Nimiq Pay yet?</p>
      <ul className="nd-getapp-list">
        {stores.map((store) => (
          <li key={store.id}>
            <a
              className="nd-store"
              href={store.url}
              target="_blank"
              rel="noopener noreferrer"
              data-likely={store.id === guess ? 'true' : 'false'}
              data-store={store.id}
            >
              <img src={store.badge} alt={store.name} width={store.width} height={store.height} />
            </a>
          </li>
        ))}
      </ul>
      <p className="nd-note nd-getapp-note">
        Install Nimiq Pay, then return to this page and tap Open in Nimiq Pay. The wallet is free,
        and opening the app does not sign or send anything.
      </p>
    </div>
  )
}

export interface OpenInAppProps {
  title: string
  children: ReactNode
  deepLink: string
  url: string
  qrSrc?: string
}

export default function OpenInApp({ title, children, deepLink, url, qrSrc }: OpenInAppProps) {
  const [qrBroken, setQrBroken] = useState(false)
  const showQr = Boolean(qrSrc) && !qrBroken

  return (
    <div className="nd-openin" data-testid="open-in-app">
      <div className="nd-openin-col">
        <h1 className="nd-openin-title">{title}</h1>
        <div className="nd-openin-lede">{children}</div>

        <a className="nd-action nd-openin-go" href={deepLink}>
          Open in Nimiq Pay
        </a>
        <p className="nd-note nd-openin-hint">
          The wallet opens this same page. Nothing is signed by opening it.
        </p>

        {showQr ? (
          <div className="nd-openin-qr">
            <img
              src={qrSrc}
              alt="QR code for this link"
              width={168}
              height={168}
              onError={() => setQrBroken(true)}
            />
            <p>
              <QrCodeIcon size={14} />
              Scan with the phone that has Nimiq Pay
            </p>
          </div>
        ) : (
          <p className="nd-openin-copy" data-testid="open-in-app-url">
            Or open this link on the phone that has Nimiq Pay
            <code>{url}</code>
          </p>
        )}

        <GetNimiqPay />
      </div>
    </div>
  )
}
