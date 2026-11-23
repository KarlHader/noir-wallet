import type { PortfolioReadModel } from '@/core/portfolio'
import { evmWalletClient } from './evm-wallet-client'

export {
  PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS,
  portfolioChainIdsForAutomaticRefresh,
  portfolioChainIdsNeedingRefresh,
  shouldRefreshPortfolioFromNetwork
} from '@/core/portfolio'

export interface PortfolioCacheScope {
  readonly walletId: string
  readonly accountId: string
  readonly endpointRuntimeKey: string
}

interface PortfolioRefreshOptions {
  readonly forceDiscovery?: boolean
  readonly forceRefresh?: boolean
  readonly refreshConfidential?: boolean
  readonly allowStaleOnError?: boolean
  readonly refreshChainIds?: readonly string[]
  readonly additionalChainIds?: readonly string[]
}

export function isPortfolioModelForScope(
  model: PortfolioReadModel | null,
  walletId: string | null,
  accountId: string | null
): model is PortfolioReadModel {
  return model?.scope.keyDomainId === walletId && model.scope.accountId === accountId
}

export async function readCachedPortfolio(
  scope: Pick<PortfolioCacheScope, 'walletId' | 'accountId'> & { readonly detailAssetId?: string }
): Promise<PortfolioReadModel | null> {
  const cached = await evmWalletClient.getPortfolio('read', {
    expectedWalletId: scope.walletId,
    expectedAccountId: scope.accountId,
    detailAssetId: scope.detailAssetId
  })
  return isPortfolioModelForScope(cached, scope.walletId, scope.accountId) ? cached : null
}

export async function refreshPortfolioFromCache(
  scope: PortfolioCacheScope,
  cached: PortfolioReadModel | null,
  options: PortfolioRefreshOptions = {}
): Promise<PortfolioReadModel | null> {
  const scopedCached = isPortfolioModelForScope(cached, scope.walletId, scope.accountId)
    ? cached
    : null
  try {
    const refreshed = await evmWalletClient.getPortfolio('refresh', {
      forceDiscovery: options.forceDiscovery,
      refreshConfidential: options.refreshConfidential,
      chainIds:
        options.refreshChainIds?.length || options.additionalChainIds?.length
          ? Object.freeze([
              ...new Set([
                ...(options.refreshChainIds ?? []),
                ...(options.additionalChainIds ?? [])
              ])
            ])
          : undefined,
      automatic: options.forceRefresh !== true && options.forceDiscovery !== true,
      expectedWalletId: scope.walletId,
      expectedAccountId: scope.accountId
    })
    if (!isPortfolioModelForScope(refreshed, scope.walletId, scope.accountId)) {
      throw new Error('Portfolio response does not match the active Account')
    }
    return refreshed
  } catch (error) {
    if (scopedCached && options.allowStaleOnError !== false) return scopedCached
    throw error
  }
}
