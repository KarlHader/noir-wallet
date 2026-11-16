import {
  PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS,
  portfolioChainIdsForAutomaticRefresh,
  type PortfolioReadModel
} from '@/core/portfolio'
import type { StorageV2GenerationId } from '@/ports/repositories'
import type {
  PortfolioInvalidationDomain,
  PortfolioInvalidationMarker
} from '@/infrastructure/persistence/repositories'
import type { Network } from '@/types/wallet'
import type { UnifiedPortfolioCoordinator } from './unified-portfolio-coordinator'

const FAILED_REFRESH_RETRY_MS = 10_000

export interface BackgroundPortfolioScope {
  readonly network: Network
  readonly generationId: StorageV2GenerationId
  readonly keyDomainId: string
  readonly accountId: string
  readonly runtimeKey: string
}

export type PortfolioInvalidationScope = Pick<
  BackgroundPortfolioScope,
  'network' | 'keyDomainId' | 'accountId'
>

export interface BackgroundPortfolioServiceOptions {
  readonly coordinator: Pick<UnifiedPortfolioCoordinator, 'readCachedActive' | 'refreshActive'>
  readonly readScope: () => Promise<BackgroundPortfolioScope | null>
  readonly enrich: (
    model: PortfolioReadModel,
    refresh: false | 'if-stale' | true
  ) => Promise<PortfolioReadModel>
  readonly onUpdated: (model: PortfolioReadModel) => void | Promise<void>
  readonly onDispose?: () => void
  readonly markStale: (
    scope: PortfolioInvalidationScope,
    chainIds: readonly string[],
    domain: PortfolioInvalidationDomain
  ) => Promise<void>
  readonly readInvalidations: (
    scope: BackgroundPortfolioScope
  ) => Promise<readonly PortfolioInvalidationMarker[]>
  readonly acknowledgeInvalidations: (
    scope: BackgroundPortfolioScope,
    markers: readonly PortfolioInvalidationMarker[]
  ) => Promise<void>
  readonly now?: () => number
}

interface InFlightChainRefresh {
  readonly promise: Promise<boolean>
  readonly markerRevision: number
}

function scopeKey(scope: BackgroundPortfolioScope): string {
  return JSON.stringify([
    scope.network,
    scope.generationId,
    scope.keyDomainId,
    scope.accountId,
    scope.runtimeKey
  ])
}

function matchesModel(
  model: PortfolioReadModel | null,
  scope: BackgroundPortfolioScope
): model is PortfolioReadModel {
  return model?.scope.keyDomainId === scope.keyDomainId && model.scope.accountId === scope.accountId
}

function modelFingerprint(model: PortfolioReadModel): string {
  return JSON.stringify(model)
}

function authorityUpdatedAfter(
  model: PortfolioReadModel,
  marker: PortfolioInvalidationMarker
): boolean {
  if (marker.domain === 'confidential') {
    return Boolean(
      model.confidential?.status === 'ready' &&
      model.confidential.freshness === 'fresh' &&
      (model.confidential.updatedAt ?? 0) > marker.invalidatedAt
    )
  }
  const chain = model.chains.find(item => item.chain.id === marker.chainId)
  if (!chain || chain.chain.family === 'bitcoin' || chain.chain.family === 'zcash') return false
  return Boolean(
    chain?.status === 'ready' && chain.assets.some(asset => asset.updatedAt > marker.invalidatedAt)
  )
}

function applyInvalidationFreshness(
  model: PortfolioReadModel,
  markers: readonly PortfolioInvalidationMarker[]
): PortfolioReadModel {
  const staleChains = new Set(
    markers.flatMap(marker =>
      marker.domain === 'chain' && !authorityUpdatedAfter(model, marker) ? [marker.chainId] : []
    )
  )
  const staleConfidential = markers.some(
    marker => marker.domain === 'confidential' && !authorityUpdatedAfter(model, marker)
  )
  if (staleChains.size === 0 && !staleConfidential) return model
  return Object.freeze({
    ...model,
    status: staleChains.size > 0 && model.status === 'ready' ? 'partial' : model.status,
    chains: Object.freeze(
      model.chains.map(chain =>
        staleChains.has(chain.chain.id)
          ? Object.freeze({
              ...chain,
              status: chain.status === 'ready' ? ('partial' as const) : chain.status,
              assets: Object.freeze(
                chain.assets.map(asset => Object.freeze({ ...asset, freshness: 'stale' as const }))
              )
            })
          : chain
      )
    ),
    assets: Object.freeze(
      model.assets.map(asset =>
        staleChains.has(asset.asset.chainId)
          ? Object.freeze({ ...asset, freshness: 'stale' as const })
          : asset
      )
    ),
    ...(staleConfidential && model.confidential
      ? { confidential: Object.freeze({ ...model.confidential, freshness: 'stale' as const }) }
      : {})
  })
}

export class BackgroundPortfolioService {
  private disposed = false
  private readonly inFlight = new Map<string, InFlightChainRefresh>()
  private readonly failedAt = new Map<string, number>()
  private readonly emptyRefreshedAt = new Map<string, number>()
  private readonly published = new Map<string, string>()

  constructor(private readonly options: BackgroundPortfolioServiceOptions) {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.onDispose?.()
    this.failedAt.clear()
    this.emptyRefreshedAt.clear()
    this.published.clear()
  }

  async isActiveAccount(scope: {
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<boolean> {
    if (this.disposed) return false
    const active = await this.options.readScope()
    return (
      !this.disposed &&
      active?.keyDomainId === scope.keyDomainId &&
      active.accountId === scope.accountId
    )
  }

  async readCachedActive(): Promise<PortfolioReadModel | null> {
    if (this.disposed) return null
    const scope = await this.options.readScope()
    if (!scope) return null
    const model = await this.options.coordinator.readCachedActive()
    if (!matchesModel(model, scope) || !(await this.isCurrent(scope))) return null
    const enriched = await this.options.enrich(model, false)
    if (!matchesModel(enriched, scope) || !(await this.isCurrent(scope))) return null
    const markers = await this.options.readInvalidations(scope)
    if (!(await this.isCurrent(scope))) return null
    const satisfied = markers.filter(marker => authorityUpdatedAfter(enriched, marker))
    if (satisfied.length > 0) {
      await this.options.acknowledgeInvalidations(scope, satisfied)
    }
    return applyInvalidationFreshness(enriched, markers)
  }

  async refreshActive(
    chainIds?: readonly string[],
    options: Readonly<{ automatic?: boolean }> = {}
  ): Promise<PortfolioReadModel | null> {
    return this.refreshActiveWithFollowup(chainIds, options, true, false)
  }

  private async refreshActiveWithFollowup(
    chainIds: readonly string[] | undefined,
    options: Readonly<{ automatic?: boolean }>,
    allowFollowup: boolean,
    bypassBackoff: boolean
  ): Promise<PortfolioReadModel | null> {
    if (this.disposed) return null
    const scope = await this.options.readScope()
    if (!scope) return null
    const before = await this.options.coordinator.readCachedActive()
    if (!matchesModel(before, scope) || !(await this.isCurrent(scope))) return null
    const previous = await this.options.enrich(before, false)
    if (!matchesModel(previous, scope) || !(await this.isCurrent(scope))) return null
    const knownChains = new Set<string>(
      before.chains.flatMap(chain => (chain.chain.family === 'zcash' ? [] : [chain.chain.id]))
    )
    const requested = chainIds ? [...new Set(chainIds)] : [...knownChains]
    const invalidated = await this.options.readInvalidations(scope)
    if (!(await this.isCurrent(scope))) return null
    const emptyCandidates = before.chains.flatMap(chain => {
      const key = `${scopeKey(scope)}:${chain.chain.id}`
      const lastRefreshed = this.emptyRefreshedAt.get(key)
      return chain.chain.family !== 'zcash' &&
        chain.status === 'ready' &&
        chain.assets.length === 0 &&
        (lastRefreshed === undefined ||
          this.now() - lastRefreshed >= PORTFOLIO_AUTOMATIC_REFRESH_MAX_AGE_MS)
        ? [chain.chain.id]
        : []
    })
    const candidates = options.automatic
      ? [
          ...new Set([
            ...portfolioChainIdsForAutomaticRefresh(
              before,
              { refreshChainIds: chainIds },
              this.now()
            ),
            ...emptyCandidates.filter(chainId => !chainIds || chainIds.includes(chainId)),
            ...requested.filter(chainId =>
              invalidated.some(marker => marker.domain === 'chain' && marker.chainId === chainId)
            )
          ])
        ]
      : requested
    const selected = candidates.filter(chainId => knownChains.has(chainId))
    const newChains: string[] = []
    const markerRevision = (chainId: string) =>
      invalidated.reduce(
        (revision, marker) =>
          marker.domain === 'chain' && marker.chainId === chainId
            ? Math.max(revision, marker.revision)
            : revision,
        0
      )
    const attempts = selected.map(chainId => {
      const key = `${scopeKey(scope)}:${chainId}`
      const pending = this.inFlight.get(key)
      if (pending) return pending
      const failedAt = this.failedAt.get(key)
      if (
        options.automatic &&
        !bypassBackoff &&
        failedAt !== undefined &&
        this.now() - failedAt < FAILED_REFRESH_RETRY_MS
      ) {
        return { promise: Promise.resolve(false), markerRevision: markerRevision(chainId) }
      }
      newChains.push(chainId)
      return null
    })
    if (newChains.length > 0) {
      const awaitBitcoin = newChains.some(
        chainId =>
          invalidated.some(marker => marker.domain === 'chain' && marker.chainId === chainId) &&
          before.chains.some(
            chain => chain.chain.id === chainId && chain.chain.family === 'bitcoin'
          )
      )
      const batch = this.refreshBatch(scope, newChains, awaitBitcoin)
      for (const chainId of newChains) {
        const key = `${scopeKey(scope)}:${chainId}`
        const perChain = batch.then(results => results.get(chainId) ?? false)
        const entry = { promise: perChain, markerRevision: markerRevision(chainId) }
        this.inFlight.set(key, entry)
        void perChain.finally(() => {
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key)
        })
      }
    }
    const tracked = attempts.map(
      (pending, index) => pending ?? this.inFlight.get(`${scopeKey(scope)}:${selected[index]}`)
    )
    const results = await Promise.all(
      tracked.map(entry => entry?.promise ?? Promise.resolve(false))
    )
    if (!(await this.isCurrent(scope))) return null
    const current = await this.options.coordinator.readCachedActive()
    if (!matchesModel(current, scope) || !(await this.isCurrent(scope))) return null
    const confidentialMarkers = invalidated.filter(
      marker =>
        marker.domain === 'confidential' &&
        (chainIds === undefined || chainIds.includes(marker.chainId))
    )
    const refreshed = await this.options.enrich(
      current,
      confidentialMarkers.length > 0 ? true : chainIds === undefined ? 'if-stale' : false
    )
    if (!matchesModel(refreshed, scope) || !(await this.isCurrent(scope))) return null
    const latestInvalidations = await this.options.readInvalidations(scope)
    if (!(await this.isCurrent(scope))) return null
    const newerChains = selected.filter((chainId, index) =>
      latestInvalidations.some(
        marker =>
          marker.domain === 'chain' &&
          marker.chainId === chainId &&
          marker.revision > (tracked[index]?.markerRevision ?? 0)
      )
    )
    const newerConfidential = latestInvalidations.flatMap(marker => {
      if (marker.domain !== 'confidential') return []
      const previousMarker = invalidated.find(
        item => item.domain === 'confidential' && item.chainId === marker.chainId
      )
      return marker.revision > (previousMarker?.revision ?? 0) ? [marker.chainId] : []
    })
    if (allowFollowup && (newerChains.length > 0 || newerConfidential.length > 0)) {
      return this.refreshActiveWithFollowup(
        [...new Set([...newerChains, ...newerConfidential])],
        { automatic: true },
        false,
        true
      )
    }
    const successfulChains = new Set(selected.filter((_, index) => results[index] === true))
    const acknowledged = invalidated.filter(marker => {
      if (marker.domain === 'confidential') {
        return confidentialMarkers.includes(marker) && authorityUpdatedAfter(refreshed, marker)
      }
      const chain = refreshed.chains.find(item => item.chain.id === marker.chainId)
      if (chain?.chain.family === 'zcash') return false
      if (chain?.chain.family === 'bitcoin') {
        return (
          successfulChains.has(marker.chainId) &&
          chain.status === 'ready' &&
          (tracked[selected.indexOf(marker.chainId)]?.markerRevision ?? 0) >= marker.revision
        )
      }
      const index = selected.indexOf(marker.chainId)
      return (
        successfulChains.has(marker.chainId) &&
        index >= 0 &&
        (tracked[index]?.markerRevision ?? 0) >= marker.revision
      )
    })
    if (acknowledged.length > 0) {
      await this.options.acknowledgeInvalidations(scope, acknowledged)
    }
    const remaining = await this.options.readInvalidations(scope)
    if (!(await this.isCurrent(scope))) return null
    const visible = applyInvalidationFreshness(refreshed, remaining)
    const fingerprint = modelFingerprint(visible)
    const confidentialChanged =
      JSON.stringify(previous.confidential) !== JSON.stringify(refreshed.confidential)
    if (
      (selected.length > 0 || confidentialChanged) &&
      fingerprint !== modelFingerprint(applyInvalidationFreshness(previous, invalidated)) &&
      fingerprint !== this.published.get(scopeKey(scope))
    ) {
      this.published.set(scopeKey(scope), fingerprint)
      await Promise.resolve(this.options.onUpdated(visible)).catch(() => {})
    }
    return visible
  }

  async invalidate(
    scope: PortfolioInvalidationScope,
    chainIds: readonly string[],
    options: Readonly<{ domain?: PortfolioInvalidationDomain; refresh?: boolean }> = {}
  ): Promise<PortfolioReadModel | null> {
    if (this.disposed) return null
    const domain = options.domain ?? 'chain'
    await this.options.markStale(scope, chainIds, domain)
    if (options.refresh === false) return null
    const active = await this.options.readScope()
    if (
      !active ||
      active.network !== scope.network ||
      active.keyDomainId !== scope.keyDomainId ||
      active.accountId !== scope.accountId
    ) {
      return null
    }
    return this.refreshActive(chainIds, { automatic: domain === 'confidential' })
  }

  private async refreshBatch(
    scope: BackgroundPortfolioScope,
    chainIds: readonly string[],
    awaitBitcoin = false
  ): Promise<ReadonlyMap<string, boolean>> {
    const results = new Map<string, boolean>()
    try {
      const model = await this.options.coordinator.refreshActive(chainIds, {
        awaitBitcoin,
        requireNewBitcoinScan: awaitBitcoin
      })
      if (!matchesModel(model, scope) || !(await this.isCurrent(scope))) return results
      for (const chainId of chainIds) {
        const chain = model.chains.find(item => item.chain.id === chainId)
        const succeeded = chain?.status === 'ready'
        results.set(chainId, succeeded)
        const key = `${scopeKey(scope)}:${chainId}`
        if (succeeded) {
          this.failedAt.delete(key)
          if (chain?.status === 'ready' && chain.assets.length === 0) {
            this.emptyRefreshedAt.set(key, this.now())
          } else {
            this.emptyRefreshedAt.delete(key)
          }
        } else {
          this.failedAt.set(key, this.now())
        }
      }
    } catch {
      for (const chainId of chainIds) {
        this.failedAt.set(`${scopeKey(scope)}:${chainId}`, this.now())
      }
    }
    return results
  }

  private async isCurrent(expected: BackgroundPortfolioScope): Promise<boolean> {
    if (this.disposed) return false
    const current = await this.options.readScope()
    return !this.disposed && current !== null && scopeKey(current) === scopeKey(expected)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
