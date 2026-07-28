/**
 * The claim state machine (design §4.3, §4.4).
 *
 * Three commitments shape this file:
 *
 *  1. **Only the server says "paid".** A 202 reserves a slot; the transfer
 *     worker signs, broadcasts and confirms. The hook therefore never invents a
 *     terminal state — it polls `GET /api/claims/:claimId` and reports what it
 *     is told. `sending` (broadcast) is displayed as *confirming*, because a
 *     broadcast transaction is not money in a wallet yet.
 *  2. **A reload must not orphan a claim.** The opaque status token is written
 *     to `localStorage` keyed by the drop, so a refresh — or a return trip from
 *     the wallet app — resumes polling the SAME claim instead of minting a
 *     second challenge.
 *  3. **Every refusal has a name.** Exhausted, expired, paused and degraded are
 *     different facts with different honest sentences; collapsing them into
 *     "something went wrong" would leave a claimant unable to tell "you were
 *     too late" from "we are having a bad minute".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  getClaimStatus,
  getDrop,
  issueChallenge,
  submitClaim,
  type ClaimServerState,
  type DropPublic,
} from '../api'
import { resolveBridge, type BridgeResult } from '../sdk/adapter'

/**
 * Nimiq Watch is the canonical Nimiq block explorer; its testnet instance lives
 * on the `test.` subdomain, and both route by URL fragment (`/#<hash>`).
 *
 * This is a build-time constant on purpose. The web bundle has no business
 * probing which network it is on — the server owns `NIMIQ_NETWORK` — so the
 * value is hardcoded here and flipped by `VITE_NIMIQ_NETWORK` at build time.
 * It defaults to the testnet explorer: pointing a testnet receipt at the
 * mainnet explorer would show a claimant an empty page for a real payment.
 */
export const EXPLORER_BASE =
  import.meta.env.VITE_NIMIQ_NETWORK === 'MainAlbatross'
    ? 'https://nimiq.watch'
    : 'https://test.nimiq.watch'

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/#${txHash}`
}

/**
 * Every screen the claim flow can be on. There is deliberately no
 * `manual_review` member: a review means "we hold your slot and a human is
 * looking", which is still in flight, so it displays as `confirming` with the
 * raw `serverState` carrying the reason for the copy.
 *
 * `awaiting-funding` is its own member rather than a flavour of `loading`
 * because the two are different facts. `loading` means "we are fetching, this
 * ends in a moment". A drop in `awaiting_funding` has no funding transaction
 * anywhere — the sponsor has not paid — so nothing is in flight and nothing is
 * guaranteed to end. Displaying that as a spinner under a dead claim button is
 * how a shared link to an unfunded campaign comes to look broken.
 *
 * `closed` is separate from `expired` for the same reason: no deadline passed
 * and no share was taken by someone faster — the sponsor ended their own drop.
 * Saying "its claim window is up" there would be a plain untruth, and it is the
 * one screen where the reader might otherwise wonder whether they were slow.
 */
export type ClaimUiState =
  | 'loading'
  | 'awaiting-funding'
  | 'no-wallet'
  | 'ready'
  | 'signing'
  | 'reserved'
  | 'confirming'
  | 'paid'
  | 'rejected'
  | 'exhausted'
  | 'expired'
  | 'closed'
  | 'degraded'
  | 'paused'

/** `nimdrops.claim:<publicId>` → `{ claimId, statusToken }`. */
export const CLAIM_STORAGE_PREFIX = 'nimdrops.claim:'

/** Slow enough to be polite to the API, fast enough to feel live. */
export const CLAIM_POLL_MS = 2500

export interface UseClaimOptions {
  /** Test seam; production uses the real provider discovery. */
  discoverBridge?: () => Promise<BridgeResult>
  pollMs?: number
}

export interface ClaimController {
  state: ClaimUiState
  drop: DropPublic | null
  /** The server's own word, kept so `manual_review` can be said out loud. */
  serverState: ClaimServerState | null
  txHash: string | null
  /** Decimal NIM per share, from the drop or from the claim receipt. */
  amountEach: string | null
  /** One honest sentence for the recoverable states; empty otherwise. */
  notice: string
  claim: () => Promise<void>
  retry: () => void
}

interface StoredClaim {
  claimId: string
  statusToken: string
}

function storageKey(publicId: string): string {
  return `${CLAIM_STORAGE_PREFIX}${publicId}`
}

function readStored(publicId: string): StoredClaim | null {
  try {
    const raw = localStorage.getItem(storageKey(publicId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredClaim>
    if (typeof parsed?.claimId !== 'string' || typeof parsed?.statusToken !== 'string') return null
    return { claimId: parsed.claimId, statusToken: parsed.statusToken }
  } catch {
    // Private mode, quota, or a hand-edited value: treat as "no claim here".
    return null
  }
}

function writeStored(publicId: string, claim: StoredClaim): void {
  try {
    localStorage.setItem(storageKey(publicId), JSON.stringify(claim))
  } catch {
    // Storage denial costs resume-after-reload, not the claim in progress.
  }
}

function clearStored(publicId: string): void {
  try {
    localStorage.removeItem(storageKey(publicId))
  } catch {
    /* nothing to undo */
  }
}

/** What the public drop projection means for someone who wants to claim. */
export function stateForDrop(drop: DropPublic): ClaimUiState {
  if (drop.closingReason === 'closed_by_sponsor') return 'closed'
  if (drop.closingReason === 'exhausted') return 'exhausted'
  switch (drop.state) {
    case 'awaiting_funding':
      // No funding transaction exists. Not a refusal and not a wait with a
      // known end: say so, and keep asking in case the sponsor pays.
      return 'awaiting-funding'
    case 'funding_pending':
      // A funding transaction is on the network and confirming. This one does
      // resolve on its own, so it stays a wait.
      return 'loading'
    case 'paused':
    case 'manual_review':
      return 'paused'
    case 'live':
      return drop.remaining > 0 ? 'ready' : 'exhausted'
    case 'settled':
      return drop.remaining === 0 ? 'exhausted' : 'expired'
    case 'closing':
    case 'refunded':
      return drop.remaining === 0 ? 'exhausted' : 'expired'
    default:
      return 'expired'
  }
}

function uiForServer(state: ClaimServerState): ClaimUiState {
  switch (state) {
    case 'reserved':
      return 'reserved'
    case 'paid':
      return 'paid'
    // `sending` is a broadcast, `manual_review` is a held slot. Both are
    // "still coming", and neither is ever displayed as paid.
    default:
      return 'confirming'
  }
}

/**
 * Pre-claim states whose truth is the drop projection, so they keep asking:
 * a drop still being funded goes live on its own, and a remaining count falls
 * while the claimant reads the card. `awaiting-funding` is here for the same
 * reason — it is the whole promise of that screen, which says the page will
 * become claimable by itself the moment the sponsor's funding lands.
 *
 * `degraded` is NOT here. Degradation is a fact about the money path (a 503
 * from the challenge or claim endpoint), and a drop projection that reads fine
 * is not evidence that payouts resumed — silently re-enabling the button on
 * that basis would invite a tap the server is about to refuse again.
 */
const DROP_POLLED: readonly ClaimUiState[] = ['loading', 'awaiting-funding', 'ready']

export function useClaim(publicId: string, options: UseClaimOptions = {}): ClaimController {
  const { discoverBridge = resolveBridge, pollMs = CLAIM_POLL_MS } = options

  const [state, setState] = useState<ClaimUiState>('loading')
  const [drop, setDrop] = useState<DropPublic | null>(null)
  const [serverState, setServerState] = useState<ClaimServerState | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [claimAmount, setClaimAmount] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [tracking, setTracking] = useState<StoredClaim | null>(null)

  const bridgeRef = useRef<BridgeResult | null>(null)
  const dropRef = useRef<DropPublic | null>(null)
  const stateRef = useRef<ClaimUiState>('loading')
  const idemRef = useRef<{ challengeId: string; key: string } | null>(null)

  const goto = useCallback((next: ClaimUiState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const rememberDrop = useCallback((next: DropPublic) => {
    dropRef.current = next
    setDrop(next)
  }, [])

  /** Map any thrown failure onto a named state. */
  const applyFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'exhausted':
            setNotice('')
            goto('exhausted')
            return
          case 'drop_expired':
          case 'drop_not_live':
            setNotice('')
            goto('expired')
            return
          // The sponsor ended the drop, possibly while this claimant was
          // reading it. A dead end, but not the same dead end as a deadline.
          case 'closed_by_sponsor':
            setNotice('')
            goto('closed')
            return
          case 'paused':
            setNotice(err.message)
            goto('paused')
            return
          case 'degraded':
          case 'unavailable':
            setNotice(err.message)
            goto('degraded')
            return
          case 'not_found':
            setNotice('')
            goto('expired')
            return
          default:
            break
        }
        // A stale, reused or unverifiable challenge is not a failure of the
        // claimant's — it is "start again", which is exactly `rejected`.
        if (err.code.startsWith('challenge') || err.code === 'invalid_signature' ||
            err.code === 'unknown_challenge' || err.code === 'cross_drop_challenge' ||
            err.code === 'message_mismatch') {
          setNotice(err.message)
          goto('rejected')
          return
        }
        if (err.status >= 500) {
          setNotice(err.message)
          goto('degraded')
          return
        }
        setNotice(err.message)
        goto('rejected')
        return
      }
      // Offline, DNS, TLS, abort: the network, not the money path.
      setNotice('We could not reach NimDrops just now.')
      goto('degraded')
    },
    [goto],
  )

  // ---- landing ------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    const stored = readStored(publicId)
    // A stored claim outranks everything: this browser already holds a slot, so
    // the only question left is what the server says about it. No wallet is
    // needed to answer that, and no second challenge may be minted.
    if (stored) setTracking(stored)

    const boot = async () => {
      const bridge = stored ? null : await discoverBridge().catch(() => ({ kind: 'unavailable' }) as BridgeResult)
      if (cancelled) return
      if (bridge) bridgeRef.current = bridge

      let latest: DropPublic
      try {
        latest = await getDrop(publicId)
      } catch (err) {
        if (cancelled || stored) return
        applyFailure(err)
        return
      }
      if (cancelled) return
      rememberDrop(latest)
      if (stored) return // the claim poll owns the state
      if (bridge?.kind === 'unavailable') {
        goto('no-wallet')
        return
      }
      goto(stateForDrop(latest))
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [applyFailure, discoverBridge, goto, publicId, rememberDrop])

  // ---- pre-claim drop refresh ---------------------------------------------------

  useEffect(() => {
    if (!DROP_POLLED.includes(state)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const latest = await getDrop(publicId)
        if (cancelled) return
        rememberDrop(latest)
        // Only re-derive the screen if the claimant has not moved on since:
        // a poll landing mid-signature must never yank the screen back.
        if (DROP_POLLED.includes(stateRef.current)) goto(stateForDrop(latest))
      } catch {
        // A failed refresh is a failed refresh. Keep the screen, keep asking.
      }
      if (!cancelled) timer = setTimeout(poll, pollMs)
    }
    timer = setTimeout(poll, pollMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [goto, pollMs, publicId, rememberDrop, state])

  // ---- claim status poll --------------------------------------------------------

  useEffect(() => {
    if (!tracking) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const status = await getClaimStatus(tracking.claimId, tracking.statusToken)
        if (cancelled) return
        setServerState(status.state)
        setClaimAmount(status.amountEach)
        if (status.txHash) setTxHash(status.txHash)
        goto(uiForServer(status.state))
        // Paid is terminal. The stored token stays put so the receipt survives
        // a reload — it is a read credential for a finished payment.
        if (status.state === 'paid') return
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
          // The server does not recognise this token any more. Holding on to it
          // would poll a claim that cannot answer, forever.
          clearStored(publicId)
          if (cancelled) return
          setTracking(null)
          const known = dropRef.current
          goto(known ? stateForDrop(known) : 'loading')
          return
        }
        // Transient: keep asking rather than declaring a payment lost.
      }
      if (!cancelled) timer = setTimeout(poll, pollMs)
    }

    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [goto, pollMs, publicId, tracking])

  // ---- actions -------------------------------------------------------------------

  const claim = useCallback(async () => {
    if (stateRef.current === 'signing') return
    const bridge = bridgeRef.current ?? (await discoverBridge())
    bridgeRef.current = bridge
    if (bridge.kind === 'unavailable') {
      goto('no-wallet')
      return
    }

    setNotice('')
    goto('signing')

    let challenge
    try {
      challenge = await issueChallenge(publicId)
    } catch (err) {
      applyFailure(err)
      return
    }

    let signed
    try {
      signed = await bridge.bridge.sign(challenge.message)
    } catch {
      // Closed, cancelled, or refused in the wallet. Nothing was reserved and
      // nothing was signed, so this is a retry, not a lost claim.
      setNotice('Your wallet closed without approving. Nothing was claimed.')
      goto('rejected')
      return
    }

    // One idempotency key per signed request: a retry of THE SAME signature
    // must replay the same claim, never reserve a second slot.
    if (idemRef.current?.challengeId !== challenge.challengeId) {
      idemRef.current = { challengeId: challenge.challengeId, key: crypto.randomUUID() }
    }

    try {
      const reserved = await submitClaim(
        publicId,
        {
          challengeId: challenge.challengeId,
          publicKey: signed.publicKey,
          signature: signed.signature,
        },
        idemRef.current.key,
      )
      const stored = { claimId: reserved.claimId, statusToken: reserved.statusToken }
      writeStored(publicId, stored)
      setServerState(reserved.state)
      goto(uiForServer(reserved.state))
      setTracking(stored)
    } catch (err) {
      applyFailure(err)
    }
  }, [applyFailure, discoverBridge, goto, publicId])

  /**
   * Back to the campaign card. It answers immediately from the drop we already
   * have — a retry should not stare at a spinner — and re-reads the projection
   * in the background so the remaining count is current by the next tap.
   */
  const retry = useCallback(() => {
    setNotice('')
    const known = dropRef.current
    goto(known ? stateForDrop(known) : 'loading')
    void getDrop(publicId)
      .then((latest) => {
        rememberDrop(latest)
        if (DROP_POLLED.includes(stateRef.current)) goto(stateForDrop(latest))
      })
      .catch(() => {
        // Nothing to correct: the screen we just restored is still the best
        // thing we know.
      })
  }, [goto, publicId, rememberDrop])

  return {
    state,
    drop,
    serverState,
    txHash,
    // The claim status's amount FIRST: on a scored gate it is the committed
    // payout (60/80/100% of the share), while the drop's own figure is always
    // the full share. The drop is only the answer before a claim exists.
    amountEach: claimAmount ?? drop?.amountEach ?? null,
    notice,
    claim,
    retry,
  }
}
