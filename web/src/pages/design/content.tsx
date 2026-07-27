import { useMemo } from 'react'

/**
 * DEV-ONLY. The facts all five design systems are drawn with, and the mock QR.
 *
 * Copy lives here rather than in the five sample files so that a difference
 * between two samples is always a difference of FORM. If one of them looked
 * better because it happened to be given shorter words, the comparison would
 * be worthless.
 */

export const DROP = {
  sponsor: 'Amara O.',
  message: 'Thanks for a good week. Small one, from all of us.',
  amount: '5',
  shares: 5,
  left: 3,
  expiresIn: '3h 20m',
  txHash: 'b3f1c9d4a2e88170c5be34a9017d6f2b4c8ea51d93b0776fe2a4c81d6b0937ae',
  address: 'NQ07 8E9J 4KTM 9XQ2 7VLC 4K2M',
  link: 'https://nimdrops.timidan.xyz/drop/7f3a91c2',
} as const

/**
 * The trivia session, per `docs/superpowers/specs/2026-07-26-nimdrops-trivia-gate-design.md`.
 *
 * Five questions, four options, five distinct categories, a server-stamped
 * per-question deadline, and the constraint that shapes every one of these
 * screens: **per-question correctness is never revealed**. Not during the
 * session, not after. So none of the five samples may use a tick, a cross, a
 * green fill, a red fill, or a score. The vocabulary every quiz UI reaches for
 * is unavailable here, and each sample answers that differently.
 *
 * The question below is deliberately long, and so is option C, because the
 * question screen is the workhorse and it has to hold both at 320px.
 */
export const TRIVIA = {
  tier: 'Easy',
  index: 3,
  total: 5,
  category: 'Science',
  secondsLeft: 9,
  secondsPerQuestion: 15,
  question: 'Which of these instruments measures the pressure of the atmosphere around it?',
  options: [
    'A hygrometer',
    'A barometer',
    'An anemometer, which the shipping forecast also uses',
    'A seismograph',
  ],
  /** Which option the mock shows as chosen. Not an answer key. */
  picked: 1,
  cooldownMinutes: 10,
} as const

/** The `/game` listing. Tier, payout, slots, expiry, and the unlock. Never addresses. */
export const GAMES = [
  { tier: 'Novice', amount: '2', left: 4, of: 8, expires: '5h 10m', locked: false },
  { tier: 'Easy', amount: '5', left: 3, of: 5, expires: '3h 20m', locked: false },
  { tier: 'Medium', amount: '12', left: 6, of: 6, expires: '9h 02m', locked: 'Pass an Easy game' },
  { tier: 'Hard', amount: '30', left: 2, of: 4, expires: '21h 44m', locked: 'Pass a Medium game' },
] as const

/** The three facts that must stay reachable, wherever a sample decides to put them. */
export const CUSTODY = [
  {
    k: 'Who holds it',
    v: 'Until you claim it, the NIM sits in a wallet the NimDrops operator controls. Not a smart contract, and not yours.',
  },
  {
    k: 'One share per',
    v: 'Wallet. A signature proves a wallet, not a person, so anyone holding several can take several.',
  },
  {
    k: 'After 24 hours',
    v: 'The drop closes and every unclaimed share goes back to the wallet that funded it.',
  },
] as const

/**
 * A mock QR, drawn rather than encoded.
 *
 * The production surface already serves a real one at `/drop/:publicId/qr.svg`.
 * This exists so the sealed desktop composition can be judged at the right
 * visual weight without the sample depending on a server. It is deterministic,
 * so two screenshots of the same sample match, and it carries the three finder
 * patterns a reader recognises a QR by. It does not encode anything and must
 * never be shipped.
 */
export function MockQr({ size = 168, dark = '#141010', light = '#ffffff' }) {
  const modules = 25
  const cells = useMemo(() => {
    // xorshift, seeded, so the pattern is stable across renders and captures.
    let seed = 0x9e3779b9
    const rand = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return ((seed >>> 0) % 1000) / 1000
    }
    const inFinder = (x: number, y: number) =>
      (x < 8 && y < 8) || (x > modules - 9 && y < 8) || (x < 8 && y > modules - 9)
    const out: [number, number][] = []
    for (let y = 0; y < modules; y++) {
      for (let x = 0; x < modules; x++) {
        if (inFinder(x, y)) continue
        if (rand() > 0.52) out.push([x, y])
      }
    }
    return out
  }, [])

  const finder = (fx: number, fy: number) => (
    <g key={`${fx}-${fy}`}>
      <rect x={fx} y={fy} width={7} height={7} fill={dark} />
      <rect x={fx + 1} y={fy + 1} width={5} height={5} fill={light} />
      <rect x={fx + 2} y={fy + 2} width={3} height={3} fill={dark} />
    </g>
  )

  return (
    <svg
      width={size}
      height={size}
      viewBox={`-1 -1 ${modules + 2} ${modules + 2}`}
      role="img"
      aria-label="QR code for this drop's link"
      shapeRendering="crispEdges"
    >
      <rect x={-1} y={-1} width={modules + 2} height={modules + 2} fill={light} />
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={dark} />
      ))}
      {finder(0, 0)}
      {finder(modules - 7, 0)}
      {finder(0, modules - 7)}
    </svg>
  )
}
