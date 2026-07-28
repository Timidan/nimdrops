import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import CloseDrop from './pages/CloseDrop'
import Create from './pages/Create'
import DirectionA from './pages/design/DirectionA'
import DirectionB from './pages/design/DirectionB'
import DirectionC from './pages/design/DirectionC'
import Reveal from './pages/design/Reveal'
import Treatment from './pages/design/Treatments'
import Drop from './pages/Drop'
import Game from './pages/Game'
import Games from './pages/Games'
import Landing from './pages/Landing'
import Preview from './pages/Preview'
import Spike from './pages/Spike'

/**
 * The routes the server actually serves a shell for (`http/ssr.ts`): `/`,
 * `/create`, `/drop/:publicId`, `/drop/:publicId/close`, `/game/:publicId` and
 * `/games`. Anything else is a mistyped or stale link, and the useful answer to
 * that is the create screen, not a 404 page.
 *
 * `/preview` is the envelope's states board and must never ship. The guard is
 * `import.meta.env.DEV`, which Vite substitutes with the literal `false` in a
 * production build; the branch is then dead code and `Preview` is tree-shaken
 * out. The same rule the `MockBridge` lives under, verified the same way — by
 * grepping `web/dist` for the module's sentinel string.
 *
 * `/design/a|b|c` are the three rendered redesign directions and live under the
 * same guard, with their own sentinel (`nd-design-only-surface`) so the same
 * dist grep proves the same thing about them.
 *
 * `AppRoutes` is exported without the router so tests can mount it inside a
 * `MemoryRouter` at any path.
 */
/** Carries the id across, so an old link lands on the drop and not on a form. */
function LegacyDropRedirect() {
  const { publicId } = useParams()
  return <Navigate to={publicId ? `/drop/${publicId}` : '/'} replace />
}

export function AppRoutes() {
  return (
    <Routes>
      {/*
        The root is the landing page, not the create form. It is the only
        surface that works on every platform and the only one meant to be
        found: a stranger who arrives without a link should learn what
        NimDrops is, not be handed a form that asks them to fund something.
        Sponsors reach the form at `/create`.
      */}
      <Route path="/" element={<Landing />} />
      <Route path="/create" element={<Create />} />
      <Route path="/drop/:publicId" element={<Drop />} />
      {/*
        The sponsor's own screen for the drop they funded. A route rather than a
        dialog on the page above it, because closing is irreversible and the
        sentence that says so has to be read before the wallet opens.

        It is not protected here and does not need to be: the server accepts a
        close only from a signature by the address that funded the drop, so an
        uninvited visitor to this URL can read it and get no further.
      */}
      <Route path="/drop/:publicId/close" element={<CloseDrop />} />
      {/*
        The old shape. The server 301s it, so this only catches a client-side
        navigation, but a claim link that dead-ends is somebody not getting
        money that was sent to them — cheap to keep, expensive to have missed.
      */}
      <Route path="/d/:publicId" element={<LegacyDropRedirect />} />
      {/*
        Conditional claims. `/game/:publicId`, not `/g/:publicId` — `/d/` was
        the short thing that fit while the shell was being built and it cost a
        redirect to undo, so a new abbreviation would recreate that debt on day
        one.
      */}
      <Route path="/game/:publicId" element={<Game />} />
      <Route path="/games" element={<Games />} />
      {import.meta.env.DEV ? <Route path="/spike" element={<Spike />} /> : null}
      {import.meta.env.DEV ? <Route path="/preview" element={<Preview />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/a" element={<DirectionA />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/b" element={<DirectionB />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/c" element={<DirectionC />} /> : null}
      {/* Static beats dynamic in the router's own ranking, so this wins over
          `/design/:treatment` below it whatever the order. */}
      {import.meta.env.DEV ? <Route path="/design/reveal" element={<Reveal />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/:treatment" element={<Treatment />} /> : null}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
