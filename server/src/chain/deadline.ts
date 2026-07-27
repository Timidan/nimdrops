/**
 * A hard wall-clock bound on any single chain call the money engine makes.
 *
 * Nothing in `ChainClient` promises to return. `NimiqChain.getTransaction`
 * awaits `connect()` (which waits for consensus) and then a peer round trip,
 * and neither has a timeout of its own — a peer that accepts the request and
 * never answers leaves the caller awaiting forever. That is survivable in a
 * one-shot CLI and it is not survivable in the worker: `runWorkerTick`
 * materialises every open attempt and polls them SEQUENTIALLY, so one call that
 * never returns stops that tick, and the tick also carries refunds, expiry,
 * settlement and every other drop. Since the size and headcount caps came out,
 * the number of open attempts a single drop can produce is unbounded, which
 * turns "one slow lookup" from an annoyance into a way to stop the whole
 * deployment paying anybody.
 *
 * The bound lives HERE, at the call site in the money engine, rather than
 * inside `chain/nimiq.ts`, for two reasons:
 *
 *  - it then applies to every `ChainClient`, including the ones tests and the
 *    harness pass in, so "the worker will not wait longer than this" is a
 *    property of the worker rather than of one implementation; and
 *  - `chain/types.ts` is frozen and `chain/nimiq.ts` is the adapter for one
 *    library's API. A scheduling guarantee the money engine needs is not that
 *    library's business.
 *
 * WHAT A TIMEOUT MEANS. Exactly what any other lookup failure means: "we could
 * not ask." It is NOT absence. Every caller here already distinguishes the two —
 * `progressLocked` records `last_error` and records NO absence observation,
 * `evaluateProvenDead` returns `unknown: true` with `absent: false` — so a
 * timeout degrades onto the existing retry path and can never contribute to the
 * `proven_dead` evidence chain that authorises spending the same money twice.
 * The error message is deliberately worded to match none of the "not found"
 * phrases in `chain/nimiq.ts` or `services/drops.ts`, so it cannot be mistaken
 * for one by the string tests those two files use.
 */

/**
 * How long the money engine will wait for one chain call.
 *
 * Ten seconds, chosen between two failure directions:
 *
 *  - TOO SHORT and a slow-but-working node is failed spuriously. That is not
 *    free: each failure records `last_error` on the attempt, and fifteen
 *    minutes of them (`UNRESOLVED_BUDGET_MS`) hands the intent to an operator.
 *    Measured on TestAlbatross (`server/spike/g0-evidence.md`), establishing
 *    consensus took ~4.3 s and a lookup after that answered in well under a
 *    second, so ten seconds is more than twice the worst measured connect and
 *    an order of magnitude above a normal lookup.
 *  - TOO LONG and the bound stops being one. Ten seconds is five worker ticks
 *    (`TICK_INTERVAL_MS` = 2 s): a call that has not answered in five ticks is
 *    not going to answer in this one, and the same question is asked again on
 *    the next tick anyway.
 *
 * It must also stay far below `UNRESOLVED_BUDGET_MS` (15 min) so that an
 * unreachable node produces a SERIES of recorded observations an operator can
 * read, rather than one endless await that never writes anything down.
 */
export const CHAIN_CALL_TIMEOUT_MS = 10_000

/** The chain did not answer in time. "We could not ask" — never "it is absent". */
export class ChainCallTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`chain lookup "${label}" timed out after ${timeoutMs}ms`)
    this.name = 'ChainCallTimeoutError'
  }
}

/**
 * Run one chain call under {@link CHAIN_CALL_TIMEOUT_MS}.
 *
 * Takes a THUNK, not a promise, so that a client which throws synchronously is
 * turned into a rejection here instead of escaping the bound entirely.
 *
 * The underlying call is not cancelled — `ChainClient` has no cancellation and
 * the WASM client has none either. It is abandoned: its eventual settlement is
 * swallowed, and the money engine has already moved on with "we could not ask",
 * which is a state every caller handles. Abandoning is safe precisely because
 * every call this wraps is a READ.
 */
export function withChainDeadline<T>(
  label: string,
  call: () => Promise<T>,
  timeoutMs: number = CHAIN_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ChainCallTimeoutError(label, timeoutMs))
    }, timeoutMs)
    // A pending deadline must never be the reason a process stays alive.
    timer.unref?.()

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    let work: Promise<T>
    try {
      work = call()
    } catch (err) {
      finish(() => reject(err))
      return
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    )
  })
}
