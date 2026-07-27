/**
 * The sponsor's early close, client side (server: `services/close.ts`).
 *
 * Three commitments, and they are the claim machine's commitments read from the
 * other side of the link:
 *
 *  1. **Only the server says a drop is closed.** This module sends a signature
 *     and reports what it is told. It never predicts the outcome, and it never
 *     says a refund has arrived — the 202 means the refund is queued, exactly as
 *     a claim's 202 means a share is reserved.
 *  2. **Irreversible is said before, not after.** The confirm step is a screen,
 *     not a toast: the page names what closing does to the sponsor's money AND
 *     what it does to everyone holding the link, and only then offers a button.
 *  3. **Every refusal has a name.** Wrong wallet, already closed, never funded
 *     and "we could not check that approval" are four different facts, and a
 *     sponsor who cannot tell them apart cannot act on any of them.
 *
 * ---
 *
 * **Why the two calls are here and not in `api.ts`.** They belong there, beside
 * every other endpoint, and this module exists only because `api.ts` was being
 * edited concurrently when this shipped. Folding `requestCloseChallenge` and
 * `closeDrop` into `api.ts` — and deleting the `postJson` below in favour of its
 * `request` — is a mechanical follow-up with no behavioural component. The error
 * envelope is deliberately re-thrown as the SAME `ApiError` that file exports,
 * so nothing downstream can tell the difference in the meantime.
 */
import { ApiError, NetworkError, type Challenge } from '../api'

/** Same-origin: the API, the SSR campaign pages and the SPA share one host. */
const BASE = '/api'

/** `POST /api/drops/:publicId/close` — 202: the drop is closed, the refund is queued. */
export interface CloseAccepted {
  /** Shares that were already reserved. These are still paid, in full. */
  claimedShares: number
  /** Shares nobody took. Their value is what comes back. */
  unclaimedShares: number
  /** Decimal NIM heading back to the funding wallet, e.g. `"7.5"`. */
  refund: string
  refundLuna: string
}

export interface SignedClose {
  challengeId: string
  publicKey: string
  signature: string
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new NetworkError(cause)
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new ApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'unknown',
      typeof error?.message === 'string' ? error.message : 'something went wrong',
    )
  }
  return parsed as T
}

/**
 * The exact bytes the funding wallet must sign to authorize ONE close of ONE
 * drop. A separate endpoint from the claim challenge, because it authorizes a
 * different action and the server refuses to let either stand in for the other.
 */
export function requestCloseChallenge(publicId: string): Promise<Challenge> {
  return postJson<Challenge>(`/drops/${encodeURIComponent(publicId)}/close/challenge`, {})
}

export function closeDrop(publicId: string, signed: SignedClose): Promise<CloseAccepted> {
  return postJson<CloseAccepted>(`/drops/${encodeURIComponent(publicId)}/close`, signed)
}

/**
 * The one sentence to show for a refused close.
 *
 * The server's own message is used wherever it has one, for the same reason the
 * disclosure text is not rewritten here: it enforces the rule, so it owns the
 * words. This table only covers what the server cannot know — the network being
 * gone, and the wallet being closed without approving.
 */
export function closeFailureNotice(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof NetworkError) return 'We could not reach NimDrops just now. Nothing changed.'
  return 'Something went wrong and the drop was not closed.'
}
