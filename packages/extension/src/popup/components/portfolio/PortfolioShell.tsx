import { useMemo, useState } from 'react'
import { useSwapTokenCatalog } from '@/popup/hooks/useSwapTokenCatalog'
import { Icon } from '@iconify/react'
import { formatFiatAmount } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import tokenViewIcon from '@/images/portfolio-token-view.svg'
import chainViewIcon from '@/images/portfolio-chain-view.svg'
import type { PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Network } from '@/types'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Tooltip } from '@/popup/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'
import { NetworkFilter, NetworkFilterToolbar } from '@/popup/components/common/NetworkFilter'
import type { AssetDomain } from '@/popup/services/asset-domains'
import {
  PortfolioAssetGroupCard,
  PortfolioChainAssetRow,
  PortfolioAssetRowContent,
  portfolioAssetRowClassName
} from './PortfolioAssetGroupCard'
import { NearConfidentialHoldingRow } from './NearConfidentialHoldingRow'
import {
  buildPortfolioDisplay,
  getPortfolioChainBalanceStatus,
  getPortfolioChainSection,
  type PortfolioAssetGroup
} from '@/popup/services/portfolio-presentation'

type PortfolioViewMode = 'assets' | 'chains'

interface PortfolioShellProps {
  readonly domain: AssetDomain
  readonly model: PortfolioReadModel
  readonly sourceModel: PortfolioReadModel
  readonly network: Network
  readonly prices: AssetPriceReadModel | null
  readonly priceStatus?: 'loading' | 'ready' | 'error'
  readonly balancesHidden?: boolean
  readonly view: PortfolioViewMode
  readonly onViewChange: (view: PortfolioViewMode) => void
  readonly chainListExpanded: boolean
  readonly onChainListExpandedChange: (expanded: boolean) => void
  readonly refreshing: boolean
  readonly refreshDisabled: boolean
  readonly selectedChainIds: readonly string[]
  readonly onSelectedChainIdsChange: (chainIds: readonly string[]) => void
  readonly onSelectAsset?: (assetId: string) => void
  readonly onSelectConfidentialAsset?: (tokenId: string) => void
  readonly onRefresh?: () => void
  readonly onManageTokens?: () => void
}

function StatePanel({
  icon,
  title,
  description,
  tone = 'empty'
}: {
  readonly icon: string
  readonly title: string
  readonly description?: string
  readonly tone?: 'empty' | 'error'
}) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-foreground/5">
        <Icon icon={icon} width={24} height={24} className="text-muted" />
      </div>
      <p className={cn('text-sm font-medium', tone === 'empty' && 'text-muted')}>{title}</p>
      {description && (
        <p className="mt-1 max-w-[260px] text-xs leading-5 text-muted">{description}</p>
      )}
    </div>
  )
}

function LoadingPanel() {
  return (
    <div role="status" aria-label="Loading portfolio" className="space-y-2 px-4 py-3">
      {[0, 1, 2].map(index => (
        <div
          key={index}
          className="flex min-h-[68px] animate-pulse items-center gap-3 rounded-xl bg-card px-3 py-2.5"
        >
          <div className="size-9 shrink-0 rounded-full bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-20 rounded bg-foreground/10" />
            <div className="h-2.5 w-24 rounded bg-foreground/5" />
          </div>
          <div className="h-3 w-16 rounded bg-foreground/10" />
        </div>
      ))}
      <span className="sr-only">Loading balances from enabled networks.</span>
    </div>
  )
}

function BalanceReadError({
  chain,
  hasBalance = false,
  onRetry,
  disabled
}: {
  readonly chain: PortfolioChainView
  readonly hasBalance?: boolean
  readonly onRetry?: () => void
  readonly disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span role="status" className="text-muted">
        {hasBalance ? 'Unable to update balance' : 'Balance unavailable'}
      </span>
      {onRetry && (
        <button
          type="button"
          aria-label={`Retry ${chain.chain.displayName} balance`}
          disabled={disabled}
          onClick={onRetry}
          className="wallet-interactive shrink-0 rounded px-1 py-1 text-primary disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary"
        >
          Retry
        </button>
      )}
    </div>
  )
}

function UnavailableChainBalance({
  chain,
  balancesHidden = false,
  onRetry,
  disabled
}: {
  readonly chain: PortfolioChainView
  readonly balancesHidden?: boolean
  readonly onRetry?: () => void
  readonly disabled?: boolean
}) {
  if (chain.chain.family === 'zcash') {
    return (
      <div
        role="status"
        aria-label="ZEC balance unavailable"
        className={portfolioAssetRowClassName}
      >
        <PortfolioAssetRowContent
          icon={
            <TokenIcon
              symbol="ZEC"
              nativeChain="zcash"
              blockchain="zcash"
              size={36}
              className="shrink-0"
            />
          }
          title={<p className="truncate text-base font-medium">ZEC</p>}
          subtitle={<BalanceReadError chain={chain} onRetry={onRetry} disabled={disabled} />}
          balance={
            balancesHidden ? (
              <>
                <p className="text-base font-medium">••••</p>
                <p className="mt-0.5 text-xs text-muted">••••</p>
              </>
            ) : (
              <span className="text-xs text-muted">Unavailable</span>
            )
          }
        />
      </div>
    )
  }
  return (
    <div
      role="status"
      aria-label={`${chain.chain.displayName} balance unavailable`}
      className="flex min-h-16 items-center gap-3 rounded-xl bg-card/60 px-3 py-3"
    >
      <ChainIcon
        chain={resolveChainIconAlias(chain.chain.family, chain.chain.displayName, chain.chain.id)}
        width={32}
        height={32}
        showTooltip={false}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{chain.chain.displayName}</p>
        <BalanceReadError chain={chain} onRetry={onRetry} disabled={disabled} />
      </div>
      <span className="text-xs text-muted">Unavailable</span>
    </div>
  )
}

function PortfolioViewIcon({
  view,
  active
}: {
  readonly view: PortfolioViewMode
  readonly active: boolean
}) {
  const icon = view === 'assets' ? tokenViewIcon : chainViewIcon

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 items-center justify-center text-[var(--color-wallet-secondary)] opacity-50 transition-colors',
        active && 'text-foreground opacity-100'
      )}
    >
      <span
        className="block size-5 bg-current"
        style={{
          WebkitMask: `url(${icon}) center / 20px 20px no-repeat`,
          mask: `url(${icon}) center / 20px 20px no-repeat`
        }}
      />
    </span>
  )
}

export function PortfolioShell({
  model,
  sourceModel,
  network,
  domain,
  prices: sourcePrices,
  priceStatus = 'ready',
  balancesHidden = false,
  view,
  onViewChange,
  chainListExpanded,
  onChainListExpandedChange,
  refreshing,
  refreshDisabled,
  selectedChainIds: requestedChainIds,
  onSelectedChainIdsChange,
  onSelectAsset,
  onSelectConfidentialAsset,
  onRefresh,
  onManageTokens
}: PortfolioShellProps) {
  const {
    prices,
    confidentialZec,
    selectedChainIds,
    visibleConfidential,
    separateConfidential,
    primaryAssetGroups,
    lowValueAssetGroups,
    sortedChains,
    networkOptions,
    pendingStarterZcash,
    unavailableChains,
    hasPendingBalances
  } = useMemo(
    () =>
      buildPortfolioDisplay({
        model,
        sourceModel,
        network,
        domain,
        sourcePrices,
        selectedChainIds: requestedChainIds,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
      }),
    [domain, model, network, requestedChainIds, sourceModel, sourcePrices]
  )
  const selectAsset = (assetId: string) => {
    if (confidentialZec?.displayAsset && assetId === confidentialZec.assetId) {
      const tokenId = confidentialZec.mergedHolding?.entry.asset.tokenId
      if (tokenId) onSelectConfidentialAsset?.(tokenId)
    } else {
      onSelectAsset?.(assetId)
    }
  }
  const [expandedChainIds, setExpandedChainIds] = useState<ReadonlySet<string>>(() => new Set())
  const swapCatalog = useSwapTokenCatalog() ?? undefined
  const [lowValueExpanded, setLowValueExpanded] = useState(false)

  const displayedChains = chainListExpanded ? sortedChains : sortedChains.slice(0, 3)
  const showContent = model.status === 'ready' || model.status === 'partial'
  // Balances arrive from cache before prices resolve; show price/fiat skeletons
  // instead of a bare em dash until the first price model lands.
  const pricesLoading = priceStatus === 'loading'

  const renderAssetGroup = (group: PortfolioAssetGroup, scope: string) => {
    const key = `${scope}:${group.key}`
    const unavailableZcash = group.entries.find(
      ({ chain }) =>
        chain.chain.family === 'zcash' && getPortfolioChainBalanceStatus(chain) === 'unavailable'
    )?.chain
    return (
      <div key={key}>
        <PortfolioAssetGroupCard
          domain={domain}
          group={group}
          prices={prices}
          confidentialZec={confidentialZec}
          balancesHidden={balancesHidden}
          expanded={false}
          pricesLoading={pricesLoading}
          onSelectAsset={selectAsset}
          directAsset
          swapCatalog={swapCatalog}
        />
        {unavailableZcash && (
          <div className="px-4 pb-2 pl-16">
            <BalanceReadError
              chain={unavailableZcash}
              hasBalance={!confidentialZec?.displayAsset}
              onRetry={onRefresh}
              disabled={refreshDisabled}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <section
      aria-label={domain === 'shield' ? 'Shield assets' : 'Portfolio'}
      className="flex min-h-0 flex-1 flex-col"
    >
      <h2 className="sr-only">Portfolio</h2>
      <NetworkFilterToolbar>
        <NetworkFilter
          ariaLabelPrefix="Filter portfolio by network"
          options={networkOptions}
          selectedIds={selectedChainIds}
          onSelectionChange={onSelectedChainIdsChange}
        />

        <div className="flex shrink-0 items-center gap-1">
          {refreshing && (
            <span role="status" aria-label="Portfolio data is syncing" className="sr-only">
              Syncing portfolio
            </span>
          )}
          <div
            role="group"
            aria-label="Portfolio view"
            className="flex h-8 items-center gap-0.5 rounded-lg bg-[var(--home-toolbar-surface,var(--color-wallet-surface))] p-1"
          >
            <Tooltip content="View by token" side="bottom">
              <button
                type="button"
                aria-label="Show token view"
                aria-pressed={view === 'assets'}
                onClick={() => onViewChange('assets')}
                className="wallet-interactive flex size-6 items-center justify-center rounded-md hover:bg-wallet-selected active:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 aria-pressed:bg-wallet-selected"
              >
                <PortfolioViewIcon view="assets" active={view === 'assets'} />
              </button>
            </Tooltip>
            <Tooltip content="View by network" side="bottom">
              <button
                type="button"
                aria-label="Show chain view"
                aria-pressed={view === 'chains'}
                onClick={() => onViewChange('chains')}
                className="wallet-interactive flex size-6 items-center justify-center rounded-md hover:bg-wallet-selected active:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 aria-pressed:bg-wallet-selected"
              >
                <PortfolioViewIcon view="chains" active={view === 'chains'} />
              </button>
            </Tooltip>
          </div>
          {(onRefresh || onManageTokens) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Portfolio options"
                  className="wallet-interactive flex h-8 w-6 items-center justify-center rounded-lg text-wallet-secondary hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                >
                  <Icon icon="lucide:ellipsis" width={16} height={16} className="rotate-90" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[var(--color-wallet-surface)]">
                {onManageTokens && (
                  <DropdownMenuItem onSelect={onManageTokens}>Manage tokens</DropdownMenuItem>
                )}
                {onRefresh && (
                  <DropdownMenuItem disabled={refreshDisabled} onSelect={onRefresh}>
                    Refresh list
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </NetworkFilterToolbar>

      <div className="min-h-0 flex-1 pb-4">
        {model.status === 'loading' && visibleConfidential.length === 0 ? (
          <LoadingPanel />
        ) : model.status === 'error' &&
          unavailableChains.length === 0 &&
          visibleConfidential.length === 0 ? (
          <StatePanel
            icon="lucide:wifi-off"
            title="Unable to load portfolio"
            description="Noir Wallet is reconnecting automatically."
            tone="error"
          />
        ) : model.status === 'empty' && visibleConfidential.length === 0 ? (
          <StatePanel
            icon="lucide:layers"
            title={domain === 'all' ? 'No networks available' : 'No assets found'}
          />
        ) : showContent && selectedChainIds.length === 0 ? (
          <StatePanel icon="lucide:network" title="No network selected" />
        ) : showContent &&
          view === 'assets' &&
          primaryAssetGroups.length === 0 &&
          lowValueAssetGroups.length === 0 &&
          visibleConfidential.length === 0 &&
          unavailableChains.length === 0 &&
          !hasPendingBalances ? (
          <StatePanel
            icon="lucide:wallet-cards"
            title={selectedChainIds.length === 1 ? 'No assets on this network' : 'No assets found'}
          />
        ) : view === 'assets' ? (
          <div className="pb-2">
            {pendingStarterZcash && (
              <button
                type="button"
                aria-label={`View ZEC details on ${pendingStarterZcash.chain.displayName}`}
                className={cn(
                  portfolioAssetRowClassName,
                  'wallet-interactive hover:bg-foreground/[0.03] active:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary'
                )}
                onClick={() => selectAsset(`${pendingStarterZcash.chain.id}/slip44:133`)}
              >
                <PortfolioAssetRowContent
                  icon={<TokenIcon symbol="ZEC" nativeChain="zcash" size={36} />}
                  title={<p className="truncate text-base font-medium">ZEC</p>}
                  subtitle={null}
                  balance={
                    <span className="text-xs text-muted" role="status">
                      {balancesHidden ? '••••' : 'Syncing'}
                    </span>
                  }
                />
              </button>
            )}
            {primaryAssetGroups.map(group => renderAssetGroup(group, 'assets:all'))}
            {separateConfidential.map(({ entry, chain }) => (
              <NearConfidentialHoldingRow
                key={entry.asset.tokenId}
                entry={entry}
                chain={chain?.chain}
                showProvider={domain !== 'all'}
                balancesHidden={balancesHidden}
                pricesLoading={pricesLoading}
                onClick={() => onSelectConfidentialAsset?.(entry.asset.tokenId)}
              />
            ))}
            {unavailableChains.map(chain => (
              <UnavailableChainBalance
                key={chain.chain.id}
                chain={chain}
                balancesHidden={balancesHidden}
                onRetry={onRefresh}
                disabled={refreshDisabled}
              />
            ))}
            {lowValueAssetGroups.length > 0 && (
              <section>
                <div className="mx-4">
                  <button
                    type="button"
                    aria-expanded={lowValueExpanded}
                    aria-label={`${lowValueExpanded ? 'Collapse' : 'Expand'} low value assets`}
                    onClick={() => setLowValueExpanded(current => !current)}
                    className="wallet-interactive flex min-h-11 w-full items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                  >
                    <Icon icon="lucide:archive" width={16} height={16} className="text-muted" />
                    <span className="min-w-0 flex-1 text-sm font-medium">Low value</span>
                    <span className="text-xs text-muted">{lowValueAssetGroups.length} Assets</span>
                    <Icon
                      icon="lucide:chevron-down"
                      width={13}
                      height={13}
                      className={cn(
                        'text-muted transition-transform',
                        lowValueExpanded && 'rotate-180'
                      )}
                    />
                  </button>
                </div>
                {lowValueExpanded && (
                  <div className="space-y-2">
                    {lowValueAssetGroups.map(group => renderAssetGroup(group, 'assets:low-value'))}
                  </div>
                )}
              </section>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border pb-2">
            {displayedChains.map(chain => {
              const expanded = expandedChainIds.has(chain.chain.id)
              const { balanceStatus, chainFiat, hasNativeBalance, separateHoldings, assets } =
                getPortfolioChainSection(chain, prices, visibleConfidential, confidentialZec)
              return (
                <section
                  key={chain.chain.id}
                  className="overflow-hidden"
                  aria-label={`${chain.chain.displayName} portfolio`}
                >
                  <button
                    type="button"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${chain.chain.displayName} tokens`}
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedChainIds(current => {
                        const next = new Set(current)
                        if (next.has(chain.chain.id)) next.delete(chain.chain.id)
                        else next.add(chain.chain.id)
                        return next
                      })
                    }
                    className="wallet-interactive flex min-h-[66px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-foreground/5 active:bg-foreground/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                  >
                    <ChainIcon
                      chain={resolveChainIconAlias(
                        chain.chain.family,
                        chain.chain.displayName,
                        chain.chain.id
                      )}
                      width={32}
                      height={32}
                      className="shrink-0 rounded-[6px]"
                      showTooltip={false}
                    />
                    <span className="min-w-0 flex-1 truncate text-base font-medium">
                      {chain.chain.displayName}
                    </span>
                    {!balancesHidden &&
                    chainFiat === null &&
                    pricesLoading &&
                    balanceStatus !== 'loading' ? (
                      <Skeleton className="h-3 w-14" />
                    ) : (
                      <span className="text-base font-medium">
                        {balancesHidden
                          ? '••••'
                          : chainFiat === null
                            ? balanceStatus === 'unavailable' || balanceStatus === 'loading'
                              ? '—'
                              : formatFiatAmount('0', { showSign: true })
                            : formatFiatAmount(chainFiat, { showSign: true })}
                      </span>
                    )}
                    <Icon
                      icon="lucide:chevron-down"
                      width={13}
                      height={13}
                      className={cn('text-muted transition-transform', expanded && 'rotate-180')}
                    />
                  </button>
                  {chain.chain.family === 'zcash' && balanceStatus === 'unavailable' && (
                    <div className="px-4 pb-2 pl-16">
                      <BalanceReadError
                        chain={chain}
                        hasBalance={hasNativeBalance}
                        onRetry={onRefresh}
                        disabled={refreshDisabled}
                      />
                    </div>
                  )}
                  {expanded &&
                    chain.assets.length === 0 &&
                    chain.chain.family !== 'zcash' &&
                    balanceStatus === 'unavailable' && (
                      <UnavailableChainBalance
                        chain={chain}
                        balancesHidden={balancesHidden}
                        onRetry={onRefresh}
                        disabled={refreshDisabled}
                      />
                    )}
                  {expanded && (chain.assets.length > 0 || separateHoldings.length > 0) && (
                    <div
                      role="region"
                      aria-label={`${chain.chain.displayName} token balances`}
                      className="divide-y divide-border/70 border-t border-border/70"
                    >
                      {assets.map(asset => (
                        <PortfolioChainAssetRow
                          key={asset.asset.id}
                          entry={{ asset, chain }}
                          domain={domain}
                          prices={prices}
                          confidentialZec={confidentialZec}
                          balancesHidden={balancesHidden}
                          pricesLoading={pricesLoading}
                          onSelectAsset={selectAsset}
                          swapCatalog={swapCatalog}
                        />
                      ))}
                      {separateHoldings.map(({ entry }) => (
                        <NearConfidentialHoldingRow
                          key={entry.asset.tokenId}
                          entry={entry}
                          chain={chain.chain}
                          showProvider={domain !== 'all'}
                          balancesHidden={balancesHidden}
                          pricesLoading={pricesLoading}
                          onClick={() => onSelectConfidentialAsset?.(entry.asset.tokenId)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
            {separateConfidential
              .filter(item => !item.chain)
              .map(({ entry }) => (
                <NearConfidentialHoldingRow
                  key={entry.asset.tokenId}
                  entry={entry}
                  showProvider={domain !== 'all'}
                  balancesHidden={balancesHidden}
                  pricesLoading={pricesLoading}
                  onClick={() => onSelectConfidentialAsset?.(entry.asset.tokenId)}
                />
              ))}
            {sortedChains.length > 3 && (
              <button
                type="button"
                aria-expanded={chainListExpanded}
                onClick={() => onChainListExpandedChange(!chainListExpanded)}
                className="wallet-interactive flex min-h-11 w-full items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-primary hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              >
                {chainListExpanded ? 'Collapse' : 'View more'}
                <Icon
                  icon={chainListExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
                  width={14}
                  height={14}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
