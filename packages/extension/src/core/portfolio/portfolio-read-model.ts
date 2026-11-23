import { parseAccountId, parseChainAccountId, type ChainAccountId } from '@/core/accounts/domain'
import type { AssetId, ChainId } from '@/core/chains/domain'
import type { AssetRegistry, AssetRegistryEntry, ChainRegistry } from '@/core/chains/registry'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  PORTFOLIO_READ_LIMITS,
  type PortfolioAssetView,
  type PortfolioBalanceSnapshot,
  type PortfolioChainView,
  type PortfolioReadErrorCode,
  type PortfolioReadModel,
  type PortfolioScope,
  type PortfolioSourceSnapshot,
  type PortfolioSourceStatus,
  type PortfolioViewStatus
} from './portfolio-types'
import { parsePortfolioSourceState } from './portfolio-parsing'

interface NormalizedBalance {
  readonly entry: AssetRegistryEntry
  readonly chainAccountId: ChainAccountId
  readonly sourceStatus: PortfolioSourceStatus
  readonly balance: PortfolioBalanceSnapshot
}

interface NormalizedSource {
  readonly chainId: ChainId
  readonly status: PortfolioSourceStatus
  readonly balances: readonly NormalizedBalance[]
  readonly errorCode?: PortfolioReadErrorCode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function addRaw(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString()
}

function aggregateAssetBalances(balances: readonly NormalizedBalance[]): PortfolioAssetView {
  const [first, ...rest] = balances
  let totalRaw = first.balance.totalRaw
  let spendableRaw = first.balance.spendableRaw
  let availableRaw = first.balance.availableRaw
  let pendingRaw = first.balance.pendingRaw
  let shieldableRaw = first.balance.shieldableRaw
  let shieldedRaw = first.balance.shieldedRaw
  let transparentRaw = first.balance.transparentRaw
  let shieldedPendingRaw = first.balance.shieldedPendingRaw
  let transparentPendingRaw = first.balance.transparentPendingRaw
  let mainRaw = first.balance.mainRaw
  let privateRaw = first.balance.privateRaw
  let privateOnchainRaw = first.balance.privateOnchainRaw
  let confidentialRaw = first.balance.confidentialRaw
  let updatedAt = first.balance.updatedAt
  let stale = first.sourceStatus !== 'ready'
  const chainAccountIds = new Set<ChainAccountId>([first.chainAccountId])

  for (const item of rest) {
    totalRaw = addRaw(totalRaw, item.balance.totalRaw)
    spendableRaw = addRaw(spendableRaw, item.balance.spendableRaw)
    availableRaw = addRaw(availableRaw, item.balance.availableRaw)
    pendingRaw = addRaw(pendingRaw, item.balance.pendingRaw)
    if (shieldableRaw !== undefined || item.balance.shieldableRaw !== undefined) {
      shieldableRaw = addRaw(shieldableRaw ?? '0', item.balance.shieldableRaw ?? '0')
    }
    if (shieldedRaw !== undefined || item.balance.shieldedRaw !== undefined) {
      shieldedRaw = addRaw(shieldedRaw ?? '0', item.balance.shieldedRaw ?? '0')
    }
    if (transparentRaw !== undefined || item.balance.transparentRaw !== undefined) {
      transparentRaw = addRaw(transparentRaw ?? '0', item.balance.transparentRaw ?? '0')
    }
    if (shieldedPendingRaw !== undefined || item.balance.shieldedPendingRaw !== undefined) {
      shieldedPendingRaw = addRaw(shieldedPendingRaw ?? '0', item.balance.shieldedPendingRaw ?? '0')
    }
    if (transparentPendingRaw !== undefined || item.balance.transparentPendingRaw !== undefined) {
      transparentPendingRaw = addRaw(
        transparentPendingRaw ?? '0',
        item.balance.transparentPendingRaw ?? '0'
      )
    }
    const hasAccountBreakdown = mainRaw !== undefined && privateRaw !== undefined
    const itemHasAccountBreakdown =
      item.balance.mainRaw !== undefined && item.balance.privateRaw !== undefined
    if (hasAccountBreakdown !== itemHasAccountBreakdown) {
      throw new Error('Portfolio asset account balance breakdown is inconsistent')
    }
    if (
      mainRaw !== undefined &&
      privateRaw !== undefined &&
      item.balance.mainRaw !== undefined &&
      item.balance.privateRaw !== undefined
    ) {
      mainRaw = addRaw(mainRaw, item.balance.mainRaw)
      privateRaw = addRaw(privateRaw, item.balance.privateRaw)
    }
    const hasConfidentialBreakdown =
      privateOnchainRaw !== undefined && confidentialRaw !== undefined
    const itemHasConfidentialBreakdown =
      item.balance.privateOnchainRaw !== undefined && item.balance.confidentialRaw !== undefined
    if (hasConfidentialBreakdown !== itemHasConfidentialBreakdown) {
      throw new Error('Portfolio asset confidential balance breakdown is inconsistent')
    }
    if (
      privateOnchainRaw !== undefined &&
      confidentialRaw !== undefined &&
      item.balance.privateOnchainRaw !== undefined &&
      item.balance.confidentialRaw !== undefined
    ) {
      privateOnchainRaw = addRaw(privateOnchainRaw, item.balance.privateOnchainRaw)
      confidentialRaw = addRaw(confidentialRaw, item.balance.confidentialRaw)
    }
    updatedAt = Math.max(updatedAt, item.balance.updatedAt)
    stale ||= item.sourceStatus !== 'ready'
    chainAccountIds.add(item.chainAccountId)
  }

  return Object.freeze({
    asset: first.entry.asset,
    metadata: first.entry.metadata,
    source: first.entry.source,
    balance: Object.freeze({
      totalRaw,
      spendableRaw,
      availableRaw,
      pendingRaw,
      ...(shieldableRaw === undefined ? {} : { shieldableRaw }),
      ...(shieldedRaw === undefined ? {} : { shieldedRaw }),
      ...(transparentRaw === undefined ? {} : { transparentRaw }),
      ...(shieldedPendingRaw === undefined ? {} : { shieldedPendingRaw }),
      ...(transparentPendingRaw === undefined ? {} : { transparentPendingRaw }),
      ...(mainRaw === undefined ? {} : { mainRaw }),
      ...(privateRaw === undefined ? {} : { privateRaw }),
      ...(privateOnchainRaw === undefined ? {} : { privateOnchainRaw }),
      ...(confidentialRaw === undefined ? {} : { confidentialRaw })
    }),
    chainAccountIds: Object.freeze([...chainAccountIds]),
    freshness: stale ? 'stale' : 'fresh',
    updatedAt
  })
}

function deriveChainStatus(
  sources: readonly NormalizedSource[],
  assetCount: number
): Exclude<PortfolioViewStatus, 'empty'> {
  if (sources.every(source => source.status === 'ready')) return 'ready'
  if (assetCount === 0 && sources.every(source => source.status === 'loading')) {
    return 'loading'
  }
  if (assetCount === 0 && sources.every(source => source.status === 'error')) {
    return 'error'
  }
  return 'partial'
}

function derivePortfolioStatus(chains: readonly PortfolioChainView[]): PortfolioViewStatus {
  if (chains.length === 0) return 'empty'
  if (chains.every(chain => chain.status === 'ready')) return 'ready'
  if (chains.every(chain => chain.status === 'loading')) return 'loading'
  if (chains.every(chain => chain.status === 'error')) return 'error'
  return 'partial'
}

export function buildPortfolioReadModel(
  scope: PortfolioScope,
  sourceSnapshots: readonly PortfolioSourceSnapshot[],
  chains: ChainRegistry,
  assets: AssetRegistry
): PortfolioReadModel {
  if (!isRecord(scope) || !hasExactKeys(scope, ['keyDomainId', 'accountId'])) {
    throw new Error('Invalid Portfolio scope')
  }
  const parsedScope = Object.freeze({
    keyDomainId: parseKeyDomainId(scope.keyDomainId),
    accountId: parseAccountId(scope.accountId)
  })
  if (!Array.isArray(sourceSnapshots) || sourceSnapshots.length > PORTFOLIO_READ_LIMITS.sources) {
    throw new Error('Portfolio sources exceed the allowed limit')
  }

  const visibleChains = new Map(chains.list().map(chain => [chain.id, chain]))
  const sourcesByChain = new Map<ChainId, NormalizedSource[]>()
  const sourceChainAccountIds = new Set<ChainAccountId>()
  let ignoredAssetCount = 0
  let totalBalanceCount = 0

  for (const source of sourceSnapshots) {
    if (
      !isRecord(source) ||
      !hasExactKeys(source, ['chainAccount', 'status', 'balances'], ['errorCode']) ||
      typeof source.status !== 'string' ||
      !Array.isArray(source.balances) ||
      source.balances.length > PORTFOLIO_READ_LIMITS.balancesPerSource ||
      !isRecord(source.chainAccount) ||
      !isRecord(source.chainAccount.scope)
    ) {
      throw new Error('Invalid Portfolio source')
    }
    const state = parsePortfolioSourceState({
      status: source.status,
      balances: source.balances,
      ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode })
    })
    const status = state.status
    if (
      typeof source.chainAccount.id !== 'string' ||
      typeof source.chainAccount.scope.keyDomainId !== 'string' ||
      typeof source.chainAccount.scope.accountId !== 'string' ||
      typeof source.chainAccount.scope.chainId !== 'string'
    ) {
      throw new Error('Invalid Portfolio ChainAccount scope')
    }
    const chainAccountId = parseChainAccountId(source.chainAccount.id)
    const keyDomainId = parseKeyDomainId(source.chainAccount.scope.keyDomainId)
    const accountId = parseAccountId(source.chainAccount.scope.accountId)
    const chainId = parseChainId(source.chainAccount.scope.chainId).id
    if (keyDomainId !== parsedScope.keyDomainId || accountId !== parsedScope.accountId) {
      throw new Error('Portfolio source does not match the requested Account scope')
    }
    const parsedErrorCode = state.errorCode
    if (sourceChainAccountIds.has(chainAccountId)) {
      throw new Error(`Duplicate Portfolio source: ${chainAccountId}`)
    }
    sourceChainAccountIds.add(chainAccountId)
    if (!visibleChains.has(chainId)) continue

    const normalizedBalances: NormalizedBalance[] = []
    const sourceAssetIds = new Set<AssetId>()
    for (const balance of state.balances) {
      totalBalanceCount += 1
      if (totalBalanceCount > PORTFOLIO_READ_LIMITS.balancesTotal) {
        throw new Error('Portfolio balances exceed the allowed limit')
      }
      let entry: AssetRegistryEntry | undefined
      try {
        entry = assets.inspect(balance.assetId)
      } catch {
        entry = undefined
      }
      if (!entry) {
        ignoredAssetCount += 1
        continue
      }
      if (entry.verification === 'blocked') {
        ignoredAssetCount += 1
        continue
      }
      if (entry.asset.chainId !== chainId) {
        throw new Error('Portfolio asset does not match its ChainAccount')
      }
      if (sourceAssetIds.has(entry.asset.id)) {
        throw new Error(`Duplicate Portfolio asset balance: ${entry.asset.id}`)
      }
      sourceAssetIds.add(entry.asset.id)
      normalizedBalances.push(
        Object.freeze({
          entry,
          chainAccountId,
          sourceStatus: status,
          balance
        })
      )
    }
    const normalizedSource = Object.freeze({
      chainId,
      status,
      balances: Object.freeze(normalizedBalances),
      ...(parsedErrorCode === undefined ? {} : { errorCode: parsedErrorCode })
    })
    const chainSources = sourcesByChain.get(chainId) ?? []
    chainSources.push(normalizedSource)
    sourcesByChain.set(chainId, chainSources)
  }

  const chainViews: PortfolioChainView[] = []
  for (const chain of chains.list()) {
    const chainSources = sourcesByChain.get(chain.id)
    if (!chainSources || chainSources.length === 0) continue
    const balancesByAsset = new Map<AssetId, NormalizedBalance[]>()
    for (const source of chainSources) {
      for (const balance of source.balances) {
        const values = balancesByAsset.get(balance.entry.asset.id) ?? []
        values.push(balance)
        balancesByAsset.set(balance.entry.asset.id, values)
      }
    }
    const assetViews = Object.freeze([...balancesByAsset.values()].map(aggregateAssetBalances))
    const errorCodes = Object.freeze([
      ...new Set(
        chainSources.flatMap(source => (source.errorCode === undefined ? [] : [source.errorCode]))
      )
    ])
    chainViews.push(
      Object.freeze({
        chain,
        status: deriveChainStatus(chainSources, assetViews.length),
        assets: assetViews,
        errorCodes
      })
    )
  }

  const frozenChains = Object.freeze(chainViews)
  return Object.freeze({
    scope: parsedScope,
    status: derivePortfolioStatus(frozenChains),
    chains: frozenChains,
    assets: Object.freeze(frozenChains.flatMap(chain => chain.assets)),
    ignoredAssetCount
  })
}
