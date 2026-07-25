import { beforeAll, describe, expect, it } from 'vitest'
import { hashIdemKey, hashToken, newPublicId, statusToken } from '../src/ids'

const URL_SAFE = /^[A-Za-z0-9_-]+$/

beforeAll(() => {
  process.env.STATUS_TOKEN_SECRET = 'test-status-token-secret'
})

describe('newPublicId', () => {
  it('is 22 chars and URL-safe', () => {
    const id = newPublicId()
    expect(id).toHaveLength(22)
    expect(id).toMatch(URL_SAFE)
  })

  it('is unique across 10_000 draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      const id = newPublicId()
      expect(id).toHaveLength(22)
      expect(id).toMatch(URL_SAFE)
      seen.add(id)
    }
    expect(seen.size).toBe(10_000)
  })
})

describe('statusToken', () => {
  it('is deterministic per claimId', () => {
    expect(statusToken('claim-1')).toBe(statusToken('claim-1'))
  })

  it('differs across claimIds', () => {
    expect(statusToken('claim-1')).not.toBe(statusToken('claim-2'))
  })

  it('is URL-safe and long enough to be unguessable', () => {
    const token = statusToken('claim-1')
    expect(token).toMatch(URL_SAFE)
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('depends on STATUS_TOKEN_SECRET', () => {
    const before = statusToken('claim-1')
    process.env.STATUS_TOKEN_SECRET = 'a-different-secret'
    try {
      expect(statusToken('claim-1')).not.toBe(before)
    } finally {
      process.env.STATUS_TOKEN_SECRET = 'test-status-token-secret'
    }
  })

  it('throws when the secret is missing', () => {
    const saved = process.env.STATUS_TOKEN_SECRET
    delete process.env.STATUS_TOKEN_SECRET
    try {
      expect(() => statusToken('claim-1')).toThrow(/STATUS_TOKEN_SECRET/)
    } finally {
      process.env.STATUS_TOKEN_SECRET = saved
    }
  })
})

describe('hashToken', () => {
  it('never equals the token it hashes', () => {
    const token = statusToken('claim-1')
    const hash = hashToken(token)
    expect(hash).not.toBe(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic and collision-free across distinct tokens', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })
})

describe('hashIdemKey', () => {
  it('is a sha256 hex digest, deterministic per (scope, key)', () => {
    const h = hashIdemKey('POST /api/drops', 'key-1')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashIdemKey('POST /api/drops', 'key-1')).toBe(h)
  })

  it('separates scopes so the same key in two scopes differs', () => {
    expect(hashIdemKey('scope-a', 'key-1')).not.toBe(hashIdemKey('scope-b', 'key-1'))
  })

  it('is unambiguous across scope/key boundary shifts', () => {
    expect(hashIdemKey('a:b', 'c')).not.toBe(hashIdemKey('a', 'b:c'))
  })
})
