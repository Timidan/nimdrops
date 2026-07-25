/**
 * The claim state machine (design §4.3, §4.4, §7).
 *
 * What these tests defend:
 *  - the wallet signs the EXACT message the server issued, nothing derived;
 *  - a 202 is a reservation, not a payment: `paid` only appears when the
 *    backend says `paid`;
 *  - the status token survives a reload, and a resumed claim never mints a
 *    second challenge (that would burn a second slot's worth of work and
 *    confuse the claimant about which claim is theirs);
 *  - every server rejection lands in a named state, never in a blank screen.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge, MOCK_PUBLIC_KEY, MOCK_SIGNATURE } from '../sdk/mock'
import { CLAIM_STORAGE_PREFIX, useClaim } from './claim'

/** 22 base64url chars — the shape `ids.ts` mints and `app.ts` validates. */
const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const CLAIM_ID = '3f1c2b7a-2f0c-4a1e-9c3d-8b5a1f2e4d60'
const STATUS_TOKEN = 'tok_opaque_status_token'
const TX_HASH = 'a'.repeat(64)

const CHALLENGE = {
  challengeId: '11111111-2222-4333-8444-555555555555',
  message: JSON.stringify({ v: 1, origin: 'https://nimdrops.example', drop: PUBLIC_ID, nonce: 'n' }),
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
}

function dropBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    publicId: PUBLIC_ID,
    sponsorLabel: 'Team NimDrops',
    message: 'Thanks for a good week',
    amountEach: '2',
    claimCount: 5,
    remaining: 3,
    state: 'live',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  }
}

interface Reply {
  status: number
  body: unknown
}

interface Script {
  drop?: Reply
  challenge?: Reply
  claim?: Reply
  /** Consumed one per poll; the last entry repeats forever. */
  status?: Reply[]
}

interface Call {
  url: string
  method: string
  init: RequestInit | undefined
}

function installFetch(script: Script) {
  const calls: Call[] = []
  const statuses = [...(script.status ?? [])]
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, init })
    let reply: Reply | undefined
    if (url.includes('/api/claims/')) reply = statuses.length > 1 ? statuses.shift() : statuses[0]
    else if (url.endsWith('/challenge')) reply = script.challenge
    else if (url.endsWith('/claims')) reply = script.claim
    else reply = script.drop
    if (!reply) throw new Error(`unscripted fetch: ${method} ${url}`)
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

function bridgeOf(bridge: WalletBridge): () => Promise<BridgeResult> {
  return async () => ({ kind: 'mock', bridge })
}

const unavailableBridge = async (): Promise<BridgeResult> => ({ kind: 'unavailable' })

function rejectingBridge(): WalletBridge {
  return {
    ready: async () => {},
    sign: async () => {
      throw new BridgeError('provider_error', 'sign', 'UserRejected: user rejected the request')
    },
    sendWithData: async () => ({ txHash: '' }),
  }
}

function accepted(state = 'reserved') {
  return { claimId: CLAIM_ID, statusToken: STATUS_TOKEN, state }
}

function statusBody(state: string, txHash?: string) {
  return { state, amountEach: '2', ...(txHash ? { txHash } : {}) }
}

function errorBody(code: string, message = 'nope') {
  return { error: { code, message } }
}

function mount(discoverBridge: () => Promise<BridgeResult> = bridgeOf(new MockBridge())) {
  return renderHook(() => useClaim(PUBLIC_ID, { discoverBridge, pollMs: 5 }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('useClaim — landing', () => {
  it('lands a live drop with shares left in `ready`', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.drop?.sponsorLabel).toBe('Team NimDrops')
    expect(result.current.amountEach).toBe('2')
  })

  it('lands in `no-wallet` when no Nimiq Pay provider is present', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    const { result } = mount(unavailableBridge)

    await waitFor(() => expect(result.current.state).toBe('no-wallet'))
    // The campaign is still readable — the claimant needs to know what they
    // are being asked to open a wallet for.
    expect(result.current.drop?.amountEach).toBe('2')
  })

  it('lands in `exhausted` when no shares remain', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ remaining: 0 }) } })
    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('exhausted'))
  })

  it('lands in `expired` for a closing drop', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'closing' }) } })
    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('expired'))
  })

  it('lands in `paused` when the money path is paused', async () => {
    installFetch({ drop: { status: 503, body: errorBody('paused', 'payouts are paused') } })
    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('paused'))
  })

  it('lands in `degraded` on a server error', async () => {
    installFetch({ drop: { status: 500, body: errorBody('internal') } })
    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('degraded'))
  })
})

describe('useClaim — claiming', () => {
  it('signs the exact challenge message and reserves a slot', async () => {
    const bridge = new MockBridge()
    const sign = vi.spyOn(bridge, 'sign')
    const { calls } = installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 202, body: accepted() },
      status: [{ status: 200, body: statusBody('reserved') }],
    })
    const { result } = mount(bridgeOf(bridge))
    await waitFor(() => expect(result.current.state).toBe('ready'))

    await act(async () => {
      await result.current.claim()
    })

    expect(sign).toHaveBeenCalledWith(CHALLENGE.message)
    await waitFor(() => expect(result.current.state).toBe('reserved'))

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/claims'))
    expect(post).toBeTruthy()
    const headers = post!.init!.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeTruthy()
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      challengeId: CHALLENGE.challengeId,
      publicKey: MOCK_PUBLIC_KEY,
      signature: MOCK_SIGNATURE,
    })

    // The status token is a bearer credential: header only, never the URL.
    const poll = calls.find((c) => c.url.includes('/api/claims/'))
    expect(poll!.url).not.toContain(STATUS_TOKEN)
    expect((poll!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${STATUS_TOKEN}`)

    // ...and it is persisted under this drop so a reload resumes the claim.
    const stored = localStorage.getItem(`${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`)
    expect(stored).toContain(STATUS_TOKEN)
    expect(stored).toContain(CLAIM_ID)
  })

  it('shows `confirming` while the payout is in flight', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 202, body: accepted() },
      status: [{ status: 200, body: statusBody('confirming') }],
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    await waitFor(() => expect(result.current.state).toBe('confirming'))
    expect(result.current.txHash).toBe(null)
  })

  it('maps the server `sending` state onto `confirming` — broadcast is not paid', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 202, body: accepted() },
      status: [{ status: 200, body: statusBody('sending') }],
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    await waitFor(() => expect(result.current.serverState).toBe('sending'))
    expect(result.current.state).toBe('confirming')
  })

  it('reaches `paid` only when the backend says paid, and carries the tx hash', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 202, body: accepted() },
      status: [
        { status: 200, body: statusBody('reserved') },
        { status: 200, body: statusBody('confirming') },
        { status: 200, body: statusBody('paid', TX_HASH) },
      ],
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    await waitFor(() => expect(result.current.state).toBe('paid'))
    expect(result.current.txHash).toBe(TX_HASH)
  })

  it('surfaces `manual_review` without losing the claim', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 202, body: accepted() },
      status: [{ status: 200, body: statusBody('manual_review') }],
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    await waitFor(() => expect(result.current.serverState).toBe('manual_review'))
    // Still in flight, not failed: the union has no `manual_review` member and
    // a review is exactly "we have your slot, a human is looking".
    expect(result.current.state).toBe('confirming')
  })
})

describe('useClaim — refusals', () => {
  it('treats a wallet rejection as recoverable and returns to `ready`', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
    })
    const { result } = mount(bridgeOf(rejectingBridge()))
    await waitFor(() => expect(result.current.state).toBe('ready'))

    await act(async () => {
      await result.current.claim()
    })
    expect(result.current.state).toBe('rejected')
    // Nothing was reserved, so nothing may be persisted.
    expect(localStorage.getItem(`${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`)).toBe(null)

    act(() => {
      result.current.retry()
    })
    expect(result.current.state).toBe('ready')
  })

  it('goes to `exhausted` when the last slot went to someone else', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 409, body: errorBody('exhausted') },
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    expect(result.current.state).toBe('exhausted')
  })

  it('goes to `expired` when the drop expired mid-claim', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 409, body: errorBody('drop_expired') },
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    expect(result.current.state).toBe('expired')
  })

  it('goes to `paused` when the server pauses between landing and claiming', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 503, body: errorBody('paused') },
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    expect(result.current.state).toBe('paused')
  })

  it('goes to `degraded` when the money path is temporarily unavailable', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 503, body: errorBody('degraded') },
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    expect(result.current.state).toBe('degraded')
  })

  it('treats a stale challenge as recoverable, not as a failure', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      claim: { status: 400, body: errorBody('challenge_expired', 'this claim request expired') },
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.state).toBe('ready'))
    await act(async () => {
      await result.current.claim()
    })

    expect(result.current.state).toBe('rejected')
    expect(result.current.notice).toMatch(/expired/i)
  })
})

describe('useClaim — resume after reload', () => {
  it('polls the stored claim and never mints a second challenge', async () => {
    localStorage.setItem(
      `${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`,
      JSON.stringify({ claimId: CLAIM_ID, statusToken: STATUS_TOKEN }),
    )
    const { calls } = installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: statusBody('paid', TX_HASH) }],
    })

    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('paid'))
    expect(result.current.txHash).toBe(TX_HASH)
    expect(calls.some((c) => c.url.endsWith('/challenge'))).toBe(false)
    expect(calls.some((c) => c.url.endsWith('/claims'))).toBe(false)
  })

  it('forgets a status token the server no longer recognises', async () => {
    localStorage.setItem(
      `${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`,
      JSON.stringify({ claimId: CLAIM_ID, statusToken: STATUS_TOKEN }),
    )
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 404, body: errorBody('not_found') }],
    })

    const { result } = mount()

    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(localStorage.getItem(`${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`)).toBe(null)
  })
})
