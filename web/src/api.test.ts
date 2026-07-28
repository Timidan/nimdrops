import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  createDrop,
  getDrop,
  getTriviaQuestion,
  submitFunding,
  submitTriviaAnswer,
} from './api'

function stubFetch(reply: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: reply.status < 400,
    status: reply.status,
    json: async () => reply.body,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const DRAFT = {
  publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
  fundingAddress: 'NQ34 248H 2M0X R0LB 9YT4 4BFD 8AXL SN0P R1KL',
  fundingMemo: 'ND1:Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
  expectedFunding: '10',
  expectedFundingLuna: '1000000',
  shareUrl: 'https://nimdrops.example/d/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('createDrop', () => {
  const input = { sponsorLabel: 'Team', amountEach: '2', claimCount: 5 }

  it('sends one Idempotency-Key and reuses it for the same draft attempt', async () => {
    const fetchMock = stubFetch({ status: 201, body: DRAFT })
    await createDrop(input)
    await createDrop(input)
    const keys = fetchMock.mock.calls.map(
      (call) => ((call as unknown[])[1] as { headers: Record<string, string> }).headers['Idempotency-Key'],
    )
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i)
    expect(keys[1]).toBe(keys[0])
  })

  it('mints a new key when the draft changes', async () => {
    const fetchMock = stubFetch({ status: 201, body: DRAFT })
    await createDrop(input)
    await createDrop({ ...input, claimCount: 6 })
    const keys = fetchMock.mock.calls.map(
      (call) => ((call as unknown[])[1] as { headers: Record<string, string> }).headers['Idempotency-Key'],
    )
    expect(keys[1]).not.toBe(keys[0])
  })

  it('keeps luna as a string — never a number', async () => {
    stubFetch({ status: 201, body: DRAFT })
    const draft = await createDrop(input)
    expect(draft.expectedFundingLuna).toBe('1000000')
    expect(BigInt(draft.expectedFundingLuna)).toBe(1_000_000n)
  })
})

describe('error envelope', () => {
  it('becomes a typed ApiError carrying the server code', async () => {
    stubFetch({ status: 422, body: { error: { code: 'wrong_amount', message: 'nope' } } })
    await expect(submitFunding('Ab3Cd4Ef5Gh6Ij7Kl8Mn9O', 'a'.repeat(64))).rejects.toMatchObject({
      code: 'wrong_amount',
      status: 422,
    })
  })

  it('falls back to a generic code when the body is not an envelope', async () => {
    stubFetch({ status: 500, body: 'nope' })
    const err = await getDrop('Ab3Cd4Ef5Gh6Ij7Kl8Mn9O').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('unknown')
  })
})

/**
 * The wallet address must reach the gate routes, and these are the only tests
 * that can tell.
 *
 * It is what makes a leaked session id useless on its own: without it, anyone who
 * saw a session id in a log, a referrer or a shared URL could submit a wrong
 * answer and impose the cooldown on that wallet. The server requires it, so
 * omitting it 400s every gate request.
 *
 * `Game.test.tsx` cannot catch that — it matches stubbed responses by URL suffix
 * and never inspects what was sent. So these assert the outgoing request itself.
 */
describe('gate requests carry the wallet', () => {
  const WALLET = 'NQ31 XF93 8ANH R6R7 1XKM 26UM 0Y82 3XPY 34FX'

  it('puts the wallet in the question URL', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: {
        questionIndex: 0,
        prompt: 'q?',
        options: ['a', 'b', 'c', 'd'],
        category: 'science',
        deadlineAt: new Date().toISOString(),
        questionCount: 5,
      },
    })
    await getTriviaQuestion('Ab3Cd4Ef5Gh6Ij7Kl8Mn9O', '11111111-2222-3333-4444-555555555555', WALLET)

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('wallet=')
    // Encoded, because a Nimiq address is written with spaces.
    expect(url).toContain(encodeURIComponent(WALLET))
  })

  it('puts the wallet in the answer body', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { state: 'in_progress', answered: 1, questionCount: 5 },
    })
    await submitTriviaAnswer(
      'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
      '11111111-2222-3333-4444-555555555555',
      0,
      2,
      WALLET,
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body)).toEqual({
      questionIndex: 0,
      answerIndex: 2,
      walletAddress: WALLET,
    })
  })
})
