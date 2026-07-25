import { createHash } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import {
  buildChallengeMessage,
  CHALLENGE_TTL_SECONDS,
  ChallengeExpiredError,
  assertChallengeFresh,
  issueChallenge,
  type Challenge,
} from '../src/auth/challenge'
import { addressFromPublicKey, verifyWalletSignature } from '../src/auth/verify'

const ORIGIN = 'https://nimdrops.example'
const NETWORK = 'TestAlbatross'
const DROP = 'Zm9vYmFyYmF6cXV4MDAwMA'

function sampleChallenge(over: Partial<Challenge> = {}): Challenge {
  return {
    v: 1,
    aud: ORIGIN,
    net: NETWORK,
    action: 'claim',
    drop: DROP,
    nonce: 'GxJ7pT2Qm4V1Zc0aRk9sHw',
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    ...over,
  }
}

/** Independent re-implementation of the wallet-side prefixed digest, per design §8.1. */
function signedMessageDigest(message: string): Uint8Array {
  const prefixed = Buffer.concat([
    Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
    Buffer.from(String(Buffer.byteLength(message, 'utf8')), 'utf8'),
    Buffer.from(message, 'utf8'),
  ])
  return new Uint8Array(createHash('sha256').update(prefixed).digest())
}

describe('buildChallengeMessage', () => {
  it('is byte-stable for the same challenge', () => {
    const c = sampleChallenge()
    const a = buildChallengeMessage(c)
    const b = buildChallengeMessage({ ...c })
    expect(a).toBe(b)
    expect(Buffer.byteLength(a, 'utf8')).toBe(Buffer.byteLength(b, 'utf8'))
  })

  it('ignores property insertion order', () => {
    const canonical = buildChallengeMessage(sampleChallenge())
    const shuffled: Challenge = {
      exp: 1_800_000_300,
      drop: DROP,
      v: 1,
      nonce: 'GxJ7pT2Qm4V1Zc0aRk9sHw',
      net: NETWORK,
      iat: 1_800_000_000,
      aud: ORIGIN,
      action: 'claim',
    }
    expect(buildChallengeMessage(shuffled)).toBe(canonical)
  })

  it('emits sorted keys and no whitespace', () => {
    const message = buildChallengeMessage(sampleChallenge())
    expect(message).not.toMatch(/\s/)
    const keys = Object.keys(JSON.parse(message) as Record<string, unknown>)
    expect(keys).toEqual(['action', 'aud', 'drop', 'exp', 'iat', 'net', 'nonce', 'v'])
    expect([...keys].sort()).toEqual(keys)
  })

  it('round-trips every field value', () => {
    const c = sampleChallenge()
    expect(JSON.parse(buildChallengeMessage(c))).toEqual(c)
  })

  it('rejects a challenge with non-integer timestamps', () => {
    expect(() => buildChallengeMessage(sampleChallenge({ iat: 1.5 }))).toThrow()
    expect(() => buildChallengeMessage(sampleChallenge({ exp: Number.NaN }))).toThrow()
  })
})

describe('issueChallenge', () => {
  it('fills the fixed fields and a 5-minute expiry', () => {
    const before = Math.floor(Date.now() / 1000)
    const c = issueChallenge({ origin: ORIGIN, network: NETWORK, dropPublicId: DROP })
    const after = Math.floor(Date.now() / 1000)

    expect(c.v).toBe(1)
    expect(c.action).toBe('claim')
    expect(c.aud).toBe(ORIGIN)
    expect(c.net).toBe(NETWORK)
    expect(c.drop).toBe(DROP)
    expect(c.iat).toBeGreaterThanOrEqual(before)
    expect(c.iat).toBeLessThanOrEqual(after)
    expect(c.exp - c.iat).toBe(CHALLENGE_TTL_SECONDS)
    expect(CHALLENGE_TTL_SECONDS).toBe(300)
  })

  it('draws a fresh URL-safe nonce every time', () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const { nonce } = issueChallenge({ origin: ORIGIN, network: NETWORK, dropPublicId: DROP })
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/)
      nonces.add(nonce)
    }
    expect(nonces.size).toBe(500)
  })

  it('produces a message that survives a build round-trip', () => {
    const c = issueChallenge({ origin: ORIGIN, network: NETWORK, dropPublicId: DROP })
    expect(JSON.parse(buildChallengeMessage(c))).toEqual(c)
  })
})

describe('assertChallengeFresh', () => {
  it('accepts a challenge inside its window', () => {
    const c = sampleChallenge()
    expect(() => assertChallengeFresh(c, c.iat)).not.toThrow()
    expect(() => assertChallengeFresh(c, c.exp - 1)).not.toThrow()
  })

  it('rejects an expired challenge', () => {
    const c = sampleChallenge()
    expect(() => assertChallengeFresh(c, c.exp)).toThrow(ChallengeExpiredError)
    expect(() => assertChallengeFresh(c, c.exp + 1)).toThrow(ChallengeExpiredError)
    expect(() => assertChallengeFresh(c, c.iat + CHALLENGE_TTL_SECONDS + 60)).toThrow(
      ChallengeExpiredError,
    )
  })

  it('rejects a challenge issued far in the future', () => {
    const c = sampleChallenge()
    expect(() => assertChallengeFresh(c, c.iat - 3600)).toThrow()
  })

  it('defaults `now` to the current clock', () => {
    const fresh = issueChallenge({ origin: ORIGIN, network: NETWORK, dropPublicId: DROP })
    expect(() => assertChallengeFresh(fresh)).not.toThrow()
    const stale = { ...fresh, iat: fresh.iat - 3600, exp: fresh.exp - 3600 }
    expect(() => assertChallengeFresh(stale)).toThrow(ChallengeExpiredError)
  })
})

describe('verifyWalletSignature (scheme: raw)', () => {
  const keyPair = KeyPair.generate()
  const publicKeyHex = keyPair.publicKey.toHex()
  const message = buildChallengeMessage(sampleChallenge())
  const signatureHex = keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex()

  it('accepts a signature made by the matching key over the canonical message', () => {
    expect(verifyWalletSignature({ message, publicKeyHex, signatureHex, scheme: 'raw' })).toBe(true)
  })

  it('rejects a tampered message', () => {
    const tampered = message.replace(DROP, 'AAAAAAAAAAAAAAAAAAAAAA')
    expect(tampered).not.toBe(message)
    expect(
      verifyWalletSignature({ message: tampered, publicKeyHex, signatureHex, scheme: 'raw' }),
    ).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const flipped = flipLastHexNibble(signatureHex)
    expect(verifyWalletSignature({ message, publicKeyHex, signatureHex: flipped, scheme: 'raw' })).toBe(
      false,
    )
  })

  it('rejects a signature from a different key', () => {
    const other = KeyPair.generate()
    expect(
      verifyWalletSignature({
        message,
        publicKeyHex: other.publicKey.toHex(),
        signatureHex,
        scheme: 'raw',
      }),
    ).toBe(false)
  })

  it('rejects malformed hex inputs instead of throwing', () => {
    expect(verifyWalletSignature({ message, publicKeyHex: 'zz', signatureHex, scheme: 'raw' })).toBe(
      false,
    )
    expect(verifyWalletSignature({ message, publicKeyHex, signatureHex: 'beef', scheme: 'raw' })).toBe(
      false,
    )
    expect(verifyWalletSignature({ message, publicKeyHex: '', signatureHex: '', scheme: 'raw' })).toBe(
      false,
    )
  })

  it('does not verify under the prefixed scheme', () => {
    expect(
      verifyWalletSignature({ message, publicKeyHex, signatureHex, scheme: 'nimiq-signed-message' }),
    ).toBe(false)
  })
})

describe('verifyWalletSignature (scheme: nimiq-signed-message)', () => {
  const keyPair = KeyPair.generate()
  const publicKeyHex = keyPair.publicKey.toHex()
  const message = buildChallengeMessage(sampleChallenge())
  const signatureHex = keyPair.sign(signedMessageDigest(message)).toHex()

  it('accepts a signature over the prefixed SHA-256 digest', () => {
    expect(
      verifyWalletSignature({ message, publicKeyHex, signatureHex, scheme: 'nimiq-signed-message' }),
    ).toBe(true)
  })

  it('rejects a tampered message', () => {
    expect(
      verifyWalletSignature({
        message: `${message} `,
        publicKeyHex,
        signatureHex,
        scheme: 'nimiq-signed-message',
      }),
    ).toBe(false)
  })

  it('does not verify under the raw scheme', () => {
    expect(verifyWalletSignature({ message, publicKeyHex, signatureHex, scheme: 'raw' })).toBe(false)
  })
})

describe('addressFromPublicKey', () => {
  it('matches the keypair address reported by @nimiq/core', () => {
    for (let i = 0; i < 5; i++) {
      const keyPair = KeyPair.generate()
      expect(addressFromPublicKey(keyPair.publicKey.toHex())).toBe(
        keyPair.toAddress().toUserFriendlyAddress(),
      )
    }
  })

  it('returns a user-friendly NQ address', () => {
    const address = addressFromPublicKey(KeyPair.generate().publicKey.toHex())
    expect(address).toMatch(/^NQ[0-9]{2}(?: [A-Z0-9]{4}){8}$/)
  })

  it('throws on an unparseable public key', () => {
    expect(() => addressFromPublicKey('not-hex')).toThrow()
  })
})

function flipLastHexNibble(hex: string): string {
  const last = hex.slice(-1)
  const flipped = ((parseInt(last, 16) + 1) % 16).toString(16)
  return hex.slice(0, -1) + flipped
}
