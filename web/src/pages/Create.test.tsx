/**
 * Behaviour tests for the create-and-fund flow (design §4.2).
 *
 * The rules these tests exist to defend:
 *  - the total is DERIVED (`amount_each × people`), never entered;
 *  - the custody disclosure (§10.4) is on screen before the wallet opens;
 *  - a wallet rejection is recoverable and NEVER reads as "fund it again";
 *  - `Detecting → Confirming → Live` is driven by polled server state, not by
 *    a timer we made up.
 *  - "Drop one back" arrives with `?amount=`, and that param is trusted no
 *    further than typed input is.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge } from '../sdk/mock'
import Create, { type CreateProps } from './Create'

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

/** Create reads its `?amount=` seed from the router, so it always mounts inside one. */
function renderCreate(props: CreateProps = {}, path = '/create') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Create {...props} />
    </MemoryRouter>,
  )
}

function amountField() {
  return screen.getByLabelText(/NIM per person/i) as HTMLInputElement
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
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ amount: '2', people: '5' })
    expect(screen.getByText('10 NIM')).toBeTruthy()
  })

  it('keeps the total exact for fractional amounts (no float drift)', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ amount: '0.07', people: '3' })
    expect(screen.getByText('0.21 NIM')).toBeTruthy()
  })
})

describe('Create — "Drop one back" prefill', () => {
  it('opens with the amount the claimant was handed by the link', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create?amount=2.5')
    expect(amountField().value).toBe('2.5')
    // Only the amount travelled, so the people count stays at its own default
    // rather than being invented from the sender's drop.
    expect((screen.getByLabelText(/how many people/i) as HTMLInputElement).value).toBe('5')
    // 2.5 × 5 — derived from the seed exactly as it would be from typing.
    expect(screen.getByTestId('derived-total').textContent).toBe('12.5 NIM')
  })

  it('accepts an amount that only just fits under the total cap', () => {
    // 20 × the default 5 people is exactly the 100 NIM launch cap.
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create?amount=20')
    expect(amountField().value).toBe('20')
  })

  it('leaves the seeded amount fully editable', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create?amount=2.5')
    fireEvent.change(amountField(), { target: { value: '7' } })
    expect(amountField().value).toBe('7')
    expect(screen.getByTestId('derived-total').textContent).toBe('35 NIM')
  })

  it('starts empty when no amount was passed', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create')
    expect(amountField().value).toBe('')
    expect(screen.getByTestId('derived-total').textContent).toBe('—')
  })

  // A link is not a keystroke: the claimant did not type any of this, so a param
  // that fails the form's own rules is dropped without a word.
  const rejected: [string, string][] = [
    ['junk', 'abc'],
    ['a comma decimal', '2,5'],
    ['a negative amount', '-1'],
    ['zero', '0'],
    ['zero written out', '0.00000'],
    ['an empty value', ''],
    ['more than five decimals', '0.123456'],
    ['a total over the 100 NIM cap at the default count', '21'],
    ['an absurd number', '99999999999999999999'],
    ['whitespace', '  2  '],
  ]

  for (const [label, value] of rejected) {
    it(`ignores ${label} without an error the user did not cause`, () => {
      renderCreate(
        { discoverBridge: bridgeOf(new MockBridge()) },
        `/create?amount=${encodeURIComponent(value)}`,
      )
      expect(amountField().value).toBe('')
      expect(screen.getByTestId('derived-total').textContent).toBe('—')
      // The default form has no complaint on it; the cap note is for a total the
      // sponsor actually built.
      expect(screen.queryByText(/A drop can hold up to 100 NIM/i)).toBeNull()
      expect(document.body.textContent ?? '').not.toMatch(/invalid|not a valid|error/i)
    })
  }
})

describe('Create — review sheet', () => {
  it('shows the custody disclosure, expiry and refund rule before the wallet opens', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
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

  it('seals the envelope: the sponsor initial is pressed into wax on the sheet', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ from: 'Team NimDrops' })
    const sheet = openReview()

    // §4.4: this is the moment the sponsor seals it, so it carries the same
    // wax the claimant will break at the other end of the link.
    const wax = sheet.querySelector('.nd-wax')
    expect(wax).toBeTruthy()
    expect(wax?.getAttribute('aria-hidden')).toBe('true')
    expect(wax?.querySelector('.nd-wax-mark')?.textContent).toBe('T')
    // Decorative only — it must not have crowded out the dialog's own label.
    expect(within(sheet).getByRole('heading', { name: /before you fund/i })).toBeTruthy()
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

    renderCreate({ discoverBridge: bridgeOf(bridge) })
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
    renderCreate({ discoverBridge: bridgeOf(rejectingBridge()) })
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

    renderCreate({ discoverBridge: bridgeOf(bridge) })
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
    renderCreate({ discoverBridge: bridgeOf(bridge) })
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
