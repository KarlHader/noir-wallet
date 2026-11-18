import { useCallback } from 'react'
import { usePortfolioSnapshot } from './usePortfolioSnapshot'

export function useHomePortfolio(walletId: string | null, accountId: string | null) {
  const portfolio = usePortfolioSnapshot(walletId, accountId)
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
