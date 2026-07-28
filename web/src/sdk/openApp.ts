/**
 * Open Nimiq Pay, and fall back to the store when it is not installed.
 *
 * A `nimiqpay://` navigation does one of two things on a phone: the app is
 * installed and the OS hands the URL to it, or nothing is registered for the
 * scheme and the browser silently does nothing. The second case is the dead end
 * this exists to remove — a button that appears to do nothing is worse than no
 * button. So after firing the scheme we watch, and if the page is still here a
 * moment later, we send it to the correct store instead.
 *
 * WHY A USER GESTURE, not on load. Mobile browsers block a scheme navigation
 * that is not the direct result of a tap — an on-load `location = 'nimiqpay://'`
 * is either ignored or throws. The tap is not a UX nicety here, it is the only
 * trigger that works.
 *
 * The detection is deliberately belt-and-braces, because no single signal is
 * reliable across iOS Safari, Android Chrome and the in-app browsers people
 * paste links into:
 *
 *  - `visibilitychange` / `pagehide` firing means the app took focus — cancel.
 *  - a long gap between scheduling the timer and it running means the tab was
 *    frozen while the app was open — also cancel. A timer that was meant to run
 *    in 1200ms but runs 3000ms later did not "expire", it was suspended.
 *
 * Only when neither says the app opened do we redirect. Being wrong in that
 * direction sends someone to a store they did not need; being wrong the other
 * way strands someone with no app and no prompt, which is the worse failure.
 */
import { NIMIQ_PAY_APP_STORE_URL, NIMIQ_PAY_GOOGLE_PLAY_URL, detectPlatform } from '../ui/OpenInApp'

/** How long to wait for the app to take focus before assuming it is absent. */
const FALLBACK_DELAY_MS = 1200

/**
 * A timer that runs THIS much later than scheduled means the tab was suspended
 * while the app was foregrounded. Below it, the delay is ordinary scheduling
 * jitter and the app did not open.
 */
const SUSPEND_MARGIN_MS = 700

/** The store a given platform sends an uninstalled user to. */
export function storeUrlFor(platform = detectPlatform()): string {
  return platform === 'android' ? NIMIQ_PAY_GOOGLE_PLAY_URL : NIMIQ_PAY_APP_STORE_URL
}

export interface OpenInNimiqPayOptions {
  /** The `nimiqpay://…` link that reopens the current page in the app. */
  deeplink: string
  /** Where to send a visitor whose device has no Nimiq Pay. */
  storeUrl?: string
  /** Injectable for tests; defaults to the real window. */
  win?: Window
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
}

/**
 * Fire the deeplink and arm the store fallback. Returns a cleanup function that
 * cancels the pending fallback — call it on unmount so a redirect cannot land
 * on a page the user has already left.
 */
export function openInNimiqPay(o: OpenInNimiqPayOptions): () => void {
  const win = o.win ?? (typeof window === 'undefined' ? undefined : window)
  if (!win) return () => {}
  const now = o.now ?? Date.now
  const storeUrl = o.storeUrl ?? storeUrlFor()

  let done = false
  const scheduledAt = now()

  const finish = () => {
    done = true
    win.document.removeEventListener('visibilitychange', onHide)
    win.removeEventListener('pagehide', onHide)
    win.removeEventListener('blur', onHide)
  }

  // The app took focus: whatever we see next, do not send this person to a store.
  function onHide() {
    if (win!.document.visibilityState === 'hidden' || true) finish()
  }

  win.document.addEventListener('visibilitychange', onHide)
  win.addEventListener('pagehide', onHide)
  // `blur` is the coarsest of the three and the most likely to false-positive,
  // so it only counts alongside the timer's own suspend check below — it cancels
  // the fallback but the timer is what would have redirected anyway.
  win.addEventListener('blur', onHide)

  // Firing the scheme. A try/catch because a browser with no handler can throw
  // rather than no-op, and a throw here must not stop the fallback timer.
  try {
    win.location.href = o.deeplink
  } catch {
    /* handled by the fallback below */
  }

  const timer = win.setTimeout(() => {
    if (done) return
    // If far more than the delay has elapsed, the tab was frozen while the app
    // was open — treat that as "the app opened" and do not redirect.
    if (now() - scheduledAt > FALLBACK_DELAY_MS + SUSPEND_MARGIN_MS) {
      finish()
      return
    }
    if (win.document.visibilityState === 'hidden') {
      finish()
      return
    }
    finish()
    win.location.href = storeUrl
  }, FALLBACK_DELAY_MS)

  return () => {
    if (!done) win.clearTimeout(timer)
    finish()
  }
}
