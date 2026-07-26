import { KeyPair, PrivateKey } from '@nimiq/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NimiqChain,
  ReadOnlyChainError,
  nimiqChainFromEnv,
  readOnlyNimiqChainFromEnv,
} from '../src/chain/nimiq'

/**
 * The API process must not be able to move money (design §10.3: "keep the
 * signing code narrow and the runtime access restricted").
 *
 * Before this, `index.ts` required `CUSTODY_PRIVATE_KEY_HEX` for one reason —
 * `NimiqChain`'s constructor derived the custody ADDRESS from it — so the hot
 * key sat in the environment and the heap of the only internet-facing process
 * in the deployment, in exchange for a 44-character string. These tests pin
 * both halves of the fix: the read-only client answers every read the API makes,
 * and every write path on it throws.
 *
 * All of it is offline. Key derivation and address parsing happen in the WASM
 * module at import time; nothing here connects to a network.
 */

// Deterministic, non-secret, and never funded: a test vector, not a wallet.
const TEST_KEY = '1'.repeat(64)
const TEST_ADDRESS = KeyPair.derive(PrivateKey.fromHex(TEST_KEY)).toAddress().toUserFriendlyAddress()

/** A different wallet, so a signed transaction is not sender-to-itself. */
const OTHER_KEY = '2'.repeat(64)
const OTHER_ADDRESS = KeyPair.derive(PrivateKey.fromHex(OTHER_KEY))
  .toAddress()
  .toUserFriendlyAddress()

const SIGN_ARGS = { to: OTHER_ADDRESS, valueLuna: 1_000n, validityStartHeight: 1 }

const saved = {
  network: process.env.NIMIQ_NETWORK,
  key: process.env.CUSTODY_PRIVATE_KEY_HEX,
  address: process.env.CUSTODY_ADDRESS,
}

beforeEach(() => {
  process.env.NIMIQ_NETWORK = 'TestAlbatross'
  delete process.env.CUSTODY_PRIVATE_KEY_HEX
  delete process.env.CUSTODY_ADDRESS
})

afterEach(() => {
  for (const [name, value] of [
    ['NIMIQ_NETWORK', saved.network],
    ['CUSTODY_PRIVATE_KEY_HEX', saved.key],
    ['CUSTODY_ADDRESS', saved.address],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('NimiqChain read-only mode', () => {
  it('reports the custody address from CUSTODY_ADDRESS, with no key in the process', () => {
    const chain = new NimiqChain({ network: 'TestAlbatross', custodyAddress: TEST_ADDRESS })
    expect(chain.isReadOnly()).toBe(true)
    expect(chain.custodyAddress()).toBe(TEST_ADDRESS)
    expect(chain.network()).toBe('TestAlbatross')
  })

  it('normalises the address it was given, so both modes answer identically', () => {
    const spaced = new NimiqChain({ network: 'TestAlbatross', custodyAddress: TEST_ADDRESS })
    const unspaced = new NimiqChain({
      network: 'TestAlbatross',
      custodyAddress: TEST_ADDRESS.replace(/ /g, ''),
    })
    const signing = new NimiqChain({ network: 'TestAlbatross', custodyPrivateKeyHex: TEST_KEY })

    expect(unspaced.custodyAddress()).toBe(TEST_ADDRESS)
    expect(spaced.custodyAddress()).toBe(signing.custodyAddress())
  })

  it('refuses to build a signed transaction', async () => {
    const chain = new NimiqChain({ network: 'TestAlbatross', custodyAddress: TEST_ADDRESS })
    await expect(chain.buildSignedBasic(SIGN_ARGS)).rejects.toBeInstanceOf(ReadOnlyChainError)
  })

  it('refuses even before validating its arguments, so it cannot be probed', async () => {
    const chain = new NimiqChain({ network: 'TestAlbatross', custodyAddress: TEST_ADDRESS })
    // A signing client rejects this on `valueLuna`; a read-only one must give
    // the same answer to every call it will never perform.
    await expect(
      chain.buildSignedBasic({ ...SIGN_ARGS, valueLuna: 0n }),
    ).rejects.toBeInstanceOf(ReadOnlyChainError)
  })

  it('refuses to broadcast bytes somebody else signed', async () => {
    const chain = new NimiqChain({ network: 'TestAlbatross', custodyAddress: TEST_ADDRESS })
    // No network call is reachable: the guard is before `connect()`.
    await expect(chain.broadcast('00'.repeat(20))).rejects.toBeInstanceOf(ReadOnlyChainError)
  })

  it('rejects a custody address that is not an address, at construction', () => {
    expect(() => new NimiqChain({ network: 'TestAlbatross', custodyAddress: 'NQ99 NOPE' })).toThrow()
  })

  it('rejects both modes at once, and neither mode at all', () => {
    expect(
      () =>
        new NimiqChain({
          network: 'TestAlbatross',
          custodyPrivateKeyHex: TEST_KEY,
          custodyAddress: TEST_ADDRESS,
        }),
    ).toThrow(/exactly one/)
    expect(() => new NimiqChain({ network: 'TestAlbatross' })).toThrow(/exactly one/)
  })
})

describe('NimiqChain signing mode is unchanged', () => {
  it('still derives its own address and still signs', async () => {
    const chain = new NimiqChain({ network: 'TestAlbatross', custodyPrivateKeyHex: TEST_KEY })
    expect(chain.isReadOnly()).toBe(false)
    expect(chain.custodyAddress()).toBe(TEST_ADDRESS)

    const signed = await chain.buildSignedBasic(SIGN_ARGS)
    expect(signed.rawTxHex).toMatch(/^[0-9a-f]+$/i)
    expect(signed.txHash).toHaveLength(64)
    // Round-trip: the bytes carry this network, which is what `recover replace`
    // reads before it is allowed to call anything dead.
    expect(chain.rawTxNetwork(signed.rawTxHex)).toBe('TestAlbatross')
  })
})

describe('the two env factories are separate on purpose', () => {
  it('readOnlyNimiqChainFromEnv needs CUSTODY_ADDRESS and never reads the key', () => {
    process.env.CUSTODY_PRIVATE_KEY_HEX = TEST_KEY
    expect(() => readOnlyNimiqChainFromEnv()).toThrow(/CUSTODY_ADDRESS is not set/)

    process.env.CUSTODY_ADDRESS = TEST_ADDRESS
    const chain = readOnlyNimiqChainFromEnv()
    expect(chain.isReadOnly()).toBe(true)
    expect(chain.custodyAddress()).toBe(TEST_ADDRESS)
  })

  it('refuses a key smuggled in through an override', () => {
    process.env.CUSTODY_ADDRESS = TEST_ADDRESS
    const chain = readOnlyNimiqChainFromEnv({ custodyPrivateKeyHex: TEST_KEY })
    expect(chain.isReadOnly()).toBe(true)
  })

  it('nimiqChainFromEnv still requires the key and still signs', () => {
    expect(() => nimiqChainFromEnv()).toThrow(/CUSTODY_PRIVATE_KEY_HEX is not set/)

    process.env.CUSTODY_PRIVATE_KEY_HEX = TEST_KEY
    // An address in the overrides must not turn the worker's client read-only.
    const chain = nimiqChainFromEnv({ custodyAddress: TEST_ADDRESS })
    expect(chain.isReadOnly()).toBe(false)
  })
})
