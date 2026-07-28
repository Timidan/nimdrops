import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { useTriviaSession } from './trivia'

vi.mock('../api')

const PLAYER = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'

/** A deadline 15s out, expressed the way the server does. */
function question(index: number, secondsOut = 15) {
  return {
    questionIndex: index,
    prompt: `q${index}?`,
    options: ['a', 'b', 'c', 'd'],
    category: 'science',
    deadlineAt: new Date(Date.now() + secondsOut * 1000).toISOString(),
    questionCount: 5,
  }
}

describe('useTriviaSession', () => {
  beforeEach(() => {
    // Not in the plan's copy of this file, and it does not pass without it: the
    // suite has no `clearMocks` config, so `submitTriviaAnswer` reaches the
    // last case carrying three calls from earlier ones — and the rejecting
    // implementation one of them installed. `claim.test.ts` resets in an
    // `afterEach` for the same reason.
    vi.resetAllMocks()
    vi.mocked(api.startTriviaSession).mockResolvedValue({
      sessionId: 's-1',
      questionCount: 5,
      secondsPerQuestion: 15,
      deliveredCount: 0,
    })
    vi.mocked(api.getTriviaQuestion).mockResolvedValue(question(0))
  })

  it('starts idle and fetches nothing before start()', () => {
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    expect(result.current.phase).toBe('idle')
    expect(api.startTriviaSession).not.toHaveBeenCalled()
  })

  it('exposes the first question after start()', async () => {
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await waitFor(() => expect(result.current.phase).toBe('playing'))
    expect(result.current.question?.questionIndex).toBe(0)
    expect(result.current.question?.options).toHaveLength(4)
  })

  it('derives secondsLeft from the server deadline, not from when it rendered', async () => {
    vi.mocked(api.getTriviaQuestion).mockResolvedValue(question(0, 4))
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await waitFor(() => expect(result.current.secondsLeft).toBeLessThanOrEqual(4))
    expect(result.current.secondsLeft).toBeGreaterThan(0)
  })

  it('reaches passed when the final answer is accepted', async () => {
    vi.mocked(api.submitTriviaAnswer).mockResolvedValue({
      state: 'passed',
      answered: 5,
      questionCount: 5,
    })
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.submit(1)
    })
    expect(result.current.phase).toBe('passed')
  })

  it('reaches failed on a wrong answer and reveals no correct answer', async () => {
    vi.mocked(api.submitTriviaAnswer).mockResolvedValue({
      state: 'failed',
      answered: 2,
      questionCount: 5,
    })
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.submit(0)
    })
    expect(result.current.phase).toBe('failed')
    expect(JSON.stringify(result.current)).not.toContain('answerIndex')
  })

  it('treats a missed deadline as a failure with the server’s own sentence', async () => {
    vi.mocked(api.submitTriviaAnswer).mockRejectedValue(
      Object.assign(new Error('time ran out on that question'), { code: 'deadline_missed' }),
    )
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.submit(0)
    })
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toContain('time ran out')
  })

  it('does not auto-submit when the countdown reaches zero', async () => {
    vi.mocked(api.getTriviaQuestion).mockResolvedValue(question(0, -1))
    const { result } = renderHook(() => useTriviaSession('game-1', PLAYER))
    await act(async () => {
      await result.current.start()
    })
    await waitFor(() => expect(result.current.secondsLeft).toBe(0))
    expect(api.submitTriviaAnswer).not.toHaveBeenCalled()
  })
})
