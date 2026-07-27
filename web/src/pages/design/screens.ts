/**
 * DEV-ONLY. The screens every design system has to answer.
 *
 * A system that only holds the claim screen is not a system, so each of the
 * five covers all of these in its own vocabulary. They are listed here in one
 * place so the board can walk them and nothing can quietly go missing.
 *
 *   claim     the judged surface: a funded drop with a share left
 *   claimed   the moment after the claim resolves, and the receipt
 *   sealed    no wallet provider. Desktop is this, always. See below.
 *   gate      a gated drop before the session starts
 *   question  the trivia workhorse: prompt, four options, deadline, progress
 *   passed    the session cleared, leading into the claim
 *   failed    the session did not clear, with the cooldown, and no dead button
 *   games     the discovery list of gated drops and the tier each needs
 *
 * ## `sealed` is a state, not a breakpoint
 *
 * A claim cannot be opened without a wallet provider, and there is no provider
 * in a desktop browser: Nimiq Pay is a phone app. So the branch is on the SDK
 * adapter reporting `unavailable`, never on viewport width. A phone browser
 * with no wallet installed gets exactly the same screen as a 27-inch monitor,
 * which is correct, because they have the same problem.
 *
 * `sealed` is a FINISHED state and not a disabled one. There is no greyed-out
 * primary anywhere in it. It shows the amount, the fixed-and-equal fact, and a
 * QR, and that is the whole screen. In these samples `canSign` is passed as a
 * prop so the board can render both; in the product it comes from the adapter.
 */
export type Screen =
  | 'claim'
  | 'claimed'
  | 'sealed'
  | 'gate'
  | 'question'
  | 'passed'
  | 'failed'
  | 'games'

export const SCREENS: Screen[] = [
  'claim',
  'claimed',
  'sealed',
  'gate',
  'question',
  'passed',
  'failed',
  'games',
]

export interface SampleProps {
  screen: Screen
  /** True when this owns the viewport, so the field can be `100dvh`. */
  solo?: boolean
  /**
   * Forces the pressed state of the sample's primary control, so a filmstrip
   * can capture press feedback deterministically instead of racing a timer.
   */
  pressed?: boolean
}

export interface SampleMeta {
  id: string
  name: string
  /** The form decision the whole system follows from. */
  thesis: string
  /** Primary action, amount treatment, containment, corners, anchor, density. */
  form: string
  /** The motion character, in the terms the report uses. */
  motion: string
  /** How this system answers "correctness is never revealed". */
  silence: string
}
