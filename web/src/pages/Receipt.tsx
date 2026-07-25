/**
 * PLACEHOLDER STUB — Task 16 replaces this file wholesale.
 *
 * The paid receipt (amount, recipient, explorer link, "Drop one back") belongs
 * to the claim flow. It exists here only so Task 16 has the file it owns and so
 * nothing imports a module that does not exist yet.
 */
export interface ReceiptProps {
  publicId: string
}

export default function Receipt({ publicId }: ReceiptProps) {
  return (
    <section className="text-sm text-ink/60">
      Receipt for <code className="font-mono text-xs">{publicId}</code> — the claim flow lands in Task 16.
    </section>
  )
}
