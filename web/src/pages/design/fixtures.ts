/**
 * DEV-ONLY. The one drop all three directions are drawn with, so the boards can
 * be read against each other rather than against three different fictions.
 *
 * Sponsor, message and amounts are the same shapes `Preview.tsx` uses. The
 * trivia question is a placeholder for a surface another engineer is building;
 * it is here so each direction has to show where the question goes, not so the
 * question is designed.
 */
export const DROP = {
  sponsor: 'Amara O.',
  initial: 'A',
  message: 'Thanks for a good week. Small one, from all of us.',
  amount: '2',
  unit: 'NIM',
  claimCount: 5,
  remaining: 3,
  expiresIn: '3h 20m',
  txHash: 'b3f1c9d4a2e88170c5be34a9017d6f2b4c8ea51d93b0776fe2a4c81d6b0937ae',
} as const

export const TRIVIA = {
  question: 'How long does a Nimiq block take to confirm?',
  options: ['About one second', 'About one minute', 'About three minutes'],
  /** Index of the answer the mockups render as chosen. Not a real answer key. */
  chosen: 0,
} as const

/**
 * Grain, as an SVG data URI.
 *
 * A large flat field of one colour bands on an 8-bit phone panel, and a
 * gradient over it bands worse. Three octaves of fractal noise at 3-5% kills
 * both, costs one composited layer, and is the difference between a surface
 * that looks printed and one that looks like a CSS gradient.
 */
export function grain(): string {
  return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23g)'/%3E%3C/svg%3E\")"
}
