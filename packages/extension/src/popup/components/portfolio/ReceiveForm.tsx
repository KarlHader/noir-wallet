import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/popup/components/common/PageHeader'

export type ReceiveMode = 'public' | 'shield'

export function ReceiveForm({
  mode,
  shieldAvailable,
  onModeChange,
  headerAction,
  children,
  busy,
  disabled,
  onShowAddress
}: {
  readonly mode: ReceiveMode
  readonly shieldAvailable: boolean
  readonly onModeChange: (mode: ReceiveMode) => void
  readonly headerAction?: ReactNode
  readonly children: ReactNode
  readonly busy?: boolean
  readonly disabled: boolean
  readonly onShowAddress: () => void
}) {
  return (
    <div className="page-container min-h-0 overflow-hidden">
      <PageHeader title="Receive" showBack rightContent={headerAction} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-6 pb-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="text-sm text-muted">Receive to</span>
          <div role="group" aria-label="Receive to" className="flex gap-2">
            {(['public', 'shield'] as const).map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                disabled={option === 'shield' && !shieldAvailable}
                onClick={() => onModeChange(option)}
                className={cn(
                  'wallet-interactive h-7 rounded-full border px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45',
                  option === mode
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-wallet-surface text-muted enabled:hover:text-foreground'
                )}
              >
                {option === 'public' ? 'Public' : 'Shield'}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2.5">{children}</div>
      </div>
      <div className="page-footer">
        <button
          type="button"
          onClick={onShowAddress}
          disabled={disabled}
          aria-busy={busy || undefined}
          className="wallet-interactive h-11 w-full rounded-lg bg-primary text-sm font-medium text-background enabled:hover:brightness-110 enabled:active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
        >
          {busy ? 'Generating…' : 'Receiving address'}
        </button>
      </div>
    </div>
  )
}

export function ReceiveField({
  label,
  value,
  icon,
  placeholderIcon,
  disabled,
  onClick
}: {
  readonly label: string
  readonly value?: string
  readonly icon?: ReactNode
  readonly placeholderIcon?: string
  readonly disabled?: boolean
  readonly onClick?: () => void
}) {
  const contents = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md">
        {icon ?? (
          <span className="flex size-full items-center justify-center rounded-md bg-white/10 text-muted">
            <Icon icon={placeholderIcon ?? 'lucide:network'} width={17} height={17} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted">{label}</span>
        {value && <span className="block truncate text-sm">{value}</span>}
      </span>
      <Icon
        icon={onClick ? 'lucide:chevron-down' : 'lucide:lock-keyhole'}
        width={16}
        height={16}
        aria-hidden="true"
        className="shrink-0 text-muted"
      />
    </>
  )
  const className =
    'flex h-[62px] w-full items-center gap-2.5 rounded-xl bg-wallet-surface px-4 text-left'
  return onClick ? (
    <button
      type="button"
      aria-label={value ? `${label}: ${value}` : label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        className,
        'wallet-interactive enabled:hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed'
      )}
    >
      {contents}
    </button>
  ) : (
    <div className={className}>{contents}</div>
  )
}
