/**
 * The sponsor's close screen (`/drop/:publicId/close`).
 *
 * The rules these tests exist to defend:
 *  - irreversibility is stated BEFORE the wallet opens, on the same screen as
 *    the button, not after the fact;
 *  - the screen says what happens to the people holding the link — those who
 *    already claimed are still paid, everyone else finds the drop closed;
 *  - the amount named on the button is the amount coming back;
 *  - nothing ever says the refund has arrived; a 202 is "on its way";
 *  - a refusal is reported in the server's own words, and a wrong wallet does
 *    not read as a system failure;
 *  - a wallet closed without approving leaves the drop running and the screen
 *    retryable.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeResult, WalletBridge } from '../sdk/adapter'
import { BridgeError } from '../sdk/adapter'
import CloseDrop, { unclaimedNim } from './CloseDrop'

const PUBLIC_ID = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O'

const CHALLENGE = {
  challengeId: '11111111-2222-4333-8444-555555555555',
  message: '{"action":"close","drop":"Ab3Cd4Ef5Gh6Ij7Kl8Mn9O"}',
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
  challenge?: Reply
  close?: Reply
}

function installFetch(script: Script) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      let reply: Reply | undefined
      if (url.endsWith('/close/challenge')) reply = script.challenge
      else if (url.endsWith('/close')) reply = script.close
      else reply = script.drop
      if (!reply) throw new Error(`unscripted fetch: ${url}`)
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
    }),
  )
}

function signingBridge(): WalletBridge {
  return {
    ready: async () => {},
    sign: async () => ({ publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) }),
    sendWithData: async () => ({ txHash: '' }),
  }
}

function rejectingBridge(): WalletBridge {
  return {
    ready: async () => {},
    sign: async () => {
      throw new BridgeError('provider_error', 'sign', 'UserRejected: user rejected the request')
    },
    sendWithData: async () => ({ txHash: '' }),
  }
}

function mount(bridge: WalletBridge = signingBridge()) {
  const discoverBridge = async (): Promise<BridgeResult> => ({ kind: 'mock', bridge })
  return render(
    <MemoryRouter initialEntries={[`/drop/${PUBLIC_ID}/close`]}>
      <Routes>
        <Route
          path="/drop/:publicId/close"
          element={<CloseDrop discoverBridge={discoverBridge} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('unclaimedNim', () => {
  it('multiplies in luna, never in floating point', () => {
    expect(unclaimedNim(dropBody({ amountEach: '0.00001', remaining: 3 }) as never)).toBe('0.00003')
    expect(unclaimedNim(dropBody({ amountEach: '2.5', remaining: 3 }) as never)).toBe('7.5')
  })

  it('shows nothing rather than a wrong figure', () => {
    expect(unclaimedNim(dropBody({ remaining: 0 }) as never)).toBeNull()
    expect(unclaimedNim(dropBody({ amountEach: 'not a number' }) as never)).toBeNull()
  })
})

describe('CloseDrop — before the wallet', () => {
  it('states what comes back, who is still paid, and that it cannot be undone', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()

    // 3 unclaimed × 2 NIM.
    expect(await screen.findByRole('button', { name: /send back 6 NIM/i })).toBeTruthy()
    expect(screen.getByText(/2 people have already claimed/i)).toBeTruthy()
    expect(screen.getByText(/still paid in full/i)).toBeTruthy()
    expect(screen.getByText(/goes back to the wallet that funded this drop/i)).toBeTruthy()
    expect(screen.getByText(/finds the drop closed/i)).toBeTruthy()
    expect(screen.getByTestId('close-irreversible').textContent).toMatch(/cannot be undone/i)
  })

  it('offers a way out that is not closing', async () => {
    installFetch({ drop: { status: 200, body: dropBody() } })
    mount()

    const leave = await screen.findByRole('link', { name: /leave it running/i })
    expect(leave.getAttribute('href')).toBe(`/drop/${PUBLIC_ID}`)
  })

  it('refuses to offer a close on a drop that is already over', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'refunded' }) } })
    mount()

    expect(await screen.findByText(/already closed/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull()
  })

  it('says a draft has nothing to refund rather than calling it closed', async () => {
    installFetch({ drop: { status: 200, body: dropBody({ state: 'awaiting_funding' }) } })
    mount()

    expect(await screen.findByText(/never funded/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull()
  })
})

describe('CloseDrop — closing', () => {
  it('reports the refund as on its way, never as arrived', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      close: {
        status: 202,
        body: { claimedShares: 2, unclaimedShares: 3, refund: '6', refundLuna: '600000' },
      },
    })
    mount()

    const button = await screen.findByRole('button', { name: /send back 6 NIM/i })
    button.click()

    await waitFor(() => expect(screen.getByTestId('close-done')).toBeTruthy())
    expect(screen.getByText(/on its way back/i)).toBeTruthy()
    expect(screen.getByText(/2 shares already\s+claimed are still being paid out/i)).toBeTruthy()
    // The one word this screen may never say about a refund it has not seen land.
    expect(screen.queryByText(/\brefunded\b|\bpaid back\b|\barrived\b/i)).toBeNull()
  })

  it('keeps the drop running when the wallet closes without approving', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
    })
    mount(rejectingBridge())

    const button = await screen.findByRole('button', { name: /send back 6 NIM/i })
    button.click()

    await waitFor(() => expect(screen.getByTestId('close-notice')).toBeTruthy())
    expect(screen.getByTestId('close-notice').textContent).toMatch(/still running/i)
    // Still offered: nothing was signed, so this is a retry.
    expect(screen.getByRole('button', { name: /send back 6 NIM/i })).toBeTruthy()
  })

  it('passes a wrong-wallet refusal through in the server’s own words', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      close: {
        status: 403,
        body: errorBody('not_the_funder', 'only the wallet that funded this drop can close it'),
      },
    })
    mount()

    const button = await screen.findByRole('button', { name: /send back 6 NIM/i })
    button.click()

    await waitFor(() =>
      expect(screen.getByTestId('close-notice').textContent).toMatch(/only the wallet that funded/i),
    )
    // A wrong wallet is a retryable mistake, not a dead end.
    expect(screen.getByRole('button', { name: /send back 6 NIM/i })).toBeTruthy()
  })

  it('stops offering the button once the server says the drop is already closed', async () => {
    installFetch({
      drop: { status: 200, body: dropBody() },
      challenge: { status: 200, body: CHALLENGE },
      close: { status: 409, body: errorBody('already_closed', 'this drop is already closed') },
    })
    mount()

    const button = await screen.findByRole('button', { name: /send back 6 NIM/i })
    button.click()

    await waitFor(() => expect(screen.getByTestId('close-unavailable')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /send back/i })).toBeNull()
  })
})
