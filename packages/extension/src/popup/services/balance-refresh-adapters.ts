import type { PortfolioReadModel } from '@/core/portfolio'
import type { Network } from '@/types/wallet'
import { confidentialFundingClient } from './confidential-funding-client'
import { refreshPortfolioFromCache } from './portfolio-cache'

export interface BalanceRefreshScope {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
  readonly endpointRuntimeKey: string
}

export type BalanceRefreshRequest =
  | Readonly<{
      source: 'chain'
      force?: boolean
      chainIds?: readonly string[]
      additionalChainIds?: readonly string[]
      forceDiscovery?: boolean
    }>
  | Readonly<{
      source: 'near-confidential'
      authorize?: boolean
      notifyPortfolio?: boolean
    }>

interface BalanceRefreshAdapter<Request extends BalanceRefreshRequest> {
  refresh(
    scope: BalanceRefreshScope,
    cached: PortfolioReadModel | null,
    request: Request
  ): Promise<void>
  isReady(model: PortfolioReadModel | null): boolean
}

const chainAdapter: BalanceRefreshAdapter<Extract<BalanceRefreshRequest, { source: 'chain' }>> = {
  async refresh(scope, cached, request) {
    await refreshPortfolioFromCache(scope, cached, {
      forceRefresh: request.force,
      allowStaleOnError: false,
      forceDiscovery: request.forceDiscovery,
      refreshChainIds: request.chainIds,
      additionalChainIds: request.additionalChainIds
    })
  },
  isReady: model => model !== null
}

const nearConfidentialAdapter: BalanceRefreshAdapter<
  Extract<BalanceRefreshRequest, { source: 'near-confidential' }>
> = {
  async refresh(scope, _cached, request) {
    await confidentialFundingClient.refreshBalances(
      { network: scope.network, keyDomainId: scope.walletId, accountId: scope.accountId },
      request.authorize ?? true,
      request.notifyPortfolio ?? true
    )
  },
  isReady: model =>
    model?.confidential?.status === 'ready' && model.confidential.freshness === 'fresh'
}

export function balanceRefreshRequestKey(request: BalanceRefreshRequest): string {
  if (request.source === 'chain') {
    const chainIds = [
      ...new Set([...(request.chainIds ?? []), ...(request.additionalChainIds ?? [])])
    ].sort()
    return JSON.stringify([
      request.source,
      request.force === true,
      request.forceDiscovery === true,
      chainIds
    ])
  }
  return JSON.stringify([
    request.source,
    request.authorize ?? true,
    request.notifyPortfolio ?? true
  ])
}

export async function runBalanceRefresh(
  scope: BalanceRefreshScope,
  cached: PortfolioReadModel | null,
  request: BalanceRefreshRequest
): Promise<void> {
  if (request.source === 'chain') return chainAdapter.refresh(scope, cached, request)
  return nearConfidentialAdapter.refresh(scope, cached, request)
}

export function balanceRefreshIsReady(
  request: BalanceRefreshRequest,
  model: PortfolioReadModel | null
): boolean {
  return request.source === 'chain'
    ? chainAdapter.isReady(model)
    : nearConfidentialAdapter.isReady(model)
}
