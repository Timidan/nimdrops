import { useId } from 'react'

/**
 * NIM entry, and the largest control on the create sheet.
 *
 * `inputMode="decimal"` so phones open the numeric keypad, and the value stays a
 * STRING all the way to `lunaFromNim` — parsing it to a `number` would be the
 * one float that quietly loses a user's money.
 *
 * The type is 28px, which is over the 16px floor by a wide margin, and that
 * floor is the reason it is stated at all: under 16px iOS zooms the viewport on
 * focus, and a page that zooms while a sponsor is entering an amount moves the
 * number they are checking out from under their thumb. The focus ring belongs to
 * the box rather than to the input, because the input has no visible edge of its
 * own; see `.nd-amountbox` in `index.css`.
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
      <label htmlFor={id} className="nd-lab">
        {label}
      </label>
      <div className="nd-amountbox">
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
        />
        {/* The unit, not the mark: the signet is reserved for the amount lockup
            in the field above, where it is the money rather than a suffix. */}
        <span aria-hidden="true">NIM</span>
      </div>
      {hint ? (
        <p id={hintId} className="nd-hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
