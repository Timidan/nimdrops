import { Hono } from 'hono'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import {
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  SHARED_BUCKET,
  makeClientIpResolver,
} from '../src/http/client-ip'
import { makeApp } from '../src/http/app'
import type { Alerts } from '../src/services/alerts'

/**
 * The rate-limit bucket key is the only thing standing between one abusive
 * client and everybody else's 60 requests a minute, so it is decided by
 * exactly one rule: a hop we authenticated told us, or the socket peer.
 *
 * Every test below is really the same assertion in a different disguise — a
 * client cannot choose its own bucket, and every failure lands on a SHARED
 * bucket (the peer, or `unknown`) rather than a client-nominated one. A shared
 * bucket over-limits during a misconfiguration; a client-chosen one silently
 * removes the limiter, which is the failure nobody notices.
 */

const SECRET = 'f'.repeat(64)
const PEER = '203.0.113.9'

/** Resolve one request through a real Hono context, as production does. */
async function resolve(
  o: { secret?: string | undefined; peer?: string | undefined },
  headers: Record<string, string> = {},
): Promise<string> {
  const resolver = makeClientIpResolver({
    proxySecret: o.secret,
    peerAddress: () => o.peer,
  })
  const app = new Hono()
  app.get('/', (c) => c.text(resolver(c)))
  const res = await app.request('/', { headers })
  return res.text()
}

/** Everything a client can send that some framework somewhere would trust. */
const CLIENT_SUPPLIED = {
  'x-forwarded-for': '198.51.100.1',
  'x-real-ip': '198.51.100.2',
  'cf-connecting-ip': '198.51.100.3',
  'cf-connecting-ipv6': '2001:db8::bad',
  'true-client-ip': '198.51.100.4',
  forwarded: 'for=198.51.100.5',
}

describe('client IP: headers are worthless without the shared secret', () => {
  it('ignores every forwarding header when no secret is configured', async () => {
    expect(await resolve({ peer: PEER }, CLIENT_SUPPLIED)).toBe(PEER)
  })

  it('ignores the canonical header too when no secret is configured', async () => {
    const spoofed = { ...CLIENT_SUPPLIED, [CLIENT_IP_HEADER]: '198.51.100.9' }
    expect(await resolve({ peer: PEER }, spoofed)).toBe(PEER)
  })

  it('ignores the canonical header when the presented secret is wrong', async () => {
    const forged = {
      [PROXY_SECRET_HEADER]: 'e'.repeat(64),
      [CLIENT_IP_HEADER]: '198.51.100.9',
    }
    expect(await resolve({ secret: SECRET, peer: PEER }, forged)).toBe(PEER)
  })

  it('ignores a secret of the wrong LENGTH without throwing', async () => {
    // `timingSafeEqual` throws on unequal buffer lengths; an uncaught throw here
    // would be a 500 on every request rather than a fallback to the peer.
    for (const guess of ['', 'f', SECRET.slice(0, -1), `${SECRET}f`, SECRET.repeat(3)]) {
      const forged = { [PROXY_SECRET_HEADER]: guess, [CLIENT_IP_HEADER]: '198.51.100.9' }
      expect(await resolve({ secret: SECRET, peer: PEER }, forged), `guess ${guess.length}`).toBe(PEER)
    }
  })

  it('ignores the canonical header when the secret header is absent', async () => {
    expect(await resolve({ secret: SECRET, peer: PEER }, { [CLIENT_IP_HEADER]: '198.51.100.9' })).toBe(PEER)
  })

  it('still ignores the OTHER forwarding headers when the secret IS correct', async () => {
    // Caddy strips them, but a stripped header is a config away from coming
    // back; only the canonical header is ever read.
    const authenticated = { ...CLIENT_SUPPLIED, [PROXY_SECRET_HEADER]: SECRET }
    expect(await resolve({ secret: SECRET, peer: PEER }, authenticated)).toBe(PEER)
  })
})

describe('client IP: the authenticated hop is honoured', () => {
  it('returns the nominated IPv4', async () => {
    const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '198.51.100.9' }
    expect(await resolve({ secret: SECRET, peer: PEER }, headers)).toBe('198.51.100.9')
  })

  it('returns the nominated IPv6', async () => {
    const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '2001:db8::1' }
    expect(await resolve({ secret: SECRET, peer: PEER }, headers)).toBe('2001:db8::1')
  })

  it('honours the nominated IP even when the peer is unusable', async () => {
    const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '198.51.100.9' }
    expect(await resolve({ secret: SECRET, peer: undefined }, headers)).toBe('198.51.100.9')
  })
})

describe('client IP: an unusable nomination falls back to the peer', () => {
  const bad: Record<string, string> = {
    malformed: 'not-an-ip',
    'comma list': '198.51.100.9, 203.0.113.1',
    'with port': '198.51.100.9:443',
    'bracketed with port': '[2001:db8::1]:443',
    empty: '',
    whitespace: '   ',
    'cidr block': '198.51.100.0/24',
    'partial quad': '198.51.100',
    'out of range': '999.999.999.999',
    'leading zeroes': '010.010.010.010',
    'sql-ish': "198.51.100.9' OR 1=1",
    'huge': 'a'.repeat(5_000),
  }

  for (const [label, value] of Object.entries(bad)) {
    it(`falls back to the peer for ${label}`, async () => {
      const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: value }
      expect(await resolve({ secret: SECRET, peer: PEER }, headers)).toBe(PEER)
    })
  }

  it('falls back to the SHARED bucket when the peer is unusable too', async () => {
    for (const peer of [undefined, '', 'not-an-ip', '198.51.100.9:443']) {
      const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: 'not-an-ip' }
      expect(await resolve({ secret: SECRET, peer }, headers), `peer ${String(peer)}`).toBe(SHARED_BUCKET)
    }
  })

  it('falls back to the SHARED bucket when reading the peer throws', async () => {
    const resolver = makeClientIpResolver({
      proxySecret: SECRET,
      peerAddress: () => {
        throw new Error('no conninfo on this runtime')
      },
    })
    const app = new Hono()
    app.get('/', (c) => c.text(resolver(c)))
    expect(await (await app.request('/')).text()).toBe(SHARED_BUCKET)
  })
})

describe('client IP: equivalent spellings share one bucket', () => {
  /** Every row must collapse to a single key, or the limiter is 2×-4× per client. */
  const equivalent: Array<[string, string[]]> = [
    ['1.2.3.4', ['1.2.3.4', '::ffff:1.2.3.4', '::FFFF:1.2.3.4', '::ffff:0102:0304', ' 1.2.3.4 ']],
    ['2001:db8::1', ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:DB8::1', '2001:db8:0:0::1']],
    ['::1', ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']],
  ]

  for (const [canonical, spellings] of equivalent) {
    it(`maps every spelling of ${canonical} to one key (nominated)`, async () => {
      for (const spelling of spellings) {
        const headers = { [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: spelling }
        expect(await resolve({ secret: SECRET, peer: PEER }, headers), spelling).toBe(canonical)
      }
    })

    it(`maps every spelling of ${canonical} to one key (peer)`, async () => {
      for (const spelling of spellings) {
        expect(await resolve({ peer: spelling }), spelling).toBe(canonical)
      }
    })
  }

  it('does not merge distinct addresses', async () => {
    expect(await resolve({ peer: '1.2.3.4' })).not.toBe(await resolve({ peer: '1.2.3.5' }))
    expect(await resolve({ peer: '2001:db8::1' })).not.toBe(await resolve({ peer: '2001:db8::2' }))
  })
})

/**
 * The app-level half of the contract: `makeApp` without a resolver must not
 * fall back to reading headers. It shares one bucket instead, so a miswired
 * build rate-limits everybody together — loud, and safe — rather than handing
 * every client a private bucket of its own choosing.
 */
describe('app without a client-IP resolver', () => {
  const deadPool = {
    query: async () => {
      throw new Error('database unavailable')
    },
  } as unknown as Pool
  const silentAlerts: Alerts = { notify: async () => {} }

  it('puts every client, however it labels itself, in ONE bucket', async () => {
    let clock = 1_700_000_000_000
    const app = makeApp({
      pool: deadPool,
      chain: new FakeChain({ custody: 'NQ07 CUSTODY', finalityDepth: 5 }),
      alerts: silentAlerts,
      now: () => clock,
      limits: { ipPerWindow: 3 },
    })

    // `POST /api/drops` with no Idempotency-Key is rejected before the handler
    // touches the pool, so this measures the limiter and nothing else.
    const attempt = async (label: string): Promise<Response> =>
      app.request('/api/drops', {
        method: 'POST',
        headers: {
          'x-forwarded-for': label,
          'x-real-ip': label,
          'cf-connecting-ip': label,
          [CLIENT_IP_HEADER]: label,
          [PROXY_SECRET_HEADER]: SECRET,
        },
      })

    expect((await attempt('198.51.100.1')).status).toBe(400)
    expect((await attempt('198.51.100.2')).status).toBe(400)
    expect((await attempt('198.51.100.3')).status).toBe(400)
    // Three distinct self-declared identities, one exhausted bucket.
    expect((await attempt('198.51.100.4')).status).toBe(429)

    clock += 60_000
    expect((await attempt('198.51.100.5')).status).toBe(400)
  })
})
