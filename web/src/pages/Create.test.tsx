/**
 * Behaviour tests for the create-and-fund flow (design §4.2).
 *
 * The rules these tests exist to defend:
 *  - the total is DERIVED (`amount_each × people`), never entered;
 *  - the custody disclosure (§10.4) is on screen before the wallet opens;
 *  - a wallet rejection is recoverable and NEVER reads as "fund it again";
 *  - `Detecting → Confirming → Live` is driven by polled server state, not by
 *    a timer we made up.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge } from '../sdk/mock'
import Create from './Create'

/** 22 base64url chars — the shape `ids.ts` mints and `app.ts` validates. */
const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const SHARE_URL = `https://nimdrops.example/d/${PUBLIC_ID}`

/** What `POST /api/drops` answers for 2 NIM × 5 people. */
const DRAFT = {
  publicId: PUBLIC_ID,
  fundingAddress: 'NQ34 248H 2M0X R0LB 9YT4 4BFD 8AXL SN0P R1KL',
  fundingMemo: `ND1:${PUBLIC_ID}`,
  expectedFunding: '10',
  expectedFundingLuna: '1000000',
  shareUrl: SHARE_URL,
}

function dropBody(state: string, remaining = 5) {
  return {
    publicId: PUBLIC_ID,
    sponsorLabel: 'Team NimDrops',
    message: null,
    amountEach: '2',
    claimCount: 5,
    remaining,
    state,
    expiresAt: state === 'live' ? new Date(Date.now() + 86_400_000).toISOString() : null,
  }
}

interface Reply {
  status: number
  body: unknown
}

interface FetchScript {
  create?: Reply
  funding?: Reply
  /** Consumed one per `GET`; the last entry repeats forever. */
  drops?: Reply[]
}

function installFetch(script: FetchScript) {
  const calls: { url: string; method: string; init: RequestInit | undefined }[] = []
  const queue = [...(script.drops ?? [])]
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, init })
    let reply: Reply | undefined
    if (method === 'POST' && url.endsWith('/funding')) reply = script.funding
    else if (method === 'POST') reply = script.create
    else reply = queue.length > 1 ? queue.shift() : queue[0]
    if (!reply) throw new Error(`unscripted fetch: ${method} ${url}`)
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

function bridgeOf(bridge: WalletBridge): () => Promise<BridgeResult> {
  return async () => ({ kind: 'mock', bridge })
}

function rejectingBridge(): WalletBridge {
  return {
    ready: async () => {},
    sign: async () => ({ publicKey: '', signature: '' }),
    sendWithData: async () => {
      throw new BridgeError('provider_error', 'sendWithData', 'UserRejected: user rejected the request')
    },
  }
}

function fillForm(opts: { amount?: string; people?: string; from?: string } = {}) {
  fireEvent.change(screen.getByLabelText(/NIM per person/i), {
    target: { value: opts.amount ?? '2' },
  })
  fireEvent.change(screen.getByLabelText(/how many people/i), {
    target: { value: opts.people ?? '5' },
  })
  fireEvent.change(screen.getByLabelText(/^from$/i), {
    target: { value: opts.from ?? 'Team NimDrops' },
  })
}

function openReview() {
  fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
  return screen.getByRole('dialog')
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('Create — amount entry', () => {
  it('derives the total from NIM per person × people', () => {
    render(<Create discoverBridge={bridgeOf(new MockBridge())} />)
    fillForm({ amount: '2', people: '5' })
    expect(screen.getByText('10 NIM')).toBeTruthy()
  })

  it('keeps the total exact for fractional amounts (no float drift)', () => {
    render(<Create discoverBridge={bridgeOf(new MockBridge())} />)
    fillForm({ amount: '0.07', people: '3' })
    expect(screen.getByText('0.21 NIM')).toBeTruthy()
  })
})

describe('Create — review sheet', () => {
  it('shows the custody disclosure, expiry and refund rule before the wallet opens', () => {
    render(<Create discoverBridge={bridgeOf(new MockBridge())} />)
    fillForm()
    const sheet = openReview()
    expect(within(sheet).getByText('10 NIM')).toBeTruthy()
    // §10.4: funds are temporarily held by the operator.
    expect(within(sheet).getByText(/temporarily held/i)).toBeTruthy()
    // §10.4: default expiry and the exact refund rule.
    expect(within(sheet).getAllByText(/24 hours/i).length).toBeGreaterThan(0)
    expect(within(sheet).getByText(/refunded to the wallet that funded/i)).toBeTruthy()
    // §10.4: first come, first served, one per wallet, no personhood proof.
    expect(within(sheet).getByText(/one per wallet/i)).toBeTruthy()
  })
})

describe('Create — funding', () => {
  it('asks the wallet for the exact luna total and memo from the draft', async () => {
    const bridge = new MockBridge()
    const send = vi.spyOn(bridge, 'sendWithData')
    const { calls } = installFetch({
      create: { status: 201, body: DRAFT },
      funding: { status: 200, body: dropBody('funding_pending') },
      drops: [{ status: 200, body: dropBody('funding_pending') }],
    })
    vi.useFakeTimers()

    render(<Create discoverBridge={bridgeOf(bridge)} />)
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))
    await tick(1000)

    expect(send).toHaveBeenCalledWith({
      recipient: DRAFT.fundingAddress,
      valueLuna: 1_000_000n,
      data: DRAFT.fundingMemo,
    })

    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/drops'))
    expect(create).toBeTruthy()
    const headers = create!.init!.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
    // Same draft attempt keeps its key across retries, so a retried create
    // replays the same draft rather than minting a second one.
    expect(sessionStorage.length).toBeGreaterThan(0)
  })

  it('recovers from a wallet rejection without ever suggesting a second transaction', async () => {
    installFetch({ create: { status: 201, body: DRAFT } })
    render(<Create discoverBridge={bridgeOf(rejectingBridge())} />)
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    const retry = await screen.findByRole('button', { name: /try again/i })
    expect(retry).toBeTruthy()
    expect(document.body.textContent ?? '').not.toMatch(/re-?fund|fund again|send again/i)
  })

  it('walks Detecting → Confirming → Live off polled drop state', async () => {
    const bridge = new MockBridge()
    installFetch({
      create: { status: 201, body: DRAFT },
      funding: { status: 200, body: dropBody('awaiting_funding') },
      drops: [
        { status: 200, body: dropBody('funding_pending') },
        { status: 200, body: dropBody('live') },
      ],
    })
    vi.useFakeTimers()

    render(<Create discoverBridge={bridgeOf(bridge)} />)
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    /** The step the progress rail marks as current. */
    const step = () => screen.getByRole('listitem', { current: 'step' }).textContent

    await tick(1000)
    expect(step()).toBe('Detecting')
    // Slow detection must never turn into a prompt to pay twice.
    expect(document.body.textContent ?? '').not.toMatch(/fund again|send again/i)

    await tick(3000)
    expect(step()).toBe('Confirming')

    await tick(3000)
    expect(screen.getByRole('heading', { name: /your drop is live/i })).toBeTruthy()
  })
})

describe('Create — share screen', () => {
  async function reachLive() {
    const bridge = new MockBridge()
    installFetch({
      create: { status: 201, body: DRAFT },
      funding: { status: 200, body: dropBody('live') },
      drops: [{ status: 200, body: dropBody('live') }],
    })
    render(<Create discoverBridge={bridgeOf(bridge)} />)
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))
    await waitFor(() => screen.getByRole('heading', { name: /your drop is live/i }))
  }

  it('shows the canonical link, its QR, and a copy button', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await reachLive()

    expect(screen.getByText(SHARE_URL)).toBeTruthy()
    const qr = screen.getByRole('img', { name: /qr/i })
    expect(qr.getAttribute('src')).toBe(`/d/${PUBLIC_ID}/qr.svg`)

    fireEvent.click(screen.getByRole('button', { name: /copy link/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL))
  })

  it('offers the native share sheet only where the browser has one', async () => {
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    await reachLive()

    fireEvent.click(screen.getByRole('button', { name: /^share$/i }))
    await waitFor(() => expect(share).toHaveBeenCalled())

    // Take the capability away and render again: the button is conditional.
    Reflect.deleteProperty(navigator, 'share')
    cleanup()
    await reachLive()
    expect(screen.queryByRole('button', { name: /^share$/i })).toBeNull()
  })
})
