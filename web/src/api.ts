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
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** A request that never reached the server (offline, DNS, TLS, abort). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the network request did not complete', { cause })
    this.name = 'NetworkError'
  }
}

function envelopeOf(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : 'unknown'
  const message = typeof error?.message === 'string' ? error.message : 'something went wrong'
  return new ApiError(status, code, message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: { ok: boolean; status: number; json: () => Promise<unknown> }
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
  if (!response.ok) throw envelopeOf(response.status, body)
  return body as T
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
  return request<Draft>('/drops', {
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
