import { createHash } from 'node:crypto'
import { PublicKey, Signature } from '@nimiq/core'

/**
 * How the wallet turns the canonical challenge message into the bytes it signs.
 *
 * - `raw`: Ed25519 over the UTF-8 message bytes.
 * - `nimiq-signed-message`: Ed25519 over SHA-256 of the prefixed message.
 *
 * PRODUCTION SCHEME IS NOT DECIDED HERE. Task 7 captures a real Nimiq Pay
 * signature into `server/test/fixtures/device-sign.json`; whichever scheme
 * verifies that fixture is locked in as the `SIG_SCHEME` config value the API
 * passes to {@link verifyWalletSignature}. Until then both are supported and
 * neither is a default.
 */
export type SigScheme = 'raw' | 'nimiq-signed-message'

/**
 * `\x16` is the length (22) of the label that follows, matching Nimiq's
 * signed-message convention.
 */
export const SIGNED_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n'

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
  let publicKey: PublicKey
  let signature: Signature
  try {
    publicKey = PublicKey.fromHex(o.publicKeyHex)
    signature = Signature.fromHex(o.signatureHex)
  } catch {
    return false
  }

  try {
    return publicKey.verify(signature, signedBytes(o.message, o.scheme))
  } catch {
    return false
  }
}

/** The user-friendly `NQ..` address that a public key pays out to. */
export function addressFromPublicKey(publicKeyHex: string): string {
  return PublicKey.fromHex(publicKeyHex).toAddress().toUserFriendlyAddress()
}

function signedBytes(message: string, scheme: SigScheme): Uint8Array {
  const utf8 = Buffer.from(message, 'utf8')
  if (scheme === 'raw') return new Uint8Array(utf8)

  // Prefix + decimal message length + message, then SHA-256. The length is the
  // UTF-8 byte length; the canonical challenge message is ASCII, so this equals
  // its character count.
  const prefixed = Buffer.concat([
    Buffer.from(SIGNED_MESSAGE_PREFIX, 'utf8'),
    Buffer.from(String(utf8.length), 'utf8'),
    utf8,
  ])
  return new Uint8Array(createHash('sha256').update(prefixed).digest())
}
