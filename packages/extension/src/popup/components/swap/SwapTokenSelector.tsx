import { startTransition, useEffect, useMemo, useState } from 'react'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { TokenSelector, type TokenSelectorProps } from '../tokens/TokenSelector'
import {
  findVerifiedRheaSwapToken,
  toWalletEvmSwapToken
} from '@/popup/services/token-address-discovery'
import { ListSkeleton } from '../ui/skeleton'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
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
  readonly onSelect: (token: RheaSwapToken) => void
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
            tokens,
            portfolio: scopedPortfolio,
            receiveTargets: scopedReceiveTargets,
            zcashAvailable,
            evmExecutionMode
          })
        : undefined,
    [tokens, scopedPortfolio, scopedReceiveTargets, zcashAvailable, evmExecutionMode]
  )
  const defaultTokens = useMemo(
    () => selectDefaultSwapTokens(tokens, curatedRows, { balances, customAssets }),
    [tokens, curatedRows, balances, customAssets]
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
        balances={balances}
        catalogLoading={loading}
        onDiscoveredToken={result => {
          const matched =
            findVerifiedRheaSwapToken(result.candidate, tokens) ??
            toWalletEvmSwapToken(result.candidate)
          if (!matched) return 'Select an available EVM network'
          onSelect(matched)
        }}
        onSelect={token => {
          const selected = tokens.find(
            candidate =>
              candidate.assetId === token.assetId && candidate.blockchain === token.blockchain
          )
          if (selected) onSelect(selected)
        }}
      />
    </div>
  )
}
