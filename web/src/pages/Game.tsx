import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, submitPassphrase, type GateKind, type ReviewedQuestion } from '../api'
import { formatNim } from '../money'
import { clearStoredClaim } from '../state/claim'
import { ADDRESS_RE, PASSPHRASE_MAX_ATTEMPTS, useGate } from '../state/gate'
import {
  TRIVIA_COOLDOWN_MINUTES,
  TRIVIA_PASS_MIN_CORRECT,
  TRIVIA_QUESTION_COUNT,
  useTriviaSession,
} from '../state/trivia'
import { BridgeError, getBridge, nimiqPayDeeplink, resolveBridge } from '../sdk/adapter'
import { openInNimiqPay } from '../sdk/openApp'
import Field from '../ui/Field'
import { GetNimiqPay } from '../ui/OpenInApp'

/**
 * One page, three conditions: answer five questions, know a phrase, or be
 * vouched for by whoever runs the drop.
 *
 * **The pass screen is plain, and that is the load-bearing decision here.**
 * *The celebration belongs to the moment of receiving, and nowhere else.*
 * Meeting a condition is not receiving — nothing has moved and nothing has
 * been signed. So passing says "You can claim N NIM" and hands off to
 * `/drop/:publicId`, where the reveal already lives. A reveal here would both
 * steal that moment from the payout and use delight to hurry a stranger
 * toward a signature — which is the thing that makes a scam feel like one.
 *
 * **Nothing here is built on the sealed-paper component.** Three redesign
 * directions are live and undecided and one of them removes it entirely, so
 * these screens use `Field`, the paper and ink tokens, and the `nd-*` classes
 * in `index.css` — all of which survive every direction. A grep of this file for
 * that component's name comes back empty, and is meant to keep doing so.
 *
 * **The player's address is asked for, not derived.** `web/` has no way to read
 * an address from the wallet: `sdk/adapter.ts` deliberately does not call
 * `connect()`/`listAccounts()` because that costs a native prompt, and design
 * §4.3 derives the claimant's address from the verified `sign()` public key
 * instead — which happens on the claim, long after this page. The gate routes
 * take an asserted address by design, and it is safe precisely because a grant
 * is worthless to any address but the one it names.
 */

export interface GameProps {
  /** Test seam. Production remembers whatever the player last told us. */
  walletAddress?: string
}

/** `nimdrops.gate.wallet` → the address the player said they are playing as. */
export const WALLET_STORAGE_KEY = 'nimdrops.gate.wallet'

function readStoredWallet(): string | null {
  try {
    const raw = localStorage.getItem(WALLET_STORAGE_KEY)
    return raw && ADDRESS_RE.test(raw) ? raw : null
  } catch {
    // Private mode or a quota denial. Costs a re-ask, nothing more.
    return null
  }
}

function writeStoredWallet(address: string): void {
  try {
    localStorage.setItem(WALLET_STORAGE_KEY, address)
  } catch {
    /* the address still works for this page load */
  }
}

function clearStoredWallet(): void {
  try {
    localStorage.removeItem(WALLET_STORAGE_KEY)
  } catch {
    /* nothing to undo */
  }
}

/** What this drop asks of you, in the fewest words that are still true. */
const KIND_TITLES: Record<GateKind, string> = {
  trivia: 'Five questions',
  passphrase: 'A passphrase',
  attested: 'Confirmed by the organiser',
}

export default function Game({ walletAddress }: GameProps) {
  const { publicId = '' } = useParams()
  const [wallet, setWallet] = useState<string | null>(() => walletAddress ?? readStoredWallet())
  const gate = useGate(publicId, wallet ?? undefined)
  /**
   * Satisfied during this visit, as opposed to `gate.granted`, which was already
   * true when the page loaded. Lifted out of the kinds so the pass screen is the
   * WHOLE screen: leaving the offer above it would print the amount twice, and
   * leaving "use a different wallet" under it would invite somebody to switch to
   * a wallet that cannot claim what they just earned.
   */
  const [metJustNow, setMetJustNow] = useState(false)
  /**
   * The finished trivia session, lifted here for the same reason `metJustNow`
   * is: the pass screen replaces the whole screen, so the `Trivia` component
   * that held the review has already unmounted by the time the review is shown.
   * Only `trivia` ever supplies one — the other two kinds meet the condition
   * with nothing to look back at, so this stays null and nothing renders.
   */
  const [review, setReview] = useState<ReviewedQuestion[] | null>(null)
  const [correctCount, setCorrectCount] = useState<number | null>(null)
  /**
   * Threaded alongside `correctCount` for the same reason and by the same
   * path: it lives on the same finished-session outcome, and the pass screen
   * needs both to print "N of M right" rather than a bare count.
   */
  const [questionCount, setQuestionCount] = useState<number | null>(null)

  const rememberWallet = useCallback((address: string) => {
    writeStoredWallet(address)
    setWallet(address)
  }, [])

  const forgetWallet = useCallback(() => {
    clearStoredWallet()
    setWallet(null)
  }, [])

  const onMet = useCallback(
    (reviewed?: ReviewedQuestion[] | null, count?: number | null, total?: number | null) => {
      setMetJustNow(true)
      // Never cleared by a caller that has none: `Passphrase` and `Attested` pass
      // nothing, and a trivia pass can arrive in two renders if the phase lands
      // before the review does.
      if (reviewed && reviewed.length > 0) setReview(reviewed)
      if (typeof count === 'number') setCorrectCount(count)
      if (typeof total === 'number') setQuestionCount(total)
    },
    [],
  )

  const amount = gate.amountEachLuna === null ? null : formatNim(BigInt(gate.amountEachLuna))
  // A stored grant is still the terminal state for passphrase and attested
  // gates. Trivia is replayable: only a pass from this visit hands off to the
  // claim screen, while an older grant must not hide the game.
  const met = metJustNow || (gate.kind !== 'trivia' && gate.granted)

  return (
    <Field tone="live">
      <div className="nd-column">
        <div className="flex flex-1 flex-col px-5 pt-9 pb-12 text-chalk">
        {gate.loading && gate.kind === null ? (
          <Loading />
        ) : gate.kind === null ? (
          <LoadFailure
            publicId={publicId}
            code={gate.errorCode}
            message={gate.error}
            onRetry={gate.refresh}
          />
        ) : met ? (
          <Pass
            publicId={publicId}
            amount={amount ?? ''}
            review={review}
            correctCount={correctCount}
            questionCount={questionCount}
          />
        ) : (
          <>
            <Offer
              kind={gate.kind}
              tier={gate.tier}
              amount={amount ?? ''}
              slotsRemaining={gate.slotsRemaining}
            />

            {wallet === null ? (
              <WalletStep onSubmit={rememberWallet} />
            ) : (
              <>
                <PlayingAs address={wallet} onChange={forgetWallet} />
                {gate.kind === 'trivia' ? (
                  <Trivia publicId={publicId} walletAddress={wallet} onPass={onMet} />
                ) : gate.kind === 'passphrase' ? (
                  <Passphrase
                    publicId={publicId}
                    walletAddress={wallet}
                    hint={gate.hint}
                    onGranted={onMet}
                  />
                ) : (
                  <Attested onCheckAgain={gate.refresh} checking={gate.loading} />
                )}
              </>
            )}
          </>
        )}
        </div>
      </div>
    </Field>
  )
}

// ---- the offer, above every kind ---------------------------------------------------

/**
 * What is on the table and what it costs to reach it.
 *
 * The amount is the largest thing on the screen because it is the number the
 * reader is deciding about, in tabular figures so it cannot jitter, and exact — five NIM is `5`, two and a half is
 * `2.5`, and neither is ever rounded to look tidier.
 *
 * The share count is here rather than left to the claim screen because a player
 * is about to spend real effort: somebody who would answer five questions for
 * the last share deserves to know it is the last one first.
 */
function Offer({
  kind,
  tier,
  amount,
  slotsRemaining,
}: {
  kind: GateKind
  tier: string | null
  amount: string
  slotsRemaining: number | null
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <p className="text-sm font-semibold text-chalk/70">{KIND_TITLES[kind]}</p>
        {tier ? (
          <span className="rounded-full border border-chalk/15 px-2 py-0.5 text-[0.6875rem] font-medium text-chalk/55">
            {tier}
          </span>
        ) : null}
      </div>

      <p data-testid="game-amount" className="nd-amount nd-num mt-6 justify-center" data-size="md">
        {amount} NIM
      </p>
      <p className="mt-3 text-center text-xs leading-relaxed text-chalk/55">
        {kind === 'trivia' ? (
          <>Maximum payout. Your score decides how much you claim.</>
        ) : (
          <>The same fixed amount for everyone who meets this drop&rsquo;s condition.</>
        )}
      </p>
      {kind === 'trivia' ? <ScoreLadder /> : null}

      {slotsRemaining === null ? null : (
        <p data-testid="game-slots" className="mt-4 text-center text-xs tabular-nums text-chalk/55">
          {slotsRemaining} {slotsRemaining === 1 ? 'share' : 'shares'} left
        </p>
      )}
    </div>
  )
}

function ScoreLadder() {
  return (
    <p aria-label="Score payouts" className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[0.6875rem] tabular-nums text-chalk/60">
      <span><strong className="font-semibold text-chalk/80">3/5</strong> · 60%</span>
      <span><strong className="font-semibold text-chalk/80">4/5</strong> · 80%</span>
      <span><strong className="font-semibold text-chalk/80">5/5</strong> · 100%</span>
    </p>
  )
}

// ---- the pass screen: deliberately plain -------------------------------------------

/**
 * Met the condition. This is not the moment of receiving, so it does not look
 * like one: no keyline, no bloom, no exclamation. It states the fact, says what
 * happens next in the order it happens, and links to the screen that owns the
 * reveal.
 *
 * **The review sits BELOW the claim, and that ordering is the whole decision.**
 * It is information, not a trophy: it carries no score, no "five out of five"
 * and no praise, because a scoreboard here would turn meeting a condition into
 * the moment of receiving that belongs to the payout. Putting it above the
 * link would also push the primary action off a phone screen behind
 * five questions nobody has to read, which is the practical half of the same
 * rule: the claim is what this screen is for.
 */
function Pass({
  publicId,
  amount,
  review,
  correctCount,
  questionCount,
}: {
  publicId: string
  amount: string
  review: ReviewedQuestion[] | null
  correctCount: number | null
  questionCount: number | null
}) {
  return (
    <div data-testid="gate-passed" className="mt-9">
      <h1 className="text-2xl font-semibold tracking-tight">
        {correctCount !== null && correctCount < (questionCount ?? TRIVIA_QUESTION_COUNT)
          ? `You can claim ${Math.floor((correctCount / (questionCount ?? TRIVIA_QUESTION_COUNT)) * 100)}% of ${amount} NIM`
          : `You can claim ${amount} NIM`}
      </h1>
      {correctCount !== null ? (
        <p className="mt-2 text-sm leading-relaxed text-chalk/75">
          {correctCount} of {questionCount ?? TRIVIA_QUESTION_COUNT} right.
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        Nothing has been sent yet. Claim it on the drop&rsquo;s page with one signature.
      </p>
      <Link
        to={`/drop/${publicId}`}
        onClick={() => clearStoredClaim(publicId)}
        className="nd-action mt-8 block w-full text-center"
      >
        Go to the claim
      </Link>
      <p className="mt-3 text-center text-xs leading-relaxed text-chalk/50">
        This payout has to go to the wallet you played with.
      </p>

      <Review questions={review} correctCount={correctCount ?? undefined} />
    </div>
  )
}

// ---- what the questions were -------------------------------------------------------

/**
 * The finished session, question by question.
 *
 * Rendered identically on a pass and on a failure, because it is the same
 * information either way and a version that congratulated on one and consoled on
 * the other would be tone doing the work that facts should.
 *
 * **Nothing here is invented.** It renders `review` and only `review`: no score,
 * no tally, and no fallback prose when the server sent nothing — an absent
 * review renders an absent section. An option index the server's own `options`
 * array does not contain drops its line rather than printing `undefined` or
 * guessing, on the same principle.
 *
 * **Correctness is carried by words, not by hue.** Every row states its outcome
 * in text — "Correct", "Not correct", "Ran out of time" — with a mark beside it
 * that is `aria-hidden`, so the label is what both a screen reader and a
 * greyscale render receive. Assume red and green are indistinguishable to
 * some claimants. There is no colour coding at all here,
 * which also means nothing to fix for anyone who cannot see it.
 *
 * **There is no reveal.** No transition, no stagger, no expansion — the whole
 * section is in the first paint, so `prefers-reduced-motion` has nothing to
 * suppress and nobody gets a version of this screen with information missing
 * from it.
 */
function Review({
  questions,
  correctCount,
}: {
  questions: ReviewedQuestion[] | null
  correctCount?: number
}) {
  if (!questions || questions.length === 0) return null

  /**
   * Shown only when the per-question verdicts are withheld, and then it is the
   * ONLY score on the screen. With verdicts present the rows already say it
   * question by question, and repeating it as a tally would read as a grade —
   * which is ruled out on a screen that is about a payout.
   */
  const withheld = questions.every((q) => q.wasCorrect === null)
  const score = withheld && correctCount !== undefined ? correctCount : null

  return (
    <section
      data-testid="trivia-review"
      aria-labelledby="trivia-review-heading"
      className="mt-10 border-t border-chalk/10 pt-6"
    >
      <h2 id="trivia-review-heading" className="text-sm font-semibold tracking-tight text-chalk/75">
        Question by question
      </h2>
      {score === null ? null : (
        <p data-testid="trivia-score" className="mt-2 text-sm leading-relaxed text-chalk/65">
          You got <span className="font-medium text-chalk">{score}</span> of {questions.length} right.
          This set does not publish its answers, so we cannot say which.
        </p>
      )}
      <ol className="mt-5 flex flex-col gap-6">
        {questions.map((question) => (
          <ReviewRow key={question.questionIndex} question={question} />
        ))}
      </ol>
    </section>
  )
}

function ReviewRow({ question }: { question: ReviewedQuestion }) {
  /**
   * `answerIndex === null` is the ONLY thing that means the deadline passed with
   * nothing submitted, and it is not how a wrong answer is expressed. Reading it
   * as one would tell somebody who never saw the question that they got it wrong.
   */
  const outOfTime = question.answerIndex === null
  const chosen = question.answerIndex === null ? undefined : question.options[question.answerIndex]
  // `null` means the server withheld it, and that is routine rather than an
  // error — see `ReviewedQuestion.correctIndex`. Indexing an array with `null`
  // would have quietly produced `options[0]` and named the FIRST option as the
  // right one, which is worse than saying nothing.
  const correct = question.correctIndex === null ? undefined : question.options[question.correctIndex]
  /**
   * Answered, in time to be shown on screen, and still scored wrong for arriving
   * late. Without this the player who picked the right option one second over is
   * shown their own correct answer labelled "Not correct", which reads as a bug
   * in the scoring rather than as the clock running out.
   */
  const late = !outOfTime && question.wasLate

  /**
   * The server withheld its verdict on this question, because naming the option
   * the player chose as right or wrong is the same as naming the answer. Routine
   * for a bank the operator wrote themselves; the score comes from `correctCount`
   * instead. Note this is checked BEFORE `wasCorrect` is read anywhere, since
   * `null` is falsy and reading it as "not correct" would tell somebody they got
   * a question wrong on no evidence at all.
   */
  const noVerdict = question.wasCorrect === null

  /**
   * The server's verdict, never a comparison of the two indices. A late answer
   * arrives with the index the player picked and is scored wrong, so the indices
   * can agree while `wasCorrect` is false — and the scoring is what decided the
   * outcome of this session.
   */
  const label = outOfTime
    ? 'Ran out of time'
    : late
      ? 'Too late'
      : noVerdict
        ? 'Answered'
        : question.wasCorrect
          ? 'Correct'
          : 'Not correct'
  const mark = outOfTime || late ? '–' : noVerdict ? '·' : question.wasCorrect ? '✓' : '✕'

  return (
    <li data-testid={`review-${question.questionIndex}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold tabular-nums text-chalk/55">
          Question {question.questionIndex + 1}
        </p>
        {/**
         * One class list for all three outcomes, deliberately. There is nothing
         * to strip out in greyscale because there is no hue here to begin with,
         * and a test can prove it by comparing two rows' `className`.
         */}
        <p
          data-testid={`review-${question.questionIndex}-outcome`}
          className="text-xs font-semibold text-chalk/75"
        >
          <span aria-hidden="true" className="mr-1">
            {mark}
          </span>
          {label}
        </p>
      </div>

      <p className="mt-2 text-sm leading-snug font-medium text-chalk">{question.prompt}</p>

      {outOfTime ? (
        <p className="mt-2 text-sm leading-relaxed text-chalk/65">
          You ran out of time on this one, so no answer was recorded.
        </p>
      ) : chosen === undefined ? null : (
        <p className="mt-2 text-sm leading-relaxed text-chalk/65">
          You chose <span className="font-medium text-chalk">{chosen}</span>
          {late ? ', but the clock had already run out.' : '.'}
        </p>
      )}

      {correct === undefined ? null : (
        <p className="mt-1 text-sm leading-relaxed text-chalk/65">
          The right answer is <span className="font-medium text-chalk">{correct}</span>.
        </p>
      )}
    </li>
  )
}

// ---- which wallet is playing -------------------------------------------------------

/**
 * The one thing this page has to ask for.
 *
 * It comes after the offer, never before it: a stranger should learn what this
 * is before being asked for anything.
 *
 * The address is READ FROM THE WALLET, not typed. This was a text field, on the
 * reasoning that the page should not spend a native prompt on a condition the
 * player has not met yet — but the cost of that reasoning was asking someone to
 * copy thirty-six characters on a phone, and "without typing an address" is
 * part of what success looks like. One tap on a wallet dialog is
 * cheaper than that for everyone, and it cannot be mistyped.
 *
 * The prompt is bought here and nowhere else. `WalletBridge.address()` is not
 * called from `ready()`, and the ordinary claim path never calls it at all, so a
 * claimant on an ungated drop still meets exactly one prompt in the whole flow.
 */
/** The current page as an https URL, or null when there is no window (SSR). */
function selfUrl(): string | null {
  if (typeof window === 'undefined') return null
  return window.location.href.replace(/^http:/, 'https:')
}

function WalletStep({ onSubmit }: { onSubmit: (address: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  // Set once we know this page is open OUTSIDE Nimiq Pay. The wallet bridge only
  // exists inside the app, so a browser tab cannot read an address at all — the
  // honest next step is to reopen this exact page in Nimiq Pay, not to prompt for
  // a wallet that is not there. Held in state rather than read at render because
  // `getBridge()` is the same probe `ask()` already uses.
  const [needsApp, setNeedsApp] = useState(false)
  const url = selfUrl()

  // Probe once on mount, so a reader who arrived in a browser sees "Open in
  // Nimiq Pay" straight away rather than a wallet button that leads nowhere.
  // `resolveBridge` waits out the provider-injection race instead of trusting a
  // synchronous snapshot, and it only detects presence — it does not read an
  // address, so nothing prompts the wallet here.
  useEffect(() => {
    let alive = true
    void resolveBridge().then((r) => {
      if (alive && r.kind === 'unavailable') setNeedsApp(true)
    })
    return () => {
      alive = false
    }
  }, [])

  async function ask() {
    setBusy(true)
    setProblem('')
    try {
      const result = getBridge()
      if (result.kind === 'unavailable') {
        // Was a dead end: a line of copy telling the reader to open in Nimiq Pay
        // and no way to do it. The deeplink reopens THIS url inside the app,
        // where the bridge exists and the wallet can answer.
        setNeedsApp(true)
        return
      }
      onSubmit(await result.bridge.address())
    } catch (cause) {
      // Never "your wallet refused you". Declining is a legitimate answer, and
      // the claimant declining in Nimiq Pay is not an error state we scold.
      setProblem(
        cause instanceof BridgeError && cause.type === 'provider_error'
          ? 'No address was shared, so there is nothing to record this against yet. Try again when you are ready.'
          : 'We could not read your address. Nothing was sent and nothing was signed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="wallet-step" className="mt-8">
      <h1 className="text-lg font-semibold tracking-tight">Play with your Nimiq wallet</h1>
      <p className="mt-2 text-sm leading-relaxed text-chalk/65">
        Nimiq Pay shares your wallet address so your score and claim stay together, and only that
        wallet can claim. Nothing is signed or sent until you claim.
      </p>

      {problem ? (
        <p data-testid="wallet-problem" role="alert" className="mt-4 text-xs leading-relaxed text-chalk/75">
          {problem}
        </p>
      ) : null}

      {needsApp ? (
        <div data-testid="open-in-app" className="mt-6">
          <p className="text-sm leading-relaxed text-chalk/65">
            Open this page in Nimiq Pay to connect your wallet and play.
          </p>
          {url ? (
            <button
              type="button"
              data-testid="open-in-app-cta"
              onClick={() => openInNimiqPay({ deeplink: nimiqPayDeeplink(url) })}
              className="nd-action mt-4 w-full"
            >
              Open in Nimiq Pay
            </button>
          ) : null}
          <div className="mt-6">
            <GetNimiqPay />
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="connect-wallet"
          disabled={busy}
          onClick={() => void ask()}
          className="nd-action mt-6 w-full disabled:opacity-60"
        >
          {busy ? 'Waiting for your wallet…' : 'Use my wallet'}
        </button>
      )}
    </div>
  )
}

function PlayingAs({ address, onChange }: { address: string; onChange: () => void }) {
  return (
    <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-chalk/10 pt-4">
      <p className="min-w-0 text-xs leading-relaxed text-chalk/55 [overflow-wrap:anywhere]">
        Playing as <span className="font-medium text-chalk/75">{address}</span>
      </p>
      <button
        type="button"
        data-testid="change-wallet"
        onClick={onChange}
        className="nd-textlink shrink-0"
      >
        Use a different wallet
      </button>
    </div>
  )
}

// ---- kind: trivia -------------------------------------------------------------------

function Trivia({
  publicId,
  walletAddress,
  onPass,
}: {
  publicId: string
  walletAddress: string
  onPass: (
    review: ReviewedQuestion[] | null,
    correctCount: number | null,
    questionCount: number | null,
  ) => void
}) {
  const session = useTriviaSession(publicId, walletAddress)
  const [submitting, setSubmitting] = useState(false)

  // Told upwards rather than rendered here, so the pass screen is the whole
  // screen rather than a panel under the offer it has just been earned from.
  // The review travels with it: this component unmounts on a pass, and the
  // review belongs to the screen that replaces it.
  const passed = session.phase === 'passed'
  const passedReview = passed ? session.review : null
  // Travels with the review, because it IS the review when the bank withholds
  // its per-question verdicts — see `ReviewedQuestion.wasCorrect`.
  const passedCount = passed ? session.correctCount : null
  // Same object, same reason: the fraction on the pass screen needs both the
  // count and the total it is out of.
  const passedTotal = passed ? session.questionCount : null
  useEffect(() => {
    if (passed) onPass(passedReview, passedCount, passedTotal)
  }, [onPass, passed, passedReview, passedCount, passedTotal])
  if (passed) return null

  if (session.phase === 'failed') {
    return (
      <div data-testid="trivia-failed" className="mt-8">
        <h1 className="text-2xl font-semibold tracking-tight">This attempt has ended</h1>
        <p className="mt-3 text-sm leading-relaxed text-chalk/65">
          {session.error ??
            (session.correctCount != null
              ? `You got ${session.correctCount} of ${session.questionCount} right. You need ${TRIVIA_PASS_MIN_CORRECT} to win.`
              : `You answered ${session.answered} of ${session.questionCount}.`)}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-chalk/65">
          Try again in {TRIVIA_COOLDOWN_MINUTES} minutes. Nothing was signed and nothing was sent.
        </p>
        <Link to="/games" className="nd-quiet mt-8 block w-full text-center">
          See the other drops
        </Link>

        <Review questions={session.review} correctCount={session.correctCount ?? undefined} />
      </div>
    )
  }

  if (session.phase === 'playing' && session.question) {
    const question = session.question
    const timeUp = session.secondsLeft === 0
    return (
      <div data-testid="trivia-playing" className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <p data-testid="question-progress" className="text-sm font-semibold tabular-nums text-chalk/70">
            {question.questionIndex + 1} of {session.questionCount || question.questionCount}
          </p>
          <p className="text-xs font-medium text-chalk/55">{question.category}</p>
        </div>

        <Countdown secondsLeft={session.secondsLeft} />

        <h1 className="mt-6 text-xl leading-snug font-semibold tracking-tight">{question.prompt}</h1>

        {/* Four large targets, 52px tall with 12px between them. */}
        <div className="mt-6 flex flex-col gap-3">
          {question.options.map((option, index) => (
            <button
              key={option}
              type="button"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true)
                void session.submit(index).finally(() => setSubmitting(false))
              }}
              className="nd-option"
            >
              {option}
            </button>
          ))}
        </div>

        {/**
         * Zero does not submit anything. The server already refuses a late
         * answer and stays the authority; picking an option on the player's
         * behalf would spend their one submission on something they did not
         * choose. So the buttons stay live and the screen says where they stand.
         */}
        {timeUp ? (
          <p data-testid="time-up" className="mt-4 text-sm leading-relaxed text-chalk/65">
            Time is up on this question. You can still answer, but the server may not accept it.
          </p>
        ) : null}

        {session.error ? (
          <p role="alert" className="mt-4 text-sm leading-relaxed text-chalk/75">
            {session.error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div data-testid="trivia-idle" className="mt-8">
      <h1 className="text-lg font-semibold tracking-tight">
        {TRIVIA_QUESTION_COUNT} questions, four options each
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-chalk/65">
        Get {TRIVIA_PASS_MIN_CORRECT} or more right. The server times each question, with the
        countdown on screen while you answer.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-chalk/65">
        Nothing is signed while you play. If you pass, you claim on this drop&rsquo;s own page. The
        wallet approval comes after, not now.
      </p>

      <button
        type="button"
        onClick={() => void session.start()}
        className="nd-action mt-8 w-full"
      >
        Start
      </button>

      <p className="mt-5 text-center text-[0.6875rem] leading-relaxed text-chalk/45">
        Some questions are adapted from{' '}
        <a href="https://opentdb.com/" target="_blank" rel="noreferrer" className="underline">
          Open Trivia DB
        </a>{' '}
        under{' '}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          CC BY-SA 4.0
        </a>
        . They may be filtered, reordered, or retiered.
      </p>

      {session.error ? (
        <p data-testid="trivia-start-error" role="alert" className="mt-4 text-sm leading-relaxed text-chalk/75">
          {session.error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The seconds the SERVER will honour, and a bar that shows them at a glance.
 *
 * The number is plain text driven by state, so it keeps counting under
 * `prefers-reduced-motion` — the global block in `index.css` zeroes the bar's
 * transition and nothing else. A countdown that stopped counting because
 * animation was off would be a correctness bug wearing a visual costume, and
 * timers are held to AA contrast for the same reason amounts are: misreading
 * one has consequences.
 */
function Countdown({ secondsLeft }: { secondsLeft: number }) {
  return (
    <div className="mt-4">
      <span
        data-testid="countdown"
        role="timer"
        className="text-sm font-semibold tabular-nums text-chalk"
      >
        {secondsLeft}s
      </span>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-chalk/10">
        <div
          aria-hidden="true"
          className="h-full rounded-full bg-chalk/70 transition-[width] duration-300 ease-linear"
          style={{ width: `${Math.min(100, secondsLeft * 10)}%` }}
        />
      </div>
    </div>
  )
}

// ---- kind: passphrase ---------------------------------------------------------------

function Passphrase({
  publicId,
  walletAddress,
  hint,
  onGranted,
}: {
  publicId: string
  walletAddress: string
  hint: string | null
  onGranted: () => void
}) {
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ReactNode>(null)
  /**
   * This page's own count of wrong tries, not the server's.
   *
   * The server counts per address per drop over an hour and does not return the
   * tally, so this is the only number available at the moment of a wrong
   * guess. It can only ever be an under-count — tries from another device or
   * before a reload are invisible to it — which is why the server's own
   * `too_many_attempts` sentence replaces this line the moment it arrives.
   */
  const [wrong, setWrong] = useState(0)

  return (
    <form
      data-testid="passphrase-form"
      className="mt-8"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || phrase.trim() === '') return
        setBusy(true)
        setNotice(null)
        // Called with no arguments on purpose. `.then(onGranted)` would hand the
        // response body straight to a callback that now takes a trivia review.
        void submitPassphrase(publicId, walletAddress, phrase)
          .then(() => onGranted())
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === 'bad_attempt') {
              const used = wrong + 1
              const left = Math.max(0, PASSPHRASE_MAX_ATTEMPTS - used)
              setWrong(used)
              setNotice(
                <>
                  That is not it.{' '}
                  <span className="tabular-nums">
                    {left} of {PASSPHRASE_MAX_ATTEMPTS} tries left.
                  </span>
                </>,
              )
              return
            }
            if (err instanceof ApiError) {
              // The server's own sentence, including the hour-long refusal.
              setNotice(err.message)
              return
            }
            setNotice('We could not reach NimDrops just now. Nothing was counted against you.')
          })
          .finally(() => setBusy(false))
      }}
    >
      <h1 className="text-lg font-semibold tracking-tight">Know the phrase, claim a share</h1>
      {hint ? (
        <p data-testid="passphrase-hint" className="mt-3 border-l-2 border-chalk/25 pl-4 text-sm leading-relaxed text-chalk/70">
          {hint}
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        Capital letters and extra spaces do not matter. Nothing is signed here. If the phrase is
        right, you claim on the drop&rsquo;s own page.
      </p>

      <label htmlFor="gate-phrase" className="mt-6 block text-sm font-medium text-chalk/70">
        The phrase
      </label>
      <input
        id="gate-phrase"
        name="phrase"
        value={phrase}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setPhrase(event.target.value)}
        className="nd-input mt-2"
      />

      <button type="submit" disabled={busy || phrase.trim() === ''} className="nd-action mt-6 w-full">
        Check the phrase
      </button>

      {notice ? (
        <p data-testid="passphrase-notice" role="alert" className="mt-4 text-sm leading-relaxed text-chalk/75">
          {notice}
        </p>
      ) : null}
    </form>
  )
}

// ---- kind: attested -----------------------------------------------------------------

/**
 * Nothing to answer. A third party decides who is eligible and tells the server
 * with a signed message, so the player has no step at all — and the screen says
 * that plainly instead of showing an input that would do nothing.
 */
function Attested({ onCheckAgain, checking }: { onCheckAgain: () => void; checking: boolean }) {
  return (
    <div data-testid="attested" className="mt-8">
      <h1 className="text-lg font-semibold tracking-tight">The organiser confirms this one</h1>
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        Whoever runs this drop decides who can claim it and confirms it themselves. There is nothing
        here to answer and nothing to sign.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        For the wallet you named, that confirmation has not happened yet. When it does, this page
        says you can claim.
      </p>
      <button
        type="button"
        data-testid="attested-recheck"
        disabled={checking}
        onClick={onCheckAgain}
        className="nd-quiet mt-8 w-full"
      >
        Check again
      </button>
    </div>
  )
}

// ---- the page could not be read ------------------------------------------------------

function Loading() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-24 text-center">
      <div className="nd-beacon nd-pulse" aria-hidden="true" />
      <p className="mt-6 text-sm text-chalk/55">Opening…</p>
    </div>
  )
}

/**
 * Two different dead ends, told apart by the code rather than the sentence.
 *
 * `not_a_game` is the common one and is not an error at all: somebody was sent
 * a `/game/` link for an ordinary drop, and the useful answer is the drop.
 */
function LoadFailure({
  publicId,
  code,
  message,
  onRetry,
}: {
  publicId: string
  code: string | null
  message: string | null
  onRetry: () => void
}) {
  if (code === 'not_a_game' || code === 'not_found') {
    return (
      <div data-testid="not-a-game" className="flex flex-1 flex-col justify-center pb-16">
        <h1 className="text-2xl font-semibold tracking-tight">Nothing to meet here</h1>
        <p className="mt-3 text-sm leading-relaxed text-chalk/65">
          This drop does not ask anything of you. If it is still live, you can claim from its own
          page.
        </p>
        <Link to={`/drop/${publicId}`} className="nd-action mt-8 block w-full text-center">
          Open the drop
        </Link>
      </div>
    )
  }

  return (
    <div data-testid="game-unavailable" className="flex flex-1 flex-col justify-center pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">We could not open this</h1>
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        {message ?? 'Something went wrong on our side.'}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-chalk/65">
        Nothing has been lost and nothing was signed.
      </p>
      <button type="button" onClick={onRetry} className="nd-action mt-8 w-full">
        Try again
      </button>
    </div>
  )
}
