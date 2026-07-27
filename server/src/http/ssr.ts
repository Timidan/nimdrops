import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import QRCode from 'qrcode'
import type { Pool } from 'pg'
import { DropNotFoundError, getPublic, type DropPublic } from '../services/drops'
import { logError } from './redact'

/**
 * The external-link bridge (design §4.1): `/d/:publicId` rendered on the server
 * so a chat platform sees a real preview card, plus the QR and the static files
 * the single-origin deployment needs.
 *
 * Four rules shape this file.
 *
 *  1. **The preview carries no mutable state.** Chat platforms cache the card
 *     for hours, so "3 shares left" turns into a lie the moment someone claims.
 *     The head carries the sponsor label and nothing else that can go stale —
 *     no remaining count, no amount, no expiry. The live numbers are the SPA's
 *     job, fetched fresh from `GET /api/drops/:publicId`.
 *  2. **The page is not an existence oracle.** An unknown id and a malformed id
 *     both render the generic shell with a 200, with a head that is identical
 *     byte for byte, so scanning the 128-bit id space tells an attacker nothing
 *     it did not already know. `DropNotFoundError` is swallowed here on purpose;
 *     it is the ONLY error class this route hides.
 *  3. **Nothing user-controlled reaches the HTML unescaped.** The sponsor label
 *     is attacker-supplied text on a page that also carries a deeplink, so every
 *     interpolation goes through `escapeHtml`.
 *  4. **It mounts last and claims only the paths it owns.** No `*` route: an
 *     unmatched path still falls through to the app's uniform JSON 404, so the
 *     SPA can never shadow — or disguise the shape of — an `/api` response.
 */

// ---- options -----------------------------------------------------------------------

/** Everything SSR needs from the data layer: one read of the public projection. */
export type DropLookup = (publicId: string) => Promise<DropPublic>

export interface SsrOptions {
  /** Used to build the default lookup. Ignored when `lookup` is supplied. */
  pool?: Pool
  /** Overrides the `getPublic` read (tests, and any future cache in front of it). */
  lookup?: DropLookup
  /** Built SPA directory. Defaults to `$SPA_DIST`, then `<repo>/web/dist`. */
  staticRoot?: string
  /** Server-owned assets (the OG image). Defaults to `server/static`. */
  assetRoot?: string
  /** Canonical origin. Defaults to `PUBLIC_ORIGIN`, read per request. */
  origin?: string
}

/** 16 random bytes, base64url — the same shape `ids.ts` mints and `app.ts` checks. */
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_STATIC_ROOT = resolve(HERE, '../../../web/dist')
const DEFAULT_ASSET_ROOT = resolve(HERE, '../../static')

// ---- HTML ------------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Static preview copy. Deliberately free of numbers: see rule 1. It also avoids
 * "one tap" (Global Constraints) — approving a payment is a real, deliberate act.
 */
// This is the first thing a stranger reads, in a chat preview, before they know
// what NimDrops is. It introduces the product, not the mechanism: "campaign" is
// the sponsor's word for what they funded, never the recipient's word for a gift.
const OG_DESCRIPTION = 'One link. A fixed share of NIM for everyone who opens it.'

/**
 * The landing page's own description. Longer than `OG_DESCRIPTION` because it
 * is the one that has to work as a search result rather than as a chat preview:
 * it names who it is for and what happens, where the chat card only has to say
 * enough that a friend taps it.
 */
const LANDING_DESCRIPTION =
  'Fund one drop, share one link, and let a fixed number of people each claim an equal share of NIM. Unclaimed value goes back to the sponsor.'
const GENERIC_OG_TITLE = 'Someone is sharing NIM'

function ogTitle(drop: DropPublic | null): string {
  return drop ? `${drop.sponsorLabel} is sharing NIM` : GENERIC_OG_TITLE
}

/**
 * The `<script>`/`<link>` tags Vite emitted into `web/dist/index.html`.
 *
 * Read once at registration rather than per request: the file cannot change
 * under a running server, and a synchronous read on the render path would put
 * the disk in front of every chat crawler. When the build is absent (dev, or a
 * fresh clone — `dist` is gitignored) the shell still renders, just without the
 * app, which keeps the OG and QR paths testable without a web build.
 */
function readAssetTags(staticRoot: string): string {
  let indexHtml: string
  try {
    indexHtml = readFileSync(join(staticRoot, 'index.html'), 'utf8')
  } catch {
    return ''
  }
  const tags = [
    ...(indexHtml.match(/<script[^>]*type="module"[^>]*><\/script>/g) ?? []),
    ...(indexHtml.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? []),
  ]
  return tags.map((tag) => `    ${tag}`).join('\n')
}

interface ShellInput {
  drop: DropPublic | null
  /** Already-escaped canonical URL of this page, or null when there is no id. */
  canonical: string | null
  origin: string
  assetTags: string
  qrPath: string | null
  /**
   * The landing page, and only it, is meant to be found.
   *
   * Every other shell is `noindex` because an unguessable id is the only access
   * control a campaign page has, so indexing one would publish it. That reason
   * does not apply to `/`: it holds no id, it is the page that explains what
   * NimDrops is, and hiding it from search costs the product its only
   * discoverable surface.
   */
  indexable?: boolean
}

/**
 * One template for every case. The head is a pure function of `drop` and
 * `origin` — never of the id — which is what makes the unknown and malformed
 * responses byte-identical above the body.
 */
function shell(input: ShellInput): string {
  const { drop, canonical, origin, assetTags, qrPath, indexable = false } = input
  const deeplink = canonical === null ? null : `nimiqpay://miniapp?url=${encodeURIComponent(canonical)}`

  const head = [
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    indexable
      ? '    <title>NimDrops — one link, a fixed share of NIM each</title>'
      : '    <title>NimDrops</title>',
    // Unguessable ids are the only access control on a campaign page, so the
    // page must never enter a search index (design §4.1). The landing page has
    // no id to protect and is the one surface that has to be findable.
    ...(indexable
      ? [`    <meta name="description" content="${escapeHtml(LANDING_DESCRIPTION)}" />`]
      : ['    <meta name="robots" content="noindex" />']),
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:site_name" content="NimDrops" />`,
    `    <meta property="og:title" content="${escapeHtml(ogTitle(drop))}" />`,
    `    <meta property="og:description" content="${escapeHtml(indexable ? LANDING_DESCRIPTION : OG_DESCRIPTION)}" />`,
    `    <meta property="og:image" content="${escapeHtml(`${origin}/og-envelope.png`)}" />`,
    '    <meta name="twitter:card" content="summary_large_image" />',
    '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    assetTags,
  ]
    .filter((line) => line !== '')
    .join('\n')

  // The no-JS block is the judged fallback path: a link opened in a plain
  // browser with scripting off still gets the deeplink, the QR and a URL it can
  // copy into Nimiq Pay by hand. With JS the SPA owns this screen (Task 16), so
  // the markup lives in <noscript> where it cannot fight hydration.
  const fallback =
    deeplink === null || canonical === null || qrPath === null
      ? ''
      : [
          '    <noscript>',
          '      <h1>NimDrops</h1>',
          `      <p><a href="${escapeHtml(deeplink)}">Open in Nimiq Pay</a></p>`,
          `      <p><img src="${escapeHtml(qrPath)}" width="220" height="220" alt="QR code for this NimDrop" /></p>`,
          `      <p>Or copy this link: <code>${escapeHtml(canonical)}</code></p>`,
          '    </noscript>',
        ].join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
${head}
  </head>
  <body>
    <div id="root"></div>
${fallback}
  </body>
</html>
`
}

// ---- static files -------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=UTF-8',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=UTF-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=UTF-8',
  '.map': 'application/json; charset=UTF-8',
}

/**
 * Resolve `relative` inside `root`, or null.
 *
 * Two things are checked, because either alone is bypassable: the decoded path
 * must not escape the root after normalisation, and it must not contain a NUL.
 * Hono has already percent-decoded the path, so `%2e%2e%2f` arrives as `../`
 * and is caught by the same prefix test as a literal `../`.
 */
function safeJoin(root: string, relative: string): string | null {
  if (relative.includes('\0')) return null
  const target = resolve(root, normalize(relative).replace(/^([/\\])+/, ''))
  const bounded = root.endsWith(sep) ? root : root + sep
  return target === root || target.startsWith(bounded) ? target : null
}

async function serveFile(path: string | null): Promise<Response | null> {
  if (path === null) return null
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    const body = await readFile(path)
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        // Vite emits content-hashed filenames, so assets are immutable. The OG
        // image is not hashed, hence the shorter, revalidating ttl below.
        'cache-control': path.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
        'content-length': String(info.size),
      },
    })
  } catch {
    return null
  }
}

// ---- registration ----------------------------------------------------------------------------

/**
 * Mount the campaign page, the QR endpoint and the SPA's static files.
 *
 * MUST be called after every `/api` route (`makeApp` calls it last).
 */
export function registerSsr(app: Hono, opts: SsrOptions = {}): void {
  const staticRoot = resolve(opts.staticRoot ?? process.env.SPA_DIST ?? DEFAULT_STATIC_ROOT)
  const assetRoot = resolve(opts.assetRoot ?? DEFAULT_ASSET_ROOT)
  const assetTags = readAssetTags(staticRoot)

  const pool = opts.pool
  const lookup: DropLookup =
    opts.lookup ??
    ((publicId: string) => {
      if (!pool) throw new Error('registerSsr needs a pool or a lookup')
      return getPublic(pool, publicId)
    })

  function origin(): string {
    const configured = opts.origin ?? process.env.PUBLIC_ORIGIN
    if (!configured) throw new Error('PUBLIC_ORIGIN is not set')
    return configured.replace(/\/+$/, '')
  }

  function html(body: string, indexable = false): Response {
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        // Belt and braces with the meta tag: crawlers that never parse the body
        // still see it, and it survives being fetched by a proxy. The landing
        // page is the one shell that opts out of both, because it is the only
        // one with nothing to hide and something to gain from being found.
        ...(indexable ? {} : { 'x-robots-tag': 'noindex' }),
        // A campaign page must never be cached: its counts and its state move.
        // The landing page is static markup whose numbers arrive over the API,
        // so it can be held briefly — and `must-revalidate` keeps a deploy from
        // being invisible to anyone who visited in the previous minute.
        'cache-control': indexable ? 'public, max-age=60, must-revalidate' : 'no-store',
      },
    })
  }

  // ---- GET /drop/:publicId ---------------------------------------------------------

  /**
   * `/d/:publicId` was the original shape and is kept as a permanent redirect
   * rather than deleted. Nothing forces that: no mainnet link had been shared
   * when this moved, so the migration is free today. But a drop link's whole
   * purpose is to be pasted into a group chat and scanned off someone's screen,
   * and a QR code that has already been printed cannot be edited. A dead claim
   * link is a person not getting money they were sent, so this redirect stays
   * even though today it has nothing to catch.
   */
  app.get('/d/:publicId', (c) => {
    const publicId = c.req.param('publicId') ?? ''
    if (!PUBLIC_ID_RE.test(publicId)) return c.notFound()
    return c.redirect(`/drop/${publicId}`, 301)
  })

  app.get('/d/:publicId/qr.svg', (c) => {
    const publicId = c.req.param('publicId') ?? ''
    if (!PUBLIC_ID_RE.test(publicId)) return c.notFound()
    return c.redirect(`/drop/${publicId}/qr.svg`, 301)
  })

  app.get('/drop/:publicId', async (c) => {
    const publicId = c.req.param('publicId') ?? ''
    const wellFormed = PUBLIC_ID_RE.test(publicId)

    let drop: DropPublic | null = null
    if (wellFormed) {
      try {
        drop = await lookup(publicId)
      } catch (err) {
        // A missing drop is a normal outcome — see rule 2 — and is silent.
        //
        // A read FAILURE (dead pool, bug) degrades to the same generic shell
        // rather than a 500, and is logged instead. The page's job is to load
        // the app; the app then reads `GET /api/drops/:publicId`, which does
        // NOT hide the outage and drives the degraded banner. Failing the shell
        // would replace a recoverable banner with a blank error page.
        if (!(err instanceof DropNotFoundError)) {
          logError('ssr_lookup_failed', {
            error: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        drop = null
      }
    }

    const base = origin()
    return html(
      shell({
        drop,
        canonical: wellFormed ? `${base}/drop/${publicId}` : null,
        origin: base,
        assetTags,
        qrPath: wellFormed ? `/drop/${publicId}/qr.svg` : null,
      }),
    )
  })

  // ---- GET /drop/:publicId/qr.svg ----------------------------------------------------

  /**
   * A QR of the canonical URL. It performs NO lookup: encoding an id the caller
   * already typed reveals nothing, and skipping the query keeps the image path
   * free of database latency (and of any timing difference between a live and a
   * dead campaign).
   */
  app.get('/drop/:publicId/qr.svg', async (c) => {
    const publicId = c.req.param('publicId') ?? ''
    if (!PUBLIC_ID_RE.test(publicId)) return c.notFound()

    const canonical = `${origin()}/drop/${publicId}`
    const svg = await QRCode.toString(canonical, {
      type: 'svg',
      // Medium recovery survives a phone screenshot; the margin keeps the quiet
      // zone scanners need when the code is pasted onto a coloured background.
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#1F2348', light: '#FFFFFF' },
    })

    // The URL is embedded as a title so the SVG is self-describing to screen
    // readers, to anyone who opens it directly, and to a human debugging a
    // scan failure. QR modules alone are not human-readable.
    const titled = svg.replace(
      /(<svg[^>]*>)/,
      `$1<title>${escapeHtml(canonical)}</title><desc>${escapeHtml(canonical)}</desc>`,
    )

    return new Response(titled, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=UTF-8',
        'cache-control': 'public, max-age=3600',
        'x-robots-tag': 'noindex',
      },
    })
  })

  // ---- static ---------------------------------------------------------------------------

  app.get('/assets/*', async (c) => {
    const relative = c.req.path.slice('/assets/'.length)
    return (await serveFile(safeJoin(join(staticRoot, 'assets'), relative))) ?? c.notFound()
  })

  /**
   * Everything Vite copies verbatim out of `web/public`.
   *
   * Only `/assets/*` was mounted, which is where the bundler puts what it has
   * hashed. Anything referenced by a fixed path — the self-hosted typeface, the
   * photography — was therefore 404ing in production while working perfectly in
   * dev, because the Vite dev server serves `public/` and this did not. The
   * font preload in `index.html` had been failing on mainnet since it shipped:
   * the page still rendered, in a fallback face, which is exactly the kind of
   * defect that survives review because nothing is obviously broken.
   *
   * These are immutable, content-stable files, so they get a long cache. They
   * are also the only unauthenticated paths that read from disk by name, hence
   * `safeJoin`, which is what keeps a `..` out of the filesystem.
   */
  for (const prefix of ['/fonts/', '/images/'] as const) {
    app.get(`${prefix}*`, async (c) => {
      const relative = c.req.path.slice(prefix.length)
      const file = await serveFile(safeJoin(join(staticRoot, prefix.slice(1, -1)), relative))
      if (!file) return c.notFound()
      file.headers.set('cache-control', 'public, max-age=31536000, immutable')
      return file
    })
  }

  /** The single art-directed preview image, owned by the server, not the build. */
  app.get('/og-envelope.png', async (c) => {
    return (await serveFile(join(assetRoot, 'og-envelope.png'))) ?? c.notFound()
  })

  app.get('/favicon.svg', async (c) => {
    return (
      (await serveFile(safeJoin(staticRoot, 'favicon.svg'))) ??
      (await serveFile(join(assetRoot, 'favicon.svg'))) ??
      c.notFound()
    )
  })

  // ---- the SPA entry -----------------------------------------------------------------------

  const spaShell = (indexable = false): Response =>
    html(
      shell({ drop: null, canonical: null, origin: origin(), assetTags, qrPath: null, indexable }),
      indexable,
    )

  /** The landing page: the only shell that may be indexed. */
  app.get('/', () => spaShell(true))
  /** Client-routed pages that are not campaign links. */
  app.get('/create', () => spaShell())

  /**
   * The sponsor's close screen.
   *
   * A generic shell, deliberately: it performs NO lookup and its head is
   * byte-identical to every other non-campaign page. A route that rendered the
   * sponsor label here would turn a URL anyone can construct into a confirmation
   * that a drop exists, on the one page whose subject is ending it.
   *
   * It is mounted so a sponsor can reload, or open the link cold in Nimiq Pay,
   * and still get the app rather than the API's JSON 404 — this path is under
   * `/drop/:publicId`, which matches only the exact two-segment route above.
   */
  app.get('/drop/:publicId/close', (c) => {
    const publicId = c.req.param('publicId') ?? ''
    if (!PUBLIC_ID_RE.test(publicId)) return c.notFound()
    return spaShell()
  })
}
