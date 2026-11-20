import { cn } from '@/lib/utils'

interface SegmentedToggleProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  /** Options that cannot be chosen right now; the rest stay usable. */
  disabledValues?: readonly T[]
}

/** Compact single-choice switch for two or three short options. */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  disabledValues = []
}: SegmentedToggleProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-disabled={disabled || undefined}
      className="inline-flex gap-1 rounded-full bg-card p-1"
    >
      {options.map(option => {
        const selected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || disabledValues.includes(option.value)}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full px-4 py-1.5 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'bg-popover font-medium text-foreground'
                : 'text-muted enabled:hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
