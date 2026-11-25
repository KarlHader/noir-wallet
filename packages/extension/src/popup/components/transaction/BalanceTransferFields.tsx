import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { formatTokenQuantity } from '@/lib/number-format'
import { formatSortAddress } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  balanceTransferDomainLabel,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { ChainIcon } from '../common/ChainIcon'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '../portfolio/shield-providers'
import { BalanceSkeleton } from '../ui/skeleton'
import { TransferMaximumButton, type TransferMaximumControl } from './SendInputCards'

export interface BalanceTransferAmountInput {
  readonly id?: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly invalid?: boolean
}

export function BalanceTransferAmount({
  amount,
  asset,
  balance,
  balanceLoading,
  max
}: {
  readonly amount?: BalanceTransferAmountInput
  readonly asset: ReactNode
  readonly balance?: string
  readonly balanceLoading?: boolean
  readonly max?: TransferMaximumControl
}) {
  return (
    <div className="flex min-h-[145px] min-w-0 shrink-0 flex-col items-center justify-center gap-2 py-3">
      {amount && (
        <input
          id={amount.id}
          aria-label={amount.label}
          aria-invalid={amount.invalid || undefined}
          inputMode="decimal"
          value={amount.value}
          disabled={amount.disabled}
          title={amount.value || undefined}
          onChange={event => amount.onChange(event.target.value)}
          placeholder="0"
          className="h-14 w-full min-w-0 max-w-[320px] bg-transparent px-2 text-center text-[40px] font-semibold leading-tight tabular-nums caret-primary outline-none placeholder:text-muted/45"
          style={{
            fontSize: Math.max(16, Math.min(40, Math.floor(440 / Math.max(1, amount.value.length))))
          }}
        />
      )}
      {asset}
      {balance !== undefined && (
        <div className="flex max-w-full items-center gap-2 text-xs text-muted">
          {balanceLoading ? (
            <BalanceSkeleton />
          ) : (
            <span className="truncate" title={balance}>
              {formatTokenQuantity(balance)}
            </span>
          )}
          {max && <TransferMaximumButton {...max} appearance="compact" />}
        </div>
      )}
    </div>
  )
}

export function BalanceTransferAccountCard({
  label,
  accountName,
  domain,
  address,
  network,
  networkName,
  onNetworkClick,
  onAccountClick,
  showNetwork = false,
  disabled,
  provider = 'near-confidential',
  external = false,
  transparent = false
}: {
  label: 'From' | 'To'
  accountName: string
  domain: TransferDomain
  address: string
  network?: string
  networkName?: string
  onNetworkClick?: () => void
  onAccountClick?: () => void
  showNetwork?: boolean
  disabled?: boolean
  provider?: ShieldProvider | null
  external?: boolean
  transparent?: boolean
}) {
  const AccountControl = onAccountClick ? 'button' : 'div'
  const NetworkControl = onNetworkClick ? 'button' : 'div'
  const accountLabel = external
    ? 'External transfer'
    : domain === 'shield' && provider
      ? SHIELD_PROVIDERS[provider].detailName
      : transparent && domain === 'public'
        ? 'Transparent'
        : balanceTransferDomainLabel(domain)
  return (
    <div className="w-full rounded-xl border border-white/5 bg-wallet-surface px-4 py-4">
      <AccountControl
        {...(onAccountClick && {
          type: 'button',
          onClick: onAccountClick,
          disabled,
          'aria-label': `${label}: ${accountLabel}. Change account`
        })}
        className="wallet-interactive flex w-full min-w-0 items-center gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        {domain === 'shield' && provider ? (
          <ShieldProviderLogo provider={provider} size={28} />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-muted">
            <Icon
              icon={
                external
                  ? 'lucide:qr-code'
                  : domain === 'shield'
                    ? 'noir:shield-assets'
                    : 'lucide:wallet'
              }
              width={19}
              height={19}
            />
          </span>
        )}
        <span className="min-w-0 flex-1">
          {domain === 'shield' ? (
            <>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{label}</span>
                <span>Shield</span>
              </span>
              <span className="block truncate text-base font-medium">
                {provider ? SHIELD_PROVIDERS[provider].detailName : 'Select provider'}
              </span>
            </>
          ) : external ? (
            <>
              <span className="block text-xs text-muted">{label}</span>
              <span className="block text-base font-medium">External transfer</span>
            </>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{label}</span>
                <span className="truncate">{accountName}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5',
                    domain === 'private' ? 'bg-private/10 text-private' : 'bg-white/10 text-muted'
                  )}
                >
                  {accountLabel}
                </span>
              </span>
              <span className="mt-1 block truncate text-base font-medium" title={address}>
                {address ? formatSortAddress(address) : '—'}
              </span>
            </>
          )}
        </span>
        {onAccountClick && (
          <Icon icon="lucide:chevron-down" width={15} height={15} className="shrink-0 text-muted" />
        )}
      </AccountControl>
      {showNetwork && domain !== 'shield' && network && (networkName || onNetworkClick) && (
        <NetworkControl
          {...(onNetworkClick && {
            type: 'button',
            onClick: onNetworkClick,
            disabled,
            'aria-label': `Select ${label.toLowerCase()} network`
          })}
          className={cn(
            'mt-4 flex w-full items-center gap-3 rounded text-left',
            onNetworkClick &&
              'wallet-interactive focus-visible:outline-2 focus-visible:outline-primary'
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-muted">
            <Icon icon="lucide:globe" width={19} height={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">Network</span>
            <span className="mt-1 flex items-center gap-1.5 text-base font-medium">
              <ChainIcon
                chain={network}
                width={16}
                height={16}
                showTooltip={false}
                alt=""
                aria-hidden="true"
                className="shrink-0 rounded"
              />
              <span className="truncate">{networkName || 'Select network'}</span>
            </span>
          </span>
          {onNetworkClick && (
            <Icon
              icon="lucide:chevron-down"
              width={15}
              height={15}
              className="shrink-0 text-muted"
            />
          )}
        </NetworkControl>
      )}
    </div>
  )
}

export function BalanceTransferAccounts({
  source,
  destination,
  onReverse,
  disabled,
  className,
  privateMode
}: {
  readonly source: ReactNode
  readonly destination: ReactNode
  readonly onReverse?: () => void
  readonly disabled?: boolean
  readonly className?: string
  readonly privateMode?: boolean
}) {
  return (
    <div className={className}>
      {source}
      <div className="relative h-2.5">
        {onReverse && (
          <button
            type="button"
            aria-label="Switch transfer direction"
            title="Switch transfer direction"
            onClick={onReverse}
            disabled={disabled}
            className={cn(
              'wallet-interactive absolute left-1/2 top-1/2 z-10 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border border-white/10 bg-card hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40',
              privateMode ? 'text-private' : 'text-foreground'
            )}
          >
            <Icon icon="lucide:arrow-down-up" width={18} height={18} />
          </button>
        )}
      </div>
      {destination}
    </div>
  )
}
