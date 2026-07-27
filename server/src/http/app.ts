import { createHash } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Pool } from 'pg'
import { addressFromPublicKey } from '../auth/verify'
import type { ChainClient } from '../chain/types'
import { CapError, formatNim, lunaFromNim } from '../money'
import { normaliseNimiqAddress } from '../nimiq-address'
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
import { submitAttestation } from '../gates/attested'
import { submitPassphrase } from '../gates/passphrase'
import type { TriviaService } from '../gates/trivia/sessions'
import { GateRejectedError, type GateRejectionCode } from '../gates/types'
import { hasGrant, listGames, loadGameView, loadGate } from '../services/gates'
import { SHARED_BUCKET, type ClientIpResolver } from './client-ip'
import { type CustodyDisclosure, buildDisclosure } from './disclosure'
import { ConflictError, bindIdem, idemKeyHash, lookupIdem } from './idempotency'
import { logError } from './redact'
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

/**
 * HTTP requests one honest five-question session costs at the gate routes: one
 * `POST /session`, then a `GET .../question` and a `POST .../answer` per
 * question. The limiter is a multiple of this rather than a bare number, so
 * changing the question count cannot leave a player throttled mid-game.
 */
export const GATE_REQUESTS_PER_SESSION = 11

export interface RateLimits {
  /** Requests per window per client IP, across every `/api` route. */
  ipPerWindow: number
  /** Whole gate sessions one IP may play per window. */
  gateSessionsPerWindow: number
  /** Claim attempts per window per drop (design §10.1). */
  claimsPerDropPerWindow: number
  /** Claim attempts per window per derived wallet address, across drops. */
  claimsPerWalletPerWindow: number
  windowMs: number
}

export const DEFAULT_LIMITS: RateLimits = {
  ipPerWindow: 60,
  // Two, not one: a player who reloads or resumes must not be locked out of the
  // game they are already in the middle of.
  gateSessionsPerWindow: 2,
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
  // NOT "you failed" and not "you are not eligible". The overwhelmingly common
  // case is a stranger who was sent the claim link directly and has never seen
  // the condition at all, so this says what to do rather than what went wrong.
  // It also avoids naming the condition: this layer does not know which kind the
  // drop carries, and guessing would eventually be wrong.
  gate_required: 'this drop asks you to do something first — open it to see what',
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

/**
 * Client-facing copy for every gate rejection, on the same rule as
 * `CLAIM_MESSAGES`: the service message is never forwarded, so a reworded
 * internal message can never reach a client by accident.
 *
 * Two of these say deliberately little. `already_granted` does not name which
 * condition was met, and `misconfigured` does not say what is broken — a
 * player can do nothing with either detail, and the second would describe the
 * operator's config to whoever asked.
 */
const GATE_MESSAGES: Record<GateRejectionCode, string> = {
  not_a_game: 'this drop has no condition to meet',
  game_not_live: 'this drop is not accepting claims',
  wrong_kind: 'that is not how this drop works',
  already_granted: 'you have already met this drop’s condition — claim your share',
  cooldown: 'wait a few minutes before trying again',
  too_many_attempts: 'too many tries — try again in an hour',
  bad_attempt: 'that is not it',
  session_not_found: 'that attempt is no longer valid — start again',
  session_over: 'that attempt is finished — start again',
  deadline_missed: 'time ran out on that question',
  wrong_index: 'that is not the question in play — reload and try again',
  tier_locked: 'pass an easier one first to unlock this',
  bad_attestation: 'that confirmation could not be verified',
  attestation_replayed: 'that confirmation was already used',
  // 5xx: see GATE_STATUS.
  misconfigured: 'this drop is not set up correctly — nobody can claim it yet',
}

/**
 * The status each rejection answers with.
 *
 * `misconfigured` is the only 5xx, and it is deliberate. The request was
 * well-formed and the player did nothing wrong, so every 4xx would blame them;
 * the deployment is genuinely broken, so a 2xx would hide it. It is the one code
 * here that means "our fault", and it is the one an operator must be paged about.
 */
const GATE_STATUS: Record<GateRejectionCode, ContentfulStatusCode> = {
  not_a_game: 404,
  game_not_live: 409,
  wrong_kind: 409,
  already_granted: 409,
  cooldown: 429,
  too_many_attempts: 429,
  bad_attempt: 409,
  session_not_found: 404,
  session_over: 409,
  deadline_missed: 409,
  wrong_index: 409,
  tier_locked: 403,
  bad_attestation: 400,
  attestation_replayed: 409,
  misconfigured: 500,
}

/** Retry hint for a temporarily unavailable money path. */
const DEGRADED_RETRY_SECONDS = 30

// ---- request parsing -------------------------------------------------------------

/** 16 random bytes, base64url: exactly 22 URL-safe characters (`ids.ts`). */
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Nimiq transaction id: 32 bytes of hex. */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/
// A wallet address is checked by its CHECKSUM, in `../nimiq-address`, and there
// is deliberately no `ADDRESS_RE` at this spot any more. The regex that used to
// live here matched the shape and nothing else, so it admitted addresses no
// wallet can hold — see `requireWalletAddress` below and the module comment in
// `../nimiq-address` for what that cost.

/** The longest phrase a sponsor may set. Long enough for a sentence. */
const PHRASE_MAX_LENGTH = 120
/** A signed attestation is seven short lines; this is generous for all of them. */
const ATTESTATION_MAX_LENGTH = 512
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

/**
 * A session id from the path.
 *
 * Answers 404 rather than 400 for a malformed one, matching `requirePublicId`: a
 * session id is an opaque handle, and telling a caller their id is the wrong
 * SHAPE is a distinction only a prober would use.
 */
function requireSessionId(c: Context): string {
  const sessionId = c.req.param('sessionId')
  if (!sessionId || !UUID_RE.test(sessionId)) throw notFound()
  return sessionId
}

/**
 * A whole number in an inclusive range.
 *
 * Rejects a numeric STRING as well as a fraction. `matching()` covers strings and
 * `Number()` would happily accept `"0"`, `" 0"` and `"0.0"` as the same index —
 * three spellings of one answer is the shape of laxity that makes a
 * one-submission-per-question rule negotiable.
 */
function wholeNumberIn(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(`${key} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/** A submitted passphrase. Trimming and casefolding belong to the gate, not here. */
function requirePhrase(body: Record<string, unknown>): string {
  const value = body.phrase
  if (typeof value !== 'string' || value.trim() === '' || value.length > PHRASE_MAX_LENGTH) {
    throw invalidRequest('phrase must be a short non-empty string')
  }
  return value
}

/**
 * A signed attestation message, passed through byte for byte.
 *
 * Deliberately NOT normalised, trimmed or re-joined: the signature covers these
 * exact bytes, so altering them here would either break a valid attestation or —
 * worse — make two different bodies verify as the same message.
 */
function requireAttestationMessage(body: Record<string, unknown>): string {
  const value = body.message
  if (typeof value !== 'string' || value === '' || value.length > ATTESTATION_MAX_LENGTH) {
    throw invalidRequest('message must be a non-empty attestation string')
  }
  return value
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
 * A wallet address from a body, checksum-verified and returned in ONE spelling.
 *
 * Returning the normalised form is not tidiness. The address is stored as written
 * — as a `gate_grants` row and a `trivia_sessions` row — and `reserveClaim` later
 * compares that stored string against an address derived from a verified public
 * key. If `NQ07 ABCD…` and `nq07abcd…` are allowed to reach the database as two
 * strings, one wallet gets two grants on a one-play-per-wallet gate and at least
 * one of them can never be matched by anything derived.
 */
function requireWalletAddress(body: Record<string, unknown>, key = 'walletAddress'): string {
  const value = body[key]
  if (typeof value !== 'string') throw invalidRequest()
  const address = normaliseNimiqAddress(value)
  if (address === null) throw invalidRequest(`${key} is not a valid Nimiq address`)
  return address
}

/**
 * The wallet a session belongs to, from `?wallet=`.
 *
 * Required on the session routes, which otherwise identify the caller by session
 * id alone. A session id is a v4 uuid and so unguessable, but it travels in URLs,
 * referrers and logs, and on its own it was enough to play out somebody else's
 * session — one wrong answer imposes the cooldown on THEIR wallet. Presenting the
 * address alongside it does not make the address a secret; it makes a leaked
 * session id insufficient, which is the whole exposure.
 */
function requireWalletQuery(c: Context): string {
  const value = c.req.query('wallet')
  if (value === undefined) throw invalidRequest('a wallet query parameter is required')
  const address = normaliseNimiqAddress(value)
  if (address === null) throw invalidRequest('wallet is not a valid Nimiq address')
  return address
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
   * The gate services, or null where a kind is not configured.
   *
   * INJECTED rather than constructed here, for two reasons. Reading the question
   * bank is async and `makeApp` is not — making it async would ripple into every
   * caller and every test that builds an app. And tests need to supply a small
   * in-memory bank without touching the filesystem. `index.ts` is the only place
   * that reads the file.
   *
   * Absent, or with `trivia: null`, the corresponding routes answer 404 and every
   * ordinary drop path is untouched. A deployment with no question bank still
   * serves passphrase and attested drops.
   */
  gates?: GateServices | null
}

export interface GateServices {
  trivia: TriviaService | null
  /** HMAC key for passphrase hashing. Null disables the passphrase route. */
  passphraseSalt: string | null
}

const CREATE_DROP_SCOPE = 'POST /api/drops'

export function makeApp(deps: AppDeps): Hono {
  const { pool, chain } = deps
  const now = deps.now ?? Date.now
  const limits: RateLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const clientIp: ClientIpResolver = deps.clientIp ?? (() => SHARED_BUCKET)
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

  const gates = deps.gates ?? null

  /**
   * Attempts at a condition, per IP.
   *
   * Every gate route does real work before it can refuse: a passphrase submission
   * runs an HMAC, an attestation runs an Ed25519 verify, a session start runs an
   * HMAC selection and a transaction. Unlike a claim there is no signature to
   * make an attacker pay for the privilege, so this bucket is the only thing
   * between the routes and a CPU-bound flood. Per-IP rather than per-address,
   * because the address is client-asserted and an attacker would simply vary it.
   */
  //
  // Sized from what ONE honest session costs, which is not the claim budget. A
  // five-question session is eleven requests through here: one start, then a read
  // and a submit per question. Reusing `claimsPerWalletPerWindow` (5) meant a
  // player was rate-limited out of their own game at question three — caught by an
  // API test that could not finish a session, not by review.
  //
  // GATE_REQUESTS_PER_SESSION is that arithmetic written down, so a change to the
  // question count moves the limit with it instead of silently re-breaking this.
  const gateAttemptBucket = new TokenBuckets(
    GATE_REQUESTS_PER_SESSION * limits.gateSessionsPerWindow,
    limits.windowMs,
    now,
  )

  function requireGates(): GateServices {
    if (!gates) throw new HttpError(404, 'not_found', 'this deployment has no gated drops')
    return gates
  }

  function requireTrivia(): TriviaService {
    const service = requireGates().trivia
    if (!service) {
      throw new HttpError(404, 'not_found', 'this deployment does not serve question games')
    }
    return service
  }

  function requirePassphraseSalt(): string {
    const salt = requireGates().passphraseSalt
    if (!salt) {
      throw new HttpError(404, 'not_found', 'this deployment does not serve passphrase games')
    }
    return salt
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

  // ---- gates: meeting a drop's condition ---------------------------------------------------
  //
  // None of these routes takes a wallet signature, and that is the design rather
  // than an omission (spec §4.5): a grant names an address but only ever benefits
  // the holder of that address, because `reserveClaim` compares it against the
  // address derived from the claim signature. Asking for a signature here would
  // cost the player a native wallet prompt before they had received anything.
  //
  // What that leaves is read-side disclosure, which is real and worth naming: the
  // session route tells anyone who asks whether a given address has already
  // played or won a given drop. It is not a money hole, and it is not fixable
  // without the prompt the flow declines to ask for.

  // ---- GET /api/games ----------------------------------------------------------------------

  /**
   * Listed, gated, live drops. Answers even with no gates configured, because an
   * empty catalogue is a truthful answer and a 404 here would look like an outage.
   */
  app.get('/api/games', async (c) => {
    if (!gates) return c.json({ games: [] })
    return c.json({ games: await listGames(pool) })
  })

  // ---- GET /api/games/:publicId ------------------------------------------------------------

  /**
   * One game, plus whether a given wallet has already met its condition.
   *
   * Returns a NAMED field set and never `drop_gates.config`, which holds the
   * passphrase hash for one kind and the attester key for another. `wallet` is an
   * optional query parameter; without it `granted` is false rather than unknown,
   * because the page that has no wallet yet cannot act on the difference.
   */
  app.get('/api/games/:publicId', async (c) => {
    const publicId = requirePublicId(c)
    requireGates()
    const view = await loadGameView(pool, publicId)
    const wallet = c.req.query('wallet')
    // An absent OR invalid wallet reads as `granted: false` rather than 400,
    // unchanged: this route answers a page that may not have a wallet yet, and a
    // page that cannot act on the difference should not be handed an error. What
    // did change is that the lookup now uses the NORMALISED address, so a spaced
    // and a compacted spelling of one wallet no longer disagree about its grant.
    const address = wallet === undefined ? null : normaliseNimiqAddress(wallet)
    const granted =
      address === null
        ? false
        : await hasGrant(pool, (await loadGate(pool, publicId)).dropId, address)
    return c.json({ ...view, granted })
  })

  // ---- POST /api/games/:publicId/session ---------------------------------------------------

  app.post('/api/games/:publicId/session', async (c) => {
    const publicId = requirePublicId(c)
    const body = await readJsonObject(c)
    only(body, ['walletAddress'])
    const walletAddress = requireWalletAddress(body)
    enforce(gateAttemptBucket, clientIp(c))

    const gate = await loadGate(pool, publicId)
    const started = await requireTrivia().startOrResume(gate, walletAddress)
    return c.json(started)
  })

  // ---- GET /api/games/:publicId/session/:sessionId/question --------------------------------

  app.get('/api/games/:publicId/session/:sessionId/question', async (c) => {
    const publicId = requirePublicId(c)
    const sessionId = requireSessionId(c)
    const walletAddress = requireWalletQuery(c)
    // Metered like the other gate routes. It looked like a read, but it opens a
    // transaction, locks the session row, writes delivery state and reads the
    // bank — the same work the routes either side of it pay for.
    enforce(gateAttemptBucket, clientIp(c))
    // All THREE identifiers are honoured. Without the drop id a session belonging
    // to one drop could be played through another drop's URL; without the wallet,
    // a leaked session id alone was enough to drive somebody else's session.
    const gate = await loadGate(pool, publicId)
    const question = await requireTrivia().currentQuestion(sessionId, gate.dropId, walletAddress)
    // Note what is NOT here: no answer index, no per-question correctness, no
    // score. See `AnswerOutcome` in `gates/trivia/sessions.ts` for why.
    return c.json({ ...question, deadlineAt: question.deadlineAt.toISOString() })
  })

  // ---- POST /api/games/:publicId/session/:sessionId/answer ---------------------------------

  app.post('/api/games/:publicId/session/:sessionId/answer', async (c) => {
    const publicId = requirePublicId(c)
    const sessionId = requireSessionId(c)
    const body = await readJsonObject(c)
    only(body, ['questionIndex', 'answerIndex', 'walletAddress'])
    const questionIndex = wholeNumberIn(body, 'questionIndex', 0, 9)
    const answerIndex = wholeNumberIn(body, 'answerIndex', 0, 3)
    // Required, for the reason in `requireWalletQuery`: a wrong answer costs the
    // session's wallet a ten-minute cooldown, so submitting one must take more
    // than a session id somebody left in a log.
    const walletAddress = requireWalletAddress(body)
    enforce(gateAttemptBucket, clientIp(c))
    const gate = await loadGate(pool, publicId)
    return c.json(
      await requireTrivia().submitAnswer(
        sessionId,
        questionIndex,
        answerIndex,
        gate.dropId,
        walletAddress,
      ),
    )
  })

  // ---- POST /api/games/:publicId/passphrase ------------------------------------------------

  app.post('/api/games/:publicId/passphrase', async (c) => {
    const publicId = requirePublicId(c)
    const body = await readJsonObject(c)
    only(body, ['walletAddress', 'phrase'])
    const walletAddress = requireWalletAddress(body)
    const phrase = requirePhrase(body)
    enforce(gateAttemptBucket, clientIp(c))

    const gate = await loadGate(pool, publicId)
    return c.json(
      await submitPassphrase(pool, { gate, walletAddress, phrase, salt: requirePassphraseSalt() }),
    )
  })

  // ---- POST /api/games/:publicId/attestation -----------------------------------------------

  /**
   * A third party confirming that a wallet met their condition.
   *
   * The body carries a message and a signature and NO address: the beneficiary is
   * named inside the signed bytes, so there is nothing here for a request to
   * substitute. `only()` refuses an unexpected `walletAddress` field outright
   * rather than ignoring it, so a client that thinks it can nominate one is told
   * it cannot.
   */
  app.post('/api/games/:publicId/attestation', async (c) => {
    const publicId = requirePublicId(c)
    const body = await readJsonObject(c)
    only(body, ['message', 'signature'])
    const message = requireAttestationMessage(body)
    const signatureHex = matching(body, 'signature', SIGNATURE_RE)
    enforce(gateAttemptBucket, clientIp(c))

    requireGates()
    const gate = await loadGate(pool, publicId)
    return c.json(await submitAttestation(pool, { gate, message, signatureHex }))
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
  // Unlike claim and funding refusals, gate refusals do not share one status:
  // a locked tier is a 403, a cooldown is a 429, an unknown session is a 404,
  // and a misconfigured drop is the one 5xx. See GATE_STATUS.
  if (err instanceof GateRejectedError) {
    return new HttpError(
      GATE_STATUS[err.code] ?? 409,
      err.code,
      GATE_MESSAGES[err.code] ?? 'this condition cannot be completed',
    )
  }
  if (err instanceof CapError) return invalidRequest(err.message)
  // Capacity refusals come BEFORE the generic `CapExceededError` line below, on
  // purpose. They are the only money-shaped refusal a sponsor meets before they
  // have paid anything, and "temporarily unavailable" would be both vaguer and,
  // for a drop that is simply too big, wrong: no amount of retrying helps.
  // The numbers are read off the error rather than forwarded as prose, so the
  // client copy stays this file's to choose (see the CLAIM_MESSAGES note).
  if (err instanceof DropTooLargeError) {
    const max = formatNim(err.capacity.maxLivePrincipalLuna)
    return new HttpError(
      422,
      'drop_too_large',
      `this pilot holds up to ${max} NIM across all live drops — try a smaller total`,
    )
  }
  if (err instanceof NoHeadroomError) {
    const free = formatNim(err.capacity.remainingLuna)
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
