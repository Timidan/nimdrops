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
import { capProblem, formatNim, lunaFromNim, MAX_CLAIMS, MIN_CLAIMS } from '../money'
import { nimiqPayDeeplink, resolveBridge, type BridgeResult } from '../sdk/adapter'
import { clearFunding, readFunding, writeFunding } from '../state/funding'
import AmountInput from '../ui/AmountInput'
import Envelope from '../ui/Envelope'
import NdScreen from '../ui/Screen'
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
 * `lunaFromNim` parse and the same `capProblem` caps the form itself uses. A
 * param that fails any of them is dropped in silence and the field opens empty:
 * a stale or hand-edited link is not a mistake the claimant made, so it is not a
 * mistake they are shown. Only the amount travels; the people count is the
 * sponsor's own decision and stays at its default.
 */
function prefillAmount(raw: string | null): string {
  if (raw === null) return ''
  return capProblem(lunaFromNim(raw), DEFAULT_CLAIM_COUNT) === null ? raw : ''
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
  const loadCustody = useCallback(async (): Promise<CustodyDisclosure | null> => {
    try {
      const next = await getCustody()
      setCustody(next)
      setCustodyState('ready')
      return next
    } catch {
      setCustodyState((previous) => (previous === 'ready' ? previous : 'unavailable'))
      return null
    }
  }, [])

  const refreshCustody = useCallback(() => {
    void loadCustody()
  }, [loadCustody])

  useEffect(() => {
    void loadCustody()
  }, [loadCustody])

  const paused = custody?.paused === true

  const amountLuna = lunaFromNim(amountEach)
  const problem = capProblem(amountLuna, claimCount)
  const totalLuna = amountLuna === null ? null : amountLuna * BigInt(claimCount)
  const totalText = totalLuna === null || problem === 'amount' ? '—' : `${formatNim(totalLuna)} NIM`
  /**
   * The deployment's own ceiling, which on the mainnet pilot is two orders of
   * magnitude under the 100 NIM launch cap in `money.ts`. Checked here so a
   * sponsor meets the limit while they are still choosing a number, rather than
   * as a 422 after they have committed to one.
   */
  const capLuna = custody === null ? null : lunaOf(custody.limits.perDropMaxLuna)
  const overCap = totalLuna !== null && capLuna !== null && totalLuna > capLuna
  const ready = problem === null && sponsorLabel.trim().length > 0 && !overCap && !paused

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
  }, [amountEach, approve, claimCount, message, paused, refreshCustody, sponsorLabel])

  /**
   * Ask again whether funding has reopened. Only the closed screen calls it, and
   * only a genuine `paused: false` moves off that screen — a failed check leaves
   * the sponsor where they are rather than walking them into a refusal.
   */
  const recheckFunding = useCallback(async () => {
    const next = await loadCustody()
    if (next && !next.paused) setPhase('form')
  }, [loadCustody])

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
    setSponsorLabel('')
    setMessage('')
    setPhase('form')
  }, [])

  if (phase === 'live' && draft) {
    // After a reload the form fields are empty, but the server still knows who
    // sent it, so the wax keeps its initial.
    const sealFrom = (drop?.sponsorLabel || sponsorLabel).trim()
    return (
      <Live
        draft={draft}
        drop={drop}
        sealMark={sealFrom.slice(0, 1).toUpperCase()}
        onStartAnother={startAnother}
      />
    )
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
   * 422. The requested total is larger than the whole cap, so there is no
   * later at which it would work and no retry button on this screen.
   */
  if (phase === 'too-large') {
    return (
      <Recover
        testId="drop-too-large"
        title="That total is over the cap"
        body={
          custody
            ? `A drop can hold up to ${custody.limits.perDropMax} NIM right now. Lower the amount per person or the number of people, then review it again.`
            : 'This drop is larger than the cap allows. Lower the amount per person or the number of people, then review it again.'
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
      <Progress phase={phase} draft={draft} note={phase === 'approving' ? reservationNote : null} />
    )
  }

  return (
    <Screen>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Send a NimDrop</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink/60">
          One transaction from you. A fixed, equal share for everyone who opens the link.
        </p>
      </header>

      {/* The ceiling, before a number is typed against it — or, when the
          operator has closed funding, the one fact that matters more. */}
      {paused ? (
        <div
          data-testid="funding-closed"
          role="status"
          className="mt-6 rounded-2xl border border-gold/50 bg-gold/15 p-4"
        >
          <p className="text-sm font-semibold text-ink">Funding is closed</p>
          <p className="mt-1 text-xs leading-relaxed text-ink/70">
            {pausedPoint(custody) ??
              'The operator has to open funding before a new drop can start.'}
          </p>
        </div>
      ) : custody ? (
        <LiveLimits limits={custody.limits} />
      ) : null}

      <div className="mt-8 space-y-6">
        <AmountInput
          label="NIM per person"
          value={amountEach}
          onChange={setAmountEach}
          hint="Everyone gets exactly this. No splitting, no chance."
        />

        <PeopleStepper value={claimCount} onChange={setClaimCount} />

        <TextField label="From" value={sponsorLabel} onChange={setSponsorLabel} maxLength={40} placeholder="Your name or group" />
        <TextField
          label="Message (optional)"
          value={message}
          onChange={setMessage}
          maxLength={200}
          placeholder="Thanks for a good week"
        />
      </div>

      <div className="mt-8 flex items-baseline justify-between border-t border-ink/10 pt-5">
        <span className="text-sm text-ink/60">Total</span>
        <p data-testid="derived-total" className="text-xl font-semibold tabular-nums text-ink">
          {totalText}
        </p>
      </div>
      {overCap && custody ? (
        <p data-testid="over-cap" className="mt-2 text-right text-xs text-ink/60">
          A drop can hold up to {custody.limits.perDropMax} NIM right now. Lower the amount or the
          number of people.
        </p>
      ) : problem === 'total' ? (
        <p className="mt-2 text-right text-xs text-ink/60">
          A drop can hold up to 100 NIM while NimDrops is new.
        </p>
      ) : null}

      {/* The study's Ugly Cash move: the least reassuring fact about the
          product is the headline of a card, not a footnote under a button.
          The same words the claimant's card uses on the other side of the
          link, aimed at the person who is about to pay for it. */}
      <button
        type="button"
        data-testid="custody-card"
        aria-haspopup="dialog"
        aria-expanded={sheet === 'custody'}
        onClick={() => setSheet('custody')}
        className="mt-8 block w-full rounded-2xl border border-ink/10 bg-ink/4 p-4 text-left"
      >
        <span className="block text-sm font-semibold text-ink/80">
          NimDrops holds your NIM, and no contract holds it for you
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink/55">
          Who can move it, the limits right now, and what happens if nobody claims.
        </span>
      </button>

      <button
        type="button"
        disabled={!ready}
        onClick={() => setSheet('review')}
        className="nd-primary mt-5 w-full"
      >
        Review drop
      </button>
      <p className="mt-3 text-center text-xs text-ink/50">
        Nothing is sent until you approve it in Nimiq Pay.
      </p>

      {/* The disclosure on its own, reachable while the sponsor is still
          deciding how much to send. Same points, same order, no fund button —
          reading it is not a step in paying. */}
      <Sheet
        open={sheet === 'custody'}
        title="What you are trusting"
        onClose={() => setSheet('none')}
      >
        <CustodyBody
          custody={custody}
          custodyState={custodyState}
          onRetry={refreshCustody}
          heading={false}
        />
        <ShareRules />
        <button
          type="button"
          data-testid="custody-sheet-close"
          onClick={() => setSheet('none')}
          className="nd-secondary mt-6 w-full"
        >
          Close
        </button>
      </Sheet>

      <Sheet
        open={sheet === 'review'}
        title="Before you fund"
        sealMark={sponsorLabel.trim().slice(0, 1).toUpperCase()}
        onClose={() => setSheet('none')}
      >
        <dl className="divide-y divide-ink/10 text-sm">
          <Row label="Each person gets">{`${amountEach || '0'} NIM`}</Row>
          <Row label="People">{String(claimCount)}</Row>
          <Row label="You send">
            <span className="font-semibold">{totalText}</span>
          </Row>
          <Row label="Expires">24 hours after it goes live</Row>
        </dl>

        {/* Every point, in the server's order, above the button that opens the
            wallet. The sheet scrolls, so reaching the button means scrolling
            past them. */}
        <CustodyBody custody={custody} custodyState={custodyState} onRetry={refreshCustody} />
        <ShareRules />

        {custody ? (
          <p
            data-testid="custody-summary"
            className="mt-6 text-sm leading-relaxed font-medium text-ink"
          >
            {custody.summary}
          </p>
        ) : null}
        <button type="button" onClick={() => void fund()} className="nd-primary mt-4 w-full">
          Fund drop
        </button>
        <p className="mt-3 text-center text-xs text-ink/50">
          Nimiq Pay opens next — tap and approve one transaction.
        </p>
      </Sheet>
    </Screen>
  )
}

// ---- pieces ---------------------------------------------------------------------

/**
 * The create flow is the envelope before it has a flap: a blank sheet the
 * sponsor fills in. The wax appears at the two moments it means something —
 * the review sheet (sealing it) and the share screen (sealed).
 */
function Screen({ children }: { children: ReactNode }) {
  return (
    <NdScreen>
      <main className="nd-face flex-1 pt-7 pb-14 text-ink">{children}</main>
    </NdScreen>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between py-2.5">
      <dt className="text-ink/60">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  )
}

// ---- the custody disclosure ----------------------------------------------------

/**
 * The live ceiling, on the form, above the fields.
 *
 * A sponsor choosing an amount needs the number they are choosing against. The
 * mainnet pilot's aggregate cap is two orders of magnitude under the 100 NIM
 * launch cap, so this is the difference between typing a total that works and
 * typing one the server has to refuse.
 */
function LiveLimits({ limits }: { limits: PilotLimits }) {
  return (
    <div data-testid="live-limits" className="mt-6 rounded-2xl bg-ink/4 px-4 py-3">
      <p className="text-xs font-semibold tracking-wide text-ink/55 uppercase">Limits right now</p>
      <dl className="mt-1.5 divide-y divide-ink/8 text-sm">
        <Row label="Most in one drop">{limits.perDropMax} NIM</Row>
        <Row label="Free across all drops">
          {limits.remaining} of {limits.aggregateMax} NIM
        </Row>
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
    <ul data-testid="custody-points" className="mt-3 space-y-2.5">
      {points.map((point, index) => (
        <li
          key={point.id}
          data-point={point.id}
          className={`flex gap-2.5 text-sm leading-relaxed break-words ${
            index === 0 ? 'font-medium text-ink' : 'text-ink/70'
          }`}
        >
          <span
            aria-hidden="true"
            className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gold-deep"
          />
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
  /** Off in the sheet whose dialog title already says it. */
  heading = true,
}: {
  custody: CustodyDisclosure | null
  custodyState: CustodyState
  onRetry: () => void
  heading?: boolean
}) {
  return (
    <section className={heading ? 'mt-6' : ''}>
      {heading ? <h3 className="text-sm font-semibold text-ink">What you are trusting</h3> : null}
      {custody ? (
        <CustodyPoints points={custody.points} />
      ) : (
        <div data-testid="custody-fallback" className="mt-3 space-y-2.5 text-sm leading-relaxed text-ink/70">
          <p className="font-medium text-ink">
            Your NIM goes to one wallet the NimDrops operator runs, not to an escrow contract. The
            operator holds the only key and can move everything in it.
          </p>
          <p>
            A drop stops accepting claims 24 hours after it goes live. Whatever nobody claims goes
            back to the wallet you fund from.
          </p>
          {custodyState === 'unavailable' ? (
            <>
              <p>
                The live limits did not load, so this screen cannot tell you how much room is left.
                NimDrops checks the cap again when the drop is created and says what to do if there
                is none.
              </p>
              <button type="button" onClick={onRetry} className="nd-secondary mt-1 w-full">
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
      <h3 className="text-sm font-semibold text-ink">How the shares work</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink/70">
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
  const usable = Number.isFinite(deadline)
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
  const text = lapsed
    ? `The ${windowMinutes} minute hold on your room has ended. ${custody.limits.remaining} NIM of the ${custody.limits.aggregateMax} NIM cap is free right now, so funding may still work — it is just no longer held for you.`
    : minutesLeft <= 1
      ? 'Your room in the cap is held for less than a minute more.'
      : `Your room in the cap is held for another ${minutesLeft} minutes.`

  return (
    <p data-testid="reservation-note" role="status" className="mt-8 text-xs leading-relaxed text-ink/55">
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
    return `Another drop is already running, and this pilot runs one at a time. ${sentence}.`
  }
  if (custody) {
    return `This drop needs ${totalText}, and ${custody.limits.remaining} NIM of the ${custody.limits.aggregateMax} NIM cap is free right now. Lower the total, or ${wait}.`
  }
  const sentence = wait.charAt(0).toUpperCase() + wait.slice(1)
  return `Someone else is holding the room in the cap. ${sentence}.`
}

function PeopleStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId()
  const clamp = (n: number) => Math.min(MAX_CLAIMS, Math.max(MIN_CLAIMS, n))
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink/70">
        How many people
      </label>
      <div className="mt-2 flex items-center gap-3">
        <StepButton label="One fewer person" onClick={() => onChange(clamp(value - 1))} disabled={value <= MIN_CLAIMS}>
          −
        </StepButton>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_CLAIMS}
          max={MAX_CLAIMS}
          value={value}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10)
            if (Number.isFinite(next)) onChange(clamp(next))
          }}
          className="w-20 rounded-2xl border border-ink/12 bg-white py-3 text-center text-xl font-semibold tabular-nums text-ink outline-none focus:border-gold"
        />
        <StepButton label="One more person" onClick={() => onChange(clamp(value + 1))} disabled={value >= MAX_CLAIMS}>
          +
        </StepButton>
        <span className="ml-auto text-xs text-ink/45">
          {MIN_CLAIMS}–{MAX_CLAIMS}
        </span>
      </div>
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
      className="h-12 w-12 rounded-2xl border border-ink/12 bg-white text-xl font-semibold text-ink disabled:opacity-35"
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
      <label htmlFor={id} className="block text-sm font-medium text-ink/70">
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-ink/12 bg-white px-4 py-3 text-base text-ink outline-none placeholder:text-ink/25 focus:border-gold"
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

function Progress({
  phase,
  draft,
  note,
}: {
  phase: Phase
  draft: Draft | null
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
    <Screen>
      <div className="flex flex-1 flex-col justify-center py-16">
        <div className="nd-pulse mb-8 h-1.5 w-16 rounded-full bg-gold" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">{copy.body}</p>

        {reached >= 0 ? (
          <>
            <ol className="mt-8 flex gap-2" aria-label="Funding progress">
              {steps.map((step, index) => (
                <li
                  key={step.key}
                  aria-current={index === reached ? 'step' : undefined}
                  className={`flex-1 rounded-full py-1.5 text-center text-xs font-medium ${
                    index <= reached ? 'bg-ink text-paper' : 'bg-ink/8 text-ink/45'
                  }`}
                >
                  {step.label}
                </li>
              ))}
            </ol>
            <p
              data-testid="pending-share-note"
              className="mt-6 text-xs leading-relaxed text-ink/50"
            >
              {PENDING_SHARE_NOTE}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink/50">{PENDING_LEAVE_NOTE}</p>
          </>
        ) : null}

        {draft ? (
          <p className="mt-8 text-xs text-ink/45">
            Funding {draft.expectedFunding} NIM to the NimDrops custody address.
          </p>
        ) : null}

        {note}
      </div>
    </Screen>
  )
}

function Recover({
  title,
  body,
  action,
  onAction,
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
  quiet?: boolean
  /** A second way out, for a refusal that has two honest answers. */
  secondary?: string
  onSecondary?: () => void
  note?: ReactNode
  testId?: string
}) {
  return (
    <Screen>
      <div
        {...(testId ? { 'data-testid': testId } : {})}
        className="flex flex-1 flex-col justify-center py-16"
      >
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">{body}</p>
        <button type="button" onClick={onAction} className={quiet ? 'nd-secondary mt-8 w-full' : 'nd-primary mt-8 w-full'}>
          {action}
        </button>
        {secondary && onSecondary ? (
          <button type="button" onClick={onSecondary} className="nd-secondary mt-3 w-full">
            {secondary}
          </button>
        ) : null}

        {note}
      </div>
    </Screen>
  )
}

function NoWallet() {
  const here = typeof window === 'undefined' ? '' : window.location.href
  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Open this in Nimiq Pay</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
          NimDrops signs with your own wallet, so the drop has to be funded from inside Nimiq Pay.
        </p>
        <a href={nimiqPayDeeplink(here)} className="nd-primary mt-8 block w-full text-center">
          Open in Nimiq Pay
        </a>
      </div>
    </Screen>
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
function Live({
  draft,
  drop,
  sealMark,
  onStartAnother,
}: {
  draft: Draft
  drop: DropPublic | null
  sealMark: string
  onStartAnother: () => void
}) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return (
    <NdScreen>
      {/* Sealed, and about to be handed round: the same object the claimant
          will meet at the other end of the link. */}
      <Envelope open={false} {...(sealMark ? { sealMark } : {})}>
        <div className="pb-12">
          <p className="inline-flex rounded-full bg-gold/20 px-2.5 py-1 text-xs font-semibold text-gold-deep">
            Funded
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Your drop is live</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink/60">
            {drop
              ? `${drop.remaining} of ${drop.claimCount} shares of ${drop.amountEach} NIM are waiting. Share the link — the first ${drop.claimCount} wallets to open it each get one.`
              : 'Share the link. Each wallet that opens it can claim one fixed share.'}
          </p>

          <div data-testid="share-block" className="nd-rise">
            <div className="mt-8 rounded-3xl border border-ink/10 bg-white p-5">
              <img
                src={`/d/${draft.publicId}/qr.svg`}
                alt="QR code for this drop's link"
                width={220}
                height={220}
                className="mx-auto h-auto w-full max-w-[200px]"
              />
              <p className="mt-4 text-center text-xs break-all text-ink/60">{draft.shareUrl}</p>
            </div>

            <div className="mt-6 space-y-3">
              {canShare ? (
                <button
                  type="button"
                  className="nd-primary w-full"
                  onClick={() => {
                    // A dismissed share sheet rejects with AbortError; that is a
                    // choice, not a failure.
                    //
                    // `text` matters more here than anywhere else in the app.
                    // This is the primary distribution path, and WhatsApp
                    // routinely drops `title` and shows a bare link — so
                    // without it the product's one-line description never
                    // reaches the group chat, and the first thing a stranger
                    // sees is an unexplained URL asking them to sign something.
                    void navigator
                      .share({
                        title: 'A NimDrop for you',
                        text: 'One link. A fixed share of NIM for everyone who opens it.',
                        url: draft.shareUrl,
                      })
                      .catch(() => {})
                  }}
                >
                  Share
                </button>
              ) : null}
              <button
                type="button"
                className={canShare ? 'nd-secondary w-full' : 'nd-primary w-full'}
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

          <p className="mt-8 text-xs leading-relaxed text-ink/50">
            Unclaimed shares are refunded to the wallet that funded this drop, 24 hours after it
            went live.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink/50">
            Reopen NimDrops on this device to come back to this link.
          </p>

          <button
            type="button"
            onClick={onStartAnother}
            className="mt-5 min-h-12 w-full text-sm font-semibold text-ink/55"
          >
            Send another drop
          </button>
        </div>
      </Envelope>
    </NdScreen>
  )
}
