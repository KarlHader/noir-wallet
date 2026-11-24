import { Icon } from '@iconify/react'
import type { ComponentProps, ReactNode } from 'react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { TokenIcon } from '../tokens/TokenIcon'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { ChainIcon } from '../common/ChainIcon'
import { AmountDisplay } from '../common/AmountDisplay'
import { BalanceSkeleton } from '../ui/skeleton'

export interface TransferMaximumControl {
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly selected?: boolean
  readonly loading?: boolean
  readonly title?: string
}

export function TransferMaximumButton({
  onClick,
  disabled,
  selected,
  loading,
  title,
  appearance = 'neutral'
}: TransferMaximumControl & { readonly appearance?: 'neutral' | 'compact' }) {
  return (
    <button
      type="button"
      aria-label="Max"
      aria-pressed={selected}
      aria-busy={loading || undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'wallet-interactive inline-flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 py-1 font-medium text-muted disabled:opacity-40',
        selected && 'bg-primary/15 text-primary',
        appearance === 'compact' && 'rounded px-1.5 py-0.5'
      )}
    >
      {loading && <Icon icon="lucide:loader-circle" className="size-3 animate-spin" aria-hidden />}
      Max
    </button>
  )
}

export interface SendFormAdapter {
  readonly amount: ComponentProps<typeof SendAmountInput>
  readonly asset: ComponentProps<typeof SendAssetHeader>
  readonly balance: {
    readonly value: string | null
    readonly hidden?: boolean
    readonly loading?: boolean
    readonly testId?: string
  }
  readonly maximum: TransferMaximumControl
  readonly recipient: Omit<
    ComponentProps<typeof SendRecipientInputCard>,
    'hideLabel' | 'variant'
  > & {
    readonly network: {
      readonly name: string
      readonly icon?: string
      readonly onSelect?: () => void
      readonly disabled?: boolean
      readonly selectorLabel?: string
    }
    readonly feedback?: ReactNode
    readonly notice?: ReactNode
  }
}

export function SendFormView({
  adapter,
  children,
  footer
}: {
  readonly adapter: SendFormAdapter
  readonly children?: ReactNode
  readonly footer: ReactNode
}) {
  return (
    <>
      <div className="page-content min-h-0 space-y-4 !px-4 pt-4">
        <SendRecipientSection {...adapter.recipient} />
        <SendAmountRow {...adapter} />
        {children}
        {adapter.recipient.notice}
      </div>
      <div className="page-footer">{footer}</div>
    </>
  )
}

export function SendFormActions({
  onContinue,
  disabled,
  loading,
  privacy
}: {
  readonly onContinue: () => void
  readonly disabled: boolean
  readonly loading?: boolean
  readonly privacy?: { readonly checked: boolean; readonly onChange: () => void }
}) {
  return (
    <>
      {privacy && (
        <button
          type="button"
          role="switch"
          aria-label="Send privately"
          aria-checked={privacy.checked}
          onClick={privacy.onChange}
          className={cn(
            'mb-4 flex w-full items-center justify-center gap-1.5 text-sm',
            privacy.checked ? 'text-primary' : 'text-muted'
          )}
        >
          <Icon icon="lucide:shield-check" width={15} height={15} className="text-primary" />
          Send privately
          <Switch checked={privacy.checked} size="sm" />
        </button>
      )}
      <Button
        size="wallet"
        className="h-[45px] w-full"
        disabled={disabled}
        isLoading={loading}
        onClick={onContinue}
      >
        Continue
      </Button>
    </>
  )
}

/** Keeps source and recipient headings at the same visual level. */
function SendFieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="shrink-0 font-sans text-sm font-medium text-wallet-field-label">
      {children}
    </span>
  )
}

function SendRecipientSection({
  network,
  feedback,
  notice,
  describedBy,
  ...field
}: SendFormAdapter['recipient']) {
  const networkLabel = (
    <>
      {network.icon && (
        <ChainIcon
          chain={network.icon}
          width={16}
          height={16}
          className="shrink-0 rounded"
          showTooltip={false}
        />
      )}
      <span className="max-w-32 truncate">{network.name}</span>
    </>
  )
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <SendFieldLabel>Send to</SendFieldLabel>
        {network.onSelect ? (
          <button
            type="button"
            aria-label={network.selectorLabel ?? `Select destination network, ${network.name}`}
            onClick={network.onSelect}
            disabled={network.disabled}
            className="wallet-interactive inline-flex min-w-0 items-center gap-1.5 hover:text-primary disabled:opacity-50"
          >
            {networkLabel}
            <Icon icon="lucide:chevron-down" width={13} height={13} className="shrink-0" />
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">{networkLabel}</span>
        )}
      </div>
      <SendRecipientInputCard
        {...field}
        describedBy={notice ? `${field.id}-error` : describedBy}
        hideLabel
        variant="filled"
      />
      {feedback}
    </div>
  )
}

function SendAmountRow({
  amount,
  asset,
  balance,
  maximum
}: Pick<SendFormAdapter, 'amount' | 'asset' | 'balance' | 'maximum'>) {
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
        <SendFieldLabel>Amount</SendFieldLabel>
        <div className="flex max-w-[70%] min-w-0 items-center gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">
            Bal.{' '}
            <span
              data-testid={balance.testId}
              title={balance.hidden ? undefined : (balance.value ?? undefined)}
            >
              {balance.hidden ? (
                '••••'
              ) : balance.loading ? (
                <BalanceSkeleton />
              ) : balance.value === null ? (
                '—'
              ) : (
                formatTokenQuantity(balance.value)
              )}
            </span>
          </span>
          <TransferMaximumButton {...maximum} />
        </div>
      </div>
      <div className="flex min-h-14 min-w-0 items-center gap-2 rounded-[10px] border border-white/10 bg-wallet-surface px-4 focus-within:border-white/35">
        <div className="min-w-0 flex-1">
          <SendAmountInput {...amount} />
        </div>
        <div className="min-w-0 max-w-[55%] shrink-0">
          <SendAssetHeader {...asset} />
        </div>
      </div>
    </div>
  )
}

export function SendRouteInfoCard({
  provider,
  fee,
  feeLabel = 'Fee',
  time,
  extra,
  estimatedReceive
}: {
  readonly provider?: ReactNode
  readonly fee?: ReactNode
  readonly feeLabel?: string
  readonly time?: ReactNode
  readonly extra?: ReactNode
  readonly estimatedReceive?: { readonly value: string; readonly symbol: string }
}) {
  return (
    <div className="space-y-3 rounded-lg border border-white/15 px-4 py-4 text-xs">
      {provider !== undefined && (
        <div className="flex min-h-5 items-center justify-between gap-3">
          <span className="text-muted">Provider</span>
          <div className="min-w-0 text-right">{provider}</div>
        </div>
      )}
      {fee !== undefined && (
        <div className="flex min-h-5 items-center justify-between gap-3">
          <span className="text-muted">{feeLabel}</span>
          <div className="min-w-0 text-right">{fee}</div>
        </div>
      )}
      {time !== undefined && (
        <div className="flex min-h-5 items-center justify-between gap-3">
          <span className="text-muted">Est. time</span>
          <div className="min-w-0 text-right">{time}</div>
        </div>
      )}
      {extra}
      {estimatedReceive && (
        <div className="flex justify-between gap-3 border-t border-white/10 pt-3">
          <span className="text-muted">Est. receive</span>
          <AmountDisplay value={estimatedReceive.value} symbol={estimatedReceive.symbol} />
        </div>
      )}
    </div>
  )
}

export function SendRecipientInputCard({
  id,
  value,
  onChange,
  placeholder,
  label = 'Send to',
  hideLabel = false,
  variant = 'outline',
  invalid = false,
  describedBy,
  autoFocus = false,
  disabled = false,
  readOnly,
  selectedName,
  onSelectRecipient
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly label?: string
  readonly hideLabel?: boolean
  readonly variant?: 'outline' | 'filled'
  readonly invalid?: boolean
  readonly describedBy?: string
  readonly autoFocus?: boolean
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly selectedName?: string
  readonly onSelectRecipient?: () => void
}) {
  return (
    <div className={cn('space-y-1.5', variant === 'filled' && 'space-y-3')}>
      <div
        className={cn(
          'flex min-w-0 items-center justify-between gap-2',
          hideLabel && !selectedName && 'sr-only'
        )}
      >
        <label
          htmlFor={id}
          className={cn(
            'block px-1 text-xs font-medium text-foreground/80',
            variant === 'filled' && 'px-0 text-sm leading-[18px]',
            hideLabel && 'sr-only'
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
        aria-describedby={describedBy}
        disabled={disabled}
        readOnly={readOnly}
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
          ) : variant === 'filled' ? (
            <></>
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

function SendAmountInput({
  ariaLabel,
  value,
  onChange,
  invalid,
  describedBy,
  testId = 'send-amount-card',
  disabled
}: {
  readonly ariaLabel: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly invalid?: boolean
  readonly describedBy?: string
  readonly testId?: string
  readonly disabled?: boolean
}) {
  return (
    <div data-testid={testId} className="w-full min-w-0">
      <input
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        inputMode="decimal"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="0"
        className="h-12 w-full min-w-0 bg-transparent font-sans text-xl font-medium tabular-nums text-foreground outline-none placeholder:text-muted/45"
      />
    </div>
  )
}

function SendAssetHeader({
  assetId,
  symbol,
  icon,
  networkName,
  nativeChain,
  blockchain,
  onSelectAsset,
  disabled,
  ariaLabel
}: {
  readonly assetId?: string
  readonly symbol: string
  readonly icon?: string
  readonly networkName: string
  readonly nativeChain?: 'zcash' | 'bitcoin' | 'solana' | 'near'
  readonly blockchain?: string
  readonly onSelectAsset?: () => void
  readonly disabled?: boolean
  readonly ariaLabel?: string
}) {
  const content = (
    <>
      <TokenIcon
        assetId={assetId}
        symbol={symbol}
        icon={icon}
        nativeChain={nativeChain}
        blockchain={blockchain ?? nativeChain}
        size={24}
      />
      <span className="max-w-28 truncate">{symbol}</span>
      {onSelectAsset && <Icon icon="lucide:chevron-down" width={15} height={15} />}
    </>
  )
  return (
    <div data-testid="send-asset-header" className="flex justify-center">
      {onSelectAsset ? (
        <button
          type="button"
          onClick={onSelectAsset}
          aria-label={ariaLabel ?? `Select send asset, ${symbol} on ${networkName}`}
          disabled={disabled}
          className="wallet-interactive inline-flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full bg-wallet-surface px-2.5 text-sm font-medium enabled:hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
        >
          {content}
        </button>
      ) : (
        <div className="inline-flex h-9 max-w-full items-center gap-2 rounded-full bg-wallet-surface px-2.5 text-sm font-medium">
          {content}
        </div>
      )}
    </div>
  )
}
