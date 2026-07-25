import { useParams } from 'react-router-dom'

/**
 * PLACEHOLDER STUB — Task 16 replaces this file wholesale.
 *
 * Task 15 owns the router, so `/d/:publicId` has to resolve to something today.
 * The real campaign page (sponsor label, fixed amount, remaining count, expiry,
 * and the `useClaim` state machine) is Task 16's deliverable.
 */
export default function Drop() {
  const { publicId = '' } = useParams()
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col justify-center gap-3 bg-paper px-6 text-ink">
      <h1 className="text-2xl font-semibold tracking-tight">NimDrop</h1>
      <p className="text-sm text-ink/60">
        Campaign <code className="rounded bg-ink/6 px-1.5 py-0.5 font-mono text-xs">{publicId}</code>
      </p>
      <p className="text-sm text-ink/60">The claim flow lands in Task 16.</p>
    </main>
  )
}
