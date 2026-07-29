import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listGames, type GateKind, type ListedGame } from '../api'
import { formatNim } from '../money'
import Field from '../ui/Field'

/**
 * Every drop that asks something of you, grouped by what it asks.
 *
 * Three rules shape it.
 *
 * **The order is fixed, not discovered.** The server already sorts by kind, then
 * tier, then expiry, and this page groups by the same fixed kind order rather
 * than by arrival. A catalogue that reshuffles itself between loads reads as a
 * slot machine, and randomness is the one prohibited mechanic in this product.
 *
 * **A locked card stays visible, with its payout shown.** Unreachable value a
 * player can see is the only progression reward in the design, so the amount is
 * never hidden behind the requirement — the requirement is stated next to it.
 *
 * **No addresses, ever.** `GET /api/games` selects none: not the custody
 * address, not a sponsor's, not a claimant's (`PRIVACY.md`). Nothing here can
 * print one because nothing here is given one.
 *
 * Nothing here is built on the sealed-paper component: three redesign
 * directions are live and undecided, and one removes it entirely.
 */

/** Fixed, and the same order `services/gates.ts` sorts by. */
const KIND_ORDER: readonly GateKind[] = ['passphrase', 'trivia', 'attested']

const KIND_HEADINGS: Record<GateKind, string> = {
  passphrase: 'Know the phrase',
  trivia: 'Answer five questions',
  attested: 'Confirmed by the organiser',
}

const KIND_BLURBS: Record<GateKind, string> = {
  passphrase: 'Somebody said a phrase out loud. Type it and the share is yours to claim.',
  trivia: 'Five timed questions. Score three or more to unlock a share.',
  attested: 'Whoever runs the drop confirms who is eligible. There is nothing to answer.',
}

const TIER_DESCRIPTIONS: Record<string, string> = {
  novice: 'basics',
  easy: 'everyday',
  medium: 'mixed knowledge',
  hard: 'specialist',
}

export default function Games() {
  const [games, setGames] = useState<ListedGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listGames()
      .then((next) => {
        if (!cancelled) setGames(next)
      })
      .catch(() => {
        if (!cancelled) setError('We could not reach NimDrops just now.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Field tone="live">
      <div className="nd-column">
        <div className="flex flex-1 flex-col px-5 pt-9 pb-12 text-chalk">
        <h1 className="text-2xl font-semibold tracking-tight">Games you can earn from</h1>
        <p className="mt-2 text-sm leading-relaxed text-chalk/65">
          Each of these asks one thing of you first. Meet it and you claim a share on the
          drop&rsquo;s own page, where you tap and approve one signature.
        </p>

        {games === null && error === null ? <Loading /> : null}
        {error !== null ? (
          <p data-testid="games-error" className="mt-8 text-sm leading-relaxed text-chalk/65">
            {error} Nothing has been lost. This is only a list.
          </p>
        ) : null}
        {games !== null && games.length === 0 ? <Empty /> : null}

        {games !== null && games.length > 0
          ? KIND_ORDER.map((kind) => {
              const group = games.filter((game) => game.kind === kind)
              if (group.length === 0) return null
              return (
                <section key={kind} data-testid={`group-${kind}`} className="mt-10">
                  <h2 className="text-base font-semibold tracking-tight">{KIND_HEADINGS[kind]}</h2>
                  <p className="mt-1 text-xs leading-relaxed text-chalk/55">{KIND_BLURBS[kind]}</p>
                  {kind === 'trivia' ? <ScoreLadder /> : null}
                  <ul className="mt-4 flex flex-col gap-3">
                    {group.map((game) => (
                      <li key={game.publicId}>
                        <GameCard game={game} />
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })
          : null}
        </div>
      </div>
    </Field>
  )
}

/** One drop. Every tier is open to everyone, so no card is ever locked. */
function GameCard({ game }: { game: ListedGame }) {
  const amount = formatNim(BigInt(game.amountEachLuna))

  return (
    <Link
      to={`/game/${game.publicId}`}
      data-testid={`game-${game.publicId}`}
      className="block rounded-2xl border border-chalk/10 bg-(--nd-recess-field) p-4 transition-transform duration-150 ease-out active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chalk/70"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* Exact, never rounded, tabular so a column of them cannot jitter. */}
        <span className="nd-amount nd-num text-2xl">{amount} NIM</span>
        {game.tier ? (
          <span className="rounded-full border border-chalk/15 px-2 py-0.5 text-[0.6875rem] font-medium text-chalk/55">
            {game.tier} · {TIER_DESCRIPTIONS[game.tier] ?? 'open'}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-chalk/55">
        {game.kind === 'trivia' ? 'maximum payout' : 'each'}
      </p>

      {game.hint ? (
        <p
          data-testid={`hint-${game.publicId}`}
          className="mt-3 border-l-2 border-chalk/25 pl-3 text-sm leading-relaxed text-chalk/70"
        >
          {game.hint}
        </p>
      ) : null}

      <div className="mt-3 flex items-end justify-between gap-4">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-chalk/55">
          <span data-testid={`slots-${game.publicId}`}>
            {game.slotsRemaining === null
              ? 'Open'
              : `${game.slotsRemaining} ${game.slotsRemaining === 1 ? 'share' : 'shares'} left`}
          </span>
          {game.expiresAt ? (
            <>
              <span aria-hidden="true" className="text-chalk/25">
                ·
              </span>
              <Expiry expiresAt={game.expiresAt} />
            </>
          ) : null}
        </p>
        <span className="shrink-0 text-xs font-semibold text-chalk/75">
          Play <span aria-hidden="true">→</span>
        </span>
      </div>
    </Link>
  )
}

function ScoreLadder() {
  return (
    <p aria-label="Score payouts" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] tabular-nums text-chalk/60">
      <span><strong className="font-semibold text-chalk/80">3/5</strong> · 60%</span>
      <span><strong className="font-semibold text-chalk/80">4/5</strong> · 80%</span>
      <span><strong className="font-semibold text-chalk/80">5/5</strong> · 100%</span>
    </p>
  )
}

/**
 * Wall-clock, from the server's own `expiresAt`. The same shape the drop page
 * uses, for the same reason: a player does not think in macro blocks, and the
 * expiry timestamp is the only deadline that decides anything.
 */
function Expiry({ expiresAt }: { expiresAt: string }) {
  const remainingMs = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(remainingMs)) return null
  if (remainingMs <= 0) return <span>Ended</span>

  const minutes = Math.floor(remainingMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days >= 1) return <span>Ends in {`${days}d ${hours % 24}h`}</span>
  if (hours >= 1) return <span>Ends in {`${hours}h ${minutes % 60}m`}</span>
  if (minutes >= 1) return <span>Ends in {minutes}m</span>
  return <span>Ends in under a minute</span>
}

function Loading() {
  return (
    <div className="mt-16 flex flex-col items-center">
      <div className="nd-beacon nd-pulse" aria-hidden="true" />
    </div>
  )
}

/**
 * Nothing listed is a truthful answer, not a failure. It says what would make
 * the list fill up, so an empty page does not read as a broken one.
 */
function Empty() {
  return (
    <div data-testid="games-empty" className="mt-12 rounded-2xl border border-chalk/10 bg-(--nd-recess-field) p-4">
      <p className="text-sm leading-relaxed text-chalk/75">There is nothing to earn right now.</p>
      <p className="mt-3 text-sm leading-relaxed text-chalk/60">
        These are put up one at a time, usually around an event, and they end after 24 hours. Nothing
        is wrong with this page.
      </p>
      <Link to="/create" className="nd-quiet mt-6 block w-full text-center">
        Send a NimDrop instead
      </Link>
    </div>
  )
}
