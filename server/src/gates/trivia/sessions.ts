/**
 * Kind `trivia`: five timed questions, then a grant (spec §4.6).
 *
 * The only trivia module that touches Postgres. It owns the session state
 * machine, question delivery, deadline enforcement and scoring. It does NOT
 * decide whether a claim may proceed — `services/claims.ts` does that, inside the
 * allocation transaction, because that is the only place the recipient address is
 * known to be derived from a verified signature.
 *
 * A session starts under a CLIENT-ASSERTED wallet address and requires no
 * signature. That is safe because passing as address X only ever benefits the
 * holder of X: `reserveClaim` compares `gate_grants.wallet_address` against the
 * address derived from the claim signature. Requiring a signature here would cost
 * the player a native wallet prompt before they have received anything.
 *
 * Two rules here are load-bearing rather than tidy, and both come from §7.2:
 *
 *  - **A retry serves the IDENTICAL question set**, because selection is
 *    deterministic per (drop, wallet).
 *  - **Per-question correctness is never returned.** {@link AnswerOutcome} is
 *    `state`, `answered` and `questionCount` and nothing else. Those two rules
 *    only work together: 4^5 = 1024 guaranteed attempts against a fixed set
 *    collapses to about twenty if a player learns which of the five was wrong.
 *
 * Dependency direction: this module imports from `gates/` only, never from
 * `services/`, which is what keeps the one-way arrow in `gates/types.ts` from
 * becoming a cycle.
 */
import type { Pool, PoolClient } from 'pg'
import { normaliseNimiqAddress } from '../../nimiq-address'
import { issueGrant } from '../grants'
import { GateError, GateRejectedError, type GateRow, assertGameLive } from '../types'
import { type Bank, OPTIONS_PER_QUESTION, type Tier } from './bank'
import { selectQuestionIds } from './select'

/** A session abandoned mid-play stops being resumable after this long. */
export const SESSION_TTL_MINUTES = 10

/**
 * Minimum gap between two sessions on one drop for one wallet, measured from the
 * previous session's `started_at`.
 *
 * This is the multiplier on the brute-force floor: guaranteed brute force is
 * 4^5 = 1024 attempts, each costing five deadlines of wall clock; a ten-minute
 * gap between attempts pushes that well past the 24-hour life of a drop. It is a
 * policy window rather than an invariant, so it lives here and not in a database
 * constraint.
 */
export const COOLDOWN_MINUTES = 10

/**
 * The only `questionCount` this kind will serve.
 *
 * Not a tuning knob. The eligibility argument in spec §3 is that pure guessing
 * succeeds at `0.25^5 = 0.098%`, three orders of magnitude below skill. Three
 * questions would be `0.25^3 = 1.6%`, which is close enough to a coin flip that
 * the argument stops holding — so a drop configured with anything else is refused
 * outright rather than quietly served short.
 */
const REQUIRED_QUESTION_COUNT = 5

const TIERS: readonly Tier[] = ['novice', 'easy', 'medium', 'hard']

/**
 * Validated `drop_gates.config` for a trivia gate.
 *
 * `unlockRequiresTier` is enforced in {@link TriviaService.startOrResume} — see
 * `assertTierUnlocked` — and is also what a listed game shows as its
 * requirement, so a locked game still renders with its payout visible.
 */
export interface TriviaConfig {
  tier: Tier
  bankVersion: string
  questionCount: number
  secondsPerQuestion: number
  unlockRequiresTier: Tier | null
}

export interface StartedSession {
  sessionId: string
  questionCount: number
  secondsPerQuestion: number
  deliveredCount: number
}

export interface DeliveredQuestion {
  questionIndex: number
  prompt: string
  options: string[]
  category: string
  /** Stamped by the server at delivery. Re-reading does not extend it. */
  deadlineAt: Date
  questionCount: number
}

/**
 * The result of one submission.
 *
 * There is no `isCorrect`, no per-question score array and no reveal of the right
 * answer. More importantly, `state` says nothing about the answer just submitted:
 * it stays `in_progress` for every question until the last one, and only then
 * becomes `passed` or `failed`.
 *
 * Withholding the field is not enough on its own, and the first version of this
 * proved it. A `state` that flipped to `failed` the moment an answer was wrong
 * WAS per-question correctness, whatever it was called, and it collapsed brute
 * force from 1024 attempts to sixteen. See `submitAnswer` for the arithmetic.
 */
export interface AnswerOutcome {
  state: 'in_progress' | 'passed' | 'failed'
  answered: number
  questionCount: number
  /**
   * The finished session, question by question. Present ONLY when `state` is no
   * longer `in_progress`, and absent while a question is still in play.
   *
   * Safe to send precisely because a wallet never meets a question twice — see
   * `trivia_seen` and `selectQuestionIds`. Without that rule this field would be
   * the whole answer key: test one option across all five, read the verdicts,
   * repeat, and pass on the fourth attempt knowing nothing.
   */
  review?: ReviewedQuestion[]
}

export interface ReviewedQuestion {
  questionIndex: number
  prompt: string
  options: string[]
  /** What the player chose. Null if the deadline passed with no submission. */
  answerIndex: number | null
  correctIndex: number
  wasCorrect: boolean
  /**
   * The answer arrived after its deadline, so it was scored wrong whatever it said.
   *
   * Needed because `wasCorrect` is NOT `answerIndex === correctIndex`: a late
   * answer commits the index the player chose and is still scored wrong. Without
   * this flag a player who picked the right option one second late is shown their
   * own correct answer labelled "not correct", which reads as a bug in the
   * scoring rather than as the clock running out.
   */
  wasLate: boolean
}

export interface TriviaService {
  startOrResume(gate: GateRow, walletAddress: string): Promise<StartedSession>
  currentQuestion(
    sessionId: string,
    dropId?: string,
    walletAddress?: string,
  ): Promise<DeliveredQuestion>
  submitAnswer(
    sessionId: string,
    questionIndex: number,
    answerIndex: number,
    dropId?: string,
    walletAddress?: string,
  ): Promise<AnswerOutcome>
}

type SessionState = 'in_progress' | 'passed' | 'failed' | 'expired'

/**
 * Session ids reach this module from a URL. A non-uuid would make Postgres raise
 * `invalid input syntax for type uuid`, which is a 500 for what is really a
 * caller mistake, so the shape is checked before it becomes SQL.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function misconfigured(what: string): never {
  // Was a bare `GateError`, on the reasoning that no rejection code described an
  // operator's typo honestly. That was true, and the fix was to add the code
  // rather than keep raising something the layer above reads as an outage.
  //
  // Still fails closed, and the HTTP layer still answers 5xx: nothing the player
  // did is wrong, so a 4xx would blame them, but the deployment IS broken and an
  // operator has to see it.
  throw new GateRejectedError('misconfigured', `trivia gate is misconfigured: ${what}`)
}

/**
 * @param loadedBankVersion the version of the bank this process actually holds.
 *   Optional so the pure config cases can call this without one, and passed at
 *   every call site inside {@link makeTrivia}.
 */
export function parseTriviaConfig(
  config: Record<string, unknown>,
  loadedBankVersion?: string,
): TriviaConfig {
  const { tier, bankVersion, questionCount, secondsPerQuestion, unlockRequiresTier } = config

  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) {
    misconfigured(`tier ${String(tier)} is not one of ${TIERS.join(', ')}`)
  }
  if (typeof bankVersion !== 'string' || bankVersion.length === 0) {
    misconfigured('bankVersion is missing')
  }
  // A drop configured for one bank version, served by another, silently asks
  // different questions than the operator set up — the same class of quiet
  // misconfiguration the questionCount rule exists to stop, so it fails the same
  // way. Selection seeds on the LOADED version, so without this the configured
  // value was validated as a non-empty string and then ignored.
  if (loadedBankVersion !== undefined && bankVersion !== loadedBankVersion) {
    misconfigured(
      `configured for bank ${bankVersion} but this deployment loaded ${loadedBankVersion}`,
    )
  }
  // Fails closed. See REQUIRED_QUESTION_COUNT.
  if (questionCount !== REQUIRED_QUESTION_COUNT) {
    misconfigured(
      `questionCount is ${String(questionCount)}, and this kind serves ` +
        `${REQUIRED_QUESTION_COUNT} questions or none`,
    )
  }
  if (
    typeof secondsPerQuestion !== 'number' ||
    !Number.isInteger(secondsPerQuestion) ||
    secondsPerQuestion <= 0
  ) {
    misconfigured(
      `secondsPerQuestion ${String(secondsPerQuestion)} must be a positive whole number`,
    )
  }
  if (
    unlockRequiresTier !== undefined &&
    unlockRequiresTier !== null &&
    (typeof unlockRequiresTier !== 'string' || !TIERS.includes(unlockRequiresTier as Tier))
  ) {
    misconfigured(`unlockRequiresTier ${String(unlockRequiresTier)} is not a tier`)
  }

  return {
    tier: tier as Tier,
    bankVersion,
    questionCount,
    secondsPerQuestion,
    unlockRequiresTier: (unlockRequiresTier ?? null) as Tier | null,
  }
}

interface SessionRow {
  id: string
  drop_id: string
  wallet_address: string
  state: SessionState
  question_ids: string[]
  delivered_count: number
  expired: boolean
  kind: string
  config: Record<string, unknown>
}

export function makeTrivia(o: { pool: Pool; bank: Bank; salt: string }): TriviaService {
  const { pool, bank, salt } = o

  /**
   * Lazily retire a session past its expiry.
   *
   * No sweeper job and no worker change: expiry is evaluated on the next request
   * that touches the session. `expired` and `failed` are distinct only so an
   * operator can tell abandonment from a wrong answer; neither is claimable.
   */
  async function retireIfExpired(db: PoolClient, sessionId: string): Promise<void> {
    await db.query(
      `UPDATE trivia_sessions
       SET state = 'expired', completed_at = now()
       WHERE id = $1 AND state = 'in_progress' AND expires_at <= now()`,
      [sessionId],
    )
  }

  /** The question this session was built from, or a hard failure. */
  function questionById(sessionId: string, questionId: string) {
    const question = bank.questions.find((q) => q.id === questionId)
    if (!question) {
      // The bank changed under a live session. Fail closed rather than serve a
      // question this session was not built from — the alternative silently
      // changes the set a retry is supposed to reproduce.
      throw new GateError(`session ${sessionId} references unknown question ${questionId}`)
    }
    return question
  }

  /**
   * Tier progression (spec §4.6): Medium needs a pass at Easy or above, Hard
   * needs Medium, and Novice and Easy are always open because nothing precedes
   * them.
   *
   * "A pass" is a `kind = 'trivia'` grant, on ANY drop — not a passed session
   * row and not a grant of another kind. Both restrictions are load-bearing:
   * sessions are retried and a `passed` row on a drop whose grant was never
   * written would be a pass the money path never saw, and a `passphrase` grant
   * says a wallet heard a word at a meetup, which is no evidence about trivia.
   *
   * The comparison runs on `array_position` over the tier ladder rather than on
   * text, so `medium >= easy` means what the ladder says rather than what the
   * alphabet says. `array_position` answers NULL for a tier the ladder does not
   * name, and `NULL >= n` is NULL, so a gate carrying a junk tier unlocks
   * nothing — it fails closed, exactly as `parseTriviaConfig` does.
   *
   * Runs inside the caller's transaction, under the same advisory lock as the
   * rest of `startOrResume`: the unlock and the session it authorises must be
   * decided against one snapshot, or two tabs could each read "locked" and one
   * still get a session out of it.
   */
  async function assertTierUnlocked(
    db: PoolClient,
    requiredTier: Tier,
    walletAddress: string,
  ): Promise<void> {
    const { rows } = await db.query<{ unlocked: boolean }>(
      `SELECT true AS unlocked
       FROM gate_grants gg
       JOIN drop_gates dg ON dg.drop_id = gg.drop_id
       WHERE gg.wallet_address = $1
         AND gg.kind = 'trivia'
         AND array_position($3::text[], dg.config->>'tier')
             >= array_position($3::text[], $2::text)
       LIMIT 1`,
      [walletAddress, requiredTier, [...TIERS]],
    )
    if (rows.length === 0) {
      // Names the requirement, because a player who cannot see what unlocks a
      // game has been given a locked door and no sign on it. It names no wallet
      // and no other drop.
      throw new GateRejectedError(
        'tier_locked',
        `this game opens after a pass at ${requiredTier} or above`,
      )
    }
  }

  /**
   * @param expectDropId when given, the session must belong to this drop.
   *   The HTTP routes carry a `publicId` AND a `sessionId`, and without this the
   *   two were never compared: a session for drop A could be played through drop
   *   B's URL. Nothing was stealable that way — the grant lands on drop A for the
   *   session's own wallet either way — but a route whose path segments contradict
   *   each other should say so rather than quietly honour one and ignore the
   *   other.
   * @param expectWallet when given, the session must belong to this wallet.
   *   Session ids are v4 uuids and so unguessable, but they are not secrets: they
   *   sit in URLs, referrers and access logs. Holding one used to be sufficient to
   *   drive the session, and a single wrong answer imposes a ten-minute cooldown
   *   on the wallet — so a leaked id was a remote "end that player's run" button.
   *   Requiring the address does not make it secret (the client asserts it
   *   anyway); it makes the leaked id alone useless, which is the exposure.
   */
  async function loadSession(
    db: PoolClient,
    sessionId: string,
    expectDropId?: string,
    expectWallet?: string,
  ): Promise<SessionRow> {
    if (!UUID_RE.test(sessionId)) {
      throw new GateRejectedError('session_not_found', 'no such session')
    }
    const { rows } = await db.query<SessionRow>(
      `SELECT s.id, s.drop_id, s.wallet_address, s.state, s.question_ids, s.delivered_count,
              s.expires_at <= now() AS expired,
              g.kind, g.config
       FROM trivia_sessions s
       JOIN drop_gates g ON g.drop_id = s.drop_id
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) throw new GateRejectedError('session_not_found', 'no such session')
    if (row.kind !== 'trivia') {
      throw new GateRejectedError('wrong_kind', 'this drop does not use trivia')
    }
    // Same code as an unknown id, on purpose: a caller who guesses a real session
    // id under the wrong drop learns nothing it did not already have.
    if (expectDropId !== undefined && row.drop_id !== expectDropId) {
      throw new GateRejectedError('session_not_found', 'no such session')
    }
    // Also `session_not_found`, and for the same reason: a holder of a leaked
    // session id must not be able to tell "no such session" from "right session,
    // wrong wallet", or the route becomes an oracle for which wallet owns an id.
    //
    // Both sides are normalised before comparing. The stored value is normalised
    // on the way in now, but rows written before that was true may hold a spaced
    // or lowercased spelling of the same address, and locking a player out of
    // their own session over whitespace would be a worse bug than the one this
    // parameter closes.
    if (expectWallet !== undefined) {
      const expected = normaliseNimiqAddress(expectWallet) ?? expectWallet
      const owner = normaliseNimiqAddress(row.wallet_address) ?? row.wallet_address
      if (owner !== expected) {
        throw new GateRejectedError('session_not_found', 'no such session')
      }
    }
    return row
  }

  async function startOrResume(gate: GateRow, walletAddress: string): Promise<StartedSession> {
    if (gate.kind !== 'trivia') {
      throw new GateRejectedError('wrong_kind', 'this drop does not use trivia')
    }
    assertGameLive(gate)
    const config = parseTriviaConfig(gate.config, bank.version)

    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')

      // Serialize this wallet's sessions for this drop. An advisory lock rather
      // than a row lock, because on the first call there is no row to lock yet —
      // two tabs would otherwise each read "no session" and each insert one.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `trivia:${gate.dropId}:${walletAddress}`,
      ])

      // The grant is what blocks a retry, not a passed session row. A wallet that
      // already satisfied this drop's condition should be claiming, not playing
      // again — and any kind could have issued it.
      const { rows: held } = await client.query<{ id: string }>(
        'SELECT id FROM gate_grants WHERE drop_id = $1 AND wallet_address = $2',
        [gate.dropId, walletAddress],
      )
      if (held[0]) {
        throw new GateRejectedError(
          'already_granted',
          'this wallet has already met this condition',
        )
      }

      // After `already_granted`, so a wallet that has finished this very game is
      // told to go and claim rather than told it is locked out of it. Before the
      // cooldown and before selection: a locked player must not spend a session,
      // and must not be put in cooldown for one they were never allowed to start.
      if (config.unlockRequiresTier !== null) {
        await assertTierUnlocked(client, config.unlockRequiresTier, walletAddress)
      }

      const { rows: existing } = await client.query<{
        id: string
        state: SessionState
        delivered_count: number
        expired: boolean
        cooling: boolean
      }>(
        `SELECT id, state, delivered_count,
                expires_at <= now() AS expired,
                started_at > now() - make_interval(mins => $3::int) AS cooling
         FROM trivia_sessions
         WHERE drop_id = $1 AND wallet_address = $2
         ORDER BY started_at DESC
         LIMIT 1`,
        [gate.dropId, walletAddress, COOLDOWN_MINUTES],
      )

      const prior = existing[0]
      if (prior) {
        // Resume rather than start a second: a reload mid-quiz is the normal
        // case, and a fresh session would hand out a fresh set of deadlines.
        if (prior.state === 'in_progress' && !prior.expired) {
          await client.query('COMMIT')
          committed = true
          return {
            sessionId: prior.id,
            questionCount: config.questionCount,
            secondsPerQuestion: config.secondsPerQuestion,
            deliveredCount: prior.delivered_count,
          }
        }
        if (prior.state === 'in_progress' && prior.expired) {
          await retireIfExpired(client, prior.id)
        }
        if (prior.cooling) {
          throw new GateRejectedError(
            'cooldown',
            `wait ${COOLDOWN_MINUTES} minutes between attempts at this drop`,
          )
        }
      }

      // Deterministic per (drop, wallet), so a retry gets the identical set —
      // persisted here so it cannot drift even if the bank is reloaded.
      // Everything this wallet has already been shown, across every drop. A
      // question it has seen cannot come back, which is what makes revealing the
      // answers afterwards safe — see `selectQuestionIds`.
      const { rows: seenRows } = await client.query<{ question_id: string }>(
        'SELECT question_id FROM trivia_seen WHERE wallet_address = $1',
        [walletAddress],
      )
      const seen = new Set(seenRows.map((r) => r.question_id))

      const questionIds = selectQuestionIds({
        bank,
        tier: config.tier,
        salt,
        dropId: gate.dropId,
        walletAddress,
        count: config.questionCount,
        exclude: seen,
      })

      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO trivia_sessions
           (drop_id, wallet_address, state, bank_version, question_ids, expires_at)
         VALUES ($1, $2, 'in_progress', $3, $4::jsonb,
                 now() + make_interval(mins => $5::int))
         RETURNING id`,
        [
          gate.dropId,
          walletAddress,
          bank.version,
          JSON.stringify(questionIds),
          SESSION_TTL_MINUTES,
        ],
      )

      // Recorded at START, not at delivery. A player who abandons a session has
      // still SEEN whatever it was going to ask, and re-offering those questions
      // to the same wallet after a reveal is precisely the repetition this table
      // exists to prevent. Burning them on an abandoned session is the safe
      // direction to be wrong in.
      await client.query(
        `INSERT INTO trivia_seen (wallet_address, question_id, session_id)
         SELECT $1, unnest($2::text[]), $3
         ON CONFLICT (wallet_address, question_id) DO NOTHING`,
        [walletAddress, questionIds, created[0].id],
      )

      await client.query('COMMIT')
      committed = true
      return {
        sessionId: created[0].id,
        questionCount: config.questionCount,
        secondsPerQuestion: config.secondsPerQuestion,
        deliveredCount: 0,
      }
    } catch (err) {
      if (!committed) await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * The question in play, delivering it if it has not been delivered yet.
   *
   * Delivery stamps `delivered_at` and `deadline_at` server-side and is
   * idempotent: re-reading returns the ORIGINAL deadline, so reloading the page
   * cannot buy time. That is why the INSERT does not use RETURNING — on the
   * second call it returns nothing — and is paired with a follow-up read.
   */
  async function currentQuestion(
    sessionId: string,
    dropId?: string,
    walletAddress?: string,
  ): Promise<DeliveredQuestion> {
    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      const session = await loadSession(client, sessionId, dropId, walletAddress)
      const config = parseTriviaConfig(session.config, bank.version)

      if (session.state === 'in_progress' && session.expired) {
        await retireIfExpired(client, session.id)
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('session_over', 'this session expired')
      }
      if (session.state !== 'in_progress') {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('session_over', 'this session is finished')
      }

      const index = session.delivered_count
      if (index >= config.questionCount) {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('session_over', 'every question was delivered')
      }

      const questionId = session.question_ids[index]
      const question = questionById(sessionId, questionId)

      await client.query(
        `INSERT INTO trivia_answers
           (session_id, question_index, question_id, delivered_at, deadline_at)
         VALUES ($1, $2, $3, now(), now() + make_interval(secs => $4::int))
         ON CONFLICT (session_id, question_index) DO NOTHING`,
        [sessionId, index, questionId, config.secondsPerQuestion],
      )
      const { rows: stamped } = await client.query<{ deadline_at: Date }>(
        `SELECT deadline_at FROM trivia_answers
         WHERE session_id = $1 AND question_index = $2`,
        [sessionId, index],
      )

      await client.query('COMMIT')
      committed = true
      return {
        questionIndex: index,
        prompt: question.prompt,
        options: [...question.options],
        category: question.category,
        deadlineAt: stamped[0].deadline_at,
        questionCount: config.questionCount,
      }
    } catch (err) {
      if (!committed) await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Every question of a finished session, with the player's answer and the right
   * one.
   *
   * Only ever called once a session has left `in_progress`. Calling it earlier
   * would hand over the answers mid-play, which is the same leak as scoring
   * mid-play and worse.
   */
  async function buildReview(db: PoolClient, sessionId: string): Promise<ReviewedQuestion[]> {
    const { rows } = await db.query<{
      question_index: number
      question_id: string
      answer_index: number | null
      is_correct: boolean | null
      was_late: boolean
    }>(
      `SELECT question_index, question_id, answer_index, is_correct,
              -- Compared against the row's own stamped deadline, not against
              -- now(): by review time every deadline is in the past.
              (answered_at IS NULL OR answered_at > deadline_at) AS was_late
       FROM trivia_answers WHERE session_id = $1 ORDER BY question_index`,
      [sessionId],
    )
    return rows.map((row) => {
      const question = questionById(sessionId, row.question_id)
      return {
        questionIndex: row.question_index,
        prompt: question.prompt,
        options: [...question.options],
        answerIndex: row.answer_index,
        correctIndex: question.answerIndex,
        wasCorrect: row.is_correct === true,
        wasLate: row.was_late,
      }
    })
  }

  async function submitAnswer(
    sessionId: string,
    questionIndex: number,
    answerIndex: number,
    dropId?: string,
    walletAddress?: string,
  ): Promise<AnswerOutcome> {
    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= OPTIONS_PER_QUESTION
    ) {
      throw new GateRejectedError(
        'wrong_index',
        `answer index must be 0..${OPTIONS_PER_QUESTION - 1}`,
      )
    }

    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      const session = await loadSession(client, sessionId, dropId, walletAddress)
      const config = parseTriviaConfig(session.config, bank.version)

      if (session.state === 'in_progress' && session.expired) {
        await retireIfExpired(client, session.id)
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('session_over', 'this session expired')
      }
      if (session.state !== 'in_progress') {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('session_over', 'this session is finished')
      }
      if (questionIndex !== session.delivered_count) {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('wrong_index', 'that is not the question in play')
      }

      // The deadline is the SERVER's, read from the row stamped at delivery. A
      // client-supplied elapsed time would be a client-supplied deadline.
      const { rows: pending } = await client.query<{
        question_id: string
        late: boolean
        already: boolean
      }>(
        `SELECT question_id,
                deadline_at < now() AS late,
                answered_at IS NOT NULL AS already
         FROM trivia_answers
         WHERE session_id = $1 AND question_index = $2
         FOR UPDATE`,
        [sessionId, questionIndex],
      )
      const row = pending[0]
      if (!row) {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('wrong_index', 'that question was never delivered')
      }
      if (row.already) {
        await client.query('COMMIT')
        committed = true
        throw new GateRejectedError('wrong_index', 'that question was already answered')
      }

      const question = questionById(sessionId, row.question_id)

      // A late answer counts as wrong. It is not a free retry: the wall-clock
      // cost of the deadline is the whole point of having one.
      const correct = !row.late && answerIndex === question.answerIndex

      await client.query(
        `UPDATE trivia_answers
         SET answered_at = now(), answer_index = $3, is_correct = $4
         WHERE session_id = $1 AND question_index = $2`,
        [sessionId, questionIndex, answerIndex, correct],
      )

      const answered = questionIndex + 1

      // EVERY QUESTION IS ANSWERED BEFORE ANYTHING IS SCORED.
      //
      // This is the most important decision in the file, and the first version of
      // it was wrong. A wrong answer used to end the session immediately, so every
      // submission answered "was THAT one right?" — `failed` for no,
      // `in_progress` for yes. Combined with a retry serving the identical
      // question set, that let an attacker solve each question independently: at
      // most three failed sessions per question, five questions, so SIXTEEN
      // attempts rather than 4^5 = 1024. At a ten-minute cooldown that is about
      // two and a half hours against a twenty-four hour drop, from one address,
      // knowing none of the answers. The gate was decorative.
      //
      // Scoring only once every question is in restores the intended bound: an
      // attempt yields exactly one bit, pass or fail overall, and 1024 attempts
      // no longer fit inside a drop's life.
      //
      // The cost is that a player who knows they got question two wrong still
      // answers three more. That is the right trade — the alternative hands the
      // answer key to anyone patient enough to ask for it five times.
      let state: AnswerOutcome['state'] = 'in_progress'
      if (answered >= config.questionCount) {
        const { rows: tally } = await client.query<{ wrong: string }>(
          `SELECT count(*)::text AS wrong
           FROM trivia_answers
           WHERE session_id = $1 AND is_correct IS NOT TRUE`,
          [sessionId],
        )
        state = tally[0].wrong === '0' ? 'passed' : 'failed'
      }

      await client.query(
        `UPDATE trivia_sessions
         SET delivered_count = $2,
             state = $3,
             completed_at = CASE WHEN $3 = 'in_progress' THEN NULL ELSE now() END
         WHERE id = $1`,
        [sessionId, answered, state],
      )

      // The grant is written in the SAME transaction that marks the session
      // passed, so the two commit together or not at all. A pass with no grant
      // would be a player told they succeeded who cannot claim; a grant with no
      // pass would be a free slot.
      if (state === 'passed') {
        await issueGrant(client, {
          dropId: session.drop_id,
          walletAddress: session.wallet_address,
          kind: 'trivia',
        })
      }

      // Built INSIDE the transaction that finished the session, from the rows
      // just written, so it cannot disagree with what was scored.
      const review = state === 'in_progress' ? undefined : await buildReview(client, sessionId)

      await client.query('COMMIT')
      committed = true

      // The answer is COMMITTED as wrong before this rejection is raised, so a
      // missed deadline is recorded rather than lost to a rollback. It does not
      // end the session — the player answers the rest and learns the outcome at
      // the end like everyone else. Lateness is not correctness, so telling them
      // the clock beat them leaks nothing about the answer.
      if (row.late) {
        throw new GateRejectedError('deadline_missed', 'that answer arrived after the deadline')
      }
      return { state, answered, questionCount: config.questionCount, ...(review ? { review } : {}) }
    } catch (err) {
      if (!committed) await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  return { startOrResume, currentQuestion, submitAnswer }
}
