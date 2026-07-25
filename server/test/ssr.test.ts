import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { makeApp } from '../src/http/app'
import { registerSsr } from '../src/http/ssr'
import type { Alerts } from '../src/services/alerts'
import { DropNotFoundError, type DropPublic } from '../src/services/drops'

/**
 * The SSR surface has exactly three jobs, and this suite pins all three:
 *
 *  1. A chat preview that is campaign-specific but carries NO mutable count
 *     (design §4.1 — previews are cached, so "3 left" becomes a lie).
 *  2. No existence oracle. An unknown but well-formed id and outright junk must
 *     produce the SAME page, byte for byte in the head, so `/d/<guess>` cannot
 *     be used to enumerate live campaigns.
 *  3. It is mounted LAST. Nothing here may shadow an `/api` route.
 */

const ORIGIN = 'https://nimdrops.test'
const KNOWN_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const UNKNOWN_ID = 'BBBBBBBBBBBBBBBBBBBBBB'
const MALFORMED_ID = 'not-a-real-id'
const SPONSOR = 'Nimiq Community Call'

const knownDrop: DropPublic = {
  publicId: KNOWN_ID,
  sponsorLabel: SPONSOR,
  message: 'Thanks for joining the call',
  amountEach: '2.5',
  claimCount: 5,
  remaining: 3,
  state: 'live',
  expiresAt: new Date('2026-07-26T12:00:00.000Z'),
  fundingTxHash: 'a'.repeat(64),
}

async function lookup(publicId: string): Promise<DropPublic> {
  if (publicId === KNOWN_ID) return knownDrop
  throw new DropNotFoundError(publicId)
}

/** The built-SPA fixture: a stand-in for `web/dist` that needs no real build. */
let distRoot: string
/** Server-owned assets (`server/static`), where the OG image lives. */
let assetRoot: string
let app: Hono

/** `app.request` is typed `Promise<Response> | Response`; always await it. */
async function body(target: Hono, path: string): Promise<string> {
  const res = await target.request(path)
  return res.text()
}

function head(html: string): string {
  const match = /<head>([\s\S]*?)<\/head>/.exec(html)
  if (!match) throw new Error('response has no <head>')
  return match[1]
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const property = new RegExp(`<meta\\s+property="${escaped}"\\s+content="([^"]*)"`).exec(html)
  if (property) return property[1]
  const named = new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"`).exec(html)
  return named ? named[1] : null
}

beforeAll(() => {
  process.env.PUBLIC_ORIGIN = ORIGIN

  distRoot = mkdtempSync(join(tmpdir(), 'nimdrops-dist-'))
  mkdirSync(join(distRoot, 'assets'))
  writeFileSync(join(distRoot, 'assets', 'app-fixture.js'), 'globalThis.__nimdrops = 1\n')
  writeFileSync(join(distRoot, 'assets', 'app-fixture.css'), ':root{color:#fff}\n')
  writeFileSync(
    join(distRoot, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en"><head>',
      '<script type="module" crossorigin src="/assets/app-fixture.js"></script>',
      '<link rel="stylesheet" crossorigin href="/assets/app-fixture.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'),
  )

  assetRoot = mkdtempSync(join(tmpdir(), 'nimdrops-static-'))
  writeFileSync(join(assetRoot, 'og-envelope.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

  app = new Hono()
  registerSsr(app, { lookup, staticRoot: distRoot, assetRoot })
})

afterAll(() => {
  rmSync(distRoot, { recursive: true, force: true })
  rmSync(assetRoot, { recursive: true, force: true })
})

describe('GET /d/:publicId — campaign page', () => {
  it('renders a campaign-specific preview for a live drop', async () => {
    const res = await app.request(`/d/${KNOWN_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)

    const html = await res.text()
    expect(metaContent(html, 'og:title')).toContain(SPONSOR)
    expect(metaContent(html, 'og:image')).toBe(`${ORIGIN}/og-envelope.png`)
    expect(metaContent(html, 'robots')).toBe('noindex')
    expect(html).toContain('<div id="root"></div>')
  })

  it('omits every mutable count from the preview metadata', async () => {
    const html = await body(app, `/d/${KNOWN_ID}`)
    const description = metaContent(html, 'og:description') ?? ''

    expect(description).not.toMatch(/remaining|claimed|left|\bshares?\b.*\d|\d+\s*of\s*\d+/i)
    expect(description).not.toMatch(/\d/)
    // Nothing in the head may carry the count, the amount or the expiry either:
    // chat platforms cache the card, so any of them would become a stale claim.
    expect(head(html)).not.toContain(String(knownDrop.remaining))
    expect(head(html)).not.toContain(knownDrop.amountEach)
    expect(head(html)).not.toContain('2026-07-26')
  })

  it('offers the Nimiq Pay deeplink, a QR and the copyable canonical URL', async () => {
    const html = await body(app, `/d/${KNOWN_ID}`)
    const canonical = `${ORIGIN}/d/${KNOWN_ID}`

    expect(html).toContain(`nimiqpay://miniapp?url=${encodeURIComponent(canonical)}`)
    expect(html).toContain('Open in Nimiq Pay')
    expect(html).toContain(`/d/${KNOWN_ID}/qr.svg`)
    expect(html).toContain(canonical)
  })

  it('loads the built SPA bundle from the dist manifest', async () => {
    const html = await body(app, `/d/${KNOWN_ID}`)
    expect(html).toContain('src="/assets/app-fixture.js"')
    expect(html).toContain('href="/assets/app-fixture.css"')
  })

  it('escapes the sponsor label instead of interpolating markup', async () => {
    const hostile: DropPublic = { ...knownDrop, sponsorLabel: '"><script>alert(1)</script>' }
    const hostileApp = new Hono()
    registerSsr(hostileApp, {
      lookup: async () => hostile,
      staticRoot: distRoot,
      assetRoot,
    })

    const html = await body(hostileApp, `/d/${KNOWN_ID}`)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(metaContent(html, 'og:title')).toContain('&lt;script&gt;')
  })
})

describe('GET /d/:publicId — no existence oracle', () => {
  it('answers an unknown id with a 200 generic shell', async () => {
    const res = await app.request(`/d/${UNKNOWN_ID}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(metaContent(html, 'og:title')).not.toContain(SPONSOR)
    expect(metaContent(html, 'robots')).toBe('noindex')
    expect(html).toContain('<div id="root"></div>')
  })

  it('answers a malformed id with the same status and a byte-identical head', async () => {
    const unknown = await app.request(`/d/${UNKNOWN_ID}`)
    const malformed = await app.request(`/d/${MALFORMED_ID}`)

    expect(malformed.status).toBe(unknown.status)
    expect(head(await malformed.text())).toBe(head(await unknown.text()))
  })

  it('differs from the known-drop page only in the OG fields', async () => {
    const known = head(await body(app, `/d/${KNOWN_ID}`))
    const unknown = head(await body(app, `/d/${UNKNOWN_ID}`))

    const strip = (h: string): string => h.replace(/<meta\s+property="og:[^>]*>\s*/g, '')
    expect(strip(known)).toBe(strip(unknown))
  })
})

describe('GET /d/:publicId/qr.svg', () => {
  it('renders a QR of the canonical URL', async () => {
    const res = await app.request(`/d/${KNOWN_ID}/qr.svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/)

    const svg = await res.text()
    expect(svg).toContain('<svg')
    expect(svg).toContain(`${ORIGIN}/d/${KNOWN_ID}`)
  })

  it('does not consult the drop at all — an unknown id still gets a QR', async () => {
    const res = await app.request(`/d/${UNKNOWN_ID}/qr.svg`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`${ORIGIN}/d/${UNKNOWN_ID}`)
  })
})

describe('static serving', () => {
  it('serves hashed SPA assets from the dist root', async () => {
    const res = await app.request('/assets/app-fixture.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(await res.text()).toContain('__nimdrops')
  })

  it('serves the OG image from the server asset root', async () => {
    const res = await app.request('/og-envelope.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('serves the shell at the root path', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root"></div>')
  })

  it('refuses to walk out of the static root', async () => {
    for (const path of ['/assets/../../etc/passwd', '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
      const res = await app.request(path)
      expect(res.status).not.toBe(200)
    }
  })
})

describe('registration order', () => {
  /** A pool that fails every query: enough to prove the route is REACHED. */
  const brokenPool = {
    query: async () => {
      throw new Error('database unavailable')
    },
  } as unknown as Pool

  const silentAlerts: Alerts = { notify: async () => {} }

  it('leaves /api routes reachable behind the SSR mount', async () => {
    const full = makeApp({
      pool: brokenPool,
      chain: new FakeChain({ custody: 'NQ07 CUSTODY', finalityDepth: 5 }),
      alerts: silentAlerts,
    })

    const res = await full.request(`/api/drops/${KNOWN_ID}`)
    // The SPA catch-all must NOT have answered: an /api path always produces the
    // JSON error envelope, never HTML.
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.status).toBe(500)

    // …while the SSR route on the same app renders HTML.
    const page = await full.request(`/d/${KNOWN_ID}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)
  })
})
