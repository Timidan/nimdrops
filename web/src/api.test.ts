import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createDrop, getDrop, submitFunding } from './api'

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
