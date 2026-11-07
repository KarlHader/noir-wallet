import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'

import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/popup/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'

export function PrivateExecutionIcon({
  size = 16,
  className,
  ariaLabel
}: {
  readonly size?: number
  readonly className?: string
  readonly ariaLabel?: string
}) {
  return (
    <Icon
      icon="solar:incognito-outline"
      width={size}
      height={size}
      className={className}
      aria-label={ariaLabel}
    />
  )
}

export function PrivateExecutionModeIconButton({
  mode,
  ariaLabel,
  title,
  busy = false,
  disabled = false,
  onClick
}: {
  readonly mode: DAppExecutionMode
  readonly ariaLabel: string
  readonly title: string
  readonly busy?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
}) {
  const privateMode = mode === 'private'

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-busy={busy}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-50',
        privateMode
          ? 'bg-private/10 text-private hover:bg-private/15'
          : 'bg-card/60 text-foreground/70 hover:bg-accent hover:text-foreground'
      )}
    >
      <PrivateExecutionIcon size={18} />
      <span
        aria-hidden="true"
        className={cn(
          'absolute right-0.5 top-0.5 size-1.5 rounded-full ring-2 ring-background',
          privateMode ? 'bg-private' : 'bg-muted/50'
        )}
      />
    </button>
  )
}

export function AccountAddressSelectorButton({
  mode,
  address,
  ariaLabel,
  showModeBadge = false,
  className,
  disabled = false,
  onClick
}: {
  readonly mode: DAppExecutionMode | 'custom'
  readonly address?: string
  readonly ariaLabel: string
  readonly showModeBadge?: boolean
  readonly className?: string
  readonly disabled?: boolean
  readonly onClick: () => void
}) {
  return (
    <Tooltip
      content={mode === 'private' ? 'Private' : mode === 'custom' ? 'Custom address' : 'Public'}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-[13px] transition-colors hover:text-primary disabled:opacity-50',
          className
        )}
      >
        <span className="truncate font-mono" title={address}>
          {address ? formatSortAddress(address) : mode === 'custom' ? 'Custom address' : 'Wallet'}
        </span>
        {showModeBadge && mode !== 'custom' ? (
          <ExecutionAccountBadge mode={mode} />
        ) : mode === 'private' ? (
          <PrivateExecutionIcon size={14} className="shrink-0 text-private" />
        ) : null}
        <Icon icon="lucide:chevron-down" width={13} height={13} className="shrink-0 text-muted" />
      </button>
    </Tooltip>
  )
}

export function ExecutionAccountIcon({
  mode,
  size = 16,
  className
}: {
  readonly mode: DAppExecutionMode
  readonly size?: number
  readonly className?: string
}) {
  return mode === 'private' ? (
    <PrivateExecutionIcon size={size} className={className} />
  ) : (
    <Icon icon="lucide:wallet" width={size} height={size} className={className} />
  )
}

export function ExecutionAccountBadge({
  mode,
  iconOnly = false,
  className
}: {
  readonly mode: DAppExecutionMode
  readonly iconOnly?: boolean
  readonly className?: string
}) {
  const label = mode === 'private' ? 'Private' : 'Public'
  const badge = (
    <span
      aria-label={iconOnly ? label : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md',
        iconOnly ? 'size-5' : 'gap-1 px-1.5 py-0.5 text-[10px] font-medium leading-4',
        mode === 'private' ? 'bg-private/12 text-private' : 'bg-white/7 text-muted',
        className
      )}
    >
      <ExecutionAccountIcon mode={mode} size={iconOnly ? 13 : 11} />
      {!iconOnly && label}
    </span>
  )
  return iconOnly ? <Tooltip content={label}>{badge}</Tooltip> : badge
}

interface ExecutionAccountOption {
  readonly mode: DAppExecutionMode
  readonly address?: string
  readonly balance?: string
}

export function ExecutionAccountOptionRow({
  mode,
  selected,
  disabled = false,
  locked = disabled,
  label,
  address,
  unavailableLabel = 'Address unavailable',
  detail,
  ariaLabel,
  onClick
}: {
  readonly mode: DAppExecutionMode
  readonly selected: boolean
  readonly disabled?: boolean
  readonly locked?: boolean
  readonly label: string
  readonly address?: string
  readonly unavailableLabel?: string
  readonly detail?: ReactNode
  readonly ariaLabel?: string
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-[62px] w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
        selected
          ? mode === 'private'
            ? 'border-private/40 bg-private/8'
            : 'border-primary/40 bg-primary/8'
          : 'border-border/60 bg-card/45 hover:border-primary/25',
        disabled && 'cursor-not-allowed opacity-45'
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl',
          selected
            ? mode === 'private'
              ? 'bg-private/15 text-private'
              : 'bg-primary/15 text-primary'
            : 'bg-white/6 text-muted'
        )}
      >
        {locked ? (
          <Icon icon="lucide:lock" width={17} height={17} />
        ) : (
          <ExecutionAccountIcon mode={mode} size={17} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted" title={address}>
          {address ? formatSortAddress(address) : unavailableLabel}
        </span>
      </span>
      {detail}
      <Icon
        icon={selected ? 'lucide:circle-check' : 'lucide:circle'}
        width={17}
        height={17}
        className={cn(
          'shrink-0',
          selected ? (mode === 'private' ? 'text-private' : 'text-primary') : 'text-muted/45'
        )}
      />
    </button>
  )
}

export function ExecutionAccountSelectorDialog({
  open,
  onOpenChange,
  value,
  onSelect,
  privateAvailable,
  mainAddress,
  privateAddress,
  mainBalance,
  privateBalance,
  symbol,
  purpose = 'source',
  onCustomAddress,
  onFundPrivate
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly value: DAppExecutionMode | 'custom'
  readonly onSelect: (mode: DAppExecutionMode) => void
  readonly privateAvailable: boolean
  readonly mainAddress?: string
  readonly privateAddress?: string
  readonly mainBalance?: string
  readonly privateBalance?: string
  readonly symbol?: string
  readonly purpose?: 'source' | 'destination'
  readonly onCustomAddress?: () => void
  readonly onFundPrivate?: () => void
}) {
  const options: readonly ExecutionAccountOption[] = [
    { mode: 'main', address: mainAddress, balance: mainBalance },
    { mode: 'private', address: privateAddress, balance: privateBalance }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="bottom" className="gap-0 p-0" showCloseButton>
        <DialogHeader className="px-5 pb-4 pt-5">
          <DialogTitle className="text-center">Choose {purpose} account</DialogTitle>
          <DialogDescription className="sr-only">
            Choose an account for this action
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label={`${purpose === 'source' ? 'Source' : 'Destination'} account`}
          className="space-y-2 px-4 pb-5"
        >
          {options.map(option => {
            const selected = value === option.mode
            const disabled = option.mode === 'private' && !privateAvailable
            return (
              <ExecutionAccountOptionRow
                key={option.mode}
                mode={option.mode}
                selected={selected}
                disabled={disabled}
                label={option.mode === 'private' ? 'Private account' : 'Public account'}
                address={option.address}
                unavailableLabel={disabled ? 'Not available' : 'Address unavailable'}
                onClick={() => {
                  if (selected) {
                    onOpenChange(false)
                    return
                  }
                  onSelect(option.mode)
                  onOpenChange(false)
                }}
                detail={
                  option.balance !== undefined && (
                    <span className="max-w-[38%] shrink-0 text-right">
                      <span
                        className="block break-all font-mono text-[11px] text-muted"
                        title={option.balance}
                      >
                        {formatTokenQuantity(option.balance)} {symbol}
                      </span>
                    </span>
                  )
                }
              />
            )
          })}
          {onCustomAddress && (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/45 px-3.5 py-3 text-sm hover:border-primary/25"
              onClick={() => {
                onOpenChange(false)
                onCustomAddress()
              }}
            >
              <Icon icon="lucide:map-pin" width={17} height={17} />
              Custom address
            </button>
          )}
          {privateAvailable && onFundPrivate && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onFundPrivate()
              }}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium text-private transition-colors hover:bg-private/10"
            >
              <Icon icon="lucide:plus" width={15} height={15} />
              Transfer to Private
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
