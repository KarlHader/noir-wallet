import { useEffect, useMemo, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
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
import { NetworkFilter } from '@/popup/components/common/NetworkFilter'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import type { AssetDomain } from '@/popup/services/asset-domains'
import { LOW_VALUE_USD_THRESHOLD, withConfidentialAssetPrices } from './portfolio-prices'
import {
  PortfolioAssetGroupCard,
  PortfolioChainAssetRow,
  PortfolioAssetRowContent,
  portfolioAssetRowClassName
} from './PortfolioAssetGroupCard'
import { NearConfidentialHoldingRow } from './NearConfidentialHoldingRow'
import {
  listStandaloneNearConfidentialHoldings,
  resolveNearConfidentialZecRow,
  sumNearConfidentialChainFiat
} from '@/popup/services/near-confidential-holdings'
import {
  buildPortfolioAssetGroups,
  getPortfolioChainUsdValue,
  getPortfolioChainBalanceStatus,
  groupPortfolioDisplayChains,
  partitionPortfolioAssetGroups,
  partitionPortfolioAssets,
  sortPortfolioAssets,
  sortPortfolioChains,
  type PortfolioAssetGroup
} from '@/popup/services/portfolio-presentation'

export type PortfolioViewMode = 'assets' | 'chains'

interface PortfolioShellProps {
  readonly domain?: AssetDomain
  readonly hideToolbar?: boolean
  readonly model: PortfolioReadModel
  readonly sourceModel?: PortfolioReadModel
  readonly network: Network
  readonly prices: AssetPriceReadModel | null
  readonly priceStatus?: 'loading' | 'ready' | 'error'
  readonly balancesHidden?: boolean
  readonly initialView?: PortfolioViewMode
  readonly view?: PortfolioViewMode
  readonly onViewChange?: (view: PortfolioViewMode) => void
  readonly chainListExpanded: boolean
  readonly onChainListExpandedChange: (expanded: boolean) => void
  readonly refreshing?: boolean
  readonly refreshDisabled?: boolean
  readonly selectedChainIds?: readonly string[]
  readonly onSelectedChainIdsChange?: (chainIds: readonly string[]) => void
  readonly onSelectAsset?: (assetId: string) => void
  readonly onSelectConfidentialAsset?: (tokenId: string) => void
  readonly onRefresh?: () => void
  readonly onManageTokens?: () => void
}

function StatePanel({
  icon,
  title,
  description
}: {
  readonly icon: string
  readonly title: string
  readonly description?: string
}) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-foreground/5">
        <Icon icon={icon} width={24} height={24} className="text-muted" />
      </div>
      <p className="text-sm font-medium">{title}</p>
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
          <div className="size-9 shrink-0 rounded-full bg-white/10" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-20 rounded bg-white/10" />
            <div className="h-2.5 w-24 rounded bg-white/5" />
          </div>
          <div className="h-3 w-16 rounded bg-white/10" />
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
        className="shrink-0 rounded-full"
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
        active && 'text-white opacity-100'
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
  domain = 'all',
  hideToolbar = false,
  prices: sourcePrices,
  priceStatus = 'ready',
  balancesHidden = false,
  initialView = 'assets',
  view: controlledView,
  onViewChange,
  chainListExpanded,
  onChainListExpandedChange,
  refreshing = false,
  refreshDisabled = refreshing,
  selectedChainIds: controlledSelectedChainIds,
  onSelectedChainIdsChange,
  onSelectAsset,
  onSelectConfidentialAsset,
  onRefresh,
  onManageTokens
}: PortfolioShellProps) {
  const [localView, setLocalView] = useState<PortfolioViewMode>(initialView)
  const view = controlledView ?? localView
  const setView = onViewChange ?? setLocalView
  const displayModel = model
  const prices = useMemo(
    () => withConfidentialAssetPrices(sourceModel ?? model, sourcePrices),
    [model, sourceModel, sourcePrices]
  )
  const standaloneConfidential = useMemo(
    () =>
      domain === 'all' || domain === 'shield'
        ? listStandaloneNearConfidentialHoldings(model, sourceModel ?? model, prices)
        : [],
    [domain, model, sourceModel, prices]
  )
  const confidentialZec = useMemo(
    () =>
      domain === 'all'
        ? resolveNearConfidentialZecRow(
            model,
            sourceModel ?? model,
            network,
            standaloneConfidential
          )
        : null,
    [domain, model, sourceModel, network, standaloneConfidential]
  )
  const [localSelectedChainIds, setLocalSelectedChainIds] = useState<readonly string[]>(() =>
    displayModel.chains
      .filter(chain => isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__))
      .map(chain => chain.chain.id)
  )
  const selectableChains = useMemo(
    () =>
      displayModel.chains.filter(chain =>
        isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__)
      ),
    [displayModel.chains]
  )
  const availableChainIds = useMemo(
    () => selectableChains.map(chain => chain.chain.id),
    [selectableChains]
  )
  const availableChainIdSet = useMemo(() => new Set<string>(availableChainIds), [availableChainIds])
  const selectedChainIds = (controlledSelectedChainIds ?? localSelectedChainIds).filter(chainId =>
    availableChainIdSet.has(chainId)
  )
  const setSelectedChainIds = onSelectedChainIdsChange ?? setLocalSelectedChainIds
  const visibleConfidential = standaloneConfidential.filter(
    item =>
      (item.chain && selectedChainIds.includes(item.chain.chain.id)) ||
      (!item.chain && selectedChainIds.length === availableChainIds.length)
  )
  const separateConfidential = visibleConfidential.filter(
    item => item !== confidentialZec?.mergedHolding
  )
  const standaloneChainIds = new Set(
    visibleConfidential.flatMap(item => (item.chain ? [item.chain.chain.id] : []))
  )
  const [expandedChainIds, setExpandedChainIds] = useState<ReadonlySet<string>>(() => new Set())
  const [swapCatalog, setSwapCatalog] = useState<readonly SwapToken[]>([])
  useEffect(() => {
    let cancelled = false
    void swapTokenCatalogClient
      .readCached()
      .then(tokens => {
        if (!cancelled) setSwapCatalog(tokens)
      })
      .catch(() => {})
    void swapTokenCatalogClient
      .refresh()
      .then(tokens => {
        if (!cancelled) setSwapCatalog(tokens)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const [lowValueExpanded, setLowValueExpanded] = useState(false)
  const [expandedLowValueChainIds, setExpandedLowValueChainIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const filteredChains = useMemo(
    () => selectableChains.filter(chain => selectedChainIds.includes(chain.chain.id)),
    [selectableChains, selectedChainIds]
  )
  const visibleChains =
    domain === 'all'
      ? filteredChains
      : filteredChains.filter(
          chain =>
            chain.assets.length > 0 ||
            standaloneChainIds.has(chain.chain.id) ||
            getPortfolioChainBalanceStatus(chain) !== 'ready'
        )
  const assetGroups = useMemo(
    () =>
      buildPortfolioAssetGroups(visibleChains, prices, {
        includeZeroBalanceNativeAssets: visibleChains.length === 1
      }),
    [prices, visibleChains]
  )
  const { primaryAssetGroups, lowValueAssetGroups } = useMemo(
    () => partitionPortfolioAssetGroups(assetGroups, prices, LOW_VALUE_USD_THRESHOLD),
    [assetGroups, prices]
  )
  const sortedChains = useMemo(
    () => sortPortfolioChains(groupPortfolioDisplayChains(visibleChains), prices),
    [prices, visibleChains]
  )
  const displayedChains = chainListExpanded ? sortedChains : sortedChains.slice(0, 3)
  const sortedNetworkOptions = useMemo(
    () => sortPortfolioChains(selectableChains, prices),
    [selectableChains, prices]
  )
  const showContent = model.status === 'ready' || model.status === 'partial'
  const unavailableChains = visibleChains.filter(
    chain => chain.assets.length === 0 && getPortfolioChainBalanceStatus(chain) === 'unavailable'
  )
  const hasPendingBalances = visibleChains.some(
    chain => getPortfolioChainBalanceStatus(chain) === 'loading'
  )
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
          onSelectAsset={onSelectAsset}
          directAsset
          swapCatalog={swapCatalog}
        />
        {unavailableZcash && (
          <div className="px-4 pb-2 pl-16">
            <BalanceReadError
              chain={unavailableZcash}
              hasBalance
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
      {!hideToolbar && (
        <div className="flex h-[46px] shrink-0 items-center justify-between px-4 pb-1 pt-2.5">
          <NetworkFilter
            ariaLabelPrefix="Filter portfolio by network"
            options={sortedNetworkOptions.map(chain => chain.chain)}
            selectedIds={selectedChainIds}
            onSelectionChange={setSelectedChainIds}
          />

          <div className="flex shrink-0 items-center gap-2">
            {refreshing && (
              <span role="status" aria-label="Portfolio data is syncing" className="sr-only">
                Syncing portfolio
              </span>
            )}
            <div
              role="group"
              aria-label="Portfolio view"
              className="flex h-8 items-center rounded-xl bg-[var(--color-wallet-surface)] p-1"
            >
              <Tooltip content="View by token" side="bottom">
                <button
                  type="button"
                  aria-label="Show token view"
                  aria-pressed={view === 'assets'}
                  onClick={() => setView('assets')}
                  className="wallet-interactive flex size-6 items-center justify-center rounded-lg hover:bg-[var(--color-wallet-selected)] active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 aria-pressed:bg-[var(--color-wallet-selected)]"
                >
                  <PortfolioViewIcon view="assets" active={view === 'assets'} />
                </button>
              </Tooltip>
              <Tooltip content="View by network" side="bottom">
                <button
                  type="button"
                  aria-label="Show chain view"
                  aria-pressed={view === 'chains'}
                  onClick={() => setView('chains')}
                  className="wallet-interactive flex size-6 items-center justify-center rounded-lg hover:bg-[var(--color-wallet-selected)] active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 aria-pressed:bg-[var(--color-wallet-selected)]"
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
                    className="wallet-interactive flex size-8 items-center justify-center rounded-lg text-[var(--color-wallet-secondary)] hover:bg-white/5 hover:text-foreground active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    <Icon icon="lucide:ellipsis" width={21} height={21} />
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
        </div>
      )}

      <div className="min-h-0 flex-1 pb-4">
        {model.status === 'loading' && visibleConfidential.length === 0 ? (
          <LoadingPanel />
        ) : model.status === 'error' && unavailableChains.length === 0 ? (
          <StatePanel
            icon="lucide:wifi-off"
            title="Unable to load portfolio"
            description="Noir Wallet is reconnecting automatically."
          />
        ) : model.status === 'empty' ? (
          <StatePanel
            icon="lucide:layers"
            title={domain === 'all' ? 'No networks available' : 'No assets found'}
          />
        ) : showContent && selectedChainIds.length === 0 ? (
          <StatePanel icon="lucide:network" title="No network selected" />
        ) : showContent &&
          view === 'assets' &&
          assetGroups.length === 0 &&
          visibleConfidential.length === 0 &&
          unavailableChains.length === 0 &&
          !hasPendingBalances ? (
          <StatePanel
            icon="lucide:wallet-cards"
            title={selectedChainIds.length === 1 ? 'No assets on this network' : 'No assets found'}
          />
        ) : view === 'assets' ? (
          <div className="pb-2">
            {primaryAssetGroups.map(group => renderAssetGroup(group, 'assets:all'))}
            {separateConfidential.map(({ entry, chain }) => (
              <NearConfidentialHoldingRow
                key={entry.asset.tokenId}
                entry={entry}
                chain={chain?.chain}
                showProvider
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
          <div className="divide-y divide-white/[0.08] pb-2">
            {displayedChains.map(chain => {
              const expanded = expandedChainIds.has(chain.chain.id)
              const balanceStatus = getPortfolioChainBalanceStatus(chain)
              const confidentialEntries = visibleConfidential.filter(
                item => item.chain?.chain.id === chain.chain.id
              )
              const chainFiat = sumNearConfidentialChainFiat(
                getPortfolioChainUsdValue(chain, prices),
                confidentialEntries
              )
              const sortedAssets = sortPortfolioAssets(chain.assets, prices)
              const { primaryAssets, lowValueAssets } = partitionPortfolioAssets(
                sortedAssets,
                prices,
                LOW_VALUE_USD_THRESHOLD
              )
              const chainLowValueExpanded = expandedLowValueChainIds.has(chain.chain.id)
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
                    className="wallet-interactive flex min-h-[66px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
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
                        hasBalance={chain.assets.length > 0}
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
                  {expanded && (chain.assets.length > 0 || confidentialEntries.length > 0) && (
                    <div
                      role="region"
                      aria-label={`${chain.chain.displayName} token balances`}
                      className="divide-y divide-border/70 border-t border-border/70"
                    >
                      {primaryAssets.map(asset => (
                        <PortfolioChainAssetRow
                          key={asset.asset.id}
                          entry={{ asset, chain }}
                          domain={domain}
                          prices={prices}
                          confidentialZec={confidentialZec}
                          balancesHidden={balancesHidden}
                          pricesLoading={pricesLoading}
                          onSelectAsset={onSelectAsset}
                          swapCatalog={swapCatalog}
                        />
                      ))}
                      {confidentialEntries
                        .filter(item => item !== confidentialZec?.mergedHolding)
                        .map(({ entry }) => (
                          <NearConfidentialHoldingRow
                            key={entry.asset.tokenId}
                            entry={entry}
                            chain={chain.chain}
                            showProvider
                            balancesHidden={balancesHidden}
                            pricesLoading={pricesLoading}
                            onClick={() => onSelectConfidentialAsset?.(entry.asset.tokenId)}
                          />
                        ))}
                      {lowValueAssets.length > 0 && (
                        <>
                          <button
                            type="button"
                            aria-expanded={chainLowValueExpanded}
                            onClick={() =>
                              setExpandedLowValueChainIds(current => {
                                const next = new Set(current)
                                if (next.has(chain.chain.id)) next.delete(chain.chain.id)
                                else next.add(chain.chain.id)
                                return next
                              })
                            }
                            className="wallet-interactive flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs text-muted hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                          >
                            <Icon icon="lucide:archive" width={14} height={14} />
                            <span className="flex-1">Low value ({lowValueAssets.length})</span>
                            <Icon
                              icon="lucide:chevron-down"
                              width={12}
                              height={12}
                              className={cn(
                                'transition-transform',
                                chainLowValueExpanded && 'rotate-180'
                              )}
                            />
                          </button>
                          {chainLowValueExpanded &&
                            lowValueAssets.map(asset => (
                              <PortfolioChainAssetRow
                                key={asset.asset.id}
                                entry={{ asset, chain }}
                                domain={domain}
                                prices={prices}
                                confidentialZec={confidentialZec}
                                balancesHidden={balancesHidden}
                                pricesLoading={pricesLoading}
                                onSelectAsset={onSelectAsset}
                                swapCatalog={swapCatalog}
                              />
                            ))}
                        </>
                      )}
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
                  showProvider
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
