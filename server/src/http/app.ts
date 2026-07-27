import { createHash } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Pool } from 'pg'
import { addressFromPublicKey } from '../auth/verify'
import type { ChainClient } from '../chain/types'
import { DropShapeError, formatNim, lunaFromNim } from '../money'
import { type Alerts, throttled } from '../services/alerts'
import {
  ClaimNotFoundError,
  ClaimRejectedError,
  claimStatus,
  issueChallenge,
  reserveClaim,
  type ClaimRejectionCode,
} from '../services/claims'
import {
  DropNotFoundError,
  FundingRejectedError,
  createDraft,
  fundingMemoFor,
  getPublic,
  submitFunding,
  type DropPublic,
  type FundingRejectionCode,
} from '../services/drops'
import {
  type CapacitySnapshot,
  CapExceededError,
  DropTooLargeError,
  InsolventError,
  NoHeadroomError,
  PausedError,
  RECONCILIATION_MAX_AGE_MS,
  StaleReconciliationError,
  readCapacity,
  readControls,
} from '../services/solvency'
import { StatsCache, type StatsCacheOptions, StatsUnavailableError } from '../services/stats'
import { SHARED_BUCKET, type ClientIpResolver } from './client-ip'
import { type CustodyDisclosure, buildDisclosure } from './disclosure'
import { ConflictError, bindIdem, idemKeyHash, lookupIdem } from './idempotency'
import { logError } from './redact'
import { registerSsr } from './ssr'

/**
 * The whole public HTTP surface (design §11), plus an unauthenticated
 * `GET /health` (amended contract: "six endpoints + /health") and an
 * unauthenticated `GET /api/stats` (aggregate counts for the landing page;
 * `services/stats.ts` owns what may appear in it).
 *
 * Three rules shape every line below.
 *
 *  1. **The HTTP layer decides nothing about money.** It parses, rate-limits,
 *     and translates error classes into status codes. Every state transition
 *     happens inside `services/*`, which own their transactions and lock order.
 *  2. **Responses never leak.** One envelope, `{ error: { code, message } }`,
 *     with curated messages: no stack traces, no SQL, no driver codes, and no
 *     claimant addresses. A wrong bearer token and an unknown claim id produce
 *     byte-identical 404s, so status reads are not an existence oracle.
 *  3. **Status tokens live in the `Authorization` header only.** They are never
 *     put in a path, a query string, a redirect, or a log line.
 *
 * `registerSsr` (`./ssr`) is mounted at the bottom, so the route order is fixed:
 * API first, SSR and SPA assets last.
 */

// ---- rate limits ---------------------------------------------------------------

export interface RateLimits {
  /** Requests per window per client IP, across every `/api` route. */
  ipPerWindow: number
  /** Claim attempts per window per drop (design §10.1). */
  claimsPerDropPerWindow: number
  /** Claim attempts per window per derived wallet address, across drops. */
  claimsPerWalletPerWindow: number
  windowMs: number
}

export const DEFAULT_LIMITS: RateLimits = {
  ipPerWindow: 60,
  claimsPerDropPerWindow: 10,
  claimsPerWalletPerWindow: 5,
  windowMs: 60_000,
}

/** Stop the limiter itself from becoming the memory leak it protects against. */
const MAX_TRACKED_KEYS = 20_000

interface Verdict {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * In-memory token buckets, one map per limiter, scoped to a single app
 * instance (i.e. one process). That is deliberate for Cycle I: a shared store
 * would mean Redis, which is a banned dependency, and the single API process is
 * the only ingress. Restarting the process forgives outstanding penalties —
 * acceptable for abuse damping, and irrelevant to correctness, because the
 * database (one claim per wallet, one payout per claim) is what protects money.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  take(key: string): Verdict {
    const at = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED_KEYS) this.sweep(at)
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: at })
      return { allowed: true, retryAfterSeconds: 0 }
    }

    const elapsed = Math.max(0, at - bucket.updatedAt)
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / this.windowMs) * this.capacity)
    bucket.updatedAt = at

    if (bucket.tokens < 1) {
      const msToOneToken = ((1 - bucket.tokens) * this.windowMs) / this.capacity
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msToOneToken / 1000)) }
    }
    bucket.tokens -= 1
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** Drop every bucket that has fully refilled: it is identical to no bucket. */
  private sweep(at: number): void {
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.updatedAt >= this.windowMs) this.buckets.delete(key)
    }
  }
}

// ---- error envelope -------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly publicMessage: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage)
  }
}

/** Uniform: unknown drop, unknown claim, wrong bearer, absent bearer, no route. */
function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'not found')
}

function invalidRequest(message = 'request body is not valid'): HttpError {
  return new HttpError(400, 'invalid_request', message)
}

/**
 * Client-facing copy for every rejection code. The service messages are NOT
 * forwarded: `ClaimRejectionCode` and `FundingRejectionCode` are documented as
 * "callers map these to generic client-facing messages", and a fixed table is
 * the only way to guarantee that stays true when a service message changes.
 */
const CLAIM_MESSAGES: Record<ClaimRejectionCode, string> = {
  unknown_challenge: 'this claim request is no longer valid — start again',
  cross_drop_challenge: 'this claim request is no longer valid — start again',
  challenge_expired: 'this claim request expired — start again',
  challenge_consumed: 'this claim request was already used — start again',
  // NOT "the wallet signature could not be verified". That sentence reads as
  // "your wallet refused you", which is the one thing it never means: the
  // wallet did its part and this server could not confirm it. The claimant
  // declining in Nimiq Pay is a different screen with its own words, so this
  // one owes them the other half — nothing was spent, and the link still works.
  invalid_signature:
    'we could not check that approval — nothing was claimed and nothing left your wallet, so try again or come back to this link later',
  message_mismatch: 'this claim request is no longer valid — start again',
  drop_not_live: 'this drop is not accepting claims',
  drop_expired: 'this drop has expired',
  exhausted: 'every share in this drop has been claimed',
}

const FUNDING_MESSAGES: Record<FundingRejectionCode, string> = {
  wrong_network: 'that transaction is on a different network',
  execution_failed: 'that transaction did not succeed on chain',
  wrong_recipient: 'that transaction was not sent to the funding address',
  wrong_amount: 'that transaction does not match the exact funding amount',
  wrong_memo: 'that transaction does not carry this drop’s funding message',
  invalid_sender: 'that transaction has no usable sender',
  reused_hash: 'that transaction was already used to fund a drop',
  drop_not_fundable: 'this drop is no longer awaiting funding',
  attested_as_float: 'that transaction is already recorded as an operator deposit',
}

/** Retry hint for a temporarily unavailable money path. */
const DEGRADED_RETRY_SECONDS = 30

// ---- request parsing -------------------------------------------------------------

/** 16 random bytes, base64url: exactly 22 URL-safe characters (`ids.ts`). */
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Nimiq transaction id: 32 bytes of hex. */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/
/** Ed25519 public key (32 bytes) and signature (64 bytes). */
const PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/
const SIGNATURE_RE = /^[0-9a-fA-F]{128}$/
/** Decimal NIM with at most 5 places, matching `lunaFromNim`. */
const NIM_AMOUNT_RE = /^\d{1,9}(\.\d{1,5})?$/

const MAX_BODY_BYTES = 8 * 1024
const MAX_SPONSOR_LABEL_CHARS = 40
const MAX_MESSAGE_CHARS = 200
const MAX_IDEM_KEY_CHARS = 200

/** A well-formed id is checked before any lookup, so junk never reaches the DB. */
function requirePublicId(c: Context): string {
  const publicId = c.req.param('publicId')
  if (!publicId || !PUBLIC_ID_RE.test(publicId)) throw notFound()
  return publicId
}

function requireIdemKey(c: Context): string {
  const raw = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key')
  const key = raw?.trim() ?? ''
  if (key === '' || key.length > MAX_IDEM_KEY_CHARS) {
    throw new HttpError(400, 'idempotency_key_required', 'an Idempotency-Key header is required')
  }
  return key
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw invalidRequest()
  if (text.trim() === '') throw invalidRequest()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidRequest()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalidRequest()
  return parsed as Record<string, unknown>
}

/** Strict shape check: unknown properties are rejected, never ignored. */
function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidRequest()
  }
}

function requireString(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key]
  if (typeof value !== 'string') throw invalidRequest()
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) throw invalidRequest()
  return trimmed
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalidRequest()
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) throw invalidRequest()
  return trimmed
}

function matching(body: Record<string, unknown>, key: string, re: RegExp): string {
  const value = body[key]
  if (typeof value !== 'string' || !re.test(value)) throw invalidRequest()
  return value
}

/**
 * Canonical JSON: object keys sorted, `undefined` dropped. Two byte-different
 * requests that mean the same thing must produce the same idempotency request
 * hash, otherwise a retried key looks like a reused one.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}

function requestHash(scope: string, value: unknown): string {
  return createHash('sha256').update(`${scope}\n${canonicalJson(value)}`, 'utf8').digest('hex')
}

// ---- response shapes ---------------------------------------------------------------

function requireOrigin(): string {
  const origin = process.env.PUBLIC_ORIGIN
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set')
  return origin.replace(/\/+$/, '')
}

export function shareUrlFor(publicId: string): string {
  return `${requireOrigin()}/drop/${publicId}`
}

/**
 * `getPublic` is the ONLY read shape served publicly: it carries no claimant
 * addresses, no signatures and no row ids. This function only serialises it —
 * it must never add a field the projection did not hand over.
 */
function publicBody(drop: DropPublic): Record<string, unknown> {
  return {
    publicId: drop.publicId,
    sponsorLabel: drop.sponsorLabel,
    message: drop.message,
    amountEach: drop.amountEach,
    claimCount: drop.claimCount,
    remaining: drop.remaining,
    state: drop.state,
    expiresAt: drop.expiresAt === null ? null : drop.expiresAt.toISOString(),
    ...(drop.fundingTxHash === undefined ? {} : { fundingTxHash: drop.fundingTxHash }),
  }
}

interface DraftBody {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  /** Decimal NIM, for display. */
  expectedFunding: string
  /** The same amount in luna, as a string: what the wallet call needs, exactly. */
  expectedFundingLuna: string
  shareUrl: string
  /**
   * When this draft stops holding room in the aggregate cap. After it passes,
   * funding may still work — it just is not promised any more.
   */
  reservationExpiresAt: string | null
  /**
   * Everything the sponsor must see before the wallet prompt. Carried on the
   * draft as well as on `GET /api/custody` so the confirmation screen shows the
   * numbers that applied to THIS drop, not a second fetch's.
   */
  disclosure: CustodyDisclosure
}

function draftBody(o: {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFundingLuna: bigint
  reservationExpiresAt: Date | null
  disclosure: CustodyDisclosure
}): DraftBody {
  return {
    publicId: o.publicId,
    fundingAddress: o.fundingAddress,
    fundingMemo: o.fundingMemo,
    expectedFunding: formatNim(o.expectedFundingLuna),
    expectedFundingLuna: o.expectedFundingLuna.toString(),
    shareUrl: shareUrlFor(o.publicId),
    reservationExpiresAt:
      o.reservationExpiresAt === null ? null : o.reservationExpiresAt.toISOString(),
    disclosure: o.disclosure,
  }
}

/**
 * Build the custody disclosure from live controls.
 *
 * `capacity` is passed in by the create route, which already read it inside the
 * reservation transaction — that snapshot includes the sponsor's own drop and
 * is the one their screen must show. Everything else reads it fresh.
 */
async function currentDisclosure(
  pool: Pool,
  chain: ChainClient,
  capacity?: CapacitySnapshot,
): Promise<CustodyDisclosure> {
  const controls = await readControls(pool)
  return buildDisclosure({
    network: chain.network(),
    custodyAddress: chain.custodyAddress(),
    paused: controls.paused,
    capacity: capacity ?? (await readCapacity(pool, controls)),
  })
}

// ---- app -----------------------------------------------------------------------------

export interface AppDeps {
  pool: Pool
  chain: ChainClient
  alerts: Alerts
  /** Injectable clock for the rate limiters (tests freeze it). */
  now?: () => number
  limits?: Partial<RateLimits>
  /**
   * How the per-IP limiter names a client (`http/client-ip.ts`). Built in
   * `index.ts` from the socket peer and the Caddy shared secret.
   *
   * ABSENT MEANS ONE SHARED BUCKET, deliberately: an app wired without a
   * resolver rate-limits every client together — visible, and safe — instead
   * of falling back to reading `X-Forwarded-For`, which any client can set.
   * There is no configuration of this process in which a header decides a
   * bucket without a secret proving which hop set it.
   */
  clientIp?: ClientIpResolver
  /**
   * Overrides for the `GET /api/stats` snapshot cache (`services/stats.ts`).
   * Production leaves this alone and gets the module's defaults; tests shorten
   * the TTL so they can observe a refresh without waiting a minute.
   */
  statsCache?: StatsCacheOptions
}

const CREATE_DROP_SCOPE = 'POST /api/drops'

export function makeApp(deps: AppDeps): Hono {
  const { pool, chain } = deps
  const now = deps.now ?? Date.now
  const limits: RateLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const clientIp: ClientIpResolver = deps.clientIp ?? (() => SHARED_BUCKET)
  // Throttled so a hot claim path cannot turn one insolvency into a webhook flood.
  const alerts = throttled(deps.alerts)

  // One per app, so its TTL and its single-flight guarantee are process-wide.
  // Built with the injected clock: the tests that freeze `now` for the rate
  // limiters freeze the stats TTL with it.
  const statsCache = new StatsCache(pool, { now, ...deps.statsCache })

  const ipBucket = new TokenBuckets(limits.ipPerWindow, limits.windowMs, now)
  const dropClaimBucket = new TokenBuckets(limits.claimsPerDropPerWindow, limits.windowMs, now)
  const walletClaimBucket = new TokenBuckets(limits.claimsPerWalletPerWindow, limits.windowMs, now)

  function enforce(bucket: TokenBuckets, key: string): void {
    const verdict = bucket.take(key)
    if (verdict.allowed) return
    throw new HttpError(429, 'rate_limited', 'too many requests — try again shortly', verdict.retryAfterSeconds)
  }

  const app = new Hono()

  // ---- error handling: one envelope, everywhere --------------------------------

  app.notFound(() => envelope(notFound()))

  app.onError((err, c) => {
    const mapped = mapError(err)
    if (mapped.status >= 500) {
      // Redacted twice over. By SELECTION: method + route, error identity and
      // stack, never the body, the headers, or the bearer token (design §11).
      // And by FILTER: `logError` puts the message and the stack through
      // `http/redact.ts`, because their contents are the failing library's
      // choice, not ours — a driver that echoes a signed transaction or a
      // connection string into its own error text would otherwise put it here.
      logError('request_failed', {
        method: c.req.method,
        route: c.req.routePath,
        error: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
    }
    if (mapped.code === 'paused') void alerts.notify('paused', { surface: 'api' })
    if (mapped.code === 'degraded') void alerts.notify('stale_reconciliation', { surface: 'api' })
    if (mapped.code === 'unavailable') void alerts.notify('insolvent', { surface: 'api' })
    // A refusal the claimant is not told apart from any other refusal, because
    // it is not about them: the service found the failure operator-shaped and
    // said so. See `ClaimDiagnostic` in `services/claims.ts`.
    if (err instanceof ClaimRejectedError && err.diagnostic) {
      void alerts.notify(err.diagnostic.alert, { surface: 'api', ...err.diagnostic.detail })
    }
    return envelope(mapped)
  })

  // ---- middleware ----------------------------------------------------------------

  const perIp: MiddlewareHandler = async (c, next) => {
    enforce(ipBucket, clientIp(c))
    await next()
  }
  // Scoped to `/api`: `/health` must stay answerable to monitors, and the SSR
  // and SPA assets Task 14 mounts are not money paths.
  app.use('/api/*', perIp)

  // ---- POST /api/drops -------------------------------------------------------------

  app.post('/api/drops', async (c) => {
    const idemKey = requireIdemKey(c)
    const body = await readJsonObject(c)
    only(body, ['sponsorLabel', 'message', 'amountEach', 'claimCount'])

    const sponsorLabel = requireString(body, 'sponsorLabel', MAX_SPONSOR_LABEL_CHARS)
    const message = optionalString(body, 'message', MAX_MESSAGE_CHARS)
    const amountEach = matching(body, 'amountEach', NIM_AMOUNT_RE)
    const claimCount = body.claimCount
    if (typeof claimCount !== 'number' || !Number.isInteger(claimCount)) throw invalidRequest()

    const amountEachLuna = lunaFromNim(amountEach) // DropShapeError → 400

    const keyHash = idemKeyHash(CREATE_DROP_SCOPE, idemKey)
    const hash = requestHash(CREATE_DROP_SCOPE, { sponsorLabel, message, amountEach, claimCount })

    const recorded = await lookupIdem(pool, CREATE_DROP_SCOPE, keyHash)
    if (recorded) {
      if (recorded.requestHash !== hash) throw new ConflictError()
      const replay = recorded.resourceId ? await draftById(pool, chain, recorded.resourceId) : null
      if (replay) return c.json(replay, recorded.responseStatus as ContentfulStatusCode)
    }

    const draft = await createDraft(pool, chain, {
      sponsorLabel,
      ...(message === undefined ? {} : { message }),
      amountEachLuna,
      claimCount,
    })

    // A draft holds no money, so binding the key AFTER the insert is safe: the
    // worst case is an orphan draft that `gcDrafts` collects. Money-bearing
    // idempotency (claims) is bound inside the service transaction instead.
    const dropId = await dropRowId(pool, draft.publicId)
    const bound = await bindIdem(pool, {
      scope: CREATE_DROP_SCOPE,
      keyHash,
      requestHash: hash,
      resourceType: 'drop',
      resourceId: dropId,
      responseStatus: 201,
    })
    if (!bound.created && bound.record.resourceId && bound.record.resourceId !== dropId) {
      // A concurrent duplicate of this exact request won the race; answer with
      // the draft the key is actually bound to, so both callers agree.
      const winner = await draftById(pool, chain, bound.record.resourceId)
      if (winner) return c.json(winner, bound.record.responseStatus as ContentfulStatusCode)
    }

    return c.json(
      draftBody({
        ...draft,
        reservationExpiresAt: draft.reservationExpiresAt,
        disclosure: await currentDisclosure(pool, chain, draft.capacity),
      }),
      201,
    )
  })

  // ---- GET /api/custody -------------------------------------------------------------
  //
  // What a sponsor must be able to read BEFORE they start a drop, let alone
  // before their wallet asks them to approve anything: that this is a custodial
  // hot wallet, who holds the key, which chain and address the money goes to,
  // and exactly how much room is left. Unauthenticated and cheap, so the create
  // screen can render it on first paint.
  app.get('/api/custody', async (c) => {
    return c.json(await currentDisclosure(pool, chain))
  })

  // ---- GET /api/stats ----------------------------------------------------------------
  //
  // Public aggregate statistics for the landing page. Everything about what may
  // and may not appear here — and why the "paid out" predicate is the one it is
  // — lives in `services/stats.ts`; this route only serialises and caches.
  //
  // Mounted under `/api` deliberately, so the per-IP limiter above covers it:
  // an unauthenticated read on a money service gets the same 60-per-minute
  // budget as every other API route, and `StatsCache` means even that budget
  // costs at most one query a minute. `/health` is outside `/api` because a
  // monitor must always be answered; a statistics page has no such claim.
  app.get('/api/stats', async (c) => {
    const stats = await statsCache.read()
    // Let a browser or a proxy absorb the rest of the burst too. `public` is
    // correct: the body is identical for every caller and depends on no header,
    // no cookie and no bearer token.
    //
    // The lifetime is what is LEFT of this snapshot's own freshness, not a flat
    // TTL. A snapshot served stale — because a refresh is running behind it, or
    // failing — must not be handed to a proxy with a full minute of life ahead
    // of it, or the numbers a visitor sees could outlive the window this
    // process is willing to vouch for.
    const ageMs = statsCache.ageMs(now()) ?? 0
    const remainingMs = Math.max(0, statsCache.ttlMs - ageMs)
    c.header('cache-control', `public, max-age=${Math.floor(remainingMs / 1000)}`)
    return c.json(stats)
  })

  // ---- POST /api/drops/:publicId/funding ------------------------------------------

  app.post('/api/drops/:publicId/funding', async (c) => {
    const publicId = requirePublicId(c)
    const body = await readJsonObject(c)
    only(body, ['txHash'])
    const txHash = matching(body, 'txHash', TX_HASH_RE)

    // Idempotent by construction (the drop holds at most one funding hash for
    // its whole life), so no Idempotency-Key is required here. A hash the chain
    // cannot see yet comes back as ordinary state — never an error, and never a
    // prompt to fund again (design §4.2 step 5).
    return c.json(publicBody(await submitFunding(pool, chain, { publicId, txHash })))
  })

  // ---- GET /api/drops/:publicId ------------------------------------------------------

  app.get('/api/drops/:publicId', async (c) => {
    return c.json(publicBody(await getPublic(pool, requirePublicId(c))))
  })

  // ---- POST /api/drops/:publicId/challenge -------------------------------------------

  app.post('/api/drops/:publicId/challenge', async (c) => {
    const issued = await issueChallenge(pool, requirePublicId(c))
    return c.json({
      challengeId: issued.challengeId,
      message: issued.message,
      expiresAt: issued.expiresAt.toISOString(),
    })
  })

  // ---- POST /api/drops/:publicId/claims ------------------------------------------------

  app.post('/api/drops/:publicId/claims', async (c) => {
    const publicId = requirePublicId(c)
    const idemKey = requireIdemKey(c)
    const body = await readJsonObject(c)
    only(body, ['challengeId', 'publicKey', 'signature'])
    const challengeId = matching(body, 'challengeId', UUID_RE)
    const publicKeyHex = matching(body, 'publicKey', PUBLIC_KEY_RE)
    const signatureHex = matching(body, 'signature', SIGNATURE_RE)

    // Per-wallet limiter (design §10.1) keyed on the address DERIVED from the
    // key, not on anything the body nominates. A key we cannot derive from is
    // left to the signature check, which rejects it anyway.
    const walletKey = tryDeriveAddress(publicKeyHex)
    if (walletKey) enforce(walletClaimBucket, walletKey)

    const scope = `POST /api/drops/${publicId}/claims`
    const result = await reserveClaim(pool, {
      publicId,
      challengeId,
      publicKeyHex,
      signatureHex,
      idemKey,
      requestHash: requestHash(scope, { challengeId, publicKey: publicKeyHex, signature: signatureHex }),
      // G1 review finding 8, round-2 F8, round-3 R5: the per-drop bucket is
      // charged only by the request that actually commits a new reservation,
      // from inside the allocation transaction. Charging it up front made a
      // targeted lockout cost nothing (ten junk requests a minute at one drop
      // id and its real claimants got 429s while the attacker never signed
      // anything); charging every authenticated request let two wallets
      // retrying five times each close a ten-claim drop; charging before the
      // transaction let ten CONCURRENT copies of one retry each spend a token
      // for the single claim they collectively produced. Junk and retries are
      // charged to the per-IP limiter instead, which is the one an attacker
      // cannot aim at someone else's drop.
      //
      // This runs while the singleton custody lock is held, so it must stay
      // what it is: an in-memory token bucket that returns immediately.
      onAuthenticated: () => enforce(dropClaimBucket, publicId),
    })

    // 202: the slot is reserved and the payout intent is committed, but the
    // transfer is the worker's job. `broadcast` is not `paid`.
    return c.json({ claimId: result.claimId, statusToken: result.statusToken, state: result.state }, 202)
  })

  // ---- GET /api/claims/:claimId ----------------------------------------------------------

  app.get('/api/claims/:claimId', async (c) => {
    const token = bearerToken(c)
    if (!token) throw notFound() // uniform with an unknown id: no existence oracle
    const status = await claimStatus(pool, c.req.param('claimId') ?? '', token)
    return c.json({
      state: status.state,
      amountEach: status.amountEach,
      ...(status.txHash === undefined ? {} : { txHash: status.txHash }),
    })
  })

  // ---- GET /health -------------------------------------------------------------------------

  /**
   * Unauthenticated liveness for the operator and the deploy. `workerFresh` is
   * read from `custody_controls.last_reconciled_at` WITHOUT taking the lock —
   * a health probe must never queue behind a payout transaction.
   */
  app.get('/health', async (c) => {
    let headHeight: number | null = null
    try {
      headHeight = await chain.headHeight()
    } catch {
      headHeight = null
    }

    let workerFresh = false
    try {
      const controls = await readControls(pool)
      const at = controls.lastReconciledAt
      workerFresh = at !== null && Date.now() - at.getTime() <= RECONCILIATION_MAX_AGE_MS
    } catch {
      workerFresh = false
    }

    const ok = headHeight !== null && workerFresh
    return c.json({ ok, headHeight, workerFresh }, ok ? 200 : 503)
  })

  // Last, always: the `/d/:publicId` campaign page and the SPA's static files.
  // Registered here so no SSR route can ever shadow an `/api` route.
  registerSsr(app, { pool })

  return app
}

// ---- helpers -------------------------------------------------------------------------------

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

function tryDeriveAddress(publicKeyHex: string): string | null {
  try {
    return addressFromPublicKey(publicKeyHex)
  } catch {
    return null
  }
}

async function dropRowId(pool: Pool, publicId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM drops WHERE public_id = $1', [
    publicId,
  ])
  if (!rows[0]) throw new DropNotFoundError(publicId)
  return rows[0].id
}

/**
 * Rebuild the create-drop response for an idempotent replay.
 *
 * The reservation timestamp comes off the row, so a replay reports the room the
 * original request took rather than a fresh window: retrying a request must
 * never quietly extend a promise.
 */
async function draftById(pool: Pool, chain: ChainClient, dropId: string): Promise<DraftBody | null> {
  if (!UUID_RE.test(dropId)) return null
  const { rows } = await pool.query<{
    public_id: string
    expected_funding_luna: string
    funding_reservation_expires_at: Date | null
  }>(
    'SELECT public_id, expected_funding_luna, funding_reservation_expires_at FROM drops WHERE id = $1',
    [dropId],
  )
  const row = rows[0]
  if (!row) return null
  return draftBody({
    publicId: row.public_id,
    fundingAddress: chain.custodyAddress(),
    fundingMemo: fundingMemoFor(row.public_id),
    expectedFundingLuna: BigInt(row.expected_funding_luna),
    reservationExpiresAt: row.funding_reservation_expires_at,
    disclosure: await currentDisclosure(pool, chain),
  })
}

/**
 * The single error table. Everything not listed is a 500 with a fixed message:
 * an unmapped error must never describe itself to a client.
 */
function mapError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof ConflictError) {
    return new HttpError(
      409,
      'idempotency_key_reused',
      'this Idempotency-Key was already used for a different request',
    )
  }
  if (err instanceof DropNotFoundError || err instanceof ClaimNotFoundError) return notFound()
  if (err instanceof FundingRejectedError) {
    return new HttpError(422, err.code, FUNDING_MESSAGES[err.code] ?? 'that transaction cannot fund this drop')
  }
  if (err instanceof ClaimRejectedError) {
    return new HttpError(409, err.code, CLAIM_MESSAGES[err.code] ?? 'this claim cannot be completed')
  }
  if (err instanceof DropShapeError) return invalidRequest(err.message)
  // Capacity refusals come BEFORE the generic `CapExceededError` line below, on
  // purpose. They are the only money-shaped refusal a sponsor meets before they
  // have paid anything, and "temporarily unavailable" would be both vaguer and,
  // for a drop that is simply too big, wrong: no amount of retrying helps.
  // The numbers are read off the error rather than forwarded as prose, so the
  // client copy stays this file's to choose (see the CLAIM_MESSAGES note).
  //
  // Both are now reachable ONLY when an operator has set the principal cap as a
  // kill switch (migration 015); with it unset there is no size a drop can be
  // too big for. The `?? 0n` fallbacks are therefore unreachable-by-construction
  // rather than a guess at a number — a cap that is null cannot have thrown.
  if (err instanceof DropTooLargeError) {
    const max = formatNim(err.capacity.maxLivePrincipalLuna ?? 0n)
    return new HttpError(
      422,
      'drop_too_large',
      err.capacity.maxLiveDrops === 0
        ? 'this deployment is set to hold no live drops at all — ask the operator to open it'
        : `the operator has capped all live drops at ${max} NIM — try a smaller total`,
    )
  }
  if (err instanceof NoHeadroomError) {
    const free = formatNim(err.capacity.remainingLuna ?? 0n)
    const needed = formatNim(err.requestedLuna)
    return new HttpError(
      503,
      'no_capacity',
      err.capacity.remainingDrops === 0
        ? 'a drop is already running and this pilot runs one at a time — try again when it finishes'
        : `this drop needs ${needed} NIM and ${free} NIM is free right now — try a smaller total, or try again later`,
      DEGRADED_RETRY_SECONDS,
    )
  }
  if (err instanceof PausedError) {
    return new HttpError(503, 'paused', 'payouts are paused — try again shortly', DEGRADED_RETRY_SECONDS)
  }
  if (err instanceof StaleReconciliationError) {
    return new HttpError(503, 'degraded', 'temporarily unavailable — try again shortly', DEGRADED_RETRY_SECONDS)
  }
  // Its own code, NOT the shared `unavailable`: that one makes `onError` fire an
  // `insolvent` alert, and a landing-page statistic that could not be computed
  // must never page an operator about custody. Nothing on a money path depends
  // on this route, so its failure is exactly as serious as it looks.
  if (err instanceof StatsUnavailableError) {
    return new HttpError(
      503,
      'stats_unavailable',
      'statistics are temporarily unavailable — try again shortly',
      DEGRADED_RETRY_SECONDS,
    )
  }
  if (err instanceof InsolventError || err instanceof CapExceededError) {
    return new HttpError(503, 'unavailable', 'temporarily unavailable — try again shortly', DEGRADED_RETRY_SECONDS)
  }
  return new HttpError(500, 'internal_error', 'something went wrong')
}

function envelope(err: HttpError): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=UTF-8' }
  if (err.retryAfterSeconds !== undefined) headers['retry-after'] = String(err.retryAfterSeconds)
  return new Response(JSON.stringify({ error: { code: err.code, message: err.publicMessage } }), {
    status: err.status,
    headers,
  })
}
