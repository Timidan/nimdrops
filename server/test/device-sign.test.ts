import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyPair, PrivateKey } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import { buildChallengeMessage, type Challenge } from '../src/auth/challenge'
import {
  addressFromPublicKey,
  checkWalletSignature,
  verifyWalletSignature,
  WALLET_SIG_SCHEME,
  type SigScheme,
} from '../src/auth/verify'

/**
 * The test that was missing when production shipped `SIG_SCHEME=raw`.
 *
 * A real claimant opened a funded drop inside Nimiq Pay, approved the
 * signature, and was told "Not approved". The wallet had done its job; the
 * server was verifying the wrong bytes, and every unit test passed the whole
 * time because each one signed with the same scheme it then verified with. A
 * self-consistent test can never catch a self-consistent wrong answer.
 *
 * So this file does not generate its own signature. It reads a committed vector
 * of the bytes a Nimiq wallet is documented to sign and demands three things:
 * the configured wallet scheme verifies it, the other scheme does NOT, and a
 * deployment's default config names the scheme that works. The vector's
 * provenance — source-derived, not captured from a phone — is stated in the
 * fixture itself and asserted below, so nobody mistakes it for a device run.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

interface DeviceSignFixture {
  provenance: {
    deviceCaptured: boolean
    kind: string
    summary: string
    derivedFrom: string[]
    doesNotProve: string
  }
  scheme: SigScheme
  message: string
  messageByteLength: number
  signedMessageDigest: string
  publicKey: string
  signature: string
  walletReportedAddress: string
  rawSchemeCounterExample: { scheme: SigScheme; signature: string }
  testKey?: { privateKey: string }
}

const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures', 'device-sign.json'), 'utf8'),
) as DeviceSignFixture

/**
 * The prefixed digest, rebuilt here from Nimiq's published format rather than
 * imported from `auth/verify.ts`. Sharing the implementation would make this
 * file agree with the server by construction, which is the failure mode above.
 *
 *   sign( sha256( '\x16Nimiq Signed Message:\n' + message.length + message ) )
 *
 * — nimiq/hub sign-message reference; nimiq/keyguard `Key.signMessage()`.
 */
function nimiqSignedMessageDigest(message: string): Buffer {
  const body = Buffer.from(message, 'utf8')
  return createHash('sha256').update(
    Buffer.concat([
      Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
      Buffer.from(String(body.byteLength), 'utf8'),
      body,
    ]),
  ).digest()
}

describe('device-sign fixture: provenance', () => {
  it('says out loud that it is source-derived, not captured from a phone', () => {
    // If someone replaces this with a real capture they must flip the flag, and
    // the whole file's status changes with one boolean instead of a comment.
    expect(typeof fixture.provenance.deviceCaptured).toBe('boolean')
    if (!fixture.provenance.deviceCaptured) {
      expect(fixture.provenance.kind).toBe('source-derived')
      expect(fixture.provenance.derivedFrom.length).toBeGreaterThan(0)
      expect(fixture.provenance.doesNotProve).toMatch(/device/i)
    }
  })

  it('carries a throwaway key only while it is source-derived', () => {
    // A committed private key is defensible for a generated vector and is not
    // defensible next to a real wallet's signature.
    if (fixture.provenance.deviceCaptured) expect(fixture.testKey).toBeUndefined()
    else expect(fixture.testKey?.privateKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reproduces its own signature from the recorded key, byte for byte', () => {
    if (!fixture.testKey) return
    // Ed25519 is deterministic (RFC 8032), so a hand-edited signature — or a
    // vector generated against a different message — cannot survive this.
    const keyPair = KeyPair.derive(PrivateKey.fromHex(fixture.testKey.privateKey))
    expect(keyPair.publicKey.toHex()).toBe(fixture.publicKey)
    expect(keyPair.sign(new Uint8Array(nimiqSignedMessageDigest(fixture.message))).toHex()).toBe(
      fixture.signature,
    )
  })
})

describe('device-sign fixture: the message', () => {
  it('is a canonical challenge this server could have issued', () => {
    const parsed = JSON.parse(fixture.message) as Challenge
    expect(buildChallengeMessage(parsed)).toBe(fixture.message)
  })

  it('records the UTF-8 byte length that goes into the prefix', () => {
    expect(Buffer.byteLength(fixture.message, 'utf8')).toBe(fixture.messageByteLength)
  })

  it('hashes to the recorded digest under the published format', () => {
    expect(nimiqSignedMessageDigest(fixture.message).toString('hex')).toBe(
      fixture.signedMessageDigest,
    )
  })
})

describe('device-sign fixture: verification', () => {
  it('is signed under the scheme a Nimiq wallet uses', () => {
    expect(fixture.scheme).toBe(WALLET_SIG_SCHEME)
    expect(WALLET_SIG_SCHEME).toBe('nimiq-signed-message')
  })

  it('verifies against the exact bytes Nimiq Pay is documented to sign', () => {
    expect(
      verifyWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: fixture.signature,
        scheme: WALLET_SIG_SCHEME,
      }),
    ).toBe(true)
  })

  it('does NOT verify under the raw scheme', () => {
    // This is the assertion that fails if anyone re-declares `raw` the truth.
    expect(
      verifyWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: fixture.signature,
        scheme: 'raw',
      }),
    ).toBe(false)
  })

  it('pays out to the address the wallet reports for that key', () => {
    expect(addressFromPublicKey(fixture.publicKey)).toBe(fixture.walletReportedAddress)
  })
})

describe('device-sign fixture: the misconfiguration diagnostic', () => {
  it('names the exact production fault: wallet signature, SIG_SCHEME=raw', () => {
    const check = checkWalletSignature({
      message: fixture.message,
      publicKeyHex: fixture.publicKey,
      signatureHex: fixture.signature,
      scheme: 'raw',
    })
    expect(check).toEqual({ ok: false, schemeMismatch: true })
  })

  it('reports no mismatch when the configured scheme is the right one', () => {
    expect(
      checkWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: fixture.signature,
        scheme: WALLET_SIG_SCHEME,
      }),
    ).toEqual({ ok: true, schemeMismatch: false })
  })

  it('catches the mismatch in the other direction too', () => {
    const raw = fixture.rawSchemeCounterExample
    expect(
      verifyWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: raw.signature,
        scheme: 'raw',
      }),
    ).toBe(true)
    expect(
      checkWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: raw.signature,
        scheme: WALLET_SIG_SCHEME,
      }),
    ).toEqual({ ok: false, schemeMismatch: true })
  })

  it('keeps a plainly bad signature out of the mismatch bucket', () => {
    // A forgery must not be reported to operators as "your config is wrong".
    const garbage = 'ab'.repeat(64)
    expect(
      checkWalletSignature({
        message: fixture.message,
        publicKeyHex: fixture.publicKey,
        signatureHex: garbage,
        scheme: WALLET_SIG_SCHEME,
      }),
    ).toEqual({ ok: false, schemeMismatch: false })
  })
})

describe('deployment defaults', () => {
  // The live fault was never in the code: `raw` was correct-looking config in
  // a file no test read. These two read it.
  it('.env.example ships the scheme a wallet actually uses', () => {
    const env = readFileSync(resolve(REPO, '.env.example'), 'utf8')
    const match = /^SIG_SCHEME=(.*)$/m.exec(env)
    expect(match?.[1]).toBe(WALLET_SIG_SCHEME)
  })

  it('every compose service defaults to it as well', () => {
    const compose = readFileSync(resolve(REPO, 'docker-compose.yml'), 'utf8')
    const defaults = [...compose.matchAll(/SIG_SCHEME:\s*\$\{SIG_SCHEME:-([^}]*)\}/g)].map(
      (m) => m[1],
    )
    expect(defaults.length).toBeGreaterThan(0)
    for (const value of defaults) expect(value).toBe(WALLET_SIG_SCHEME)
  })
})
