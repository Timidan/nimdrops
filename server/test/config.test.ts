import { afterEach, describe, expect, it } from 'vitest'
import {
  FINALITY_DEPTH_FLOOR_BLOCKS,
  VALIDITY_WINDOW_FLOOR_BLOCKS,
  errorMessage,
  finalityDepthBlocks,
  requireNetwork,
  validityWindowBlocks,
} from '../src/config'

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

const saved = {
  network: process.env.NIMIQ_NETWORK,
  window: process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS,
  depth: process.env.NIMIQ_FINALITY_DEPTH,
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('NIMIQ_NETWORK', saved.network)
  restore('NIMIQ_VALIDITY_WINDOW_BLOCKS', saved.window)
  restore('NIMIQ_FINALITY_DEPTH', saved.depth)
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

/**
 * G1 review findings 1 and 5. Both readers are HARD FLOORED protocol constants:
 * the environment may raise them, never lower them. A window below 7200 makes a
 * live transaction look permanently dead (→ replacement → double pay); a depth
 * below 64 calls a transaction final before a macro block could have finalised
 * the batch it sits in.
 */
describe('validityWindowBlocks', () => {
  it('defaults to the protocol constant when unset or empty', () => {
    delete process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS
    expect(validityWindowBlocks()).toBe(VALIDITY_WINDOW_FLOOR_BLOCKS)
    expect(VALIDITY_WINDOW_FLOOR_BLOCKS).toBe(7200)
    process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS = ''
    expect(validityWindowBlocks()).toBe(VALIDITY_WINDOW_FLOOR_BLOCKS)
  })

  it('lets the environment raise the window', () => {
    process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS = '9000'
    expect(validityWindowBlocks()).toBe(9000)
    process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS = String(VALIDITY_WINDOW_FLOOR_BLOCKS)
    expect(validityWindowBlocks()).toBe(VALIDITY_WINDOW_FLOOR_BLOCKS)
  })

  it('throws on any value below the floor', () => {
    for (const raw of ['7199', '1', '0', '-1']) {
      process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS = raw
      expect(() => validityWindowBlocks(), `window ${raw} must be refused`).toThrow(
        /NIMIQ_VALIDITY_WINDOW_BLOCKS/,
      )
    }
  })

  it('throws on a non-integer value', () => {
    for (const raw of ['7200.5', 'lots', 'NaN']) {
      process.env.NIMIQ_VALIDITY_WINDOW_BLOCKS = raw
      expect(() => validityWindowBlocks()).toThrow(/NIMIQ_VALIDITY_WINDOW_BLOCKS/)
    }
  })
})

describe('finalityDepthBlocks', () => {
  it('defaults to the measured batch-spanning depth when unset', () => {
    delete process.env.NIMIQ_FINALITY_DEPTH
    expect(finalityDepthBlocks()).toBe(FINALITY_DEPTH_FLOOR_BLOCKS)
    expect(FINALITY_DEPTH_FLOOR_BLOCKS).toBe(64)
  })

  it('lets the environment raise the depth', () => {
    process.env.NIMIQ_FINALITY_DEPTH = '128'
    expect(finalityDepthBlocks()).toBe(128)
  })

  it('throws on any value below the floor, including 0', () => {
    for (const raw of ['63', '1', '0', '-5']) {
      process.env.NIMIQ_FINALITY_DEPTH = raw
      expect(() => finalityDepthBlocks(), `depth ${raw} must be refused`).toThrow(
        /NIMIQ_FINALITY_DEPTH/,
      )
    }
  })
})

describe('errorMessage', () => {
  it('unwraps Errors and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('boom')).toBe('boom')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
