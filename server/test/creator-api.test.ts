import { KeyPair } from '@nimiq/core'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../src/chain/fake'
import { makeApp } from '../src/http/app'

const ORIGIN = 'https://nimdrops.test'
const NOW_MS = 1_800_000_000_000

function dropRow() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    public_id: 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
    sponsor_label: 'Nimiq Community',
    message: null,
    claim_count: 5,
    amount_each_luna: '250000',
    expected_funding_luna: '1250000',
    state: 'live',
    funding_tx_hash: 'a'.repeat(64),
    activated_height: '100',
    expiry_hours: 24,
    expires_at: new Date('2027-01-16T08:00:00.000Z'),
    closing_reason: null,
    claims_reserved: '2',
    gate_kind: null,
    created_at: new Date('2027-01-15T08:00:00.000Z'),
  }
}

describe('creator management API', () => {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [dropRow()] }))
  const app = makeApp({
    pool: { query } as unknown as Pool,
    chain: new FakeChain({ custody: 'NQ07 CUSTODY', finalityDepth: 5 }),
    alerts: { notify: async () => {} },
    now: () => NOW_MS,
  })

  beforeEach(() => {
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    query.mockClear()
  })

  afterEach(() => {
    delete process.env.SIG_SCHEME
  })

  async function challenge(): Promise<string> {
    const res = await app.request('/api/creator/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { message: string }).message
  }

  it('returns only the drops belonging to the wallet that signed', async () => {
    const keyPair = KeyPair.generate()
    const message = await challenge()
    const signature = keyPair.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex()
    const res = await app.request('/api/creator/drops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: keyPair.publicKey.toHex(), signature, message }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { walletAddress: string; drops: unknown[] }
    expect(body.walletAddress).toBe(keyPair.toAddress().toUserFriendlyAddress())
    expect(body.drops).toHaveLength(1)
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(body.walletAddress)
  })

  it('rejects a signature from another wallet before querying any drops', async () => {
    const signer = KeyPair.generate()
    const submitted = KeyPair.generate()
    const message = await challenge()
    const signature = signer.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex()
    const res = await app.request('/api/creator/drops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: submitted.publicKey.toHex(), signature, message }),
    })

    expect(res.status).toBe(401)
    expect((await res.json()) as unknown).toEqual({
      error: { code: 'invalid_signature', message: 'we could not verify that wallet approval — try again' },
    })
    expect(query).not.toHaveBeenCalled()
  })
})
