import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ApiError,
  createDrop,
  forgetDraftKeys,
  getDrop,
  submitFunding,
  type Draft,
  type DropPublic,
  type DropState,
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
 */

/** Design §4.2 step 5: poll the public state, do not guess. */
const POLL_MS = 3000

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
  | 'failed'

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

  const [reviewOpen, setReviewOpen] = useState(false)
  // Read once, synchronously, before the first paint: a sponsor who funded a
  // drop from this browser must never see the empty form flash past on the way
  // to their link.
  const [restored] = useState(readFunding)
  const [phase, setPhase] = useState<Phase>(restored ? 'resuming' : 'form')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drop, setDrop] = useState<DropPublic | null>(null)
  const [failure, setFailure] = useState('')

  const amountLuna = lunaFromNim(amountEach)
  const problem = capProblem(amountLuna, claimCount)
  const totalLuna = amountLuna === null ? null : amountLuna * BigInt(claimCount)
  const totalText = totalLuna === null || problem === 'amount' ? '—' : `${formatNim(totalLuna)} NIM`
  const ready = problem === null && sponsorLabel.trim().length > 0

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
    setReviewOpen(false)
    if (draftRef.current) {
      await approve(draftRef.current)
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
      setFailure(err instanceof ApiError ? err.message : 'we could not reach NimDrops just now')
      setPhase('failed')
      return
    }
    draftRef.current = created
    setDraft(created)
    await approve(created)
  }, [amountEach, approve, claimCount, message, sponsorLabel])

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

  if (phase === 'rejected' && draft) {
    return (
      <Recover
        title="Not approved"
        body="Your wallet closed without approving the transaction, so nothing was sent and nothing was charged."
        action="Try again"
        onAction={() => void approve(draft)}
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
    return <Progress phase={phase} draft={draft} />
  }

  return (
    <Screen>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Send a NimDrop</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink/60">
          One transaction from you. A fixed, equal share for everyone who opens the link.
        </p>
      </header>

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
      {problem === 'total' ? (
        <p className="mt-2 text-right text-xs text-ink/60">
          A drop can hold up to 100 NIM while NimDrops is new.
        </p>
      ) : null}

      <button
        type="button"
        disabled={!ready}
        onClick={() => setReviewOpen(true)}
        className="nd-primary mt-6 w-full"
      >
        Review drop
      </button>
      {/* §10.4 in one line on the create screen itself; the full disclosure is
          in the review sheet, before the wallet ever opens. */}
      <p className="mt-3 text-center text-xs text-ink/50">
        NimDrops holds your NIM until each share is claimed. Nothing is sent until you approve it in
        Nimiq Pay.
      </p>

      <Sheet
        open={reviewOpen}
        title="Before you fund"
        sealMark={sponsorLabel.trim().slice(0, 1).toUpperCase()}
        onClose={() => setReviewOpen(false)}
      >
        <dl className="divide-y divide-ink/10 text-sm">
          <Row label="Each person gets">{`${amountEach || '0'} NIM`}</Row>
          <Row label="People">{String(claimCount)}</Row>
          <Row label="You send">
            <span className="font-semibold">{totalText}</span>
          </Row>
          <Row label="Expires">24 hours after it goes live</Row>
        </dl>

        <Disclosure />

        <button type="button" onClick={() => void fund()} className="nd-primary mt-6 w-full">
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

/**
 * The disclosure design §10.4 requires on the create screen, in plain words:
 * who holds the money, what a claim is, when it expires, where the rest goes,
 * and what "paid" waits for.
 */
function Disclosure() {
  return (
    <div className="mt-5 rounded-2xl bg-ink/4 p-4 text-xs leading-relaxed text-ink/70">
      <p>
        Your NIM is <strong className="font-semibold text-ink">temporarily held</strong> by the NimDrops
        operator until each share is claimed. This is custody, not a smart contract.
      </p>
      <p className="mt-2">
        Shares are fixed and first come, first served — one per wallet. Nothing here proves a person is
        unique.
      </p>
      <p className="mt-2">
        The drop expires <strong className="font-semibold text-ink">24 hours</strong> after it goes live.
        Every unclaimed share is then{' '}
        <strong className="font-semibold text-ink">refunded to the wallet that funded</strong> it — the
        sender of your funding transaction, never an address typed into this app.
      </p>
      <p className="mt-2">
        Payouts and returns wait for chain confirmation, and can go to manual review during network or
        signer incidents.
      </p>
      <p className="mt-2">
        Wallet addresses and transactions are public on the Nimiq blockchain. NimDrops keeps only the
        minimum operational records described in its privacy note.
      </p>
    </div>
  )
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
    body: 'Reserving your campaign and the exact amount to fund.',
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

function Progress({ phase, draft }: { phase: Phase; draft: Draft | null }) {
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
}: {
  title: string
  body: string
  action: string
  onAction: () => void
  quiet?: boolean
}) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center py-16">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">{body}</p>
        <button type="button" onClick={onAction} className={quiet ? 'nd-secondary mt-8 w-full' : 'nd-primary mt-8 w-full'}>
          {action}
        </button>
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
                    void navigator
                      .share({ title: 'A NimDrop for you', url: draft.shareUrl })
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
