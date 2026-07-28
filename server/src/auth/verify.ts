import { createHash } from 'node:crypto'
import { PublicKey, Signature } from '../chain/crypto'

/**
 * How the wallet turns the canonical challenge message into the bytes it signs.
 *
 * - `raw`: Ed25519 over the UTF-8 message bytes.
 * - `nimiq-signed-message`: Ed25519 over SHA-256 of the prefixed message.
 *
 * `nimiq-signed-message` is what a real Nimiq wallet does — see
 * {@link WALLET_SIG_SCHEME}. `raw` stays because it is a legitimate scheme for
 * a signer that is not a Nimiq wallet (the mock bridge, spikes, fixtures), and
 * because a verifier that knows only one shape cannot tell an operator that the
 * configured one is the wrong one. It is not a candidate for production, and
 * nothing here defaults to it.
 */
export type SigScheme = 'raw' | 'nimiq-signed-message'

/**
 * `\x16` is the length (22) of the label that follows, matching Nimiq's
 * signed-message convention. The whole constant is 23 bytes and is the same
 * string Nimiq publishes as `HubApi.MSG_PREFIX` (nimiq/hub `client/HubApi.ts`:
 * `public static readonly MSG_PREFIX = '\x16Nimiq Signed Message:\n'`).
 */
export const SIGNED_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n'

/**
 * The scheme a Nimiq wallet — Nimiq Pay included — actually produces.
 *
 * Established from Nimiq's own sources rather than by trying schemes until one
 * passes:
 *
 *  - nimiq/keyguard `src/lib/Key.js`, `Key.signMessage()`: writes
 *    `prefix` + `message.byteLength.toString(10)` + `message` into one buffer,
 *    takes `Nimiq.Hash.computeSha256(data)`, and signs THAT digest — the
 *    signature is over 32 bytes of SHA-256, never over the message.
 *  - nimiq/hub, sign-message reference: the signed bytes verbatim, as
 *    `sign( sha256( '\x16Nimiq Signed Message:\n' + message.length + message ) )`.
 *
 * Two places this could NOT be derived from, because they do not contain it:
 * `@nimiq/mini-app-sdk` only forwards `{ method: 'sign', params: { message } }`
 * across the native bridge (`dist/provider.js`, `sign()`) and never touches the
 * bytes, and `@nimiq/core` 2.7.1 ships no message-signing helper and no copy of
 * the prefix string anywhere in its wasm. The wallet side of that bridge is
 * closed source, which is why `test/fixtures/device-sign.json` is marked
 * source-derived until a real device capture replaces it.
 */
export const WALLET_SIG_SCHEME: SigScheme = 'nimiq-signed-message'

/** The scheme that is not this one. Used only to diagnose a misconfiguration. */
export function otherScheme(scheme: SigScheme): SigScheme {
  return scheme === 'raw' ? 'nimiq-signed-message' : 'raw'
}

/**
 * Re-exported, not redeclared. The single reader lives in `config.ts` so that
 * `gates/attested.ts`, the claim path and the sponsor's close path cannot end up
 * verifying under two different schemes. Signature-verifying callers import it
 * from here because this is where the scheme is defined and explained;
 * {@link checkWalletSignature} reports a signature that would have verified
 * under the other one, and the claim path turns that into an operator alert.
 */
export { requireSigScheme, SigConfigError } from '../config'

export interface SignatureCheck {
  /** Verified against the scheme the caller asked for. Only this authorizes. */
  ok: boolean
  /**
   * The signature is good, but over the OTHER scheme's bytes. That is never a
   * claimant's fault and never a reason to accept: it means `SIG_SCHEME` does
   * not describe the signer, so EVERY claim is being refused. An operator has
   * to hear about it; the claimant is still refused.
   */
  schemeMismatch: boolean
}

/**
 * Verifies an Ed25519 wallet signature over the canonical challenge message and
 * reports whether the failure looks like a misconfigured {@link SigScheme}.
 *
 * Returns — never throws — for malformed keys, malformed signatures and every
 * failed verification, so callers cannot distinguish those failure modes.
 *
 * The diagnostic verification runs ONLY after the authoritative one has already
 * failed, so a good claim never pays for it, and its result never feeds `ok`.
 */
export function checkWalletSignature(o: {
  message: string
  publicKeyHex: string
  signatureHex: string
  scheme: SigScheme
}): SignatureCheck {
  let publicKey: PublicKey
  let signature: Signature
  try {
    publicKey = PublicKey.fromHex(o.publicKeyHex)
    signature = Signature.fromHex(o.signatureHex)
  } catch {
    return { ok: false, schemeMismatch: false }
  }

  const verify = (scheme: SigScheme): boolean => {
    try {
      return publicKey.verify(signature, signedBytes(o.message, scheme))
    } catch {
      return false
    }
  }

  if (verify(o.scheme)) return { ok: true, schemeMismatch: false }
  return { ok: false, schemeMismatch: verify(otherScheme(o.scheme)) }
}

/**
 * Verifies an Ed25519 wallet signature over the canonical challenge message.
 * Returns `false` — never throws — for malformed keys, malformed signatures and
 * every failed verification, so callers cannot distinguish the failure modes.
 */
export function verifyWalletSignature(o: {
  message: string
  publicKeyHex: string
  signatureHex: string
  scheme: SigScheme
}): boolean {
  return checkWalletSignature(o).ok
}

/** The user-friendly `NQ..` address that a public key pays out to. */
export function addressFromPublicKey(publicKeyHex: string): string {
  return PublicKey.fromHex(publicKeyHex).toAddress().toUserFriendlyAddress()
}

function signedBytes(message: string, scheme: SigScheme): Uint8Array {
  const utf8 = Buffer.from(message, 'utf8')
  if (scheme === 'raw') return new Uint8Array(utf8)

  // Prefix + decimal message length + message, then SHA-256. The length is the
  // UTF-8 byte length — keyguard uses `message.byteLength` of the byte array,
  // not the string's character count — and the canonical challenge is ASCII, so
  // for our messages the two agree.
  const prefixed = Buffer.concat([
    Buffer.from(SIGNED_MESSAGE_PREFIX, 'utf8'),
    Buffer.from(String(utf8.length), 'utf8'),
    utf8,
  ])
  return new Uint8Array(createHash('sha256').update(prefixed).digest())
}
