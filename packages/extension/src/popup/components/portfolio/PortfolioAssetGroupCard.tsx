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
import { formatSymbol } from '@/lib/format'
import type { PortfolioAssetView } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import type { SwapToken } from '@/core/services/intents-api'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import {
  lookupSwapTokenForWalletAsset,
  resolvePortfolioAssetIconUrl
} from '@/popup/components/tokens/portfolio-token-swap-icon'
import { BalanceHelp } from '@/popup/components/transaction/BalanceHelp'
import { getPortfolioAssetUsdValue } from './portfolio-prices'
import { formatDisplayAmount } from './portfolio-format'
import { Skeleton } from '@/popup/components/ui/skeleton'
import {
  getAvailablePortfolioAssetGroupUsdValue,
  getPortfolioAssetDomainBalances,
  getPortfolioAssetGroupUnitQuote,
  type PortfolioAssetGroup,
  type PortfolioAssetGroupEntry
} from '@/popup/services/portfolio-presentation'
import type { AssetDomain } from '@/popup/services/asset-domains'
import { ZcashFundingBadge } from '@/popup/components/account/ZcashFundingBadge'
import { Tooltip } from '@/popup/components/ui/tooltip'

export const portfolioAssetRowClassName =
  'flex min-h-[72px] w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left'

export function PortfolioAssetRowContent({
  icon,
  title,
  subtitle,
  balance
}: {
  readonly icon: ReactNode
  readonly title: ReactNode
  readonly subtitle: ReactNode
  readonly balance: ReactNode
}) {
  return (
    <>
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">{title}</div>
        {subtitle}
      </div>
      <div className="min-w-0 max-w-[142px] shrink-0 text-right">{balance}</div>
    </>
  )
}

type ConfidentialZecBalance = Readonly<{ assetId: string; amount: string; fiat: string | null }>

interface PortfolioAssetGroupCardProps {
  readonly domain?: AssetDomain
  readonly group: PortfolioAssetGroup
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly confidentialZec?: ConfidentialZecBalance | null
  readonly expanded: boolean
  readonly pricesLoading?: boolean
  readonly directAsset?: boolean
  readonly onToggle?: () => void
  readonly onSelectAsset?: (assetId: string) => void
  readonly swapCatalog?: readonly SwapToken[]
}

interface PortfolioAssetBalanceRowProps {
  readonly domain?: AssetDomain
  readonly entry: PortfolioAssetGroupEntry
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly confidentialZec?: ConfidentialZecBalance | null
  readonly leading: 'chain' | 'token'
  readonly pricesLoading?: boolean
  readonly showUnitPrice?: boolean
  readonly onSelectAsset?: (assetId: string) => void
  readonly swapCatalog?: readonly SwapToken[]
}

function portfolioTokenIconProps(
  asset: PortfolioAssetView,
  catalog: readonly SwapToken[] | undefined,
  blockchain?: string
) {
  const assetId = asset.asset.id
  const swapToken = catalog ? lookupSwapTokenForWalletAsset(assetId, catalog) : null
  return {
    token: swapToken ?? undefined,
    assetId,
    symbol: formatSymbol(asset.metadata.symbol),
    icon: resolvePortfolioAssetIconUrl({
      assetId,
      metadataIconUrl: asset.metadata.iconUrl,
      catalog
    }),
    blockchain: blockchain ?? swapToken?.blockchain
  }
}

function assetAmount(asset: PortfolioAssetView): Big {
  return new Big(formatBaseUnitDecimalAmount(asset.balance.totalRaw, asset.metadata.decimals))
}

function assetPendingAmount(asset: PortfolioAssetView): Big {
  return new Big(formatBaseUnitDecimalAmount(asset.balance.pendingRaw, asset.metadata.decimals))
}

function PortfolioAssetQuantity({
  entries,
  domain,
  prices,
  balancesHidden,
  confidentialZec,
  amount,
  symbol
}: {
  readonly entries: readonly PortfolioAssetGroupEntry[]
  readonly domain: AssetDomain
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly confidentialZec?: ConfidentialZecBalance | null
  readonly amount: Big
  readonly symbol: string
}) {
  if (balancesHidden) return <p className="mt-0.5 break-all text-xs text-muted">••••</p>

  const domainBalances = getPortfolioAssetDomainBalances(entries, domain, prices)
  const isZcash = entries.every(entry => entry.chain.chain.family === 'zcash')
  const balances =
    isZcash &&
    confidentialZec &&
    entries.some(entry => entry.asset.asset.id === confidentialZec.assetId)
      ? [...domainBalances, { ...confidentialZec, domain: 'near-confidential' as const }]
      : domainBalances
  return (
    <Tooltip
      side="top"
      className="max-w-[260px]"
      content={
        <div className="space-y-1.5">
          {balances.map(balance => (
            <div key={balance.domain} className="flex items-start justify-between gap-4">
              <span className="shrink-0">
                {balance.domain === 'public' && isZcash
                  ? 'Transparent'
                  : balance.domain === 'public'
                    ? 'Public'
                    : balance.domain === 'shield'
                      ? 'Shield'
                      : balance.domain === 'near-confidential'
                        ? 'NEAR Confidential'
                        : 'Private'}
              </span>
              <span className="text-right tabular-nums">
                <span className="block">
                  {balance.amount === null ? '—' : formatDisplayAmount(new Big(balance.amount))}{' '}
                  {formatSymbol(symbol)}
                </span>
                <span className="block opacity-70">
                  {balance.fiat === null ? '—' : formatFiatAmount(balance.fiat, { showSign: true })}
                </span>
              </span>
            </div>
          ))}
        </div>
      }
    >
      <span className="mt-0.5 inline-block break-all text-xs text-muted underline decoration-dotted underline-offset-2">
        {formatDisplayAmount(amount)} {formatSymbol(symbol)}
      </span>
    </Tooltip>
  )
}

function PendingAssetAmount({ amount, symbol }: { readonly amount: Big; readonly symbol: string }) {
  if (amount.lte(0)) return null
  return (
    <div className="flex min-w-0 items-center justify-end gap-1 px-3 pb-2.5 text-[11px] text-muted">
      <span
        className="min-w-0 break-all text-right"
        title={`${amount.toFixed()} ${formatSymbol(symbol)} pending`}
      >
        {formatDisplayAmount(amount)} {formatSymbol(symbol)} pending
      </span>
      <BalanceHelp kind="pending" />
    </div>
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
          aria-label={`${formattedChange} over 24 hours${changeFreshness === 'stale' ? ', last available data' : ''}`}
          title={changeFreshness === 'stale' ? 'Last available 24h change' : '24h change'}
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
  domain,
  prices,
  balancesHidden,
  confidentialZec,
  leading,
  pricesLoading = false,
  showUnitPrice = true,
  onSelectAsset,
  swapCatalog
}: PortfolioAssetBalanceRowProps) {
  const amount = assetAmount(entry.asset)
  const pendingAmount = assetPendingAmount(entry.asset)
  const fiat = getPortfolioAssetUsdValue(entry.asset, prices)
  const quote = findAssetPrice(prices, entry.asset.asset.id)
  const chainAlias = resolveChainIconAlias(
    entry.chain.chain.family,
    entry.chain.chain.displayName,
    entry.chain.chain.id
  )

  return (
    <div>
      <button
        type="button"
        aria-label={`View ${formatSymbol(entry.asset.metadata.symbol)} details on ${entry.chain.chain.displayName}`}
        onClick={() => onSelectAsset?.(entry.asset.asset.id)}
        className={cn(
          'wallet-interactive flex min-h-[72px] w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
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
            {...portfolioTokenIconProps(entry.asset, swapCatalog, chainAlias)}
            size={32}
            className="shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="truncate text-base font-medium">
              {leading === 'chain'
                ? entry.chain.chain.displayName
                : formatSymbol(entry.asset.metadata.symbol)}
            </p>
            {domain === 'public' && entry.chain.chain.family === 'zcash' && (
              <ZcashFundingBadge source="transparent" />
            )}
          </div>
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
            <p className="break-all text-base font-medium">
              {balancesHidden
                ? '••••'
                : fiat === null
                  ? formatFiatAmount('0', { showSign: true })
                  : formatFiatAmount(fiat, { showSign: true })}
            </p>
          )}
          <PortfolioAssetQuantity
            entries={[entry]}
            domain={domain ?? 'all'}
            prices={prices}
            balancesHidden={balancesHidden}
            confidentialZec={confidentialZec}
            amount={amount}
            symbol={entry.asset.metadata.symbol}
          />
        </div>
      </button>
      {!balancesHidden && (
        <PendingAssetAmount
          amount={pendingAmount}
          symbol={formatSymbol(entry.asset.metadata.symbol)}
        />
      )}
    </div>
  )
}

export function PortfolioChainAssetRow(props: Omit<PortfolioAssetBalanceRowProps, 'leading'>) {
  return <PortfolioAssetBalanceRow {...props} leading="token" />
}

export function PortfolioAssetGroupCard({
  group,
  domain = 'all',
  prices,
  balancesHidden,
  confidentialZec,
  expanded,
  pricesLoading = false,
  directAsset = false,
  onToggle,
  onSelectAsset,
  swapCatalog
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
  const representativeAsset = group.entries[0]?.asset
  const chainBadge =
    directAsset && group.entries[0]
      ? resolveChainIconAlias(
          group.entries[0].chain.chain.family,
          group.entries[0].chain.chain.displayName,
          group.entries[0].chain.chain.id
        )
      : undefined

  return (
    <article className="overflow-hidden">
      <button
        type="button"
        aria-label={
          directAsset
            ? `View ${formatSymbol(group.symbol)} details on ${group.entries[0]?.chain.chain.displayName}`
            : `${expanded ? 'Collapse' : 'Expand'} ${formatSymbol(group.symbol)} networks`
        }
        aria-expanded={directAsset ? undefined : expanded}
        onClick={() =>
          directAsset ? onSelectAsset?.(group.entries[0].asset.asset.id) : onToggle?.()
        }
        className={cn(
          portfolioAssetRowClassName,
          'wallet-interactive hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
          !balancesHidden && pendingAmount.gt(0) && 'pb-0'
        )}
      >
        <PortfolioAssetRowContent
          icon={
            <TokenIcon
              {...(representativeAsset
                ? portfolioTokenIconProps(representativeAsset, swapCatalog, chainBadge)
                : {
                    assetId: group.representativeAssetId,
                    symbol: formatSymbol(group.symbol),
                    icon: group.iconUrl,
                    blockchain: chainBadge
                  })}
              size={36}
              className="shrink-0"
            />
          }
          title={
            <>
              <p className="truncate text-base font-medium">{formatSymbol(group.symbol)}</p>
              {domain === 'public' &&
                group.entries.every(entry => entry.chain.chain.family === 'zcash') && (
                  <ZcashFundingBadge source="transparent" />
                )}
              {!group.bundled && (
                <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                  Custom
                </span>
              )}
            </>
          }
          subtitle={
            <UnitPrice
              price={unitQuote?.priceUsd ?? null}
              percent24h={unitQuote?.percent24h}
              changeFreshness={unitQuote?.changeFreshness}
              loading={pricesLoading}
            />
          }
          balance={
            <>
              {!balancesHidden && fiat === null && pricesLoading ? (
                <Skeleton className="ml-auto h-4 w-16" />
              ) : (
                <p className="break-all text-base font-medium">
                  {balancesHidden
                    ? '••••'
                    : fiat === null
                      ? formatFiatAmount('0', { showSign: true })
                      : formatFiatAmount(fiat, { showSign: true })}
                </p>
              )}
              <PortfolioAssetQuantity
                entries={group.entries}
                domain={domain}
                prices={prices}
                balancesHidden={balancesHidden}
                confidentialZec={confidentialZec}
                amount={totalAmount}
                symbol={group.symbol}
              />
            </>
          }
        />
        {!directAsset && (
          <Icon
            icon="lucide:chevron-down"
            width={15}
            height={15}
            className={cn('shrink-0 text-muted transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      {!balancesHidden && (
        <PendingAssetAmount amount={pendingAmount} symbol={formatSymbol(group.symbol)} />
      )}
      {!directAsset && expanded && (
        <div
          role="region"
          aria-label={`${formatSymbol(group.symbol)} network balances`}
          className="divide-y divide-border/70 border-t border-border/70"
        >
          {group.entries.map(entry => (
            <PortfolioAssetBalanceRow
              key={entry.asset.asset.id}
              entry={entry}
              domain={domain}
              prices={prices}
              balancesHidden={balancesHidden}
              confidentialZec={confidentialZec}
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
