import { useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import Big from '@/lib/big'
import { formatFiatAmount } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import tokenViewIcon from '@/images/portfolio-token-view.svg'
import chainViewIcon from '@/images/portfolio-chain-view.svg'
import type { PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { Tooltip } from '@/popup/components/ui/tooltip'
import { NetworkFilter } from '@/popup/components/common/NetworkFilter'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import {
  ZcashSyncProgress,
  type ZcashSyncProgressState
} from '@/popup/components/common/ZcashSyncProgress'
import { resolveLowValueUsdThreshold } from './portfolio-prices'
import { PortfolioAssetGroupCard, PortfolioChainAssetRow } from './PortfolioAssetGroupCard'
import {
  buildPortfolioAssetGroups,
  getPortfolioChainUsdValue,
  getPortfolioChainBalanceStatus,
  partitionPortfolioAssetGroups,
  partitionPortfolioAssets,
  sortPortfolioAssets,
  sortPortfolioChains,
  type PortfolioAssetGroup
} from '@/popup/services/portfolio-presentation'

export type PortfolioViewMode = 'assets' | 'chains'

interface PortfolioShellProps {
  readonly model: PortfolioReadModel
  readonly prices: AssetPriceReadModel | null
  readonly priceStatus?: 'loading' | 'ready' | 'error'
  readonly balancesHidden?: boolean
  readonly zcashSyncState?: ZcashSyncProgressState
  readonly initialView?: PortfolioViewMode
  readonly view?: PortfolioViewMode
  readonly onViewChange?: (view: PortfolioViewMode) => void
  readonly refreshing?: boolean
  readonly refreshDisabled?: boolean
  readonly selectedChainIds?: readonly string[]
  readonly onSelectedChainIdsChange?: (chainIds: readonly string[]) => void
  readonly onSelectAsset?: (assetId: string) => void
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

function UnloadedChainBalance({ chain }: { readonly chain: PortfolioChainView }) {
  const unavailable = getPortfolioChainBalanceStatus(chain) === 'unavailable'
  return (
    <div
      role="status"
      aria-label={`${chain.chain.displayName} balance ${unavailable ? 'unavailable' : 'loading'}`}
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
        <p className="mt-0.5 text-xs text-muted">
          {unavailable ? 'Balance unavailable' : 'Loading balance'}
        </p>
      </div>
      {unavailable ? <span className="text-muted">—</span> : <Skeleton className="h-4 w-16" />}
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
        'flex size-5 items-center justify-center rounded text-[#7e8a93] opacity-50 transition-colors',
        active && 'bg-white/10 text-white opacity-100'
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
  prices,
  priceStatus = 'ready',
  balancesHidden = false,
  zcashSyncState,
  initialView = 'assets',
  view: controlledView,
  onViewChange,
  refreshing = false,
  refreshDisabled = refreshing,
  selectedChainIds: controlledSelectedChainIds,
  onSelectedChainIdsChange,
  onSelectAsset,
  onRefresh,
  onManageTokens
}: PortfolioShellProps) {
  const [localView, setLocalView] = useState<PortfolioViewMode>(initialView)
  const view = controlledView ?? localView
  const setView = onViewChange ?? setLocalView
  const [localSelectedChainIds, setLocalSelectedChainIds] = useState<readonly string[]>(() =>
    model.chains
      .filter(chain => isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__))
      .map(chain => chain.chain.id)
  )
  const selectableChains = useMemo(
    () =>
      model.chains.filter(chain =>
        isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__)
      ),
    [model.chains]
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
  const [expandedChainIds, setExpandedChainIds] = useState<ReadonlySet<string>>(() => new Set())
  const [lowValueExpanded, setLowValueExpanded] = useState(false)
  const [expandedLowValueChainIds, setExpandedLowValueChainIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const filteredChains = useMemo(
    () => selectableChains.filter(chain => selectedChainIds.includes(chain.chain.id)),
    [selectableChains, selectedChainIds]
  )
  const visibleChains = filteredChains
  const assetGroups = useMemo(
    () =>
      buildPortfolioAssetGroups(visibleChains, prices, {
        includeZeroBalanceNativeAssets: visibleChains.length === 1
      }),
    [prices, visibleChains]
  )
  const lowValueUsdThreshold = useMemo(
    () => new Big(resolveLowValueUsdThreshold(model, prices)),
    [model, prices]
  )
  const { primaryAssetGroups, lowValueAssetGroups } = useMemo(
    () => partitionPortfolioAssetGroups(assetGroups, prices, lowValueUsdThreshold),
    [assetGroups, lowValueUsdThreshold, prices]
  )
  const sortedChains = useMemo(
    () => sortPortfolioChains(visibleChains, prices),
    [prices, visibleChains]
  )
  const sortedNetworkOptions = useMemo(
    () => sortPortfolioChains(selectableChains, prices),
    [selectableChains, prices]
  )
  const showContent = model.status === 'ready' || model.status === 'partial'
  const unloadedChains = visibleChains.filter(
    chain => chain.assets.length === 0 && getPortfolioChainBalanceStatus(chain) !== 'ready'
  )
  const zcashChain = visibleChains.find(chain => chain.chain.family === 'zcash')
  const zcashBalanceStatus = zcashChain ? getPortfolioChainBalanceStatus(zcashChain) : 'ready'
  // Balances arrive from cache before prices resolve; show price/fiat skeletons
  // instead of a bare em dash until the first price model lands.
  const pricesLoading = priceStatus === 'loading'

  const renderAssetGroup = (group: PortfolioAssetGroup, scope: string) => {
    const key = `${scope}:${group.key}`
    return (
      <PortfolioAssetGroupCard
        key={key}
        group={group}
        prices={prices}
        balancesHidden={balancesHidden}
        expanded={false}
        pricesLoading={pricesLoading}
        onSelectAsset={onSelectAsset}
        directAsset
      />
    )
  }

  return (
    <section aria-label="Portfolio" className="flex min-h-0 flex-1 flex-col">
      <h2 className="sr-only">Portfolio</h2>
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-3">
        <NetworkFilter
          ariaLabelPrefix="Filter portfolio by network"
          options={sortedNetworkOptions.map(chain => chain.chain)}
          selectedIds={selectedChainIds}
          onSelectionChange={setSelectedChainIds}
        />

        <div role="group" aria-label="Portfolio view" className="flex items-center gap-1.5">
          {zcashSyncState && <ZcashSyncProgress {...zcashSyncState} />}
          {!zcashSyncState && zcashBalanceStatus !== 'ready' && (
            <span
              role="status"
              aria-label={`Zcash balance ${zcashBalanceStatus}`}
              className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-white/5 px-2 text-[10px] text-muted"
            >
              <Icon
                icon={
                  zcashBalanceStatus === 'unavailable' ? 'lucide:wifi-off' : 'lucide:refresh-cw'
                }
                width={10}
                height={10}
                className={zcashBalanceStatus === 'unavailable' ? undefined : 'animate-spin'}
              />
              {zcashBalanceStatus === 'unavailable'
                ? 'ZEC unavailable'
                : zcashBalanceStatus === 'loading'
                  ? 'Loading ZEC'
                  : 'Updating ZEC'}
            </span>
          )}
          {refreshing && (
            <span role="status" aria-label="Portfolio data is syncing" className="sr-only">
              Syncing portfolio
            </span>
          )}
          {onRefresh && (
            <Tooltip content="Refresh portfolio balances and prices." side="bottom">
              <button
                type="button"
                aria-label="Refresh portfolio"
                onClick={onRefresh}
                disabled={refreshDisabled}
                className="flex size-5 items-center justify-center text-muted transition-colors hover:text-foreground disabled:cursor-wait disabled:text-primary"
              >
                <Icon
                  icon="lucide:refresh-cw"
                  width={15}
                  height={15}
                  className={cn(refreshDisabled && 'animate-spin')}
                />
              </button>
            </Tooltip>
          )}
          {onManageTokens && (
            <Tooltip content="Manage portfolio tokens." side="bottom">
              <button
                type="button"
                aria-label="Manage Tokens"
                onClick={onManageTokens}
                className="flex size-5 items-center justify-center text-muted transition-colors hover:text-foreground"
              >
                <Icon icon="lucide:plus" width={16} height={16} />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Group the portfolio by asset." side="bottom">
            <button
              type="button"
              aria-label="Show token view"
              aria-pressed={view === 'assets'}
              onClick={() => setView('assets')}
              className="flex size-5 items-center justify-center"
            >
              <PortfolioViewIcon view="assets" active={view === 'assets'} />
            </button>
          </Tooltip>
          <Tooltip content="Group the portfolio by network." side="bottom">
            <button
              type="button"
              aria-label="Show chain view"
              aria-pressed={view === 'chains'}
              onClick={() => setView('chains')}
              className="flex size-5 items-center justify-center"
            >
              <PortfolioViewIcon view="chains" active={view === 'chains'} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 pb-4">
        {model.status === 'loading' ? (
          <LoadingPanel />
        ) : model.status === 'error' ? (
          <StatePanel
            icon="lucide:wifi-off"
            title="Unable to load portfolio"
            description="Noir Wallet is reconnecting automatically."
          />
        ) : model.status === 'empty' ? (
          <StatePanel icon="lucide:layers" title="No networks available" />
        ) : showContent && selectedChainIds.length === 0 ? (
          <StatePanel icon="lucide:network" title="No network selected" />
        ) : showContent &&
          view === 'assets' &&
          assetGroups.length === 0 &&
          unloadedChains.length === 0 ? (
          <StatePanel
            icon="lucide:wallet-cards"
            title={selectedChainIds.length === 1 ? 'No assets on this network' : 'No assets found'}
          />
        ) : view === 'assets' ? (
          <div className="space-y-2 px-4 pb-2">
            {primaryAssetGroups.map(group => renderAssetGroup(group, 'assets:all'))}
            {unloadedChains.map(chain => (
              <UnloadedChainBalance key={chain.chain.id} chain={chain} />
            ))}
            {lowValueAssetGroups.length > 0 && (
              <section className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
                <button
                  type="button"
                  aria-expanded={lowValueExpanded}
                  aria-label={`${lowValueExpanded ? 'Collapse' : 'Expand'} low value assets`}
                  onClick={() => setLowValueExpanded(current => !current)}
                  className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
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
                {lowValueExpanded && (
                  <div className="space-y-2 border-t border-border/60 p-2">
                    {lowValueAssetGroups.map(group => renderAssetGroup(group, 'assets:low-value'))}
                  </div>
                )}
              </section>
            )}
          </div>
        ) : (
          <div className="space-y-2 px-4 pb-2">
            {sortedChains.map(chain => {
              const expanded = expandedChainIds.has(chain.chain.id)
              const chainFiat = getPortfolioChainUsdValue(chain, prices)
              const sortedAssets = sortPortfolioAssets(chain.assets, prices)
              const { primaryAssets, lowValueAssets } = partitionPortfolioAssets(
                sortedAssets,
                prices,
                lowValueUsdThreshold
              )
              const chainLowValueExpanded = expandedLowValueChainIds.has(chain.chain.id)
              return (
                <section
                  key={chain.chain.id}
                  className="overflow-hidden rounded-xl bg-card/60"
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
                    className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    <ChainIcon
                      chain={resolveChainIconAlias(
                        chain.chain.family,
                        chain.chain.displayName,
                        chain.chain.id
                      )}
                      width={18}
                      height={18}
                      className="shrink-0 rounded-[5px]"
                      showTooltip={false}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {chain.chain.displayName}
                    </span>
                    {!balancesHidden &&
                    chain.assets.length === 0 &&
                    getPortfolioChainBalanceStatus(chain) === 'loading' ? (
                      <Skeleton className="h-3 w-14" />
                    ) : !balancesHidden && chainFiat === null && pricesLoading ? (
                      <Skeleton className="h-3 w-14" />
                    ) : (
                      <span className="font-mono text-xs text-muted">
                        {balancesHidden
                          ? '••••'
                          : chainFiat === null
                            ? '—'
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
                  {expanded &&
                    chain.assets.length === 0 &&
                    getPortfolioChainBalanceStatus(chain) !== 'ready' && (
                      <UnloadedChainBalance chain={chain} />
                    )}
                  {expanded && chain.assets.length > 0 && (
                    <div
                      role="region"
                      aria-label={`${chain.chain.displayName} token balances`}
                      className="divide-y divide-border/70 border-t border-border/70"
                    >
                      {primaryAssets.map(asset => (
                        <PortfolioChainAssetRow
                          key={asset.asset.id}
                          entry={{ asset, chain }}
                          prices={prices}
                          balancesHidden={balancesHidden}
                          pricesLoading={pricesLoading}
                          onSelectAsset={onSelectAsset}
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
                            className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs text-muted hover:bg-white/[0.03]"
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
                                prices={prices}
                                balancesHidden={balancesHidden}
                                pricesLoading={pricesLoading}
                                onSelectAsset={onSelectAsset}
                              />
                            ))}
                        </>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
