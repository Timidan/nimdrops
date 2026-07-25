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
