import { createHash } from 'node:crypto'
import { KeyPair } from '@nimiq/core'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate'
import {
  ATTESTATION_PREFIX,
  type Attestation,
  buildAttestationMessage,
  CLOCK_SKEW_SECONDS,
  parseAttestationMessage,
  parseAttestedConfig,
  submitAttestation,
} from '../src/gates/attested'
import { GateRejectedError } from '../src/gates/types'
import { loadGate } from '../src/services/gates'
// Side-effect import: installs the int8-as-string parser so BIGINT luna never
// passes through a lossy JS number. This suite builds its own pool, so it still
// depends on that global parser being registered.
import '../src/db/pool'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Private schema, private pool. This suite writes `drops`, and the `*.race`
 * suites vitest may run alongside it truncate `drops` freely.
 */
const SCHEMA = 'attested_test'
const ORIGIN = 'https://nimdrops.test'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** A fresh 32-hex nonce per call, so no test depends on another's nonce space. */
let nonceCounter = 0
function freshNonce(): string {
  nonceCounter += 1
  return createHash('sha256')
    .update(`${process.pid}:${Date.now()}:${nonceCounter}:${Math.random()}`)
    .digest('hex')
    .slice(0, 32)
}

// ---- pure parsing ------------------------------------------------------------
//
// Step 1 of the verification order, tested without a database. Strictness here
// is what makes the nonce check meaningful: if two byte sequences could mean the
// same attestation, one of them can be replayed under a nonce row that was never
// written for it.

const CANONICAL: Attestation = {
  network: 'TestAlbatross',
  origin: ORIGIN,
  drop: 'drop-abc',
  wallet: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
  issuedAt: 1_800_000_000,
  nonce: 'a'.repeat(32),
}

function lines(over: Partial<Record<string, string>> = {}): string[] {
  return [
    ATTESTATION_PREFIX,
    `network=${over.network ?? CANONICAL.network}`,
    `origin=${over.origin ?? CANONICAL.origin}`,
    `drop=${over.drop ?? CANONICAL.drop}`,
    `wallet=${over.wallet ?? CANONICAL.wallet}`,
    `issuedAt=${over.issuedAt ?? String(CANONICAL.issuedAt)}`,
    `nonce=${over.nonce ?? CANONICAL.nonce}`,
  ]
}

describe('buildAttestationMessage / parseAttestationMessage', () => {
  it('is exactly seven lines in the documented order', () => {
    expect(buildAttestationMessage(CANONICAL).split('\n')).toEqual([
      'nimdrops-attestation',
      'network=TestAlbatross',
      `origin=${ORIGIN}`,
      'drop=drop-abc',
      `wallet=${CANONICAL.wallet}`,
      'issuedAt=1800000000',
      `nonce=${'a'.repeat(32)}`,
    ])
  })

  it('round-trips', () => {
    expect(parseAttestationMessage(buildAttestationMessage(CANONICAL))).toEqual(CANONICAL)
  })

  it('refuses a missing line', () => {
    expect(() => parseAttestationMessage(lines().slice(0, 6).join('\n'))).toThrow(GateRejectedError)
  })

  it('refuses an extra line', () => {
    expect(() => parseAttestationMessage(`${lines().join('\n')}\nextra=1`)).toThrow(
      GateRejectedError,
    )
  })

  it('refuses a trailing newline, which is a different byte sequence', () => {
    expect(() => parseAttestationMessage(`${lines().join('\n')}\n`)).toThrow(GateRejectedError)
  })

  it('refuses a wrong or absent prefix', () => {
    const [, ...rest] = lines()
    expect(() => parseAttestationMessage(['nimdrops-attestations', ...rest].join('\n'))).toThrow(
      GateRejectedError,
    )
    expect(() => parseAttestationMessage(['', ...rest].join('\n'))).toThrow(GateRejectedError)
  })

  it('refuses reordered keys', () => {
    const [prefix, network, origin, drop, wallet, issuedAt, nonce] = lines()
    const swapped = [prefix, origin, network, drop, wallet, issuedAt, nonce].join('\n')
    expect(() => parseAttestationMessage(swapped)).toThrow(GateRejectedError)
    const late = [prefix, network, origin, drop, wallet, nonce, issuedAt].join('\n')
    expect(() => parseAttestationMessage(late)).toThrow(GateRejectedError)
  })

  it('refuses a duplicated key in place of another', () => {
    const [prefix, network, origin, drop, wallet, issuedAt] = lines()
    expect(() =>
      parseAttestationMessage([prefix, network, origin, drop, wallet, issuedAt, issuedAt].join('\n')),
    ).toThrow(GateRejectedError)
  })

  // Every one of these is a second spelling of the same instant. `Number()`
  // would accept them all.
  it.each(['', ' 1800000000', '1800000000 ', '1800000000.0', '1.8e9', '0x6B49D200', '01800000000', '-1800000000', '0', 'NaN'])(
    'refuses issuedAt=%j',
    (issuedAt) => {
      expect(() => parseAttestationMessage(lines({ issuedAt }).join('\n'))).toThrow(
        GateRejectedError,
      )
    },
  )

  it.each([
    '',
    'A'.repeat(32),
    'a'.repeat(31),
    'a'.repeat(33),
    `${'a'.repeat(31)}g`,
    ` ${'a'.repeat(32)}`,
  ])('refuses nonce=%j', (nonce) => {
    expect(() => parseAttestationMessage(lines({ nonce }).join('\n'))).toThrow(GateRejectedError)
  })

  it('reports bad_attestation for every parse failure', () => {
    expect(() => parseAttestationMessage('nope')).toThrow(
      expect.objectContaining({ code: 'bad_attestation' }),
    )
  })
})

describe('parseAttestedConfig', () => {
  const key = 'ab'.repeat(32)

  it('accepts a well-formed config', () => {
    expect(parseAttestedConfig({ attesterPublicKey: key, maxAgeSeconds: 300 })).toEqual({
      attesterPublicKey: key,
      maxAgeSeconds: 300,
    })
  })

  it.each([
    {},
    { maxAgeSeconds: 300 },
    { attesterPublicKey: key },
    { attesterPublicKey: 'ab'.repeat(31), maxAgeSeconds: 300 },
    { attesterPublicKey: `${'ab'.repeat(31)}zz`, maxAgeSeconds: 300 },
    { attesterPublicKey: 42, maxAgeSeconds: 300 },
    { attesterPublicKey: key, maxAgeSeconds: 0 },
    { attesterPublicKey: key, maxAgeSeconds: -300 },
    { attesterPublicKey: key, maxAgeSeconds: 1.5 },
    { attesterPublicKey: key, maxAgeSeconds: '300' },
  ])('refuses %j as a misconfiguration', (config) => {
    // `misconfigured`, not `bad_attestation`. These are all faults in what the
    // SPONSOR configured, and reporting them as a verification failure told an
    // honest integrator their signature was bad when it verified perfectly.
    expect(() => parseAttestedConfig(config as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: 'misconfigured' }),
    )
  })
})

// ---- submission --------------------------------------------------------------

describe.skipIf(!hasDb)('submitAttestation', () => {
  let pool: pg.Pool
  let publicId: string
  let attester: KeyPair
  let beneficiary: string

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${SCHEMA}`,
    })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** A drop carrying one gate. Only the columns the CHECKs require are set. */
  async function gatedDrop(
    o: { kind?: string; config?: unknown; state?: string } = {},
  ): Promise<string> {
    const id = `at-${Math.random().toString(36).slice(2, 12)}`
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drops (
         public_id, sponsor_label, claim_count, amount_each_luna,
         expected_funding_luna, state, expires_at
       ) VALUES ($1, 'steps', 20, 100000, 2000000, $2, now() + interval '24 hours')
       RETURNING id`,
      [id, o.state ?? 'live'],
    )
    await pool.query(
      `INSERT INTO drop_gates (drop_id, kind, config) VALUES ($1, $2, $3::jsonb)`,
      [
        rows[0].id,
        o.kind ?? 'attested',
        JSON.stringify(
          o.config ?? { attesterPublicKey: attester.publicKey.toHex(), maxAgeSeconds: 300 },
        ),
      ],
    )
    return id
  }

  beforeEach(async () => {
    process.env.NIMIQ_NETWORK = 'TestAlbatross'
    process.env.PUBLIC_ORIGIN = ORIGIN
    process.env.SIG_SCHEME = 'raw'
    for (const t of ['gate_grants', 'attestation_nonces', 'drop_gates', 'drops']) {
      await pool.query(`DELETE FROM ${t}`)
    }
    attester = KeyPair.generate()
    beneficiary = KeyPair.generate().publicKey.toAddress().toUserFriendlyAddress()
    publicId = await gatedDrop()
  })

  function attestation(over: Partial<Attestation> = {}): string {
    return buildAttestationMessage({
      network: 'TestAlbatross',
      origin: ORIGIN,
      drop: publicId,
      wallet: beneficiary,
      issuedAt: nowSeconds(),
      nonce: freshNonce(),
      ...over,
    })
  }

  /** A real Ed25519 signer: the suite never fakes a signature it then verifies. */
  const sign = (message: string, key = attester) =>
    key.sign(new Uint8Array(Buffer.from(message, 'utf8'))).toHex()

  /** What a real Nimiq wallet returns, which `SIG_SCHEME=raw` must NOT accept. */
  const signLikeNimiqPay = (message: string, key = attester) => {
    const body = Buffer.from(message, 'utf8')
    const digest = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('\x16Nimiq Signed Message:\n', 'utf8'),
          Buffer.from(String(body.byteLength), 'utf8'),
          body,
        ]),
      )
      .digest()
    return key.sign(new Uint8Array(digest)).toHex()
  }

  const submit = async (message: string, signatureHex = sign(message), id = publicId) =>
    submitAttestation(pool, { gate: await loadGate(pool, id), message, signatureHex })

  const countGrants = async () =>
    (await pool.query<{ count: string }>('SELECT count(*) FROM gate_grants')).rows[0].count

  const countNonces = async () =>
    (await pool.query<{ count: string }>('SELECT count(*) FROM attestation_nonces')).rows[0].count

  it('grants to the wallet named in the attestation', async () => {
    await expect(submit(attestation())).resolves.toMatchObject({ granted: true,
      walletAddress: beneficiary,
    })
    const { rows } = await pool.query<{ wallet_address: string; kind: string }>(
      'SELECT wallet_address, kind FROM gate_grants',
    )
    expect(rows[0].wallet_address).toBe(beneficiary)
    expect(rows[0].kind).toBe('attested')
  })

  it('ignores any address outside the signed message', async () => {
    // There is no request-body address to pass: the attester names the
    // beneficiary and the signature covers it. This asserts the shape stays that
    // way — a third argument would be a regression.
    expect(submitAttestation.length).toBe(2)
    const message = attestation()
    const gate = await loadGate(pool, publicId)
    await expect(
      submitAttestation(pool, { gate, message, signatureHex: sign(message) }),
    ).resolves.toMatchObject({ walletAddress: beneficiary })
    // A different wallet in the signed message moves the money, and nothing else
    // can: an attacker who re-signs with their own key is refused above.
    const other = KeyPair.generate().publicKey.toAddress().toUserFriendlyAddress()
    await expect(submit(attestation({ wallet: other }))).resolves.toMatchObject({
      walletAddress: other,
    })
  })

  it('refuses a signature from any other key', async () => {
    const message = attestation()
    await expect(submit(message, sign(message, KeyPair.generate()))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
    expect(await countGrants()).toBe('0')
  })

  it('refuses a malformed signature', async () => {
    await expect(submit(attestation(), 'not-hex')).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('refuses a signature over the other SIG_SCHEME bytes', async () => {
    // Good signature, wrong bytes. A verifier that shrugged and tried both
    // schemes would accept a message the configured scheme never covered.
    const message = attestation()
    await expect(submit(message, signLikeNimiqPay(message))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('accepts the wallet scheme when the deployment runs it', async () => {
    // `docs/ATTESTATIONS.md` tells an integrator to sign whichever bytes
    // `SIG_SCHEME` names, and a production deployment names this one. The rest of
    // this suite runs `raw`, so without this case the documented production path
    // would be the untested one.
    process.env.SIG_SCHEME = 'nimiq-signed-message'
    const message = attestation()
    await expect(submit(message, signLikeNimiqPay(message))).resolves.toMatchObject({
      granted: true,
      walletAddress: beneficiary,
    })
    const plain = attestation()
    await expect(submit(plain, sign(plain))).rejects.toMatchObject({ code: 'bad_attestation' })
  })

  it('refuses a network mismatch', async () => {
    await expect(submit(attestation({ network: 'MainAlbatross' }))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('refuses an origin mismatch', async () => {
    await expect(submit(attestation({ origin: 'https://evil.test' }))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('refuses an attestation naming another drop', async () => {
    await expect(submit(attestation({ drop: 'some-other-drop' }))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('refuses an attestation minted for a sibling drop of the same attester', async () => {
    // Same key, same origin, same network — only `drop` differs. Without step 3
    // one signature would spend a slot on every drop that trusts the attester.
    const sibling = await gatedDrop()
    const message = attestation({ drop: sibling })
    await expect(submit(message)).rejects.toMatchObject({ code: 'bad_attestation' })
    await expect(submit(message, sign(message), sibling)).resolves.toMatchObject({ granted: true })
  })

  it('refuses one older than maxAgeSeconds', async () => {
    await expect(submit(attestation({ issuedAt: nowSeconds() - 3600 }))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('refuses one issued in the future', async () => {
    await expect(submit(attestation({ issuedAt: nowSeconds() + 3600 }))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
  })

  it('accepts a signer whose clock runs slightly ahead', async () => {
    await expect(
      submit(attestation({ issuedAt: nowSeconds() + CLOCK_SKEW_SECONDS - 5 })),
    ).resolves.toMatchObject({ granted: true })
  })

  it('accepts one just inside maxAgeSeconds', async () => {
    await expect(submit(attestation({ issuedAt: nowSeconds() - 295 }))).resolves.toMatchObject({
      granted: true,
    })
  })

  it('refuses a replayed nonce and leaves the first grant intact', async () => {
    const message = attestation()
    await submit(message)
    await expect(submit(message)).rejects.toMatchObject({ code: 'attestation_replayed' })
    expect(await countGrants()).toBe('1')
  })

  it('refuses a second attestation reusing one nonce for a different wallet', async () => {
    // The replay check is on the nonce, not on the whole message: an attester
    // that re-uses a nonce cannot mint a second beneficiary from it.
    const nonce = freshNonce()
    await submit(attestation({ nonce }))
    const other = KeyPair.generate().publicKey.toAddress().toUserFriendlyAddress()
    await expect(submit(attestation({ nonce, wallet: other }))).rejects.toMatchObject({
      code: 'attestation_replayed',
    })
    expect(await countGrants()).toBe('1')
  })

  it('lets exactly one of eight concurrent copies win', async () => {
    // Two tabs, or a retried request. The gate load and the signing happen up
    // front on purpose: everything `submitAttestation` does before it touches
    // `attestation_nonces` is synchronous, so all eight statements are dispatched
    // in one burst before any response can be processed. That is a real race
    // rather than eight sequential calls that happen to be written concurrently.
    //
    // Read-then-write would let all eight pass the read; the
    // INSERT ... ON CONFLICT is itself the check, so seven lose.
    const message = attestation()
    const signatureHex = sign(message)
    const gate = await loadGate(pool, publicId)
    // Pre-warm the pool. With lazily created clients the first caller finishes
    // its whole round trip while the others are still completing a TCP and auth
    // handshake, which quietly serialises the race this test exists to run.
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')))
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => submitAttestation(pool, { gate, message, signatureHex })),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((x) => x.status === 'rejected')) {
      // Not just "rejected": a unique-violation escaping as a raw pg error is a
      // 500 that tells the operator nothing and the submitter less.
      expect(r.reason).toBeInstanceOf(GateRejectedError)
      expect(r.reason).toMatchObject({ code: 'attestation_replayed' })
    }
    expect(await countGrants()).toBe('1')
    expect(await countNonces()).toBe('1')
  })

  it('keeps the nonce space per drop', async () => {
    const other = await gatedDrop()
    const nonce = freshNonce()
    await expect(submit(attestation({ nonce }))).resolves.toMatchObject({ granted: true })
    const second = attestation({ nonce, drop: other })
    await expect(submit(second, sign(second), other)).resolves.toMatchObject({ granted: true })
    expect(await countNonces()).toBe('2')
  })

  it('does not spend the nonce on a refused attestation', async () => {
    // Ordering matters: if the nonce were claimed before the signature check,
    // anyone who saw a valid message in flight could burn it with garbage.
    const message = attestation()
    await expect(submit(message, sign(message, KeyPair.generate()))).rejects.toMatchObject({
      code: 'bad_attestation',
    })
    expect(await countNonces()).toBe('0')
    await expect(submit(message)).resolves.toMatchObject({ granted: true })
  })

  it('refuses a message with an extra line', async () => {
    await expect(submit(`${attestation()}\nextra=1`)).rejects.toThrow(GateRejectedError)
    expect(await countNonces()).toBe('0')
  })

  it('refuses an attestation posted to a gate of another kind', async () => {
    const phrase = await gatedDrop({ kind: 'passphrase', config: { hash: 'x', hint: 'y' } })
    const message = attestation({ drop: phrase })
    await expect(submit(message, sign(message), phrase)).rejects.toMatchObject({
      code: 'wrong_kind',
    })
  })

  it('refuses an attestation for a drop that is no longer live', async () => {
    const paused = await gatedDrop({ state: 'paused' })
    const message = attestation({ drop: paused })
    await expect(submit(message, sign(message), paused)).rejects.toMatchObject({
      code: 'game_not_live',
    })
    expect(await countNonces()).toBe('0')
  })

  it('refuses every attestation on a misconfigured gate, blaming the operator', async () => {
    const broken = await gatedDrop({ config: { attesterPublicKey: 'nope', maxAgeSeconds: 300 } })
    const message = attestation({ drop: broken })
    // The signature here is valid. Only the drop is broken, so the code must not
    // be the one that means "your confirmation could not be verified" — the HTTP
    // layer maps `misconfigured` to 5xx and pages an operator instead.
    await expect(submit(message, sign(message), broken)).rejects.toMatchObject({
      code: 'misconfigured',
    })
  })

  it('is idempotent for a wallet that already holds a grant', async () => {
    // A second, freshly-nonced attestation for the same wallet must not error
    // and must not create a second grant.
    await submit(attestation())
    await expect(submit(attestation())).resolves.toMatchObject({ walletAddress: beneficiary })
    expect(await countGrants()).toBe('1')
    expect(await countNonces()).toBe('2')
  })
})
