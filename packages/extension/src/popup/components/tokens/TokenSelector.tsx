/**
 * Token selector component for Swap and other scenarios
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { Icon } from '@iconify/react'
import { Input } from '../ui/input'
import type { SwapToken } from '@/core/services/intents-api'
import { formatChainName, formatSymbol } from '@/lib/format'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'
import { sortTokensByBalanceValue } from './token-balance-order'
import { ListSkeleton } from '../ui/skeleton'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  compareSwapTokenSearchRelevance,
  matchesSwapTokenSearch
} from '@/popup/services/swap-token-selection'
import { cn } from '@/lib/utils'
import { createDebugRequestId, logDebugTiming } from '@/lib/debug-performance'
import { ChainIcon } from '../common/ChainIcon'
import {
  deferredChainChoices,
  isSelectableSwapBlockchain
} from '@/popup/services/chain-selection-availability'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

const MAX_RENDERED_TOKENS = 100

export interface TokenSelectorProps {
  selectedToken?: SwapToken
  onSelect: (token: SwapToken) => void
  tokens?: readonly SwapToken[]
  balances?: ReadonlyMap<string, string>
  catalogLoading?: boolean
  stableCatalogOrder?: boolean
  excludeAssetId?: string
  emptyMessage?: string
}

export function TokenSelector({
  selectedToken,
  onSelect,
  tokens: providedTokens,
  balances,
  catalogLoading = false,
  stableCatalogOrder = false,
  excludeAssetId,
  emptyMessage = 'No tokens found'
}: TokenSelectorProps) {
  const [search, setSearch] = useState('')
  const [selectedBlockchain, setSelectedBlockchain] = useState('all')
  const [fetchedTokens, setFetchedTokens] = useState<readonly SwapToken[]>([])
  const [fetchedLoading, setFetchedLoading] = useState(providedTokens === undefined)
  const [selectionTraceId] = useState(() => createDebugRequestId('token-selector'))
  const previousRows = useRef<{ filter: string; keys: readonly string[] } | null>(null)
  const [renderWindow, setRenderWindow] = useState({ filter: 'all:', count: MAX_RENDERED_TOKENS })
  const hasProvidedTokens = providedTokens !== undefined
  const tokens = useMemo(
    () =>
      (providedTokens ?? fetchedTokens).filter(token =>
        isSelectableSwapBlockchain(token.blockchain, __ENABLED_CHAIN_FEATURE_FLAGS__)
      ),
    [providedTokens, fetchedTokens]
  )
  const loading = !hasProvidedTokens && fetchedLoading

  useEffect(() => {
    if (hasProvidedTokens) return

    let cancelled = false
    async function loadTokens() {
      setFetchedLoading(true)
      try {
        const cached = await swapTokenCatalogClient.readCached()
        if (!cancelled && cached.length > 0) {
          setFetchedTokens(cached)
          setFetchedLoading(false)
        }
        const refreshed = await swapTokenCatalogClient.refresh()
        if (!cancelled) setFetchedTokens(refreshed)
      } catch {
        // Keep the last usable cached catalog.
      } finally {
        if (!cancelled) setFetchedLoading(false)
      }
    }
    void loadTokens()
    return () => {
      cancelled = true
    }
  }, [hasProvidedTokens])

  const networkOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const token of tokens) {
      if (!options.has(token.blockchain)) {
        options.set(token.blockchain, formatChainName(token.blockchain))
      }
    }
    return [...options].map(([id, label]) => ({ id, label }))
  }, [tokens])
  const effectiveBlockchain =
    selectedBlockchain === 'all' || networkOptions.some(option => option.id === selectedBlockchain)
      ? selectedBlockchain
      : 'all'
  const selectedNetwork = networkOptions.find(option => option.id === effectiveBlockchain)
  const selectedNetworkLabel = selectedNetwork?.label ?? 'All Networks'
  const filterKey = `${effectiveBlockchain}:${search}`
  const filteredTokens = useMemo(() => {
    const startedAt = performance.now()
    const previous =
      stableCatalogOrder && !search && previousRows.current?.filter === filterKey
        ? new Map(previousRows.current.keys.map((key, index) => [key, index]))
        : undefined
    const ranked = [
      ...sortTokensByBalanceValue(
        tokens.filter(token => {
          if (token.assetId === excludeAssetId) return false
          if (effectiveBlockchain !== 'all' && token.blockchain !== effectiveBlockchain)
            return false
          return matchesSwapTokenSearch(token, search)
        }),
        balances,
        previous
      )
    ].sort((left, right) => compareSwapTokenSearchRelevance(left, right, search))
    logDebugTiming(
      selectionTraceId,
      `filter-sort input=${tokens.length} output=${ranked.length} queryLength=${search.length}`,
      startedAt
    )
    return ranked
  }, [
    tokens,
    excludeAssetId,
    effectiveBlockchain,
    search,
    balances,
    selectionTraceId,
    stableCatalogOrder,
    filterKey
  ])
  useEffect(() => {
    previousRows.current = {
      filter: filterKey,
      keys: filteredTokens.map(token => `${token.blockchain}:${token.assetId}`)
    }
  }, [filterKey, filteredTokens])
  const visibleLimit = renderWindow.filter === filterKey ? renderWindow.count : MAX_RENDERED_TOKENS
  const visibleTokens = filteredTokens.slice(0, visibleLimit)

  return (
    <div className="h-[60vh] flex flex-col">
      <div className="py-4 sticky top-0 z-10">
        <Input
          type="text"
          placeholder="Search tokens"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-10"
          autoFocus
          startContent={<Icon icon="lucide:search" className="text-muted" width={16} height={16} />}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Filter assets by network: ${selectedNetworkLabel}`}
              className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-3 text-xs text-foreground transition-colors hover:bg-accent"
            >
              {selectedNetwork ? (
                <ChainIcon
                  chain={selectedNetwork.id}
                  width={16}
                  height={16}
                  className="rounded-[4px]"
                  showTooltip={false}
                  alt=""
                  aria-hidden="true"
                />
              ) : (
                <Icon icon="lucide:network" width={16} height={16} className="text-muted" />
              )}
              <span>{selectedNetworkLabel}</span>
              <Icon icon="lucide:chevron-down" width={13} height={13} className="text-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[180px]">
            <DropdownMenuRadioGroup
              value={effectiveBlockchain}
              onValueChange={setSelectedBlockchain}
            >
              <DropdownMenuRadioItem value="all" className="cursor-pointer">
                <Icon icon="lucide:network" width={16} height={16} className="text-muted" />
                <span>All Networks</span>
              </DropdownMenuRadioItem>
              {networkOptions.map(option => (
                <DropdownMenuRadioItem key={option.id} value={option.id} className="cursor-pointer">
                  <ChainIcon
                    chain={option.id}
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                    showTooltip={false}
                    alt=""
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </DropdownMenuRadioItem>
              ))}
              {deferredChainChoices(__ENABLED_CHAIN_FEATURE_FLAGS__).map(option => (
                <DropdownMenuRadioItem
                  key={option.family}
                  value={`coming-soon:${option.family}`}
                  disabled
                  className="text-muted data-[disabled]:opacity-100"
                >
                  <ChainIcon
                    chain={option.iconAlias}
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                    showTooltip={false}
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="flex-1">{option.label}</span>
                  <span className="text-[10px]">Coming soon</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {catalogLoading && search.trim().length > 0 && (
          <p role="status" className="mt-2 text-xs text-muted">
            Searching more networks...
          </p>
        )}
      </div>
      <div
        className="flex-1 overflow-y-auto"
        onScroll={event => {
          const list = event.currentTarget
          if (
            visibleLimit < filteredTokens.length &&
            list.scrollHeight - list.scrollTop - list.clientHeight < 200
          ) {
            setRenderWindow({ filter: filterKey, count: visibleLimit + MAX_RENDERED_TOKENS })
          }
        }}
      >
        {loading ? (
          <ListSkeleton rows={5} label="Loading tokens" className="px-1" />
        ) : filteredTokens.length === 0 ? (
          catalogLoading ? (
            <ListSkeleton rows={3} label="Searching tokens" className="px-1" />
          ) : (
            <div className="py-8 text-center text-muted">{emptyMessage}</div>
          )
        ) : (
          <>
            {visibleTokens.map(token => {
              const balance = balances?.get(token.assetId)
              const symbol = formatSymbol(token.symbol)
              const chainName = formatChainName(token.blockchain)
              return (
                <button
                  key={`${token.blockchain}-${token.symbol}-${token.assetId}`}
                  onClick={() => onSelect(token)}
                  aria-pressed={selectedToken?.assetId === token.assetId}
                  aria-label={`${symbol} on ${chainName}${balance === undefined ? '' : `, balance ${balance} ${symbol}`}`}
                  className={cn(
                    'flex min-h-[55px] w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-card',
                    selectedToken?.assetId === token.assetId && 'bg-primary/[0.08]'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <TokenIcon token={token} size={30} />
                    <div className="min-w-0 text-left">
                      <p className="truncate font-semibold">{symbol}</p>
                      <p className="truncate text-xs text-muted">{chainName}</p>
                    </div>
                  </div>
                  <div className="min-w-0 max-w-[55%]">
                    {balance !== undefined && (
                      <TokenBalanceDisplay
                        amount={balance}
                        symbol={symbol}
                        priceUsd={token.price}
                      />
                    )}
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
