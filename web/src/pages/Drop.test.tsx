/**
 * The drop page a stranger opens from a group chat (design §4.1, §4.3).
 *
 * The rules these tests exist to defend:
 *  - a link opened in a plain browser is NOT a dead end: deep link, QR and a
 *    copy button are all on screen (this is the most-travelled path for a
 *    shared link, so it gets its own test);
 *  - the button never promises "one tap" — the approval is stated in the line
 *    beneath it, and it is never reduced to a single gesture;
 *  - "on its way" while pending, "Paid" only when the backend says paid;
 *  - degradation disables the claim button, it does not delete it;
 *  - a claimant can forward a still-funded drop directly to another wallet.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type BridgeResult, type WalletBridge } from '../sdk/adapter'
import { MockBridge } from '../sdk/mock'
import { CLAIM_STORAGE_PREFIX } from '../state/claim'
import { FUNDING_STORAGE_KEY } from '../state/funding'
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
    // The window the sponsor chose. Every real server sends it; a claim screen
    // that has it names this drop's own deadline rather than a constant.
    expiryHours: 24,
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
    // The claim and funding paths must NEVER ask the wallet who it is: the
    // address is derived server-side from the verified sign() public key, and a
    // call here would be a silently added native prompt. Throwing makes that a
    // test failure instead of a UX regression nobody notices.
    address: () => Promise.reject(new Error('address() must not be called on this path')),
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
    <MemoryRouter initialEntries={[`/drop/${PUBLIC_ID}`]}>
      <Routes>
        <Route
          path="/drop/:publicId"
          element={<Drop discoverBridge={discoverBridge} pollMs={pollMs} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

/**
 * Break the seal, the way a keyboard or a screen reader does.
 *
 * The claim surface sits behind a full-screen sealed envelope now, so a test
 * that wants the transaction has to open it first. `detail: 0` is the
 * synthesised activation `Enter`, `Space` and an assistive double-tap all
 * produce, and it is the documented path that needs no sustained gesture —
 * `ui/SealedEnvelope.tsx` has the argument for why that path has to exist.
 *
 * States that are already past the envelope — a resumed claim, a settled one,
 * a dead end — open the gate themselves and never call this.
 */
async function unseal() {
  const envelope = await screen.findByTestId('hold-open')
  await act(async () => {
    fireEvent.click(envelope, { detail: 0 })
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  // Tests that need a Web Share API or a clipboard define one on `navigator`;
  // jsdom ships neither, so the honest reset is to take them away again.
  for (const key of ['share', 'clipboard']) {
    if (Object.getOwnPropertyDescriptor(navigator, key)?.configurable) {
      delete (navigator as unknown as Record<string, unknown>)[key]
    }
  }
})

describe('Drop — the drop card', () => {
  it('shows sponsor, the fixed amount, what is left, and the message', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    expect(await screen.findByText('Team NimDrops')).toBeTruthy()
    expect(screen.getByTestId('amount-hero').textContent).toMatch(/2\s*NIM/)
    expect(screen.getByTestId('remaining').textContent).toMatch(/3.*5/)
    expect(screen.getByText('Thanks for a good week')).toBeTruthy()
    // The deadline is a labelled tile in the open field now, not a sentence.
    expect(screen.getByText(/closes in/i)).toBeTruthy()
    expect(screen.getByTestId('countdown').textContent).toMatch(/\d+h/)
  })

  /**
   * The claim window is the sponsor's choice, so `expiresAt` can now be a
   * fortnight out. The countdown reads it per drop and needs no other change —
   * except its units: `335h 12m` is a number nobody converts, and it is wider
   * than the tabular figures beside it are laid out for.
   */
  it('counts a multi-day window down in days, and this drop own window in the sheet', async () => {
    installFetch({
      drop: {
        status: 200,
        body: dropBody({
          expiryHours: 336,
          expiresAt: new Date(Date.now() + 200 * 3600_000 + 30 * 60_000).toISOString(),
        }),
      },
    })
    mount()
    await unseal()

    // 200 hours is 8 days and 8 hours. Not "200h 30m".
    expect(screen.getByTestId('countdown').textContent).toBe('8d 8h')

    fireEvent.click(await screen.findByTestId('custody-disclosure'))
    const sheet = await screen.findByRole('dialog')
    expect(sheet.textContent).toMatch(/stops accepting claims\s*14 days\s*after it went live/i)
    expect(sheet.textContent, 'never a constant').not.toMatch(/24 hours/i)
  })

  /**
   * A first-time claimant has never heard of NimDrops. Above the fold they need
   * who sent it, what it is in one clause, how much, and one action — in that
   * order, and with nothing else competing.
   */
  it('introduces itself to someone who has never seen a NimDrop', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    expect(await screen.findByText(/sent you a NimDrop/i)).toBeTruthy()
    expect(screen.getByText(/a fixed share of NIM/i)).toBeTruthy()

    // The sponsor's own words come before the thing they are asked to press.
    // (The s4 layout puts the money and the drop's live facts in the open
    // field ABOVE the sheet, so the order inside the sheet is the one left to
    // defend: who sent it, what they said, then the action.)
    const body = document.body.textContent ?? ''
    expect(body.indexOf('Thanks for a good week')).toBeLessThan(body.indexOf('Claim 2 NIM'))

    // "Campaign" is sponsor-side vocabulary and must not reach a claimant.
    expect(body).not.toMatch(/campaign/i)
  })

  it('labels the money action exactly "Claim 2 NIM"', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect(button.textContent).toBe('Claim 2 NIM')
    // The approval expectation lives under the button, not on it.
    expect(document.body.textContent ?? '').toMatch(/you approve one signature/i)
    // …and the button says nothing the 3.5rem amount above it already said.
    expect(button.textContent).not.toMatch(/approve|tap/i)
  })

  it('never promises one tap, anywhere on the page', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()
    await screen.findByRole('button', { name: /claim 2 NIM/i })

    expect(document.body.textContent ?? '').not.toMatch(/one[\s-]?tap/i)
    // Banned vocabulary: shares are fixed and equal, never a game of chance.
    expect(document.body.textContent ?? '').not.toMatch(/luck|random/i)
  })

  it('does not stack a "Live" pill on top of a button that already says so', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect(screen.queryByTestId('status-pill')).toBe(null)
  })
})

/**
 * The claimant is the person being asked to trust a custodian, and used to see
 * two grey footer lines about it while the sponsor got the whole disclosure.
 */
describe('Drop — the custody disclosure', () => {
  it('opens a sheet with the facts a claimant is entitled to before they trust it', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    const card = await screen.findByTestId('custody-disclosure')
    expect(card.textContent).toMatch(/holding this NIM/i)
    expect(card.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBe(null)

    fireEvent.click(card)

    const sheet = await screen.findByRole('dialog')
    expect(sheet.textContent).toMatch(/who is holding this NIM/i)
    // The three facts that are nobody's favourite, unsoftened.
    expect(sheet.textContent).toMatch(/operator controls.*custody: not a smart contract/is)
    expect(sheet.textContent).toMatch(/one per wallet/i)
    expect(sheet.textContent).toMatch(/does not prove one person/i)
    expect(sheet.textContent).toMatch(/24 hours/i)
    expect(sheet.textContent).toMatch(/refunded to the wallet that funded it/i)

    fireEvent.click(screen.getByTestId('disclosure-close'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))
  })

  it('does not claim to be holding anything before the sponsor has funded it', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'awaiting_funding' }) } })
    mount()
    await unseal()

    await screen.findByTestId('awaiting-funding')
    expect(screen.queryByTestId('custody-disclosure')).toBe(null)
  })
})

describe('Drop — opened in a plain browser (no wallet)', () => {
  /**
   * The seal means the same thing everywhere. A device that cannot sign gets
   * the same full-screen sealed envelope a phone gets, with no amount on it and
   * no press affordance — a FINISHED state, not a disabled one — plus the deep
   * link and the QR. The branch is the SDK adapter reporting `unavailable`,
   * never a viewport width: a narrow desktop window is still a desktop, and a
   * phone browser outside Nimiq Pay has exactly the same problem as a monitor.
   */
  it('offers the Nimiq Pay deep link and a QR on a seal that cannot be opened', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount(unavailableBridge)

    const link = await screen.findByRole('link', { name: /open in nimiq pay/i })
    expect(link.getAttribute('href')).toBe(
      `nimiqpay://miniapp?url=${encodeURIComponent(window.location.href)}`,
    )

    const qr = screen.getByRole('img', { name: /qr/i })
    expect(qr.getAttribute('src')).toBe(`/drop/${PUBLIC_ID}/qr.svg`)

    // Sealed, and there is nothing on it to press.
    expect(screen.getByTestId('sealed-envelope')).toBeTruthy()
    expect(screen.queryByTestId('hold-open')).toBe(null)
    expect(document.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0)

    // The amount is NOT on it. What the claimant is told instead is the fact
    // that makes concealing it a ritual rather than a draw.
    expect(screen.queryByTestId('amount-hero')).toBe(null)
    expect(screen.getByTestId('sealed-only').textContent).toMatch(/every share.*same size/i)
  })
})

describe('Drop — the sponsor has not funded it yet', () => {
  it('keeps the offer visible and says why, without a claim button that cannot work', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'awaiting_funding' }) } })
    mount()
    await unseal()

    const panel = await screen.findByTestId('awaiting-funding')
    expect(panel.textContent).toMatch(/has not funded this NimDrop yet/i)
    expect(panel.textContent).toMatch(/nothing is wrong with this link/i)
    // The promise the poll has to keep.
    expect(panel.textContent).toMatch(/appears here as soon as the funding is confirmed/i)

    // A dead primary button reads as a broken page: there must not be one.
    expect(screen.queryByRole('button', { name: /^open/i })).toBe(null)
    expect(screen.getByTestId('status-pill').textContent).toBe('Not funded yet')
    // ...but there IS something that works. It is a 44px circle on the rail
    // now rather than a full-width button, so it is found by its name.
    expect(screen.getByRole('button', { name: /copy the link/i })).toBeTruthy()

    // The sheet is on screen and everything real stays on it.
    expect(screen.getByTestId('claim-sheet')).toBeTruthy()
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
    await unseal()

    await screen.findByTestId('awaiting-funding')
    // No reload and no interaction — the poll does it.
    const button = await screen.findByRole('button', { name: /claim 2 NIM/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('awaiting-funding')).toBe(null)
  })

  it('says a pending funding transaction is confirming, not that the page is opening', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'funding_pending' }) } })
    mount()
    await unseal()

    const panel = await screen.findByTestId('funding-confirming')
    expect(panel.textContent).toMatch(/funding transaction is on the network and confirming/i)
    expect(panel.textContent).toMatch(/goes live the moment that transaction is final/i)
    expect(screen.getByTestId('status-pill').textContent).toBe('Confirming')
    expect(screen.queryByRole('button', { name: /^open/i })).toBe(null)
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
    // Same two facts, fewer words: a person is looking at it, and the money is
    // safe while they do.
    expect(review.textContent).toMatch(/a person is reviewing/i)
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
    expect(screen.getByTestId('share-link')).toBeTruthy()

    const nextSteps = screen.getByTestId('post-claim-actions')
    expect(within(nextSteps).getByRole('link', { name: /spend NIM/i })).toBeTruthy()
    expect(within(nextSteps).getByRole('link', { name: /sell NIM/i })).toBeTruthy()

    // "Drop" is claimant vocabulary; "Campaign" is the sponsor's.
    expect(document.body.textContent ?? '').not.toMatch(/campaign/i)
  })

  it('forwards a still-funded drop to the next wallet', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'paid', amountEach: '2', txHash: TX_HASH } }],
    })
    // jsdom has no Web Share API, so there is nothing to spy on: define it.
    const share = vi.fn(async (_data: ShareData) => {})
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    mount()

    const button = await screen.findByTestId('share-link')
    expect(button.getAttribute('aria-label')).toBe('Share this drop')
    fireEvent.click(button)

    expect(share).toHaveBeenCalledTimes(1)
    const payload = share.mock.calls[0]![0]
    expect(payload.url).toBe(`${window.location.origin}/drop/${PUBLIC_ID}`)
    expect(payload.text).toMatch(/fixed 2 NIM share is waiting/i)
    expect(payload.text).toMatch(/one per wallet/i)
  })

  it('falls back to copying the canonical drop link where the share sheet does not exist', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody() },
      status: [{ status: 200, body: { state: 'paid', amountEach: '2', txHash: TX_HASH } }],
    })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount()

    const button = await screen.findByTestId('share-link')
    await act(async () => {
      fireEvent.click(button)
    })

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/drop/${PUBLIC_ID}`)
    await waitFor(() => expect(screen.getByText('Drop link copied')).toBeTruthy())
  })

  it('shares the product instead of forwarding a closed drop', async () => {
    seedResumableClaim()
    installFetch({
      drop: { status: 200, body: dropBody({ state: 'settled', remaining: 0 }) },
      status: [{ status: 200, body: { state: 'paid', amountEach: '2', txHash: TX_HASH } }],
    })
    const share = vi.fn(async (_data: ShareData) => {})
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    mount()

    const button = await screen.findByTestId('share-link')
    expect(button.getAttribute('aria-label')).toBe('Share NimDrops')
    fireEvent.click(button)

    expect(share).toHaveBeenCalledTimes(1)
    expect(share.mock.calls[0]![0].url).toBe(window.location.origin)
  })

  it('recovers from a wallet rejection with a retry that returns to the claim button', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
    })
    mount(bridgeOf(rejectingBridge()))
    await unseal()

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
    installFetch({
      drop: {
        status: 200,
        body: dropBody({ state: 'closing', expiresAt: new Date(Date.now() - 1000).toISOString() }),
      },
    })
    mount()

    expect(await screen.findByText(/this drop has ended/i)).toBeTruthy()
    expect(screen.getByText(/refunded to the wallet that funded/i)).toBeTruthy()
  })

  it('offers the close screen only to the browser that funded this drop', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()
    // A claimant is never shown a control that ends the drop they are reading.
    expect(await screen.findByTestId('claim-sheet')).toBeTruthy()
    expect(screen.queryByTestId('sponsor-close-link')).toBeNull()
    cleanup()

    localStorage.setItem(
      FUNDING_STORAGE_KEY,
      JSON.stringify({
        draft: {
          publicId: PUBLIC_ID,
          fundingAddress: 'NQ07 CUSTODY',
          fundingMemo: `ND1:${PUBLIC_ID}`,
          expectedFunding: '10',
          expectedFundingLuna: '1000000',
          shareUrl: `https://nimdrops.test/drop/${PUBLIC_ID}`,
        },
        txHash: 'c'.repeat(64),
        savedAt: Date.now(),
      }),
    )
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()
    await unseal()

    const link = await screen.findByTestId('sponsor-close-link')
    expect(link.querySelector('a')?.getAttribute('href')).toBe(`/drop/${PUBLIC_ID}/close`)
    localStorage.clear()
  })

  it('names the sponsor when they closed the drop early, and says who is still paid', async () => {
    installFetch({
      drop: {
        status: 200,
        // The server's reason, not a shape this screen reads a reason out of.
        body: dropBody({ state: 'closing', closingReason: 'closed_by_sponsor', remaining: 3 }),
      },
    })
    mount()

    expect(await screen.findByText(/the sponsor closed this drop/i)).toBeTruthy()
    // The two facts a claimant landing here has to be given: nothing left them,
    // and anyone who did claim is still being paid.
    expect(screen.getByText(/nothing was taken from your wallet/i)).toBeTruthy()
    expect(screen.getByText(/already claimed a share still gets paid/i)).toBeTruthy()
  })

  it('disables the claim button on degradation instead of removing it', async () => {
    installFetch({ drop: { status: 200, body: dropBody() }, challenge: { status: 503, body: { error: { code: 'degraded', message: 'temporarily unavailable' } } } })
    mount()
    await unseal()

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
