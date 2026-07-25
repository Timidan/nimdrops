import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBridge, resolveBridge } from './adapter'

/**
 * Kill criterion (docs/goals/nimdrops-cycle1/PLAN.md): "Mock/fake reachable
 * from production entrypoints → blocker." The selection rule is the guard, so
 * it gets a test of its own.
 */
afterEach(() => {
  vi.unstubAllEnvs()
  delete window.nimiq
  delete window.nimiqPay
})

describe('getBridge selection rule', () => {
  it("returns 'unavailable' in a production build with no provider", () => {
    vi.stubEnv('DEV', false)
    expect(window.nimiq).toBeUndefined()
    expect(window.nimiqPay).toBeUndefined()
    expect(getBridge()).toEqual({ kind: 'unavailable' })
  })

  it("never returns 'mock' when import.meta.env.DEV is false", async () => {
    vi.stubEnv('DEV', false)
    expect(getBridge().kind).not.toBe('mock')
    // The polling variant must obey the same rule after the detect timeout.
    await expect(resolveBridge(20).then((r) => r.kind)).resolves.toBe('unavailable')
  })

  it("returns 'real' whenever a provider is present, DEV or not", () => {
    window.nimiqPay = {} as Window['nimiqPay']
    vi.stubEnv('DEV', true)
    expect(getBridge().kind).toBe('real')
    vi.stubEnv('DEV', false)
    expect(getBridge().kind).toBe('real')
  })

  it("falls back to 'mock' only in DEV with no provider", () => {
    vi.stubEnv('DEV', true)
    expect(getBridge().kind).toBe('mock')
  })
})
