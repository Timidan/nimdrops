import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import CloseDrop from './pages/CloseDrop'
import Create from './pages/Create'
import Drop from './pages/Drop'
import Game from './pages/Game'
import Games from './pages/Games'
import Landing from './pages/Landing'
import MyDrops from './pages/MyDrops'

/**
 * The routes the server actually serves a shell for (`http/ssr.ts`): `/`,
 * `/create`, `/my-drops`, `/drop/:publicId`, `/drop/:publicId/close`,
 * `/game/:publicId` and `/games`. Anything else is a mistyped or stale link,
 * and the useful answer to
 * that is the create screen, not a 404 page.
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
      <Route path="/my-drops" element={<MyDrops />} />
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
