import { createHash } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Pool } from 'pg'
import { addressFromPublicKey } from '../auth/verify'
import type { ChainClient } from '../chain/types'
import { CapError, formatNim, lunaFromNim } from '../money'
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
  CapExceededError,
  InsolventError,
  PausedError,
  RECONCILIATION_MAX_AGE_MS,
  StaleReconciliationError,
  readControls,
} from '../services/solvency'
import { ConflictError, bindIdem, idemKeyHash, lookupIdem } from './idempotency'
import { registerSsr } from './ssr'

/**
 * The whole public HTTP surface (design §11), plus an unauthenticated
 * `GET /health` (amended contract: "six endpoints + /health").
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

/**
 * The client address, taken as the LAST entry of `X-Forwarded-For`.
 *
 * Caddy appends the peer address to whatever the client sent, so the last hop
 * is the only entry an attacker cannot forge. Reading the first entry — the
 * common mistake — would let anyone pick their own rate-limit bucket.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last
  }
  return c.req.header('x-real-ip')?.trim() || 'unknown'
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
  invalid_signature: 'the wallet signature could not be verified',
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
  return `${requireOrigin()}/d/${publicId}`
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
}

function draftBody(o: {
  publicId: string
  fundingAddress: string
  fundingMemo: string
  expectedFundingLuna: bigint
}): DraftBody {
  return {
    publicId: o.publicId,
    fundingAddress: o.fundingAddress,
    fundingMemo: o.fundingMemo,
    expectedFunding: formatNim(o.expectedFundingLuna),
    expectedFundingLuna: o.expectedFundingLuna.toString(),
    shareUrl: shareUrlFor(o.publicId),
  }
}

// ---- app -----------------------------------------------------------------------------

export interface AppDeps {
  pool: Pool
  chain: ChainClient
  alerts: Alerts
  /** Injectable clock for the rate limiters (tests freeze it). */
  now?: () => number
  limits?: Partial<RateLimits>
}

const CREATE_DROP_SCOPE = 'POST /api/drops'

export function makeApp(deps: AppDeps): Hono {
  const { pool, chain } = deps
  const now = deps.now ?? Date.now
  const limits: RateLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  // Throttled so a hot claim path cannot turn one insolvency into a webhook flood.
  const alerts = throttled(deps.alerts)

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
      // Redacted on purpose: method + route, error identity and stack. Never the
      // body, the headers, or the bearer token — design §11.
      console.error(
        JSON.stringify({
          event: 'request_failed',
          method: c.req.method,
          route: c.req.routePath,
          error: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
      )
    }
    if (mapped.code === 'paused') void alerts.notify('paused', { surface: 'api' })
    if (mapped.code === 'degraded') void alerts.notify('stale_reconciliation', { surface: 'api' })
    if (mapped.code === 'unavailable') void alerts.notify('insolvent', { surface: 'api' })
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

    const amountEachLuna = lunaFromNim(amountEach) // CapError → 400

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

    return c.json(draftBody(draft), 201)
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
    // Per-drop limiter first, so a flood cannot make the server do real work
    // (JSON parsing, Ed25519 verification, a database round trip) per request.
    enforce(dropClaimBucket, publicId)
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

/** Rebuild the create-drop response for an idempotent replay. */
async function draftById(pool: Pool, chain: ChainClient, dropId: string): Promise<DraftBody | null> {
  if (!UUID_RE.test(dropId)) return null
  const { rows } = await pool.query<{ public_id: string; expected_funding_luna: string }>(
    'SELECT public_id, expected_funding_luna FROM drops WHERE id = $1',
    [dropId],
  )
  const row = rows[0]
  if (!row) return null
  return draftBody({
    publicId: row.public_id,
    fundingAddress: chain.custodyAddress(),
    fundingMemo: fundingMemoFor(row.public_id),
    expectedFundingLuna: BigInt(row.expected_funding_luna),
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
  if (err instanceof CapError) return invalidRequest(err.message)
  if (err instanceof PausedError) {
    return new HttpError(503, 'paused', 'payouts are paused — try again shortly', DEGRADED_RETRY_SECONDS)
  }
  if (err instanceof StaleReconciliationError) {
    return new HttpError(503, 'degraded', 'temporarily unavailable — try again shortly', DEGRADED_RETRY_SECONDS)
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
