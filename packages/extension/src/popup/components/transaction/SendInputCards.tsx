import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import { formatTokenQuantity } from '@/lib/number-format'
import { formatSendFiatValue } from './send-input-model'
import { cn } from '@/lib/utils'
import { TokenIcon } from '../tokens/TokenIcon'
import { Input } from '../ui/input'
import { BalanceHelp } from './BalanceHelp'
import { safeBig } from '@/lib/big'

export function SendRecipientInputCard({
  id,
  value,
  onChange,
  placeholder,
  label = 'Send to',
  variant = 'outline',
  invalid = false,
  autoFocus = false,
  onSelectRecipient
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly label?: string
  readonly variant?: 'outline' | 'filled'
  readonly invalid?: boolean
  readonly autoFocus?: boolean
  readonly onSelectRecipient?: () => void
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block px-1 text-xs font-medium text-foreground/80">
        {label}
      </label>
      <Input
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        className={cn(
          'pr-16 font-mono text-sm shadow-none focus-visible:ring-0',
          variant === 'filled'
            ? 'h-[46px] rounded-xl border-0 bg-card pl-3 pr-12'
            : 'h-14 rounded-2xl border-white/35 bg-transparent pl-4 focus-visible:border-white/60'
        )}
        endContent={
          onSelectRecipient ? (
            <button
              type="button"
              aria-label="Select Recipient"
              title="Select Recipient"
              onClick={onSelectRecipient}
              className={cn(
                'flex size-10 items-center justify-center rounded-xl text-foreground transition-colors',
                variant === 'filled'
                  ? 'bg-transparent hover:text-primary'
                  : 'bg-white/10 hover:bg-white/15'
              )}
            >
              <Icon icon="lucide:book-user" width={22} height={22} />
            </button>
          ) : undefined
        }
        classNames={{ endContent: variant === 'filled' ? 'right-[3px]' : 'right-3' }}
      />
    </div>
  )
}

export function SendAmountInputCard({
  ariaLabel,
  value,
  onChange,
  available,
  availableLabel = 'Available',
  symbol,
  priceUsd,
  onMax,
  maxDisabled = false,
  maxLoading = false,
  maxSelected = false,
  invalid = false,
  error,
  pending,
  showBalanceHelp = false,
  headerAction,
  title,
  testId
}: {
  readonly ariaLabel: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly available: string
  readonly availableLabel?: 'Available' | 'Balance'
  readonly symbol: string
  readonly priceUsd?: string | number | null
  readonly onMax?: () => void
  readonly maxDisabled?: boolean
  readonly maxLoading?: boolean
  readonly maxSelected?: boolean
  readonly invalid?: boolean
  readonly error?: string
  readonly pending?: string
  readonly showBalanceHelp?: boolean
  readonly headerAction?: ReactNode
  readonly title?: string
  readonly testId?: string
}) {
  const amountFiat = formatSendFiatValue(value, priceUsd)
  const availableFiat = formatSendFiatValue(available, priceUsd)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-foreground/80">Amount</span>
        {headerAction}
      </div>
      <div
        data-testid={testId ?? 'send-amount-card'}
        title={title}
        className={cn(
          'min-h-[92px] rounded-2xl border px-4 py-3 transition-colors focus-within:border-white/60',
          invalid ? 'border-warning' : 'border-white/35'
        )}
      >
        <div className="flex min-h-8 items-center justify-between gap-3">
          <input
            aria-label={ariaLabel}
            inputMode="decimal"
            value={value}
            aria-invalid={invalid || undefined}
            aria-describedby={error ? `${testId ?? 'send-amount-card'}-error` : undefined}
            onChange={event => onChange(event.target.value)}
            placeholder="0"
            className="min-w-0 flex-1 bg-transparent font-mono text-2xl text-foreground outline-none placeholder:text-muted/45"
          />
          {onMax && (
            <button
              type="button"
              aria-label="Max"
              aria-pressed={maxSelected}
              onClick={onMax}
              disabled={maxDisabled || maxLoading}
              className={cn(
                'flex h-8 min-w-12 items-center justify-center rounded-full bg-white/12 px-3 text-sm text-foreground transition-colors hover:bg-white/18 disabled:pointer-events-none disabled:opacity-40',
                maxSelected && 'bg-primary/15 text-primary'
              )}
            >
              {maxLoading ? (
                <Icon icon="lucide:loader-circle" width={15} height={15} className="animate-spin" />
              ) : (
                'Max'
              )}
            </button>
          )}
        </div>
        <div className="mt-3 flex min-w-0 items-center justify-between gap-3 text-xs leading-4">
          <span className="shrink-0 text-muted">{amountFiat ? `~${amountFiat}` : '—'}</span>
          <div className="min-w-0 text-right text-muted">
            <div className="flex min-w-0 items-center justify-end gap-1">
              <span className="min-w-0 break-all" title={available}>
                {availableLabel}{' '}
                <strong className="font-semibold text-foreground">
                  {formatTokenQuantity(available)}
                </strong>{' '}
                {symbol}
                {availableFiat ? ` (${availableFiat})` : ''}
              </span>
              {showBalanceHelp && <BalanceHelp kind="available" />}
            </div>
            {pending != null && safeBig(pending).gt(0) && (
              <div className="mt-0.5 flex min-w-0 items-center justify-end gap-1 text-[11px]">
                <span className="min-w-0 break-all" title={pending}>
                  {formatTokenQuantity(pending)} {symbol} pending
                </span>
                <BalanceHelp kind="pending" />
              </div>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p
          id={`${testId ?? 'send-amount-card'}-error`}
          className="px-1 text-xs text-warning"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  )
}

export function SendAssetHeader({
  assetId,
  symbol,
  icon,
  networkName,
  nativeChain,
  blockchain
}: {
  readonly assetId?: string
  readonly symbol: string
  readonly icon?: string
  readonly networkName: string
  readonly nativeChain?: 'zcash' | 'bitcoin' | 'solana' | 'near'
  readonly blockchain?: string
}) {
  return (
    <div
      data-testid="send-asset-header"
      className="flex flex-col items-center pb-0.5 pt-0.5 text-center"
    >
      <TokenIcon
        assetId={assetId}
        symbol={symbol}
        icon={icon}
        nativeChain={nativeChain}
        blockchain={blockchain}
        size={48}
      />
      <p className="mt-2 text-base font-semibold leading-5">{symbol}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted">{networkName}</p>
    </div>
  )
}

export function SendNetworkFeeCard({
  label = 'Network fee',
  loading = false,
  children
}: {
  readonly label?: string
  readonly loading?: boolean
  readonly children: ReactNode
}) {
  return (
    <div
      data-testid="send-network-fee"
      className="flex min-h-12 items-center justify-between gap-4 rounded-xl bg-card/45 px-4 py-3"
    >
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5 text-right text-xs font-medium">
        {loading && (
          <Icon
            icon="lucide:loader-circle"
            width={14}
            height={14}
            className="shrink-0 animate-spin text-muted"
          />
        )}
        {children}
      </div>
    </div>
  )
}
