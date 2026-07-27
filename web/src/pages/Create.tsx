import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ApiError,
  createDrop,
  forgetDraftKeys,
  getCustody,
  getDrop,
  submitFunding,
  type CustodyDisclosure,
  type Draft,
  type DropPublic,
  type DropState,
  type PilotLimits,
} from '../api'
import { dropShareData, shareOrCopy } from '../integrations/share'
import {
  DEFAULT_EXPIRY_HOURS,
  EXPIRY_CHOICES,
  expiryWindowLabel,
  formatNim,
  lunaFromNim,
  MAX_CLAIM_COUNT,
  MIN_AMOUNT_EACH_LUNA,
  MIN_CLAIMS,
  shapeProblem,
} from '../money'
import { nimiqPayDeeplink, resolveBridge, type BridgeResult } from '../sdk/adapter'
import { clearFunding, readFunding, writeFunding } from '../state/funding'
import AmountInput from '../ui/AmountInput'
import Field from '../ui/Field'
import GlassSheet from '../ui/GlassSheet'
import {
  ChevronRightIcon,
  ClockExpiryIcon,
  CustodyShieldIcon,
  InfoIcon,
  WarningIcon,
} from '../ui/icons'
import { Amount } from '../ui/Nim'
import OpenInApp from '../ui/OpenInApp'
import Sheet from '../ui/Sheet'

/**
 * Create and fund a drop (design §4.2).
 *
 * The screen is a small state machine, and its most important property is what
 * it refuses to say. Between "the wallet accepted the transaction" and "the
 * chain shows it", the honest words are *detecting* and *confirming*. Telling a
 * sponsor to send the money again because our detection is slow would cost them
 * a second real transaction, so no branch of this file offers that.
 *
 * **The link is the reward for funding, and nothing else earns it.** A draft
 * has a `publicId` from the moment it is created — it has to, because the
 * funding memo is `ND1:<publicId>` and that memo is how the server proves which
 * drop a payment funded — but a `publicId` is not a shareable thing. An
 * unfunded packet leads to a card with no money behind it, which is worse than
 * no link at all. So no share URL, no QR, no copy and no share button exists on
 * this screen until the server says `live`; before that the sponsor gets the
 * funding progress and one sentence saying where the link will appear.
 *
 * **A funded drop must never be lost.** Because the link is withheld until
 * `live`, a sponsor who closes the app while funding confirms has no other copy
 * of it. `state/funding.ts` therefore remembers the funded draft, and this
 * screen resumes from it on mount.
 *
 * **The sponsor is trusting a person, and has to be told so before they pay.**
 * NimDrops is a custodial hot wallet: the operator holds a key that can spend
 * the whole balance, and no on-chain escrow exists because a Nimiq HTLC has one
 * recipient and cannot express "N unknown claimants". `GET /api/custody` is the
 * server's own account of that, and every point it returns is rendered here, in
 * the order it returns them, above the fund button. Not paraphrased: the server
 * enforces the caps and holds the key, so any wording invented on this side
 * could drift away from what is actually true.
 *
 * ## The composition, since the redesign
 *
 * The same two zones the claim surface uses (`DropView`, the s4 "Stack"
 * system): an open upper field carrying the money, and one sheet of glass over
 * it carrying the transaction. Before this, the sponsor's first impression was
 * white cards on near-white while the claimant got a warm near-black field lit
 * by a single vermilion bloom, and the two ends of one link looked like two
 * products.
 *
 * Three rules govern how the states map onto those zones:
 *
 *  - **The money is the `h1`, on every screen that has one.** The claimant's
 *    field prints the share they are being offered; the sponsor's prints the
 *    total they are about to send, derived while they type. It is the same
 *    `Amount` lockup, in the same near-white, for the same reason: Nimiq gold
 *    is 2.74:1 on the field's brightest pixel.
 *  - **A screen with no money to print puts its heading in the field instead**,
 *    which is the rule the claim surface's dead ends already follow. That is
 *    every refusal, plus the frame where a remembered drop is being looked up.
 *  - **The sheet is the only thing a new state changes.** The upper field is
 *    the total from the first keystroke to the live link.
 *
 * The resting total is `0` rather than a dash. A form whose money slot is empty
 * has to say something in it, and `0 NIM` is both true and the thing a wallet
 * says; the dash it replaces was also the last em dash on the screen.
 */

/** Design §4.2 step 5: poll the public state, do not guess. */
const POLL_MS = 3000

/**
 * How often the reservation countdown redraws. The number on screen is in
 * minutes, so a second is far finer than it needs to be — but it is also what
 * makes the lapse land on the second it happens rather than up to a minute
 * later, and the lapse is the moment the sponsor's room stops being theirs.
 */
const RESERVATION_TICK_MS = 1000

/** How many people the form starts on, and the count a `?amount=` is judged against. */
const DEFAULT_CLAIM_COUNT = 5

/**
 * The reciprocity loop's one piece of state: "Drop one back" carries the amount
 * the claimant just received as `?amount=`, so the return drop opens with that
 * number already in the field.
 *
 * A link is not typed input, but it is held to exactly the same rules — the same
 * `lunaFromNim` parse and the same `shapeProblem` check the form itself uses. A
 * param that fails either is dropped in silence and the field opens empty:
 * a stale or hand-edited link is not a mistake the claimant made, so it is not a
 * mistake they are shown. Only the amount travels; the people count is the
 * sponsor's own decision and stays at its default.
 */
function prefillAmount(raw: string | null): string {
  if (raw === null) return ''
  return shapeProblem(lunaFromNim(raw), DEFAULT_CLAIM_COUNT) === null ? raw : ''
}

type Phase =
  | 'form'
  /** Reading back a drop this browser already funded, before anything is drawn. */
  | 'resuming'
  /** `POST /api/drops` in flight. */
  | 'creating'
  /** Waiting for the sponsor to approve in Nimiq Pay. */
  | 'approving'
  /** The wallet said no. Recoverable, and not a money event. */
  | 'rejected'
  /** The wallet returned something the funding endpoint would not take. */
  | 'unconfirmed'
  | 'detecting'
  | 'confirming'
  | 'live'
  /** Production browser with no Nimiq Pay provider. */
  | 'no-wallet'
  /**
   * `drop_too_large` (422). The total is bigger than the cap can ever hold, so
   * the only move is a smaller drop. Deliberately NOT a retry screen.
   */
  | 'too-large'
  /** `no_capacity` (503). The room exists; somebody else has it right now. */
  | 'no-capacity'
  /** The operator has funding closed. No wallet prompt from here. */
  | 'closed'
  | 'failed'

/** Whether the live disclosure has arrived, and what to show while it has not. */
type CustodyState = 'loading' | 'ready' | 'unavailable'

function phaseForDrop(state: DropState): Phase {
  if (state === 'funding_pending') return 'confirming'
  if (state === 'live' || state === 'closing' || state === 'settled' || state === 'refunded') {
    return 'live'
  }
  return 'detecting'
}

/**
 * A drop whose life is over. There is no link left to hand anyone, so a
 * remembered record pointing at one is forgotten rather than resumed.
 */
const FINISHED: readonly DropState[] = ['settled', 'refunded', 'cancelled']

/** Phases whose truth lives on the server, so they keep asking it. */
const POLLED: readonly Phase[] = ['detecting', 'confirming', 'unconfirmed']

/** `BigInt()` on a string the server chose, without trusting it to be a number. */
function lunaOf(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/** The server's own sentence for a closed deployment, when it sent one. */
function pausedPoint(custody: CustodyDisclosure | null): string | null {
  return custody?.points.find((point) => point.id === 'paused')?.text ?? null
}

export interface CreateProps {
  /**
   * Test seam. Production renders `<Create />` and gets the real provider
   * discovery from `sdk/adapter`; tests hand in a `MockBridge`.
   */
  discoverBridge?: () => Promise<BridgeResult>
}

export default function Create({ discoverBridge = resolveBridge }: CreateProps) {
  // Read once, on mount: the param seeds the field, it does not own it. Every
  // later keystroke wins, and nothing here writes back to the URL.
  const [searchParams] = useSearchParams()
  const [amountEach, setAmountEach] = useState(() => prefillAmount(searchParams.get('amount')))
  const [claimCount, setClaimCount] = useState(DEFAULT_CLAIM_COUNT)
  /**
   * How long the drop stays claimable. Starts on the default, so a sponsor who
   * never touches the control gets exactly the drop this screen made before it
   * existed — and the request omits the field entirely in that case, which is
   * what keeps the server's default and this screen's default one number
   * rather than two that could drift apart.
   */
  const [expiryHours, setExpiryHours] = useState(DEFAULT_EXPIRY_HOURS)
  const [sponsorLabel, setSponsorLabel] = useState('')
  const [message, setMessage] = useState('')

  /** One sheet at a time: the disclosure on its own, or the review that funds. */
  const [sheet, setSheet] = useState<'none' | 'custody' | 'review'>('none')
  // Read once, synchronously, before the first paint: a sponsor who funded a
  // drop from this browser must never see the empty form flash past on the way
  // to their link.
  const [restored] = useState(readFunding)
  const [phase, setPhase] = useState<Phase>(restored ? 'resuming' : 'form')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drop, setDrop] = useState<DropPublic | null>(null)
  const [failure, setFailure] = useState('')
  const [custody, setCustody] = useState<CustodyDisclosure | null>(null)
  const [custodyState, setCustodyState] = useState<CustodyState>('loading')
  const [retryAfter, setRetryAfter] = useState<number | null>(null)

  /**
   * Read the live disclosure. Returns it as well as storing it, because two
   * callers need to act on the answer rather than just show it.
   *
   * A refresh that fails keeps whatever was already on screen: numbers a minute
   * old are closer to the truth than no numbers, and the server re-checks the
   * cap when the drop is created anyway.
   */
  const loadCustody = useCallback(async (hours: number): Promise<CustodyDisclosure | null> => {
    try {
      const next = await getCustody(hours)
      setCustody(next)
      setCustodyState('ready')
      return next
    } catch {
      setCustodyState((previous) => (previous === 'ready' ? previous : 'unavailable'))
      return null
    }
  }, [])

  const refreshCustody = useCallback(() => {
    void loadCustody(expiryHours)
  }, [loadCustody, expiryHours])

  /**
   * Read the disclosure for the window that is selected right now.
   *
   * One of the server's points NAMES the claim window, and the sponsor reads it
   * before they fund. So the fetch is keyed on the selection: change the
   * window, and the sentences change with it. The first run asks for the
   * default, which is what is selected on arrival, so the common path costs
   * exactly the one request it always did.
   *
   * While a refresh is in flight — or after one failed — the disclosure on hand
   * describes a DIFFERENT window from the one selected, and `disclosureFits`
   * below is what stops those sentences from being shown against it.
   */
  useEffect(() => {
    void loadCustody(expiryHours)
  }, [loadCustody, expiryHours])

  /**
   * Can this device fund a drop at all? Asked on arrival, not at the fund button.
   *
   * Funding is one transaction signed in Nimiq Pay, so a browser with no
   * provider cannot complete this screen no matter what is typed into it.
   * Discovering that only at the end meant a sponsor filled in an amount, a
   * headcount, a name and a message, read the whole custody disclosure, pressed
   * the one button that matters and was then told the screen never worked here.
   *
   * Two guards keep the early check from causing harm of its own:
   *
   *  - It only ever downgrades from `form`. A resumed draft, a funding
   *    transaction in flight and a live drop all own the screen already, and a
   *    late `unavailable` must not throw away a link the sponsor cannot get back.
   *  - It never upgrades. Nothing here sets a phase on success, so the ordinary
   *    in-wallet path is byte for byte what it was.
   *
   * The wait is the adapter's own 1.5s injection budget, which inside Nimiq Pay
   * resolves immediately because the provider is seeded before the page script
   * runs. A plain browser therefore reads the form for a moment before the gate
   * replaces it — the honest trade against gating a wallet's own sponsor on a
   * race it could lose.
   */
  useEffect(() => {
    let alive = true
    void discoverBridge()
      .then((resolved) => {
        if (!alive || resolved.kind !== 'unavailable') return
        setPhase((previous) => (previous === 'form' ? 'no-wallet' : previous))
      })
      .catch(() => {
        // The adapter answers rather than throwing; if it ever does throw, the
        // form is the safer thing to leave on screen than a gate.
      })
    return () => {
      alive = false
    }
  }, [discoverBridge])

  const paused = custody?.paused === true

  const amountLuna = lunaFromNim(amountEach)
  const problem = shapeProblem(amountLuna, claimCount)
  const totalLuna = amountLuna === null ? null : amountLuna * BigInt(claimCount)
  /**
   * The figure the field prints, with no unit on it: `Amount` sets the mark and
   * the word. `0` while there is nothing to multiply, because the money slot on
   * a form is never empty and a wallet's own resting state is a zero.
   */
  const totalFigure = totalLuna === null || problem === 'amount' ? '0' : formatNim(totalLuna)
  const totalText = `${totalFigure} NIM`
  /**
   * How much room this deployment has left, or `null` when the operator has set
   * no ceiling — which is the default, and the case a sponsor is normally in.
   *
   * Nothing here bounds the size of a drop. The one check the form still makes
   * is against the ROOM THAT IS ACTUALLY FREE, and it exists for a single
   * reason: a sponsor must never fill in a whole form and be refused at the
   * fund button for something that was knowable while they were still choosing
   * a number. It is a live figure and it can go stale between the read and the
   * tap, which is what the `no-capacity` screen is for.
   */
  const freeLuna = custody?.limits.remainingLuna == null ? null : lunaOf(custody.limits.remainingLuna)
  const overCapacity = totalLuna !== null && freeLuna !== null && totalLuna > freeLuna
  const ready = problem === null && sponsorLabel.trim().length > 0 && !overCapacity && !paused

  /**
   * Whether the disclosure on hand describes the window that is selected.
   *
   * The server's points are shown verbatim or not at all, and one of them names
   * the window. A point naming 24 hours beside a 7 day selection would be a
   * false statement about this sponsor's own money, so when the two disagree —
   * a refresh still in flight, or one that failed — the fallback prose is shown
   * instead, and it names the selection rather than a constant.
   *
   * Only the WORDS are gated. `paused` and the live limits do not depend on the
   * window, so they keep reading from whatever disclosure is on hand.
   */
  const disclosureFits = custody !== null && custody.expiryHours === expiryHours
  const custodyWords = disclosureFits ? custody : null

  // A draft that has already been created is reused on retry: the sponsor is
  // approving THE SAME funding request, not a new one.
  const draftRef = useRef<Draft | null>(null)
  /**
   * The hash the wallet reported, once it has. It is what turns polling from a
   * read into a submission — `POST /api/drops/:publicId/funding` is the only
   * call that can move a drop from `funding_pending` to `live`, and it is
   * idempotent by construction, so re-sending the same hash is safe and is
   * exactly what the operator's own funding utility does.
   */
  const txHashRef = useRef<string | null>(null)

  const approve = useCallback(
    async (current: Draft) => {
      setPhase('approving')
      const resolved = await discoverBridge()
      if (resolved.kind === 'unavailable') {
        setPhase('no-wallet')
        return
      }

      let txHash: string
      try {
        const sent = await resolved.bridge.sendWithData({
          recipient: current.fundingAddress,
          // The server's luna string is authoritative — never the local total.
          valueLuna: BigInt(current.expectedFundingLuna),
          data: current.fundingMemo,
        })
        txHash = sent.txHash
      } catch {
        // Rejected, cancelled, or the provider failed before signing. Nothing
        // left the wallet, so this is a retry, not a second payment.
        setPhase('rejected')
        return
      }

      // Money has provably left the wallet. From here the sponsor must be able
      // to close the app and come back to this drop, so the record is written
      // BEFORE the funding call rather than after it: a crash in between must
      // not be the difference between a recoverable drop and a lost one.
      txHashRef.current = txHash
      writeFunding({ draft: current, txHash, savedAt: Date.now() })

      try {
        const funded = await submitFunding(current.publicId, txHash)
        setDrop(funded)
        setPhase(phaseForDrop(funded.state))
      } catch (err) {
        // `POST /funding` validates `txHash` as 64 hex characters. The Nimiq Pay
        // SDK types `sendBasicTransactionWithData` as returning "the serialized
        // transaction", and whether that string is the hash or the raw tx is the
        // open question the Task 7 on-device fixture has to settle
        // (`sdk/adapter.ts`). Until it does, a value the endpoint rejects is
        // reported as what it honestly is — the transaction is not registered
        // yet — with the raw string logged for the device run. It is never
        // reported as "send it again".
        if (err instanceof ApiError && err.status === 400) {
          console.warn('[nimdrops] wallet returned a value the funding endpoint rejected:', txHash)
          setPhase('unconfirmed')
          return
        }
        // A 5xx is not a verdict on the transaction, and the money has already
        // left the wallet. The server says so itself — a chain lookup that hit
        // its deadline, a paused custody, a stale reconciliation all answer 503
        // with `Retry-After` — and the poll below already treats a 5xx as "keep
        // asking". Treating it as `failed` here put a "Try again" button in
        // front of a sponsor who had paid, and that button re-opens the wallet
        // and sends a SECOND transaction: the drop holds one funding hash for
        // its whole life, so the second deposit becomes an operator
        // reconciliation item rather than a refund.
        if (err instanceof ApiError && err.status >= 500) {
          setPhase('detecting')
          return
        }
        if (err instanceof ApiError) {
          setFailure(err.message)
          setPhase('failed')
          return
        }
        // Network trouble after a signed transaction: keep polling instead of
        // declaring a failure the chain may well disagree with.
        setPhase('detecting')
      }
    },
    [discoverBridge],
  )

  const fund = useCallback(async () => {
    setSheet('none')
    if (draftRef.current) {
      await approve(draftRef.current)
      return
    }
    // Belt and braces behind the disabled review button: the operator can close
    // funding while a sheet is open, and a wallet prompt for a drop the server
    // will refuse costs the sponsor a real transaction.
    if (paused) {
      setPhase('closed')
      return
    }
    setPhase('creating')
    let created: Draft
    try {
      created = await createDrop({
        sponsorLabel: sponsorLabel.trim(),
        ...(message.trim() ? { message: message.trim() } : {}),
        amountEach,
        claimCount,
        // Sent only when the sponsor chose something other than the default, so
        // the untouched form makes byte for byte the request it always made and
        // the default stays the server's to define.
        ...(expiryHours === DEFAULT_EXPIRY_HOURS ? {} : { expiryHours }),
      })
    } catch (err) {
      /**
       * The three capacity refusals, which are the only money-shaped refusals a
       * sponsor meets before they have paid anything. Each gets its own screen
       * because each has a different answer, and "try again" on the one that
       * can never succeed would send the sponsor round a loop.
       */
      if (err instanceof ApiError && err.code === 'drop_too_large') {
        refreshCustody()
        setPhase('too-large')
        return
      }
      if (err instanceof ApiError && err.code === 'no_capacity') {
        setRetryAfter(err.retryAfterSeconds ?? null)
        refreshCustody()
        setPhase('no-capacity')
        return
      }
      if (err instanceof ApiError && err.code === 'paused') {
        refreshCustody()
        setPhase('closed')
        return
      }
      setFailure(err instanceof ApiError ? err.message : 'we could not reach NimDrops just now')
      setPhase('failed')
      return
    }
    // The disclosure on the 201 is the one that applied to THIS drop, read
    // inside the transaction that reserved its room. It wins over the copy
    // fetched on mount.
    if (created.disclosure) {
      setCustody(created.disclosure)
      setCustodyState('ready')
    }
    draftRef.current = created
    setDraft(created)
    await approve(created)
  }, [amountEach, approve, claimCount, expiryHours, message, paused, refreshCustody, sponsorLabel])

  /**
   * Ask again whether funding has reopened. Only the closed screen calls it, and
   * only a genuine `paused: false` moves off that screen — a failed check leaves
   * the sponsor where they are rather than walking them into a refusal.
   */
  const recheckFunding = useCallback(async () => {
    const next = await loadCustody(expiryHours)
    if (next && !next.paused) setPhase('form')
  }, [loadCustody, expiryHours])

  /**
   * Come back to a drop this browser funded.
   *
   * Runs once, on mount, and only when a record exists. The record proves a
   * transaction was signed; the server is the only authority on what became of
   * it, so the record supplies the draft (and its share URL) and the server
   * supplies the state.
   */
  useEffect(() => {
    if (!restored) return
    let cancelled = false

    const resume = async () => {
      const adopt = (next: Phase) => {
        draftRef.current = restored.draft
        txHashRef.current = restored.txHash
        setDraft(restored.draft)
        setPhase(next)
      }

      let latest: DropPublic
      try {
        latest = await getDrop(restored.draft.publicId)
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          // The server has never heard of it. Nothing to resume and nothing to
          // recover; the create form is the useful answer.
          clearFunding()
          setPhase('form')
          return
        }
        // Offline, or a bad minute at the API. The drop is still ours, so pick
        // the poll back up rather than throwing the record away.
        adopt('detecting')
        return
      }
      if (cancelled) return

      if (FINISHED.includes(latest.state)) {
        clearFunding()
        setPhase('form')
        return
      }
      setDrop(latest)
      adopt(phaseForDrop(latest.state))
    }

    void resume()
    return () => {
      cancelled = true
    }
  }, [restored])

  /**
   * Funding truth, asked for on a timer.
   *
   * Once a transaction hash exists this is a re-submission, not a read: a
   * `funding_pending` drop only ever reaches `live` inside the funding
   * endpoint, which re-checks the transaction against every §7 predicate and
   * activates it the moment it is final. Re-sending the same hash is the
   * endpoint's documented idempotent case — it moves no money — and without it
   * a sponsor sits on "Confirming" forever and their link never arrives.
   *
   * A 4xx means this hash will never be accepted for this drop, so the poll
   * stops re-submitting it and falls back to reading. A 5xx or a dropped
   * connection means nothing of the sort, and keeps trying.
   */
  const publicId = draft?.publicId
  const polled = POLLED.includes(phase)
  useEffect(() => {
    if (!polled || !publicId) return
    let cancelled = false
    let submit = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const hash = txHashRef.current
      try {
        const latest = submit && hash ? await submitFunding(publicId, hash) : await getDrop(publicId)
        if (cancelled) return
        setDrop(latest)
        setPhase(phaseForDrop(latest.state))
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) submit = false
        // A failed poll is a failed poll. Keep asking.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS)
    }
    timer = setTimeout(poll, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [polled, publicId])

  /**
   * Put the funded drop down and start a fresh one.
   *
   * The remembered record goes, and so does every remembered draft attempt in
   * this tab: replaying a spent draft would ask the wallet to fund a drop that
   * is already live.
   */
  const startAnother = useCallback(() => {
    clearFunding()
    forgetDraftKeys()
    draftRef.current = null
    txHashRef.current = null
    setDraft(null)
    setDrop(null)
    setFailure('')
    setRetryAfter(null)
    setAmountEach('')
    setClaimCount(DEFAULT_CLAIM_COUNT)
    setExpiryHours(DEFAULT_EXPIRY_HOURS)
    setSponsorLabel('')
    setMessage('')
    setPhase('form')
  }, [])

  if (phase === 'live' && draft) {
    return <Live draft={draft} drop={drop} onStartAnother={startAnother} />
  }

  if (phase === 'no-wallet') return <NoWallet />

  /**
   * The room this draft holds in the cap, counting down.
   *
   * Shown only while the sponsor still has a decision to make. Once the wallet
   * has reported a hash the reservation stops mattering — the server keeps a
   * paid draft's room regardless — so the note would be a worry with no action
   * behind it.
   */
  const reservationNote =
    draft?.reservationExpiresAt && custody ? (
      <ReservationNote
        expiresAt={draft.reservationExpiresAt}
        windowMinutes={custody.fundingWindowMinutes}
        custody={custody}
        onLapsed={refreshCustody}
      />
    ) : null

  if (phase === 'rejected' && draft) {
    return (
      <Recover
        title="Not approved"
        body="Your wallet closed without approving the transaction, so nothing was sent and nothing was charged."
        action="Try again"
        onAction={() => void approve(draft)}
        note={reservationNote}
      />
    )
  }

  /**
   * 422. Reachable only when the operator has put the principal cap back on as
   * a kill switch: the total is larger than the whole ceiling, so there is no
   * later at which it would work and no retry button on this screen.
   */
  if (phase === 'too-large') {
    return (
      <Recover
        testId="drop-too-large"
        mark="info"
        title="That total is over the operator's limit"
        body={
          custody?.limits.aggregateMax
            ? `The operator has capped all live drops at ${custody.limits.aggregateMax} NIM. Lower the amount per person or the number of people, then review it again.`
            : 'The operator has capped how much can be live at once. Lower the amount per person or the number of people, then review it again.'
        }
        action="Change the amount"
        onAction={() => setPhase('form')}
      />
    )
  }

  /** 503. The room exists, someone else has it, and waiting is a real answer. */
  if (phase === 'no-capacity') {
    return (
      <Recover
        testId="no-capacity"
        mark="info"
        title="No room for another drop right now"
        body={noCapacityBody({ custody, totalText, retryAfter })}
        action="Try again"
        onAction={() => void fund()}
        secondary="Change the amount"
        onSecondary={() => setPhase('form')}
      />
    )
  }

  if (phase === 'closed') {
    return (
      <Recover
        testId="funding-closed-screen"
        title="Funding is closed right now"
        body={
          pausedPoint(custody) ??
          'The operator has to open funding before a new drop can start. Nothing has been sent and nothing has been charged.'
        }
        action="Check again"
        onAction={() => void recheckFunding()}
        quiet
      />
    )
  }

  if (phase === 'unconfirmed' && draft) {
    return (
      <Recover
        mark="clock"
        title="Waiting for wallet confirmation"
        body="Your wallet has the transaction, but it has not given us a receipt we can verify yet. We keep checking — the moment the network shows it, this drop goes live and your share link appears here."
        action="Check again"
        onAction={() => void approve(draft)}
        quiet
      />
    )
  }

  if (phase === 'failed') {
    return (
      <Recover
        title="That did not go through"
        body={failure || 'Something went wrong before your wallet opened.'}
        action="Try again"
        onAction={() => void fund()}
      />
    )
  }

  if (
    phase === 'resuming' ||
    phase === 'creating' ||
    phase === 'approving' ||
    phase === 'detecting' ||
    phase === 'confirming'
  ) {
    return (
      <Progress
        phase={phase}
        /**
         * The money stays put while the transaction moves through the sheet.
         * Before a draft exists it is the form's own derived total; after one
         * exists it is the server's `expectedFundingLuna` in decimal NIM, which
         * is the authoritative figure and the one the wallet was asked for.
         *
         * `resuming` has neither — the form is empty and the draft is still
         * being read back — so it prints a heading in the field instead.
         */
        nim={draft ? draft.expectedFunding : phase === 'resuming' ? null : totalFigure}
        funding={draft !== null}
        peopleCaption={`total for ${claimCount} people`}
        note={phase === 'approving' ? reservationNote : null}
      />
    )
  }

  return (
    <Shell
      sheets={
        <>
          {/* The disclosure on its own, reachable while the sponsor is still
              deciding how much to send. Same points, same order, no fund
              button — reading it is not a step in paying. */}
          <Sheet
            open={sheet === 'custody'}
            surface="field"
            title="What you are trusting"
            onClose={() => setSheet('none')}
          >
            <CustodyBody
              custody={custodyWords}
              custodyState={custodyState}
              onRetry={refreshCustody}
              expiryHours={expiryHours}
              heading={false}
            />
            <ShareRules />
            <button
              type="button"
              data-testid="custody-sheet-close"
              onClick={() => setSheet('none')}
              className="nd-quiet mt-6"
            >
              Close
            </button>
          </Sheet>

          <Sheet
            open={sheet === 'review'}
            surface="field"
            title="Before you fund"
            onClose={() => setSheet('none')}
          >
            <dl className="nd-rows">
              <Row label="Each person gets">{`${amountEach || '0'} NIM`}</Row>
              <Row label="People">{String(claimCount)}</Row>
              <Row label="You send">{totalText}</Row>
              <Row label="Claim window">
                {expiryWindowLabel(expiryHours)} after it goes live
              </Row>
            </dl>

            {/* Every point, in the server's order, above the button that opens
                the wallet. The sheet scrolls, so reaching the button means
                scrolling past them. One of those points names the claim window,
                and `custodyWords` is what keeps it from naming a window other
                than the one in the row above. */}
            <CustodyBody
              custody={custodyWords}
              custodyState={custodyState}
              onRetry={refreshCustody}
              expiryHours={expiryHours}
            />
            <ShareRules />

            {custody ? (
              <p data-testid="custody-summary" className="nd-lede">
                {custody.summary}
              </p>
            ) : null}
            <button type="button" onClick={() => void fund()} className="nd-action mt-4">
              Fund drop
            </button>
            <p className="nd-note text-center">
              Nimiq Pay opens next — tap and approve one transaction.
            </p>
          </Sheet>
        </>
      }
    >
      <div className="nd-upper">
        {/* The money the sponsor is about to send, derived as they type. */}
        <Money nim={totalFigure} caption={`total for ${claimCount} people`} testId="derived-total" />

        {/* The share floor, said only once the sponsor has typed something the
            form can read as a number. Below it the fund button is dead, and a
            dead button with no sentence next to it is the form refusing without
            saying why. */}
        {problem === 'too-small' ? (
          <Alert testId="share-too-small">
            Each person needs at least {formatNim(MIN_AMOUNT_EACH_LUNA)} NIM. Raise the amount per
            person.
          </Alert>
        ) : null}

        {overCapacity && custody ? (
          <Alert testId="over-cap">
            {custody.limits.remaining} NIM is free across all drops right now. Lower the amount or
            the number of people.
          </Alert>
        ) : null}

        {/* The ceiling, before a number is typed against it — or, when the
            operator has closed funding, the one fact that matters more. */}
        {paused ? (
          <Alert testId="funding-closed" role="status" title="Funding is closed">
            {pausedPoint(custody) ?? 'The operator has to open funding before a new drop can start.'}
          </Alert>
        ) : custody ? (
          <LiveLimits limits={custody.limits} />
        ) : null}
      </div>

      <GlassSheet
        header={<h2 className="nd-sheeth">Send a NimDrop</h2>}
        caption={
          <p className="nd-note">
            One transaction from you. A fixed, equal share for everyone who opens the link.
          </p>
        }
      >
        <div className="nd-form">
          <AmountInput
            label="NIM per person"
            value={amountEach}
            onChange={setAmountEach}
            hint="Everyone gets exactly this. No splitting, no chance."
          />

          <PeopleStepper value={claimCount} onChange={setClaimCount} />

          <ExpiryChoice value={expiryHours} onChange={setExpiryHours} />

          <TextField
            label="From"
            value={sponsorLabel}
            onChange={setSponsorLabel}
            maxLength={40}
            placeholder="Your name or group"
          />
          <TextField
            label="Message (optional)"
            value={message}
            onChange={setMessage}
            maxLength={200}
            placeholder="Thanks for a good week"
          />
        </div>

        {/* The study's Ugly Cash move: the least reassuring fact about the
            product is the headline of a control, not a footnote under a button.
            The same words the claimant's own custody control uses on the other
            side of the link, aimed at the person who is about to pay for it. */}
        <button
          type="button"
          data-testid="custody-card"
          aria-haspopup="dialog"
          aria-expanded={sheet === 'custody'}
          onClick={() => setSheet('custody')}
          className="nd-disclose mt-5"
        >
          <CustodyShieldIcon size={20} />
          <span>
            <b>NimDrops holds your NIM, and no contract holds it for you</b>
            <em>Who can move it, the limits right now, and what happens if nobody claims.</em>
          </span>
          <ChevronRightIcon size={18} />
        </button>

        <button
          type="button"
          disabled={!ready}
          onClick={() => setSheet('review')}
          className="nd-action mt-3"
        >
          Review drop
        </button>
        <p className="nd-note text-center">
          Nothing is sent until you approve it in Nimiq Pay.
        </p>
      </GlassSheet>
    </Shell>
  )
}

// ---- pieces ---------------------------------------------------------------------

/**
 * The field, and the column the two zones stack in.
 *
 * `.nd-stack` is a container of its own, which is what keeps the poster layout
 * from firing on a screen that has no poster composition; the reasoning is on
 * the class in `index.css`. Modal sheets are rendered as SIBLINGS of it rather
 * than inside it, because a container establishes a containing block for fixed
 * positioning and a modal has to be fixed to the viewport.
 *
 * `tone` is the field's own light. `warm` is the state the claim surface uses
 * for a claim that landed, and the sponsor's equivalent is a drop that went
 * live: the bloom comes up and stays up, so the screen remembers. `quiet` is
 * every refusal, where nothing is going to happen until the sponsor does
 * something.
 */
function Shell({
  children,
  sheets,
  tone = 'live',
  testId,
}: {
  children: ReactNode
  /** Modal sheets, rendered outside the container. */
  sheets?: ReactNode
  tone?: 'live' | 'warm' | 'quiet'
  testId?: string
}) {
  return (
    <Field tone={tone}>
      <div className="nd-stack" {...(testId ? { 'data-testid': testId } : {})}>
        {children}
      </div>
      {sheets}
    </Field>
  )
}

/**
 * The money, bare in the open field, in the same lockup the claimant meets.
 *
 * `tone="ink"` and not gold, for the arithmetic in `index.css`: Nimiq gold is
 * 2.74:1 on the field's brightest pixel, under even the 3:1 a non-text mark is
 * held to. The size steps down by character count rather than by media query,
 * because what overflows a 320px phone is `10000.00000`, not a narrow screen.
 */
function Money({ nim, caption, testId }: { nim: string; caption: string; testId?: string }) {
  return (
    <div className="nd-money" {...(testId ? { 'data-testid': testId } : {})}>
      <Amount
        value={nim}
        markScale={0.46}
        tone="ink"
        className="nd-amount"
        data-size={nim.length <= 6 ? 'lg' : nim.length <= 9 ? 'md' : 'sm'}
      />
      <p className="nd-moneycap">{caption}</p>
    </div>
  )
}

/**
 * A heading in the field, for a screen with no money to print.
 *
 * The same move the claim surface makes on its dead ends: a heading in the open
 * field is a stronger statement of "this did not happen" than the same words in
 * a sheet. The mark above it is a word's worth of the same statement — a shape,
 * never a hue on its own — and it is near-white rather than gold because gold
 * on the field is 2.74:1, under even the 3:1 a non-text mark is held to.
 *
 * `waiting` is the one that is not an icon: something is in flight, nothing has
 * gone wrong, and a pulsing keyline says that where a warning triangle would
 * say the opposite.
 */
type Mark = 'waiting' | 'warn' | 'info' | 'clock'

function Headline({ title, mark }: { title: string; mark: Mark }) {
  return (
    <div className="nd-headline">
      {mark === 'waiting' ? (
        <span className="nd-beacon nd-pulse" aria-hidden="true" data-testid="headline-mark" />
      ) : mark === 'info' ? (
        <InfoIcon size={24} data-testid="headline-mark" />
      ) : mark === 'clock' ? (
        <ClockExpiryIcon size={24} data-testid="headline-mark" />
      ) : (
        <WarningIcon size={24} data-testid="headline-mark" />
      )}
      <h1>{title}</h1>
    </div>
  )
}

/**
 * Something that outranks the ledger below it: the cap this total has passed,
 * or funding being closed.
 *
 * A hard vermilion edge on the field's own recess, never a wash of it — the
 * field's colour is a bloom, and more of it would read as light rather than as
 * a warning. The mark is near-white for the same reason.
 */
function Alert({
  children,
  title,
  testId,
  role,
}: {
  children: ReactNode
  title?: string
  testId?: string
  role?: 'status'
}) {
  return (
    <div
      className="nd-alert"
      {...(testId ? { 'data-testid': testId } : {})}
      {...(role ? { role } : {})}
    >
      <WarningIcon size={18} />
      <div>
        {title ? <b>{title}</b> : null}
        <p>{children}</p>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nd-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// ---- the custody disclosure ----------------------------------------------------

/**
 * What this deployment has left, on the form, above the fields — and nothing at
 * all when there is nothing to be left of.
 *
 * There is no ceiling on a drop any more, so most of the time the honest answer
 * to "what am I choosing against" is "nothing", and a box saying so would be a
 * box saying nothing. It renders only when the operator has actually set a
 * ceiling or a drop limit, which is the only case where a sponsor's number can
 * be refused for a reason they could have seen first.
 */
function LiveLimits({ limits }: { limits: PilotLimits }) {
  if (limits.aggregateMax === null && limits.maxLiveDrops === null) return null
  return (
    <div data-testid="live-limits" className="nd-limits">
      <p>Limits right now</p>
      <dl className="nd-rows">
        {limits.aggregateMax === null ? null : (
          <Row label="Free across all drops">
            {limits.remaining} of {limits.aggregateMax} NIM
          </Row>
        )}
        {limits.maxLiveDrops === null ? null : (
          <Row label="Drops running">
            {limits.liveDrops} of {limits.maxLiveDrops}
          </Row>
        )}
      </dl>
    </div>
  )
}

/**
 * Every disclosure point the server sent, in the order it sent them.
 *
 * The order is the reading order the server chose — what this is, who can take
 * it, how much, where it goes, which run this is, when the clock starts, how
 * money comes back — and when funding is closed the server puts that first.
 * Nothing here re-sorts, re-words or filters, because the point of fetching
 * these rather than shipping them is that they cannot drift away from what the
 * backend actually enforces.
 *
 * The first point gets the darker ink. It is the one the sponsor is most likely
 * to read and the one they most need to.
 */
function CustodyPoints({ points }: { points: { id: string; text: string }[] }) {
  return (
    <ul data-testid="custody-points" className="nd-points">
      {points.map((point) => (
        <li key={point.id} data-point={point.id}>
          {/* `currentColor`, so the first point's stronger ink carries into its
              own bullet and no second accent is introduced. */}
          <span aria-hidden="true" />
          <span className="min-w-0">{point.text}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The server's points, or the words this app ships with when they did not load.
 *
 * The fallback is short on purpose: it carries the two facts a sponsor cannot
 * be allowed to fund without — custody, and where unclaimed NIM goes — and says
 * plainly that the live numbers are missing. It does not block funding, because
 * the server re-checks every cap when the drop is created and now says exactly
 * why when it refuses.
 */
function CustodyBody({
  custody,
  custodyState,
  onRetry,
  expiryHours,
  /** Off in the sheet whose dialog title already says it. */
  heading = true,
}: {
  /**
   * The server's disclosure, or `null` when there is none to show that
   * describes the window currently selected. Not the same thing as "the fetch
   * failed": a disclosure about a different window is worse than none, because
   * it would tell the sponsor a false thing about their own money.
   */
  custody: CustodyDisclosure | null
  custodyState: CustodyState
  onRetry: () => void
  /** The selected window, for the fallback's own sentence about it. */
  expiryHours: number
  heading?: boolean
}) {
  return (
    <section className={heading ? 'mt-6' : ''}>
      {heading ? <h3 className="nd-subh">What you are trusting</h3> : null}
      {custody ? (
        <CustodyPoints points={custody.points} />
      ) : (
        <div data-testid="custody-fallback" className="nd-prose">
          <p className="is-lead">
            Your NIM goes to one wallet the NimDrops operator runs, not to an escrow contract. The
            operator holds the only key and can move everything in it.
          </p>
          <p>
            A drop stops accepting claims {expiryWindowLabel(expiryHours)} after it goes live.
            Whatever nobody claims goes back to the wallet you fund from.
          </p>
          {custodyState === 'unavailable' ? (
            <>
              <p>
                The live limits did not load, so this screen cannot tell you how much room is left.
                NimDrops checks the cap again when the drop is created and says what to do if there
                is none.
              </p>
              <button type="button" onClick={onRetry} className="nd-quiet mt-1">
                Load the limits again
              </button>
            </>
          ) : null}
        </div>
      )}
    </section>
  )
}

/**
 * What the server's points deliberately leave to this side: how a share is
 * won, and what is public afterwards. The same three facts the claimant's own
 * disclosure sheet gives, so both ends of the link are told one story.
 */
function ShareRules() {
  return (
    <section className="mt-6">
      <h3 className="nd-subh">How the shares work</h3>
      <div className="nd-prose">
        <p>
          Shares are fixed and first come, first served — one per wallet. A signature proves control
          of one wallet, not one person.
        </p>
        <p>
          Payouts and returns wait for the network to confirm them, and can go to a person for
          review during an incident.
        </p>
        <p>
          Funding, payouts and refunds are ordinary Nimiq transactions: public and permanent on the
          chain.
        </p>
      </div>
    </section>
  )
}

/**
 * How long this draft's room in the cap is still its own.
 *
 * Capacity is committed when the funding instructions are issued and released
 * again after `fundingWindowMinutes`, so a sponsor who leaves the wallet open
 * and comes back an hour later may find the room gone. Saying so is the whole
 * job; the lapse also re-reads `/api/custody`, so the sentence that replaces the
 * countdown carries the headroom as it is now rather than as it was.
 */
function ReservationNote({
  expiresAt,
  windowMinutes,
  custody,
  onLapsed,
}: {
  expiresAt: string
  windowMinutes: number
  custody: CustodyDisclosure
  onLapsed: () => void
}) {
  const deadline = Date.parse(expiresAt)
  /**
   * A reservation is only worth telling a sponsor about when it is holding
   * something back from somebody else. With no principal ceiling and no drop
   * limit it holds nothing — the row still has its expiry, and the moment an
   * operator arms either limit it starts mattering again, so the server keeps
   * writing it. Saying "your room is held" when there is no room to hold would
   * be a sentence about nothing.
   */
  const reserves = custody.limits.aggregateMax !== null || custody.limits.maxLiveDrops !== null
  const usable = reserves && Number.isFinite(deadline)
  const [now, setNow] = useState(() => Date.now())
  const lapsed = usable && deadline <= now

  useEffect(() => {
    if (!usable || lapsed) return
    const timer = setInterval(() => setNow(Date.now()), RESERVATION_TICK_MS)
    return () => clearInterval(timer)
  }, [usable, lapsed])

  useEffect(() => {
    if (lapsed) onLapsed()
  }, [lapsed, onLapsed])

  if (!usable) return null

  const minutesLeft = Math.max(1, Math.ceil((deadline - now) / 60_000))
  const free =
    custody.limits.remaining === null
      ? ''
      : ` ${custody.limits.remaining} NIM of the ${custody.limits.aggregateMax} NIM cap is free right now.`
  const text = lapsed
    ? `The ${windowMinutes} minute hold on your room has ended.${free} Funding may still work — it is just no longer held for you.`
    : minutesLeft <= 1
      ? 'Your room is held for less than a minute more.'
      : `Your room is held for another ${minutesLeft} minutes.`

  return (
    <p data-testid="reservation-note" role="status" className="nd-note is-hold">
      {text}
    </p>
  )
}

/**
 * What to say when the server had no room. Three answers, because there are
 * three different situations and only two of them are worth retrying.
 */
function noCapacityBody(o: {
  custody: CustodyDisclosure | null
  totalText: string
  retryAfter: number | null
}): string {
  const { custody, totalText, retryAfter } = o
  const wait =
    retryAfter !== null && retryAfter > 0
      ? `try again in about ${retryAfter} seconds`
      : 'try again shortly'
  if (custody && custody.limits.remainingDrops === 0) {
    const sentence = wait.charAt(0).toUpperCase() + wait.slice(1)
    const many = custody.limits.maxLiveDrops === 1 ? 'one at a time' : `${custody.limits.maxLiveDrops} at a time`
    return `Another drop is already running, and this deployment runs ${many}. ${sentence}.`
  }
  if (custody && custody.limits.remaining !== null) {
    return `This drop needs ${totalText}, and ${custody.limits.remaining} NIM of the ${custody.limits.aggregateMax} NIM cap is free right now. Lower the total, or ${wait}.`
  }
  const sentence = wait.charAt(0).toUpperCase() + wait.slice(1)
  return `Someone else is holding the room. ${sentence}.`
}

/**
 * How many people, with a floor and no ceiling.
 *
 * The ceiling used to be twenty, and twenty is the number that made the product
 * pointless: one signature paying a hundred people is the whole idea. What is
 * left is the floor — a one-person drop is a Cashlink — and the width of the
 * column the count is stored in, which is not a limit anyone will type.
 */
function PeopleStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId()
  const clamp = (n: number) => Math.min(MAX_CLAIM_COUNT, Math.max(MIN_CLAIMS, n))
  return (
    <div>
      <label htmlFor={id} className="nd-lab">
        How many people
      </label>
      {/* The claim screen's 44px circle, doing the only job it honestly has on
          this side of the link. Two of them, 10px apart, so a thumb aiming at
          one cannot land on the other. */}
      <div className="nd-stepper">
        <StepButton label="One fewer person" onClick={() => onChange(clamp(value - 1))} disabled={value <= MIN_CLAIMS}>
          −
        </StepButton>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_CLAIMS}
          max={MAX_CLAIM_COUNT}
          value={value}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10)
            if (Number.isFinite(next)) onChange(clamp(next))
          }}
          className="nd-input"
        />
        <StepButton label="One more person" onClick={() => onChange(clamp(value + 1))} disabled={value >= MAX_CLAIM_COUNT}>
          +
        </StepButton>
        <p className="nd-range">{MIN_CLAIMS} or more</p>
      </div>
    </div>
  )
}

/**
 * How long the drop stays claimable.
 *
 * **Discrete, not a typed hour count.** A number field would ask a sponsor on a
 * phone to convert "over the weekend" into 72, then discover the bounds by
 * being refused, then convert the refusal back into hours. Six chips show the
 * whole range at once, cannot express an invalid window, and put the shortest
 * and longest this deployment allows on screen without anyone having to be told
 * no. The set spans hours to a fortnight because those are the shapes sponsors
 * described: a room, an evening, a day, a weekend, a conference, a campaign.
 *
 * **The default costs no interaction.** `24 hours` is pressed on arrival, so
 * the sponsor who does not care about this is finished with it before they read
 * it, and the one who does can see what they are changing from.
 *
 * The consequence sits under the chips rather than behind the disclosure sheet,
 * because it is the fact that should decide the choice: a longer window is a
 * longer time somebody else is holding the money, and there is no way to cut it
 * short afterwards. `role="radiogroup"` and not a set of buttons, so a screen
 * reader hears one control with six options and its current value.
 */
function ExpiryChoice({ value, onChange }: { value: number; onChange: (hours: number) => void }) {
  const labelId = useId()
  return (
    <div>
      <span id={labelId} className="nd-lab">
        Claim window
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="nd-chips" data-testid="expiry-choice">
        {EXPIRY_CHOICES.map((hours) => (
          <button
            key={hours}
            type="button"
            role="radio"
            aria-checked={hours === value}
            data-hours={hours}
            onClick={() => onChange(hours)}
            className="nd-chip"
          >
            {expiryWindowLabel(hours)}
          </button>
        ))}
      </div>
      <p className="nd-hint">
        Unclaimed NIM goes back to you {expiryWindowLabel(value)} after the drop goes live. NimDrops
        holds it for the whole window, and you can close the drop early from the wallet you fund
        with to get the unclaimed NIM back sooner.
      </p>
    </div>
  )
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="nd-round"
    >
      {children}
    </button>
  )
}

function TextField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  maxLength: number
  placeholder: string
}) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="nd-lab">
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="nd-input"
      />
    </div>
  )
}

const PROGRESS_COPY: Record<string, { title: string; body: string }> = {
  resuming: {
    title: 'Finding your drop',
    body: 'You funded a drop from this device. We are checking whether it is live yet.',
  },
  creating: {
    title: 'Preparing your drop',
    body: 'Reserving your drop and the exact amount to fund.',
  },
  approving: {
    title: 'Approve in Nimiq Pay',
    body: 'Your wallet has the transaction. Tap and approve it there to fund this drop.',
  },
  detecting: {
    title: 'Detecting your transaction',
    body: 'We are watching the Nimiq network for it. This can take several minutes, and there is nothing else for you to do.',
  },
  confirming: {
    title: 'Confirming on the network',
    body: 'The network has your transaction. Your drop goes live as soon as it is final.',
  },
}

/**
 * What replaces the share block while a drop is unfunded.
 *
 * Two jobs. The first line says plainly that there is nothing to hand anyone
 * yet and where the link will be, so waiting is a wait *for* something rather
 * than an absence the sponsor has to interpret. The second answers the question
 * the first one raises — "so I have to sit here?" — and it is only sayable
 * because `state/funding.ts` makes it true.
 */
const PENDING_SHARE_NOTE =
  'Nothing to share yet. Your link and its QR code appear here the moment funding confirms.'

const PENDING_LEAVE_NOTE =
  'You can close NimDrops. Reopen it on this device and you land back on this drop.'

/**
 * Funding, in flight.
 *
 * The money stays in the field and only the sheet changes, which is the same
 * contract the claim surface keeps: a new state is a new sheet body and nothing
 * else. Where there is no total to print yet — a remembered drop being read
 * back — the title takes the field instead and the sheet carries no second copy
 * of it.
 */
function Progress({
  phase,
  nim,
  funding,
  peopleCaption,
  note,
}: {
  phase: Phase
  /** The total to print in the field, or `null` when there is not one yet. */
  nim: string | null
  /** Whether that total is now a transaction rather than a form's arithmetic. */
  funding: boolean
  peopleCaption: string
  note?: ReactNode
}) {
  const copy = PROGRESS_COPY[phase] ?? PROGRESS_COPY.creating
  const steps: { key: Phase; label: string }[] = [
    { key: 'detecting', label: 'Detecting' },
    { key: 'confirming', label: 'Confirming' },
    { key: 'live', label: 'Live' },
  ]
  const reached = steps.findIndex((s) => s.key === phase)
  return (
    <Shell>
      <div className="nd-upper">
        {nim === null ? (
          <Headline title={copy.title} mark="waiting" />
        ) : (
          <Money
            nim={nim}
            // The sentence this replaces read "Funding N NIM to the NimDrops
            // custody address"; the figure above it is now that number, so the
            // caption carries the rest of it rather than saying it twice.
            caption={funding ? 'to the NimDrops custody address' : peopleCaption}
          />
        )}
      </div>

      <GlassSheet
        header={nim === null ? null : <h2 className="nd-sheeth">{copy.title}</h2>}
        caption={<p className="nd-note">{copy.body}</p>}
      >
        {reached >= 0 ? (
          <>
            <ol className="nd-steps mt-4" aria-label="Funding progress">
              {steps.map((step, index) => (
                <li
                  key={step.key}
                  aria-current={index === reached ? 'step' : undefined}
                  data-reached={index <= reached ? 'true' : 'false'}
                >
                  {step.label}
                </li>
              ))}
            </ol>
            <p data-testid="pending-share-note" className="nd-note">
              {PENDING_SHARE_NOTE}
            </p>
            <p className="nd-note">{PENDING_LEAVE_NOTE}</p>
          </>
        ) : null}

        {note}
      </GlassSheet>
    </Shell>
  )
}

/**
 * A refusal, and the way out of it.
 *
 * There is no money in the field on any of these: nothing was sent, and
 * printing a total the sponsor has not committed above the word that says they
 * did not would be the one misreading this screen cannot afford. The heading
 * takes the field instead, which is the same thing the claim surface does with
 * its dead ends.
 */
function Recover({
  title,
  body,
  action,
  onAction,
  mark = 'warn',
  quiet,
  secondary,
  onSecondary,
  note,
  testId,
}: {
  title: string
  body: string
  action: string
  onAction: () => void
  /** Which of the four marks belongs above the heading. */
  mark?: Mark
  quiet?: boolean
  /** A second way out, for a refusal that has two honest answers. */
  secondary?: string
  onSecondary?: () => void
  note?: ReactNode
  testId?: string
}) {
  return (
    <Shell tone="quiet" {...(testId ? { testId } : {})}>
      <div className="nd-upper">
        <Headline title={title} mark={mark} />
      </div>
      <GlassSheet caption={<p className="nd-lede">{body}</p>}>
        <button
          type="button"
          onClick={onAction}
          className={quiet ? 'nd-quiet mt-5' : 'nd-action mt-5'}
        >
          {action}
        </button>
        {secondary && onSecondary ? (
          <button type="button" onClick={onSecondary} className="nd-quiet mt-3">
            {secondary}
          </button>
        ) : null}

        {note}
      </GlassSheet>
    </Shell>
  )
}

/**
 * The sponsor is in an ordinary browser, so nothing on this screen can be
 * funded: the funding transaction is signed in Nimiq Pay and nowhere else.
 *
 * It is a gate and not a narrower form. The whole surface is replaced, the deep
 * link is offered first, the page URL second for a phone to type in, and the two
 * app stores third — because until this screen existed, a visitor without the
 * wallet installed pressed "Open in Nimiq Pay", watched a `nimiqpay://` link
 * resolve to nothing, and had no way to learn what to install.
 */
function NoWallet() {
  const here = typeof window === 'undefined' ? '' : window.location.href
  return (
    <Field brand>
      <OpenInApp title="Fund your drop in Nimiq Pay" deepLink={nimiqPayDeeplink(here)} url={here}>
        <p>
          A NimDrop is funded by one transaction from your own wallet, so this step happens inside
          Nimiq Pay rather than in a browser.
        </p>
        <p>You pick the amount per person and the headcount there, and approve once.</p>
      </OpenInApp>
    </Field>
  )
}

/**
 * The reward for funding.
 *
 * Every share affordance in the product lives here and nowhere else, which is
 * the whole point: reaching this screen is the only way a share URL, a QR code,
 * a copy button or the native share sheet comes into existence. The block rises
 * in on `nd-rise` so the arrival reads as something the sponsor earned rather
 * than a field that quietly filled itself in — and `nd-rise` is a plain
 * animation, so `prefers-reduced-motion` lands it fully formed on the first
 * frame instead of skipping it.
 */
/** What happens to whatever nobody takes, and when — or just what, if the window is unknown. */
function refundLine(hours: number | undefined): string {
  const base = 'Unclaimed shares are refunded to the wallet that funded this drop'
  return hours === undefined
    ? `${base} when the claim window ends.`
    : `${base}, ${expiryWindowLabel(hours)} after it went live.`
}

function Live({
  draft,
  drop,
  onStartAnother,
}: {
  draft: Draft
  drop: DropPublic | null
  onStartAnother: () => void
}) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return (
    // `warm` is the field's memory. The claim surface keeps the hotter cast
    // once a claim lands; the sponsor's equivalent is a drop that went live,
    // and it is the one screen in this flow that earned it.
    <Shell tone="warm">
      <div className="nd-upper">
        <Money nim={draft.expectedFunding} caption="funded" />
      </div>

      <GlassSheet
        header={<h2 className="nd-sheeth">Your drop is live</h2>}
        caption={
          <p className="nd-note">
            {drop
              ? `${drop.remaining} of ${drop.claimCount} shares of ${drop.amountEach} NIM are waiting. Share the link — the first ${drop.claimCount} wallets to open it each get one.`
              : 'Share the link. Each wallet that opens it can claim one fixed share.'}
          </p>
        }
      >
        <div data-testid="share-block" className="nd-rise mt-5">
          <div className="nd-qr">
            <img
              src={`/drop/${draft.publicId}/qr.svg`}
              alt="QR code for this drop's link"
              width={220}
              height={220}
            />
          </div>
          <p className="nd-linkline">{draft.shareUrl}</p>

          <div className="mt-5 space-y-3">
            {canShare ? (
              <button
                type="button"
                className="nd-action"
                onClick={() => {
                  void shareOrCopy(
                    dropShareData({ url: draft.shareUrl, amount: drop?.amountEach }),
                  ).then((result) => setCopied(result === 'copied'))
                }}
              >
                Share
              </button>
            ) : null}
            <button
              type="button"
              className={canShare ? 'nd-quiet' : 'nd-action'}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(draft.shareUrl)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </div>
        </div>

        {/* The window comes off the drop, never off a constant. The server's
            record wins; the draft covers the frame before the first poll
            answers; a record stored by a build older than this feature carries
            neither, and then the sentence names no number rather than the
            wrong one. */}
        <p className="nd-note">{refundLine(drop?.expiryHours ?? draft.expiryHours)}</p>
        <p className="nd-note">Reopen NimDrops on this device to come back to this link.</p>

        <button
          type="button"
          onClick={onStartAnother}
          className="nd-textlink mt-2 block w-full text-center"
        >
          Send another drop
        </button>
      </GlassSheet>
    </Shell>
  )
}
