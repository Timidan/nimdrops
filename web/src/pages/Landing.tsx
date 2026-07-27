import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStats, type PublicStats, type StatKey } from '../api'
import {
  ClaimIcon,
  CustodyShieldIcon,
  EnvelopeSealedIcon,
  QuestionMarkIcon,
  RefundReturnIcon,
  ShareIcon,
  WalletIcon,
  type IconComponent,
} from '../ui/icons'
import { NimMark } from '../ui/Nim'
import NimDropsPhotograph from '../ui/NimDropsPhotograph'
import { GetNimiqPay } from '../ui/OpenInApp'
import './Landing.css'

/**
 * The landing page, and the only genuinely responsive surface in the product.
 *
 * Everything else — claim, create, trivia — lives inside the Nimiq Pay WebView
 * on a phone, and answers a browser with an open-in-app gate rather than a
 * degraded wide layout. This page is the exception: it is what someone who has
 * never heard of NimDrops reads, on whatever they happen to be holding, and it
 * has to look deliberate at 320px and at 1440px.
 *
 * ## What it is for
 *
 * One job: explain the product to a stranger. One sponsor funds a drop, N people
 * each claim one fixed, equal share of NIM through a shared link, and whatever
 * nobody claims goes back to the sponsor after 24 hours. The positioning is
 * `docs/submission/description.md` and `PRODUCT.md`; the words below are theirs,
 * tightened, not reinvented.
 *
 * ## The figures, and the rule that governs all of them
 *
 * **No number on this page is ever invented, padded, rounded to look better, or
 * substituted with a placeholder.** Every one is a query result from
 * `GET /api/stats`, and the mainnet pilot is capped, so they are currently tiny.
 * That is the truth and it ships as the truth: for a custodial product, "2 NIM
 * paid to 1 wallet, every transaction on chain" is worth more than a round
 * number nobody can check. The section is designed for small numbers — a ledger
 * with a timestamp, not a wall of metrics — so honesty reads as deliberate.
 *
 * Four states, and they are four different sentences rather than four skins of
 * one:
 *
 *  - **populated / tiny** — the figure, in tabular digits.
 *  - **unavailable** — the statistic exists but this deployment cannot measure
 *    it, and the server says so by NAMING it in `unavailable` and omitting it
 *    from `stats`. Rendered "Not measured yet", NEVER as `0`. `questionsAnswered`
 *    is in exactly this state until the trivia migration lands.
 *  - **absent** — a key the server did not send and did not name. Treated the
 *    same as unavailable, because the alternative is to make a number up.
 *  - **the endpoint is down** — the whole section says so in one line and offers
 *    a retry. No stale cache, no zeros, no empty rows pretending to be data.
 *
 * ## The composition
 *
 * The same field the product is built on: warm near-black, one vermilion bloom
 * as a light source, dark recesses, near-white text, Mulish. Two differences,
 * both deliberate. The bloom does not drift — the drift on a claim screen means
 * "this drop is live and other people are taking shares out of it", and a
 * landing page is not live, so animating it would be decoration. And the light
 * is bounded to the first screen: it rises behind the photographed packet, and
 * the page settles into flat near-black underneath, so five folds of reading do
 * not happen on top of a gradient.
 *
 * Section rhythm changes on purpose. The hero is copy left / object right; the
 * sequence is a rail with beats; the figures are a ledger; the custody section
 * is a heading beside its own prose. Nothing here is four identical cards.
 */

// ---- the figures ------------------------------------------------------------------

interface Row {
  key: StatKey
  icon: IconComponent
  label: string
  /** What this figure counts, for a reader who has not used the product. */
  note: string
}

/**
 * The four counted figures, in the order they are read.
 *
 * `totalPaidOut` is not here: it is the lead entry above them and is drawn with
 * the Nimiq signet rather than an icon from the set, because it is the money and
 * the mark IS its unit.
 */
const ROWS: Row[] = [
  {
    key: 'uniqueWalletsPaid',
    icon: WalletIcon,
    label: 'Wallets paid',
    note: 'Different wallets that have received a payout.',
  },
  {
    key: 'sharesClaimed',
    icon: ClaimIcon,
    label: 'Shares claimed',
    note: 'One per wallet per drop, proved by a signature.',
  },
  {
    key: 'dropsFunded',
    icon: EnvelopeSealedIcon,
    label: 'Drops funded',
    note: 'Drops whose funding was confirmed on the blockchain.',
  },
  {
    key: 'questionsAnswered',
    icon: QuestionMarkIcon,
    label: 'Questions answered',
    note: 'Trivia answers submitted at a gated drop.',
  },
]

type Load = { phase: 'loading' } | { phase: 'ready'; data: PublicStats } | { phase: 'failed' }

/**
 * The value for one row, or the reason there is not one.
 *
 * The distinction this function exists to keep: a figure that is ABSENT from the
 * response is not zero. It is a measurement this deployment cannot take, and the
 * page says that in words. Coercing it to `0` would publish a number the server
 * deliberately refused to publish.
 */
function readFigure(data: PublicStats, key: StatKey): string | null {
  const value = data.stats[key]
  if (typeof value === 'number') return value.toLocaleString('en-GB')
  if (typeof value === 'string') return value
  return null
}

/** UTC, spelled out. A landing page's numbers must carry their own age. */
function stamp(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }).format(at)
}

function Ledger() {
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setLoad({ phase: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    let alive = true
    getStats().then(
      (data) => {
        if (alive) setLoad({ phase: 'ready', data })
      },
      () => {
        if (alive) setLoad({ phase: 'failed' })
      },
    )
    return () => {
      alive = false
    }
  }, [attempt])

  return (
    <section className="nd-land-sec nd-land-figures" aria-labelledby="figures">
      <div className="nd-land-wrap nd-land-figures-in">
        <div className="nd-land-figures-head">
          <h2 id="figures">What has actually happened</h2>
          <p>
            NimDrops is running a capped pilot on Nimiq mainnet, so these are small numbers. Each
            one is a query against the ledger rather than an estimate, and every payment inside them
            is an ordinary Nimiq transaction that anyone can look up.
          </p>
        </div>

        {load.phase === 'failed' ? (
          <div className="nd-panel nd-land-figures-down" data-testid="stats-down">
            <p className="nd-note">
              The live figures are not loading right now. Nothing else on this page depends on them,
              and no number here is filled in when they are missing.
            </p>
            <button type="button" className="nd-textlink" onClick={retry}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <dl
              className="nd-ledger"
              data-testid="stats"
              aria-busy={load.phase === 'loading' ? 'true' : 'false'}
            >
              <div className="nd-ledger-lead" data-stat="totalPaidOut">
                <dt>
                  <NimMark tone="gold" height="1.125rem" />
                  Paid out to claimants
                </dt>
                <dd>
                  {load.phase === 'loading' ? (
                    <Waiting />
                  ) : (
                    <Money nim={readFigure(load.data, 'totalPaidOut')} />
                  )}
                </dd>
                {/* A second `dd` rather than a `p`: only `dt` and `dd` are
                    allowed inside a `dl`'s grouping element. */}
                <dd className="nd-ledger-note">
                  Confirmed on the Nimiq blockchain, not merely sent.
                </dd>
              </div>

              {ROWS.map(({ key, icon: Icon, label, note }) => (
                <div className="nd-ledger-row" key={key} data-stat={key}>
                  <dt>
                    <Icon size={18} />
                    {label}
                  </dt>
                  <dd>
                    {load.phase === 'loading' ? (
                      <Waiting />
                    ) : (
                      <Figure value={readFigure(load.data, key)} />
                    )}
                  </dd>
                  <dd className="nd-ledger-note">{note}</dd>
                </div>
              ))}
            </dl>

            <p className="nd-land-stamp">
              {load.phase === 'loading' ? (
                <span role="status">Reading the figures…</span>
              ) : (
                `Read ${stamp(load.data.generatedAt)} UTC.`
              )}
            </p>
          </>
        )}
      </div>
    </section>
  )
}

/** A figure that is on its way. Not a zero, and not a dash that reads as one. */
function Waiting() {
  return <span className="nd-ledger-wait" aria-hidden="true" />
}

function Figure({ value }: { value: string | null }) {
  if (value === null) return <span className="nd-ledger-none">Not measured yet</span>
  return <b className="nd-num">{value}</b>
}

/** The money keeps its unit. Exact decimal NIM, never abbreviated or rounded. */
function Money({ nim }: { nim: string | null }) {
  if (nim === null) return <span className="nd-ledger-none">Not measured yet</span>
  return (
    <b className="nd-num">
      {nim}
      <span className="nd-ledger-unit"> NIM</span>
    </b>
  )
}

// ---- the page ----------------------------------------------------------------------

const STEPS: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: WalletIcon,
    title: 'Fund it once',
    body: 'Pick the amount each person gets and how many people. One transaction from your own wallet covers all of them.',
  },
  {
    icon: ShareIcon,
    title: 'Send one link',
    body: 'You get a link and a QR code. Put it in the group chat, or on a screen at the event.',
  },
  {
    icon: ClaimIcon,
    title: 'Everyone gets the same',
    body: 'Each person opens the link in Nimiq Pay and approves one signature. The NIM arrives at the wallet that signed. Nobody types an address and nobody pays a fee.',
  },
]

export default function Landing() {
  return (
    <main className="nd-land">
      {/*
        The light, bounded to the first screen. It does not drift: on a claim
        screen the drift means the drop is still moving while you read it, and
        there is nothing moving here. Below this band the page is flat near-black,
        so four folds of reading do not sit on a gradient.
      */}
      <div className="nd-land-sky" aria-hidden="true">
        <span className="nd-land-bloom" />
        <span className="nd-land-counter" />
      </div>
      <span className="nd-field-texture" aria-hidden="true" />

      <header className="nd-land-top">
        <div className="nd-land-wrap nd-land-top-in">
          <p className="nd-land-brand">NimDrops</p>
          <Link to="/create" className="nd-land-topcta">
            Create a drop
          </Link>
        </div>
      </header>

      <section className="nd-land-hero">
        <div className="nd-land-wrap nd-land-hero-in">
          <div className="nd-land-hero-copy">
            <h1 className="nd-land-h1">
              <span className="nd-land-h1-a">One link.</span>
              <span className="nd-land-h1-b">A fixed share of NIM for everyone who opens it.</span>
            </h1>
            <p className="nd-land-lede">
              A sponsor funds a drop once in Nimiq Pay and gets a single link. Everyone who opens it
              signs once and receives the same amount — one share per wallet, first come, first
              served. Whatever nobody claims goes back to the sponsor after 24 hours.
            </p>
            <div className="nd-land-cta">
              <Link to="/create" className="nd-action">
                Create a drop
              </Link>
              <p className="nd-land-ctanote">
                Funding is signed in Nimiq Pay, so this step needs the wallet. There is nothing to
                sign up for.
              </p>
            </div>
          </div>

          {/*
            Decorative, and empty alt so a missing file collapses to nothing
            rather than to a broken-image glyph on the first screen a stranger
            sees. The page reads correctly with or without it.
          */}
          <div className="nd-land-hero-art" aria-hidden="true">
            <NimDropsPhotograph
              variant="packet-cutout"
              alt=""
              priority
              sizes="(max-width: 60rem) 62vw, 26rem"
            />
          </div>
        </div>
      </section>

      <section className="nd-land-sec nd-land-how" aria-labelledby="how">
        <div className="nd-land-wrap nd-land-how-in">
          <div className="nd-land-how-head">
            <h2 id="how">How a drop works</h2>
            <p>
              Three things the sponsor does, and one that happens on its own. One approval becomes
              many outgoing payments, inside a wallet people already have.
            </p>
          </div>

          <div className="nd-land-how-body">
            <ol className="nd-flow">
              {STEPS.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <span className="nd-flow-mark" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ol>

            {/* Not a step: nobody performs it. It is what the clock does. */}
            <div className="nd-flow-after">
              <span className="nd-flow-mark" aria-hidden="true">
                <RefundReturnIcon size={20} />
              </span>
              <h3>Then, 24 hours later</h3>
              <p>
                The drop stops accepting claims and every unclaimed share is refunded to the wallet
                that funded it. The sponsor does not have to come back for it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <Ledger />

      <section className="nd-land-sec nd-land-plain" aria-labelledby="custody">
        <div className="nd-land-wrap">
          <div className="nd-land-plain-in">
            <div className="nd-land-plain-head">
              <span className="nd-land-plain-mark" aria-hidden="true">
                <CustodyShieldIcon size={22} />
              </span>
              <h2 id="custody">Said before you have to ask</h2>
            </div>
            <div className="nd-land-plain-body">
              <p>
                NimDrops holds the NIM between funding and payout. That is custody: not a smart
                contract, and not your wallet. When someone claims, it is sent to the wallet that
                signed and to no other address.
              </p>
              <p>
                A signature proves control of one wallet, not one person, so anyone holding several
                wallets can take several shares. Shares are fixed and equal, which is why there is
                nothing to win by trying.
              </p>
              <p>
                Funding, payouts and refunds are ordinary Nimiq transactions: public, permanent and
                readable by anyone. Payouts wait for the network to confirm them, and nothing here
                says &ldquo;paid&rdquo; before a transaction is final.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="nd-land-foot">
        <div className="nd-land-wrap nd-land-foot-in">
          <div className="nd-land-foot-copy">
            <p className="nd-land-foot-line">
              NimDrops runs inside Nimiq Pay as a mini app. Open it there to fund a drop or to claim
              one.
            </p>
            <Link to="/create" className="nd-quiet nd-land-foot-cta">
              Create a drop
            </Link>
          </div>
          <GetNimiqPay />
        </div>
      </footer>
    </main>
  )
}
