import { timingSafeEqual } from 'node:crypto'
import { SocketAddress, isIP } from 'node:net'
import type { Context } from 'hono'

/**
 * Who the request is FROM, for rate-limiting purposes only.
 *
 * The deployment topology this has to survive is: claimant → Cloudflare → Caddy
 * → this process. Two obvious readings of that chain are both wrong.
 *
 *  - Reading the LAST `X-Forwarded-For` hop is correct with Caddy alone (Caddy
 *    appends the real peer, so the last entry is the one a client cannot
 *    forge). Put Cloudflare in front and the last hop becomes a Cloudflare edge
 *    address: every claimant on earth collapses into one 60/min bucket and
 *    honest users start seeing 429s.
 *  - Reading `CF-Connecting-IP` instead re-opens the hole the last-hop rule
 *    closed. The header is only meaningful if the request actually came from
 *    Cloudflare, and this process cannot tell — anyone who finds the origin can
 *    send it and pick their own bucket.
 *
 * So the app is not Cloudflare-aware at all. Caddy is the only component that
 * knows about the edge: it authenticates Cloudflare by CIDR
 * (`trusted_proxies_strict`), derives `{client_ip}` itself, and hands us ONE
 * header — plus a shared secret that proves the header came from Caddy and not
 * from the internet. See the `Caddyfile`.
 *
 * Everything here is built so that every failure — no secret configured, wrong
 * secret, absent header, garbage header, no peer — lands on a bucket the client
 * did NOT choose. That direction matters: a shared bucket over-limits during a
 * misconfiguration and someone notices; a client-chosen bucket silently deletes
 * the limiter and nobody does.
 */

/** The one header carrying the client address. Set by Caddy, never by a client. */
export const CLIENT_IP_HEADER = 'x-nimdrops-client-ip'

/** Proves the hop that set `CLIENT_IP_HEADER` is our own edge. */
export const PROXY_SECRET_HEADER = 'x-nimdrops-proxy-secret'

/** The bucket every unattributable request shares. */
export const SHARED_BUCKET = 'unknown'

/** A bucket key for the per-IP rate limiter. Never used for anything else. */
export type ClientIpResolver = (c: Context) => string

export interface ClientIpOptions {
  /**
   * `CADDY_APP_SHARED_SECRET`. Undefined means "there is no trusted proxy":
   * the socket peer is then the only thing that decides a bucket, which is the
   * right answer for a direct/no-proxy run.
   */
  proxySecret?: string | undefined
  /**
   * The socket peer address, e.g. `getConnInfo(c).remote.address`. May return
   * undefined, and may throw — a runtime without connection info must not turn
   * every request into a 500.
   */
  peerAddress: (c: Context) => string | undefined
}

/**
 * One address, one string — or undefined if it is not a single IP address.
 *
 * Two jobs. It REJECTS anything that is not exactly one address (comma lists,
 * `host:port`, CIDR, junk), because a bucket key that a client can vary at will
 * is not a limit. And it FOLDS the spellings of the same address together:
 * `::FFFF:1.2.3.4`, `::ffff:0102:0304` and `1.2.3.4` are one host and must be
 * one bucket, or a dual-stack client gets several limits for free. `isIP` does
 * the validating; `SocketAddress` (Node ≥ 18, no dependency) does the
 * normalising — case, zero-compression and the zone id — and the v4-mapped
 * prefix is stripped here because it does not.
 */
export function canonicalIp(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  const family = isIP(trimmed)
  if (family === 0) return undefined

  let normalised: string
  try {
    normalised = new SocketAddress({ address: trimmed, family: family === 4 ? 'ipv4' : 'ipv6' }).address
  } catch {
    return undefined
  }

  if (family === 6 && normalised.startsWith('::ffff:')) {
    const mapped = normalised.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return mapped
  }
  return normalised
}

/**
 * Constant-time over the secret's bytes, and length-checked first because
 * `timingSafeEqual` THROWS on unequal lengths — an uncaught throw here would be
 * a 500 on every request, triggerable by anyone sending a one-byte header.
 * The length leak is not worth defending: it is a property of a secret the
 * operator generates, not of any user input.
 */
function secretMatches(configured: string, presented: string | undefined): boolean {
  if (presented === undefined) return false
  const expected = Buffer.from(configured, 'utf8')
  const actual = Buffer.from(presented, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Build the resolver. Precedence, and there is only one:
 *
 *   authenticated hop's `CLIENT_IP_HEADER`  →  socket peer  →  `SHARED_BUCKET`
 *
 * `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` and friends are never
 * read, at any point, under any configuration. Caddy strips them on the way in;
 * this module would ignore them even if it did not.
 */
export function makeClientIpResolver(options: ClientIpOptions): ClientIpResolver {
  const { proxySecret } = options

  return (c: Context): string => {
    let peer: string | undefined
    try {
      peer = canonicalIp(options.peerAddress(c))
    } catch {
      peer = undefined
    }
    const fallback = peer ?? SHARED_BUCKET

    if (proxySecret === undefined || proxySecret === '') return fallback
    if (!secretMatches(proxySecret, c.req.header(PROXY_SECRET_HEADER))) return fallback

    return canonicalIp(c.req.header(CLIENT_IP_HEADER)) ?? fallback
  }
}
