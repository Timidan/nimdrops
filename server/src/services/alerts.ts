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
 * financial record, the webhook is only a courtesy. Every failure degrades to
 * `console.warn` so the event still lands in the host's log.
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
  notify(kind: AlertKind, detail: Record<string, unknown>): Promise<void>
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
 * Values are logged, so redact per design §10.3 before they get here: no
 * signatures, no raw transactions, no full claimant addresses. Callers pass
 * internal IDs and hashes, which are already public on-chain identifiers.
 */
function line(kind: AlertKind, detail: Record<string, unknown>, note?: string): string {
  return JSON.stringify({ event: 'alert', kind, ...(note ? { note } : {}), detail })
}

export function createAlerts(o: AlertsOptions = {}): Alerts {
  const timeoutMs = o.timeoutMs ?? ALERT_TIMEOUT_MS
  const source = o.source ?? 'nimdrops'

  return {
    async notify(kind, detail) {
      const url = o.webhookUrl ?? process.env.ALERT_WEBHOOK_URL
      const body = { kind, source, at: new Date().toISOString(), detail }

      // Always log: the webhook is best-effort, the log is not.
      if (kind === 'heartbeat') console.info(line(kind, detail))
      else console.warn(line(kind, detail))

      if (!url) return

      const doFetch = o.fetchImpl ?? globalThis.fetch
      if (typeof doFetch !== 'function') {
        console.warn(line(kind, detail, 'no fetch implementation available'))
        return
      }

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) console.warn(line(kind, detail, `webhook responded ${res.status}`))
      } catch (err) {
        // Includes the 5s timeout abort. Never rethrow: see the module note.
        console.warn(line(kind, detail, `webhook failed: ${errorMessage(err)}`))
      }
    },
  }
}

/** Alerts that only log. Used by CLIs and by tests that assert on stdout. */
export function consoleAlerts(): Alerts {
  return createAlerts({ webhookUrl: undefined, fetchImpl: undefined })
}

/**
 * Suppress repeats of the same kind inside `windowMs`.
 *
 * The worker ticks every 2s; a paused system with queued work would otherwise
 * emit an alert every 2s until an operator intervened. Throttling lives here
 * rather than in `transfers.ts` so the service stays pure and every alert is
 * observable in tests.
 */
export function throttled(inner: Alerts, windowMs = 5 * 60_000): Alerts {
  const lastSentAt = new Map<AlertKind, number>()
  return {
    async notify(kind, detail) {
      const now = Date.now()
      const previous = lastSentAt.get(kind)
      if (previous !== undefined && now - previous < windowMs) return
      lastSentAt.set(kind, now)
      await inner.notify(kind, detail)
    },
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
