import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { getStats, type PublicStats, type StatKey } from '../api'
import {
  ClaimIcon,
  ClockExpiryIcon,
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

interface Row {
  key: StatKey
  icon: IconComponent
  label: string
  note: string
}

const ROWS: Row[] = [
  {
    key: 'uniqueWalletsPaid',
    icon: WalletIcon,
    label: 'Wallets paid',
    note: 'Wallets that have received a payout.',
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
    note: 'Funding confirmed on chain.',
  },
  {
    key: 'questionsAnswered',
    icon: QuestionMarkIcon,
    label: 'Questions answered',
    note: 'Answers submitted at a gated drop.',
  },
]

type Load = { phase: 'loading' } | { phase: 'ready'; data: PublicStats } | { phase: 'failed' }

/** Null means the server did not measure this. Never coerce it to 0. */
function readFigure(data: PublicStats, key: StatKey): string | null {
  const value = data.stats[key]
  if (typeof value === 'number') return value.toLocaleString('en-GB')
  if (typeof value === 'string') return value
  return null
}

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

function useStats(): { load: Load; retry: () => void } {
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

  return { load, retry }
}

function Ledger({ load, retry }: { load: Load; retry: () => void }) {
  return (
    <section className="nd-land-sec nd-land-figures" aria-labelledby="figures">
      <div className="nd-land-wrap nd-land-figures-in">
        <div className="nd-land-figures-head nd-rise">
          <h2 id="figures">What has actually happened</h2>
          <p>
            A capped pilot on Nimiq mainnet, so these are small. Each is a query against the ledger,
            not an estimate.
          </p>
        </div>

        {load.phase === 'failed' ? (
          <div className="nd-panel nd-land-figures-down" data-testid="stats-down">
            <p className="nd-note">
              The live figures are not loading right now. No number here is filled in when they are
              missing.
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
                {/* A `dd`, not a `p`: a `dl` group admits only `dt` and `dd`. */}
                <dd className="nd-ledger-note">Confirmed on chain, not merely sent.</dd>
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

function Waiting() {
  return <span className="nd-ledger-wait" aria-hidden="true" />
}

function Figure({ value }: { value: string | null }) {
  if (value === null) return <span className="nd-ledger-none nd-settle">Not measured yet</span>
  return <b className="nd-num nd-settle">{value}</b>
}

function Money({ nim }: { nim: string | null }) {
  if (nim === null) return <span className="nd-ledger-none nd-settle">Not measured yet</span>
  return (
    <b className="nd-num nd-settle">
      {nim}
      <span className="nd-ledger-unit"> NIM</span>
    </b>
  )
}

/**
 * Trivia is not built. `questionsAnswered` is absent until the `trivia_answers`
 * table exists, so gating on it is what stops this section describing a feature
 * that is not running. Gate on presence, not on a positive count.
 */
function TriviaBeat({ load }: { load: Load }) {
  if (load.phase !== 'ready') return null
  if (readFigure(load.data, 'questionsAnswered') === null) return null

  return (
    <section className="nd-land-sec nd-land-gate" aria-labelledby="gate">
      <div className="nd-land-wrap nd-land-gate-in">
        <div className="nd-land-gate-head nd-rise">
          <h2 id="gate">Some drops ask first</h2>
          <p>
            A sponsor can put five questions in front of the share. Answer all five and you claim
            the same fixed amount as everyone else.
          </p>
        </div>

        <dl className="nd-land-gate-facts">
          <div className="nd-rise">
            <dt>
              <QuestionMarkIcon size={18} />
              Five questions, four options
            </dt>
            <dd>One at a time. The next one arrives only after the last is committed.</dd>
          </div>
          <div className="nd-rise">
            <dt>
              <ClockExpiryIcon size={18} />
              Fifteen seconds each
            </dt>
            <dd>The deadline is stamped and timed by the server, not by your device.</dd>
          </div>
          <div className="nd-rise">
            <dt>
              <CustodyShieldIcon size={18} />
              No answers given back
            </dt>
            <dd>
              You are told that a run failed, never which answer was wrong. You can try again.
            </dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

const STEPS: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: WalletIcon,
    title: 'Fund it once',
    body: 'Pick the amount each person gets, and how many people. One transaction covers all of them.',
  },
  {
    icon: ShareIcon,
    title: 'Send one link',
    body: 'You get a link and a QR code. Put it in the group chat, or on a screen.',
  },
  {
    icon: ClaimIcon,
    title: 'Everyone gets the same',
    body: 'They open it in Nimiq Pay and approve. The NIM lands in the wallet that signed. No address to type, no fee.',
  },
]

export default function Landing() {
  const { load, retry } = useStats()

  return (
    <main className="nd-land">
      <div className="nd-land-sky" aria-hidden="true">
        <span className="nd-land-bloom" />
        <span className="nd-land-counter" />
      </div>
      <span className="nd-field-texture" aria-hidden="true" />

      <header className="nd-land-top">
        <div className="nd-land-wrap nd-land-top-in">
          <p className="nd-land-brand nd-arrive" style={{ '--nd-in': '0ms' } as CSSProperties}>
            NimDrops
          </p>
          <Link
            to="/create"
            className="nd-land-topcta nd-arrive"
            style={{ '--nd-in': '40ms' } as CSSProperties}
          >
            Create a drop
          </Link>
        </div>
      </header>

      <section className="nd-land-hero">
        <div className="nd-land-wrap nd-land-hero-in">
          <div className="nd-land-hero-copy">
            <h1 className="nd-land-h1">
              <span
                className="nd-land-h1-a nd-arrive"
                style={{ '--nd-in': '80ms' } as CSSProperties}
              >
                One link.
              </span>
              <span
                className="nd-land-h1-b nd-arrive"
                style={{ '--nd-in': '160ms' } as CSSProperties}
              >
                A fixed share of NIM for everyone who opens it.
              </span>
            </h1>
            <p className="nd-land-lede nd-arrive" style={{ '--nd-in': '240ms' } as CSSProperties}>
              A sponsor funds once in Nimiq Pay and gets one link. Everyone who opens it signs and
              gets the same amount: one share per wallet, first come, first served.
            </p>
            <div className="nd-land-cta nd-arrive" style={{ '--nd-in': '320ms' } as CSSProperties}>
              <Link to="/create" className="nd-action">
                Create a drop
              </Link>
              <p className="nd-land-ctanote">Signed in Nimiq Pay. Nothing to sign up for.</p>
            </div>
          </div>

          <div className="nd-land-hero-art" aria-hidden="true">
            {/* Two spans: the outer arrives, the inner floats. One element
                cannot hold both transforms. */}
            <span
              className="nd-land-packet nd-arrive"
              style={{ '--nd-in': '120ms' } as CSSProperties}
            >
              <span className="nd-land-packet-float">
                <NimDropsPhotograph
                  variant="packet-cutout"
                  alt=""
                  priority
                  sizes="(max-width: 60rem) 62vw, 26rem"
                />
              </span>
            </span>
          </div>
        </div>
      </section>

      <section className="nd-land-sec nd-land-how" aria-labelledby="how">
        <div className="nd-land-wrap nd-land-how-in">
          <div className="nd-land-how-head nd-rise">
            <h2 id="how">How a drop works</h2>
            <p>Three things the sponsor does, and one the clock does.</p>
          </div>

          <div className="nd-land-how-body">
            <ol className="nd-flow">
              {STEPS.map(({ icon: Icon, title, body }) => (
                <li key={title} className="nd-rise">
                  <span className="nd-flow-mark" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ol>

            <div className="nd-flow-after nd-rise">
              <span className="nd-flow-mark" aria-hidden="true">
                <RefundReturnIcon size={20} />
              </span>
              <h3>Then, when the window closes</h3>
              <p>
                Whatever nobody claims goes back to the sponsor when the claim window closes. The
                sponsor sets that window when funding, from an hour to two weeks. It is 24 hours
                unless they change it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <TriviaBeat load={load} />

      <Ledger load={load} retry={retry} />

      <section className="nd-land-sec nd-land-plain" aria-labelledby="custody">
        <div className="nd-land-wrap">
          <div className="nd-land-plain-in nd-rise">
            <div className="nd-land-plain-head">
              <span className="nd-land-plain-mark" aria-hidden="true">
                <CustodyShieldIcon size={22} />
              </span>
              <h2 id="custody">Said before you have to ask</h2>
            </div>
            <div className="nd-land-plain-body">
              <p className="nd-land-plain-lead">
                NimDrops holds the NIM between funding and payout. That is custody: not a smart
                contract, and not your wallet.
              </p>
              {/* Shortening moved these behind a summary. Removing any of them
                  deletes a custody fact. */}
              <details className="nd-land-plain-more">
                <summary>What that means in practice</summary>
                <div className="nd-land-plain-detail">
                  <p>
                    When someone claims, the NIM is sent to the wallet that signed and to no other
                    address.
                  </p>
                  <p>
                    A signature proves control of one wallet, not one person, so anyone holding
                    several wallets can take several shares. Shares are fixed and equal, which is
                    why there is nothing to win by trying.
                  </p>
                  <p>
                    Funding, payouts and refunds are ordinary Nimiq transactions: public, permanent
                    and readable by anyone. Nothing here says &ldquo;paid&rdquo; before the network
                    has confirmed it.
                  </p>
                </div>
              </details>
            </div>
          </div>
        </div>
      </section>

      <footer className="nd-land-foot">
        <div className="nd-land-wrap nd-land-foot-in">
          <div className="nd-land-foot-copy">
            <p className="nd-land-foot-line">NimDrops runs inside Nimiq Pay as a mini app.</p>
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
