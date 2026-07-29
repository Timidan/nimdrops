import { randomBytes } from 'node:crypto'
import { addressFromPublicKey, verifyWalletSignature, type SigScheme } from './verify'

export const CREATOR_CHALLENGE_TTL_SECONDS = 300
const CLOCK_SKEW_SECONDS = 60
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/

export interface CreatorChallenge {
  v: 1
  action: 'list_creator_drops'
  aud: string
  net: string
  nonce: string
  iat: number
  exp: number
}

export type CreatorAuthCode = 'invalid_challenge' | 'challenge_expired' | 'invalid_signature'

export class CreatorAuthError extends Error {
  constructor(readonly code: CreatorAuthCode) {
    super(code)
  }
}

export function issueCreatorChallenge(o: {
  origin: string
  network: string
  nowSeconds?: number
}): CreatorChallenge {
  const iat = o.nowSeconds ?? Math.floor(Date.now() / 1000)
  return {
    v: 1,
    action: 'list_creator_drops',
    aud: o.origin,
    net: o.network,
    nonce: randomBytes(16).toString('base64url'),
    iat,
    exp: iat + CREATOR_CHALLENGE_TTL_SECONDS,
  }
}

export function buildCreatorChallengeMessage(challenge: CreatorChallenge): string {
  assertChallengeShape(challenge)
  return JSON.stringify({
    action: challenge.action,
    aud: challenge.aud,
    exp: challenge.exp,
    iat: challenge.iat,
    net: challenge.net,
    nonce: challenge.nonce,
    v: challenge.v,
  })
}

export function verifyCreatorChallenge(o: {
  message: string
  publicKeyHex: string
  signatureHex: string
  origin: string
  network: string
  scheme: SigScheme
  nowSeconds?: number
}): string {
  let challenge: CreatorChallenge
  try {
    const parsed = JSON.parse(o.message) as CreatorChallenge
    assertChallengeShape(parsed)
    if (buildCreatorChallengeMessage(parsed) !== o.message) throw new Error('not canonical')
    challenge = parsed
  } catch {
    throw new CreatorAuthError('invalid_challenge')
  }

  if (challenge.aud !== o.origin || challenge.net !== o.network) {
    throw new CreatorAuthError('invalid_challenge')
  }

  const now = o.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (now >= challenge.exp) throw new CreatorAuthError('challenge_expired')
  if (challenge.iat - now > CLOCK_SKEW_SECONDS) throw new CreatorAuthError('invalid_challenge')

  if (
    !verifyWalletSignature({
      message: o.message,
      publicKeyHex: o.publicKeyHex,
      signatureHex: o.signatureHex,
      scheme: o.scheme,
    })
  ) {
    throw new CreatorAuthError('invalid_signature')
  }

  try {
    return addressFromPublicKey(o.publicKeyHex)
  } catch {
    throw new CreatorAuthError('invalid_signature')
  }
}

function assertChallengeShape(value: CreatorChallenge): void {
  if (!value || typeof value !== 'object') throw new Error('invalid challenge')
  if (value.v !== 1 || value.action !== 'list_creator_drops') throw new Error('invalid action')
  if (typeof value.aud !== 'string' || value.aud.length === 0 || value.aud.length > 200) {
    throw new Error('invalid audience')
  }
  if (typeof value.net !== 'string' || value.net.length === 0 || value.net.length > 32) {
    throw new Error('invalid network')
  }
  if (typeof value.nonce !== 'string' || !NONCE_RE.test(value.nonce)) {
    throw new Error('invalid nonce')
  }
  if (!Number.isInteger(value.iat) || !Number.isInteger(value.exp)) {
    throw new Error('invalid timestamps')
  }
  if (value.exp - value.iat !== CREATOR_CHALLENGE_TTL_SECONDS) {
    throw new Error('invalid lifetime')
  }
}
