import type { PortfolioChainView } from '@/core/portfolio'

const BASE_RECOVERY_DELAY_MS = 1_000
const MAX_RECOVERY_DELAY_MS = 30_000

export function hasPortfolioBalanceRefreshIssue(chains: readonly PortfolioChainView[]): boolean {
  return chains.some(
    chain =>
      chain.status === 'error' ||
      chain.errorCodes.length > 0 ||
      (chain.chain.family !== 'zcash' && chain.status === 'loading' && chain.assets.length === 0)
  )
}

export function getPortfolioRecoveryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('Invalid Portfolio recovery attempt')
  }
  return Math.min(BASE_RECOVERY_DELAY_MS * 2 ** attempt, MAX_RECOVERY_DELAY_MS)
}
