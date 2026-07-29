import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WalletBridge } from '../sdk/adapter'
import MyDrops from './MyDrops'

const MESSAGE = '{"action":"list_creator_drops"}'
const WALLET = 'NQ12 ABCD EFGH IJKL MNOP QRST UVXY 1234 5678'

function bridge(): WalletBridge {
  return {
    ready: vi.fn(async () => {}),
    address: vi.fn(async () => WALLET),
    sign: vi.fn(async () => ({ publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) })),
    sendWithData: vi.fn(async () => ({ txHash: 'c'.repeat(64) })),
  }
}

function installFetch(drops: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/creator/challenge')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: MESSAGE, expiresAt: '2026-07-29T12:05:00.000Z' }),
          headers: { get: (): string | null => null },
        }
      }
      if (url.endsWith('/api/creator/drops')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ walletAddress: WALLET, drops, truncated: false }),
          headers: { get: (): string | null => null },
        }
      }
      throw new Error(`unscripted fetch: ${url}`)
    }),
  )
}

function mount(wallet: WalletBridge = bridge()) {
  return render(
    <MemoryRouter initialEntries={['/my-drops']}>
      <MyDrops discoverBridge={async () => ({ kind: 'real', bridge: wallet })} />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MyDrops', () => {
  it('signs once, then lists the connected wallet’s drops and controls', async () => {
    const wallet = bridge()
    installFetch([
      {
        publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
        sponsorLabel: 'Nimiq Community',
        message: 'Thanks for joining',
        amountEach: '2.5',
        claimCount: 5,
        remaining: 3,
        state: 'live',
        expiryHours: 24,
        expiresAt: '2026-07-30T12:00:00.000Z',
        closingReason: null,
        gateKind: null,
        createdAt: '2026-07-29T12:00:00.000Z',
      },
    ])
    mount(wallet)

    fireEvent.click(screen.getByRole('button', { name: /show my drops/i }))
    const item = await screen.findByTestId('creator-drop-Ab3Cd4Ef5Gh6Ij7Kl8Mn9O')

    expect(wallet.sign).toHaveBeenCalledOnce()
    expect(wallet.sign).toHaveBeenCalledWith(MESSAGE)
    expect(item.textContent).toMatch(/2\.5 NIM/i)
    expect(item.textContent).toMatch(/2 of 5 claimed/i)
    expect(item.textContent).toMatch(/live/i)
    expect(screen.getByRole('link', { name: /open details/i }).getAttribute('href')).toBe(
      '/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
    )
    expect(screen.getByRole('link', { name: /close and refund/i }).getAttribute('href')).toBe(
      '/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O/close',
    )
  })

  it('shares the wallet account before requesting its management signature', async () => {
    const wallet = bridge()
    let accountShared = false
    wallet.address = vi.fn(async () => {
      accountShared = true
      return WALLET
    })
    wallet.sign = vi.fn(async () => {
      if (!accountShared) throw new Error('account access was not approved')
      return { publicKey: 'a'.repeat(64), signature: 'b'.repeat(128) }
    })
    installFetch([
      {
        publicId: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
        sponsorLabel: 'Nimiq Community',
        message: null,
        amountEach: '2.5',
        claimCount: 5,
        remaining: 5,
        state: 'live',
        expiryHours: 24,
        expiresAt: '2026-07-30T12:00:00.000Z',
        closingReason: null,
        gateKind: null,
        createdAt: '2026-07-29T12:00:00.000Z',
      },
    ])
    mount(wallet)

    fireEvent.click(screen.getByRole('button', { name: /show my drops/i }))

    expect(await screen.findByTestId('creator-drop-Ab3Cd4Ef5Gh6Ij7Kl8Mn9O')).toBeTruthy()
  })

  it('shows an honest empty state for a wallet with no funded drops', async () => {
    installFetch([])
    mount()
    fireEvent.click(screen.getByRole('button', { name: /show my drops/i }))
    expect((await screen.findByTestId('creator-empty')).textContent).toMatch(/no funded drops/i)
  })

  it('hands a browser without the provider to Nimiq Pay', async () => {
    installFetch([])
    render(
      <MemoryRouter initialEntries={['/my-drops']}>
        <MyDrops discoverBridge={async () => ({ kind: 'unavailable' })} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /show my drops/i }))
    expect((await screen.findByTestId('open-in-app')).textContent).toMatch(
      /manage your drops in Nimiq Pay/i,
    )
  })

  it('returns to a retryable state when approval is refused', async () => {
    installFetch([])
    const wallet = bridge()
    wallet.sign = vi.fn(async () => {
      throw new Error('declined')
    })
    mount(wallet)
    fireEvent.click(screen.getByRole('button', { name: /show my drops/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /show my drops/i })).toBeTruthy())
    expect(screen.getByRole('status').textContent).toMatch(/nothing was sent/i)
  })
})
