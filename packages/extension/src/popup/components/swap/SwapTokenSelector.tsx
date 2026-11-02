import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { PortfolioReadModel } from '@/core/portfolio'
import { TokenSelector, type TokenSelectorProps } from '../tokens/TokenSelector'
import { ListSkeleton } from '../ui/skeleton'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { isPortfolioModelForScope, readCachedPortfolio } from '@/popup/services/portfolio-cache'
import type { AdditionalReceiveTargetsView } from '@/popup/services/receive-targets-client'
import { receiveTargetsClient } from '@/popup/services/receive-targets-client'
import { buildWalletSwapSourceBalances } from '@/popup/services/swap-page-model'

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
  'tokens' | 'onSelect' | 'balances'
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
  const [tokens, setTokens] = useState(initialTokens)
  const [loading, setLoading] = useState(true)
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
    <TokenSelector
      {...props}
      stableCatalogOrder
      tokens={tokens}
      balances={balances}
      catalogLoading={loading}
      onSelect={token => {
        const selected = tokens.find(
          candidate =>
            candidate.assetId === token.assetId && candidate.blockchain === token.blockchain
        )
        if (selected) onSelect(selected, scopedPortfolio)
      }}
    />
  )
}
