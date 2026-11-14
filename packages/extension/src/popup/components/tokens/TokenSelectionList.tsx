import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'

export interface TokenSelectionItem {
  readonly key: string
  readonly symbol: string
  readonly symbolSuffix?: ReactNode
  readonly icon: ReactNode
  readonly subtitle?: string
  readonly subtitleTitle?: string
  readonly balance?: ReactNode
  readonly balanceTitle?: string
  readonly ariaLabel?: string
  readonly title?: string
  readonly disabledReason?: string
}

export function TokenSelectionSearch({
  value,
  onChange,
  placeholder = 'Search tokens',
  ariaLabel,
  className,
  autoFocus
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly ariaLabel: string
  readonly className?: string
  readonly autoFocus?: boolean
}) {
  return (
    <Input
      type="text"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      onChange={event => onChange(event.target.value)}
      className={className}
      autoFocus={autoFocus}
      startContent={<Icon icon="lucide:search" className="text-muted" width={16} height={16} />}
    />
  )
}

export function TokenSelectionList({
  items,
  selectedKey,
  onSelect
}: {
  readonly items: readonly TokenSelectionItem[]
  readonly selectedKey?: string
  readonly onSelect: (key: string) => void
}) {
  if (items.length === 0) return null

  return (
    <div>
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          disabled={Boolean(item.disabledReason)}
          title={item.disabledReason ?? item.title}
          onClick={() => onSelect(item.key)}
          aria-pressed={selectedKey === item.key}
          aria-label={item.ariaLabel}
          className={cn(
            'wallet-interactive flex min-h-[55px] w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-card active:bg-white/10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45',
            selectedKey === item.key && 'bg-primary/[0.08]'
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {item.icon}
            <div className="min-w-0 flex-1">
              <span className={cn('flex min-w-0 items-center', item.symbolSuffix && 'gap-1.5')}>
                <span className="block truncate font-semibold">{item.symbol}</span>
                {item.symbolSuffix}
              </span>
              {item.subtitle && (
                <span className="block truncate text-xs text-muted" title={item.subtitleTitle}>
                  {item.subtitle}
                </span>
              )}
            </div>
          </div>
          {item.balance !== undefined && (
            <div className="min-w-0 max-w-[55%] shrink-0 text-right" title={item.balanceTitle}>
              {item.balance}
            </div>
          )}
          {selectedKey === item.key && (
            <Icon
              icon="lucide:check"
              width={16}
              height={16}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />
          )}
        </button>
      ))}
    </div>
  )
}
