/**
 * The campaign page a stranger opens from a group chat (design §4.1, §4.3).
 *
 * The rules these tests exist to defend:
 *  - a link opened in a plain browser is NOT a dead end: deep link, QR and a
 *    copy button are all on screen (this is the most-travelled path for a
 *    shared link, so it gets its own test);
 *  - the button never promises "one tap" — it says "tap and approve";
 *  - "on its way" while pending, "Paid" only when the backend says paid;
 *  - degradation disables the claim button, it does not delete it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge } from '../sdk/mock'
import { CLAIM_STORAGE_PREFIX } from '../state/claim'
import Drop from './Drop'

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'
const CLAIM_ID = '3f1c2b7a-2f0c-4a1e-9c3d-8b5a1f2e4d60'
const STATUS_TOKEN = 'tok_opaque_status_token'
const TX_HASH = 'b'.repeat(64)

const CHALLENGE = {
  challengeId: '11111111-2222-4333-8444-555555555555',
  message: '{"v":1,"drop":"Ab3Cd4Ef5Gh6Ij7Kl8Mn9O"}',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
}

function dropBody(over: Record<string, unknown> = {}) {
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
  /** Consumed one per drop read; the last entry repeats forever. Wins over `drop`. */
  drops?: Reply[]
  challenge?: Reply
  claim?: Reply
  status?: Reply[]
}

function installFetch(script: Script) {
  const statuses = [...(script.status ?? [])]
  const drops = script.drops ? [...script.drops] : null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      let reply: Reply | undefined
      if (url.includes('/api/claims/')) reply = statuses.length > 1 ? statuses.shift() : statuses[0]
      else if (url.endsWith('/challenge')) reply = script.challenge
      else if (url.endsWith('/claims')) reply = script.claim
      else if (drops) reply = drops.length > 1 ? drops.shift() : drops[0]
      else reply = script.drop
      if (!reply) throw new Error(`unscripted fetch: ${url}`)
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
    }),
  )
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

function seedResumableClaim() {
  localStorage.setItem(
    `${CLAIM_STORAGE_PREFIX}${PUBLIC_ID}`,
    JSON.stringify({ claimId: CLAIM_ID, statusToken: STATUS_TOKEN }),
  )
}

function mount(
  discoverBridge: () => Promise<BridgeResult> = bridgeOf(new MockBridge()),
  pollMs = 5,
) {
  return render(
    <MemoryRouter initialEntries={[`/d/${PUBLIC_ID}`]}>
      <Routes>
        <Route
          path="/d/:publicId"
          element={<Drop discoverBridge={discoverBridge} pollMs={pollMs} />}
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

describe('Drop — the campaign card', () => {
  it('shows sponsor, the unverified chip, the fixed amount, what is left, and the message', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()

    expect(await screen.findByText('Team NimDrops')).toBeTruthy()
    // §4.1: the sponsor label is claimant-supplied text and is labelled as such.
    expect(screen.getByText(/unverified/i)).toBeTruthy()
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)
    expect(screen.getByText('Thanks for a good week')).toBeTruthy()
    expect(screen.getByText(/expires in/i)).toBeTruthy()
  })

  it('labels the action exactly "Claim 2 NIM — tap and approve"', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()

    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect(button.textContent).toBe('Claim 2 NIM — tap and approve')
  })

  it('never promises one tap, anywhere on the page', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await screen.findByRole('button', { name: /claim 2 NIM/i })

    expect(document.body.textContent ?? '').not.toMatch(/one[\s-]?tap/i)
    // Banned vocabulary: shares are fixed and equal, never a game of chance.
    expect(document.body.textContent ?? '').not.toMatch(/luck|random/i)
  })
})

describe('Drop — opened in a plain browser (no wallet)', () => {
  it('offers the Nimiq Pay deep link, a QR and a copy button instead of a dead end', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount(unavailableBridge)

    const link = await screen.findByRole('link', { name: /open in nimiq pay/i })
    expect(link.getAttribute('href')).toBe(
      `nimiqpay://miniapp?url=${encodeURIComponent(window.location.href)}`,
    )

    const qr = screen.getByRole('img', { name: /qr/i })
    expect(qr.getAttribute('src')).toBe(`/d/${PUBLIC_ID}/qr.svg`)

    expect(screen.getByRole('button', { name: /copy link/i })).toBeTruthy()
    // The offer is still visible, so the claimant knows what it is worth.
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
  })
})

describe('Drop — the sponsor has not funded it yet', () => {
  it('keeps the offer visible and says why, without a claim button that cannot work', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'awaiting_funding' }) } })
    mount()

    const panel = await screen.findByTestId('awaiting-funding')
    expect(panel.textContent).toMatch(/has not funded this NimDrop yet/i)
    expect(panel.textContent).toMatch(/nothing is wrong with this link/i)
    // The promise the poll has to keep.
    expect(panel.textContent).toMatch(/appears here as soon as the funding is confirmed/i)

    // A dead primary button reads as a broken page: there must not be one.
    expect(screen.queryByRole('button', { name: /claim/i })).toBe(null)
    expect(screen.getByTestId('status-pill').textContent).toBe('Not funded yet')
    // ...but there IS something that works.
    expect(screen.getByRole('button', { name: /copy link/i })).toBeTruthy()

    // The envelope stays sealed, and everything real stays on screen.
    expect(screen.getByTestId('envelope').getAttribute('data-envelope-open')).toBe('false')
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByText('Team NimDrops')).toBeTruthy()
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)

    // No spinner language, no blame, no promise of a tap that does nothing.
    expect(document.body.textContent ?? '').not.toMatch(/Opening/i)
    expect(document.body.textContent ?? '').not.toMatch(/one[\s-]?tap/i)
    expect(document.body.textContent ?? '').not.toMatch(/failed|error|your fault/i)
  })

  it('turns into a claimable drop on its own when the funding confirms', async () => {
    installFetch({
      drops: [
        { status: 200, body: dropBody({ state: 'awaiting_funding' }) },
        { status: 200, body: dropBody({ state: 'live' }) },
      ],
    })
    // A slower poll than the rest of this file uses, so the unfunded screen is
    // observably rendered before the refresh replaces it.
    mount(bridgeOf(new MockBridge()), 60)

    await screen.findByTestId('awaiting-funding')
    // No reload and no interaction — the poll does it.
    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('awaiting-funding')).toBe(null)
  })

  it('says a pending funding transaction is confirming, not that the page is opening', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'funding_pending' }) } })
    mount()

    const panel = await screen.findByTestId('funding-confirming')
    expect(panel.textContent).toMatch(/funding transaction is on the network and confirming/i)
    expect(panel.textContent).toMatch(/goes live the moment that transaction is final/i)
    expect(screen.getByTestId('status-pill').textContent).toBe('Confirming')
    expect(screen.queryByRole('button', { name: /claim/i })).toBe(null)
    expect(document.body.textContent ?? '').not.toMatch(/Opening/i)
  })
})

describe('Drop — claiming', () => {
  it('says "2 NIM is on its way" while the payout is pending', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'reserved', amountEach: '2' } }],
    })
    mount()

    expect(await screen.findByText(/2 NIM is on its way/i)).toBeTruthy()
    // §4.3: "Paid" is a backend fact, not a UI guess.
    expect(document.body.textContent ?? '').not.toMatch(/\bPaid\b/)
  })

  it('keeps the "on its way" promise while the payout is confirming', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'confirming', amountEach: '2' } }],
    })
    mount()

    expect(await screen.findByText(/2 NIM is on its way/i)).toBeTruthy()
  })

  it('says a reviewed claim is safe rather than pretending it is normal', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'manual_review', amountEach: '2' } }],
    })
    mount()

    const review = await screen.findByTestId('manual-review')
    expect(review.textContent).toMatch(/being reviewed/i)
    expect(review.textContent).toMatch(/safe/i)
  })

  it('shows the receipt with an explorer link once the backend says paid', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'paid', amountEach: '2', txHash: TX_HASH } }],
    })
    mount()

    expect(await screen.findByText(/^Paid$/)).toBeTruthy()
    const explorer = screen.getByRole('link', { name: /view on the nimiq explorer/i })
    expect(explorer.getAttribute('href')).toMatch(/^https:\/\/(test\.)?nimiq\.watch\//)
    expect(explorer.getAttribute('href')).toContain(TX_HASH)

    // §4.3 final CTAs.
    const back = screen.getByRole('link', { name: /drop one back/i })
    expect(back.getAttribute('href')).toBe('/create?amount=2')
    expect(screen.getByRole('button', { name: /share nimdrops/i })).toBeTruthy()
  })

  it('recovers from a wallet rejection with a retry that returns to the claim button', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
    })
    mount(bridgeOf(rejectingBridge()))

    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    await act(async () => {
      fireEvent.click(button)
    })

    const retry = await screen.findByRole('button', { name: /try again/i })
    expect(document.body.textContent ?? '').not.toMatch(/failed|error/i)
    await act(async () => {
      fireEvent.click(retry)
    })

    await waitFor(() => expect(screen.getByRole('button', { name: /claim 2 NIM/i })).toBeTruthy())
  })
})

describe('Drop — states that are not a claim', () => {
  it('offers "Drop one back" when every share is gone', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ remaining: 0 }) } })
    mount()

    expect(await screen.findByText(/every share/i)).toBeTruthy()
    const back = screen.getByRole('link', { name: /drop one back/i })
    expect(back.getAttribute('href')).toBe('/create?amount=2')
  })

  it('says the drop has ended when it is past its expiry', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'closing' }) } })
    mount()

    expect(await screen.findByText(/this drop has ended/i)).toBeTruthy()
    expect(screen.getByText(/refunded to the wallet that funded/i)).toBeTruthy()
  })

  it('disables the claim button on degradation instead of removing it', async () => {
    installFetch({ drop: { status: 200, body: dropBody() }, challenge: { status: 503, body: { error: { code: 'degraded', message: 'temporarily unavailable' } } } })
    mount()

    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    await act(async () => {
      fireEvent.click(button)
    })

    const still = await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect((still as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('degraded-banner').textContent).toMatch(/try again shortly|having trouble/i)
  })

  it('is honest about a pause instead of blaming the claimant', async () => {
    installFetch({ drop: { status: 503, body: { error: { code: 'paused', message: 'payouts are paused' } } } })
    mount()

    expect(await screen.findByText(/paused/i)).toBeTruthy()
    expect(document.body.textContent ?? '').toMatch(/no NIM has been lost|nothing has been lost/i)
  })
})
