import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADDRESS_PREFIX_CHARS,
  REDACTED,
  logInfo,
  redact,
  redactAddress,
  redactString,
  safeLog,
} from '../src/http/redact'

/**
 * The claim these tests defend is not "the function returns a string" — it is
 * "no log line this codebase can emit contains key material, a signature, a
 * bearer token or a full wallet address". So they are written per SENSITIVE
 * CLASS (§10.3's list, one `it` each), plus the two shapes that break naive
 * redactors: nesting and free-form error text.
 *
 * The negative control matters as much as the positives. A redactor that eats a
 * transaction hash or a drop id passes every "is it masked" test and destroys
 * the operator's ability to trace money — HACKATHON.md §8 requires exactly that
 * lookup — so "a normal operational log is untouched" is asserted explicitly.
 */

/**
 * Shapes taken from the real system, not invented: 64 hex = key, 128 = sig.
 *
 * None of these are secrets — they are the SHAPES the redactor keys on, which
 * is exactly why a secret scanner flags the two that look most like credentials.
 * `gitleaks:allow` is the narrow, reviewable way to say so: per line, in the
 * file, rather than a repo-wide ignore that would also hide the real thing.
 */
const PRIVATE_KEY = 'a3f1c2d4e5b6a7980f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778' // gitleaks:allow
const SIGNATURE =
  'd4c3b2a1908172635445362718091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b' +
  'b2a1908172635445362718091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const RAW_TX_HEX =
  '0100' + 'ab'.repeat(80) + 'ff'
const TX_HASH = 'b386b8dfcda0f11b1af18aed2c211433a40a1754bcb1baec8f10751e5e7b88c3'
const ADDRESS = 'NQ21 SEXP 7XVQ 1GTM 6R7A H1DK MEUY C0KD 4LM3'
const STATUS_TOKEN = 'Yk3nP8vQr2XsLtE9wZaB4mCd7FgHjKlNoPqRsTuVwXy' // gitleaks:allow

afterEach(() => {
  vi.restoreAllMocks()
})

describe('redact — one sensitive class at a time', () => {
  it('masks a signature, by field name and inside free text', () => {
    expect(redact({ signature: SIGNATURE })).toEqual({ signature: REDACTED })
    expect(redact({ signatureHex: SIGNATURE })).toEqual({ signatureHex: REDACTED })
    expect(redactString(`verify failed for sig ${SIGNATURE}`)).not.toContain(SIGNATURE)
  })

  it('masks a public key', () => {
    expect(redact({ publicKey: 'ab'.repeat(32) })).toEqual({ publicKey: REDACTED })
    expect(redact({ publicKeyHex: 'ab'.repeat(32) })).toEqual({ publicKeyHex: REDACTED })
  })

  it('masks raw signed transaction bytes', () => {
    const out = redact({ rawTxHex: RAW_TX_HEX, raw_tx_hex: RAW_TX_HEX }) as Record<string, unknown>
    expect(out.rawTxHex).toBe(REDACTED)
    // Same field, different spelling: normalisation, not two entries.
    expect(out.raw_tx_hex).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain('abab')
  })

  it('masks a bearer / status token', () => {
    expect(redact({ statusToken: STATUS_TOKEN })).toEqual({ statusToken: REDACTED })
    expect(redact({ authorization: `Bearer ${STATUS_TOKEN}` })).toEqual({
      authorization: REDACTED,
    })
    // …and in a string that was never a token field.
    const text = redactString(`upstream said: Authorization: Bearer ${STATUS_TOKEN}`)
    expect(text).not.toContain(STATUS_TOKEN)
    expect(text).toContain('Bearer [redacted]')
  })

  it('masks an idempotency key', () => {
    expect(redact({ idempotencyKey: 'client-chose-this-one' })).toEqual({
      idempotencyKey: REDACTED,
    })
    expect(redact({ 'idempotency-key': 'client-chose-this-one' })).toEqual({
      'idempotency-key': REDACTED,
    })
  })

  it('masks private key material by name AND any hex run long enough to be a key', () => {
    expect(redact({ custodyPrivateKeyHex: PRIVATE_KEY })).toEqual({
      custodyPrivateKeyHex: REDACTED,
    })
    // The dangerous case: nobody named the field, it is just loose in a message.
    expect(redactString(`CUSTODY_PRIVATE_KEY_HEX=${PRIVATE_KEY} rejected`)).toBe(
      `CUSTODY_PRIVATE_KEY_HEX=${REDACTED} rejected`,
    )
    expect(redactString(`0x${PRIVATE_KEY}`)).toBe(REDACTED)
    // 16 bytes is the floor; a UUID's longest run is 12 and must survive.
    expect(redactString('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    )
  })

  it('masks the password in a connection string but keeps the host', () => {
    // The real shape: `pg` puts DATABASE_URL into its own connect errors, and
    // `app.ts` logs `errorMessage(err)` for every 500.
    const text = redactString(
      'connect ECONNREFUSED postgres://nimdrops:hunter2@postgres:5432/nimdrops',
    )
    expect(text).not.toContain('hunter2')
    expect(text).toContain('postgres:5432/nimdrops')
    expect(text).toBe(`connect ECONNREFUSED postgres://${REDACTED}@postgres:5432/nimdrops`)
  })

  it('keeps only the first 9 characters of a full wallet address', () => {
    expect(redactAddress(ADDRESS)).toBe('NQ21 SEXP...')
    expect(redactAddress(ADDRESS).slice(0, ADDRESS_PREFIX_CHARS)).toBe('NQ21 SEXP')

    // By field name…
    expect(redact({ recipientAddress: ADDRESS })).toEqual({ recipientAddress: 'NQ21 SEXP...' })
    // …and anywhere else, including the unspaced form and mid-sentence.
    const unspaced = ADDRESS.replace(/ /g, '')
    expect(redactString(`paid ${ADDRESS} 5 NIM`)).toBe('paid NQ21 SEXP... 5 NIM')
    expect(redactString(unspaced)).toBe('NQ21SEXP7...')
  })

  it('leaves a normal operational log completely untouched', () => {
    const line = {
      event: 'transfer_confirmed',
      transferId: '9f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8',
      attemptId: '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9',
      txHash: TX_HASH,
      sequence: 3,
      claimId: 'c-42',
      includedHeight: 7_006_478,
      amountLuna: 500_000n,
    }
    expect(redact(line)).toEqual({ ...line, amountLuna: '500000' })
  })

  it('keeps a transaction hash but masks the identically shaped hex elsewhere', () => {
    // 64 hex is a private key AND a tx hash. The field name is the only signal.
    expect(redact({ txHash: TX_HASH })).toEqual({ txHash: TX_HASH })
    expect(redact({ someHexBlob: TX_HASH })).toEqual({ someHexBlob: REDACTED })
  })

  it('walks nested objects and arrays', () => {
    const out = redact({
      attempt: {
        txHash: TX_HASH,
        signature: SIGNATURE,
        payouts: [
          { recipientAddress: ADDRESS, amountLuna: 1n },
          { recipientAddress: ADDRESS, amountLuna: 2n },
        ],
      },
      signatures: [SIGNATURE, SIGNATURE],
      addresses: [ADDRESS],
    })
    expect(out).toEqual({
      attempt: {
        txHash: TX_HASH,
        signature: REDACTED,
        payouts: [
          { recipientAddress: 'NQ21 SEXP...', amountLuna: '1' },
          { recipientAddress: 'NQ21 SEXP...', amountLuna: '2' },
        ],
      },
      // A plural secret field is still a secret field: the whole array goes.
      signatures: REDACTED,
      // A plural address field keeps its shape; the elements inherit the name.
      addresses: ['NQ21 SEXP...'],
    })
  })

  it('redacts an Error, message and stack, and survives a cycle', () => {
    const err = new Error(`broadcast rejected tx ${RAW_TX_HEX} from ${ADDRESS}`)
    const out = redact({ error: err }) as { error: { name: string; message: string } }
    expect(out.error.name).toBe('Error')
    expect(out.error.message).not.toContain('abab')
    expect(out.error.message).toContain('NQ21 SEXP...')

    const cyclic: Record<string, unknown> = { event: 'x' }
    cyclic.self = cyclic
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow()
  })
})

describe('safeLog', () => {
  it('emits one JSON line with event + timestamp and nothing sensitive', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    logInfo('claim_accepted', {
      claimId: 'c-1',
      recipientAddress: ADDRESS,
      signature: SIGNATURE,
      statusToken: STATUS_TOKEN,
      idempotencyKey: 'idem-1',
      txHash: TX_HASH,
    })

    expect(info).toHaveBeenCalledTimes(1)
    const line = String(info.mock.calls[0]?.[0])
    const parsed = JSON.parse(line) as Record<string, unknown>

    expect(parsed.event).toBe('claim_accepted')
    expect(typeof parsed.at).toBe('string')
    expect(parsed.claimId).toBe('c-1')
    expect(parsed.txHash).toBe(TX_HASH)
    expect(parsed.recipientAddress).toBe('NQ21 SEXP...')

    for (const secret of [SIGNATURE, STATUS_TOKEN, 'idem-1', ADDRESS]) {
      expect(line, `line still contains ${secret.slice(0, 12)}…`).not.toContain(secret)
    }
  })

  it('routes levels to the matching console method', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    safeLog('warn', 'a')
    safeLog('error', 'b')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('never throws, even on a value JSON cannot serialise', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const hostile = {
      get boom(): never {
        throw new Error('getter exploded')
      },
    }
    expect(() => logInfo('weird', { hostile })).not.toThrow()
    expect(info).toHaveBeenCalledTimes(1)
  })
})
