import { useState, type ReactNode } from 'react'
import { QrCodeIcon } from './icons'
import './OpenInApp.css'

/**
 * The open-in-app gate, and the app-store fallback the product was missing.
 *
 * ## The failure this exists to close
 *
 * `nimiqPayDeeplink()` builds `nimiqpay://miniapp?url=…`, and until now that was
 * the whole of the no-wallet path. A custom scheme with no handler registered
 * FAILS SILENTLY: the browser does nothing at all — no error, no navigation, no
 * event we could listen for. So a visitor who does not have Nimiq Pay installed
 * pressed a button, watched nothing happen, and was finished with the product.
 * They were not told the app exists, and they were not told where to get it.
 *
 * Three consequences shape this component:
 *
 *  1. **The store is on screen from the first paint.** Not behind a timeout that
 *     "detects" a failed deep link, because there is nothing to detect — the
 *     page stays exactly as it was whether the scheme resolved or not, and a
 *     visibility timer fires just as readily when the wallet DID open. Guessing
 *     wrong there either hides the store from the person who needs it or accuses
 *     someone who has the app of not having it.
 *  2. **Every route out is reachable from every device.** The platform guess
 *     below only ORDERS the two stores and marks one; it never removes the
 *     other, never removes the QR from a phone, and never removes the deep link
 *     from a desktop. User-agent detection is guesswork, and being wrong must
 *     cost a visitor an extra glance rather than the whole path.
 *  3. **The branch is capability, never width.** Callers reach this component
 *     from `BridgeResult.kind === 'unavailable'` (`sdk/adapter.ts`). A narrow
 *     desktop window is still a desktop; a wide tablet may have the wallet.
 *
 * ## Where the two URLs came from
 *
 * Both were verified against the stores themselves rather than transcribed from
 * a research note, because a wrong store id is the same dead end as no link at
 * all, one step later:
 *
 *  - **Apple.** Apple's own lookup API for `bundleId=com.nimiq.pay` returns
 *    track 6471844738, "Nimiq Pay", seller "Nimiq Labs Ltd". The id-only form
 *    used here 301s to the caller's own storefront, so a visitor outside the US
 *    is not sent to a listing they cannot install from.
 *  - **Google.** `id=com.nimiq.pay` answers 200 with the Nimiq Labs listing.
 *
 * Neither URL carries a campaign or referrer parameter. There is nothing to
 * measure and no third party to tell.
 */

/** Storefront-agnostic: Apple 301s this to whichever store the visitor uses. */
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

/**
 * A guess at which store to put first, and it is treated as exactly that.
 *
 * iPadOS 13 and later report a desktop Safari user agent, so an iPad is only
 * separable from a Mac by its touch points. Everything that is not confidently
 * one of the two mobile platforms answers `other`, which orders the stores
 * without marking either — a desktop visitor is being asked which phone they
 * own, and the browser cannot know.
 */
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
  /** Overridable so tests and the design boards can pin the ordering. */
  platform?: Platform
  className?: string
}

/**
 * "You do not have the wallet yet" — the block that was missing everywhere.
 *
 * Standalone rather than folded into {@link OpenInApp} so it can also be hung
 * under the claim screen's sealed gate, which owns its own deep link and QR and
 * only ever lacked this third option.
 */
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
              // A new tab, so the drop link the visitor arrived on is still
              // there when they come back from installing.
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
  /** What this screen is, in one line. A stranger may be reading it first. */
  title: string
  /** Why the wallet is needed here. One or two sentences. */
  children: ReactNode
  /** The `nimiqpay://` link, built by `sdk/adapter.ts`. */
  deepLink: string
  /** The https URL the deep link reopens. Shown as the type-it-yourself fallback. */
  url: string
  /** A QR of `url`, when the surface has one. `/drop/:publicId/qr.svg` on a drop. */
  qrSrc?: string
}

/**
 * The whole gate: deep link, then QR, then the stores, in that order.
 *
 * That order is the order of decreasing confidence. The deep link is instant for
 * the person already holding the right phone; the QR moves the page onto a phone
 * for the person reading on a monitor; the stores are for the person who has
 * neither. None of the three is hidden behind either of the others.
 *
 * There is no degraded desktop composition here and there is not meant to be
 * one. Claiming and funding both end in a Nimiq Pay signature, and Nimiq Pay is
 * a phone app — so a browser that cannot sign gets one finished screen with a
 * way out, not a wide version of a form it can never submit.
 */
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
          /*
           * The same fallback the sealed gate uses when its QR fails to load: a
           * link that has to be read one character at a time, selectable and
           * wrapping rather than overflowing. It is also the ONLY fallback on
           * surfaces the server renders no QR for, such as the create screen.
           */
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
