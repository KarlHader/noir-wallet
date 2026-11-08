import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { formatSendFiatValue } from './send-input-model'
import { cn } from '@/lib/utils'
import { TokenIcon } from '../tokens/TokenIcon'
import { Input } from '../ui/input'
import { BalanceHelp } from './BalanceHelp'
import { safeBig } from '@/lib/big'
import { Tooltip } from '../ui/tooltip'

export function SendRecipientInputCard({
  id,
  value,
  onChange,
  placeholder,
  label = 'Send to',
  variant = 'outline',
  invalid = false,
  autoFocus = false,
  selectedName,
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
  readonly selectedName?: string
  readonly onSelectRecipient?: () => void
}) {
  return (
    <div className={cn('space-y-1.5', variant === 'filled' && 'space-y-3')}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label
          htmlFor={id}
          className={cn(
            'block px-1 text-xs font-medium text-foreground/80',
            variant === 'filled' && 'px-0 text-sm leading-[18px]'
          )}
        >
          {label}
        </label>
        {selectedName && (
          <span className="min-w-0 truncate text-xs text-muted" title={selectedName}>
            {selectedName}
          </span>
        )}
      </div>
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
            ? 'h-[54px] rounded-[10px] border border-white/10 bg-wallet-surface pl-[15px] pr-12 font-sans font-medium leading-[18px]'
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

export function SendRecipientAddress({
  address,
  name
}: {
  readonly address: string
  readonly name?: string
}) {
  return (
    <span className="block min-w-0 text-right">
      {name && (
        <span className="block truncate font-sans text-foreground" title={name}>
          {name}
        </span>
      )}
      <span className="block truncate font-mono text-xs text-muted" title={address}>
        {formatSortAddress(address)}
      </span>
    </span>
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
  maxDisabledReason,
  maxLoading = false,
  maxSelected = false,
  invalid = false,
  error,
  pending,
  showBalanceHelp = false,
  headerAction,
  hero = false,
  variant = 'outline',
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
  readonly maxDisabledReason?: string
  readonly maxLoading?: boolean
  readonly maxSelected?: boolean
  readonly invalid?: boolean
  readonly error?: string
  readonly pending?: string
  readonly showBalanceHelp?: boolean
  readonly headerAction?: ReactNode
  readonly hero?: boolean
  readonly variant?: 'outline' | 'filled'
  readonly title?: string
  readonly testId?: string
}) {
  const amountFiat = formatSendFiatValue(value, priceUsd)
  const availableFiat = formatSendFiatValue(available, priceUsd)
  const filled = variant === 'filled' && !hero
  const maxButton = onMax ? (
    <button
      type="button"
      aria-label="Max"
      aria-pressed={maxSelected}
      onClick={onMax}
      disabled={maxDisabled || Boolean(maxDisabledReason) || maxLoading}
      className={cn(
        'flex h-8 min-w-12 items-center justify-center rounded-full bg-white/12 px-3 text-sm text-foreground transition-colors hover:bg-white/18 disabled:pointer-events-none disabled:opacity-40',
        filled && 'h-7 min-w-10 rounded-md bg-white/10 px-2 text-xs text-muted',
        maxSelected && 'bg-primary/15 text-primary'
      )}
    >
      {maxLoading ? (
        <Icon icon="lucide:loader-circle" width={15} height={15} className="animate-spin" />
      ) : (
        'Max'
      )}
    </button>
  ) : null

  return (
    <div
      data-testid={filled ? (testId ?? 'send-amount-card') : undefined}
      className={cn('space-y-1.5', filled && 'space-y-3', hero && 'space-y-0')}
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-1',
          filled && 'px-0',
          hero && 'sr-only'
        )}
      >
        <span
          className={cn(
            'text-xs font-medium text-foreground/80',
            filled && 'text-sm leading-[18px] text-muted'
          )}
        >
          Amount
        </span>
        {filled ? (
          <span className="min-w-0 truncate text-right text-xs text-muted" title={available}>
            {availableLabel === 'Available' ? 'Bal.' : availableLabel}{' '}
            <strong className="font-medium text-foreground">
              {formatTokenQuantity(available)} {symbol}
            </strong>
            {showBalanceHelp && <BalanceHelp kind="available" />}
          </span>
        ) : (
          headerAction
        )}
      </div>
      <div
        data-testid={filled ? undefined : (testId ?? 'send-amount-card')}
        title={title}
        className={cn(
          'min-h-[92px] rounded-2xl border px-4 py-3 transition-colors focus-within:border-white/60',
          hero
            ? 'min-h-10 rounded-none border-transparent px-0 py-0 focus-within:border-transparent'
            : filled
              ? cn(
                  'flex min-h-[55px] items-center rounded-[10px] border-white/10 bg-wallet-surface px-[15px] py-0',
                  invalid && 'border-warning'
                )
              : invalid
                ? 'border-warning'
                : 'border-white/35'
        )}
      >
        <div
          className={cn(
            'flex min-h-8 items-center justify-between gap-3',
            hero && 'relative',
            filled && 'w-full'
          )}
        >
          <input
            aria-label={ariaLabel}
            inputMode="decimal"
            value={value}
            title={hero && value ? value : undefined}
            style={
              hero
                ? {
                    fontSize: `${Math.max(16, Math.min(40, Math.floor(500 / Math.max(1, value.length))))}px`
                  }
                : undefined
            }
            aria-invalid={invalid || undefined}
            aria-describedby={error ? `${testId ?? 'send-amount-card'}-error` : undefined}
            onChange={event => onChange(event.target.value)}
            placeholder="0"
            className={cn(
              'min-w-0 flex-1 bg-transparent font-sans text-2xl tabular-nums text-foreground outline-none placeholder:text-muted/45',
              filled && 'h-[53px] text-base font-medium',
              hero &&
                'h-10 px-2 text-center text-[40px] font-semibold leading-[37.4px] tracking-[-0.015em]'
            )}
          />
          {onMax && (
            <span className={cn('shrink-0', hero && 'absolute right-0 top-1/2 -translate-y-1/2')}>
              {maxDisabledReason ? (
                <Tooltip content={maxDisabledReason}>
                  <span
                    tabIndex={0}
                    aria-label={maxDisabledReason}
                    className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {maxButton}
                  </span>
                </Tooltip>
              ) : (
                maxButton
              )}
            </span>
          )}
        </div>
        <div
          className={cn(
            'mt-3 flex min-w-0 items-center justify-between gap-3 text-xs leading-4',
            (hero || filled) && 'hidden'
          )}
        >
          <span className="shrink-0 text-muted">{amountFiat ? `~${amountFiat}` : '—'}</span>
          <div className={cn('min-w-0 text-right text-muted', hero && 'hidden')}>
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
      {filled && pending != null && safeBig(pending).gt(0) && (
        <div className="flex min-w-0 items-center justify-end gap-1 text-[11px] text-muted">
          <span className="min-w-0 break-all" title={pending}>
            {formatTokenQuantity(pending)} {symbol} pending
          </span>
          <BalanceHelp kind="pending" />
        </div>
      )}
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
  blockchain,
  onSelectAsset,
  variant = 'default'
}: {
  readonly assetId?: string
  readonly symbol: string
  readonly icon?: string
  readonly networkName: string
  readonly nativeChain?: 'zcash' | 'bitcoin' | 'solana' | 'near'
  readonly blockchain?: string
  readonly onSelectAsset?: () => void
  readonly variant?: 'default' | 'compact'
}) {
  if (variant === 'compact') {
    const content = (
      <>
        <TokenIcon
          assetId={assetId}
          symbol={symbol}
          icon={icon}
          nativeChain={nativeChain}
          blockchain={blockchain ?? nativeChain}
          size={42}
        />
        <span className="flex max-w-full items-center gap-1.5 text-base font-medium leading-5">
          <span className="max-w-32 truncate">{symbol}</span>
          {onSelectAsset && <Icon icon="lucide:chevron-down" width={15} height={15} />}
        </span>
      </>
    )
    return (
      <div data-testid="send-asset-header" className="flex justify-center py-1">
        {onSelectAsset ? (
          <button
            type="button"
            onClick={onSelectAsset}
            aria-label={`Select send asset, ${symbol} on ${networkName}`}
            className="flex min-w-0 flex-col items-center gap-2 text-center"
          >
            {content}
          </button>
        ) : (
          <div className="flex min-w-0 flex-col items-center gap-2 text-center">{content}</div>
        )}
      </div>
    )
  }
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
        blockchain={blockchain ?? nativeChain}
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
