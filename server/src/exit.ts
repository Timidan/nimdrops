/**
 * How a process that has held a `@nimiq/core` client is allowed to end.
 *
 * Every entrypoint in this repo that constructs a `NimiqChain` — `recover.ts`,
 * `worker.ts`, and the S3 spike's child runner — has the same two problems on
 * the way out, and both of them are the library's, not ours:
 *
 *  1. **It will not let the process end by itself.** The web client spawns a
 *     consensus WORKER THREAD whose timers and handles keep the event loop
 *     alive forever. Setting `process.exitCode` and letting Node drain is the
 *     tidy way to finish a CLI and it simply does not work here — observed on
 *     the VPS as `pnpm tsx src/recover.ts status` printing its whole report and
 *     then hanging until `timeout` killed it with 124. `chain.close()`
 *     disconnects the network; it does not tear those handles down.
 *
 *  2. **It can throw AFTER the work is finished.** The nodejs build talks to
 *     that worker over a `MessagePort`, which is an `EventTarget`, and its
 *     message listeners are async. When such a listener rejects, Node's
 *     `EventTarget` glue (`internal/event_target`'s `addCatch`) re-raises the
 *     rejection as an UNCAUGHT EXCEPTION on the next tick:
 *
 *         process.nextTick(() => { throw err; });
 *         Error: called `Result::unwrap_throw()` on an `Err` value
 *
 *     That is dispatched independently of whatever we are awaiting, so no
 *     `try`/`catch` around `chain.close()` can see it, and Node's default
 *     handler ends the process with status 1. This is what failed the G1 gate
 *     run `s3_20260726052025`: the recovering child had already confirmed its
 *     transfer, then died 1 in teardown, and the parent — which requires a
 *     clean exit from that child — declared the whole run failed.
 *
 * So the rule this module encodes is: **the exit code reports THE WORK, and it
 * is decided before teardown starts.** A fault raised after that point is
 * logged, because a WASM error nobody ever sees is its own bug, and then
 * discarded as an influence on the status the parent reads.
 *
 * What it deliberately does NOT do: it never runs before the outcome is known.
 * A fault during the work still reaches Node's default handler and still kills
 * the process non-zero, and a signal-based death (the S3 crash legs SIGKILL
 * themselves) is unreachable from user code and stays that way.
 */

import { errorMessage } from './config'

/** Longest we will wait for a stream that is not draining. */
const FLUSH_GRACE_MS = 2_000

/**
 * Longest we will wait for teardown before leaving without it.
 *
 * Closing a pool and disconnecting a node is a sub-second job; anything past
 * this is stuck, and a stuck teardown must not be able to do what an exploding
 * one could not, which is change how this process ends. Found the hard way: the
 * S3 child's `pool.end()` waits for every checked-out client, the advisory-lock
 * connection is checked out for the process's lifetime, and the run that
 * exposed it had been ending only because the WASM rethrow arrived to break the
 * deadlock. Guarding the exception without guarding the wait would have turned
 * "exits 1" into "never exits" — a worse bug wearing the fix's clothes.
 */
const TEARDOWN_GRACE_MS = 10_000

/**
 * End the process with `code`, once its output has actually gone out.
 *
 * The flush matters: when stdout or stderr is a pipe (`| jq`, a log collector,
 * CI) writes are asynchronous, and `process.exit` discards whatever is still
 * queued. A report that exits promptly but truncates its own JSON would be a
 * worse bug than the hang described above — and the same goes for the teardown
 * fault line, which is on stderr and is the only record that anything went
 * wrong at all.
 *
 * The grace timer is the fallback for a stream that will never drain (a reader
 * that has already gone away). It is `unref`ed so it cannot itself be the
 * reason the process lingers; the consensus worker's handles keep the loop
 * turning, so it still fires.
 */
export function exitAfterFlush(code: number): void {
  process.exitCode = code

  let pending = 0
  const drained = (): void => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableLength > 0) {
      pending += 1
      stream.write('', drained)
    }
  }
  if (pending === 0) process.exit(code)

  setTimeout(() => process.exit(code), FLUSH_GRACE_MS).unref()
}

/**
 * Freeze the exit code at `code`, then tear down and go.
 *
 * Call this at the moment the process's OUTCOME is known and nothing else it
 * was asked to do remains — after the transfer confirmed, after the worker
 * loop stopped, after the operator command printed. From here on:
 *
 *  - `teardown()` runs, and a rejection from it is logged and then ignored;
 *  - an uncaught exception or unhandled rejection — the `unwrap_throw` above —
 *    is logged and then ends the process with `code` rather than with 1;
 *  - the process exits with `code` either way, promptly, without waiting for a
 *    consensus worker that is never going to release the loop.
 *
 * `log` is the caller's own writer so the line lands in the same stream the
 * rest of its output did. It must be synchronous-safe: it may be called from an
 * uncaught-exception handler moments before the process ends.
 */
export function exitAfterTeardown(
  code: number,
  teardown: () => Promise<void>,
  log: (message: string) => void,
): void {
  let leaving = false
  const leave = (): void => {
    if (leaving) return
    leaving = true
    clearTimeout(overdue)
    exitAfterFlush(code)
  }

  const afterTheFact = (what: string) => (err: unknown) => {
    log(`${what} after the work finished (exit code stays ${code}): ${errorMessage(err)}`)
    leave()
  }

  // NOT `unref`ed: a teardown that has deadlocked may be the only thing left in
  // the loop, and this timer is precisely what has to survive that.
  const overdue = setTimeout(() => {
    log(`teardown still unfinished after ${TEARDOWN_GRACE_MS}ms; leaving with ${code} anyway`)
    leave()
  }, TEARDOWN_GRACE_MS)

  // Installed BEFORE teardown is started, so there is no window in which the
  // library can raise and reach Node's default handler instead.
  process.on('uncaughtException', afterTheFact('uncaught exception'))
  process.on('unhandledRejection', afterTheFact('unhandled rejection'))

  // `Promise.resolve().then(teardown)` rather than `teardown()`: a teardown
  // that throws SYNCHRONOUSLY would otherwise escape out of this function
  // entirely, past the handlers just installed to catch exactly that.
  Promise.resolve()
    .then(teardown)
    .then(leave, afterTheFact('teardown failed'))
}
