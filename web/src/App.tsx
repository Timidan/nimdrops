import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Create from './pages/Create'
import Drop from './pages/Drop'
import Spike from './pages/Spike'

/**
 * The three routes the server actually serves a shell for (`http/ssr.ts`):
 * `/`, `/create` and `/d/:publicId`. Anything else is a mistyped or stale link,
 * and the useful answer to that is the create screen, not a 404 page.
 *
 * `AppRoutes` is exported without the router so tests can mount it inside a
 * `MemoryRouter` at any path.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Create />} />
      <Route path="/create" element={<Create />} />
      <Route path="/d/:publicId" element={<Drop />} />
      {/* Task 7's on-device provider spike page; dev-only in practice. */}
      <Route path="/spike" element={<Spike />} />
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
