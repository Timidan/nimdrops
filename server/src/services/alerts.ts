import { errorMessage } from '../config'
import { redact, safeLog } from '../http/redact'

/**
 * Operator alerts (design §10.3, PLAN.md "Operator" target perspective).
 *
 * The owner must learn about `manual_review`, `paused` and stale-reconciliation
 * transitions without watching logs. This module is the whole notification
 * surface: a single webhook POST, plus a daily heartbeat that proves the worker
 * is alive (silence from a dead process is indistinguishable from silence from
 * a healthy one).
 *
 * Hard rule: `notify` NEVER throws and never blocks the money path for long.
 * An alerting outage must not stop or slow a payout — the database is the
 * financial record, the webhook is only a courtesy. Every failure degrades to a
 * redacted `safeLog` line so the event still lands in the host's log.
 */

/**
 * `insolvent` covers every refusal of the design §10.2 invariant — a custody
 * balance that no longer covers outstanding principal plus the fee reserve, or
 * a live-principal cap that a signature would exceed. Both mean the same thing
 * operationally: money is owed that the worker will not sign for until a human
 * tops up custody or raises the cap.
 */
export type AlertKind =
  | 'manual_review'
  | 'paused'
  | 'stale_reconciliation'
  | 'insolvent'
  | 'heartbeat'

export interface Alerts {
  notify(alert: AlertKind, detail: Record<string, unknown>): Promise<void>
}

/** A slow webhook must never hold up a broadcast or a confirmation. */
export const ALERT_TIMEOUT_MS = 5_000

export interface AlertsOptions {
  /** Defaults to `ALERT_WEBHOOK_URL`; alerts degrade to the log when unset. */
  webhookUrl?: string | undefined
  timeoutMs?: number
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Free-form label so several deployments can share one webhook. */
  source?: string
}

/**
 * Every alert line, redacted (§10.3).
 *
 * This used to be a comment asking callers to sanitise `detail` themselves.
 * It is now `http/redact.ts`, applied here: an alert carries whatever the
 * failing money path happened to have in hand, which is exactly the material
 * §10.3 lists — and `notify` is called from `catch` blocks where the only
 * available context is a driver's error text.
 *
 * The webhook gets the same treatment further down. It is a THIRD-PARTY
 * endpoint; posting a claimant's full address to it is not better than logging
 * it, it is worse.
 */
function emit(alert: AlertKind, detail: Record<string, unknown>, note?: string): void {
  // Heartbeats are routine; everything else is something an operator must see.
  const level = alert === 'heartbeat' ? 'info' : 'warn'
  safeLog(level, 'alert', { alert, ...(note ? { note } : {}), detail })
}

export function createAlerts(o: AlertsOptions = {}): Alerts {
  const timeoutMs = o.timeoutMs ?? ALERT_TIMEOUT_MS
  const source = o.source ?? 'nimdrops'

  return {
    async notify(alert, detail) {
      const url = o.webhookUrl ?? process.env.ALERT_WEBHOOK_URL
      const body = { alert, source, at: new Date().toISOString(), detail: redact(detail) }

      // Always log: the webhook is best-effort, the log is not.
      emit(alert, detail)

      if (!url) return

      const doFetch = o.fetchImpl ?? globalThis.fetch
      if (typeof doFetch !== 'function') {
        emit(alert, detail, 'no fetch implementation available')
        return
      }

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) emit(alert, detail, `webhook responded ${res.status}`)
      } catch (err) {
        // Includes the 5s timeout abort. Never rethrow: see the module note.
        emit(alert, detail, `webhook failed: ${errorMessage(err)}`)
      }
    },
  }
}

/** Alerts that only log. Used by CLIs and by tests that assert on stdout. */
export function consoleAlerts(): Alerts {
  return createAlerts({ webhookUrl: undefined, fetchImpl: undefined })
}

/**
 * Rate-limit repeats of the SAME INCIDENT inside `windowMs`.
 *
 * The worker ticks every 2s; a paused system with queued work would otherwise
 * emit an alert every 2s until an operator intervened. Throttling lives here
 * rather than in `transfers.ts` so the service stays pure and every alert is
 * observable in tests.
 *
 * Two properties keep this from hiding money problems:
 *
 *  1. The log gets EVERY alert, unconditionally, before any throttle decision.
 *     What we rate-limit is the webhook, never the record. A suppressed alert
 *     that left no trace would be worse than no throttling at all.
 *  2. The window is keyed per incident, not per alert name. Keying on the name
 *     alone meant once one transfer went to `manual_review`, the next five
 *     minutes of *other* transfers failing were silently swallowed — the
 *     operator would fix one stuck payout and never learn about the rest.
 */
export function throttled(inner: Alerts, windowMs = 5 * 60_000): Alerts {
  const lastSentAt = new Map<string, number>()
  return {
    async notify(alert, detail) {
      // (1) The unconditional record. Distinct event name so it is never
      // confused with what actually went out over the webhook.
      safeLog('warn', 'alert_raised', { alert, detail })

      // (2) One bucket per incident. Alerts that name no subject (heartbeat,
      // paused, insolvent) share the empty key and stay one-per-window.
      const key = `${alert}:${incidentId(detail)}`
      const now = Date.now()
      const previous = lastSentAt.get(key)
      if (previous !== undefined && now - previous < windowMs) return
      lastSentAt.set(key, now)
      await inner.notify(alert, detail)
    },
  }
}

/** The subject of an alert, when it has one. Only ever used as a map key. */
function incidentId(detail: Record<string, unknown>): string {
  const subject = detail.transferId ?? detail.dropId ?? ''
  return typeof subject === 'string' ? subject : String(subject)
}
