import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AlertKind, type Alerts, throttled } from '../src/services/alerts'

/**
 * Throttling exists so a paused system cannot page the operator every two
 * seconds. It must never turn into "the second incident was never mentioned":
 * distinct incidents key separately, and the log gets every alert regardless of
 * what the webhook rate limiter decides.
 */

interface Recorded {
  alert: AlertKind
  detail: Record<string, unknown>
}

function recorder(): Alerts & { sent: Recorded[] } {
  const sent: Recorded[] = []
  return {
    sent,
    async notify(alert, detail) {
      sent.push({ alert, detail })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('throttled', () => {
  it('notifies for two manual_review alerts about different transfers in one window', async () => {
    const inner = recorder()
    const alerts = throttled(inner, 60_000)

    await alerts.notify('manual_review', { transferId: 't-1' })
    await alerts.notify('manual_review', { transferId: 't-2' })

    expect(inner.sent.map((a) => a.detail.transferId)).toEqual(['t-1', 't-2'])
  })

  it('suppresses a repeat of the SAME incident inside the window', async () => {
    const inner = recorder()
    const alerts = throttled(inner, 60_000)

    await alerts.notify('manual_review', { transferId: 't-1' })
    await alerts.notify('manual_review', { transferId: 't-1', attempt: 2 })

    expect(inner.sent).toHaveLength(1)
  })

  it('keys on dropId when there is no transferId', async () => {
    const inner = recorder()
    const alerts = throttled(inner, 60_000)

    await alerts.notify('stale_reconciliation', { dropId: 'd-1' })
    await alerts.notify('stale_reconciliation', { dropId: 'd-2' })
    await alerts.notify('stale_reconciliation', { dropId: 'd-1' })

    expect(inner.sent.map((a) => a.detail.dropId)).toEqual(['d-1', 'd-2'])
  })

  it('still throttles a detail-less alert to one per window per alert name', async () => {
    const inner = recorder()
    const alerts = throttled(inner, 60_000)

    await alerts.notify('paused', { reason: 'operator' })
    await alerts.notify('paused', { reason: 'operator' })

    expect(inner.sent).toHaveLength(1)
  })

  it('logs every alert BEFORE the throttle decision, including suppressed ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inner = recorder()
    const alerts = throttled(inner, 60_000)

    await alerts.notify('manual_review', { transferId: 't-1' })
    await alerts.notify('manual_review', { transferId: 't-1' })

    expect(inner.sent, 'the second one was throttled').toHaveLength(1)
    const raised = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('alert_raised'))
    expect(raised, 'both incidents reached the log').toHaveLength(2)
  })

  it('lets the same incident through again once the window has passed', async () => {
    vi.useFakeTimers()
    try {
      const inner = recorder()
      const alerts = throttled(inner, 60_000)

      await alerts.notify('manual_review', { transferId: 't-1' })
      vi.advanceTimersByTime(60_001)
      await alerts.notify('manual_review', { transferId: 't-1' })

      expect(inner.sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
