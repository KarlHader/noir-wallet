import type { PortfolioReadModel } from '@/core/portfolio'
import { automaticRefreshSession } from './automatic-refresh-session'
import { evmWalletClient } from './evm-wallet-client'

export const PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS = 60_000

const FULL_PORTFOLIO_RESOURCE = 'all-chains'

export interface PortfolioCacheScope {
  readonly walletId: string
  readonly accountId: string
  readonly endpointRuntimeKey: string
}

interface PortfolioRefreshSelection {
  readonly refreshChainIds?: readonly string[]
  readonly additionalChainIds?: readonly string[]
}

interface PortfolioRefreshOptions extends PortfolioRefreshSelection {
  readonly forceDiscovery?: boolean
  readonly forceRefresh?: boolean
}

export function isPortfolioModelForScope(
  model: PortfolioReadModel | null,
  walletId: string | null,
  accountId: string | null
): model is PortfolioReadModel {
  return model?.scope.keyDomainId === walletId && model.scope.accountId === accountId
}

export function portfolioChainIdsNeedingRefresh(
  model: PortfolioReadModel,
  now = Date.now(),
  maxAgeMs = PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS
): readonly string[] {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('Invalid Portfolio cache freshness input')
  }
  return Object.freeze(
    model.chains.flatMap(chain =>
      chain.chain.family !== 'zcash' &&
      (chain.status === 'error' ||
        (chain.status === 'loading' && chain.assets.length === 0) ||
        chain.assets.some(
          asset =>
            asset.freshness !== 'fresh' || asset.updatedAt <= 0 || now - asset.updatedAt >= maxAgeMs
        ))
        ? [chain.chain.id]
        : []
    )
  )
}

export function shouldRefreshPortfolioFromNetwork(
  model: PortfolioReadModel,
  now = Date.now(),
  maxAgeMs = PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS
): boolean {
  return portfolioChainIdsNeedingRefresh(model, now, maxAgeMs).length > 0
}

function refreshScope(scope: PortfolioCacheScope): string {
  return `portfolio:${scope.walletId}:${scope.accountId}:${scope.endpointRuntimeKey}`
}

function uniqueChainIds(chainIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(chainIds)])
}

export function portfolioChainIdsForAutomaticRefresh(
  model: PortfolioReadModel,
  selection: PortfolioRefreshSelection = {},
  now = Date.now(),
  maxAgeMs = PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS
): readonly string[] {
  const allowedChainIds = selection.refreshChainIds ? new Set(selection.refreshChainIds) : undefined
  const cachedChainIds = new Set<string>(model.chains.map(chain => chain.chain.id))
  const staleChainIds = portfolioChainIdsNeedingRefresh(model, now, maxAgeMs).filter(
    chainId => !allowedChainIds || allowedChainIds.has(chainId)
  )
  const missingChainIds = (selection.additionalChainIds ?? []).filter(
    chainId => !cachedChainIds.has(chainId) && (!allowedChainIds || allowedChainIds.has(chainId))
  )
  return uniqueChainIds([...staleChainIds, ...missingChainIds])
}

export async function readCachedPortfolio(
  scope: Pick<PortfolioCacheScope, 'walletId' | 'accountId'>
): Promise<PortfolioReadModel | null> {
  const cached = await evmWalletClient.getPortfolio('read')
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
  const forceAll =
    options.forceDiscovery === true || (options.forceRefresh === true && !scopedCached)
  let requestedChainIds: readonly string[] | undefined
  let claimedResources: readonly string[] = []

  if (forceAll) {
    requestedChainIds = undefined
  } else if (options.forceRefresh) {
    requestedChainIds = options.refreshChainIds?.length
      ? uniqueChainIds(options.refreshChainIds)
      : undefined
  } else if (scopedCached) {
    const candidates = portfolioChainIdsForAutomaticRefresh(scopedCached, options)
    const claimed = await automaticRefreshSession.claim(refreshScope(scope), candidates)
    if (claimed.length === 0) return scopedCached
    claimedResources = claimed
    requestedChainIds = claimed
  } else {
    const selectedChainIds = options.refreshChainIds?.length
      ? uniqueChainIds(options.refreshChainIds)
      : undefined
    const claimed = await automaticRefreshSession.claim(refreshScope(scope), [
      ...(selectedChainIds ?? [FULL_PORTFOLIO_RESOURCE])
    ])
    if (claimed.length === 0) {
      const latest = await readCachedPortfolio(scope).catch(() => null)
      if (latest) return latest
      // A refresh lease is not a cached balance. Join the background source's
      // in-flight refresh when another page has claimed the cold-cache request.
    }
    claimedResources = claimed
    requestedChainIds = selectedChainIds
      ? claimed.length > 0
        ? claimed
        : selectedChainIds
      : undefined
  }

  try {
    const refreshed = await evmWalletClient.getPortfolio('refresh', {
      forceDiscovery: options.forceDiscovery,
      chainIds: requestedChainIds
    })
    if (!isPortfolioModelForScope(refreshed, scope.walletId, scope.accountId)) {
      throw new Error('Portfolio response does not match the active Account')
    }
    const retryableChainIds = new Set<string>(
      refreshed.chains.flatMap(chain =>
        chain.chain.family !== 'zcash' &&
        (chain.status === 'error' ||
          chain.errorCodes.length > 0 ||
          (chain.status === 'loading' && chain.assets.length === 0))
          ? [chain.chain.id]
          : []
      )
    )
    if (!scopedCached && !options.forceRefresh && !options.forceDiscovery && !requestedChainIds) {
      await automaticRefreshSession.claim(
        refreshScope(scope),
        refreshed.chains.flatMap(chain =>
          chain.chain.family === 'zcash' || retryableChainIds.has(chain.chain.id)
            ? []
            : [chain.chain.id]
        )
      )
    }
    const retryableClaims = claimedResources.filter(
      resource => resource === FULL_PORTFOLIO_RESOURCE || retryableChainIds.has(resource)
    )
    if (retryableChainIds.size > 0 && retryableClaims.length > 0) {
      await automaticRefreshSession.release(refreshScope(scope), retryableClaims)
    }
    return refreshed
  } catch (error) {
    if (claimedResources.length > 0) {
      await automaticRefreshSession.release(refreshScope(scope), claimedResources).catch(() => {})
    }
    if (scopedCached) return scopedCached
    throw error
  }
}
