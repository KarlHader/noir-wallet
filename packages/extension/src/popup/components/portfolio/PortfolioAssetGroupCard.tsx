import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import Big from '@/lib/big'
import {
  formatPercentage,
  formatBaseUnitDecimalAmount,
  formatFiatAmount,
  formatTokenPrice
} from '@/lib/number-format'

import { cn } from '@/lib/utils'
import type { PortfolioAssetView } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { BalanceHelp } from '@/popup/components/transaction/BalanceHelp'
import { getPortfolioAssetUsdValue } from './portfolio-prices'
import { formatDisplayAmount } from './portfolio-format'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { Tooltip } from '@/popup/components/ui/tooltip'
import {
  calculatePortfolioAccountBalanceBreakdown,
  getAvailablePortfolioAssetGroupUsdValue,
  getPortfolioAssetGroupUnitQuote,
  type PortfolioAccountBalanceBreakdown,
  type PortfolioAssetGroup,
  type PortfolioAssetGroupEntry
} from '@/popup/services/portfolio-presentation'

interface PortfolioAssetGroupCardProps {
  readonly group: PortfolioAssetGroup
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly expanded: boolean
  readonly pricesLoading?: boolean
  readonly directAsset?: boolean
  readonly onToggle?: () => void
  readonly onSelectAsset?: (assetId: string) => void
}

interface PortfolioAssetBalanceRowProps {
  readonly entry: PortfolioAssetGroupEntry
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly leading: 'chain' | 'token'
  readonly pricesLoading?: boolean
  readonly showUnitPrice?: boolean
  readonly onSelectAsset?: (assetId: string) => void
}

function assetAmount(asset: PortfolioAssetView): Big {
  return new Big(formatBaseUnitDecimalAmount(asset.balance.totalRaw, asset.metadata.decimals))
}

function assetPendingAmount(asset: PortfolioAssetView): Big {
  return new Big(formatBaseUnitDecimalAmount(asset.balance.pendingRaw, asset.metadata.decimals))
}

function PendingAssetAmount({ amount, symbol }: { readonly amount: Big; readonly symbol: string }) {
  if (amount.lte(0)) return null
  return (
    <div className="flex min-w-0 items-center justify-end gap-1 px-3 pb-2.5 text-[11px] text-muted">
      <span
        className="min-w-0 break-all text-right font-mono"
        title={`${amount.toFixed()} ${symbol} pending`}
      >
        {formatDisplayAmount(amount)} {symbol} pending
      </span>
      <BalanceHelp kind="pending" />
    </div>
  )
}

function AccountBalanceTooltip({
  breakdown,
  symbol,
  children
}: {
  readonly breakdown: PortfolioAccountBalanceBreakdown
  readonly symbol: string
  readonly children: ReactNode
}) {
  return (
    <Tooltip
      side="left"
      className="w-48"
      content={
        <span className="block space-y-1">
          <span className="flex items-center justify-between gap-3">
            <span>Public</span>
            <span className="min-w-0 break-all text-right font-mono">
              <span title={`${breakdown.main.toFixed()} ${symbol}`}>
                {formatDisplayAmount(breakdown.main)} {symbol}
              </span>
            </span>
          </span>
          <span className="flex items-center justify-between gap-3">
            <span>Confidential</span>
            <span className="min-w-0 break-all text-right font-mono">
              <span title={`${breakdown.privateBalance.toFixed()} ${symbol}`}>
                {formatDisplayAmount(breakdown.privateBalance)} {symbol}
              </span>
            </span>
          </span>
        </span>
      }
    >
      {children}
    </Tooltip>
  )
}

function UnitPrice({
  price,
  percent24h,
  changeFreshness,
  loading = false
}: {
  readonly price: string | null
  readonly percent24h?: string | null
  readonly changeFreshness?: 'fresh' | 'stale' | null
  readonly loading?: boolean
}) {
  const changePercent = percent24h ?? null
  const change = changePercent === null ? null : new Big(changePercent)
  const formattedChange =
    changePercent === null
      ? null
      : formatPercentage(changePercent, { maxDigits: 2, showPlus: true })
  if (price === null && loading) {
    return <Skeleton className="mt-1 h-3 w-20" />
  }
  return (
    <p
      data-testid="asset-unit-price"
      className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted"
    >
      <span className="truncate">
        {price === null ? '—' : formatTokenPrice(price, { showSign: true })}
      </span>
      {change && formattedChange && (
        <span
          aria-label={`${formattedChange} over 24 hours${changeFreshness === 'stale' ? ', delayed' : ''}`}
          title={changeFreshness === 'stale' ? '24h change · Delayed' : '24h change'}
          className={cn(
            'shrink-0',
            change.gt(0) ? 'text-success' : change.lt(0) ? 'text-danger' : 'text-muted'
          )}
        >
          {formattedChange}
        </span>
      )}
    </p>
  )
}

function PortfolioAssetBalanceRow({
  entry,
  prices,
  balancesHidden,
  leading,
  pricesLoading = false,
  showUnitPrice = true,
  onSelectAsset
}: PortfolioAssetBalanceRowProps) {
  const amount = assetAmount(entry.asset)
  const pendingAmount = assetPendingAmount(entry.asset)
  const fiat = getPortfolioAssetUsdValue(entry.asset, prices)
  const quote = findAssetPrice(prices, entry.asset.asset.id)
  const chainAlias = resolveChainIconAlias(entry.chain.chain.family, entry.chain.chain.displayName)
  const breakdown = calculatePortfolioAccountBalanceBreakdown([entry])

  return (
    <div>
      <button
        type="button"
        aria-label={`View ${entry.asset.metadata.symbol} details on ${entry.chain.chain.displayName}`}
        onClick={() => onSelectAsset?.(entry.asset.asset.id)}
        className={cn(
          'flex min-h-14 w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]',
          !balancesHidden && pendingAmount.gt(0) && 'pb-0'
        )}
      >
        {leading === 'chain' ? (
          <ChainIcon
            chain={chainAlias}
            width={24}
            height={24}
            className="shrink-0 rounded-[6px]"
            showTooltip={false}
          />
        ) : (
          <TokenIcon
            assetId={entry.asset.asset.id}
            symbol={entry.asset.metadata.symbol}
            icon={entry.asset.metadata.iconUrl}
            size={32}
            className="shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {leading === 'chain' ? entry.chain.chain.displayName : entry.asset.metadata.symbol}
          </p>
          {showUnitPrice && (
            <UnitPrice
              price={quote?.priceUsd ?? null}
              percent24h={quote?.marketChange?.percent24h}
              changeFreshness={quote?.marketChange?.freshness}
              loading={pricesLoading}
            />
          )}
        </div>
        <div className="max-w-[132px] shrink-0 text-right">
          {!balancesHidden && fiat === null && pricesLoading ? (
            <Skeleton className="ml-auto h-4 w-16" />
          ) : (
            <p className="break-all text-sm font-medium">
              {balancesHidden
                ? '••••'
                : fiat === null
                  ? '—'
                  : formatFiatAmount(fiat, { showSign: true })}
            </p>
          )}
          {breakdown && !balancesHidden ? (
            <AccountBalanceTooltip breakdown={breakdown} symbol={entry.asset.metadata.symbol}>
              <p
                className="mt-0.5 break-all font-mono text-xs text-muted underline decoration-dotted underline-offset-2"
                title={`${amount.toFixed()} ${entry.asset.metadata.symbol}`}
              >
                {formatDisplayAmount(amount)} {entry.asset.metadata.symbol}
              </p>
            </AccountBalanceTooltip>
          ) : (
            <p
              className="mt-0.5 break-all font-mono text-xs text-muted"
              title={
                balancesHidden ? undefined : `${amount.toFixed()} ${entry.asset.metadata.symbol}`
              }
            >
              {balancesHidden
                ? '••••'
                : `${formatDisplayAmount(amount)} ${entry.asset.metadata.symbol}`}
            </p>
          )}
        </div>
      </button>
      {!balancesHidden && (
        <PendingAssetAmount amount={pendingAmount} symbol={entry.asset.metadata.symbol} />
      )}
    </div>
  )
}

export function PortfolioChainAssetRow(props: Omit<PortfolioAssetBalanceRowProps, 'leading'>) {
  return <PortfolioAssetBalanceRow {...props} leading="token" />
}

export function PortfolioAssetGroupCard({
  group,
  prices,
  balancesHidden,
  expanded,
  pricesLoading = false,
  directAsset = false,
  onToggle,
  onSelectAsset
}: PortfolioAssetGroupCardProps) {
  const totalAmount = group.entries.reduce(
    (sum, entry) => sum.plus(assetAmount(entry.asset)),
    new Big(0)
  )
  const pendingAmount = group.entries.reduce(
    (sum, entry) => sum.plus(assetPendingAmount(entry.asset)),
    new Big(0)
  )
  const fiat = getAvailablePortfolioAssetGroupUsdValue(group, prices)
  const unitQuote = getPortfolioAssetGroupUnitQuote(group, prices)
  const breakdown = calculatePortfolioAccountBalanceBreakdown(group.entries)

  return (
    <article className="overflow-hidden rounded-xl bg-card">
      <button
        type="button"
        aria-label={
          directAsset
            ? `View ${group.symbol} details on ${group.entries[0]?.chain.chain.displayName}`
            : `${expanded ? 'Collapse' : 'Expand'} ${group.symbol} networks`
        }
        aria-expanded={directAsset ? undefined : expanded}
        onClick={() =>
          directAsset ? onSelectAsset?.(group.entries[0].asset.asset.id) : onToggle?.()
        }
        className={cn(
          'flex min-h-[68px] w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]',
          !balancesHidden && pendingAmount.gt(0) && 'pb-0'
        )}
      >
        <TokenIcon
          assetId={group.representativeAssetId}
          symbol={group.symbol}
          icon={group.iconUrl}
          blockchain={
            directAsset && group.entries[0]
              ? resolveChainIconAlias(
                  group.entries[0].chain.chain.family,
                  group.entries[0].chain.chain.displayName
                )
              : undefined
          }
          size={36}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-base font-medium">{group.symbol}</p>
            {!group.bundled && (
              <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                Custom
              </span>
            )}
          </div>
          <UnitPrice
            price={unitQuote?.priceUsd ?? null}
            percent24h={unitQuote?.percent24h}
            changeFreshness={unitQuote?.changeFreshness}
            loading={pricesLoading}
          />
        </div>
        <div className="min-w-0 max-w-[142px] shrink-0 text-right">
          {!balancesHidden && fiat === null && pricesLoading ? (
            <Skeleton className="ml-auto h-4 w-16" />
          ) : (
            <p className="break-all text-sm font-medium">
              {balancesHidden
                ? '••••'
                : fiat === null
                  ? '—'
                  : formatFiatAmount(fiat, { showSign: true })}
            </p>
          )}
          {breakdown && !balancesHidden ? (
            <AccountBalanceTooltip breakdown={breakdown} symbol={group.symbol}>
              <p
                className="mt-0.5 break-all font-mono text-xs text-muted underline decoration-dotted underline-offset-2"
                title={`${totalAmount.toFixed()} ${group.symbol}`}
              >
                {formatDisplayAmount(totalAmount)} {group.symbol}
              </p>
            </AccountBalanceTooltip>
          ) : (
            <p
              className="mt-0.5 break-all font-mono text-xs text-muted"
              title={balancesHidden ? undefined : `${totalAmount.toFixed()} ${group.symbol}`}
            >
              {balancesHidden ? '••••' : `${formatDisplayAmount(totalAmount)} ${group.symbol}`}
            </p>
          )}
        </div>
        {!directAsset && (
          <Icon
            icon="lucide:chevron-down"
            width={15}
            height={15}
            className={cn('shrink-0 text-muted transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      {!balancesHidden && <PendingAssetAmount amount={pendingAmount} symbol={group.symbol} />}
      {!directAsset && expanded && (
        <div
          role="region"
          aria-label={`${group.symbol} network balances`}
          className="divide-y divide-border/70 border-t border-border/70"
        >
          {group.entries.map(entry => (
            <PortfolioAssetBalanceRow
              key={entry.asset.asset.id}
              entry={entry}
              prices={prices}
              balancesHidden={balancesHidden}
              leading="chain"
              pricesLoading={pricesLoading}
              showUnitPrice={unitQuote === null}
              onSelectAsset={onSelectAsset}
            />
          ))}
        </div>
      )}
    </article>
  )
}
