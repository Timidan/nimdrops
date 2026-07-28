/**
 * The landing page's entrances.
 *
 * The landing page is a web explainer whose job is to hand the visitor to the
 * mini app, so its calls to action are deeplinks rather than in-page navigation
 * (design: "Calls to action are deeplinks, not web navigation"). Both doors are
 * the same component because they differ only in destination and emphasis.
 *
 * The install fallback is NOT rendered here. `GetNimiqPay` already carries the
 * store badges and the landing page mounts it once in its footer; a copy per
 * door would put the same two badges on the page twice.
 */
import { Link } from 'react-router-dom'
import { hasNimiqProvider, nimiqPayDeeplink } from '../sdk/adapter'

export type AppDoorTone = 'primary' | 'secondary'

export interface AppDoorProps {
  /** In-app path, e.g. `/games`. Followed verbatim inside the wallet, encoded into the deeplink outside it. */
  to: string
  label: string
  tone?: AppDoorTone
  className?: string
}

/**
 * Absolute URL for `to`, with the scheme pinned to https.
 *
 * Nimiq Pay opens an https mini-app URL; inheriting the page's scheme would
 * mean every link built on an http dev origin looks correct in the markup and
 * does nothing on a phone, which is the one failure this component exists to
 * prevent. Returns null for an origin nothing absolute can be built from — an
 * opaque origin reports the string "null" — rather than emitting a half link.
 */
export function absoluteHttps(to: string, origin: string): string | null {
  if (!origin || origin === 'null') return null
  try {
    const url = new URL(to, origin)
    url.protocol = 'https:'
    return url.href
  } catch {
    return null
  }
}

export type AppDoorNav = { kind: 'inapp' } | { kind: 'deeplink'; href: string }

/**
 * Which of the two navigations this page is entitled to.
 *
 * Exported so the no-`window` path is testable without a renderer: the server
 * builds the HTML shell (`server/src/http/ssr.ts`) and a door must degrade
 * there instead of throwing.
 *
 * Deliberately `hasNimiqProvider()` and not `getBridge()`: a DEV build with no
 * provider answers `'mock'`, which is an ordinary browser that must still
 * deeplink. The synchronous read is enough because Nimiq Pay seeds its provider
 * before the mini app's page script runs, and every other host wants the
 * deeplink anyway.
 */
export function appDoorNav(to: string): AppDoorNav {
  // Inside the WebView the page already IS the mini app, so a deeplink would
  // ask the wallet to reopen what is open — losing the session on the way.
  if (typeof window === 'undefined' || hasNimiqProvider()) return { kind: 'inapp' }
  const url = absoluteHttps(to, window.location.origin)
  // No usable origin is not a wallet, but a deeplink carrying no URL is a link
  // to nowhere, whereas router navigation still renders a working href.
  return url === null ? { kind: 'inapp' } : { kind: 'deeplink', href: nimiqPayDeeplink(url) }
}

export default function AppDoor({ to, label, tone = 'primary', className }: AppDoorProps) {
  const classes = [tone === 'primary' ? 'nd-action' : 'nd-quiet', className]
    .filter(Boolean)
    .join(' ')
  const nav = appDoorNav(to)

  if (nav.kind === 'inapp') {
    return (
      <Link to={to} className={classes} data-testid="app-door" data-tone={tone} data-nav="inapp">
        {label}
      </Link>
    )
  }

  // Same tab on purpose. A custom scheme opened with target="_blank" hands the
  // screen to the wallet and leaves an empty tab behind the visitor returns to.
  return (
    <a
      href={nav.href}
      className={classes}
      data-testid="app-door"
      data-tone={tone}
      data-nav="deeplink"
    >
      {label}
    </a>
  )
}
