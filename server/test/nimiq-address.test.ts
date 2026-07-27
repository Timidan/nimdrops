import { describe, expect, it } from 'vitest'
import { isValidNimiqAddress, normaliseNimiqAddress } from '../src/nimiq-address'
import { testAddress } from './fixtures/address'

/**
 * Every Nimiq address written down in this repository.
 *
 * These are the fixtures because they were not invented for the test: they are
 * addresses real wallets and a real custody key actually produced, recorded in the
 * evidence write-ups and the hackathon notes. A validator that agrees with a
 * description of the algorithm but disagrees with these would be wrong about the
 * only thing that matters.
 */
const REAL = [
  // docs/HACKATHON.md:435 — mainnet custody
  'NQ97 EGUS 3JPF ELP3 TR5N 0L6E 4Y4Y GGX4 540G',
  // docs/HACKATHON.md:109, docs/evidence/g1-vps-*.md — testnet custody
  'NQ55 039X 60U7 RJXX 8SFG NGQH VLBL VJS3 NQ4M',
  // docs/ATTESTATIONS.md:278,290 — the wallet named in a signed attestation
  'NQ71 CAAV SDGU D6YE 5M54 M6QX UBJ2 TMS0 6SPA',
  // docs/evidence/g1-vps-clean-run.md — sponsor, claimant A, claimant B
  'NQ15 67BK NX8A RN7K QLAF 98AN PGQ3 KKE1 DDSJ',
  'NQ85 S3TR NVRG 7DLH 3K0T BXC1 L47A UAXU DL4B',
  'NQ87 BGPF 77QQ QJLP ADMT K8MC E1RK C9JT NKG6',
  // docs/evidence/g1-vps-round4-run.md — sponsor, claimant A, claimant B
  'NQ31 RHFE 5VFP K8MR TDMG LXAG AXM9 FTXS UK7F',
  'NQ73 B98X SH8R BV5K 3556 BU3L 9315 080M 76AS',
  'NQ19 NTCX G934 CYKP XEAQ BDJ6 YTED 3M3J X31V',
  // docs/evidence/g1-vps-s3_20260726040800.md — sponsor, claimant A, claimant B
  'NQ40 M27K U938 YRX9 FC8Q N8Y0 6LYJ C8HF HRSM',
  'NQ39 NQNT LN71 RXKY 30BU QCMC CVE9 V3D1 CDEJ',
  'NQ19 3UDH D4F2 SHCA J060 QXSJ TBR6 2XJG N3KK',
] as const

/** Nimiq's base-32 alphabet: RFC 4648 without the confusable `I`, `O`, `W`, `Z`. */
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'
const compact = (address: string) => address.replace(/\s/g, '').toUpperCase()
const isDigit = (ch: string) => ch >= '0' && ch <= '9'

describe('isValidNimiqAddress', () => {
  it('accepts every address this repository records', () => {
    for (const address of REAL) {
      expect(isValidNimiqAddress(address), address).toBe(true)
    }
  })

  it('accepts each of them compacted and lowercased too', () => {
    for (const address of REAL) {
      expect(isValidNimiqAddress(compact(address)), address).toBe(true)
      expect(isValidNimiqAddress(address.toLowerCase()), address).toBe(true)
      expect(isValidNimiqAddress(compact(address).toLowerCase()), address).toBe(true)
    }
  })

  it('rejects every same-class single-character mutation of every real address', () => {
    // "Same class" means digit-for-digit or letter-for-letter. That restriction is
    // not a convenience — it is the exact boundary of what mod-97 guarantees, and
    // the next test is about the other side of it. Within a class the substitution
    // changes the digit expansion by `delta * 10^k` with `|delta| <= 25`, and 97 is
    // prime, so the remainder cannot come back to the same value. Exhaustive here:
    // every payload position against every same-class alternative.
    let checked = 0
    for (const address of REAL) {
      const s = compact(address)
      for (let i = 4; i < s.length; i += 1) {
        for (const ch of ALPHABET) {
          if (ch === s[i] || isDigit(ch) !== isDigit(s[i])) continue
          const mutated = s.slice(0, i) + ch + s.slice(i + 1)
          expect(isValidNimiqAddress(mutated), mutated).toBe(false)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(2000)
  })

  it('rejects all but a thin residue of cross-class mutations, and only cross-class ones', () => {
    // Honest statement of a limitation inherited from IBAN mod-97 rather than
    // introduced here: substituting a digit for a letter (or the reverse) changes
    // the LENGTH of the decimal expansion, because a letter contributes two digits
    // and a digit contributes one. That shifts every following digit's place value,
    // so the residue is effectively re-rolled and about 1 in 97 such mutations
    // lands back on a passing checksum. `@nimiq/core` accepts exactly the same
    // strings; this is the scheme's detection rate, not a defect in this module.
    //
    // What this asserts is that the residue stays at that scale and that nothing
    // outside the cross-class case slips through at all.
    const candidates = `${ALPHABET}IOWZ`
    let total = 0
    const accepted: string[] = []
    for (const address of REAL) {
      const s = compact(address)
      for (let i = 0; i < s.length; i += 1) {
        for (const ch of candidates) {
          if (ch === s[i]) continue
          total += 1
          if (isValidNimiqAddress(s.slice(0, i) + ch + s.slice(i + 1))) {
            accepted.push(`${i}:${s[i]}->${ch} in ${address}`)
          }
        }
      }
    }
    // Every survivor swapped a digit for a letter or a letter for a digit, in the
    // payload. None touched `NQ`, none touched a check digit.
    for (const note of accepted) {
      const [position, swap] = [Number(note.split(':')[0]), note.split(':')[1].split(' ')[0]]
      const [from, to] = swap.split('->')
      expect(position, note).toBeGreaterThanOrEqual(4)
      expect(isDigit(from) === isDigit(to), note).toBe(false)
    }
    expect(accepted.length / total, accepted.join('\n')).toBeLessThan(0.005)
  })

  it('rejects a well-shaped address whose check digits are simply wrong', () => {
    // The shape check this replaced accepted all 99 of these for every address.
    for (const address of REAL) {
      const s = compact(address)
      const real = Number(s.slice(2, 4))
      for (let cd = 0; cd < 100; cd += 1) {
        if (cd === real) continue
        const mutated = `NQ${String(cd).padStart(2, '0')}${s.slice(4)}`
        expect(isValidNimiqAddress(mutated), mutated).toBe(false)
      }
    }
  })

  it('rejects payload characters outside the alphabet', () => {
    // `I`, `O`, `W` and `Z` are omitted precisely because a human confuses them
    // with `1`, `0`, `VV` and `2`, so seeing one means a transcription slip.
    const s = compact(REAL[0])
    for (const ch of 'IOWZ') {
      expect(isValidNimiqAddress(s.slice(0, 4) + ch + s.slice(5))).toBe(false)
    }
  })

  it('rejects the wrong length, the wrong prefix and non-digit check digits', () => {
    const s = compact(REAL[0])
    expect(isValidNimiqAddress(s.slice(0, 35))).toBe(false)
    expect(isValidNimiqAddress(`${s}0`)).toBe(false)
    expect(isValidNimiqAddress(`XQ${s.slice(2)}`)).toBe(false)
    expect(isValidNimiqAddress(`NQA${s.slice(3)}`)).toBe(false)
    expect(isValidNimiqAddress(`NQ${s[2]}B${s.slice(4)}`)).toBe(false)
    expect(isValidNimiqAddress('')).toBe(false)
    expect(isValidNimiqAddress('NQ')).toBe(false)
    // The old regex `/^NQ[0-9A-Z ]{34,44}$/i` matched this. It is 36 characters of
    // nothing, and it used to be enough to write a grant nobody could ever claim.
    expect(isValidNimiqAddress('NQ00 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA')).toBe(false)
  })

  it('is total on hostile input rather than throwing', () => {
    for (const value of [undefined, null, 42, {}, [], Symbol.iterator] as unknown[]) {
      expect(() => isValidNimiqAddress(value as string)).not.toThrow()
      expect(isValidNimiqAddress(value as string)).toBe(false)
    }
  })
})

describe('normaliseNimiqAddress', () => {
  it('collapses every spelling of one wallet to a single string', () => {
    // The whole point: these must not be able to become several `gate_grants`
    // rows for one wallet, one of which the claim path could then never match.
    const address = 'NQ55 039X 60U7 RJXX 8SFG NGQH VLBL VJS3 NQ4M'
    const expected = 'NQ55039X60U7RJXX8SFGNGQHVLBLVJS3NQ4M'
    const spellings = [
      address,
      address.toLowerCase(),
      address.toUpperCase(),
      expected,
      expected.toLowerCase(),
      `  ${address}  `,
      address.replace(/ /g, ''),
      address.replace(/ /g, '  '),
      address.replace(/ /g, '\t'),
      'nq56039X 60U7 RJXX 8SFG NGQH VLBL VJS3 bse6',
      `NQ56\n039X 60U7 RJXX 8SFG NGQH VLBL VJS3 BSE6`,
    ]
    for (const spelling of spellings) {
      expect(normaliseNimiqAddress(spelling), JSON.stringify(spelling)).toBe(expected)
    }
    expect(new Set(spellings.map((s) => normaliseNimiqAddress(s))).size).toBe(1)
  })

  it('normalises every real address to 36 characters and back to itself', () => {
    for (const address of REAL) {
      const normalised = normaliseNimiqAddress(address)
      expect(normalised, address).toBe(compact(address))
      expect(normalised).toHaveLength(36)
      // Idempotent, so a value read back out of the database normalises to itself.
      expect(normaliseNimiqAddress(normalised!)).toBe(normalised)
    }
  })

  it('returns null rather than a tidied-up invalid address', () => {
    // A caller that treated the return as a string would otherwise store the
    // cleaned-up spelling of something no wallet can hold.
    expect(normaliseNimiqAddress('nope')).toBeNull()
    expect(normaliseNimiqAddress('NQ07 PLAYER')).toBeNull()
    expect(normaliseNimiqAddress('NQ00 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA')).toBeNull()
    // One character off a real address, same class, so the checksum is the only
    // thing standing between this and acceptance.
    expect(normaliseNimiqAddress('NQ56 039X 60U7 RJXX 8SFG NGQH VLBL VJS3 BSE5')).toBeNull()
  })
})

describe('testAddress, the fixture the other suites are built on', () => {
  /**
   * Every DB suite now mints its wallets with this, so a bug here would make all
   * of them pass against addresses the product would reject. Checked against the
   * real validator, which the fixture deliberately does not call.
   */
  it('mints addresses the validator accepts, spelling the label', () => {
    for (const label of ['PLAYER', 'ALICE', 'BOB', 'A', 'CLAIMANT SECRET', '0']) {
      const address = testAddress(label)
      expect(isValidNimiqAddress(address), `${label} -> ${address}`).toBe(true)
      // Already in the one spelling, so a fixture never has to be normalised
      // before being compared with a value that came back out of the database.
      expect(normaliseNimiqAddress(address)).toBe(address)
      // The label survives minus anything outside Nimiq's alphabet — `ALICE`
      // reads as `ALCE`, because `I` is one of the four confusable characters
      // the alphabet omits. Still readable in a failure message, which is the
      // only thing the label is for.
      expect(address).toContain([...label].filter((c) => ALPHABET.includes(c)).join(''))
    }
  })

  it('gives different labels different addresses', () => {
    expect(new Set(['ALICE', 'BOB', 'CAROL'].map(testAddress)).size).toBe(3)
  })

  it('refuses a label it cannot spell, rather than quietly truncating', () => {
    // Silent truncation would make two long labels one wallet, and the suite that
    // tripped over it would be testing something it did not mean to.
    expect(() => testAddress('!!!')).toThrow()
    expect(() => testAddress('A'.repeat(33))).toThrow()
  })
})
