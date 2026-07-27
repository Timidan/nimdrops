/**
 * The sponsor's early close, client side (server: `services/close.ts`).
 *
 * Three commitments, and they are the claim machine's commitments read from the
 * other side of the link:
 *
 *  1. **Only the server says a drop is closed.** The two calls this screen makes
 *     (`requestCloseChallenge` and `closeDrop`, in `api.ts` with every other
 *     endpoint) send a signature and report what they are told. They never
 *     predict the outcome, and they never say a refund has arrived — the 202
 *     means the refund is queued, exactly as a claim's 202 means a share is
 *     reserved.
 *  2. **Irreversible is said before, not after.** The confirm step is a screen,
 *     not a toast: the page names what closing does to the sponsor's money AND
 *     what it does to everyone holding the link, and only then offers a button.
 *  3. **Every refusal has a name.** Wrong wallet, already closed, never funded
 *     and "we could not check that approval" are four different facts, and a
 *     sponsor who cannot tell them apart cannot act on any of them.
 */
import { ApiError, NetworkError } from '../api'

/**
 * The one sentence to show for a refused close.
 *
 * The server's own message is used wherever it has one, for the same reason the
 * disclosure text is not rewritten here: it enforces the rule, so it owns the
 * words. This table only covers what the server cannot know — the network being
 * gone, and the wallet being closed without approving.
 */
export function closeFailureNotice(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof NetworkError) return 'We could not reach NimDrops just now. Nothing changed.'
  return 'Something went wrong and the drop was not closed.'
}
