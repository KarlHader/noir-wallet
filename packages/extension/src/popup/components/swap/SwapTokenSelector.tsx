import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from '@/core/services/rhea-swap'
import { isZecToken, type SwapToken } from '@/core/services/intents-api'
import type { Network } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import {
  TokenSelector,
  type TokenSelectorExtraItem,
  type TokenSelectorProps
} from '../tokens/TokenSelector'
import {
  findVerifiedRheaSwapToken,
  preferWalletEvmQuoteToken,
  toWalletEvmQuoteToken,
  toWalletEvmSwapToken
} from '@/popup/services/token-address-discovery'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import type { AdditionalReceiveTargetsView } from '@/popup/services/receive-targets-client'
import { receiveTargetsClient } from '@/popup/services/receive-targets-client'
import { buildWalletSwapSourceBalances } from '@/popup/services/swap-page-model'
import { resolveAccountAvailableRaw } from '@/popup/services/transfer-availability'
import { filterManuallyHiddenSwapTokens } from '@/popup/services/swap-token-visibility'
import { useManagedTokenCatalog } from '@/popup/hooks/useManagedTokenCatalog'
import { useCachedAssetPrices } from '@/popup/hooks/useCachedAssetPrices'
import { findAssetPrice } from '@/core/prices'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap/rhea-swap-asset-identity'
import { safeBig } from '@/lib/big'
import {
  getSwapCatalogDisplaySeeds,
  mergeTokenCatalogs,
  readCachedTokenCatalogByChain
} from '@/popup/services/swap-catalog-loading'

interface SelectorFilter {
  readonly search: string
  readonly network: string
}

function swapTokenKey(token: SwapToken): string {
  const route = token as RheaSwapToken
  const address = /^[1-9]\d*$/.test(route.rheaChainId)
    ? route.rheaAddress.toLowerCase()
    : route.rheaAddress
  return `${route.rheaChainId}:${address}:${route.assetId}:${route.decimals}:${route.isNative}`
}

function swapTokenAssetRoute(token: RheaSwapToken): string {
  return `${token.rheaChainId}:${token.isNative ? 'native' : token.rheaAddress.toLowerCase()}:${token.decimals}`
}

interface SwapBalanceScope {
  readonly scopeKey: string
  readonly walletId: string
  readonly accountId: string
  readonly receiveTargets: AdditionalReceiveTargetsView | null
  readonly zcashAvailable: string
  readonly evmExecutionMode: 'main' | 'private'
}

interface SwapTokenSelectorProps extends Omit<
  TokenSelectorProps,
  'tokens' | 'onSelect' | 'balances' | 'onDiscoveredToken'
> {
  readonly initialTokens: readonly RheaSwapToken[]
  readonly loadTokens: (
    filter: SelectorFilter,
    onTokens: (tokens: readonly RheaSwapToken[]) => void,
    isCancelled: () => boolean
  ) => Promise<readonly RheaSwapToken[]>
  readonly onSelect: (token: RheaSwapToken) => void
  readonly balanceScope?: SwapBalanceScope
  readonly resolveItems?: (tokens: readonly RheaSwapToken[]) => Readonly<{
    tokens: readonly RheaSwapToken[]
    extraItems: readonly TokenSelectorExtraItem[]
  }>
  readonly filterLocalTokens?: (tokens: readonly RheaSwapToken[]) => readonly RheaSwapToken[]
  readonly scopeNetwork?: Network
  readonly openingWalletPointer?: Readonly<{ walletId: string | null; accountId: string | null }>
  readonly onScopeInvalidated?: () => void
  readonly catalogDirection?: 'from' | 'cross-chain-to'
}

export function SwapTokenSelector({
  initialTokens,
  loadTokens,
  onSelect,
  balanceScope,
  resolveItems,
  filterLocalTokens,
  scopeNetwork,
  openingWalletPointer,
  onScopeInvalidated,
  catalogDirection,
  ...props
}: SwapTokenSelectorProps) {
  const scopeInvalidated = useRef(false)
  const openingScope = useRef(
    (() => {
      const state = useWalletStore.getState()
      return {
        network: scopeNetwork ?? state.currentNetwork,
        walletId: openingWalletPointer ? openingWalletPointer.walletId : state.currentWalletId,
        accountId: openingWalletPointer ? openingWalletPointer.accountId : state.currentAccountId,
        scopedWalletId: props.accountScope?.walletId ?? balanceScope?.walletId ?? null,
        scopedAccountId: props.accountScope?.accountId ?? balanceScope?.accountId ?? null
      }
    })()
  )
  const [catalogTokens, setTokens] = useState(initialTokens)
  const [filter, setFilter] = useState<SelectorFilter>({ search: '', network: 'all' })
  const [loadingNetwork, setLoadingNetwork] = useState<string | null>(null)
  const [catalogErrorKey, setCatalogErrorKey] = useState<string | null>(null)
  const [retryRequest, setRetryRequest] = useState(0)
  const handleFilterChange = useCallback((next: SelectorFilter) => {
    if (scopeInvalidated.current) return
    setFilter(current =>
      current.search === next.search && current.network === next.network ? current : next
    )
  }, [])
  const loadedNetworks = useRef(new Set<string>())
  const loadTokensRef = useRef(loadTokens)
  loadTokensRef.current = loadTokens
  useEffect(() => {
    const opening = openingScope.current
    const invalidate = () => {
      if (scopeInvalidated.current) return
      scopeInvalidated.current = true
      onScopeInvalidated?.()
    }
    const check = () => {
      const state = useWalletStore.getState()
      if (state.currentNetwork !== opening.network) return invalidate()
      if (opening.walletId || opening.accountId) {
        if (
          state.currentWalletId !== opening.walletId ||
          state.currentAccountId !== opening.accountId
        )
          invalidate()
        return
      }
      if (
        (state.currentWalletId || state.currentAccountId) &&
        (state.currentWalletId !== opening.scopedWalletId ||
          state.currentAccountId !== opening.scopedAccountId)
      )
        invalidate()
    }
    const onAccountContextChanged = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'ACCOUNT_CONTEXT_CHANGED'
      )
        invalidate()
    }
    const unsubscribe = useWalletStore.subscribe(check)
    chrome.runtime.onMessage.addListener(onAccountContextChanged)
    check()
    return () => {
      unsubscribe()
      chrome.runtime.onMessage.removeListener(onAccountContextChanged)
    }
  }, [onScopeInvalidated])
  const configuredChainIds = useMemo(
    () =>
      props.availableNetworks?.flatMap(network => {
        if (network.disabledReason) return []
        const chain = RHEA_SWAP_CHAIN_CATALOG.find(candidate => candidate.blockchain === network.id)
        return chain ? [chain.tokenListChainId] : []
      }),
    [props.availableNetworks]
  )
  const chainIdsKey = useMemo(
    () =>
      [...new Set(configuredChainIds ?? catalogTokens.map(token => token.tokenListChainId))]
        .sort((a, b) => a - b)
        .join(','),
    [catalogTokens, configuredChainIds]
  )
  const chainIds = useMemo(
    () => (chainIdsKey ? chainIdsKey.split(',').map(Number) : []),
    [chainIdsKey]
  )
  useEffect(() => {
    if (!catalogDirection || chainIds.length === 0) return
    const cached = readCachedTokenCatalogByChain(catalogDirection, chainIds)
    if (cached.length > 0)
      startTransition(() => setTokens(current => mergeTokenCatalogs(current, cached)))
  }, [catalogDirection, chainIds])
  const activeNetwork = useWalletStore(state => state.currentNetwork)
  const {
    rows: managedRows,
    hiddenAssetIds,
    ready: managedReady
  } = useManagedTokenCatalog({
    network: scopeNetwork ?? activeNetwork,
    walletId: props.accountScope?.walletId ?? balanceScope?.walletId ?? null,
    accountId: props.accountScope?.accountId ?? balanceScope?.accountId ?? null
  })
  const [receiveTargetsSnapshot, setReceiveTargetsSnapshot] = useState(() => ({
    scope: balanceScope?.scopeKey,
    value: balanceScope?.receiveTargets ?? null
  }))
  const receiveTargets =
    receiveTargetsSnapshot.scope === balanceScope?.scopeKey
      ? (receiveTargetsSnapshot.value ?? balanceScope?.receiveTargets ?? null)
      : (balanceScope?.receiveTargets ?? null)
  const walletId = balanceScope?.walletId ?? null
  const accountId = balanceScope?.accountId ?? null
  const sharedPortfolio = usePortfolioSnapshot(walletId, accountId, {
    enabled: balanceScope !== undefined
  })
  const scopedPortfolio = sharedPortfolio.model
  const scopedReceiveTargets =
    receiveTargets?.keyDomainId === walletId && receiveTargets.accountId === accountId
      ? receiveTargets
      : null
  const scopedAccountPortfolio =
    scopedPortfolio?.scope.keyDomainId === walletId && scopedPortfolio.scope.accountId === accountId
      ? scopedPortfolio
      : null
  const { tokens, defaultRoutes } = useMemo(() => {
    const configured = new Set(chainIds)
    const defaultRoutes = new Set<string>()
    const catalog = catalogTokens.filter(token => !token.isDisplaySeed)
    const byRoute = new Map<string, RheaSwapToken>()
    for (const token of catalog) {
      const route = swapTokenAssetRoute(token)
      if (!byRoute.has(route)) byRoute.set(route, token)
    }
    const held: RheaSwapToken[] = []
    if (scopedAccountPortfolio && balanceScope) {
      for (const asset of scopedAccountPortfolio.assets) {
        if (!asset.asset.chainId.startsWith('eip155:')) continue
        try {
          if (
            BigInt(resolveAccountAvailableRaw(asset.balance, balanceScope.evmExecutionMode)) <= 0n
          )
            continue
        } catch {
          continue
        }
        const walletToken = toWalletEvmQuoteToken(asset)
        if (!walletToken || !configured.has(walletToken.tokenListChainId)) continue
        const route = swapTokenAssetRoute(walletToken)
        defaultRoutes.add(route)
        const preferred = preferWalletEvmQuoteToken(asset, byRoute.get(route))
        if (!preferred || byRoute.get(route) === preferred) continue
        held.push(preferred)
        byRoute.set(route, preferred)
      }
    }
    const managed = managedRows.flatMap(asset => {
      const token = toWalletEvmSwapToken({
        assetId: asset.assetId,
        chainId: asset.chainId,
        contractAddress: asset.reference,
        metadata: asset.metadata
      })
      if (!token || !configured.has(token.tokenListChainId)) return []
      const route = swapTokenAssetRoute(token)
      defaultRoutes.add(route)
      if (byRoute.has(route)) return []
      byRoute.set(route, token)
      return [token]
    })
    const seeds = [
      ...catalogTokens.filter(token => token.isDisplaySeed),
      ...getSwapCatalogDisplaySeeds(chainIds)
    ].flatMap(seed => {
      const route = swapTokenAssetRoute(seed)
      if (byRoute.has(route)) return []
      byRoute.set(route, seed)
      return [seed]
    })
    return { tokens: mergeTokenCatalogs(catalog, held, managed, seeds), defaultRoutes }
  }, [catalogTokens, chainIds, scopedAccountPortfolio, balanceScope, managedRows])
  const visibleTokens = useMemo(
    () =>
      !managedReady
        ? tokens.filter(token => token.isNative)
        : filterManuallyHiddenSwapTokens(tokens, hiddenAssetIds),
    [tokens, hiddenAssetIds, managedReady]
  )
  const localTokens = useMemo(
    () => filterLocalTokens?.(visibleTokens) ?? visibleTokens,
    [filterLocalTokens, visibleTokens]
  )
  const resolvedItems = useMemo(
    () =>
      resolveItems?.(localTokens) ?? { tokens: localTokens, extraItems: props.extraItems ?? [] },
    [resolveItems, localTokens, props.extraItems]
  )
  const guardedExtraItems = useMemo(
    () =>
      resolvedItems.extraItems.map(item => ({
        ...item,
        onSelect: () => {
          if (!scopeInvalidated.current) item.onSelect()
        }
      })),
    [resolvedItems.extraItems]
  )
  useEffect(() => {
    if (!walletId || !accountId || scopedReceiveTargets) return
    let cancelled = false
    void receiveTargetsClient
      .getAdditionalTargets({ keyDomainId: walletId, accountId })
      .then(targets => {
        if (!cancelled) setReceiveTargetsSnapshot({ scope: balanceScope?.scopeKey, value: targets })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [walletId, accountId, balanceScope?.scopeKey, scopedReceiveTargets])
  const zcashAvailable = balanceScope?.zcashAvailable
  const evmExecutionMode = balanceScope?.evmExecutionMode
  const balances = useMemo(
    () =>
      zcashAvailable !== undefined && evmExecutionMode
        ? buildWalletSwapSourceBalances({
            tokens: resolvedItems.tokens,
            portfolio: scopedPortfolio,
            receiveTargets: scopedReceiveTargets,
            zcashAvailable,
            evmExecutionMode
          })
        : undefined,
    [resolvedItems.tokens, scopedPortfolio, scopedReceiveTargets, zcashAvailable, evmExecutionMode]
  )
  const network = scopeNetwork ?? activeNetwork
  const prices = useCachedAssetPrices(network, !!balanceScope)
  const pricesByTokenKey = useMemo(() => {
    if (!prices || !balances) return undefined
    const displayPrices = new Map<string, string>()
    const zecAssetId = resolveRheaSwapCanonicalAssetId(ZEC_ZCASH_ASSET, network)
    for (const token of resolvedItems.tokens) {
      if (!balances.has(token.assetId)) continue
      const evmChainId = /^[1-9]\d*$/.test(token.rheaChainId) ? `eip155:${token.rheaChainId}` : null
      const assetId = isZecToken(token)
        ? zecAssetId
        : evmChainId
          ? scopedAccountPortfolio?.assets.find(
              ({ asset, metadata }) =>
                asset.chainId === evmChainId &&
                metadata.decimals === token.decimals &&
                (token.isNative
                  ? asset.kind === 'native'
                  : asset.namespace === 'erc20' &&
                    asset.reference === token.contractAddress?.toLowerCase())
            )?.asset.id
          : resolveRheaSwapCanonicalAssetId(token.assetId, network)
      const price = assetId ? findAssetPrice(prices, assetId)?.priceUsd : undefined
      if (price && safeBig(price).gt(0)) displayPrices.set(swapTokenKey(token), price)
    }
    return displayPrices
  }, [balances, network, prices, resolvedItems.tokens, scopedAccountPortfolio])
  const defaultTokens = useMemo(
    () =>
      resolvedItems.tokens.filter(
        token =>
          token.isNative ||
          defaultRoutes.has(swapTokenAssetRoute(token)) ||
          (props.selectedToken && swapTokenKey(token) === swapTokenKey(props.selectedToken))
      ),
    [resolvedItems.tokens, defaultRoutes, props.selectedToken]
  )
  useEffect(() => {
    const { search, network } = filter
    const requestKey = `${network}:${search}`
    if (scopeInvalidated.current || !search || loadedNetworks.current.has(network)) {
      setLoadingNetwork(null)
      return
    }
    let cancelled = false
    setLoadingNetwork(network)
    setCatalogErrorKey(null)
    let received = false
    const returnedNetworks = new Set<string>()
    const accept = (next: readonly RheaSwapToken[]) => {
      if (cancelled || scopeInvalidated.current) return
      received = true
      for (const token of next) {
        if (!token.isDisplaySeed) returnedNetworks.add(token.blockchain)
      }
      if (next.length === 0) return
      startTransition(() => setTokens(current => mergeTokenCatalogs(current, next)))
    }
    void loadTokensRef
      .current(filter, accept, () => cancelled || scopeInvalidated.current)
      .then(next => {
        if (cancelled || scopeInvalidated.current) return
        if (!received) accept(next)
        for (const returned of returnedNetworks) loadedNetworks.current.add(returned)
        const availableNetworks = (props.availableNetworks ?? []).filter(
          option => !option.disabledReason
        )
        if (
          network === 'all' &&
          availableNetworks.length > 0 &&
          availableNetworks.every(option => returnedNetworks.has(option.id))
        )
          loadedNetworks.current.add('all')
      })
      .catch(() => {
        if (!cancelled && !scopeInvalidated.current) setCatalogErrorKey(requestKey)
      })
      .finally(() => {
        if (!cancelled && !scopeInvalidated.current) setLoadingNetwork(null)
      })
    return () => {
      cancelled = true
    }
  }, [filter, retryRequest])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TokenSelector
        {...props}
        accountScope={
          props.accountScope ??
          (balanceScope
            ? { walletId: balanceScope.walletId, accountId: balanceScope.accountId }
            : null)
        }
        stableCatalogOrder
        tokenKey={swapTokenKey}
        tokens={resolvedItems.tokens}
        extraItems={guardedExtraItems}
        defaultTokens={defaultTokens}
        defaultCatalogLoading={false}
        balances={balances}
        pricesByTokenKey={pricesByTokenKey}
        catalogLoading={loadingNetwork === filter.network}
        catalogError={catalogErrorKey === `${filter.network}:${filter.search}`}
        onRetryCatalog={() => setRetryRequest(current => current + 1)}
        onFilterChange={handleFilterChange}
        onDiscoveredToken={result => {
          if (scopeInvalidated.current) return 'Account changed'
          const matched =
            findVerifiedRheaSwapToken(result.candidate, tokens) ??
            toWalletEvmSwapToken(result.candidate)
          if (!matched) return 'Select an available EVM network'
          if (!scopeInvalidated.current) onSelect(matched)
        }}
        onSelect={token => {
          if (!scopeInvalidated.current) onSelect(token as RheaSwapToken)
        }}
      />
    </div>
  )
}
