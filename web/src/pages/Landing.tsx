import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { getStats, type PublicStats, type StatKey } from '../api'
import {
  AnswerReviewIcon,
  ClaimIcon,
  ClockExpiryIcon,
  EnvelopeSealedIcon,
  QuestionMarkIcon,
  FreshQuestionIcon,
  RefundReturnIcon,
  ShareIcon,
  WalletIcon,
  type IconComponent,
} from '../ui/icons'
import { NimMark } from '../ui/Nim'
import NimDropsPhotograph from '../ui/NimDropsPhotograph'
import { GetNimiqPay } from '../ui/OpenInApp'
import AppDoor from '../ui/AppDoor'
import './Landing.css'
import { useSmoothScroll } from './Landing.motion'

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

/** Stagger index for the scroll reveal, and a matching delay for the settle. */
function beat(i: number): CSSProperties {
  return { '--nd-i': i, '--nd-in': `${i * 70}ms` } as CSSProperties
}

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
          <h2 id="figures">Paid out so far</h2>
          <p>Read from the ledger, not estimated.</p>
        </div>

        {load.phase === 'failed' ? (
          <div className="nd-panel nd-land-figures-down" data-testid="stats-down">
            {/* One line, not two sentences of apology. A figure this page cannot
                read is still never invented — it is simply absent. */}
            <p className="nd-note">Figures are not loading.</p>
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
              <div className="nd-ledger-lead nd-rise" data-stat="totalPaidOut" style={beat(0)}>
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

              {ROWS.map(({ key, icon: Icon, label, note }, i) => (
                <div className="nd-ledger-row nd-rise" key={key} data-stat={key} style={beat(i + 1)}>
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

const GATE_FACTS: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: QuestionMarkIcon,
    title: 'Five questions, four options',
    body: 'One at a time, the next after the last is committed.',
  },
  {
    icon: ClockExpiryIcon,
    title: 'A deadline on each',
    body: 'Stamped and timed by the server, not your device.',
  },
  {
    icon: FreshQuestionIcon,
    title: 'Never the same question twice',
    body: 'Never one a wallet has already seen.',
  },
  {
    icon: AnswerReviewIcon,
    title: 'You find out how you did',
    body: 'Afterwards: every question, and whether you got it.',
  },
]

/**
 * The trivia entrance.
 *
 * This section used to carry a "Designed, not running yet" flag and the claim
 * that no answers are given back. Both were true of the first implementation and
 * neither survived it: the gate runs on mainnet, and a finished session returns
 * every question with the player's choice, the verdict, and — for a bank whose
 * answers are already published, which the shipped one is — the right option.
 *
 * A landing page that undersells the feature it exists to explain is worse than
 * one that oversells it, because nobody goes looking for the correction.
 */
function TriviaBeat() {
  return (
    <section className="nd-land-sec nd-land-gate" aria-labelledby="gate">
      <div className="nd-land-wrap nd-land-gate-in">
        <div className="nd-land-gate-head nd-rise">
          <h2 id="gate">Answer five questions</h2>
          <p>
            Some drops hold their share behind five questions. Get them all and the share is the
            same as everyone else&rsquo;s. Twelve hundred questions, four difficulties.
          </p>
        </div>

        <dl className="nd-land-gate-facts">
          {GATE_FACTS.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="nd-rise" style={beat(i)}>
              <dt>
                <Icon size={18} />
                {title}
              </dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>

      </div>
    </section>
  )
}

const STEPS: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: WalletIcon,
    title: 'Fund it once',
    body: 'Pick the amount each person gets, and how many people. One transaction covers all.',
  },
  {
    icon: ShareIcon,
    title: 'Send one link',
    body: 'You get a link and a QR code. Put it in the group chat, or on a screen.',
  },
  {
    icon: ClaimIcon,
    title: 'Everyone gets the same',
    body: 'They open it in Nimiq Pay and approve. The NIM lands in the wallet that signed. No address, no fee.',
  },
]

export default function Landing() {
  const { load, retry } = useStats()

  // ONLY Lenis. The entrance and the section reveals are deliberately not
  // wired, and this is the second time that lesson has been paid for.
  //
  // `Landing.css` already animates this page: `.nd-arrive` has its own keyframes
  // and `.nd-rise` runs on `animation-timeline: view()`. Pointing GSAP at the
  // same two class names put two systems on one element, and a running CSS
  // animation outranks an inline transform — so the hero overlapped itself, the
  // reveals stopped reading as reveals, and at one point the entrance left the
  // page with no visible call to action at all.
  //
  // The hooks are kept and tested for a surface that has no CSS animation of its
  // own. Adding motion to a page that already has some is not additive.
  useSmoothScroll()

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
          <span
            className="nd-arrive"
            style={{ '--nd-in': '70ms', display: 'inline-block' } as CSSProperties}
          >
            <AppDoor to="/games" label="Find a game" tone="secondary" />
          </span>
        </div>
      </header>

      <section className="nd-land-hero">
        <div className="nd-land-wrap nd-land-hero-in">
          <div className="nd-land-hero-copy">
            <h1 className="nd-land-h1">
              <span
                className="nd-land-h1-a nd-arrive"
                style={{ '--nd-in': '150ms' } as CSSProperties}
              >
                Real NIM.
              </span>
              {/* Both entrances in the headline, because the page is read by
                  people who have a link and by people who have neither a link
                  nor any NIM to give away. */}
              <span
                className="nd-land-h1-b nd-arrive"
                style={{ '--nd-in': '260ms' } as CSSProperties}
              >
                From a link, or from five questions.
              </span>
            </h1>
            <p className="nd-land-lede nd-arrive" style={{ '--nd-in': '370ms' } as CSSProperties}>
              A sponsor funds once and gets one link: a fixed share of NIM for everyone who opens
              it. One share per wallet, first come, first served.
            </p>
            {/* Two doors, and the earning one leads. This page exists for
                somebody who arrived WITHOUT a link, and that person
                has no NIM to give away — so "fund a giveaway" is the wrong first
                ask. Both are deeplinks: the page is a web explainer whose job is
                to hand the visitor to the mini app. */}
            <div className="nd-land-cta nd-arrive" style={{ '--nd-in': '470ms' } as CSSProperties}>
              <div className="nd-land-doors">
                <AppDoor to="/games" label="Find a game" tone="primary" />
                <AppDoor to="/create" label="Send a drop" tone="secondary" />
              </div>
              <p className="nd-land-ctanote">Opens in Nimiq Pay. No sign-up.</p>
            </div>
          </div>

          <div className="nd-land-hero-art" aria-hidden="true">
            {/* Two spans: the outer arrives, the inner floats. One element
                cannot hold both transforms. */}
            <span
              className="nd-land-packet nd-arrive"
              style={{ '--nd-in': '140ms' } as CSSProperties}
            >
              <span className="nd-land-packet-float">
                <NimDropsPhotograph
                  variant="packet-cutout"
                  alt=""
                  priority
                  sizes="(max-width: 60rem) 62vw, 26rem"
                />
                <span className="nd-land-glint" />
              </span>
            </span>
          </div>
        </div>
      </section>

      <section className="nd-land-sec nd-land-how" aria-labelledby="how">
        <div className="nd-land-wrap nd-land-how-in">
          <div className="nd-land-how-head nd-rise">
            <h2 id="how">How a drop works</h2>
            <p>Three things the sponsor does. One the clock does.</p>
          </div>

          <div className="nd-land-how-body">
            <ol className="nd-flow">
              {STEPS.map(({ icon: Icon, title, body }, i) => (
                <li key={title} className="nd-rise" style={beat(i)}>
                  <span className="nd-flow-mark" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ol>

            <div className="nd-flow-after nd-rise" style={beat(3)}>
              <span className="nd-flow-mark" aria-hidden="true">
                <RefundReturnIcon size={20} />
              </span>
              <h3>Then, when the window closes</h3>
              <p>
                Whatever nobody claims goes back to the sponsor when the claim window closes. The
                sponsor sets it when funding, from an hour to two weeks: 24 hours unless they change
                it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <TriviaBeat />

      <Ledger load={load} retry={retry} />

      <footer className="nd-land-foot">
        <div className="nd-land-wrap nd-land-foot-in">
          <div className="nd-land-foot-copy">
            <p className="nd-land-foot-line">NimDrops runs inside Nimiq Pay as a mini app.</p>
            <AppDoor to="/create" label="Send a drop" tone="secondary" />
            <AppDoor to="/my-drops" label="Manage my drops" tone="secondary" />
          </div>
          <GetNimiqPay />
        </div>
      </footer>
    </main>
  )
}
