/**
 * Behaviour tests for the create-and-fund flow (design §4.2).
 *
 * The rules these tests exist to defend:
 *  - the total is DERIVED (`amount_each × people`), never entered;
 *  - the custody disclosure (§10.4) is on screen before the wallet opens, and
 *    EVERY point `GET /api/custody` returns is rendered, in the server's order,
 *    above the fund button — the server owns those words, so drift is the bug;
 *  - a paused deployment stops the flow before a wallet prompt;
 *  - `drop_too_large` and `no_capacity` are told apart: one can never work and
 *    must not offer a retry, the other can and must;
 *  - the room this draft holds in the cap is named and counted down, and the
 *    limits are re-read when it lapses;
 *  - a wallet rejection is recoverable and NEVER reads as "fund it again";
 *  - `Detecting → Confirming → Live` is driven by polled server state, not by
 *    a timer we made up.
 *  - "Drop one back" arrives with `?amount=`, and that param is trusted no
 *    further than typed input is.
 *  - NO share affordance exists before the server says `live` — an unfunded
 *    packet is not shareable, and a link that leads to nothing is worse than
 *    no link;
 *  - a drop that WAS funded survives the app being closed, because the link is
 *    withheld until `live` and this browser holds the only copy of it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustodyDisclosure } from '../api'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge } from '../sdk/mock'
import { FUNDING_STORAGE_KEY, FUNDING_TTL_MS, type FundedDraft } from '../state/funding'
import Create, { type CreateProps } from './Create'

/** 22 base64url chars — the shape `ids.ts` mints and `app.ts` validates. */
const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const SHARE_URL = `https://nimdrops.example/drop/${PUBLIC_ID}`
const CUSTODY_ADDRESS = 'NQ34 248H 2M0X R0LB 9YT4 4BFD 8AXL SN0P R1KL'

/** What `POST /api/drops` answers for 2 NIM × 5 people. */
const DRAFT = {
  publicId: PUBLIC_ID,
  fundingAddress: CUSTODY_ADDRESS,
  fundingMemo: `ND1:${PUBLIC_ID}`,
  expectedFunding: '10',
  expectedFundingLuna: '1000000',
  shareUrl: SHARE_URL,
}

/**
 * `GET /api/custody` on a testnet deployment with room to spare — the default,
 * because it is the shape under which every other behaviour in this file is
 * meant to work. The strings are the server's own (`http/disclosure.ts`), not
 * an approximation: these tests exist to catch the client rewording them.
 */
function disclosure(over: Partial<CustodyDisclosure> = {}): CustodyDisclosure {
  return {
    network: 'TestAlbatross',
    chainLabel: 'the Nimiq test network',
    custodyAddress: CUSTODY_ADDRESS,
    mainnetPilot: false,
    paused: false,
    expiryHours: 24,
    fundingWindowMinutes: 30,
    limits: {
      aggregateMax: '250',
      aggregateMaxLuna: '25000000',
      remaining: '250',
      remainingLuna: '25000000',
      atRisk: '0',
      atRiskLuna: '0',
      outstandingLuna: '0',
      unactivatedFundedLuna: '0',
      maxLiveDrops: null,
      liveDrops: 0,
      reservedDrafts: 0,
      remainingDrops: null,
    },
    summary:
      'Your NIM goes to a wallet the operator controls, not to an escrow contract. The operator is holding 0 NIM in it right now.',
    points: [
      {
        id: 'not_escrow',
        text: 'This is not an escrow contract. Your NIM goes to one wallet the operator runs, and no code on chain holds it for you.',
      },
      {
        id: 'why_no_contract',
        text: 'A Nimiq HTLC pays one named recipient. A drop pays a list of people nobody knows yet, so no contract on this chain can hold the money. A person holds it instead.',
      },
      {
        id: 'operator_key',
        text: 'The operator holds the only key to that wallet and can move everything in it, including your funding.',
      },
      {
        id: 'exposure',
        text: 'Nothing limits the size of a drop, so the amount at risk is whatever sponsors have funded and the operator has not finished paying out. That is 0 NIM right now, and your drop adds to it.',
      },
      {
        id: 'mitigations',
        text: 'What stands in the way is not cryptography. The books are checked against the chain before anything is signed, only one process is ever allowed to sign, the operator can stop every payment at once, and funding does not count until the network has buried it 64 blocks deep.',
      },
      {
        id: 'limits',
        text: 'The operator has capped all live drops together at 250 NIM, and 250 NIM of that is free right now.',
      },
      {
        id: 'destination',
        text: `You are sending to ${CUSTODY_ADDRESS} on the Nimiq test network. Check that address in your wallet before you approve.`,
      },
      {
        id: 'test_network',
        text: 'This runs on the Nimiq test network. The NIM here is not real money.',
      },
      {
        id: 'expiry_clock',
        text: 'The 24 hour claim window starts when the network confirms your funding, not when you tap send. The operator holds your NIM for the whole window, and no one can end a drop early.',
      },
      {
        id: 'refunds',
        text: 'Whatever nobody claims goes back to the wallet you fund from. The operator signs that transfer, so a pause or a manual check can hold it up.',
      },
      {
        id: 'funding_window',
        text: 'This drop holds its room for 30 minutes. Fund it in this session, or check the limits again before you send.',
      },
    ],
    ...over,
  }
}

/**
 * A deployment with the operator's kill switch ON: 2 NIM of live principal, one
 * drop at a time, real money. Nothing caps a drop by default any more, so this
 * fixture is the case where a number CAN be refused for a reason the sponsor
 * could have read first — which is the only case the form still checks.
 */
function pilotDisclosure(over: Partial<CustodyDisclosure> = {}): CustodyDisclosure {
  const base = disclosure()
  return {
    ...base,
    network: 'MainAlbatross',
    chainLabel: 'the Nimiq main network',
    mainnetPilot: true,
    limits: {
      ...base.limits,
      aggregateMax: '2',
      aggregateMaxLuna: '200000',
      remaining: '2',
      remainingLuna: '200000',
      maxLiveDrops: 1,
      liveDrops: 0,
      reservedDrafts: 0,
      remainingDrops: 1,
    },
    summary:
      'Your NIM goes to a wallet the operator controls, not to an escrow contract. The operator is holding 0 NIM in it right now.',
    points: [
      ...base.points.slice(0, 5),
      {
        id: 'limits',
        text: 'The operator has capped all live drops together at 2 NIM, and 2 NIM of that is free right now. Only one drop can run at a time.',
      },
      {
        id: 'destination',
        text: `You are sending to ${CUSTODY_ADDRESS} on the Nimiq main network. Check that address in your wallet before you approve.`,
      },
      {
        id: 'first_mainnet_run',
        text: 'This is the first run with real NIM. Send a small amount and expect to watch it.',
      },
      ...base.points.slice(8),
    ],
    ...over,
  }
}

/**
 * What a sponsor actually meets: no ceiling of any kind. There is no `limits`
 * point, no `funding_window` point, and nothing on the form to check a total
 * against — the server's solvency invariant is the only thing that can refuse.
 */
function uncappedDisclosure(over: Partial<CustodyDisclosure> = {}): CustodyDisclosure {
  const base = disclosure()
  return {
    ...base,
    limits: {
      ...base.limits,
      aggregateMax: null,
      aggregateMaxLuna: null,
      remaining: null,
      remainingLuna: null,
      atRisk: '412.5',
      atRiskLuna: '41250000',
      outstandingLuna: '41250000',
      unactivatedFundedLuna: '0',
    },
    points: base.points
      .filter((p) => p.id !== 'limits' && p.id !== 'funding_window')
      .map((p) =>
        p.id === 'exposure'
          ? {
              ...p,
              text: 'Nothing limits the size of a drop, so the amount at risk is whatever sponsors have funded and the operator has not finished paying out. That is 412.5 NIM right now, and your drop adds to it.',
            }
          : p,
      ),
    ...over,
  }
}

/** The server puts the closed notice first, and the client must not re-sort. */
function pausedDisclosure(): CustodyDisclosure {
  const base = pilotDisclosure()
  return {
    ...base,
    paused: true,
    points: [
      {
        id: 'paused',
        text: 'Funding is closed right now. The operator has to open it before a new drop can start.',
      },
      ...base.points,
    ],
  }
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
  /** Only `Retry-After` is ever read, and only off a refusal. */
  headers?: Record<string, string>
}

interface FetchScript {
  create?: Reply
  /**
   * Consumed one per `POST /funding`; the last entry repeats forever. The
   * screen re-submits the same hash on every poll, because that endpoint is
   * the only thing that can move a drop from `funding_pending` to `live`.
   */
  funding?: Reply | Reply[]
  /** Consumed one per `GET`; the last entry repeats forever. */
  drops?: Reply[]
  /**
   * `GET /api/custody`, consumed one per call with the last repeating. Defaults
   * to a roomy testnet deployment so every other test in this file describes
   * the flow rather than the cap.
   */
  custody?: Reply | Reply[]
}

/** Take the next reply, holding the last one once the queue runs dry. */
function next(queue: Reply[]): Reply | undefined {
  return queue.length > 1 ? queue.shift() : queue[0]
}

function queueOf(value: Reply | Reply[] | undefined, fallback: Reply[]): Reply[] {
  if (Array.isArray(value)) return [...value]
  return value ? [value] : fallback
}

/**
 * `/api/custody`, with or without the `?expiryHours=` the screen appends when
 * the sponsor picks a window other than the default. Matching on the path and
 * not on the whole string is what stops a query parameter from reading as an
 * unscripted call.
 */
function isCustody(url: string): boolean {
  return url.split('?')[0].endsWith('/api/custody')
}

function installFetch(script: FetchScript) {
  const calls: { url: string; method: string; init: RequestInit | undefined }[] = []
  const drops = [...(script.drops ?? [])]
  const funding = queueOf(script.funding, [])
  const custody = queueOf(script.custody, [{ status: 200, body: disclosure() }])
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, init })
    let reply: Reply | undefined
    if (isCustody(url)) reply = next(custody)
    else if (method === 'POST' && url.endsWith('/funding')) reply = next(funding)
    else if (method === 'POST') reply = script.create
    else reply = next(drops)
    if (!reply) throw new Error(`unscripted fetch: ${method} ${url}`)
    const headers = reply.headers ?? {}
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

/** How many times the screen has asked the server for the live disclosure. */
function custodyCalls(calls: { url: string }[]) {
  return calls.filter((call) => isCustody(call.url)).length
}

/** The record `state/funding.ts` writes once the wallet has answered. */
function storeFunded(over: Partial<FundedDraft> = {}) {
  const record: FundedDraft = {
    draft: DRAFT,
    txHash: 'a'.repeat(64),
    savedAt: Date.now(),
    ...over,
  }
  localStorage.setItem(FUNDING_STORAGE_KEY, JSON.stringify(record))
  return record
}

/** Every way this screen could hand someone a link. None may exist unfunded. */
function shareAffordances() {
  return {
    url: screen.queryByText(SHARE_URL),
    qr: screen.queryByRole('img', { name: /qr/i }),
    copy: screen.queryByRole('button', { name: /copy link/i }),
    share: screen.queryByRole('button', { name: /^share$/i }),
    block: screen.queryByTestId('share-block'),
  }
}

function expectNoShareAffordance() {
  const found = shareAffordances()
  expect(found.url).toBeNull()
  expect(found.qr).toBeNull()
  expect(found.copy).toBeNull()
  expect(found.share).toBeNull()
  expect(found.block).toBeNull()
  // Not just absent from the accessibility tree — absent from the document.
  expect(document.body.innerHTML).not.toContain(PUBLIC_ID)
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

/**
 * The derived total, read the way a screen reader reads it.
 *
 * Since the redesign it is the same amount lockup the claimant meets — figure,
 * Nimiq signet, unit — printed bare in the open field above the form, so its
 * text content is three pieces and its accessible name is the sentence. Reading
 * the name rather than the DOM is also the stricter check: it is what a sponsor
 * who cannot see the screen is told the drop will cost.
 */
function totalNim(): string | null {
  return screen.getByTestId('amount-hero').getAttribute('aria-label')
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

/** Render, then wait for `GET /api/custody` to land before touching anything. */
async function renderLoaded(props: CreateProps = {}, script: FetchScript = {}) {
  installFetch(script)
  const result = renderCreate(props)
  await screen.findByTestId('live-limits')
  return result
}

/** The `id` of every disclosure point on screen, in document order. */
function pointIds(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll('[data-point]')).map((node) =>
    node.getAttribute('data-point'),
  )
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
  localStorage.clear()
})

describe('Create — amount entry', () => {
  it('derives the total from NIM per person × people', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ amount: '2', people: '5' })
    expect(totalNim()).toBe('10 NIM')
  })

  it('keeps the total exact for fractional amounts (no float drift)', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ amount: '0.07', people: '3' })
    expect(totalNim()).toBe('0.21 NIM')
  })

  /**
   * The money slot on a form is never empty. It rests at zero and names what it
   * is a total OF, so the derivation is on screen before the sponsor has to
   * work out why the number changed when they touched the headcount.
   */
  it('rests at zero, and says what the total is a total of', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    expect(totalNim()).toBe('0 NIM')
    expect(screen.getByTestId('derived-total').textContent).toContain('total for 5 people')

    fireEvent.change(screen.getByLabelText(/how many people/i), { target: { value: '8' } })
    expect(screen.getByTestId('derived-total').textContent).toContain('total for 8 people')
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
    expect(totalNim()).toBe('12.5 NIM')
  })

  it('accepts an amount that the old launch cap would have refused', () => {
    // 21 × the default 5 people is 105 NIM, one NIM past the ceiling that used
    // to live in `money.ts`. There is no ceiling to be past any more.
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create?amount=21')
    expect(amountField().value).toBe('21')
    expect(totalNim()).toBe('105 NIM')
  })

  it('leaves the seeded amount fully editable', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create?amount=2.5')
    fireEvent.change(amountField(), { target: { value: '7' } })
    expect(amountField().value).toBe('7')
    expect(totalNim()).toBe('35 NIM')
  })

  it('starts empty when no amount was passed', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) }, '/create')
    expect(amountField().value).toBe('')
    expect(totalNim()).toBe('0 NIM')
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
      expect(totalNim()).toBe('0 NIM')
      // The default form has no complaint on it; the capacity note is for a
      // total the sponsor actually built.
      expect(screen.queryByTestId('over-cap')).toBeNull()
      expect(document.body.textContent ?? '').not.toMatch(/invalid|not a valid|error/i)
    })
  }
})

describe('Create — review sheet', () => {
  it('shows the custody disclosure, expiry and refund rule before the wallet opens', async () => {
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()
    expect(within(sheet).getByText('10 NIM')).toBeTruthy()
    // §10.4: the operator holds it, and the words are the server's.
    expect(within(sheet).getByText(/no code on chain holds it for you/i)).toBeTruthy()
    expect(within(sheet).getByText(/holds the only key/i)).toBeTruthy()
    // §10.4: default expiry and the exact refund rule.
    expect(within(sheet).getAllByText(/24 hour/i).length).toBeGreaterThan(0)
    expect(within(sheet).getByText(/goes back to the wallet you fund from/i)).toBeTruthy()
    // §10.4: first come, first served, one per wallet, no personhood proof.
    expect(within(sheet).getByText(/one per wallet/i)).toBeTruthy()
  })

  it('falls back to shipped custody copy when the live disclosure will not load', async () => {
    installFetch({ custody: { status: 503, body: { error: { code: 'degraded', message: 'no' } } } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
      const dialog = screen.getByRole('dialog')
      within(dialog).getByTestId('custody-fallback')
      return dialog
    })
    // The two facts a sponsor may never fund without, even offline.
    expect(within(sheet).getByText(/not to an escrow contract/i)).toBeTruthy()
    expect(within(sheet).getByText(/goes back to the wallet you fund from/i)).toBeTruthy()
    // And a plain account of what is missing, with a way to ask again.
    expect(within(sheet).getByText(/the live limits did not load/i)).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: /load the limits again/i })).toBeTruthy()
  })

  /**
   * The review sheet used to press a disc of gold wax with the sponsor's
   * initial on it, on the argument that this is the moment they seal the
   * envelope and that the claimant would break the same seal.
   *
   * That object no longer exists on the other side. The claim surface's packet
   * (`ui/SealedEnvelope.tsx`) carries the Nimiq signet, not an initial, so the
   * two seals were never the same object and the illustration was decorating a
   * money confirmation. What the sponsor is shown instead is the transaction:
   * four rows, in the order they matter, above the disclosure and above the
   * button that opens the wallet.
   */
  it('states the transaction itself, with nothing decorative on it', () => {
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm({ from: 'Team NimDrops' })
    const sheet = openReview()

    expect(within(sheet).getByRole('heading', { name: /before you fund/i })).toBeTruthy()
    for (const label of ['Each person gets', 'People', 'You send', 'Claim window']) {
      expect(within(sheet).getByText(label)).toBeTruthy()
    }
    expect(within(sheet).getByText('10 NIM')).toBeTruthy()
    // The window the sponsor picked, not a constant. It is the default here
    // because nothing on the form touched it.
    expect(within(sheet).getByText('24 hours after it goes live')).toBeTruthy()
    expect(sheet.querySelector('.nd-wax')).toBeNull()
  })
})

/**
 * The claim window is the sponsor's choice, and the two things that make that
 * safe on this side are asserted here: the default costs no interaction, and
 * nothing on screen ever names a window other than the one selected.
 *
 * The bound is NOT tested here, because it is not enforced here. The chips can
 * only express valid windows; the server refuses everything else and
 * `server/test/api.test.ts` is where that is proved.
 */
describe('Create — the claim window', () => {
  function chips() {
    return within(screen.getByTestId('expiry-choice')).getAllByRole('radio')
  }

  function chipFor(hours: number) {
    return screen.getByTestId('expiry-choice').querySelector(`[data-hours="${hours}"]`)!
  }

  it('opens on 24 hours, so a sponsor who does not care is already finished', async () => {
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })

    const labels = chips().map((chip) => chip.textContent)
    expect(labels).toEqual(['1 hour', '6 hours', '24 hours', '3 days', '7 days', '14 days'])
    const checked = chips().filter((chip) => chip.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toBe('24 hours')
  })

  it('states the consequence of a longer window, not just its length', async () => {
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })
    const group = screen.getByTestId('expiry-choice').parentElement!

    expect(group.textContent).toMatch(/goes back to you 24 hours after the drop goes live/i)
    expect(group.textContent).toMatch(/holds it for the whole window/i)
    expect(group.textContent).toMatch(/no one can end a drop early/i)

    fireEvent.click(chipFor(168))
    expect(group.textContent).toMatch(/goes back to you 7 days after the drop goes live/i)
  })

  it('sends the chosen window, and omits the field entirely at the default', async () => {
    const script = installFetch({ create: { status: 201, body: { ...DRAFT, expiryHours: 72 } } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByTestId('live-limits'))

    fillForm()
    fireEvent.click(chipFor(72))
    await waitFor(() => expect(chipFor(72).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
    fireEvent.click(screen.getByRole('button', { name: /fund drop/i }))

    await waitFor(() => {
      const create = script.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/drops'))
      expect(create).toBeTruthy()
      expect(JSON.parse(String(create!.init!.body))).toMatchObject({ expiryHours: 72 })
    })
  })

  it('omits the window from the request when the sponsor leaves it alone', async () => {
    const script = installFetch({ create: { status: 201, body: DRAFT } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByTestId('live-limits'))

    fillForm()
    fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
    fireEvent.click(screen.getByRole('button', { name: /fund drop/i }))

    await waitFor(() => {
      const create = script.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/drops'))
      expect(create).toBeTruthy()
      // The default is the server's to define, so the untouched form makes the
      // request it always made.
      expect(Object.keys(JSON.parse(String(create!.init!.body)))).not.toContain('expiryHours')
    })
  })

  it('asks the server to describe the window it is showing, and shows what comes back', async () => {
    const week = disclosure({
      expiryHours: 168,
      points: disclosure().points.map((p) =>
        p.id === 'expiry_clock'
          ? {
              ...p,
              text: 'The 7 day claim window starts when the network confirms your funding, not when you tap send. The operator holds your NIM for the whole window, and no one can end a drop early.',
            }
          : p,
      ),
    })
    const script = installFetch({
      custody: [
        { status: 200, body: disclosure() },
        { status: 200, body: week },
      ],
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByTestId('live-limits'))

    fireEvent.click(chipFor(168))

    // The default asks for nothing; a chosen window asks for itself.
    await waitFor(() => {
      const custody = script.calls.filter((c) => isCustody(c.url)).map((c) => c.url)
      expect(custody[0]).not.toContain('expiryHours')
      expect(custody[1]).toContain('expiryHours=168')
    })

    fillForm()
    const sheet = openReview()
    expect(within(sheet).getByText('7 days after it goes live')).toBeTruthy()
    expect(within(sheet).getByText(/The 7 day claim window starts/)).toBeTruthy()
  })

  /**
   * The disclosure is the server's sentence about the sponsor's own money. A
   * sentence naming the wrong window is worse than no sentence, so while the
   * refresh for a new selection is in flight — or after one has failed — the
   * server's points come off screen and the shipped fallback takes their place,
   * naming the selection.
   */
  it('never shows a disclosure that describes a different window', async () => {
    installFetch({
      custody: [
        { status: 200, body: disclosure() },
        { status: 503, body: { error: { code: 'degraded', message: 'no' } } },
      ],
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByTestId('live-limits'))

    fillForm()
    fireEvent.click(chipFor(336))

    const sheet = await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
      const dialog = screen.getByRole('dialog')
      within(dialog).getByTestId('custody-fallback')
      return dialog
    })
    // The stale sentence about 24 hours is gone, and what replaces it names the
    // window the sponsor actually picked.
    expect(within(sheet).queryByText(/The 24 hour claim window starts/)).toBeNull()
    expect(within(sheet).getByText(/stops accepting claims 14 days after it goes live/i)).toBeTruthy()
    expect(within(sheet).getByText('14 days after it goes live')).toBeTruthy()
  })

  it('tells the sponsor when their funded drop goes back, using that drop own window', async () => {
    installFetch({
      create: { status: 201, body: { ...DRAFT, expiryHours: 72 } },
      funding: { status: 200, body: dropBody('live') },
      drops: [{ status: 200, body: { ...dropBody('live'), expiryHours: 72 } }],
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByTestId('live-limits'))

    fillForm()
    fireEvent.click(chipFor(72))
    fireEvent.click(screen.getByRole('button', { name: /review drop/i }))
    fireEvent.click(screen.getByRole('button', { name: /fund drop/i }))

    await screen.findByTestId('share-block')
    expect(screen.getByText(/refunded to the wallet that funded this drop, 3 days after/i)).toBeTruthy()
  })
})

/**
 * The single most important honesty surface in the product. NimDrops is a
 * custodial hot wallet with no on-chain escrow and, since the caps came out, no
 * ceiling on how much of a stranger's money it is holding. The sponsor has to
 * understand that BEFORE a wallet asks them to approve anything.
 *
 * The server owns the words — it holds the key and knows the live numbers, so
 * any sentence written on this side could drift away from what is true.
 * These tests defend the two properties that follow from that: every point it
 * sends is rendered, and it is rendered in the order it sent them.
 */
describe('Create — the custody disclosure', () => {
  it('renders every point the server sent, in the order it sent them', async () => {
    const live = disclosure()
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()

    const list = within(sheet).getByTestId('custody-points')
    expect(pointIds(list)).toEqual(live.points.map((point) => point.id))
    // Not just present in the right order — present verbatim.
    const rendered = Array.from(list.querySelectorAll('[data-point]')).map(
      (node) => node.textContent ?? '',
    )
    for (const [index, point] of live.points.entries()) {
      expect(rendered[index]).toBe(point.text)
    }
  })

  it('puts every point above the fund button', async () => {
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()

    const list = within(sheet).getByTestId('custody-points')
    const button = within(sheet).getByRole('button', { name: /fund drop/i })
    // DOCUMENT_POSITION_FOLLOWING: the button comes after the whole list, so
    // there is no way to reach it without the disclosure having gone past.
    expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('carries the server summary beside the fund button', async () => {
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()
    expect(within(sheet).getByTestId('custody-summary').textContent).toBe(disclosure().summary)
  })

  it('offers the same points as a card the sponsor can read while deciding', async () => {
    const live = disclosure()
    await renderLoaded({ discoverBridge: bridgeOf(new MockBridge()) })

    // The scariest fact is the headline of the card, not a footnote.
    const card = screen.getByTestId('custody-card')
    expect(card.textContent).toMatch(/no contract holds it for you/i)

    fireEvent.click(card)
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('heading', { name: /what you are trusting/i })).toBeTruthy()
    expect(pointIds(within(sheet).getByTestId('custody-points'))).toEqual(
      live.points.map((point) => point.id),
    )
    // Reading the disclosure is not a step in paying: no fund button here.
    expect(within(sheet).queryByRole('button', { name: /fund drop/i })).toBeNull()
  })
})

describe('Create — the live cap', () => {
  it('shows the headroom before an amount is typed, when there is a ceiling', async () => {
    installFetch({ custody: { status: 200, body: pilotDisclosure() } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    const limits = await screen.findByTestId('live-limits')
    expect(within(limits).getByText('2 of 2 NIM')).toBeTruthy()
    expect(within(limits).getByText('0 of 1')).toBeTruthy()
    // On screen before the field it constrains, not after a refusal.
    expect(amountField().value).toBe('')
  })

  it('refuses a total over the free headroom here rather than at the server', async () => {
    installFetch({ custody: { status: 200, body: pilotDisclosure() } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await screen.findByTestId('live-limits')

    fillForm({ amount: '2', people: '5' })
    expect(screen.getByTestId('over-cap').textContent).toMatch(
      /2 NIM is free across all drops right now/i,
    )
    expect((screen.getByRole('button', { name: /review drop/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    // Back under the headroom and the flow reopens.
    fillForm({ amount: '0.4', people: '5' })
    expect(screen.queryByTestId('over-cap')).toBeNull()
    expect((screen.getByRole('button', { name: /review drop/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})

/**
 * The default deployment, and the shape of the product the caps were removed
 * for: 2 NIM each to 100 people is one signature and 200 NIM, and nothing on
 * this screen may stand in its way.
 */
describe('Create — no ceiling', () => {
  async function renderUncapped() {
    installFetch({ custody: { status: 200, body: uncappedDisclosure() } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await screen.findByRole('button', { name: /review drop/i })
  }

  it('shows no limits box, because there is nothing to be limited by', async () => {
    await renderUncapped()
    expect(screen.queryByTestId('live-limits')).toBeNull()
  })

  it('lets a 100-person, 200 NIM drop through to review', async () => {
    await renderUncapped()
    fillForm({ amount: '2', people: '100' })
    expect(totalNim()).toBe('200 NIM')
    expect(screen.queryByTestId('over-cap')).toBeNull()
    expect((screen.getByRole('button', { name: /review drop/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('still holds the floor at two people', async () => {
    await renderUncapped()
    fillForm({ amount: '2', people: '1' })
    // The stepper clamps rather than letting an invalid count reach the server.
    expect((screen.getByLabelText(/how many people/i) as HTMLInputElement).value).toBe('2')
    expect((screen.getByRole('button', { name: /review drop/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('tells the sponsor what is actually at risk instead of a ceiling', async () => {
    await renderUncapped()
    fireEvent.click(screen.getByTestId('custody-card'))
    const sheet = screen.getByRole('dialog')
    expect(sheet.textContent).toMatch(/has not finished paying out/i)
    expect(sheet.textContent).toMatch(/412\.5 NIM right now/)
    expect(sheet.textContent, 'say why no contract can hold it').toMatch(/HTLC/)
    expect(sheet.textContent, 'no ceiling may be promised').not.toMatch(/can hold up to/i)
  })
})

describe('Create — funding is closed', () => {
  it('says so unmissably and lets no wallet prompt happen', async () => {
    const bridge = new MockBridge()
    const send = vi.spyOn(bridge, 'sendWithData')
    const script = installFetch({ custody: { status: 200, body: pausedDisclosure() } })
    renderCreate({ discoverBridge: bridgeOf(bridge) })

    const banner = await screen.findByTestId('funding-closed')
    expect(banner.textContent).toMatch(/funding is closed/i)
    // The server's own sentence, not one invented here.
    expect(banner.textContent).toMatch(/the operator has to open it/i)

    fillForm()
    const review = screen.getByRole('button', { name: /review drop/i }) as HTMLButtonElement
    expect(review.disabled).toBe(true)
    fireEvent.click(review)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(script.calls.some((call) => call.url.endsWith('/api/drops'))).toBe(false)
  })

  it('puts the closed notice first in the list, exactly where the server put it', async () => {
    installFetch({ custody: { status: 200, body: pausedDisclosure() } })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await screen.findByTestId('funding-closed')

    fireEvent.click(screen.getByTestId('custody-card'))
    const sheet = screen.getByRole('dialog')
    expect(pointIds(within(sheet).getByTestId('custody-points'))).toEqual(
      pausedDisclosure().points.map((point) => point.id),
    )
    expect(pointIds(within(sheet).getByTestId('custody-points'))[0]).toBe('paused')
  })

  it('stops at a closed screen when funding shuts between the check and the tap', async () => {
    const bridge = new MockBridge()
    const send = vi.spyOn(bridge, 'sendWithData')
    await renderLoaded(
      { discoverBridge: bridgeOf(bridge) },
      {
        // Open when the screen loaded, closed by the time the drop was created.
        custody: [
          { status: 200, body: disclosure() },
          { status: 200, body: pausedDisclosure() },
          { status: 200, body: disclosure() },
        ],
        create: { status: 503, body: { error: { code: 'paused', message: 'payouts are paused' } } },
      },
    )
    fillForm()
    fireEvent.click(within(openReview()).getByRole('button', { name: /fund drop/i }))

    const closed = await screen.findByTestId('funding-closed-screen')
    expect(within(closed).getByRole('heading', { name: /funding is closed right now/i })).toBeTruthy()
    expect(send).not.toHaveBeenCalled()

    // Checking again once the operator reopens returns the sponsor to the form
    // with their drop intact.
    fireEvent.click(within(closed).getByRole('button', { name: /check again/i }))
    await waitFor(() => screen.getByRole('button', { name: /review drop/i }))
    expect(amountField().value).toBe('2')
  })
})

/**
 * The two capacity refusals have different answers, so they get different
 * screens. Retrying `drop_too_large` can never work; retrying `no_capacity`
 * usually will. A single "try again" would be wrong for one of them.
 */
describe('Create — capacity refusals', () => {
  function refuse(reply: Reply, custody = pilotDisclosure()) {
    const bridge = new MockBridge()
    const send = vi.spyOn(bridge, 'sendWithData')
    const script = installFetch({ custody: { status: 200, body: custody }, create: reply })
    return { bridge, send, script }
  }

  async function fundWith(bridge: WalletBridge, amount = '0.4') {
    renderCreate({ discoverBridge: bridgeOf(bridge) })
    await screen.findByTestId('live-limits')
    fillForm({ amount })
    fireEvent.click(within(openReview()).getByRole('button', { name: /fund drop/i }))
  }

  it('tells a sponsor a too-large drop can only get smaller, and never offers a retry', async () => {
    const { bridge, send } = refuse({
      status: 422,
      body: {
        error: { code: 'drop_too_large', message: 'this pilot holds up to 2 NIM across all live drops' },
      },
    })
    await fundWith(bridge)

    const screen_ = await screen.findByTestId('drop-too-large')
    expect(within(screen_).getByRole('heading', { name: /over the operator/i })).toBeTruthy()
    // The live ceiling, and the two things that change it.
    expect(screen_.textContent).toMatch(/the operator has capped all live drops at 2 NIM/i)
    expect(screen_.textContent).toMatch(/lower the amount per person or the number of people/i)
    // No retry: this request cannot succeed later, and a retry button would
    // walk the sponsor into the same 422.
    expect(within(screen_).queryByRole('button', { name: /try again/i })).toBeNull()
    expect(send).not.toHaveBeenCalled()

    fireEvent.click(within(screen_).getByRole('button', { name: /change the amount/i }))
    expect(screen.getByRole('button', { name: /review drop/i })).toBeTruthy()
    expect(amountField().value).toBe('0.4')
  })

  it('tells a sponsor with no room how long to wait and how much is free', async () => {
    const busy = pilotDisclosure()
    busy.limits = { ...busy.limits, remaining: '0.5', remainingDrops: 1, liveDrops: 0 }
    const { bridge, send } = refuse(
      {
        status: 503,
        body: {
          error: { code: 'no_capacity', message: 'this drop needs 2 NIM and 0.5 NIM is free' },
        },
        headers: { 'retry-after': '30' },
      },
      busy,
    )
    await fundWith(bridge, '0.4')

    const screen_ = await screen.findByTestId('no-capacity')
    expect(within(screen_).getByRole('heading', { name: /no room for another drop/i })).toBeTruthy()
    expect(screen_.textContent).toMatch(/this drop needs 2 NIM/i)
    expect(screen_.textContent).toMatch(/0\.5 NIM of the 2 NIM cap is free right now/i)
    // Retry-After, turned into a number the sponsor can act on.
    expect(screen_.textContent).toMatch(/try again in about 30 seconds/i)
    // Both honest answers are offered, because both work.
    expect(within(screen_).getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(within(screen_).getByRole('button', { name: /change the amount/i })).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('names the slot, not the NIM, when the pilot is simply running a drop', async () => {
    const running = pilotDisclosure()
    running.limits = { ...running.limits, liveDrops: 1, remainingDrops: 0, remaining: '0' }
    const { bridge } = refuse(
      {
        status: 503,
        body: { error: { code: 'no_capacity', message: 'a drop is already running' } },
        headers: { 'retry-after': '30' },
      },
      running,
    )
    await fundWith(bridge, '0.4')

    const screen_ = await screen.findByTestId('no-capacity')
    expect(screen_.textContent).toMatch(/another drop is already running/i)
    expect(screen_.textContent).toMatch(/this deployment runs one at a time/i)
  })

  it('re-reads the limits after a refusal so the numbers on screen are current', async () => {
    const { bridge, script } = refuse({
      status: 422,
      body: { error: { code: 'drop_too_large', message: 'too large' } },
    })
    await fundWith(bridge)
    await screen.findByTestId('drop-too-large')
    // Once on mount, once because the refusal proves the mounted copy was stale.
    expect(custodyCalls(script.calls)).toBeGreaterThan(1)
  })
})

/**
 * Capacity is reserved when the funding instructions are issued and released
 * again 30 minutes later, so a sponsor who leaves the wallet open and comes
 * back may find the room gone. Saying so is the difference between a refusal
 * they understand and one that looks like a bug.
 */
describe('Create — the funding reservation window', () => {
  /** A wallet that opens and never answers: the sponsor is mid-approval. */
  function hangingBridge(): WalletBridge {
    return {
      ready: async () => {},
      sign: async () => ({ publicKey: '', signature: '' }),
      sendWithData: () => new Promise(() => {}),
    }
  }

  /**
   * Park the flow at "approve in Nimiq Pay", which is exactly where a sponsor
   * lingers. Fake timers throughout, because the thing under test is a clock.
   */
  async function reachApproving(reservedForMs: number) {
    vi.useFakeTimers()
    const roomier = pilotDisclosure()
    roomier.limits = { ...roomier.limits, remaining: '0.75' }
    const script = installFetch({
      custody: [
        { status: 200, body: pilotDisclosure() },
        { status: 200, body: roomier },
      ],
      create: {
        status: 201,
        body: {
          ...DRAFT,
          reservationExpiresAt: new Date(Date.now() + reservedForMs).toISOString(),
          disclosure: pilotDisclosure(),
        },
      },
    })
    renderCreate({ discoverBridge: bridgeOf(hangingBridge()) })
    await tick(1)
    screen.getByTestId('live-limits')
    fillForm({ amount: '0.4' })
    fireEvent.click(within(openReview()).getByRole('button', { name: /fund drop/i }))
    await tick(1)
    screen.getByTestId('reservation-note')
    return script
  }

  it('names how long the room is held while the wallet is open', async () => {
    await reachApproving(120_000)
    expect(screen.getByRole('heading', { name: /approve in nimiq pay/i })).toBeTruthy()
    expect(screen.getByTestId('reservation-note').textContent).toMatch(
      /held for another 2 minutes/i,
    )
  })

  it('re-reads the limits the moment the hold lapses, and says what is free now', async () => {
    const script = await reachApproving(120_000)
    const before = custodyCalls(script.calls)

    await tick(121_000)

    const note = screen.getByTestId('reservation-note').textContent ?? ''
    expect(note).toMatch(/the 30 minute hold on your room has ended/i)
    // The headroom in that sentence is the re-read one, not the stale one.
    expect(note).toMatch(/0\.75 NIM of the 2 NIM cap is free right now/i)
    expect(custodyCalls(script.calls)).toBeGreaterThan(before)
    // A lapse is not a payment: nothing here suggests sending twice.
    expect(document.body.textContent ?? '').not.toMatch(/fund again|send again|re-?fund/i)
  })

  it('counts down under a minute without pretending the room is gone', async () => {
    await reachApproving(120_000)
    await tick(70_000)
    expect(screen.getByTestId('reservation-note').textContent).toMatch(
      /held for less than a minute more/i,
    )
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
      funding: [
        { status: 200, body: dropBody('awaiting_funding') },
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
    // A sponsor arriving fresh, with no funded drop remembered from before.
    localStorage.clear()
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
    expect(qr.getAttribute('src')).toBe(`/drop/${PUBLIC_ID}/qr.svg`)

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

/**
 * The owner's rule: an unfunded packet is not shareable at all. A link that
 * leads to a card with no money behind it is worse than no link, so none of the
 * four ways this screen could hand one over — the URL, the QR, copy, or the
 * native share sheet — may exist before the server says `live`.
 */
describe('Create — the link is the reward for funding', () => {
  function startFunding(funding: Reply[]) {
    const bridge = new MockBridge()
    const script = installFetch({ create: { status: 201, body: DRAFT }, funding })
    renderCreate({ discoverBridge: bridgeOf(bridge) })
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))
    return script
  }

  it('shows no share affordance while the drop is awaiting funding', async () => {
    vi.useFakeTimers()
    startFunding([{ status: 200, body: dropBody('awaiting_funding') }])
    await tick(1000)

    expect(screen.getByRole('heading', { name: /detecting your transaction/i })).toBeTruthy()
    expectNoShareAffordance()
  })

  it('shows no share affordance while funding is confirming', async () => {
    vi.useFakeTimers()
    startFunding([{ status: 200, body: dropBody('funding_pending') }])
    await tick(1000)

    expect(screen.getByRole('heading', { name: /confirming on the network/i })).toBeTruthy()
    expectNoShareAffordance()
  })

  it('says where the link will appear instead of leaving a hole', async () => {
    vi.useFakeTimers()
    startFunding([{ status: 200, body: dropBody('awaiting_funding') }])
    await tick(1000)

    const note = screen.getByTestId('pending-share-note').textContent ?? ''
    expect(note).toMatch(/nothing to share yet/i)
    expect(note).toMatch(/funding confirms/i)
    // And the promise that makes waiting bearable, which the recovery tests
    // below are what keep true.
    expect(document.body.textContent ?? '').toMatch(/you can close NimDrops/i)
    // Waiting is never turned into "pay again".
    expect(document.body.textContent ?? '').not.toMatch(/fund again|send again|re-?fund/i)
  })

  it('reveals the share block on the transition to live, and only then', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    startFunding([
      { status: 200, body: dropBody('funding_pending') },
      { status: 200, body: dropBody('live') },
    ])

    await tick(1000)
    expectNoShareAffordance()

    await tick(3000)
    const revealed = shareAffordances()
    expect(revealed.block).toBeTruthy()
    expect(revealed.url).toBeTruthy()
    expect(revealed.qr?.getAttribute('src')).toBe(`/drop/${PUBLIC_ID}/qr.svg`)
    expect(revealed.copy).toBeTruthy()
    // The arrival is animated rather than a field quietly filling in; the class
    // is a plain animation, so reduced motion lands it fully formed.
    expect(revealed.block?.className).toContain('nd-rise')
  })

  it('keeps re-submitting the same transaction until the drop goes live', async () => {
    vi.useFakeTimers()
    const bridge = new MockBridge()
    const send = vi.spyOn(bridge, 'sendWithData')
    const script = installFetch({
      create: { status: 201, body: DRAFT },
      funding: [
        { status: 200, body: dropBody('funding_pending') },
        { status: 200, body: dropBody('funding_pending') },
        { status: 200, body: dropBody('live') },
      ],
    })
    renderCreate({ discoverBridge: bridgeOf(bridge) })
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    await tick(1000)
    await tick(3000)
    await tick(3000)

    const submits = script.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/funding'))
    expect(submits.length).toBeGreaterThan(1)
    // The SAME hash every time: re-submitting is the endpoint's idempotent
    // case, and it is the only thing that lifts a drop out of funding_pending.
    const hashes = new Set(submits.map((c) => JSON.parse(String(c.init?.body)).txHash))
    expect(hashes.size).toBe(1)
    // One wallet call, one transaction. Polling never asks for a second.
    expect(send).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: /your drop is live/i })).toBeTruthy()
  })

  it('stops re-submitting a hash the endpoint refuses, and keeps reading', async () => {
    vi.useFakeTimers()
    const script = installFetch({
      create: { status: 201, body: DRAFT },
      funding: [
        { status: 200, body: dropBody('funding_pending') },
        { status: 422, body: { error: { code: 'wrong_memo', message: 'no' } } },
      ],
      drops: [{ status: 200, body: dropBody('funding_pending') }],
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    await tick(1000)
    await tick(3000)
    const afterRefusal = script.calls.length
    await tick(3000)

    const later = script.calls.slice(afterRefusal)
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((c) => c.method === 'GET')).toBe(true)
    // Still waiting, still honest, still no link and no second payment.
    expectNoShareAffordance()
    expect(document.body.textContent ?? '').not.toMatch(/fund again|send again/i)
  })
})

/**
 * Because the link is withheld until `live`, this browser holds the only copy
 * of it while funding confirms. Closing the app must not lose the drop.
 */
describe('Create — coming back to a funded drop', () => {
  it('remembers the drop as soon as the wallet reports a transaction', async () => {
    installFetch({
      create: { status: 201, body: DRAFT },
      funding: { status: 200, body: dropBody('funding_pending') },
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    await waitFor(() => expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeTruthy())
    const stored = JSON.parse(String(localStorage.getItem(FUNDING_STORAGE_KEY)))
    expect(stored.draft.shareUrl).toBe(SHARE_URL)
    expect(stored.txHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('remembers nothing before the wallet has answered', async () => {
    installFetch({ create: { status: 201, body: DRAFT } })
    renderCreate({ discoverBridge: bridgeOf(rejectingBridge()) })
    fillForm()
    const sheet = openReview()
    fireEvent.click(within(sheet).getByRole('button', { name: /fund drop/i }))

    await screen.findByRole('button', { name: /try again/i })
    // Nothing left the wallet, so there is nothing to come back to — and a
    // record here would greet the next visit with "detecting your transaction"
    // for a transaction that was never signed.
    expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeNull()
  })

  it('hands back the link on a fresh mount when the drop went live meanwhile', async () => {
    storeFunded()
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    await waitFor(() => screen.getByRole('heading', { name: /your drop is live/i }))
    expect(screen.getByText(SHARE_URL)).toBeTruthy()
    expect(screen.getByRole('img', { name: /qr/i })).toBeTruthy()
    // The form is empty after a reload, so the total in the field is the one
    // the remembered record carries rather than one this screen recomputed.
    expect(totalNim()).toBe('10 NIM')
  })

  it('resumes the funding poll when the drop is still confirming', async () => {
    vi.useFakeTimers()
    storeFunded()
    installFetch({
      drops: [{ status: 200, body: dropBody('funding_pending') }],
      funding: [{ status: 200, body: dropBody('live') }],
    })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    await tick(1)
    expect(screen.getByRole('heading', { name: /confirming on the network/i })).toBeTruthy()
    expectNoShareAffordance()

    await tick(3000)
    expect(screen.getByRole('heading', { name: /your drop is live/i })).toBeTruthy()
    expect(screen.getByText(SHARE_URL)).toBeTruthy()
  })

  it('never flashes the empty form on the way back to a funded drop', () => {
    storeFunded()
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    // The very first paint, before any fetch has resolved.
    expect(screen.queryByRole('button', { name: /review drop/i })).toBeNull()
    expect(screen.getByRole('heading', { name: /finding your drop/i })).toBeTruthy()
  })

  it('keeps the drop when the API cannot be reached, and keeps polling', async () => {
    vi.useFakeTimers()
    storeFunded()
    const script = installFetch({ funding: [{ status: 200, body: dropBody('live') }] })
    script.fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    await tick(1)
    expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeTruthy()
    expect(screen.getByRole('heading', { name: /detecting your transaction/i })).toBeTruthy()

    await tick(3000)
    expect(screen.getByRole('heading', { name: /your drop is live/i })).toBeTruthy()
  })

  it('forgets a remembered drop the server has never heard of', async () => {
    storeFunded()
    installFetch({ drops: [{ status: 404, body: { error: { code: 'not_found', message: 'no' } } }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    await waitFor(() => screen.getByRole('button', { name: /review drop/i }))
    expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeNull()
  })

  it('forgets a remembered drop whose life is over', async () => {
    storeFunded()
    installFetch({ drops: [{ status: 200, body: dropBody('refunded', 0) }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    await waitFor(() => screen.getByRole('button', { name: /review drop/i }))
    expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeNull()
    expectNoShareAffordance()
  })

  it('ignores a record older than its 48-hour life', async () => {
    storeFunded({ savedAt: Date.now() - FUNDING_TTL_MS - 1 })
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    expect(screen.getByRole('button', { name: /review drop/i })).toBeTruthy()
    await waitFor(() => expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeNull())
  })

  it('ignores a record someone edited by hand', () => {
    localStorage.setItem(FUNDING_STORAGE_KEY, '{"draft":{"publicId":42}}')
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })

    expect(screen.getByRole('button', { name: /review drop/i })).toBeTruthy()
  })

  it('lets the sponsor put a funded drop down and start a fresh one', async () => {
    storeFunded()
    sessionStorage.setItem('nimdrops.idem.create:["Team NimDrops","","2",5]', 'spent-key')
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: bridgeOf(new MockBridge()) })
    await waitFor(() => screen.getByRole('heading', { name: /your drop is live/i }))

    fireEvent.click(screen.getByRole('button', { name: /send another drop/i }))

    expect(screen.getByRole('button', { name: /review drop/i })).toBeTruthy()
    expect(amountField().value).toBe('')
    expect(localStorage.getItem(FUNDING_STORAGE_KEY)).toBeNull()
    // The spent draft attempt goes too: replaying it would ask the wallet to
    // fund a drop that is already live.
    expect(sessionStorage.getItem('nimdrops.idem.create:["Team NimDrops","","2",5]')).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Opened in an ordinary browser
 * ---------------------------------------------------------------------- */

/**
 * Funding is one transaction signed in Nimiq Pay, so a browser with no provider
 * cannot finish this screen whatever is typed into it. It is told so on arrival
 * rather than after the form is filled in, and it is given the three ways out —
 * including the one the product never had: where to GET the wallet.
 */
describe('Create — no wallet on this device', () => {
  const unavailable = async (): Promise<BridgeResult> => ({ kind: 'unavailable' })

  it('replaces the form with the gate instead of letting it be filled in', async () => {
    installFetch({})
    renderCreate({ discoverBridge: unavailable })

    await screen.findByTestId('open-in-app')
    expect(screen.queryByLabelText(/NIM per person/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /review drop/i })).toBeNull()
  })

  it('offers the deep link, the link to type, and both app stores', async () => {
    installFetch({})
    renderCreate({ discoverBridge: unavailable })
    await screen.findByTestId('open-in-app')

    expect(
      screen.getByRole('link', { name: /open in nimiq pay/i }).getAttribute('href'),
    ).toMatch(/^nimiqpay:\/\/miniapp\?url=/)
    expect(screen.getByTestId('open-in-app-url').textContent).toContain('http')
    expect(screen.getByRole('link', { name: /app store/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /google play/i })).toBeTruthy()
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)
  })

  /**
   * The gate only ever downgrades a screen that is still a form. A sponsor whose
   * drop is already funded holds the only copy of its link, and a late
   * `unavailable` must never take that away from them.
   */
  it('never takes a funded drop off the screen', async () => {
    storeFunded()
    installFetch({ drops: [{ status: 200, body: dropBody('live') }] })
    renderCreate({ discoverBridge: unavailable })

    await waitFor(() => screen.getByRole('heading', { name: /your drop is live/i }))
    // Let the boot-time bridge answer land after the resume already won.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: /your drop is live/i })).toBeTruthy()
    expect(screen.queryByTestId('open-in-app')).toBeNull()
  })
})
