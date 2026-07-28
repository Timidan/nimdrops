/**
 * Play state for one trivia session.
 *
 * The countdown derives from the SERVER's `deadlineAt`, never from a local timer
 * start. A slow network would otherwise hand the player seconds the server will
 * refuse to honour, and the disagreement would surface as an unexplained
 * failure after the UI showed time remaining.
 *
 * Reaching zero does NOT auto-submit. The server already fails a late answer and
 * stays the single authority; auto-submitting would spend the player's one
 * submission on an arbitrary option.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getTriviaQuestion, startTriviaSession, submitTriviaAnswer } from '../api'
import type { ReviewedQuestion, TriviaQuestion } from '../api'

/**
 * A deliberate mirror of `COOLDOWN_MINUTES` in
 * `server/src/gates/trivia/sessions.ts`, in the same spirit as `money.ts`
 * mirroring the server's luna arithmetic.
 *
 * The server is authoritative and says the number itself when it refuses an
 * early retry. This copy exists because the failure screen has to state the
 * wait at the moment of failing, which is before any such refusal has happened
 * — and "try again later" is the kind of vagueness this product does not use.
 */
export const TRIVIA_COOLDOWN_MINUTES = 3

/** Global constraint: this kind serves five questions or none. */
export const TRIVIA_QUESTION_COUNT = 5

/**
 * Correct answers needed to pass, a deliberate mirror of `PASS_MIN_CORRECT`
 * in `server/src/gates/trivia/sessions.ts`. The score sets the payout:
 * score/5 of the share, so 3 pays 60%, 4 pays 80%, 5 pays it in full.
 */
export const TRIVIA_PASS_MIN_CORRECT = 3

export type TriviaPhase = 'idle' | 'playing' | 'passed' | 'failed'

export interface TriviaSession {
  phase: TriviaPhase
  question: TriviaQuestion | null
  /** Whole seconds until the server's deadline, clamped at 0. */
  secondsLeft: number
  answered: number
  questionCount: number
  /**
   * The finished session, question by question, or `null`.
   *
   * `null` for the whole of `idle` and `playing`, because the server sends it
   * only once the session is over. It stays `null` when the session ended
   * through a refused submission too: that path never received an outcome
   * body, and inventing an empty review would read on screen as "we have your
   * answers and none of them were anything".
   */
  review: ReviewedQuestion[] | null
  /**
   * How many were right, or `null` when no outcome has arrived.
   *
   * Carried separately from `review` because it is the ONLY score when the bank
   * withholds per-question verdicts — see `ReviewedQuestion.wasCorrect`.
   */
  correctCount: number | null
  error: string | null
  start(): Promise<void>
  submit(answerIndex: number): Promise<void>
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))
}

export function useTriviaSession(publicId: string, walletAddress: string): TriviaSession {
  const [phase, setPhase] = useState<TriviaPhase>('idle')
  const [question, setQuestion] = useState<TriviaQuestion | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [answered, setAnswered] = useState(0)
  const [questionCount, setQuestionCount] = useState(0)
  const [review, setReview] = useState<ReviewedQuestion[] | null>(null)
  const [correctCount, setCorrectCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionId = useRef<string | null>(null)

  // Re-derived from the deadline every tick, so a backgrounded tab that misses
  // ticks still shows the truth when it resumes rather than a stale count.
  useEffect(() => {
    if (phase !== 'playing' || !question) return
    setSecondsLeft(secondsUntil(question.deadlineAt))
    const id = setInterval(() => setSecondsLeft(secondsUntil(question.deadlineAt)), 250)
    return () => clearInterval(id)
  }, [phase, question])

  const start = useCallback(async () => {
    setError(null)
    setReview(null)
    setCorrectCount(null)
    try {
      const started = await startTriviaSession(publicId, walletAddress)
      sessionId.current = started.sessionId
      setQuestionCount(started.questionCount)
      setQuestion(await getTriviaQuestion(publicId, started.sessionId, walletAddress))
      setPhase('playing')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [publicId, walletAddress])

  const submit = useCallback(
    async (answerIndex: number) => {
      const id = sessionId.current
      const current = question
      if (!id || !current) return
      setError(null)
      try {
        const outcome = await submitTriviaAnswer(
          publicId,
          id,
          current.questionIndex,
          answerIndex,
          walletAddress,
        )
        setAnswered(outcome.answered)
        setQuestionCount(outcome.questionCount)
        if (outcome.state === 'in_progress') {
          setQuestion(await getTriviaQuestion(publicId, id, walletAddress))
          return
        }
        // Set BEFORE the phase, so the render that first shows an outcome
        // screen already carries the review it belongs to rather than
        // rendering once without it. Checked for shape rather than trusted:
        // `review` is optional in the contract, and anything that is not a
        // non-empty array is treated as "the server sent none", because a
        // review section is worth showing only when there is something in it.
        setReview(Array.isArray(outcome.review) && outcome.review.length > 0 ? outcome.review : null)
        // Shape-checked like `review`, and for the same reason: it is optional
        // in the contract, and a non-number would render as a score nobody got.
        setCorrectCount(typeof outcome.correctCount === 'number' ? outcome.correctCount : null)
        setPhase(outcome.state)
      } catch (err) {
        // A refused submission is terminal for this session: the one submission
        // per question is spent either way, so showing "playing" would invite a
        // second tap that cannot succeed.
        setError((err as Error).message)
        setPhase('failed')
      }
    },
    [publicId, question, walletAddress],
  )

  return {
    phase,
    question,
    secondsLeft,
    answered,
    questionCount,
    review,
    correctCount,
    error,
    start,
    submit,
  }
}
