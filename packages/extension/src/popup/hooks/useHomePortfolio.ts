import { useCallback, useEffect } from 'react'
import { PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS } from '@/core/portfolio'
import { usePortfolioSnapshot } from './usePortfolioSnapshot'

export function useHomePortfolio(walletId: string | null, accountId: string | null) {
  const portfolio = usePortfolioSnapshot(walletId, accountId)
  const { refreshSource, scopeKey } = portfolio
  const evmChainKey = portfolio.model?.chains
    .filter(({ chain }) => chain.family === 'evm')
    .map(({ chain }) => chain.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!scopeKey || !evmChainKey) return

    const chainIds = evmChainKey.split(',')
    const refreshEvmBalances = (force: boolean) => {
      if (document.visibilityState !== 'visible') return
      void refreshSource({
        source: 'chain',
        chainIds,
        force,
        refreshConfidential: false
      }).catch(() => {})
    }
    const startPolling = () =>
      window.setInterval(() => refreshEvmBalances(true), PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS)
    let interval = document.visibilityState === 'visible' ? startPolling() : undefined
    const onVisibilityChange = () => {
      window.clearInterval(interval)
      interval = undefined
      if (document.visibilityState !== 'visible') return
      refreshEvmBalances(false)
      interval = startPolling()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [evmChainKey, refreshSource, scopeKey])

  const refresh = useCallback(
    async (forceDiscovery = false) => {
      await portfolio.refresh(forceDiscovery, { forceDiscovery })
    },
    [portfolio.refresh]
  )
  const readLatest = useCallback(async () => {
    await portfolio.readLatest()
  }, [portfolio.readLatest])

  return { ...portfolio, refresh, readLatest }
}
