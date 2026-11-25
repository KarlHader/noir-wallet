import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import type { FundingSource } from '@/types'
import { ZcashFundingBadge } from '../zcash/ZcashFundingBadge'
import { Icon } from '@iconify/react'
import { RHEA_SWAP_CHAIN_CATALOG } from '@/core/services/rhea-swap'
import type { InspectedTokenAddress } from '@/popup/services/token-address-discovery'
import { formatChainName, formatSymbol } from '@/lib/format'
import { TokenIcon } from '../tokens/TokenIcon'
import { TokenBalanceDisplay } from '../tokens/TokenBalanceDisplay'
import {
  TokenPicker,
  type TokenSelectorNetwork,
  type TokenSelectionItem
} from '../tokens/TokenPicker'
import { sortTokensByBalanceValue } from '@/popup/services/token-balance-order'
import {
  deduplicateNativeEvmSwapDisplayRows,
  getNativeEvmSwapDisplayId,
  rankTokenSearchFields
} from '@/popup/services/swap-token-selection'
import { createDebugRequestId, logDebugTiming } from '@/lib/debug-performance'
import {
  deferredChainChoices,
  isSelectableSwapBlockchain
} from '@/popup/services/chain-selection-availability'
import { useWalletStore } from '@/store/wallet-store'

const defaultTokenKey = (token: SwapToken) => `${token.blockchain}:${token.assetId}`

export interface TokenSelectorExtraItem extends TokenSelectionItem {
  readonly blockchain: string
  readonly searchTerms: readonly string[]
  readonly selected?: boolean
  readonly onSelect: () => void
}

export interface SwapCatalogTokenPickerProps {
  selectedToken?: SwapToken
  onSelect: (token: SwapToken) => void
  tokenKey?: (token: SwapToken) => string
  tokens: readonly SwapToken[]
  defaultTokens?: readonly SwapToken[]
  balances?: ReadonlyMap<string, string>
  pricesByTokenKey?: ReadonlyMap<string, string>
  zcashFundingSource?: FundingSource
  catalogLoading?: boolean
  catalogError?: boolean
  onRetryCatalog?: () => void
  stableCatalogOrder?: boolean
  excludeAssetId?: string
  emptyMessage?: string
  unavailableNetworks?: readonly Readonly<{ id: string; label: string; iconChain: string }>[]
  availableNetworks?: readonly TokenSelectorNetwork[]
  onFilterChange?: (filter: { readonly search: string; readonly network: string }) => void
  onDiscoveredToken?: (result: InspectedTokenAddress) => string | void
  balanceLoadStates?: ReadonlyMap<string, 'loading' | 'error'>
  onRetryBalances?: () => void
  extraItems?: readonly TokenSelectorExtraItem[]
}

export function SwapCatalogTokenPicker({
  selectedToken,
  onSelect,
  tokenKey = defaultTokenKey,
  tokens: providedTokens,
  defaultTokens,
  balances,
  pricesByTokenKey,
  zcashFundingSource,
  catalogLoading = false,
  catalogError = false,
  onRetryCatalog,
  stableCatalogOrder = false,
  excludeAssetId,
  emptyMessage = 'No tokens found',
  unavailableNetworks = [],
  availableNetworks,
  onFilterChange,
  onDiscoveredToken,
  balanceLoadStates,
  onRetryBalances,
  extraItems = []
}: SwapCatalogTokenPickerProps) {
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
  const selectedTokenKey = selectedToken ? tokenKey(selectedToken) : undefined
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
    return deduplicateNativeEvmSwapDisplayRows(ranked, tokenKey, selectedTokenKey)
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
    tokenKey,
    selectedTokenKey
  ])
  useEffect(() => {
    previousRows.current = {
      filter: filterKey,
      keys: filteredTokens.map(token => `${token.blockchain}:${token.assetId}`)
    }
  }, [filterKey, filteredTokens, tokenKey])
  const visibleExtraItems = extraItems.filter(item => {
    if (effectiveBlockchain !== 'all' && item.blockchain !== effectiveBlockchain) return false
    return rankTokenSearchFields(item, deferredSearch) < 99
  })
  let rows: readonly (SwapToken | TokenSelectorExtraItem)[] = filteredTokens
  if (visibleExtraItems.length > 0) {
    rows = [...visibleExtraItems, ...filteredTokens]
    if (deferredSearch.trim()) {
      rows = rows
        .map(row => ({ row, rank: rankTokenSearchFields(row, deferredSearch) }))
        .sort((left, right) => left.rank - right.rank)
        .map(({ row }) => row)
    }
  }
  const toItem = (row: SwapToken | TokenSelectorExtraItem): TokenSelectionItem => {
    if ('onSelect' in row) return row
    const token = row
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
          />
        )
    }
  }
  const discoveryChain = RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.walletFamily === 'evm' && chain.blockchain === effectiveBlockchain
  )
  const selectedDisplayId = selectedToken ? getNativeEvmSwapDisplayId(selectedToken) : null
  const selectedDisplayToken = selectedDisplayId
    ? filteredTokens.find(token => getNativeEvmSwapDisplayId(token) === selectedDisplayId)
    : undefined
  return (
    <TokenPicker
      networks={selectorNetworks}
      filter={{
        search,
        onSearchChange: setSearch,
        selectedNetwork: effectiveBlockchain,
        onNetworkChange: setSelectedBlockchain,
        queryKey: filterKey
      }}
      rows={rows}
      toItem={toItem}
      isDisabled={row => 'onSelect' in row && Boolean(row.disabledReason)}
      selectedKey={
        visibleExtraItems.find(item => item.selected)?.key ??
        (selectedDisplayToken ? tokenKey(selectedDisplayToken) : selectedTokenKey)
      }
      onSelect={row => {
        if ('onSelect' in row) row.onSelect()
        else onSelect(row)
      }}
      loading={rows.length === 0 && catalogLoading}
      emptyMessage={emptyMessage}
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
    />
  )
}
