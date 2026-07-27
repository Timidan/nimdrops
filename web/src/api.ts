/**
 * The only place `web/` talks to the server (design §11: six endpoints + /health).
 *
 * Two rules:
 *
 *  1. **Money stays textual.** `amountEach` and `expectedFundingLuna` arrive as
 *     strings and leave as strings. Nothing here calls `Number()` on a luna or
 *     NIM value; callers that need arithmetic use `BigInt(...)`.
 *  2. **Every failure is one type.** The server answers with a single envelope,
 *     `{ error: { code, message } }`, so every non-2xx becomes an `ApiError`
 *     carrying that code. Screens branch on the code, never on a message string.
 */

/** Same-origin: the API, the SSR campaign pages and the SPA share one host. */
const BASE = '/api'

export type DropState =
  | 'awaiting_funding'
  | 'funding_pending'
  | 'live'
  | 'closing'
  | 'settled'
  | 'refunded'
  | 'paused'
  | 'manual_review'
  | 'cancelled'

/**
 * One line of the custody disclosure, as the server wrote it.
 *
 * The text is never rewritten here. The server enforces the caps, holds the
 * key and knows the chain, so it owns the sentences that describe them —
 * anything this client paraphrased could drift away from what is actually
 * enforced. `id` is stable, so a screen can style or test one point without
 * matching prose.
 */
export interface DisclosurePoint {
  id: string
  text: string
}

/** The live ceiling. NIM strings are for display; luna strings for arithmetic. */
export interface PilotLimits {
  perDropMax: string
  perDropMaxLuna: string
  aggregateMax: string
  aggregateMaxLuna: string
  remaining: string
  remainingLuna: string
  /** `null` when only the principal cap applies. */
  maxLiveDrops: number | null
  liveDrops: number
  reservedDrafts: number
  remainingDrops: number | null
}

/** `GET /api/custody`, and the same object on the `POST /api/drops` 201. */
export interface CustodyDisclosure {
  network: string
  chainLabel: string
  custodyAddress: string
  mainnetPilot: boolean
  /** Funding is closed while this is true. */
  paused: boolean
  expiryHours: number
  /** Minutes a draft holds its room in the aggregate cap. */
  fundingWindowMinutes: number
  limits: PilotLimits
  /** One line for the space beside the fund button. */
  summary: string
  /** Every point, in reading order. All of them go above the fund button. */
  points: DisclosurePoint[]
}

/** `POST /api/drops` — funding instructions for an unfunded draft. */
export interface Draft {
  publicId: string
  fundingAddress: string
  /** Exactly `ND1:<publicId>`; the wallet must send this memo verbatim. */
  fundingMemo: string
  /** Decimal NIM, for display. */
  expectedFunding: string
  /** The same amount in luna, as a string. `BigInt()` it for the wallet call. */
  expectedFundingLuna: string
  shareUrl: string
  /**
   * When this draft stops holding room in the aggregate cap, or `null` when it
   * holds none. Optional in the type because a record stored by an older build
   * will not carry it.
   */
  reservationExpiresAt?: string | null
  /**
   * The disclosure that applied to THIS drop, read inside the same transaction
   * that reserved its room. Absent only when the body could not be read.
   */
  disclosure?: CustodyDisclosure
}

/** `GET /api/drops/:publicId` — the public projection; no claimant data. */
export interface DropPublic {
  publicId: string
  sponsorLabel: string
  message: string | null
  amountEach: string
  claimCount: number
  remaining: number
  state: DropState
  expiresAt: string | null
  fundingTxHash?: string
}

/** `POST /api/drops/:publicId/challenge` — the exact bytes the wallet signs. */
export interface Challenge {
  challengeId: string
  /** Sign this verbatim. Deriving or re-encoding it makes the signature invalid. */
  message: string
  expiresAt: string
}

/**
 * The claim lifecycle as the SERVER tells it. `sending` means a transaction has
 * been signed and broadcast, which is emphatically not `paid`.
 */
export type ClaimServerState = 'reserved' | 'sending' | 'confirming' | 'paid' | 'manual_review'

/** `POST /api/drops/:publicId/claims` — 202: a slot is reserved, nothing is paid. */
export interface ClaimAccepted {
  claimId: string
  /** Opaque bearer credential. Header only — never a URL, never a log line. */
  statusToken: string
  state: ClaimServerState
}

/** `GET /api/claims/:claimId` — the only source of payment truth. */
export interface ClaimStatus {
  state: ClaimServerState
  /** Present only once an attempt is confirmed on chain. */
  txHash?: string
  amountEach: string
}

export interface SignedClaim {
  challengeId: string
  publicKey: string
  signature: string
}

/**
 * `GET /api/stats` — the public aggregates the landing page reads.
 *
 * `server/src/services/stats.ts` owns which figures may appear and why. The one
 * rule that reaches this far: **an absent figure is not a zero.** A statistic
 * this deployment cannot measure is named in `unavailable` and carries no value,
 * so a client that substituted `0` would be publishing a number nobody computed.
 * Every field is therefore optional on this side too, and {@link asStats} drops
 * anything whose type is wrong rather than coercing it.
 */
export interface StatsFigures {
  /** Settled payouts, exact decimal NIM. Display only; never parsed as a float. */
  totalPaidOut?: string
  /** The same amount in luna. `BigInt()` this one for arithmetic. */
  totalPaidOutLuna?: string
  uniqueWalletsPaid?: number
  dropsFunded?: number
  sharesClaimed?: number
  /** Absent until the trivia migration lands `trivia_answers`. */
  questionsAnswered?: number
}

export interface PublicStats {
  /** When the figures were computed, ISO 8601. Not the time of the request. */
  generatedAt: string
  stats: StatsFigures
  /** Keys this deployment knows about and cannot currently measure. */
  unavailable: string[]
}

/** Every figure the landing page knows how to render, in the order it renders them. */
export type StatKey = keyof StatsFigures

export interface CreateDropInput {
  sponsorLabel: string
  message?: string
  /** Decimal NIM per person, e.g. `"2.5"`. */
  amountEach: string
  claimCount: number
}

export class ApiError extends Error {
  readonly status: number
  /** The envelope's `error.code` — the only thing screens are allowed to branch on. */
  readonly code: string
  /** `Retry-After`, in seconds, when the server said how long to wait. */
  readonly retryAfterSeconds?: number
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}

/** A request that never reached the server (offline, DNS, TLS, abort). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the network request did not complete', { cause })
    this.name = 'NetworkError'
  }
}

function envelopeOf(status: number, body: unknown, retryAfterSeconds?: number): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : 'unknown'
  const message = typeof error?.message === 'string' ? error.message : 'something went wrong'
  return new ApiError(status, code, message, retryAfterSeconds)
}

interface HttpResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  /** Optional: a stubbed response in a test need not carry headers. */
  headers?: { get?: (name: string) => string | null }
}

/**
 * `Retry-After` in seconds, when the server sent a usable one.
 *
 * Read defensively rather than assumed: the header is optional, its delta-seconds
 * form is the only one this API sends, and a screen that turned a missing header
 * into `NaN seconds` would be worse than one that simply says "try again".
 */
function retryAfterOf(response: HttpResponse): number | undefined {
  const raw = response.headers?.get?.('retry-after')
  if (typeof raw !== 'string') return undefined
  const seconds = Number.parseInt(raw, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: HttpResponse
  try {
    response = await fetch(`${BASE}${path}`, init)
  } catch (cause) {
    throw new NetworkError(cause)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) throw envelopeOf(response.status, body, retryAfterOf(response))
  return body as T
}

// ---- the custody disclosure ------------------------------------------------------

function isLimits(value: unknown): value is PilotLimits {
  const l = value as Partial<PilotLimits> | null
  const nullableNumber = (n: unknown) => n === null || typeof n === 'number'
  return (
    typeof l?.perDropMax === 'string' &&
    typeof l.perDropMaxLuna === 'string' &&
    typeof l.aggregateMax === 'string' &&
    typeof l.aggregateMaxLuna === 'string' &&
    typeof l.remaining === 'string' &&
    typeof l.remainingLuna === 'string' &&
    nullableNumber(l.maxLiveDrops) &&
    typeof l.liveDrops === 'number' &&
    typeof l.reservedDrafts === 'number' &&
    nullableNumber(l.remainingDrops)
  )
}

/**
 * A disclosure, or `null` if the body is not one.
 *
 * The one place in this file that inspects a shape instead of trusting it.
 * Everything else here is read by a screen that would show a wrong number at
 * worst; a half-parsed disclosure would show a *missing* point, and a sponsor
 * who was never told the operator holds the key has not been disclosed to. So
 * the shape either arrives whole or the screen falls back to copy it ships with.
 */
export function asDisclosure(value: unknown): CustodyDisclosure | null {
  const d = value as Partial<CustodyDisclosure> | null
  if (!d || typeof d !== 'object') return null
  if (!Array.isArray(d.points) || d.points.length === 0) return null
  if (!d.points.every((p) => typeof p?.id === 'string' && typeof p?.text === 'string')) return null
  if (typeof d.summary !== 'string' || typeof d.paused !== 'boolean') return null
  if (typeof d.custodyAddress !== 'string' || typeof d.chainLabel !== 'string') return null
  if (typeof d.expiryHours !== 'number' || typeof d.fundingWindowMinutes !== 'number') return null
  if (!isLimits(d.limits)) return null
  return d as CustodyDisclosure
}

/**
 * What the sponsor must read before their wallet asks them to approve anything.
 * Unauthenticated and cheap, so the create screen asks for it on first paint.
 */
export async function getCustody(): Promise<CustodyDisclosure> {
  const parsed = asDisclosure(await request<unknown>('/custody'))
  if (!parsed) throw new ApiError(200, 'unreadable_disclosure', 'the custody disclosure could not be read')
  return parsed
}

// ---- the public statistics -------------------------------------------------------

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asMoney(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Normalise a `/api/stats` body, or return `null` if it is not one.
 *
 * Field by field rather than all-or-nothing, which is the opposite of
 * {@link asDisclosure} and deliberately so. A half-read disclosure would mean a
 * sponsor was never told something; a figure this build does not recognise is
 * just a figure it does not draw, and the endpoint is explicitly forward
 * compatible about that. So a malformed `sharesClaimed` costs its own row and
 * nothing else — and costs it by becoming ABSENT, which the page renders as
 * "not measured yet" rather than as zero.
 */
export function asStats(value: unknown): PublicStats | null {
  const body = value as Partial<PublicStats> | null
  if (!body || typeof body !== 'object') return null
  if (typeof body.generatedAt !== 'string' || Number.isNaN(Date.parse(body.generatedAt))) return null

  const raw = (body.stats ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null) return null

  const stats: StatsFigures = {}
  const paidOut = asMoney(raw.totalPaidOut)
  if (paidOut !== undefined) stats.totalPaidOut = paidOut
  const paidOutLuna = asMoney(raw.totalPaidOutLuna)
  if (paidOutLuna !== undefined) stats.totalPaidOutLuna = paidOutLuna
  const wallets = asCount(raw.uniqueWalletsPaid)
  if (wallets !== undefined) stats.uniqueWalletsPaid = wallets
  const drops = asCount(raw.dropsFunded)
  if (drops !== undefined) stats.dropsFunded = drops
  const shares = asCount(raw.sharesClaimed)
  if (shares !== undefined) stats.sharesClaimed = shares
  const answered = asCount(raw.questionsAnswered)
  if (answered !== undefined) stats.questionsAnswered = answered

  return {
    generatedAt: body.generatedAt,
    stats,
    unavailable: Array.isArray(body.unavailable)
      ? body.unavailable.filter((key): key is string => typeof key === 'string')
      : [],
  }
}

/**
 * The aggregates, or a throw. Unauthenticated, cached hard on the server, and
 * the only endpoint on this client that a page is allowed to render nothing for.
 */
export async function getStats(): Promise<PublicStats> {
  const parsed = asStats(await request<unknown>('/stats'))
  if (!parsed) throw new ApiError(200, 'unreadable_stats', 'the statistics could not be read')
  return parsed
}

// ---- idempotency ---------------------------------------------------------------

const IDEM_PREFIX = 'nimdrops.idem.create:'

/**
 * One `Idempotency-Key` per *draft attempt*, where the attempt is identified by
 * the draft's contents.
 *
 * Retrying the same draft (the network blipped, the user tapped twice) must
 * replay the draft the server already made, so the key has to survive a reload:
 * `sessionStorage`. Changing any field means a genuinely different request, and
 * reusing the key there would earn a `409` from the server's request-hash check
 * — so a changed draft mints a new key.
 */
function idempotencyKey(input: CreateDropInput): string {
  const scope =
    IDEM_PREFIX +
    JSON.stringify([input.sponsorLabel, input.message ?? '', input.amountEach, input.claimCount])
  try {
    const existing = sessionStorage.getItem(scope)
    if (existing) return existing
    const minted = crypto.randomUUID()
    sessionStorage.setItem(scope, minted)
    return minted
  } catch {
    // Private-mode storage denial: a fresh key still works, it just cannot be
    // replayed after a reload.
    return crypto.randomUUID()
  }
}

/**
 * Forget every remembered draft attempt in this tab.
 *
 * Called at exactly one moment: the sponsor has funded a drop and is
 * deliberately starting another. Every key still in the tab at that point has
 * been spent (its draft is funded) or abandoned, and replaying a spent draft
 * would hand the wallet a funding request for a drop that is already live —
 * a second real transaction the server would then refuse. A new drop gets a
 * new key.
 *
 * Anywhere else, the keys must survive: that is what makes a retried create
 * replay one draft instead of minting two.
 */
export function forgetDraftKeys(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(IDEM_PREFIX)) sessionStorage.removeItem(key)
    }
  } catch {
    /* nothing to undo */
  }
}

// ---- endpoints -------------------------------------------------------------------

export async function createDrop(input: CreateDropInput): Promise<Draft> {
  const draft = await request<Draft>('/drops', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey(input),
    },
    body: JSON.stringify({
      sponsorLabel: input.sponsorLabel,
      ...(input.message ? { message: input.message } : {}),
      amountEach: input.amountEach,
      claimCount: input.claimCount,
    }),
  })
  // The draft's own disclosure and reservation are held to the same standard as
  // `/custody`: whole, or absent. A screen may show neither, never half of one.
  const disclosure = asDisclosure(draft.disclosure)
  return {
    ...draft,
    reservationExpiresAt:
      typeof draft.reservationExpiresAt === 'string' ? draft.reservationExpiresAt : null,
    ...(disclosure ? { disclosure } : { disclosure: undefined }),
  }
}

/**
 * Hand the server the transaction the wallet reported. The endpoint is
 * idempotent by construction (a drop holds at most one funding hash for its
 * whole life), so a repeat submit of the same hash is safe and expected.
 */
export async function submitFunding(publicId: string, txHash: string): Promise<DropPublic> {
  return request<DropPublic>(`/drops/${encodeURIComponent(publicId)}/funding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash }),
  })
}

export async function getDrop(publicId: string): Promise<DropPublic> {
  return request<DropPublic>(`/drops/${encodeURIComponent(publicId)}`)
}

/**
 * Mint a one-use claim message. Short-lived by construction, so it is requested
 * at the moment of the tap — never on page load, where it would expire while
 * the claimant reads the card.
 */
export async function issueChallenge(publicId: string): Promise<Challenge> {
  return request<Challenge>(`/drops/${encodeURIComponent(publicId)}/challenge`, { method: 'POST' })
}

/**
 * Reserve one share. The idempotency key belongs to the caller because the
 * caller is the only one who knows whether a retry is "the same signed request
 * again" (safe to replay) or a genuinely new attempt.
 */
export async function submitClaim(
  publicId: string,
  signed: SignedClaim,
  idempotencyKey: string,
): Promise<ClaimAccepted> {
  return request<ClaimAccepted>(`/drops/${encodeURIComponent(publicId)}/claims`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      challengeId: signed.challengeId,
      publicKey: signed.publicKey,
      signature: signed.signature,
    }),
  })
}

/** Design §11: the status token travels as a bearer header, never in the path. */
export async function getClaimStatus(claimId: string, statusToken: string): Promise<ClaimStatus> {
  return request<ClaimStatus>(`/claims/${encodeURIComponent(claimId)}`, {
    headers: { Authorization: `Bearer ${statusToken}` },
  })
}
