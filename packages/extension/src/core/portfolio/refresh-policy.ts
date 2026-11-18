import type { PortfolioReadModel } from './portfolio-types'

export const PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS = 60_000

export interface PortfolioRefreshSelection {
  readonly refreshChainIds?: readonly string[]
  readonly additionalChainIds?: readonly string[]
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
  return Object.freeze([...new Set([...staleChainIds, ...missingChainIds])])
}
