import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { SwapToken } from '@/core/services/intents-api'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { getEvmNetworkConfigs } from '@/config/networks'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import type { PortfolioReadModel } from '@/core/portfolio'
import { TokenSelector, type TokenSelectorProps } from '../tokens/TokenSelector'
import {
  findVerifiedRheaSwapToken,
  toWalletEvmSwapToken
} from '@/popup/services/token-address-discovery'
import { ListSkeleton } from '../ui/skeleton'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { isPortfolioModelForScope, readCachedPortfolio } from '@/popup/services/portfolio-cache'
import type { AdditionalReceiveTargetsView } from '@/popup/services/receive-targets-client'
import { receiveTargetsClient } from '@/popup/services/receive-targets-client'
import { buildWalletSwapSourceBalances } from '@/popup/services/swap-page-model'
import type { UserEvmAssetRecord } from '@/core/chains/user-assets'
import { userEvmAssetsClient } from '@/popup/services/user-evm-assets-client'
import {
  loadCuratedSwapTokens,
  readCachedCuratedSwapTokens,
  selectDefaultSwapTokens,
  type CuratedSwapTokenRow
} from '@/popup/services/swap-curated-catalog'

interface SwapBalanceScope {
  readonly scopeKey: string
  readonly walletId: string
  readonly accountId: string
  readonly initialPortfolio: PortfolioReadModel | null
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
    onTokens: (tokens: readonly RheaSwapToken[]) => void,
    isCancelled: () => boolean
  ) => Promise<readonly RheaSwapToken[]>
  readonly onSelect: (token: RheaSwapToken, portfolio: PortfolioReadModel | null) => void
  readonly balanceScope?: SwapBalanceScope
}

export function SwapTokenSelector({
  initialTokens,
  loadTokens,
  onSelect,
  balanceScope,
  ...props
}: SwapTokenSelectorProps) {
  const [catalogTokens, setTokens] = useState(initialTokens)
  const [loading, setLoading] = useState(true)
  const chainIdsKey = useMemo(
    () =>
      [...new Set(catalogTokens.map(token => token.tokenListChainId))]
        .sort((a, b) => a - b)
        .join(','),
    [catalogTokens]
  )
  const chainIds = useMemo(
    () => (chainIdsKey ? chainIdsKey.split(',').map(Number) : []),
    [chainIdsKey]
  )
  const [curatedRows, setCuratedRows] = useState<readonly CuratedSwapTokenRow[]>(() =>
    readCachedCuratedSwapTokens(chainIds)
  )
  const [curatedLoading, setCuratedLoading] = useState(true)
  const [customAssets, setCustomAssets] = useState<readonly UserEvmAssetRecord[]>([])
  const tokens = useMemo(() => {
    const known = new Set(
      catalogTokens.map(token => `${token.rheaChainId}:${token.rheaAddress.toLowerCase()}`)
    )
    const custom = customAssets.flatMap(asset => {
      const token = toWalletEvmSwapToken(asset)
      return token &&
        chainIds.includes(token.tokenListChainId) &&
        !known.has(`${token.rheaChainId}:${token.rheaAddress.toLowerCase()}`)
        ? [token]
        : []
    })
    return custom.length ? [...catalogTokens, ...custom] : catalogTokens
  }, [catalogTokens, customAssets, chainIds])
  useEffect(() => {
    let cancelled = false
    setCuratedRows(readCachedCuratedSwapTokens(chainIds))
    setCuratedLoading(true)
    void loadCuratedSwapTokens(chainIds, rows => {
      if (!cancelled) setCuratedRows(rows)
    })
      .then(rows => {
        if (!cancelled) setCuratedRows(rows)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCuratedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chainIds])
  useEffect(() => {
    let cancelled = false
    setCustomAssets([])
    void userEvmAssetsClient
      .list()
      .then(assets => {
        if (!cancelled) setCustomAssets(assets)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [balanceScope?.scopeKey])
  const [portfolioSnapshot, setPortfolioSnapshot] = useState(() => ({
    scope: balanceScope?.scopeKey,
    value: balanceScope?.initialPortfolio ?? null
  }))
  const [receiveTargetsSnapshot, setReceiveTargetsSnapshot] = useState(() => ({
    scope: balanceScope?.scopeKey,
    value: balanceScope?.receiveTargets ?? null
  }))
  const portfolio =
    portfolioSnapshot.scope === balanceScope?.scopeKey
      ? portfolioSnapshot.value
      : (balanceScope?.initialPortfolio ?? null)
  const receiveTargets =
    receiveTargetsSnapshot.scope === balanceScope?.scopeKey
      ? receiveTargetsSnapshot.value
      : (balanceScope?.receiveTargets ?? null)
  const walletId = balanceScope?.walletId ?? null
  const accountId = balanceScope?.accountId ?? null
  const scopedPortfolio = isPortfolioModelForScope(portfolio, walletId, accountId)
    ? portfolio
    : null
  const scopedReceiveTargets =
    receiveTargets?.keyDomainId === walletId && receiveTargets.accountId === accountId
      ? receiveTargets
      : null
  const portfolioReadSequence = useRef(0)
  const readLatestPortfolio = useCallback(async () => {
    if (!walletId || !accountId) return
    const sequence = ++portfolioReadSequence.current
    const latest = await readCachedPortfolio({ walletId, accountId })
    if (sequence === portfolioReadSequence.current && latest)
      setPortfolioSnapshot({ scope: balanceScope?.scopeKey, value: latest })
  }, [walletId, accountId, balanceScope?.scopeKey])
  useEffect(() => {
    void readLatestPortfolio().catch(() => {})
    return () => {
      portfolioReadSequence.current += 1
    }
  }, [readLatestPortfolio])
  usePortfolioUpdates(walletId, accountId, readLatestPortfolio)
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
  const balances = useMemo(
    () =>
      balanceScope
        ? buildWalletSwapSourceBalances({
            tokens,
            portfolio: scopedPortfolio,
            receiveTargets: scopedReceiveTargets,
            zcashAvailable: balanceScope.zcashAvailable,
            evmExecutionMode: balanceScope.evmExecutionMode
          })
        : undefined,
    [tokens, scopedPortfolio, scopedReceiveTargets, balanceScope]
  )
  const [catalogBalanceState, setCatalogBalanceState] = useState(
    () => new Map<string, { status: 'loading' | 'error' | 'ready'; amount?: string }>()
  )
  const [balanceRetryEpoch, setBalanceRetryEpoch] = useState(0)
  const [visibleCandidates, setVisibleCandidates] = useState<readonly RheaSwapToken[]>([])
  const requestedCatalogBalances = useRef(new Set<string>())
  const balanceScopeKey = `${balanceScope?.scopeKey ?? ''}:${balanceScope?.evmExecutionMode ?? ''}`
  const activeBalanceScopeKey = useRef(balanceScopeKey)
  const balanceStateScopeKey = useRef(balanceScopeKey)
  const scopedCatalogBalanceState =
    balanceStateScopeKey.current === balanceScopeKey ? catalogBalanceState : new Map()
  useEffect(() => {
    activeBalanceScopeKey.current = balanceScopeKey
    return () => {
      activeBalanceScopeKey.current = ''
    }
  }, [balanceScopeKey])
  useEffect(() => {
    balanceStateScopeKey.current = balanceScopeKey
    requestedCatalogBalances.current.clear()
    setCatalogBalanceState(new Map())
    setVisibleCandidates([])
  }, [balanceScopeKey])
  const onVisibleTokensChange = useCallback(
    (
      visible: readonly SwapToken[],
      filter: { readonly search: string; readonly network: string }
    ) => {
      const next =
        filter.search.trim() || filter.network !== 'all'
          ? visible.slice(0, 8).flatMap(item => {
              const token = tokens.find(
                candidate =>
                  candidate.assetId === item.assetId && candidate.blockchain === item.blockchain
              )
              return token ? [token] : []
            })
          : []
      setVisibleCandidates(previous =>
        previous.length === next.length &&
        previous.every((token, index) => token.assetId === next[index].assetId)
          ? previous
          : next
      )
    },
    [tokens]
  )
  const evmChainIds = useMemo(
    () => new Set(getEvmNetworkConfigs(DEFAULT_NETWORK).map(config => config.chainId)),
    []
  )
  useEffect(() => {
    if (!balanceScope || balanceStateScopeKey.current !== balanceScopeKey) return
    const scopeKey = balanceScopeKey
    const candidates = visibleCandidates.filter(token => {
      const chainId = `eip155:${token.tokenListChainId}` as const
      return (
        evmChainIds.has(chainId) &&
        /^0x[0-9a-fA-F]{40}$/.test(token.contractAddress ?? '') &&
        !balances?.has(token.assetId) &&
        !requestedCatalogBalances.current.has(token.assetId)
      )
    })
    if (candidates.length === 0) return
    for (const token of candidates) {
      if (requestedCatalogBalances.current.size >= 128) {
        requestedCatalogBalances.current.delete(
          requestedCatalogBalances.current.values().next().value!
        )
      }
      requestedCatalogBalances.current.add(token.assetId)
    }
    setCatalogBalanceState(previous => {
      const next = new Map(previous)
      for (const token of candidates) next.set(token.assetId, { status: 'loading' })
      return next
    })
    void (async () => {
      for (let index = 0; index < candidates.length; index += 4) {
        await Promise.all(
          candidates.slice(index, index + 4).map(async token => {
            try {
              const raw = await evmWalletClient.getTokenBalance({
                chainId: `eip155:${token.tokenListChainId}`,
                token: token.contractAddress!,
                walletId: balanceScope.walletId,
                accountId: balanceScope.accountId,
                executionMode: balanceScope.evmExecutionMode
              })
              if (activeBalanceScopeKey.current !== scopeKey) return
              setCatalogBalanceState(previous =>
                new Map(previous).set(token.assetId, {
                  status: 'ready',
                  amount: formatBaseUnitDecimalAmount(raw, token.decimals)
                })
              )
            } catch {
              if (activeBalanceScopeKey.current !== scopeKey) return
              setCatalogBalanceState(previous =>
                new Map(previous).set(token.assetId, { status: 'error' })
              )
            }
          })
        )
      }
    })()
  }, [balanceScope, balanceScopeKey, balances, evmChainIds, visibleCandidates, balanceRetryEpoch])
  const mergedBalances = useMemo(() => {
    if (!balances) return undefined
    const merged = new Map(balances)
    for (const [assetId, result] of scopedCatalogBalanceState) {
      if (result.status === 'ready' && result.amount !== undefined && !merged.has(assetId)) {
        merged.set(assetId, result.amount)
      }
    }
    return merged
  }, [balances, scopedCatalogBalanceState])
  const balanceLoadStates = useMemo(
    () =>
      new Map(
        [...scopedCatalogBalanceState].flatMap(([assetId, result]) =>
          result.status === 'ready' ? [] : [[assetId, result.status] as const]
        )
      ),
    [scopedCatalogBalanceState]
  )
  const retryBalances = useCallback(() => {
    const failed = [...scopedCatalogBalanceState].filter(([, result]) => result.status === 'error')
    if (failed.length === 0) return
    for (const [assetId] of failed) requestedCatalogBalances.current.delete(assetId)
    setCatalogBalanceState(previous => {
      const next = new Map(previous)
      for (const [assetId] of failed) next.delete(assetId)
      return next
    })
    setBalanceRetryEpoch(epoch => epoch + 1)
  }, [scopedCatalogBalanceState])
  const defaultTokens = useMemo(
    () => selectDefaultSwapTokens(tokens, curatedRows, { balances: mergedBalances, customAssets }),
    [tokens, curatedRows, mergedBalances, customAssets]
  )
  useEffect(() => {
    let cancelled = false
    void loadTokens(
      next => startTransition(() => setTokens(next)),
      () => cancelled
    )
      .then(next => {
        if (!cancelled) startTransition(() => setTokens(next))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadTokens])
  if (loading && tokens.length === 0) return <ListSkeleton rows={5} label="Loading tokens" />
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
        tokens={tokens}
        defaultTokens={defaultTokens}
        defaultCatalogLoading={curatedLoading}
        balances={mergedBalances}
        balanceLoadStates={balanceLoadStates}
        onRetryBalances={retryBalances}
        onVisibleTokensChange={onVisibleTokensChange}
        catalogLoading={loading}
        onDiscoveredToken={result => {
          const matched =
            findVerifiedRheaSwapToken(result.candidate, tokens) ??
            toWalletEvmSwapToken(result.candidate)
          if (!matched) return 'Select an available EVM network'
          onSelect(matched, scopedPortfolio)
        }}
        onSelect={token => {
          const selected = tokens.find(
            candidate =>
              candidate.assetId === token.assetId && candidate.blockchain === token.blockchain
          )
          if (selected) onSelect(selected, scopedPortfolio)
        }}
      />
    </div>
  )
}
