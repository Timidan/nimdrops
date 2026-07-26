import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Create from './pages/Create'
import DirectionA from './pages/design/DirectionA'
import DirectionB from './pages/design/DirectionB'
import DirectionC from './pages/design/DirectionC'
import Drop from './pages/Drop'
import Preview from './pages/Preview'
import Spike from './pages/Spike'

/**
 * The three routes the server actually serves a shell for (`http/ssr.ts`):
 * `/`, `/create` and `/d/:publicId`. Anything else is a mistyped or stale link,
 * and the useful answer to that is the create screen, not a 404 page.
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
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Create />} />
      <Route path="/create" element={<Create />} />
      <Route path="/d/:publicId" element={<Drop />} />
      {/* Task 7's on-device provider spike page; dev-only in practice. */}
      <Route path="/spike" element={<Spike />} />
      {import.meta.env.DEV ? <Route path="/preview" element={<Preview />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/a" element={<DirectionA />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/b" element={<DirectionB />} /> : null}
      {import.meta.env.DEV ? <Route path="/design/c" element={<DirectionC />} /> : null}
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
