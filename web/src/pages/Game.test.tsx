/**
 * The screen a stranger meets before they are allowed to claim.
 *
 * What these tests defend:
 *  - the pass screen is PLAIN and hands off to `/drop/:publicId`. Meeting a
 *    condition is not receiving, so no reveal happens here and no copy hurries
 *    anybody toward a signature;
 *  - the countdown comes from the server's deadline, and reaching zero submits
 *    nothing;
 *  - no correct answer is displayed while a question is still in play, and none
 *    is displayed afterwards either unless the server sent one;
 *  - the review, when there is one, says right from wrong in WORDS, tells a
 *    missed deadline apart from a wrong answer, and stays under the claim;
 *  - a failure says what ended it and the wait, and never blames the wallet;
 *  - amounts are exact, and "one tap" appears nowhere.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, getBridge, resolveBridge } from '../sdk/adapter'
import Game, { WALLET_STORAGE_KEY } from './Game'

// The wallet boundary is mocked, never the SDK: `getBridge` is the seam the page
// actually uses, and stubbing it keeps these tests free of a real provider.
vi.mock('../sdk/adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sdk/adapter')>()),
  getBridge: vi.fn(() => ({ kind: 'unavailable' as const })),
  resolveBridge: vi.fn(async () => ({ kind: 'unavailable' as const })),
}))

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const PLAYER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'

function gameBody(over: Record<string, unknown> = {}) {
  return {
    publicId: PUBLIC_ID,
    kind: 'trivia',
    tier: 'medium',
    unlockRequiresTier: null,
    hint: null,
    // 2.5 NIM. Chosen so a rounded render would be visible.
    amountEachLuna: '250000',
    claimCount: 20,
    slotsRemaining: 7,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    state: 'live',
    granted: false,
    ...over,
  }
}

function question(index: number, secondsOut = 15) {
  return {
    questionIndex: index,
    prompt: `Which of these is question ${index + 1}?`,
    options: ['first', 'second', 'third', 'fourth'],
    category: 'science',
    deadlineAt: new Date(Date.now() + secondsOut * 1000).toISOString(),
    questionCount: 5,
  }
}

/**
 * One row of the review the server sends back with a finished session.
 *
 * The defaults describe a question answered correctly, so a case only has to
 * spell out the part it is about. `answerIndex: null` is the missed deadline and
 * nothing else — a wrong answer carries the index the player actually chose.
 */
function reviewed(index: number, over: Record<string, unknown> = {}) {
  return {
    questionIndex: index,
    prompt: `Which of these is question ${index + 1}?`,
    options: ['first', 'second', 'third', 'fourth'],
    answerIndex: 0,
    correctIndex: 0,
    wasCorrect: true,
    wasLate: false,
    ...over,
  }
}

/** Five questions, with question three answered wrongly. */
function reviewWithOneWrong() {
  return [
    reviewed(0),
    reviewed(1),
    reviewed(2, { answerIndex: 1, correctIndex: 3, wasCorrect: false }),
    reviewed(3),
    reviewed(4),
  ]
}

interface Reply {
  status: number
  body: unknown
}

interface Script {
  game?: Reply
  /** Consumed one per read; the last entry repeats forever. Wins over `game`. */
  games?: Reply[]
  session?: Reply
  question?: Reply
  answer?: Reply
  /** Consumed one per submission; the last entry repeats forever. */
  answers?: Reply[]
  passphrase?: Reply
  passphrases?: Reply[]
}

function installFetch(script: Script) {
  const games = script.games ? [...script.games] : null
  const answers = script.answers ? [...script.answers] : null
  const passphrases = script.passphrases ? [...script.passphrases] : null
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    let reply: Reply | undefined
    // Matched on the PATH, with any query string stripped first. Suffix matching
    // broke the moment the question route gained `?wallet=`, and it failed as
    // fourteen unrelated assertions rather than as "the stub stopped matching".
    const path = String(url).split('?')[0]
    if (path.endsWith('/session')) reply = script.session
    else if (path.endsWith('/question')) reply = script.question
    else if (path.endsWith('/answer'))
      reply = answers ? (answers.length > 1 ? answers.shift() : answers[0]) : script.answer
    else if (path.endsWith('/passphrase'))
      reply = passphrases
        ? passphrases.length > 1
          ? passphrases.shift()
          : passphrases[0]
        : script.passphrase
    else if (games) reply = games.length > 1 ? games.shift() : games[0]
    else reply = script.game
    if (!reply) throw new Error(`unscripted fetch: ${url}`)
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Mounts with an address already known, so the wallet step is out of the way.
 * Pass `null` to exercise the wallet step itself — not `undefined`, which would
 * take the default.
 */
function mount(walletAddress: string | null = PLAYER) {
  return render(
    <MemoryRouter initialEntries={[`/game/${PUBLIC_ID}`]}>
      <Routes>
        <Route
          path="/game/:publicId"
          element={<Game {...(walletAddress ? { walletAddress } : {})} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Game — which wallet is playing', () => {
  it('asks for the wallet before any condition, and only after showing the offer', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount(null)

    const step = await screen.findByTestId('wallet-step')
    expect(step.textContent).toMatch(/which wallet is playing/i)
    // The reason it is asked, said out loud.
    expect(step.textContent).toMatch(/only that wallet can\s+claim/i)
    // And the promise that this is not the signature.
    expect(step.textContent).toMatch(/nothing is signed here/i)
    // The offer came first: a stranger learns what this is before being asked.
    expect(document.body.textContent).toMatch(/2\.5 NIM/)
    // No condition has started.
    expect(screen.queryByTestId('trivia-idle')).toBeNull()
  })

  it('reads the address from the wallet rather than asking anyone to type it', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    const address = vi.fn().mockResolvedValue(PLAYER)
    const realBridge = {
      kind: 'real' as const,
      bridge: { ready: async () => {}, address, sign: async () => ({ publicKey: '', signature: '' }), sendWithData: async () => ({ txHash: '' }) },
    }
    vi.mocked(getBridge).mockReturnValue(realBridge)
    // Inside the wallet the mount probe resolves real too, so the page keeps the
    // "Use my wallet" button rather than the deeplink fallback.
    vi.mocked(resolveBridge).mockResolvedValue(realBridge)
    mount(null)

    // There is no address field to type into. That is the point of the change.
    expect(screen.queryByLabelText(/your nimiq address/i)).toBeNull()

    fireEvent.click(await screen.findByTestId('connect-wallet'))
    expect(await screen.findByTestId('trivia-idle')).toBeTruthy()
    expect(address).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(WALLET_STORAGE_KEY)).toBe(PLAYER)
  })

  it('does not blame the wallet when the player declines', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    vi.mocked(getBridge).mockReturnValue({
      kind: 'real',
      bridge: {
        ready: async () => {},
        address: async () => {
          throw new BridgeError('provider_error', 'address', 'USER_CANCELED: rejected')
        },
        sign: async () => ({ publicKey: '', signature: '' }),
        sendWithData: async () => ({ txHash: '' }),
      },
    })
    mount(null)

    fireEvent.click(await screen.findByTestId('connect-wallet'))
    const problem = await screen.findByTestId('wallet-problem')
    // Declining is a legitimate answer, not a fault to scold.
    expect(problem.textContent).not.toMatch(/refus|denied|error|invalid/i)
    expect(problem.textContent).toMatch(/nothing to record|try again/i)
    // Nothing was remembered and no condition started.
    expect(localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull()
    expect(screen.queryByTestId('trivia-idle')).toBeNull()
  })

  it('offers a Nimiq Pay deeplink to a plain browser, not a dead end', async () => {
    // Opened outside the wallet, the page cannot read an address at all. The old
    // behaviour was a line of copy telling the reader to open in Nimiq Pay and no
    // way to do it. On mount now, `resolveBridge` reports unavailable and the
    // page shows a deeplink that reopens THIS url inside the app.
    installFetch({ game: { status: 200, body: gameBody() } })
    vi.mocked(getBridge).mockReturnValue({ kind: 'unavailable' })
    vi.mocked(resolveBridge).mockResolvedValue({ kind: 'unavailable' })
    mount(null)

    const open = await screen.findByTestId('open-in-app')
    // An "Open in Nimiq Pay" action, which fires the deeplink and — proven in
    // openApp.test.ts — falls through to the store when the app is absent. The
    // exact deeplink/store dance is that module's contract; here we only need
    // the action present and no dead-end wallet button.
    expect(screen.getByTestId('open-in-app-cta')).toBeTruthy()
    expect(open.textContent).toMatch(/open in nimiq pay/i)
    expect(screen.queryByTestId('connect-wallet')).toBeNull()
  })
})

describe('Game — trivia before play', () => {
  it('states the tier, the exact amount, the question count, and that the approval comes after', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount()

    const card = await screen.findByTestId('trivia-idle')
    expect(screen.getByTestId('game-amount').textContent).toMatch(/2\.5\s*NIM/)
    expect(screen.getByText('medium')).toBeTruthy()
    expect(card.textContent).toMatch(/5 questions, four options each/i)
    // The one line about the signature, and its ordering.
    expect(card.textContent).toMatch(/the wallet approval comes after, not now/i)
    expect(card.textContent).toMatch(/the server times each question/i)
    // How many are left, before spending five questions to find out.
    expect(screen.getByTestId('game-slots').textContent).toMatch(/7 shares left/)
    // The gate pages sit on the lit field, not a flat gradient (s4).
    expect(document.querySelector('.nd-field-light.is-bloom')).not.toBeNull()
    expect(document.querySelector('.nd-field-texture')).not.toBeNull()
  })

  it('never promises one tap and never says anything about luck', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount()

    await screen.findByTestId('trivia-idle')
    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/one[\s-]?tap/i)
    expect(body).not.toMatch(/luck|random|jackpot|prize wheel/i)
  })

  it('shows the amount exactly, never rounded', async () => {
    installFetch({ game: { status: 200, body: gameBody({ amountEachLuna: '12345' }) } })
    mount()

    await screen.findByTestId('trivia-idle')
    expect(screen.getByTestId('game-amount').textContent).toMatch(/0\.12345\s*NIM/)
  })

  it('promises only up to the amount, since the score decides the share', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount()

    await screen.findByTestId('trivia-idle')
    const body = document.body.textContent ?? ''
    expect(body).toMatch(/up to this amount/i)
    expect(body).toMatch(/3 of 5 pays 60%, 4 pays 80%, 5 pays all of it/i)
    expect(body).not.toMatch(/the same fixed amount for everyone/i)
  })
})

describe('Game — trivia in play', () => {
  const playing = () => ({
    game: { status: 200, body: gameBody() },
    session: {
      status: 200,
      body: { sessionId: 's-1', questionCount: 5, secondsPerQuestion: 15, deliveredCount: 0 },
    },
    question: { status: 200, body: question(0) },
  })

  async function start() {
    mount()
    await screen.findByTestId('trivia-idle')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    })
    return screen.findByTestId('trivia-playing')
  }

  it('shows n of 5, the category, four large targets and a countdown, and no score', async () => {
    installFetch(playing())
    const panel = await start()

    expect(screen.getByTestId('question-progress').textContent).toBe('1 of 5')
    expect(panel.textContent).toContain('science')
    expect(screen.getByRole('button', { name: 'first' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fourth' })).toBeTruthy()
    expect(panel.querySelectorAll('button')).toHaveLength(4)
    expect(screen.getByTestId('countdown').textContent).toMatch(/^\d+s$/)

    // No score, no running tally, no per-question feedback.
    expect(panel.textContent).not.toMatch(/score|correct|right so far|points/i)

    // Trivia answers are the exported control, not a re-invented one.
    const options = document.querySelectorAll('button.nd-option')
    expect(options.length).toBeGreaterThan(0)
    expect(document.querySelector('.bg-gold')).toBeNull()
  })

  it('derives the countdown from the server deadline rather than the render', async () => {
    installFetch({ ...playing(), question: { status: 200, body: question(0, 4) } })
    await start()

    await waitFor(() =>
      expect(Number.parseInt(screen.getByTestId('countdown').textContent ?? '', 10)).toBeLessThanOrEqual(4),
    )
  })

  it('does not submit anything when the clock runs out', async () => {
    const fetchMock = installFetch({ ...playing(), question: { status: 200, body: question(0, -1) } })
    await start()

    expect(await screen.findByTestId('time-up')).toBeTruthy()
    expect(screen.getByTestId('countdown').textContent).toBe('0s')
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).split('?')[0].endsWith('/answer')),
    ).toBe(false)
    // The options stay live: the server refuses a late answer, and refusing on
    // its behalf would spend the player's one submission for them.
    expect((screen.getByRole('button', { name: 'first' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('moves to the next question without saying whether the last one was right', async () => {
    installFetch({
      ...playing(),
      answer: { status: 200, body: { state: 'in_progress', answered: 1, questionCount: 5 } },
      question: { status: 200, body: question(0) },
    })
    await start()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'second' }))
    })

    expect(document.body.textContent ?? '').not.toMatch(/correct|well done|nice one|wrong/i)
  })
})

describe('Game — trivia outcomes', () => {
  const playing = {
    game: { status: 200, body: gameBody() },
    session: {
      status: 200,
      body: { sessionId: 's-1', questionCount: 5, secondsPerQuestion: 15, deliveredCount: 0 },
    },
    question: { status: 200, body: question(0) },
  }

  async function play(answer: Reply) {
    installFetch({ ...playing, answer })
    mount()
    await screen.findByTestId('trivia-idle')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    })
    await screen.findByTestId('trivia-playing')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'first' }))
    })
  }

  it('passing is plain and hands off to the claim at /drop/:publicId', async () => {
    await play({ status: 200, body: { state: 'passed', answered: 5, questionCount: 5 } })

    const pass = await screen.findByTestId('gate-passed')
    expect(pass.textContent).toMatch(/you can claim 2\.5 NIM/i)
    // It says the money has NOT moved, and where it will.
    expect(pass.textContent).toMatch(/nothing has been sent yet/i)
    expect(pass.textContent).toMatch(/tap and approve/i)

    const link = screen.getByRole('link', { name: /go to the claim/i })
    expect(link.getAttribute('href')).toBe(`/drop/${PUBLIC_ID}`)
    // Never the legacy path.
    expect(link.getAttribute('href')).not.toMatch(/^\/d\//)

    // The reveal belongs to the payout. Nothing here celebrates, and nothing
    // here is the gold keyline or the bloom.
    expect(pass.textContent).not.toMatch(/congratulations|well done|you won|🎉|amazing/i)
    expect(document.querySelector('.nd-keyline')).toBe(null)
    expect(document.querySelector('.nd-bloom')).toBe(null)
    expect(document.body.textContent ?? '').not.toMatch(/one[\s-]?tap/i)
  })

  it('prints the scored fraction and share on the passed screen', async () => {
    await play({
      status: 200,
      body: { state: 'passed', answered: 5, questionCount: 5, correctCount: 4 },
    })

    const pass = await screen.findByTestId('gate-passed')
    expect(pass.textContent).toMatch(/4 of 5/)
    expect(pass.textContent).toMatch(/80% of the share/)
  })

  /**
   * The pass screen is the whole screen. Two reasons, and the second is not
   * cosmetic: the offer above it would print the amount twice, and the "use a
   * different wallet" control would invite somebody to switch to a wallet that
   * cannot claim what they just earned.
   */
  it('replaces the offer rather than sitting under it', async () => {
    await play({ status: 200, body: { state: 'passed', answered: 5, questionCount: 5 } })

    await screen.findByTestId('gate-passed')
    expect(screen.queryByTestId('game-amount')).toBe(null)
    expect(screen.queryByTestId('change-wallet')).toBe(null)
    expect(screen.queryByTestId('trivia-playing')).toBe(null)
    // The amount is stated once.
    expect((document.body.textContent ?? '').match(/2\.5 NIM/g)).toHaveLength(1)
  })

  it('a failure says what ended it and the wait, and blames nobody', async () => {
    await play({ status: 200, body: { state: 'failed', answered: 2, questionCount: 5 } })

    const failed = await screen.findByTestId('trivia-failed')
    expect(failed.textContent).toMatch(/this attempt has ended/i)
    expect(failed.textContent).toMatch(/answered 2 of 5/i)
    expect(failed.textContent).toMatch(/3 minutes/)
    expect(failed.textContent).toMatch(/nothing has been lost/i)

    // Never the wallet's fault, and never a reveal of the answer.
    expect(failed.textContent).not.toMatch(/wallet/i)
    expect(failed.textContent).not.toMatch(/the answer was|correct answer/i)
  })

  it('shows the server’s own sentence when a submission is refused', async () => {
    await play({
      status: 409,
      body: { error: { code: 'deadline_missed', message: 'time ran out on that question' } },
    })

    const failed = await screen.findByTestId('trivia-failed')
    expect(failed.textContent).toMatch(/time ran out on that question/i)
    expect(failed.textContent).not.toMatch(/wallet/i)
  })

  it('surfaces a tier lock as the server phrased it, without starting a round', async () => {
    installFetch({
      game: { status: 200, body: gameBody() },
      session: {
        status: 403,
        body: { error: { code: 'tier_locked', message: 'pass an easier one first to unlock this' } },
      },
    })
    mount()
    await screen.findByTestId('trivia-idle')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    })

    expect((await screen.findByTestId('trivia-start-error')).textContent).toMatch(
      /pass an easier one first/i,
    )
    expect(screen.queryByTestId('trivia-playing')).toBe(null)
  })
})

describe('Game — the review of a finished round', () => {
  const playing = {
    game: { status: 200, body: gameBody() },
    session: {
      status: 200,
      body: { sessionId: 's-1', questionCount: 5, secondsPerQuestion: 15, deliveredCount: 0 },
    },
    question: { status: 200, body: question(0) },
  }

  async function play(answer: Reply) {
    installFetch({ ...playing, answer })
    mount()
    await screen.findByTestId('trivia-idle')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    })
    await screen.findByTestId('trivia-playing')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'first' }))
    })
  }

  it('shows all five questions and the right answer after a failure', async () => {
    await play({
      status: 200,
      body: { state: 'failed', answered: 5, questionCount: 5, review: reviewWithOneWrong() },
    })

    await screen.findByTestId('trivia-review')
    for (let index = 0; index < 5; index += 1) {
      const row = screen.getByTestId(`review-${index}`)
      expect(row.textContent).toContain(`Which of these is question ${index + 1}?`)
      // Every row says what the right answer was, including the ones that were.
      expect(row.textContent).toMatch(/the right answer is/i)
    }

    const wrong = screen.getByTestId('review-2')
    expect(wrong.textContent).toMatch(/you chose second/i)
    expect(wrong.textContent).toMatch(/the right answer is fourth/i)
  })

  it('shows the review on a pass too, with the claim still there and still above it', async () => {
    await play({
      status: 200,
      body: { state: 'passed', answered: 5, questionCount: 5, review: reviewWithOneWrong() },
    })

    const pass = await screen.findByTestId('gate-passed')
    const link = screen.getByRole('link', { name: /go to the claim/i })
    expect(link.getAttribute('href')).toBe(`/drop/${PUBLIC_ID}`)

    const review = screen.getByTestId('trivia-review')
    expect(review.textContent).toContain('Which of these is question 1?')
    // The claim comes FIRST in the document, so five questions never push the
    // primary action down a phone screen.
    expect(link.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Information, not a trophy: no score, no praise, no reveal.
    expect(pass.textContent).not.toMatch(/congratulations|well done|nice one|perfect|🎉/i)
    expect(pass.textContent).not.toMatch(/\b5\s*(\/|out of)\s*5\b|score/i)
    expect(document.querySelector('.nd-keyline')).toBe(null)
    expect(document.querySelector('.nd-bloom')).toBe(null)
  })

  it('reads a question the clock beat as out of time, not as a wrong answer', async () => {
    await play({
      status: 200,
      body: {
        state: 'failed',
        answered: 5,
        questionCount: 5,
        review: [
          reviewed(0),
          reviewed(1, { answerIndex: null, correctIndex: 2, wasCorrect: false }),
          reviewed(2),
          reviewed(3),
          reviewed(4),
        ],
      },
    })

    const row = await screen.findByTestId('review-1')
    expect(row.textContent).toMatch(/ran out of time/i)
    // Not scolded for an answer nobody gave, and no answer attributed to them.
    expect(row.textContent).not.toMatch(/not correct|wrong/i)
    expect(row.textContent).not.toMatch(/you chose/i)
    // The right answer is still stated, because that is what a review is for.
    expect(row.textContent).toMatch(/the right answer is third/i)
  })

  it('gives a score and no per-question verdict when the bank withholds them', async () => {
    // The normal case for a bank whose questions the operator wrote. BOTH fields
    // are null together: a verdict on the option the player chose names it when
    // true and eliminates it when false, so `wasCorrect` alone is the answer at
    // 2.5x the cost. The score is what the player gets instead.
    const withheld = (index: number, over: Record<string, unknown> = {}) =>
      reviewed(index, { correctIndex: null, wasCorrect: null, ...over })

    await play({
      status: 200,
      body: {
        state: 'failed',
        answered: 5,
        questionCount: 5,
        correctCount: 3,
        review: [
          withheld(0),
          withheld(1, { answerIndex: 1 }),
          withheld(2),
          withheld(3),
          withheld(4),
        ],
      },
    })

    const section = await screen.findByTestId('trivia-review')
    expect(screen.getByTestId('trivia-score').textContent).toMatch(/3 of 5 right/i)

    // Every row says they answered and stops there.
    expect(screen.getByTestId('review-0-outcome').textContent).toMatch(/Answered$/)
    expect(screen.getByTestId('review-1').textContent).toMatch(/you chose second/i)

    // Nothing anywhere names an answer or grades a question. `null` is falsy, so
    // a screen that read wasCorrect directly would print "Not correct" on all
    // five — telling somebody they got everything wrong on no evidence.
    expect(section.textContent).not.toMatch(/the right answer/i)
    expect(section.textContent).not.toMatch(/not correct/i)
    expect(section.textContent).not.toMatch(/\bCorrect\b/)
  })

  it('shows no score line when the verdicts are present, so the rows are the only word', async () => {
    // A tally beside per-question verdicts reads as a grade, which is ruled
    // out on a screen about a payout. The rows already say it.
    await play({
      status: 200,
      body: {
        state: 'failed',
        answered: 5,
        questionCount: 5,
        correctCount: 4,
        review: reviewWithOneWrong(),
      },
    })

    await screen.findByTestId('trivia-review')
    expect(screen.queryByTestId('trivia-score')).toBe(null)
  })

  it('reads a late answer as beaten by the clock, not as a wrong choice', async () => {
    // A late answer carries the index the player picked and is scored wrong
    // whatever it said — so `answerIndex === correctIndex` while `wasCorrect` is
    // false. Without `wasLate` this row shows somebody their own correct answer
    // labelled "Not correct", which reads as a bug in the scoring.
    await play({
      status: 200,
      body: {
        state: 'failed',
        answered: 5,
        questionCount: 5,
        review: [
          reviewed(0),
          reviewed(1, { answerIndex: 0, correctIndex: 0, wasCorrect: false, wasLate: true }),
          reviewed(2),
          reviewed(3),
          reviewed(4),
        ],
      },
    })

    const row = await screen.findByTestId('review-1')
    expect(screen.getByTestId('review-1-outcome').textContent).toMatch(/Too late$/)
    expect(row.textContent).not.toMatch(/not correct/i)
    // They are still told what they picked, and why it did not count.
    expect(row.textContent).toMatch(/you chose first/i)
    expect(row.textContent).toMatch(/clock had already run out/i)
    // It is not the same thing as never answering at all.
    expect(row.textContent).not.toMatch(/ran out of time/i)
  })

  it('carries correctness in words rather than in colour', async () => {
    await play({
      status: 200,
      body: {
        state: 'failed',
        answered: 5,
        questionCount: 5,
        review: [
          reviewed(0),
          reviewed(1, { answerIndex: 1, correctIndex: 3, wasCorrect: false }),
          reviewed(2, { answerIndex: null, correctIndex: 0, wasCorrect: false }),
          reviewed(3),
          reviewed(4),
        ],
      },
    })

    const right = await screen.findByTestId('review-0-outcome')
    const wrong = screen.getByTestId('review-1-outcome')
    const late = screen.getByTestId('review-2-outcome')

    // The word is the carrier. Greyscale and a screen reader both get this.
    expect(right.textContent).toMatch(/Correct$/)
    expect(wrong.textContent).toMatch(/Not correct$/)
    expect(late.textContent).toMatch(/Ran out of time$/)

    // And the styling is IDENTICAL across all three, so nothing about telling
    // them apart is carried by a hue.
    expect(wrong.className).toBe(right.className)
    expect(late.className).toBe(right.className)

    // The glyph beside the word is decoration and is hidden from assistive tech,
    // so removing it loses nothing.
    for (const outcome of [right, wrong, late]) {
      const marks = outcome.querySelectorAll('[aria-hidden="true"]')
      expect(marks).toHaveLength(1)
      expect(outcome.textContent?.replace(marks[0].textContent ?? '', '').trim()).not.toBe('')
    }
  })

  it('renders no review while a question is still in play', async () => {
    await play({ status: 200, body: { state: 'in_progress', answered: 1, questionCount: 5 } })

    expect(await screen.findByTestId('trivia-playing')).toBeTruthy()
    expect(screen.queryByTestId('trivia-review')).toBe(null)
    expect(document.body.textContent ?? '').not.toMatch(/the right answer is/i)
  })

  it('renders nothing at all rather than a placeholder when the server sent no review', async () => {
    await play({ status: 200, body: { state: 'failed', answered: 5, questionCount: 5 } })

    await screen.findByTestId('trivia-failed')
    expect(screen.queryByTestId('trivia-review')).toBe(null)
    expect(screen.queryByTestId('review-0')).toBe(null)
    expect(document.body.textContent ?? '').not.toMatch(/the right answer is|question by question/i)
  })
})

describe('Game — passphrase', () => {
  const gate = (over: Record<string, unknown> = {}) => ({
    game: {
      status: 200,
      body: gameBody({
        kind: 'passphrase',
        tier: null,
        hint: 'said at the 3pm talk',
        amountEachLuna: '100000',
        ...over,
      }),
    },
  })

  it('keeps the fixed-amount sentence, since only trivia scores a share', async () => {
    installFetch(gate())
    mount()

    await screen.findByTestId('passphrase-form')
    expect(document.body.textContent ?? '').toMatch(/the same fixed amount for everyone/i)
    expect(document.body.textContent ?? '').not.toMatch(/up to this amount/i)
  })

  it('shows the hint, one field and one button', async () => {
    installFetch(gate())
    mount()

    const form = await screen.findByTestId('passphrase-form')
    expect(screen.getByTestId('passphrase-hint').textContent).toBe('said at the 3pm talk')
    expect(form.querySelectorAll('input')).toHaveLength(1)
    expect(form.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /check the phrase/i })).toBeTruthy()

    // The system input: recessed dark well, token ink. bg-white made typed
    // text near-white-on-white; nd-input is the fix, not a tweak to it.
    const phrase = screen.getByLabelText('The phrase')
    expect(phrase.className).toContain('nd-input')
    expect(phrase.className).not.toContain('bg-white')
    // Gold never sits on the bare field (2.74:1).
    expect(document.querySelector('.bg-gold')).toBeNull()
    expect(document.querySelector('[class*="border-gold"]')).toBeNull()
  })

  it('says "that is not it" with the tries left, and never reveals the phrase', async () => {
    installFetch({
      ...gate(),
      passphrase: {
        status: 409,
        body: { error: { code: 'bad_attempt', message: 'that is not the phrase' } },
      },
    })
    mount()

    await screen.findByTestId('passphrase-form')
    fireEvent.change(screen.getByLabelText(/the phrase/i), { target: { value: 'blue panda' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check the phrase/i }))
    })

    const notice = await screen.findByTestId('passphrase-notice')
    expect(notice.textContent).toMatch(/that is not it/i)
    expect(notice.textContent).toMatch(/4 of 5 tries left/i)
  })

  it('counts down the tries it has seen', async () => {
    installFetch({
      ...gate(),
      passphrase: {
        status: 409,
        body: { error: { code: 'bad_attempt', message: 'that is not the phrase' } },
      },
    })
    mount()

    await screen.findByTestId('passphrase-form')
    for (const guess of ['one', 'two']) {
      fireEvent.change(screen.getByLabelText(/the phrase/i), { target: { value: guess } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check the phrase/i }))
      })
    }
    expect((await screen.findByTestId('passphrase-notice')).textContent).toMatch(/3 of 5 tries left/i)
  })

  it('hands the server’s own sentence over when the tries are used up', async () => {
    installFetch({
      ...gate(),
      passphrase: {
        status: 429,
        body: {
          error: { code: 'too_many_attempts', message: 'more than 5 tries in 60 minutes' },
        },
      },
    })
    mount()

    await screen.findByTestId('passphrase-form')
    fireEvent.change(screen.getByLabelText(/the phrase/i), { target: { value: 'red panda' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check the phrase/i }))
    })

    expect((await screen.findByTestId('passphrase-notice')).textContent).toMatch(
      /more than 5 tries in 60 minutes/i,
    )
  })

  it('succeeding is plain and links to the claim', async () => {
    installFetch({ ...gate(), passphrase: { status: 200, body: { granted: true } } })
    mount()

    await screen.findByTestId('passphrase-form')
    fireEvent.change(screen.getByLabelText(/the phrase/i), { target: { value: 'red panda' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check the phrase/i }))
    })

    const pass = await screen.findByTestId('gate-passed')
    expect(pass.textContent).toMatch(/you can claim 1 NIM/i)
    expect(screen.getByRole('link', { name: /go to the claim/i }).getAttribute('href')).toBe(
      `/drop/${PUBLIC_ID}`,
    )
    expect(pass.textContent).not.toMatch(/congratulations|🎉/i)
  })
})

describe('Game — attested', () => {
  it('asks for nothing and explains who decides', async () => {
    installFetch({
      game: { status: 200, body: gameBody({ kind: 'attested', tier: null, granted: false }) },
    })
    mount()

    const panel = await screen.findByTestId('attested')
    expect(panel.textContent).toMatch(/whoever runs this drop/i)
    expect(panel.textContent).toMatch(/has not happened yet/i)
    expect(panel.textContent).toMatch(/nothing here to answer and nothing to sign/i)
    // No input of any kind.
    expect(document.querySelectorAll('input')).toHaveLength(0)
  })

  it('links straight to the claim once the confirmation has landed', async () => {
    installFetch({
      game: { status: 200, body: gameBody({ kind: 'attested', tier: null, granted: true }) },
    })
    mount()

    const pass = await screen.findByTestId('gate-passed')
    expect(pass.textContent).toMatch(/you can claim 2\.5 NIM/i)
    expect(screen.getByRole('link', { name: /go to the claim/i }).getAttribute('href')).toBe(
      `/drop/${PUBLIC_ID}`,
    )
    expect(screen.queryByTestId('attested')).toBe(null)
  })
})

describe('Game — a link that is not a game', () => {
  it('sends an ordinary drop’s link to the drop instead of a 404', async () => {
    installFetch({
      game: {
        status: 404,
        body: { error: { code: 'not_a_game', message: 'this drop carries no condition' } },
      },
    })
    mount()

    const panel = await screen.findByTestId('not-a-game')
    expect(panel.textContent).toMatch(/does not ask anything of you/i)
    expect(screen.getByRole('link', { name: /open the drop/i }).getAttribute('href')).toBe(
      `/drop/${PUBLIC_ID}`,
    )
  })

  it('keeps a network failure honest and retryable', async () => {
    installFetch({ game: { status: 503, body: { error: { code: 'unavailable', message: 'not now' } } } })
    mount()

    const panel = await screen.findByTestId('game-unavailable')
    expect(panel.textContent).toMatch(/nothing has been lost and nothing was signed/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })
})
