import { afterEach, describe, expect, it } from 'vitest'
import { errorMessage, requireNetwork } from '../src/config'

/**
 * `requireNetwork` is the single network validator; a silent default anywhere
 * would let a testnet build sign against mainnet (or the reverse) without ever
 * saying so. These tests exist to keep that failure loud.
 *
 * Kept import-free on purpose: `nimiqChainFromEnv`'s own fail-closed behaviour
 * is asserted in `transfers.race.test.ts`, which already pays for the
 * `@nimiq/core` WASM load. Pulling that bundle into a second file would add
 * real CPU contention alongside the wall-clock race suites.
 */

const savedNetwork = process.env.NIMIQ_NETWORK

afterEach(() => {
  if (savedNetwork === undefined) delete process.env.NIMIQ_NETWORK
  else process.env.NIMIQ_NETWORK = savedNetwork
})

describe('requireNetwork', () => {
  it('accepts exactly the two supported networks', () => {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    expect(requireNetwork()).toBe('TestAlbatross')
    process.env.NIMIQ_NETWORK = 'MainAlbatross'
    expect(requireNetwork()).toBe('MainAlbatross')
  })

  it('throws when NIMIQ_NETWORK is unset', () => {
    delete process.env.NIMIQ_NETWORK
    expect(() => requireNetwork()).toThrow(/NIMIQ_NETWORK/)
  })

  it('throws on an unrecognised network name', () => {
    process.env.NIMIQ_NETWORK = 'DevAlbatross'
    expect(() => requireNetwork()).toThrow(/NIMIQ_NETWORK/)
  })
})

describe('errorMessage', () => {
  it('unwraps Errors and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('boom')).toBe('boom')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
