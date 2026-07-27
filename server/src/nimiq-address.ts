/**
 * Nimiq user-friendly address validation: the checksum, not the shape.
 *
 * A shape check (`/^NQ[0-9A-Z ]{34,44}$/i`) used to stand in for this, and it let
 * any well-spelled string through. That is not cosmetic. A gate route takes the
 * wallet address as a CLIENT ASSERTION — no signature — so a checksum-invalid
 * address writes a `gate_grants` row (and a `trivia_sessions` row) naming a wallet
 * that cannot exist. `reserveClaim` compares the grant against an address DERIVED
 * from a verified public key, so nothing derived will ever equal that string: the
 * grant is orphaned the moment it is written, and distributed requests can
 * accumulate junk rows indefinitely. Validating the checksum here is what makes a
 * written grant claimable in principle.
 *
 * Deliberately dependency-free, and deliberately NOT `@nimiq/core`. Only
 * `src/chain/` may import that package; this is integer arithmetic over 36
 * characters and pulling a WASM chain library into the request path to do it
 * would be the larger mistake.
 */

/**
 * Nimiq's base-32 alphabet: RFC 4648 without `I`, `O`, `W` and `Z`.
 *
 * The four omissions are the point — they are the characters a human confuses
 * with `1`, `0`, `VV` and `2`. A payload character outside this set is rejected
 * before the checksum runs, which is the cheap half of the check and the half
 * that catches a transcription slip the mod-97 arithmetic can miss.
 */
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

/** `NQ` + two check digits + 32 payload characters. Never any other length. */
const ADDRESS_LENGTH = 36

/**
 * IBAN mod-97 over the digit expansion of `payload + 'NQ00'`.
 *
 * Each character contributes its decimal value: a digit is itself, a letter is
 * `charCode - 55` (`A` = 10 … `Z` = 35) and so contributes TWO digits. The
 * remainder is folded one digit at a time (`acc = (acc * 10 + d) % 97`), which
 * keeps every intermediate under 970 and needs no bignum for what would
 * otherwise be a ~68-digit integer.
 */
function mod97(payload: string): number {
  let acc = 0
  const body = `${payload}NQ00`
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i)
    if (code >= 48 && code <= 57) {
      acc = (acc * 10 + (code - 48)) % 97
    } else {
      const value = code - 55
      acc = (acc * 10 + Math.floor(value / 10)) % 97
      acc = (acc * 10 + (value % 10)) % 97
    }
  }
  return acc
}

/**
 * Whether `raw` is a well-formed Nimiq address whose check digits agree with its
 * payload.
 *
 * Whitespace and case are ignored, matching what a person pastes: a wallet shows
 * `NQ07 ABCD …` in groups of four, and a URL or a form may deliver it compacted
 * or lowercased. It is the same address, so it must be the same answer here — see
 * {@link normaliseNimiqAddress} for why that then has to be written down in one
 * spelling.
 *
 * The check digits must be DIGITS and must equal `98 - (mod 97)`. That is
 * narrower than the reference implementation, which accepts any check field
 * satisfying `(mod 97 + field) % 97 === 1` and so also admits `00`, `01`, `99`
 * and even letters. Those spellings are never produced by address derivation, and
 * accepting one would recreate the exact bug this module exists to close: a grant
 * stored under a spelling no derived address can equal.
 */
export function isValidNimiqAddress(raw: string): boolean {
  if (typeof raw !== 'string') return false
  const compact = raw.replace(/\s/g, '').toUpperCase()
  if (compact.length !== ADDRESS_LENGTH) return false
  if (compact.charCodeAt(0) !== 78 || compact.charCodeAt(1) !== 81) return false // 'N', 'Q'

  const tens = compact.charCodeAt(2) - 48
  const units = compact.charCodeAt(3) - 48
  if (tens < 0 || tens > 9 || units < 0 || units > 9) return false

  for (let i = 4; i < ADDRESS_LENGTH; i += 1) {
    if (!ALPHABET.includes(compact[i])) return false
  }

  return 98 - mod97(compact.slice(4)) === tens * 10 + units
}

/**
 * The one spelling of a valid address, or `null` if it is not valid.
 *
 * Callers store this rather than what arrived. Without it `NQ07 ABCD…`,
 * `nq07abcd…` and `NQ07ABCD…` are three different strings for one wallet, which
 * means three separate `gate_grants` rows — three plays of a
 * one-play-per-wallet gate, and two grants the claim path can never match.
 */
export function normaliseNimiqAddress(raw: string): string | null {
  if (!isValidNimiqAddress(raw)) return null
  return raw.replace(/\s/g, '').toUpperCase()
}
