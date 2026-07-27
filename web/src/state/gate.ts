/**
 * What a drop asks of a wallet before it will pay that wallet.
 *
 * This hook reads `GET /api/games/:publicId` and nothing else. It is
 * deliberately kind-agnostic: it reports which kind the drop carries and
 * whether this wallet has already satisfied it, and the page decides what to
 * render. Adding a fourth kind should not touch this file.
 *
 * `granted` is the field the whole flow turns on. A wallet that already holds a
 * grant has nothing left to do here, so the page can hand it straight to the
 * claim screen — which is the entire player-facing path for `attested`, where a
 * third party did the work and the player never had a step at all.
 *
 * Nothing here is a money endpoint. The gate routes take no signature by
 * design: a grant names an address, and `reserveClaim` compares that address
 * against the one derived from the claim signature, so a condition satisfied
 * under somebody else's address is worthless to whoever satisfied it. That is
 * also why `walletAddress` may be an address the player simply typed.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getGame, type GameView, type GateKind } from '../api'

/**
 * A Nimiq user-friendly address, mirroring `ADDRESS_RE` in
 * `server/src/http/app.ts`. `NQ` and 34 base-32 characters, conventionally
 * printed in groups of four, so the spaces are optional and the length is a
 * range rather than a number.
 */
export const ADDRESS_RE = /^NQ[0-9A-Z ]{34,44}$/i

/**
 * A mirror of `MAX_ATTEMPTS` in `server/src/gates/passphrase.ts`.
 *
 * The server counts wrong guesses per address per drop and does NOT return the
 * tally, so a screen that has to say how many tries are left has only the cap to
 * work from. The server stays the authority: when it refuses, its own sentence
 * is what gets shown.
 */
export const PASSPHRASE_MAX_ATTEMPTS = 5

export interface GateController {
  kind: GateKind | null
  /** Trivia difficulty; null for a kind with no tiers, and while loading. */
  tier: string | null
  /** Luna, as a string. `BigInt()` it — never `Number()`. */
  amountEachLuna: string | null
  slotsRemaining: number | null
  /** The sponsor's public hint for `passphrase`; null for every other kind. */
  hint: string | null
  /** True only when a wallet was named AND that wallet holds a grant. */
  granted: boolean
  loading: boolean
  /** The server's own sentence, shown as written. */
  error: string | null
  /**
   * The envelope's `error.code`. Screens branch on this and never on `error`,
   * which is the rule `api.ts` sets for every other endpoint — a link to a drop
   * that carries no condition is a different screen from a network blip, and
   * only the code tells them apart.
   */
  errorCode: string | null
  /**
   * Ask again. `attested` needs it: a third party satisfies that condition out
   * of band, so without a re-read the "not yet" screen has no path forward
   * inside the session it is being read in.
   */
  refresh: () => void
}

export function useGate(publicId: string, walletAddress?: string): GateController {
  const [game, setGame] = useState<GameView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getGame(publicId, walletAddress)
      .then((next) => {
        if (cancelled) return
        setGame(next)
        setError(null)
        setErrorCode(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError) {
          setError(err.message)
          setErrorCode(err.code)
          return
        }
        // Offline, DNS, TLS, abort: the network, not the drop.
        setError('We could not reach NimDrops just now.')
        setErrorCode('network')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce, publicId, walletAddress])

  return {
    kind: game?.kind ?? null,
    tier: game?.tier ?? null,
    amountEachLuna: game?.amountEachLuna ?? null,
    slotsRemaining: game?.slotsRemaining ?? null,
    hint: game?.hint ?? null,
    granted: game?.granted === true,
    loading,
    error,
    errorCode,
    refresh,
  }
}
