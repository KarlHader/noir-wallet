/**
 * Token selector component for Swap and other scenarios
 */
import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import type { FundingSource } from '@/types'
import { ZcashFundingBadge } from '../account/ZcashFundingBadge'
import { Icon } from '@iconify/react'
import { RHEA_SWAP_CHAIN_CATALOG } from '@/core/services/rhea-swap'
import type { InspectedTokenAddress } from '@/popup/services/token-address-discovery'
import { formatChainName, formatSymbol } from '@/lib/format'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'
import { TokenSelectorView, type TokenSelectorNetwork } from './TokenSelectorView'
import type { TokenSelectionItem } from './TokenSelectionList'
import { sortTokensByBalanceValue } from './token-balance-order'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { createDebugRequestId, logDebugTiming } from '@/lib/debug-performance'
import {
  deferredChainChoices,
  isSelectableSwapBlockchain
} from '@/popup/services/chain-selection-availability'
import { useWalletStore } from '@/store/wallet-store'

const MAX_RENDERED_TOKENS = 100
const defaultTokenKey = (token: SwapToken) => `${token.blockchain}:${token.assetId}`

export interface TokenSelectorExtraItem extends TokenSelectionItem {
  readonly blockchain: string
  readonly searchTerms: readonly string[]
  readonly lowBalance?: boolean
  readonly selected?: boolean
  readonly onSelect: () => void
}

export interface TokenSelectorProps {
  accountScope?: Readonly<{ walletId: string; accountId: string }> | null
  selectedToken?: SwapToken
  onSelect: (token: SwapToken) => void
  tokenKey?: (token: SwapToken) => string
  tokens: readonly SwapToken[]
  defaultTokens?: readonly SwapToken[]
  defaultCatalogLoading?: boolean
  balances?: ReadonlyMap<string, string>
  pricesByTokenKey?: ReadonlyMap<string, string>
  zcashFundingSource?: FundingSource
  catalogLoading?: boolean
  catalogError?: boolean
  onRetryCatalog?: () => void
  stableCatalogOrder?: boolean
  fullHeight?: boolean
  excludeAssetId?: string
  emptyMessage?: string
  unavailableNetworks?: readonly Readonly<{ id: string; label: string; iconChain: string }>[]
  availableNetworks?: readonly TokenSelectorNetwork[]
  onFilterChange?: (filter: { readonly search: string; readonly network: string }) => void
  onDiscoveredToken?: (result: InspectedTokenAddress) => string | void
  onVisibleTokensChange?: (
    tokens: readonly SwapToken[],
    filter: { readonly search: string; readonly network: string }
  ) => void
  balanceLoadStates?: ReadonlyMap<string, 'loading' | 'error'>
  onRetryBalances?: () => void
  extraItems?: readonly TokenSelectorExtraItem[]
}

export function TokenSelector({
  accountScope,
  selectedToken,
  onSelect,
  tokenKey = defaultTokenKey,
  tokens: providedTokens,
  defaultTokens,
  defaultCatalogLoading = false,
  balances,
  pricesByTokenKey,
  zcashFundingSource,
  catalogLoading = false,
  catalogError = false,
  onRetryCatalog,
  stableCatalogOrder = false,
  fullHeight = false,
  excludeAssetId,
  emptyMessage = 'No tokens found',
  unavailableNetworks = [],
  availableNetworks,
  onFilterChange,
  onDiscoveredToken,
  onVisibleTokensChange,
  balanceLoadStates,
  onRetryBalances,
  extraItems = []
}: TokenSelectorProps) {
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [selectedBlockchain, setSelectedBlockchain] = useState('all')
  const onFilterChangeRef = useRef(onFilterChange)
  onFilterChangeRef.current = onFilterChange
  const [selectionTraceId] = useState(() => createDebugRequestId('token-selector'))
  const previousRows = useRef<{ filter: string; keys: readonly string[] } | null>(null)
  const [renderWindow, setRenderWindow] = useState({ filter: 'all:', count: MAX_RENDERED_TOKENS })
  const tokens = useMemo(
    () =>
      providedTokens.filter(token =>
        isSelectableSwapBlockchain(token.blockchain, __ENABLED_CHAIN_FEATURE_FLAGS__)
      ),
    [providedTokens]
  )

  const networkOptions = useMemo(() => {
    if (availableNetworks) return []
    const options = new Map<string, string>()
    for (const token of tokens) {
      if (!options.has(token.blockchain)) {
        options.set(token.blockchain, formatChainName(token.blockchain))
      }
    }
    for (const item of extraItems) {
      if (!options.has(item.blockchain)) {
        options.set(item.blockchain, formatChainName(item.blockchain))
      }
    }
    return [...options].map(([id, label]) => ({ id, label }))
  }, [tokens, extraItems, availableNetworks])
  const configuredNetworks: readonly TokenSelectorNetwork[] =
    availableNetworks ?? networkOptions.map(option => ({ ...option, iconChain: option.id }))
  const effectiveBlockchain =
    selectedBlockchain === 'all' ||
    configuredNetworks.some(option => option.id === selectedBlockchain && !option.disabledReason)
      ? selectedBlockchain
      : 'all'
  const selectorNetworks = [
    ...configuredNetworks,
    ...unavailableNetworks
      .filter(option => !configuredNetworks.some(available => available.id === option.id))
      .map(option => ({ ...option, disabledReason: 'Swaps are not supported on this network' })),
    ...deferredChainChoices(__ENABLED_CHAIN_FEATURE_FLAGS__).map(option => ({
      id: `coming-soon:${option.family}`,
      label: option.label,
      iconChain: option.iconAlias,
      disabledReason: 'Coming soon'
    }))
  ]
  useEffect(() => {
    onFilterChangeRef.current?.({ search: deferredSearch.trim(), network: effectiveBlockchain })
  }, [deferredSearch, effectiveBlockchain])
  const availableTokenKeys = useMemo(() => new Set(tokens.map(tokenKey)), [tokens, tokenKey])
  const filterKey = `${effectiveBlockchain}:${deferredSearch}`
  const filteredTokens = useMemo(() => {
    const startedAt = performance.now()
    const searching = Boolean(deferredSearch.trim())
    const searchRanks = new Map<SwapToken, number>()
    const previous =
      stableCatalogOrder && !searching && previousRows.current?.filter === filterKey
        ? new Map(previousRows.current.keys.map((key, index) => [key, index]))
        : undefined
    const ranked = [
      ...sortTokensByBalanceValue(
        (searching ? tokens : (defaultTokens ?? tokens)).filter(token => {
          if (!availableTokenKeys.has(tokenKey(token))) return false
          if (token.assetId === excludeAssetId) return false
          if (effectiveBlockchain !== 'all' && token.blockchain !== effectiveBlockchain)
            return false
          if (!searching) return true
          const rank = rankTokenSearchFields(token, deferredSearch)
          searchRanks.set(token, rank)
          return rank < 99
        }),
        balances,
        previous,
        !searching && defaultTokens
          ? new Map(
              defaultTokens.map((token, index) => [`${token.blockchain}:${token.assetId}`, index])
            )
          : undefined
      )
    ]
    if (searching) ranked.sort((left, right) => searchRanks.get(left)! - searchRanks.get(right)!)
    logDebugTiming(
      selectionTraceId,
      `filter-sort input=${tokens.length} output=${ranked.length} queryLength=${deferredSearch.length}`,
      startedAt
    )
    return ranked
  }, [
    tokens,
    defaultTokens,
    excludeAssetId,
    effectiveBlockchain,
    deferredSearch,
    availableTokenKeys,
    balances,
    selectionTraceId,
    stableCatalogOrder,
    filterKey,
    tokenKey
  ])
  useEffect(() => {
    previousRows.current = {
      filter: filterKey,
      keys: filteredTokens.map(token => `${token.blockchain}:${token.assetId}`)
    }
  }, [filterKey, filteredTokens, tokenKey])
  const visibleLimit = renderWindow.filter === filterKey ? renderWindow.count : MAX_RENDERED_TOKENS
  const visibleTokens = useMemo(
    () => filteredTokens.slice(0, visibleLimit),
    [filteredTokens, visibleLimit]
  )
  const visibleExtraItems = extraItems.filter(item => {
    if (effectiveBlockchain !== 'all' && item.blockchain !== effectiveBlockchain) return false
    return rankTokenSearchFields(item, search) < 99
  })
  useEffect(() => {
    onVisibleTokensChange?.(visibleTokens, { search, network: effectiveBlockchain })
  }, [onVisibleTokensChange, visibleTokens, search, effectiveBlockchain])

  const searchRanks = new Map<string, number>([
    ...visibleExtraItems.map(item => [item.key, rankTokenSearchFields(item, search)] as const),
    ...visibleTokens.map(token => [tokenKey(token), rankTokenSearchFields(token, search)] as const)
  ])
  const selectorItems = [
    ...visibleExtraItems,
    ...visibleTokens.map(token => {
      const balance = balances?.get(token.assetId)
      const symbol = formatSymbol(token.symbol)
      const chainName = formatChainName(token.blockchain)
      return {
        key: tokenKey(token),
        symbol,
        symbolSuffix:
          token.blockchain === 'zec' && zcashFundingSource ? (
            <ZcashFundingBadge source={zcashFundingSource} />
          ) : undefined,
        icon: <TokenIcon token={token} size={32} />,
        subtitle: chainName,
        ariaLabel:
          symbol +
          ' on ' +
          chainName +
          (balance === undefined ? '' : ', balance ' + balance + ' ' + symbol),
        balance:
          balance === undefined ? undefined : (
            <TokenBalanceDisplay
              amount={balance}
              symbol={symbol}
              priceUsd={pricesByTokenKey?.get(tokenKey(token)) ?? token.price}
              approximateFiat
            />
          )
      }
    })
  ].sort((left, right) =>
    search.trim() ? (searchRanks.get(left.key) ?? 99) - (searchRanks.get(right.key) ?? 99) : 0
  )
  const discoveryChain = RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.walletFamily === 'evm' && chain.blockchain === effectiveBlockchain
  )
  return (
    <TokenSelectorView
      accountScope={accountScope}
      search={search}
      onSearchChange={setSearch}
      networks={selectorNetworks}
      selectedNetwork={effectiveBlockchain}
      onNetworkChange={setSelectedBlockchain}
      items={selectorItems}
      selectedKey={
        visibleExtraItems.find(item => item.selected)?.key ??
        (selectedToken ? tokenKey(selectedToken) : undefined)
      }
      onSelect={key => {
        const extra = visibleExtraItems.find(item => item.key === key)
        if (extra) {
          extra.onSelect()
          return
        }
        const selected = visibleTokens.find(token => tokenKey(token) === key)
        if (selected) onSelect(selected)
      }}
      loading={
        filteredTokens.length === 0 &&
        visibleExtraItems.length === 0 &&
        (catalogLoading || (!search.trim() && defaultCatalogLoading))
      }
      emptyMessage={emptyMessage}
      fullHeight={fullHeight}
      discovery={
        onDiscoveredToken && currentWalletId && currentAccountId
          ? {
              scopeKey: `${currentNetwork}:${currentWalletId}:${currentAccountId}`,
              chainId: discoveryChain ? `eip155:${discoveryChain.apiChainId}` : null,
              onAdded: onDiscoveredToken
            }
          : undefined
      }
      status={
        <>
          {catalogLoading && search.trim().length > 0 && (
            <p role="status" className="mt-2 text-xs text-muted">
              Searching tokens...
            </p>
          )}
          {catalogError && onRetryCatalog && (
            <button
              type="button"
              onClick={onRetryCatalog}
              className="mt-2 flex items-center gap-1 text-xs text-primary"
            >
              <Icon icon="lucide:refresh-cw" width={14} height={14} /> Retry token search
            </button>
          )}
          {onRetryBalances && [...(balanceLoadStates?.values() ?? [])].includes('error') && (
            <button
              type="button"
              onClick={onRetryBalances}
              className="mt-2 flex items-center gap-1 text-xs text-primary"
            >
              <Icon icon="lucide:refresh-cw" width={14} height={14} /> Retry balances
            </button>
          )}
        </>
      }
      onScroll={event => {
        const list = event.currentTarget
        if (
          visibleLimit < filteredTokens.length &&
          list.scrollHeight - list.scrollTop - list.clientHeight < 200
        ) {
          setRenderWindow({ filter: filterKey, count: visibleLimit + MAX_RENDERED_TOKENS })
        }
      }}
    />
  )
}
