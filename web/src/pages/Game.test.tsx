/**
 * The screen a stranger meets before they are allowed to claim.
 *
 * What these tests defend:
 *  - the pass screen is PLAIN and hands off to `/drop/:publicId`. Meeting a
 *    condition is not receiving, so no reveal happens here and no copy hurries
 *    anybody toward a signature;
 *  - the countdown comes from the server's deadline, and reaching zero submits
 *    nothing;
 *  - no correct answer is ever displayed, on a pass or a failure;
 *  - a failure says what ended it and the wait, and never blames the wallet;
 *  - amounts are exact, and "one tap" appears nowhere.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Game, { WALLET_STORAGE_KEY } from './Game'

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
    if (url.endsWith('/session')) reply = script.session
    else if (url.endsWith('/question')) reply = script.question
    else if (url.endsWith('/answer'))
      reply = answers ? (answers.length > 1 ? answers.shift() : answers[0]) : script.answer
    else if (url.endsWith('/passphrase'))
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
  it('asks for an address before any condition, and only after showing the offer', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount(null)

    const step = await screen.findByTestId('wallet-step')
    expect(step.textContent).toMatch(/which wallet is playing/i)
    // The reason it is asked, said out loud.
    expect(step.textContent).toMatch(/only that wallet can claim/i)
    expect(step.textContent).toMatch(/nothing is signed on this page/i)

    // The offer is visible first: a stranger learns what this is before being
    // asked for anything.
    const body = document.body.textContent ?? ''
    expect(body.indexOf('NIM')).toBeLessThan(body.indexOf('Which wallet is playing'))

    // No condition screen yet.
    expect(screen.queryByTestId('trivia-idle')).toBe(null)
  })

  it('refuses something that is not a Nimiq address, without losing what was typed', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount(null)

    await screen.findByTestId('wallet-step')
    fireEvent.change(screen.getByLabelText(/your nimiq address/i), {
      target: { value: 'not-an-address' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByTestId('wallet-problem').textContent).toMatch(/does not look like/i)
    expect(screen.queryByTestId('trivia-idle')).toBe(null)
  })

  it('remembers the address and moves on to the condition', async () => {
    installFetch({ game: { status: 200, body: gameBody() } })
    mount(null)

    await screen.findByTestId('wallet-step')
    fireEvent.change(screen.getByLabelText(/your nimiq address/i), { target: { value: PLAYER } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    })

    expect(await screen.findByTestId('trivia-idle')).toBeTruthy()
    expect(localStorage.getItem(WALLET_STORAGE_KEY)).toBe(PLAYER)
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
    expect(card.textContent).toMatch(/each question is timed/i)
    // How many are left, before spending five questions to find out.
    expect(screen.getByTestId('game-slots').textContent).toMatch(/7 shares left/)
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
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/answer'))).toBe(false)
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
    expect(failed.textContent).toMatch(/10 minutes/)
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

  it('shows the hint, one field and one button', async () => {
    installFetch(gate())
    mount()

    const form = await screen.findByTestId('passphrase-form')
    expect(screen.getByTestId('passphrase-hint').textContent).toBe('said at the 3pm talk')
    expect(form.querySelectorAll('input')).toHaveLength(1)
    expect(form.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /check the phrase/i })).toBeTruthy()
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
