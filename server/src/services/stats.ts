import { errorMessage } from '../config'
import type { Queryable } from '../db/pool'
import { logWarn } from '../http/redact'
import { formatNim } from '../money'

/**
 * Public aggregate statistics (`GET /api/stats`).
 *
 * This file exists so a landing page can say what has actually happened without
 * anybody being able to read it back to a person, and without an unauthenticated
 * endpoint becoming a lever on the database.
 *
 * Four rules shape every line below.
 *
 *  1. **Every number is a query result.** Nothing is estimated, rounded up,
 *     seeded, or filled in with a plausible placeholder. A statistic whose
 *     backing table does not exist yet is NAMED in `unavailable` and carries no
 *     value at all — an absent number is honest, a made-up one is not. The
 *     mainnet pilot is capped at 2 NIM and one live drop, so these figures are
 *     currently tiny; that is the truth and it ships as the truth.
 *
 *  2. **Aggregates only, never a row.** No claimant address, no per-wallet
 *     amount, no per-drop breakdown, no timestamp of an individual payment, no
 *     largest / smallest / average.
 *
 *  3. **Nothing operational beyond what the drop pages and the chain already
 *     publish.** No custody balance, no operator float, no pause flag, no
 *     reconciliation freshness, no `manual_review` or `proven_dead` counts, no
 *     draft or reservation activity. See "what is derivable anyway" below for
 *     the one place this rule is weaker than it first looks, and why it is
 *     published regardless.
 *
 *  4. **This route reads and only reads.** No lock is taken, no row is written,
 *     no service on the money path is called. A statistics page must never be
 *     able to queue behind — or in front of — a payout.
 *
 * ## De-anonymisation at low counts
 *
 * The honest version of this analysis is not "aggregates cannot isolate a
 * payment". They can, and pretending otherwise would be the rationalisation.
 * Two concrete ways:
 *
 *  - **With one settled payout**, `totalPaidOut` IS that individual's amount and
 *    `uniqueWalletsPaid = 1` says so.
 *  - **By polling.** An observer who fetches this endpoint repeatedly and diffs
 *    consecutive snapshots recovers, for any interval in which exactly one
 *    payout settled, that payout's exact amount and roughly when it settled;
 *    `uniqueWalletsPaid` moving or not moving alongside it says whether the
 *    recipient had ever been paid before.
 *
 * So the question is not whether a payment can be isolated. It is what
 * isolating one yields that is not already published better elsewhere, and the
 * answer is nothing:
 *
 *  - **No address is here, so there is nothing to join on.** The response
 *    carries counts and one sum. Every route to a person still runs through the
 *    chain.
 *  - **The chain publishes strictly more, in real time, with the recipient
 *    attached.** The custody address is returned by `GET /api/custody` and
 *    printed in every sponsor's funding instructions, and `PRIVACY.md` states
 *    plainly that payouts are ordinary Nimiq transactions anyone can look up.
 *    Someone watching that address on an explorer already sees each payout's
 *    amount, its exact time AND the recipient — the polling attack above is a
 *    strictly worse version of a feed we point people at ourselves. The
 *    marginal disclosure of these aggregates is zero.
 *  - **The per-drop facts are public anyway.** During the pilot there is one
 *    live drop, so `sharesClaimed` and `dropsFunded` collapse onto that drop —
 *    but its `claimCount`, `remaining` and `amountEach` are already on its
 *    public page, and `UNIQUE (drop_id, recipient_address)` means one claim per
 *    wallet per drop, so a within-drop count reveals no linkage either.
 *
 * ## What is derivable anyway, and is published knowingly
 *
 * `sharesClaimed - uniqueWalletsPaid` is, in the single-drop pilot, exactly the
 * number of claims whose payout has not yet reached recorded finality: the
 * payout backlog. Rule 3 above would seem to forbid that, so it is stated here
 * rather than left to be discovered.
 *
 * It is published because both halves were asked for, because removing either
 * would not close it — `totalPaidOut` divided by the drop page's own
 * `amountEach` gives the settled count too — and because the quantity is not
 * sensitive: a payout confirms roughly a minute after it is broadcast, so a
 * small nonzero backlog is the ordinary steady state rather than a signal, and
 * an observer who wants to know whether payouts are flowing can watch the
 * custody address and get a better answer sooner. Nothing about the difference
 * names a person or a drop.
 *
 * ## What is deliberately absent
 *
 *  - **A most-recent-payout timestamp.** It would hand an observer the exact
 *    block range to look in — the one thing the aggregates otherwise do not
 *    supply — without them having to poll for it.
 *  - **A count of settled payouts.** Together with the sum it is an average,
 *    and at low counts an average is an individual amount wearing a
 *    statistic's name. `uniqueWalletsPaid` is a lower bound on the same count
 *    and was asked for; a second, exact one adds only the number of wallets
 *    that claimed from more than one drop.
 *  - **Any per-drop or time-bucketed series.** Two adjacent buckets differing
 *    by one payout isolate that payout; publishing the series would do the
 *    diffing for the observer instead of making them poll for it.
 *  - **Anything that moves when custody does.** Balance, float, reserve, pause
 *    state, queue depth by transfer state, reconciliation age.
 *
 * If the campaign grows past the pilot this reasoning only strengthens: the
 * counts rise and each individual contribution to them shrinks.
 */

// ---- what counts as money that moved -------------------------------------------

/**
 * The predicate for "paid out", and the reason it is this one.
 *
 * A payout is counted when BOTH
 *
 *   * its intent row is `outgoing_transfers.state = 'confirmed'`, and
 *   * it has at least one `transaction_attempts` row in state `confirmed`.
 *
 * Those two facts are written together, in one transaction, by `applyConfirm`
 * in `services/transfers.ts`, and `applyConfirm` is reached only after
 * `chain.isFinal(tx, head)` — this deployment's finality depth, floored at 64
 * blocks (`config.ts`), which always spans an Albatross macro block. So a luna
 * in this sum is a luna that reached custody-defined finality on chain. Nothing
 * else in the codebase may set either state; `transfers.ts` says so in its
 * header: "`chain.isFinal(tx, head)` is the ONLY authority for
 * `confirmed`/`paid`."
 *
 * What is therefore excluded, deliberately:
 *
 *  - `queued` and `in_progress` intents — signed or broadcast is not paid.
 *  - `manual_review` intents — an operator is looking at them precisely because
 *    nobody can yet say what the chain did with the money.
 *  - `proven_dead` attempts — an attempt an operator proved never landed.
 *  - a `confirmed` intent with no `confirmed` attempt, and a `confirmed`
 *    attempt whose intent is not `confirmed`. Neither pairing is reachable
 *    through the code, so requiring both costs nothing and means a single
 *    hand-edited row cannot inflate the published total on its own.
 *
 * This is the same "finalized" definition the solvency ledger uses
 * (`outstandingPrincipalLuna`, `ledgerMovementsLuna` in `services/solvency.ts`),
 * so the public number and the internal books can never disagree about which
 * payments happened. It is also the conservative direction in every failure I
 * can construct: a payout that just reached finality but has not been
 * reconciled yet is missing from this sum for up to one worker tick, and a
 * replacement that double-paid would be under-reported, never over-reported.
 * Under-reporting money moved is a page that catches up; over-reporting it is a
 * lie about a payment.
 *
 * `EXISTS` rather than a join, so a transfer with a confirmed attempt *and* a
 * superseded one is summed once.
 */
const SETTLED_PAYOUTS_CTE = `
  settled_payouts AS (
    SELECT t.amount_luna, t.recipient_address
    FROM outgoing_transfers t
    WHERE t.purpose = 'payout'
      AND t.state = 'confirmed'
      AND EXISTS (
        SELECT 1 FROM transaction_attempts a
        WHERE a.transfer_id = t.id AND a.state = 'confirmed'
      )
  )
`

/**
 * Everything the page needs, in one round trip.
 *
 * `to_regclass` resolves against the connection's `search_path`, which is what
 * the race and API suites need — they migrate into private schemas — and it
 * answers without touching the table, so probing costs nothing when the table
 * is absent.
 */
const AGGREGATES_SQL = `
  WITH ${SETTLED_PAYOUTS_CTE}
  SELECT
    COALESCE((SELECT SUM(amount_luna) FROM settled_payouts), 0)::BIGINT        AS paid_out_luna,
    (SELECT count(DISTINCT recipient_address) FROM settled_payouts)::int       AS unique_wallets_paid,
    (SELECT count(*) FROM drops WHERE activated_height IS NOT NULL)::int       AS drops_funded,
    (SELECT count(*) FROM claims)::int                                         AS shares_claimed,
    to_regclass('trivia_answers') IS NOT NULL                                  AS trivia_present
`

/** Answers actually submitted, once the claim gate ships. See `questionsAnswered` below. */
const TRIVIA_ANSWERS_SQL = `
  SELECT count(*)::int AS questions_answered
  FROM trivia_answers
  WHERE answered_at IS NOT NULL
`

/** Postgres: undefined_table, undefined_column. Either means "not built yet". */
const MISSING_RELATION_CODES = new Set(['42P01', '42703'])

// ---- response shape ---------------------------------------------------------------

/**
 * The published statistics.
 *
 * Every key is optional in the forward-compatible sense: a client renders the
 * ones it recognises and ignores the rest. A statistic that has no data source
 * in this deployment is ABSENT here and NAMED in {@link PublicStats.unavailable},
 * so "we cannot measure this yet" and "this measured zero" are never confused
 * with each other — which is the whole reason `questionsAnswered` is not simply
 * reported as `0` today.
 */
export interface StatsFigures {
  /**
   * Settled payouts, as an exact decimal NIM string (`formatNim` is lossless —
   * it truncates no digits and rounds nothing; 1 NIM = 100000 luna).
   */
  totalPaidOut: string
  /**
   * The same amount in luna, as a string. BIGINT never becomes a JS `number`:
   * `db/pool.ts` pins int8 to string at the driver on purpose, and this value
   * travels the whole way as text. Clients doing arithmetic must use this one.
   */
  totalPaidOutLuna: string
  /** Distinct recipient addresses that have received a settled payout. A count. */
  uniqueWalletsPaid: number
  /** Drops whose funding transaction was verified and reached finality. */
  dropsFunded: number
  /** Shares reserved by a wallet signature, the same basis as a drop page's `remaining`. */
  sharesClaimed: number
  /**
   * Trivia questions actually answered. ABSENT until the conditional-claims
   * migration lands `trivia_answers`; see {@link PublicStats.unavailable}.
   */
  questionsAnswered?: number
}

export interface PublicStats {
  /**
   * When these figures were computed, ISO 8601. Not the time of the request:
   * this endpoint answers from a cached snapshot, and sometimes a deliberately
   * stale one, so it reports the age it really has and the page can never
   * present an old number as a fresh one.
   */
  generatedAt: string
  stats: StatsFigures
  /**
   * Statistics this deployment knows about but cannot currently measure, by the
   * key they will occupy in `stats` once it can. Empty is the normal state.
   *
   * This is the seam that keeps the trivia stat non-breaking: when the
   * conditional-claims migration creates `trivia_answers`, `questionsAnswered`
   * appears in `stats` and disappears from here. No key changes meaning, no key
   * is removed, and a client written today keeps working either way.
   */
  unavailable: string[]
}

/** The key `questionsAnswered` occupies, named once so route and tests agree. */
export const QUESTIONS_ANSWERED = 'questionsAnswered'

// ---- the query -------------------------------------------------------------------

interface AggregateRow {
  paid_out_luna: string
  unique_wallets_paid: number
  drops_funded: number
  shares_claimed: number
  trivia_present: boolean
}

/**
 * Run the aggregates. Uncached — {@link StatsCache} is what routes should use.
 *
 * Two statements at most, and the second only when the trivia tables exist.
 */
export async function computePublicStats(
  db: Queryable,
  now: () => number = Date.now,
): Promise<PublicStats> {
  const { rows } = await db.query<AggregateRow>(AGGREGATES_SQL)
  const row = rows[0]
  if (!row) throw new Error('stats aggregate returned no row')

  const paidOutLuna = BigInt(row.paid_out_luna)
  const stats: StatsFigures = {
    totalPaidOut: formatNim(paidOutLuna),
    totalPaidOutLuna: paidOutLuna.toString(),
    uniqueWalletsPaid: row.unique_wallets_paid,
    dropsFunded: row.drops_funded,
    sharesClaimed: row.shares_claimed,
  }

  const answered = row.trivia_present ? await countAnsweredQuestions(db) : null
  if (answered !== null) stats[QUESTIONS_ANSWERED] = answered

  return {
    generatedAt: new Date(now()).toISOString(),
    stats,
    unavailable: answered === null ? [QUESTIONS_ANSWERED] : [],
  }
}

/**
 * `null` means "cannot be measured", never "zero".
 *
 * The probe above already said the table exists, so the try/catch is for the
 * narrow window in which it stops existing — a migration running underneath us,
 * or a table that exists with a shape this query does not know. Both are
 * "unavailable", and neither is allowed to take the whole page down: the money
 * figures are the reason this endpoint exists and they are already in hand.
 * Any other error is rethrown; a connection failure must not be reported as a
 * missing feature.
 */
async function countAnsweredQuestions(db: Queryable): Promise<number | null> {
  try {
    const { rows } = await db.query<{ questions_answered: number }>(TRIVIA_ANSWERS_SQL)
    return rows[0]?.questions_answered ?? null
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && MISSING_RELATION_CODES.has(code)) return null
    throw err
  }
}

// ---- caching ------------------------------------------------------------------------

/**
 * How long a computed snapshot is served as fresh.
 *
 * These numbers change slowly — a payout reaches finality in about a minute —
 * so a minute of staleness is invisible on a landing page and turns any request
 * rate at all into at most one query per minute.
 */
export const STATS_TTL_MS = 60_000

/**
 * How long a snapshot keeps being served after it stops being fresh, while a
 * refresh happens behind the response.
 *
 * A stale figure is still a real query result, it is labelled with its own
 * `generatedAt`, and every figure here only ever grows — so the failure mode is
 * under-reporting, which is the direction this file always chooses. Past this
 * window the endpoint refuses instead, because "unchanged for ten minutes" and
 * "we lost the database ten minutes ago" must not look the same.
 */
export const STATS_STALE_GRACE_MS = 10 * 60_000

/**
 * After a failed refresh, how long before another one is attempted. Without it
 * a database outage turns every inbound request into a fresh failing query —
 * the amplifier this cache exists to prevent, inverted.
 */
export const STATS_FAILURE_BACKOFF_MS = 5_000

/**
 * How long a caller with nothing to serve waits for a cold refresh before being
 * told no.
 *
 * A hung database must not become unbounded held-open public requests in a
 * process that is also paying claimants. The query itself is not cancelled —
 * it is left to finish or be reaped by the pool — but `inflight` stays set
 * while it runs, so a hang costs exactly one connection no matter how long it
 * lasts or how hard the endpoint is hit.
 */
export const STATS_REFRESH_TIMEOUT_MS = 5_000

/** Thrown when there is no snapshot fresh enough to serve. Carries no detail. */
export class StatsUnavailableError extends Error {
  constructor() {
    super('statistics are temporarily unavailable')
    this.name = 'StatsUnavailableError'
  }
}

/**
 * A refresh either produced a snapshot or did not. The failure carries nothing:
 * whatever went wrong is logged (redacted) at the point it happened and must not
 * travel any further towards a public response.
 */
type Outcome = { ok: true; value: PublicStats } | { ok: false }

export interface StatsCacheOptions {
  now?: () => number
  ttlMs?: number
  staleGraceMs?: number
  failureBackoffMs?: number
  refreshTimeoutMs?: number
}

/**
 * A single-flight, stale-while-revalidate snapshot of {@link computePublicStats}.
 *
 * `GET /api/stats` is unauthenticated and sits on a money service, so the
 * question is not "is this query cheap" but "what does a burst of ten thousand
 * cost us". Four properties answer it:
 *
 *  - **TTL.** Inside the window every request is served from memory and the
 *    database is not touched at all.
 *  - **Stale while revalidating.** Once the window lapses, a warm cache still
 *    answers from memory *immediately* and the refresh runs behind the
 *    response. No public request ever waits on Postgres while we already hold a
 *    real answer — which is what stops a slow database turning into a pile of
 *    held-open sockets in the process that pays claimants.
 *  - **Single flight.** At most one refresh exists at any moment, cold or warm.
 *    A cold cache plus a burst is one query, not one per request, so this
 *    endpoint cannot take connections out of the shared pool no matter how it
 *    is hammered.
 *  - **Bounded failure.** A failing database is queried at most once per
 *    {@link STATS_FAILURE_BACKOFF_MS}, and a caller with nothing to serve waits
 *    at most {@link STATS_REFRESH_TIMEOUT_MS} before being refused.
 *
 * One instance per app (`makeApp` builds it), so the cache dies with the
 * process and holds nothing but the last snapshot — no addresses, no rows.
 */
export class StatsCache {
  /** Freshness window, in ms. The route derives its `Cache-Control` from this. */
  readonly ttlMs: number

  private readonly now: () => number
  private readonly staleGraceMs: number
  private readonly failureBackoffMs: number
  private readonly refreshTimeoutMs: number

  private snapshot: PublicStats | null = null
  private snapshotAt = 0
  private inflight: Promise<Outcome> | null = null
  private lastFailureAt: number | null = null

  constructor(
    private readonly db: Queryable,
    options: StatsCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? STATS_TTL_MS
    this.staleGraceMs = options.staleGraceMs ?? STATS_STALE_GRACE_MS
    this.failureBackoffMs = options.failureBackoffMs ?? STATS_FAILURE_BACKOFF_MS
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? STATS_REFRESH_TIMEOUT_MS
  }

  /** Age of the held snapshot in ms, or `null` when there is none. */
  ageMs(at: number = this.now()): number | null {
    return this.snapshot === null ? null : Math.max(0, at - this.snapshotAt)
  }

  async read(): Promise<PublicStats> {
    const at = this.now()
    const snapshot = this.snapshot
    const age = snapshot === null ? Number.POSITIVE_INFINITY : at - this.snapshotAt

    if (snapshot !== null && age < this.ttlMs) return snapshot

    // Stale but still inside the grace window: answer now, refresh behind.
    if (snapshot !== null && age < this.staleGraceMs) {
      this.refreshInBackground(at)
      return snapshot
    }

    // Nothing servable. This is the only path that waits on the database, and
    // it waits with a deadline.
    if (this.isBackingOff(at)) throw new StatsUnavailableError()
    const outcome = await this.awaitRefresh(this.inflight ?? this.start())
    if (outcome.ok) return outcome.value
    throw new StatsUnavailableError()
  }

  private isBackingOff(at: number): boolean {
    return this.lastFailureAt !== null && at - this.lastFailureAt < this.failureBackoffMs
  }

  private refreshInBackground(at: number): void {
    if (this.inflight !== null || this.isBackingOff(at)) return
    // `start()` resolves rather than rejects, so this cannot become an
    // unhandled rejection behind a response that has already been sent.
    void this.start()
  }

  /**
   * Start exactly one refresh and publish its promise for concurrent callers.
   *
   * `inflight` is cleared only when the underlying query SETTLES — never when a
   * waiter gives up on it — so a hung query can never be joined by a second one.
   */
  private start(): Promise<Outcome> {
    const run: Promise<Outcome> = computePublicStats(this.db, this.now).then(
      (value) => {
        this.snapshot = value
        this.snapshotAt = this.now()
        this.lastFailureAt = null
        this.inflight = null
        return { ok: true, value } as const
      },
      (error) => {
        this.lastFailureAt = this.now()
        this.inflight = null
        // Redacted by `logWarn`; the message belongs to the driver, not to us.
        logWarn('stats_refresh_failed', { error: errorMessage(error) })
        return { ok: false } as const
      },
    )
    this.inflight = run
    return run
  }

  /**
   * Wait for a refresh, but not indefinitely. On timeout the caller is refused
   * and the failure backoff engages, so the requests behind it are refused
   * immediately rather than queueing up behind the same stuck query.
   */
  private awaitRefresh(run: Promise<Outcome>): Promise<Outcome> {
    if (this.refreshTimeoutMs <= 0) return run
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.lastFailureAt = this.now()
        logWarn('stats_refresh_timeout', { timeoutMs: this.refreshTimeoutMs })
        resolve({ ok: false })
      }, this.refreshTimeoutMs)
      void run.then((outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
    })
  }
}
