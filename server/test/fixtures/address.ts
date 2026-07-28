/**
 * Valid Nimiq addresses for tests, minted from a readable label.
 *
 * Suites used to write `'NQ07 PLAYER'`, which reads beautifully in a failure
 * message and is not an address: its payload is 6 characters, not 32, and its
 * check digits agree with nothing. That was harmless while the gates took any
 * string, and it stopped being harmless when they started validating — a fixture
 * that cannot exist proves nothing about a system whose whole job is to reject
 * addresses that cannot exist.
 *
 * `player('PLAYER')` gives back a real address that still says PLAYER in the
 * middle of it, so a failing assertion is as readable as it was before.
 */

/** Nimiq's base-32 alphabet: RFC 4648 without `I`, `O`, `W` and `Z`. */
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

/** Deliberately a second implementation of the mod-97 fold in `src/nimiq-address.ts`.
 *
 * A fixture that computed its check digits by calling the module under test would
 * agree with that module by construction, including when it is wrong. This one is
 * written from the IBAN rule directly.
 */
function checkDigits(payload: string): string {
  let acc = 0
  for (const ch of `${payload}NQ00`) {
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      acc = (acc * 10 + (code - 48)) % 97
    } else {
      const value = code - 55
      acc = (acc * 10 + Math.floor(value / 10)) % 97
      acc = (acc * 10 + (value % 10)) % 97
    }
  }
  return String(98 - acc).padStart(2, '0')
}

/**
 * A valid address whose payload spells `label`, padded to 32 characters.
 *
 * Characters outside Nimiq's alphabet are dropped rather than substituted, so
 * `'ALICE'` and `'ALICE!'` are the same wallet — which is what a reader expects
 * from a label. Two labels that differ only outside the alphabet would collide,
 * and no fixture needs that distinction.
 */
export function testAddress(label: string): string {
  const cleaned = [...label.toUpperCase()].filter((c) => ALPHABET.includes(c)).join('')
  if (cleaned.length === 0 || cleaned.length > 32) {
    throw new Error(`test label ${label} has ${cleaned.length} usable characters, need 1..32`)
  }
  const payload = cleaned.padEnd(32, '0')
  return `NQ${checkDigits(payload)}${payload}`
}
