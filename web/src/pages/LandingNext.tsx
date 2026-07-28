/**
 * The landing page, rebuilt: two full-screen sections on glass.
 *
 * Lives at `/next` alongside the current `/` on purpose. The old page has been
 * edited and re-screenshotted enough times that a side-by-side is worth more
 * than another assurance — and if this one is wrong, nothing that works today
 * breaks while it is being fixed.
 *
 * WHAT IT TAKES FROM THE REFERENCE and what it deliberately does not.
 *
 * Taken: the glass system with a masked gradient-stroke edge, an italic display
 * serif against a light body face, full-height sections, word-by-word blur-in,
 * and tight negative tracking on the display line.
 *
 * NOT taken, and this is the load-bearing half: the invented logo wall
 * ("trusted by…" over five brand names nobody has heard of), the fabricated
 * metrics, and the manufactured scarcity. `PRODUCT.md` bans logo walls outright,
 * and the reason is sharper here than taste — this page is read by somebody
 * deciding in about fifteen seconds whether NimDrops is a scam. Invented social
 * proof is the exact thing a scam shows them. An agency page can afford theatre
 * because nobody sends it money.
 *
 * The two glass cards in the hero therefore carry facts a reader can CHECK: the
 * custody address, in full, and a rule enforced by a database constraint rather
 * than promised in prose. That is the same visual slot doing honest work.
 */
import { useRef } from 'react'
import { AnswerReviewIcon, ClockExpiryIcon, CustodyShieldIcon, QuestionMarkIcon } from '../ui/icons'
import AppDoor from '../ui/AppDoor'
import BlurText from '../ui/BlurText'
import Manifold from '../ui/Manifold'
import { GetNimiqPay } from '../ui/OpenInApp'
import { useSectionReveals, useSmoothScroll } from './Landing.motion'
import '../ui/glass.css'
import './LandingNext.css'

/** The custody address, split so it wraps at a group rather than mid-character. */
const CUSTODY_ADDRESS = 'NQ97 EGUS 3JPF ELP3 TR5N 0L6E 4Y4Y GGX4 540G'

const CAPABILITIES: {
  icon: typeof QuestionMarkIcon
  title: string
  tags: string[]
  body: string
}[] = [
  {
    icon: QuestionMarkIcon,
    title: 'Five questions',
    tags: ['Four options', 'One at a time', 'No repeats'],
    body: 'Answer all five and claim the same fixed share as everyone else. Speed and skill change nothing — there is no scoreboard and no multiplier, because the share was decided when the drop was funded.',
  },
  {
    icon: ClockExpiryIcon,
    title: 'A server clock',
    tags: ['Stamped on delivery', 'Not your device'],
    body: 'Each question carries a deadline the server writes when it hands the question over. Reloading the page does not buy time, and a slow connection is not held against you twice.',
  },
  {
    icon: AnswerReviewIcon,
    title: 'An honest review',
    tags: ['Right and wrong', 'Every question'],
    body: 'When the round ends you see each question, what you chose, and whether it was right. Where the answers are already published, you see the right option too.',
  },
]

export default function LandingNext() {
  const page = useRef<HTMLElement>(null)

  useSmoothScroll()
  useSectionReveals(page)

  return (
    <main className="nd-next" ref={page}>
      {/* ---------------------------------------------------------------- hero */}
      <section className="nd-next-hero">
        <div className="nd-next-sky" aria-hidden="true">
          <span className="nd-next-bloom" />
        </div>

        <header className="nd-next-nav">
          <span className="nd-glass-subtle nd-next-mark">
            <span className="nd-display">n</span>
          </span>
          <nav className="nd-glass-subtle nd-next-pill">
            <a href="#how" className="nd-next-navlink">
              How it works
            </a>
            <a href="#play" className="nd-next-navlink">
              Play
            </a>
            <AppDoor to="/games" label="Find a game" tone="primary" className="nd-next-navcta" />
          </nav>
        </header>

        <div className="nd-next-hero-in">
          <p className="nd-glass-subtle nd-next-badge">
            <span className="nd-next-badge-dot" aria-hidden="true" />
            Live on Nimiq mainnet
          </p>

          <BlurText
            as="h1"
            text="Real NIM, from a link or five questions."
            className="nd-display nd-next-h1"
          />

          <p className="nd-next-lede">
            A sponsor funds once and gets one link: a fixed share of NIM for everyone who opens it.
            One share per wallet, first come, first served.
          </p>

          <div className="nd-next-doors">
            <AppDoor to="/games" label="Find a game" tone="primary" />
            <AppDoor to="/create" label="Send a drop" tone="secondary" />
          </div>
          <p className="nd-next-note">Opens in Nimiq Pay. No sign-up.</p>

          {/* Two facts a reader can check, where the reference put two it made up. */}
          <div className="nd-next-cards">
            <div className="nd-glass-subtle nd-next-card">
              <CustodyShieldIcon size={20} />
              <p className="nd-next-card-k">Custody address</p>
              <p className="nd-next-card-v">{CUSTODY_ADDRESS}</p>
              <p className="nd-next-card-n">
                Every drop is funded to this one wallet. Open it in any explorer.
              </p>
            </div>
            <div className="nd-glass-subtle nd-next-card">
              <AnswerReviewIcon size={20} />
              <p className="nd-next-card-k">One share per wallet</p>
              <p className="nd-next-card-v nd-display">1 : 1</p>
              <p className="nd-next-card-n">
                A unique constraint in the database, not a promise in this sentence.
              </p>
            </div>
          </div>
        </div>

        <Manifold className="nd-next-manifold" />
      </section>

      {/* -------------------------------------------------------- capabilities */}
      <section className="nd-next-cap" id="play">
        <p className="nd-next-eyebrow">// Two ways in</p>
        <h2 className="nd-display nd-next-h2" id="how">
          A link, or five questions
        </h2>
        <p className="nd-next-cap-lede">
          Both end at the same place: one fixed share, paid to the wallet that signed.
        </p>

        <div className="nd-next-grid">
          {CAPABILITIES.map(({ icon: Icon, title, tags, body }) => (
            <article key={title} className="nd-glass-subtle nd-next-cap-card nd-rise">
              <div className="nd-next-cap-top">
                <span className="nd-glass-subtle nd-next-cap-icon">
                  <Icon size={20} />
                </span>
                <ul className="nd-next-tags">
                  {tags.map((tag) => (
                    <li key={tag} className="nd-glass-subtle nd-next-tag">
                      {tag}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="nd-next-cap-foot">
                <h3 className="nd-display nd-next-cap-title">{title}</h3>
                <p className="nd-next-cap-body">{body}</p>
              </div>
            </article>
          ))}
        </div>

        <footer className="nd-next-foot">
          <p className="nd-next-foot-line">NimDrops runs inside Nimiq Pay as a mini app.</p>
          <GetNimiqPay />
        </footer>
      </section>
    </main>
  )
}
