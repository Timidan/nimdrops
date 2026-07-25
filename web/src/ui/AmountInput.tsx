import { useId } from 'react'

/**
 * NIM entry. `inputMode="decimal"` so phones open the numeric keypad, and the
 * value stays a STRING all the way to `lunaFromNim` — parsing it to a `number`
 * would be the one float that quietly loses a user's money.
 */
export interface AmountInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}

export default function AmountInput({ label, value, onChange, hint }: AmountInputProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink/70">
        {label}
      </label>
      <div className="mt-2 flex items-baseline gap-2 rounded-2xl border border-ink/12 bg-white px-4 py-3 focus-within:border-gold">
        <input
          id={id}
          value={value}
          onChange={(event) => {
            // Keep the field honest as it is typed: digits and one dot only.
            const next = event.target.value.replace(/[^\d.]/g, '')
            if (/^\d{0,9}(\.\d{0,5})?$/.test(next)) onChange(next)
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          aria-describedby={hint ? hintId : undefined}
          className="min-w-0 flex-1 bg-transparent text-3xl font-semibold tabular-nums tracking-tight text-ink outline-none placeholder:text-ink/25"
        />
        <span aria-hidden="true" className="text-sm font-semibold text-ink/40">
          NIM
        </span>
      </div>
      {hint ? (
        <p id={hintId} className="mt-2 text-xs text-ink/50">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
