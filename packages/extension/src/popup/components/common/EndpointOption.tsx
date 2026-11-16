import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'

export function EndpointOption({
  label,
  url,
  selected,
  disabled,
  onClick,
  children,
  ariaLabel
}: {
  readonly label: string
  readonly url: string
  readonly selected: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children?: ReactNode
  readonly ariaLabel: string
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed',
        selected ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:border-primary/30'
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate font-mono text-[11px] text-muted">
          {url.replace(/^https?:\/\//, '')}
        </p>
      </div>
      {children}
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          selected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border text-transparent'
        )}
      >
        <Icon icon="lucide:check" className="size-3" />
      </span>
    </button>
  )
}
