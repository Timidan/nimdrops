import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import { issueGrant } from '../src/gates/grants'
import { type Bank, parseBank } from '../src/gates/trivia/bank'
import {
  COOLDOWN_MINUTES,
  SESSION_TTL_MINUTES,
  makeTrivia,
  parseTriviaConfig,
} from '../src/gates/trivia/sessions'
import { GateError, GateRejectedError } from '../src/gates/types'
import { loadGate } from '../src/services/gates'
// Side-effect import: installs the int8-as-string parser. This suite builds its
// own pool, so it still depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Private schema, private pool. Sessions hang off `drops`, and the `*.race`
 * suites vitest may run alongside this one truncate `drops` freely.
 */
const SCHEMA = 'trivia_session_test'
const SALT = 'z'.repeat(32)
const PLAYER = 'NQ07 PLAYER'
const SECONDS = 15

/** 12 novice questions over 6 categories, so 5 distinct categories can be drawn. */
function testBank(): Bank {
  const categories = ['geography', 'science', 'history', 'sport', 'music', 'film']
  return parseBank({
    version: 'v1',
    questions: categories.flatMap((category) =>
      [0, 1].map((n) => ({
        id: `${category}-${n}`,
        tier: 'novice',
        category,
        prompt: `${category} ${n}?`,
        options: ['a', 'b', 'c', 'd'],
        answerIndex: n,
        source: 'https://example.org',
      })),
    ),
  })
}

const shippedConfig = {
  tier: 'novice',
  bankVersion: 'v1',
  questionCount: 5,
  secondsPerQuestion: SECONDS,
}

// Pure, so it needs no database and runs even without DATABASE_URL.
describe('parseTriviaConfig', () => {
  it('accepts the shipped shape', () => {
    expect(parseTriviaConfig({ ...shippedConfig, unlockRequiresTier: 'easy' })).toEqual({
      tier: 'novice',
      bankVersion: 'v1',
      questionCount: 5,
      secondsPerQuestion: SECONDS,
      unlockRequiresTier: 'easy',
    })
  })

  it('treats an absent unlockRequiresTier as open', () => {
    expect(parseTriviaConfig(shippedConfig).unlockRequiresTier).toBeNull()
  })

  // The eligibility argument is 0.25^5 = 0.098%. Three questions would be 1.6%,
  // so a misconfigured drop must fail closed rather than become a coin flip.
  it('refuses a questionCount other than five', () => {
    expect(() => parseTriviaConfig({ ...shippedConfig, questionCount: 3 })).toThrow(
      /questionCount/,
    )
    expect(() => parseTriviaConfig({ ...shippedConfig, questionCount: 3 })).toThrow(GateError)
  })

  it('refuses an unknown tier', () => {
    expect(() => parseTriviaConfig({ ...shippedConfig, tier: 'impossible' })).toThrow(/tier/)
  })

  it('refuses a non-positive secondsPerQuestion', () => {
    expect(() => parseTriviaConfig({ ...shippedConfig, secondsPerQuestion: 0 })).toThrow(
      /secondsPerQuestion/,
    )
  })
})

describe.skipIf(!hasDb)('trivia sessions', () => {
  let pool: pg.Pool
  let publicId: string

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** A drop carrying one gate. Returns its public id. */
  async function seedGate(
    o: { kind?: string; config?: Record<string, unknown>; state?: string } = {},
  ): Promise<string> {
    const id = `game-${Math.random().toString(36).slice(2, 12)}`
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state
       ) VALUES ($1, 'quiz', 20, 100000, 2000000, $2)
       RETURNING id`,
      [id, o.state ?? 'live'],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, config, listed)
       VALUES ($1, $2, $3::jsonb, true)`,
      [rows[0].id, o.kind ?? 'trivia', JSON.stringify(o.config ?? shippedConfig)],
    )
    return id
  }

  // FK-safe order: everything that references drop_gates first, then the gates,
  // then the drops they hang off.
  beforeEach(async () => {
    for (const table of [
      // First: it references trivia_sessions, and it is what stops a wallet
      // being asked the same question twice. Leaving it between cases exhausts
      // the twelve-question test bank after two sessions.
      'trivia_seen',
      'trivia_answers',
      'trivia_sessions',
      'gate_grants',
      'passphrase_attempts',
      'attestation_nonces',
      'drop_gates',
      'drops',
    ]) {
      await pool.query(`DELETE FROM ${table}`)
    }
    publicId = await seedGate()
  })

  const service = () => makeTrivia({ pool, bank: testBank(), salt: SALT })
  const gateFor = (id = publicId) => loadGate(pool, id)

  const questionIds = async (sessionId: string) =>
    (
      await pool.query<{ question_ids: string[] }>(
        'SELECT question_ids FROM trivia_sessions WHERE id = $1',
        [sessionId],
      )
    ).rows[0].question_ids

  const sessionState = async (sessionId: string) =>
    (
      await pool.query<{ state: string }>('SELECT state FROM trivia_sessions WHERE id = $1', [
        sessionId,
      ])
    ).rows[0].state

  /** Answer the whole set, using the bank's own answer indices as the truth. */
  async function answerAll(
    svc: ReturnType<typeof service>,
    sessionId: string,
    correct: boolean,
  ) {
    const bank = testBank()
    let last!: Awaited<ReturnType<typeof svc.submitAnswer>>
    for (let i = 0; i < 5; i += 1) {
      const q = await svc.currentQuestion(sessionId)
      const id = (await questionIds(sessionId))[q.questionIndex]
      const truth = bank.questions.find((x) => x.id === id)!.answerIndex
      const answer = correct ? truth : (truth + 1) % 4
      last = await svc.submitAnswer(sessionId, q.questionIndex, answer)
      if (last.state !== 'in_progress') break
    }
    return last
  }

  it('ships a ten-minute session and a ten-minute gap between attempts', () => {
    expect(SESSION_TTL_MINUTES).toBe(10)
    expect(COOLDOWN_MINUTES).toBe(10)
  })

  it('starts a session with the configured shape', async () => {
    const s = await service().startOrResume(await gateFor(), PLAYER)
    expect(s.questionCount).toBe(5)
    expect(s.secondsPerQuestion).toBe(SECONDS)
    expect(s.deliveredCount).toBe(0)
  })

  it('resumes the same session rather than creating a second', async () => {
    const svc = service()
    const gate = await gateFor()
    const first = await svc.startOrResume(gate, PLAYER)
    const again = await svc.startOrResume(gate, PLAYER)
    expect(again.sessionId).toBe(first.sessionId)
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM trivia_sessions',
    )
    expect(rows[0].count).toBe('1')
  })

  // Two tabs, or a double-tapped button. The first call has no row to lock, so
  // only the advisory lock stops both callers reading "no session" and inserting
  // one each — and a second session would hand out a second set of deadlines.
  it('creates one session for two concurrent starts', async () => {
    const svc = service()
    const gate = await gateFor()
    // Warm two backends first. Without this the second caller spends the whole
    // race establishing a connection, the first transaction commits before it
    // ever reads, and the test passes with the advisory lock deleted.
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1')])
    const both = await Promise.all([
      svc.startOrResume(gate, PLAYER),
      svc.startOrResume(gate, PLAYER),
    ])
    expect(both[0].sessionId).toBe(both[1].sessionId)
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM trivia_sessions',
    )
    expect(rows[0].count).toBe('1')
  })

  it('persists the deterministic question set at start', async () => {
    const s = await service().startOrResume(await gateFor(), PLAYER)
    const ids = await questionIds(s.sessionId)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
  })

  it('refuses a new session inside the cooldown after a failure', async () => {
    const svc = service()
    const gate = await gateFor()
    const s = await svc.startOrResume(gate, PLAYER)
    await pool.query(
      `UPDATE trivia_sessions SET state = 'failed', completed_at = now() WHERE id = $1`,
      [s.sessionId],
    )
    await expect(svc.startOrResume(gate, PLAYER)).rejects.toThrow(GateRejectedError)
    await expect(svc.startOrResume(gate, PLAYER)).rejects.toThrow(/cooldown/)
  })

  it('allows a new session once the cooldown has passed', async () => {
    const svc = service()
    const gate = await gateFor()
    const s = await svc.startOrResume(gate, PLAYER)
    await pool.query(
      `UPDATE trivia_sessions
       SET state = 'failed', completed_at = now(),
           started_at = now() - make_interval(mins => $2::int)
       WHERE id = $1`,
      [s.sessionId, COOLDOWN_MINUTES + 1],
    )
    const next = await svc.startOrResume(gate, PLAYER)
    expect(next.sessionId).not.toBe(s.sessionId)
  })

  it('never asks one wallet the same question twice', async () => {
    // The old rule was the opposite — a retry served the IDENTICAL set, so a
    // failure leaked one bit and brute force was 1024 attempts. That bound is
    // deliberately traded away for the reveal: showing the answers would make an
    // identical retry worth about four attempts, so instead the questions never
    // come back and knowing their answers is worth nothing.
    const svc = service()
    const gate = await gateFor()
    const first = await svc.startOrResume(gate, PLAYER)
    const before = await questionIds(first.sessionId)
    await pool.query(
      `UPDATE trivia_sessions
       SET state = 'failed', completed_at = now(),
           started_at = now() - make_interval(mins => $2::int)
       WHERE id = $1`,
      [first.sessionId, COOLDOWN_MINUTES + 1],
    )

    const second = await svc.startOrResume(gate, PLAYER)
    const after = await questionIds(second.sessionId)
    expect(after).toHaveLength(5)
    expect(after.filter((id) => before.includes(id))).toEqual([])
  })

  it('records what was shown even if the session is abandoned', async () => {
    // A player who walks away has still SEEN the questions. Re-offering them
    // after a reveal is exactly the repetition trivia_seen exists to prevent.
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const ids = await questionIds(s.sessionId)
    const { rows } = await pool.query<{ question_id: string }>(
      'SELECT question_id FROM trivia_seen WHERE wallet_address = $1 ORDER BY question_id',
      [PLAYER],
    )
    expect(rows.map((r) => r.question_id).sort()).toEqual([...ids].sort())
  })

  it('refuses a session once the wallet has exhausted the pool', async () => {
    // Marked directly rather than by playing, so the test says exactly what it
    // means: four of the six categories are used up, leaving two, and a session
    // needs five distinct ones.
    const used = ['geography', 'science', 'history', 'sport']
    const ids = testBank()
      .questions.filter((q) => used.includes(q.category))
      .map((q) => q.id)
    await pool.query(
      `INSERT INTO trivia_seen (wallet_address, question_id)
       SELECT 'NQ07 EXHAUSTED', unnest($1::text[])`,
      [ids],
    )

    await expect(service().startOrResume(await gateFor(), 'NQ07 EXHAUSTED')).rejects.toThrow(
      /already-seen|categories left/,
    )
  })
  it('refuses a new session once the wallet holds a grant', async () => {
    const svc = service()
    const gate = await gateFor()
    const s = await svc.startOrResume(gate, PLAYER)
    await pool.query(
      `UPDATE trivia_sessions
       SET state = 'passed', completed_at = now(),
           started_at = now() - make_interval(mins => $2::int)
       WHERE id = $1`,
      [s.sessionId, COOLDOWN_MINUTES + 1],
    )
    await issueGrant(pool, { dropId: gate.dropId, walletAddress: PLAYER, kind: 'trivia' })
    await expect(svc.startOrResume(gate, PLAYER)).rejects.toThrow(/already_granted/)
  })

  it('does not resume a session past its expiry, and marks it expired', async () => {
    const svc = service()
    const gate = await gateFor()
    const s = await svc.startOrResume(gate, PLAYER)
    await pool.query(
      `UPDATE trivia_sessions
       SET expires_at = now() - interval '1 second',
           started_at = now() - make_interval(mins => $2::int)
       WHERE id = $1`,
      [s.sessionId, COOLDOWN_MINUTES + 1],
    )
    const next = await svc.startOrResume(gate, PLAYER)
    expect(next.sessionId).not.toBe(s.sessionId)
    expect(await sessionState(s.sessionId)).toBe('expired')
  })

  it('refuses a gate of another kind', async () => {
    const other = await seedGate({ kind: 'passphrase', config: { hint: 'a word' } })
    await expect(service().startOrResume(await gateFor(other), PLAYER)).rejects.toThrow(
      /wrong_kind/,
    )
  })

  it('refuses a game whose drop is not live', async () => {
    await pool.query(`UPDATE drops SET state = 'closing' WHERE public_id = $1`, [publicId])
    await expect(service().startOrResume(await gateFor(), PLAYER)).rejects.toThrow(
      /game_not_live/,
    )
  })

  it('refuses a misconfigured gate rather than shortening the quiz', async () => {
    const short = await seedGate({ config: { ...shippedConfig, questionCount: 3 } })
    await expect(service().startOrResume(await gateFor(short), PLAYER)).rejects.toThrow(
      /questionCount/,
    )
  })

  it('delivers one question at a time with a server deadline', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const q = await svc.currentQuestion(s.sessionId)
    expect(q.questionIndex).toBe(0)
    expect(q.options).toHaveLength(4)
    expect(q.questionCount).toBe(5)
    expect(q.deadlineAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('never returns the answer index to the client', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const q = await svc.currentQuestion(s.sessionId)
    expect(Object.keys(q)).not.toContain('answerIndex')
  })

  // Reloading must not buy time: delivery is idempotent and the stored deadline
  // is returned untouched.
  it('re-reading the current question does not extend its deadline', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await svc.currentQuestion(s.sessionId)
    await pool.query(
      `UPDATE trivia_answers SET deadline_at = now() + interval '99 seconds'
       WHERE session_id = $1 AND question_index = 0`,
      [s.sessionId],
    )
    const again = await svc.currentQuestion(s.sessionId)
    // Re-stamping would have reset this to secondsPerQuestion (15s) from now.
    expect(again.deadlineAt.getTime() - Date.now()).toBeGreaterThan(60_000)
  })

  it('passes a session that answers all five correctly', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const outcome = await answerAll(svc, s.sessionId, true)
    expect(outcome).toMatchObject({ state: 'passed', answered: 5, questionCount: 5 })
    expect(await sessionState(s.sessionId)).toBe('passed')
  })

  it('fails a session on the first wrong answer', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const outcome = await answerAll(svc, s.sessionId, false)
    expect(outcome.state).toBe('failed')
    expect(await sessionState(s.sessionId)).toBe('failed')
  })

  // A retry serves the identical set, so leaking which of the five was wrong
  // would turn 1024 guaranteed attempts into about twenty.
  /**
   * The test that should have existed first.
   *
   * Asserting the response's KEYS proves nothing about what it means. A `state`
   * that turned `failed` the moment one answer was wrong was per-question
   * correctness under a different name, and it cut brute force from 1024 attempts
   * to sixteen — three failed sessions per question, five questions, about two
   * and a half hours at a ten-minute cooldown, knowing none of the answers.
   *
   * So this asserts the semantics: a wrong FIRST answer must be
   * indistinguishable from a right one until the set is finished.
   */
  it('does not reveal that an answer was wrong until every question is in', async () => {
    const svc = service()
    const bank = testBank()
    const gate = await loadGate(pool, publicId)
    const s = await svc.startOrResume(gate, PLAYER)

    const first = await svc.currentQuestion(s.sessionId)
    const id = (await questionIds(s.sessionId))[first.questionIndex]
    const truth = bank.questions.find((x) => x.id === id)!.answerIndex

    const wrong = await svc.submitAnswer(s.sessionId, first.questionIndex, (truth + 1) % 4)
    expect(wrong.state).toBe('in_progress')
    // And the session is genuinely still playable, not merely reported as such.
    expect(await sessionState(s.sessionId)).toBe('in_progress')
    await expect(svc.currentQuestion(s.sessionId)).resolves.toMatchObject({ questionIndex: 1 })
  })

  it('reports the same state for a right and a wrong first answer', async () => {
    const svc = service()
    const bank = testBank()
    const gate = await loadGate(pool, publicId)

    async function firstOutcome(wallet: string, correct: boolean) {
      const s = await svc.startOrResume(gate, wallet)
      const q = await svc.currentQuestion(s.sessionId)
      const id = (await questionIds(s.sessionId))[q.questionIndex]
      const truth = bank.questions.find((x) => x.id === id)!.answerIndex
      return svc.submitAnswer(s.sessionId, q.questionIndex, correct ? truth : (truth + 1) % 4)
    }

    // Two different wallets so each gets its own session and its own question
    // set; what must match is the SHAPE of the answer they get back.
    const right = await firstOutcome('NQ07 RIGHT', true)
    const notRight = await firstOutcome('NQ07 WRONG', false)
    expect(notRight).toEqual(right)
  })

  it('still fails a session that got one question wrong, at the end', async () => {
    const svc = service()
    const gate = await loadGate(pool, publicId)
    const s = await svc.startOrResume(gate, PLAYER)
    // `answerAll` with correct=false answers every question wrong; the outcome
    // must arrive only on the fifth.
    const outcome = await answerAll(svc, s.sessionId, false)
    expect(outcome).toMatchObject({ state: 'failed', answered: 5 })
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM gate_grants WHERE wallet_address = $1',
      [PLAYER],
    )
    expect(rows[0].count).toBe('0')
  })

  it('leaks no per-question correctness while a question is still in play', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const bank = testBank()

    // Mid-session the outcome carries no review and no verdict of any kind.
    const q = await svc.currentQuestion(s.sessionId)
    const id = (await questionIds(s.sessionId))[q.questionIndex]
    const truth = bank.questions.find((x) => x.id === id)!.answerIndex
    const mid = await svc.submitAnswer(s.sessionId, q.questionIndex, (truth + 1) % 4)
    expect(Object.keys(mid).sort()).toEqual(['answered', 'questionCount', 'state'])
    expect(mid.review).toBeUndefined()
  })

  it('reveals every answer once the session is over', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const ids = await questionIds(s.sessionId)
    const bank = testBank()
    const outcome = await answerAll(svc, s.sessionId, false)

    expect(outcome.state).toBe('failed')
    expect(outcome.review).toHaveLength(5)
    for (const [i, item] of (outcome.review ?? []).entries()) {
      const question = bank.questions.find((x) => x.id === ids[i])!
      expect(item).toMatchObject({
        questionIndex: i,
        prompt: question.prompt,
        correctIndex: question.answerIndex,
        wasCorrect: false,
      })
      expect(item.options).toHaveLength(4)
      // The player's own choice comes back too, so a reader can see what they
      // picked and what it should have been side by side.
      expect(item.answerIndex).toBe((question.answerIndex + 1) % 4)
    }
  })

  it('issues exactly one grant when a session passes', async () => {
    const svc = service()
    const gate = await gateFor()
    const s = await svc.startOrResume(gate, PLAYER)
    await answerAll(svc, s.sessionId, true)
    const { rows } = await pool.query<{ count: string; kind: string }>(
      `SELECT count(*)::text AS count, max(kind) AS kind FROM gate_grants
       WHERE wallet_address = $1`,
      [PLAYER],
    )
    expect(rows[0]).toEqual({ count: '1', kind: 'trivia' })
  })

  it('issues no grant when a session fails', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await answerAll(svc, s.sessionId, false)
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gate_grants',
    )
    expect(rows[0].count).toBe('0')
  })

  it('records a late answer as wrong and lets play continue', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const q = await svc.currentQuestion(s.sessionId)
    await pool.query(
      `UPDATE trivia_answers SET deadline_at = now() - interval '1 second'
       WHERE session_id = $1 AND question_index = $2`,
      [s.sessionId, q.questionIndex],
    )
    await expect(svc.submitAnswer(s.sessionId, q.questionIndex, 0)).rejects.toThrow(
      /deadline_missed/,
    )

    // The answer is committed as wrong BEFORE the rejection is raised, so the
    // missed deadline is recorded rather than lost to a rollback.
    const { rows } = await pool.query<{ is_correct: boolean; answered: boolean }>(
      `SELECT is_correct, answered_at IS NOT NULL AS answered
       FROM trivia_answers WHERE session_id = $1 AND question_index = $2`,
      [s.sessionId, q.questionIndex],
    )
    expect(rows[0]).toEqual({ is_correct: false, answered: true })

    // It does NOT end the session. Ending it here would tell the player their
    // answer was wrong, and the whole point of scoring at the end is that a
    // single submission reveals nothing about a single answer. They finish the
    // set and lose at the end, like anyone who simply guessed badly.
    expect(await sessionState(s.sessionId)).toBe('in_progress')
    await expect(svc.currentQuestion(s.sessionId)).resolves.toMatchObject({ questionIndex: 1 })
  })

  it('fails a session at the end when one answer was late', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const bank = testBank()
    for (let i = 0; i < 5; i += 1) {
      const q = await svc.currentQuestion(s.sessionId)
      const id = (await questionIds(s.sessionId))[q.questionIndex]
      const truth = bank.questions.find((x) => x.id === id)!.answerIndex
      if (i === 2) {
        // Answer this one correctly, but too late.
        await pool.query(
          `UPDATE trivia_answers SET deadline_at = now() - interval '1 second'
           WHERE session_id = $1 AND question_index = $2`,
          [s.sessionId, q.questionIndex],
        )
        await expect(svc.submitAnswer(s.sessionId, q.questionIndex, truth)).rejects.toThrow(
          /deadline_missed/,
        )
        continue
      }
      const outcome = await svc.submitAnswer(s.sessionId, q.questionIndex, truth)
      if (i < 4) expect(outcome.state).toBe('in_progress')
      else expect(outcome.state).toBe('failed')
    }
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM gate_grants WHERE wallet_address = $1',
      [PLAYER],
    )
    expect(rows[0].count).toBe('0')
  })

  it('rejects a second submission for the same question index', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    const q = await svc.currentQuestion(s.sessionId)
    await svc.submitAnswer(s.sessionId, q.questionIndex, 0)
    await expect(svc.submitAnswer(s.sessionId, q.questionIndex, 1)).rejects.toThrow(
      /wrong_index|session_over/,
    )
  })

  it('rejects an answer for a question that was never delivered', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await expect(svc.submitAnswer(s.sessionId, 3, 0)).rejects.toThrow(/wrong_index/)
  })

  it('rejects an answer index outside the four options', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await svc.currentQuestion(s.sessionId)
    await expect(svc.submitAnswer(s.sessionId, 0, 4)).rejects.toThrow(/wrong_index/)
  })

  it('will not deliver a question for a finished session', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await answerAll(svc, s.sessionId, true)
    await expect(svc.currentQuestion(s.sessionId)).rejects.toThrow(/session_over/)
  })

  it('retires an expired session on the next request that touches it', async () => {
    const svc = service()
    const s = await svc.startOrResume(await gateFor(), PLAYER)
    await pool.query(
      `UPDATE trivia_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [s.sessionId],
    )
    await expect(svc.currentQuestion(s.sessionId)).rejects.toThrow(/session_over/)
    expect(await sessionState(s.sessionId)).toBe('expired')
  })

  it('rejects an unknown session id', async () => {
    const svc = service()
    const absent = '00000000-0000-4000-8000-000000000000'
    await expect(svc.currentQuestion(absent)).rejects.toThrow(/session_not_found/)
    await expect(svc.submitAnswer(absent, 0, 0)).rejects.toThrow(/session_not_found/)
    // Garbage from a client must not surface as a 500 either.
    await expect(svc.currentQuestion('not-a-uuid')).rejects.toThrow(/session_not_found/)
  })

  // ---- a session id alone does not drive a session --------------------------
  //
  // Session ids are v4 uuids, so unguessable, but they are not secrets: they
  // travel in URLs, `Referer` headers and access logs. Before `expectWallet`,
  // holding one was enough to submit a wrong answer and spend somebody else's
  // attempt — and a failed attempt costs that wallet a ten-minute cooldown, so a
  // leaked id was effectively a remote "end that player's run" button. Naming the
  // wallet does not make it a secret (the client asserts it either way); it makes
  // the leaked id on its own useless, which is the actual exposure.
  describe('session ownership', () => {
    const STRANGER = 'NQ07 STRANGER'

    it('refuses the question to a wallet the session does not belong to', async () => {
      const svc = service()
      const s = await svc.startOrResume(await gateFor(), PLAYER)
      await expect(svc.currentQuestion(s.sessionId, undefined, STRANGER)).rejects.toThrow(
        GateRejectedError,
      )
      // The SAME code as an unknown id, deliberately: a caller must not be able to
      // tell "no such session" from "right session, wrong wallet", or the method
      // becomes an oracle for which wallet owns an id.
      await expect(svc.currentQuestion(s.sessionId, undefined, STRANGER)).rejects.toThrow(
        /session_not_found/,
      )
    })

    it('refuses an answer from a stranger and leaves the attempt untouched', async () => {
      const svc = service()
      const gate = await gateFor()
      const s = await svc.startOrResume(gate, PLAYER)
      const q = await svc.currentQuestion(s.sessionId, gate.dropId, PLAYER)

      // The cooldown is the prize, so this is the case that mattered.
      await expect(
        svc.submitAnswer(s.sessionId, q.questionIndex, 3, gate.dropId, STRANGER),
      ).rejects.toThrow(/session_not_found/)

      // Nothing was committed against the real player's attempt.
      expect(await sessionState(s.sessionId)).toBe('in_progress')
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM trivia_answers
         WHERE session_id = $1 AND answer_index IS NOT NULL`,
        [s.sessionId],
      )
      expect(rows[0].count).toBe('0')

      // And the owner can still answer the question that was in play.
      const ids = await questionIds(s.sessionId)
      const truth = testBank().questions.find((x) => x.id === ids[q.questionIndex])!.answerIndex
      await expect(
        svc.submitAnswer(s.sessionId, q.questionIndex, truth, gate.dropId, PLAYER),
      ).resolves.toMatchObject({ state: 'in_progress' })
    })

    it('reports the wrong wallet exactly as it reports an unknown id', async () => {
      const svc = service()
      const s = await svc.startOrResume(await gateFor(), PLAYER)
      const absent = '00000000-0000-4000-8000-000000000000'

      const code = async (run: () => Promise<unknown>) => {
        try {
          await run()
        } catch (err) {
          return err instanceof GateRejectedError ? err.code : `unexpected: ${String(err)}`
        }
        return 'resolved'
      }

      expect(await code(() => svc.currentQuestion(s.sessionId, undefined, STRANGER))).toBe(
        await code(() => svc.currentQuestion(absent, undefined, PLAYER)),
      )
      expect(await code(() => svc.submitAnswer(s.sessionId, 0, 0, undefined, STRANGER))).toBe(
        await code(() => svc.submitAnswer(absent, 0, 0, undefined, PLAYER)),
      )
    })

    it('lets the owner through, and still works when no wallet is named at all', async () => {
      // `expectWallet` is optional, so the internal callers that have no wallet to
      // hand keep their behaviour. The HTTP layer always passes one.
      const svc = service()
      const gate = await gateFor()
      const s = await svc.startOrResume(gate, PLAYER)
      await expect(
        svc.currentQuestion(s.sessionId, gate.dropId, PLAYER),
      ).resolves.toMatchObject({ questionIndex: 0 })
      await expect(svc.currentQuestion(s.sessionId, gate.dropId)).resolves.toMatchObject({
        questionIndex: 0,
      })
    })

    it('matches the owner however their address is spelled', async () => {
      // A real, checksum-valid address, stored canonically by the HTTP layer but
      // presented here spaced and lowercased. Locking a player out of their own
      // session over whitespace would be a worse bug than the one this closes.
      const canonical = 'NQ55039X60U7RJXX8SFGNGQHVLBLVJS3NQ4M'
      const svc = service()
      const gate = await gateFor()
      const s = await svc.startOrResume(gate, canonical)
      for (const spelling of [
        canonical,
        canonical.toLowerCase(),
        'NQ55 039X 60U7 RJXX 8SFG NGQH VLBL VJS3 NQ4M',
        'nq55 039x 60u7 rjxx 8sfg ngqh vlbl vjs3 nq4m',
      ]) {
        await expect(
          svc.currentQuestion(s.sessionId, gate.dropId, spelling),
          spelling,
        ).resolves.toMatchObject({ questionIndex: 0 })
      }
      // A different real address is still a different wallet.
      await expect(
        svc.currentQuestion(s.sessionId, gate.dropId, 'NQ97 EGUS 3JPF ELP3 TR5N 0L6E 4Y4Y GGX4 540G'),
      ).rejects.toThrow(/session_not_found/)
    })
  })

  // Spec §4.6: Novice and Easy are always open; Medium needs a pass at Easy or
  // above on ANY drop; Hard needs Medium. That is the entire level system — no
  // points, no streaks, no randomness.
  //
  // The bank in this suite holds novice questions only, so a gate under test
  // stays `tier: 'novice'` and carries the requirement in `unlockRequiresTier`.
  // Only the tier of the drop a PRIOR grant sits on matters to the check.
  describe('tier progression', () => {
    /** A gate that requires `tier`, on its own drop. */
    const gateRequiring = (tier: string) =>
      seedGate({ config: { ...shippedConfig, unlockRequiresTier: tier } })

    /** A prior pass: a grant of `kind` on a separate drop whose gate is `tier`. */
    async function priorGrant(o: { tier: string; kind?: 'trivia' | 'passphrase' }) {
      const other = await seedGate({ config: { ...shippedConfig, tier: o.tier } })
      const gate = await gateFor(other)
      await issueGrant(pool, {
        dropId: gate.dropId,
        walletAddress: PLAYER,
        kind: o.kind ?? 'trivia',
      })
    }

    it('never locks a gate that names no requirement', async () => {
      // Absent, as `shippedConfig` has it, and explicitly null.
      await expect(service().startOrResume(await gateFor(), PLAYER)).resolves.toMatchObject({
        deliveredCount: 0,
      })
      const open = await seedGate({ config: { ...shippedConfig, unlockRequiresTier: null } })
      await expect(
        service().startOrResume(await gateFor(open), 'NQ07 OTHER'),
      ).resolves.toMatchObject({ deliveredCount: 0 })
    })

    it('locks a wallet holding no prior trivia grant', async () => {
      const locked = await gateRequiring('medium')
      await expect(service().startOrResume(await gateFor(locked), PLAYER)).rejects.toThrow(
        /tier_locked/,
      )
    })

    it('unlocks on a grant at exactly the required tier', async () => {
      const locked = await gateRequiring('medium')
      await priorGrant({ tier: 'medium' })
      await expect(
        service().startOrResume(await gateFor(locked), PLAYER),
      ).resolves.toMatchObject({ deliveredCount: 0 })
    })

    it('unlocks on a grant at a higher tier', async () => {
      const locked = await gateRequiring('easy')
      await priorGrant({ tier: 'hard' })
      await expect(
        service().startOrResume(await gateFor(locked), PLAYER),
      ).resolves.toMatchObject({ deliveredCount: 0 })
    })

    it('stays locked on a grant at a lower tier', async () => {
      const locked = await gateRequiring('hard')
      await priorGrant({ tier: 'easy' })
      await expect(service().startOrResume(await gateFor(locked), PLAYER)).rejects.toThrow(
        /tier_locked/,
      )
    })

    // A passphrase grant says a wallet heard a word at a meetup. It is no
    // evidence about trivia, however high the tier of the drop it sits on.
    it('does not accept a passphrase grant as a trivia pass', async () => {
      const locked = await gateRequiring('easy')
      await priorGrant({ tier: 'hard', kind: 'passphrase' })
      await expect(service().startOrResume(await gateFor(locked), PLAYER)).rejects.toThrow(
        /tier_locked/,
      )
    })

    // The unlock and the session it authorises must be decided against one
    // snapshot. Checking it after the COMMIT, or on the pool instead of the
    // transaction's client, would let two tabs each read "locked" and one still
    // walk away with a session.
    it('checks the requirement inside the advisory-locked transaction', async () => {
      const sql: string[] = []
      const recording = {
        connect: async () => {
          const client = await pool.connect()
          const original = client.query.bind(client)
          const spy = (...args: unknown[]) => {
            const first = args[0]
            sql.push(
              typeof first === 'string' ? first : String((first as { text: string }).text),
            )
            return (original as unknown as (...a: unknown[]) => unknown)(...args)
          }
          Object.assign(client, { query: spy })
          return client
        },
      } as unknown as pg.Pool

      const locked = await gateRequiring('medium')
      const svc = makeTrivia({ pool: recording, bank: testBank(), salt: SALT })
      await expect(svc.startOrResume(await gateFor(locked), PLAYER)).rejects.toThrow(
        /tier_locked/,
      )

      const at = (needle: string) => sql.findIndex((q) => q.includes(needle))
      expect(sql[0]).toBe('BEGIN')
      expect(at('pg_advisory_xact_lock')).toBeGreaterThan(0)
      // `array_position` over the tier ladder is the tier check and nothing else
      // in this path uses it.
      expect(at('array_position')).toBeGreaterThan(at('pg_advisory_xact_lock'))
      expect(at('ROLLBACK')).toBeGreaterThan(at('array_position'))
      expect(at('COMMIT')).toBe(-1)

      // And the rollback is real: a locked player spends no session, so nothing
      // puts them in a cooldown for an attempt they were never allowed.
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM trivia_sessions',
      )
      expect(rows[0].count).toBe('0')
    })
  })
})
