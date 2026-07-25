/**
 * Placeholder shell. Task 15 owns the real router; until then a path check is
 * enough to reach the Task 7 spike page.
 */
import Spike from './pages/Spike'

function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-4 p-6 text-neutral-900">
      <h1 className="text-2xl font-semibold tracking-tight">NimDrops</h1>
      <p className="text-sm text-neutral-600">
        Fixed-share NIM campaign links for Nimiq Pay. The app screens land here in a later task.
      </p>
      <a className="text-sm font-medium underline underline-offset-4" href="/spike">
        Device spike page
      </a>
    </main>
  )
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/'
  const { hash, pathname } = window.location
  return hash.startsWith('#/') ? hash.slice(1) : pathname
}

export default function App() {
  return currentPath().replace(/(.)\/+$/, '$1') === '/spike' ? <Spike /> : <Home />
}
