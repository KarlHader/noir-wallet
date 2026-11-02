import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import {
  inferPrivateExecutionAddressFromLocalGraphs,
  type ActivityItem,
  type ActivityScope
} from '@/core/activity'
import type { TransactionGraph } from '@/core/transactions/domain'
import { buildAccountKey } from '@/core/wallet/account-scope'
import {
  ActivityCoordinator,
  createConfiguredActivityHistorySources
} from '@/infrastructure/activity'
import {
  BITCOIN_ACTIVITY_HISTORY_LIMITS,
  IndexedDbBitcoinDiscoveryRepository,
  isActiveBitcoinAddressObservation,
  loadActiveBitcoinDiscoveryContext,
  type BitcoinDiscoveryState
} from '@/infrastructure/chains/bitcoin'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm'
import { listEvmHistoryCacheByScope } from '@/infrastructure/chains/evm/evm-activity-history-cache'
import { filterTrackedEvmTokenActivity } from '@/infrastructure/chains/evm/evm-indexed-activity'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { loadTransactions } from '@/lib/indexed-db'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import { ACTIVITY_HISTORY_CACHE_ITEM_LIMIT, ActivityHistoryCache } from './activity-history-cache'
import { getBitcoinAccountPreferences } from './bitcoin-account-preferences'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import { credentialSession } from './credential-session'

const ACTIVITY_REFRESH_TTL_MS = 5 * 60_000
const PENDING_ACTIVITY_REFRESH_TTL_MS = 30_000

function bitcoinActivityCachePartition(addressType: BitcoinSupportedAddressType): string {
  return `active-address-${addressType}-v2`
}

type ActivityStorageRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export function filterLocalGraphsForActiveBitcoinAddress(
  graphs: readonly TransactionGraph[],
  bitcoinChainId: string,
  ownedAddresses: ReadonlySet<string>
): readonly TransactionGraph[] {
  return Object.freeze(
    graphs.filter(graph => {
      const hasBitcoinOrigin = graph.segments.some(
        segment =>
          segment.role === 'origin' &&
          segment.target.kind === 'onchain' &&
          segment.target.chainId === bitcoinChainId
      )
      if (!hasBitcoinOrigin) return true
      const intent = graph.root.intent
      return [intent?.sender, intent?.recipient].some(
        party => party?.chainId === bitcoinChainId && ownedAddresses.has(party.address)
      )
    })
  )
}

interface EvmExecutionAddresses {
  readonly main: string
  readonly privateAddress: string | null
}

async function resolveEvmMainAddress(
  storageRepository: ActivityStorageRepository,
  scope: ActivityScope
): Promise<{ main: string; privateAvailable: boolean; addressIndex: number } | null> {
  const pointer = await storageRepository.getActivePointer()
  if (!pointer) return null
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot) return null
  let privateAvailable = false
  try {
    const resolved = resolveKeyDomain(snapshot.keyDomains, scope.keyDomainId)
    if (!keySourceSupportsChainFamily(resolved.source, 'evm')) return null
    privateAvailable = supportsEvmPrivateExecution(resolved.source)
  } catch {
    return null
  }
  const evmChainAccount = snapshot.chainAccounts.find(
    ca =>
      ca.scope.keyDomainId === scope.keyDomainId &&
      ca.scope.accountId === scope.accountId &&
      ca.scope.chainId.startsWith('eip155:') &&
      ca.identity.kind === 'account-identifier' &&
      /^0x[0-9a-fA-F]{40}$/.test(ca.identity.value)
  )
  if (!evmChainAccount) return null
  const main = evmChainAccount.identity.value.toLowerCase()
  const addressIndex = privateAvailable
    ? parseEvmAccountBinding(evmChainAccount, evmChainAccount.scope.chainId).addressIndex
    : 0
  return Object.freeze({ main, privateAvailable, addressIndex })
}

async function resolveEvmExecutionAddresses(
  storageRepository: ActivityStorageRepository,
  signer: EvmMultichainSigningClient,
  scope: ActivityScope,
  includePrivate = true
): Promise<EvmExecutionAddresses | null> {
  const account = await resolveEvmMainAddress(storageRepository, scope)
  if (!account) return null
  if (
    !includePrivate ||
    !account.privateAvailable ||
    !(await credentialSession.hasUnlockSession())
  ) {
    return Object.freeze({ main: account.main, privateAddress: null })
  }
  const privateAddress = (
    await signer.deriveGlobalPea(scope.keyDomainId, account.addressIndex)
  ).address.toLowerCase()
  return Object.freeze({ main: account.main, privateAddress })
}

async function resolveChainAddress(
  storageRepository: ActivityStorageRepository,
  scope: ActivityScope,
  family: 'solana' | 'near',
  chainId: string
): Promise<string | null> {
  const pointer = await storageRepository.getActivePointer()
  if (!pointer) return null
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot) return null
  try {
    const resolved = resolveKeyDomain(snapshot.keyDomains, scope.keyDomainId)
    if (!keySourceSupportsChainFamily(resolved.source, family)) return null
  } catch {
    return null
  }
  const chainAccount = snapshot.chainAccounts.find(
    candidate =>
      candidate.scope.keyDomainId === scope.keyDomainId &&
      candidate.scope.accountId === scope.accountId &&
      candidate.scope.chainId === chainId &&
      candidate.identity.kind === 'account-identifier'
  )
  return chainAccount?.identity.value ?? null
}

function filterItemsForChainFamily(
  items: readonly ActivityItem[],
  namespace: string
): readonly ActivityItem[] {
  return Object.freeze(
    items.filter(item =>
      item.segments.some(
        segment =>
          segment.target.kind === 'onchain' && segment.target.chainId.startsWith(`${namespace}:`)
      )
    )
  )
}

function activityItemIncludesChain(item: ActivityItem, chainId: string): boolean {
  return item.segments.some(
    segment => segment.target.kind === 'onchain' && segment.target.chainId === chainId
  )
}

function isEvmActivityItem(item: ActivityItem): boolean {
  return item.segments.some(
    segment => segment.target.kind === 'onchain' && segment.target.chainId.startsWith('eip155:')
  )
}

function filterItemsForChain(
  items: readonly ActivityItem[],
  chainId: string
): readonly ActivityItem[] {
  return Object.freeze(items.filter(item => activityItemIncludesChain(item, chainId)))
}

function mergeBoundedActivityItems(
  previous: readonly ActivityItem[],
  fresh: readonly ActivityItem[],
  limit = ACTIVITY_HISTORY_CACHE_ITEM_LIMIT
): readonly ActivityItem[] {
  const cacheKey = (item: ActivityItem) => {
    const chainIds = [
      ...new Set(
        item.segments.flatMap(segment =>
          segment.target.kind === 'onchain' ? [segment.target.chainId] : []
        )
      )
    ].sort()
    return `${item.source}:${item.id}:${chainIds.join(',')}`
  }
  const byId = new Map(previous.map(item => [cacheKey(item), item] as const))
  for (const item of fresh) byId.set(cacheKey(item), item)
  return Object.freeze(
    [...byId.values()]
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id)
      )
      .slice(0, limit)
  )
}

function solanaSignature(item: ActivityItem): string | null {
  const prefix = 'rpc:solana:'
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : null
}

export function createBackgroundActivityCoordinator(
  bitcoinCustomRpcUrl?: string,
  endpointSettings?: ChainEndpointSettings
): ActivityCoordinator {
  const storageRepository = new IndexedDbStorageV2Repository()
  const peaSigner = new EvmMultichainSigningClient({ credentials: credentialSession })
  const historyCache = new ActivityHistoryCache(DEFAULT_NETWORK)
  const accountPreferences = getBitcoinAccountPreferences()
  const {
    bitcoinNetwork,
    bitcoinHistory,
    evmBatchHistory,
    evmHistorySources,
    solanaNetwork,
    solanaHistory,
    nearNetwork,
    nearHistory
  } = createConfiguredActivityHistorySources({
    network: DEFAULT_NETWORK,
    enabledChainFeatureFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
    bitcoinCustomRpcUrl,
    endpointSettings
  })
  const trackedEvmTokenAssetIds = new Set(
    evmHistorySources.flatMap(source => source.trackedErc20AssetIds)
  )
  const bitcoinDiscovery = bitcoinHistory ? new IndexedDbBitcoinDiscoveryRepository() : undefined

  const loadBitcoinItems = async (
    scope: ActivityScope,
    fallbackItems: readonly ActivityItem[],
    addressType: BitcoinSupportedAddressType
  ): Promise<readonly ActivityItem[]> => {
    if (!bitcoinDiscovery || !bitcoinHistory) return Object.freeze([])
    try {
      const context = await loadActiveBitcoinDiscoveryContext(
        storageRepository,
        bitcoinNetwork.chainId
      )
      if (
        !context ||
        context.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
        context.chainAccount.scope.accountId !== scope.accountId
      ) {
        return Object.freeze([])
      }
      const state: BitcoinDiscoveryState | null = await bitcoinDiscovery.get({
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex
      })
      if (!state) return Object.freeze([])
      const selectedObservations = state.observations.filter(observation =>
        isActiveBitcoinAddressObservation(observation, addressType)
      )
      const observations = [...selectedObservations].sort(
        (left, right) =>
          right.derived.addressIndex - left.derived.addressIndex ||
          Number(right.derived.change) - Number(left.derived.change) ||
          left.derived.addressType.localeCompare(right.derived.addressType)
      )
      const fresh = await bitcoinHistory.readAddressActivity({
        scope,
        ownedAddresses: selectedObservations.map(observation => observation.derived.address),
        historyAddresses: observations
          .filter(observation => observation.activity.used)
          .slice(0, BITCOIN_ACTIVITY_HISTORY_LIMITS.addresses)
          .map(observation => observation.derived.address)
      })
      return mergeBoundedActivityItems(fallbackItems, fresh)
    } catch (error) {
      logger.warn(
        `Bitcoin activity refresh failed: ${formatLogError(error)}`,
        scope.keyDomainId,
        scope.accountId
      )
      return fallbackItems
    }
  }

  const loadEvmItems = async (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    chainIds: ReadonlySet<string>,
    fallbackItems: readonly ActivityItem[],
    historyPageCount = 1,
    hasMoreKeys: ReadonlySet<string> = new Set()
  ): Promise<readonly ActivityItem[]> => {
    if (evmHistorySources.length === 0) return Object.freeze([])
    const addresses = await resolveEvmExecutionAddresses(
      storageRepository,
      peaSigner,
      scope,
      accountMode !== 'main'
    )
    if (!addresses) {
      if (historyPageCount > 1) throw new Error('EVM history address is unavailable')
      return Object.freeze(
        fallbackItems.filter(item =>
          [...chainIds].some(chainId => activityItemIncludesChain(item, chainId))
        )
      )
    }
    const selectedAddresses = [
      ...(accountMode !== 'private'
        ? [Object.freeze({ address: addresses.main, accountMode: 'main' as const })]
        : []),
      ...(accountMode !== 'main' && addresses.privateAddress
        ? [Object.freeze({ address: addresses.privateAddress, accountMode: 'private' as const })]
        : [])
    ]
    const batchEntries =
      historyPageCount > 1
        ? []
        : evmHistorySources.filter(
            entry => chainIds.has(entry.chainId) && evmBatchHistory?.chainIds.has(entry.chainId)
          )
    const batchResults = await Promise.allSettled(
      selectedAddresses.map(async selected => ({
        selected,
        results: await evmBatchHistory?.readAddressActivities(
          batchEntries.map(entry => ({
            chainId: entry.chainId,
            address: selected.address,
            scope
          }))
        )
      }))
    )
    const items: ActivityItem[] =
      historyPageCount > 1
        ? fallbackItems.filter(item =>
            [...chainIds].some(chainId => activityItemIncludesChain(item, chainId))
          )
        : []
    for (let index = 0; index < batchResults.length; index++) {
      const result = batchResults[index]
      const selected = selectedAddresses[index]
      for (const entry of batchEntries) {
        const fresh =
          result.status === 'fulfilled' ? result.value.results?.get(entry.chainId) : undefined
        if (fresh) {
          for (const item of fresh) {
            items.push(
              selected.accountMode === 'private'
                ? Object.freeze({ ...item, accountMode: 'private' as const })
                : item
            )
          }
        } else {
          items.push(
            ...filterItemsForChain(fallbackItems, entry.chainId).filter(item =>
              selected.accountMode === 'private'
                ? item.accountMode === 'private'
                : item.accountMode !== 'private'
            )
          )
          console.warn(`[Activity] EVM ${entry.chainId} batch history failed`)
        }
      }
    }
    const targets = evmHistorySources.flatMap(entry =>
      chainIds.has(entry.chainId) &&
      (historyPageCount > 1 || !evmBatchHistory?.chainIds.has(entry.chainId))
        ? selectedAddresses
            .filter(
              selected =>
                historyPageCount === 1 || hasMoreKeys.has(`${entry.chainId}:${selected.address}`)
            )
            .map(address => Object.freeze({ ...entry, ...address }))
        : []
    )
    if (historyPageCount > 1) {
      const requestedKeys = [...hasMoreKeys].filter(key =>
        [...chainIds].some(chainId => key.startsWith(`${chainId}:`))
      )
      if (targets.length !== requestedKeys.length) {
        throw new Error('EVM history address is unavailable')
      }
    }

    const MAX_CONCURRENCY = 3
    for (let i = 0; i < targets.length; i += MAX_CONCURRENCY) {
      const batch = targets.slice(i, i + MAX_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(({ source, address }) =>
          source.readAddressActivity({ scope, address, historyPageCount })
        )
      )
      for (let j = 0; j < results.length; j++) {
        const r = results[j]
        if (r.status === 'fulfilled') {
          for (const item of r.value) {
            items.push(
              batch[j].accountMode === 'private'
                ? Object.freeze({ ...item, accountMode: 'private' as const })
                : item
            )
          }
        } else {
          if (historyPageCount > 1) throw r.reason
          items.push(
            ...filterItemsForChain(fallbackItems, batch[j].chainId).filter(item =>
              batch[j].accountMode === 'private'
                ? item.accountMode === 'private'
                : item.accountMode !== 'private'
            )
          )
          console.warn(
            `[Activity] EVM ${batch[j].chainId} history failed: ${r.reason instanceof Error ? r.reason.name : 'UnknownError'}`
          )
        }
      }
    }
    if (accountMode !== 'main' && !addresses.privateAddress) {
      items.push(
        ...fallbackItems.filter(
          item =>
            item.accountMode === 'private' &&
            [...chainIds].some(chainId => activityItemIncludesChain(item, chainId))
        )
      )
    }
    const supportedItems = items.flatMap(item => {
      const supported = filterTrackedEvmTokenActivity(item, trackedEvmTokenAssetIds)
      return supported ? [supported] : []
    })
    return historyPageCount > 1
      ? mergeBoundedActivityItems([], supportedItems, 10_000)
      : Object.freeze(supportedItems)
  }

  const loadCachedEvmItems = async (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all'
  ): Promise<{
    readonly items: readonly ActivityItem[]
    readonly retryAfterByChainId: Readonly<Record<string, number>>
    readonly hasMoreByChainId: ReadonlySet<string>
    readonly hasMoreKeys: ReadonlySet<string>
  }> => {
    const empty = {
      items: Object.freeze([]),
      retryAfterByChainId: Object.freeze({}),
      hasMoreByChainId: new Set<string>(),
      hasMoreKeys: new Set<string>()
    }
    if (evmHistorySources.length === 0) return empty
    const account = await resolveEvmMainAddress(storageRepository, scope)
    if (!account) return empty
    const supportedChains = new Set<string>(evmHistorySources.map(source => source.chainId))
    const records = await listEvmHistoryCacheByScope(scope)
    const items: ActivityItem[] = []
    const retryAfterByChainId: Record<string, number> = {}
    const hasMoreByChainId = new Set<string>()
    const hasMoreKeys = new Set<string>()
    for (const record of records) {
      if (!supportedChains.has(record.chainId)) continue
      const mode = record.address === account.main ? 'main' : 'private'
      if (mode === 'private' && !account.privateAvailable) continue
      if (accountMode !== 'all' && mode !== accountMode) continue
      if (record.hasMore) {
        hasMoreByChainId.add(record.chainId)
        hasMoreKeys.add(`${record.chainId}:${record.address}`)
      }
      retryAfterByChainId[record.chainId] = Math.min(
        retryAfterByChainId[record.chainId] ?? Number.MAX_SAFE_INTEGER,
        record.retryAfter
      )
      for (const item of record.items) {
        const supported = filterTrackedEvmTokenActivity(item, trackedEvmTokenAssetIds)
        if (!supported) continue
        items.push(
          mode === 'private' ? Object.freeze({ ...supported, accountMode: 'private' }) : supported
        )
      }
    }
    return Object.freeze({
      items: Object.freeze(items),
      retryAfterByChainId,
      hasMoreByChainId,
      hasMoreKeys
    })
  }

  const loadSolanaItems = async (
    scope: ActivityScope,
    fallbackItems: readonly ActivityItem[]
  ): Promise<readonly ActivityItem[]> => {
    if (!solanaHistory) return Object.freeze([])
    const address = await resolveChainAddress(
      storageRepository,
      scope,
      'solana',
      solanaNetwork.chainId
    )
    if (!address) return Object.freeze([])
    try {
      const finalizedSignatures = fallbackItems.flatMap(item => {
        if (item.status !== 'final' && item.status !== 'failed') return []
        const signature = solanaSignature(item)
        return signature ? [signature] : []
      })
      const untilSignature = finalizedSignatures[0]
      const fresh = await solanaHistory.readAddressActivity({
        scope,
        address,
        knownFinalizedSignatures: finalizedSignatures,
        ...(untilSignature === undefined ? {} : { untilSignature })
      })
      return mergeBoundedActivityItems(fallbackItems, fresh)
    } catch (error) {
      logger.warn(
        `Solana activity refresh failed: ${formatLogError(error)}`,
        scope.keyDomainId,
        scope.accountId
      )
      return fallbackItems
    }
  }

  const loadNearItems = async (
    scope: ActivityScope,
    fallbackItems: readonly ActivityItem[]
  ): Promise<readonly ActivityItem[]> => {
    if (!nearHistory) return Object.freeze([])
    const address = await resolveChainAddress(storageRepository, scope, 'near', nearNetwork.chainId)
    if (!address) return Object.freeze([])
    try {
      const fresh = await nearHistory.readAddressActivity({ scope, address })
      return mergeBoundedActivityItems(fallbackItems, fresh)
    } catch (error) {
      logger.warn(
        `NEAR activity refresh failed: ${formatLogError(error)}`,
        scope.keyDomainId,
        scope.accountId
      )
      return fallbackItems
    }
  }

  const supplementalRefreshes = new Map<string, Promise<readonly ActivityItem[]>>()
  const supplementalCacheWrites = new Map<string, Promise<void>>()

  const loadSupplementalItems = async (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    chainIds?: readonly string[],
    historyPageCount = 1
  ): Promise<readonly ActivityItem[]> => {
    const addressType = await accountPreferences.get({
      network: DEFAULT_NETWORK,
      keyDomainId: scope.keyDomainId,
      accountId: scope.accountId
    })
    const cachePartition = bitcoinActivityCachePartition(addressType)
    const activeCache = await historyCache.read(scope, cachePartition).catch(() => null)
    const cachedEvm = await loadCachedEvmItems(scope, accountMode).catch(
      (): {
        readonly items: readonly ActivityItem[]
        readonly retryAfterByChainId: Readonly<Record<string, number>>
        readonly hasMoreByChainId: ReadonlySet<string>
        readonly hasMoreKeys: ReadonlySet<string>
      } => ({
        items: [],
        retryAfterByChainId: {},
        hasMoreByChainId: new Set<string>(),
        hasMoreKeys: new Set<string>()
      })
    )
    const activeItems = activeCache?.items ?? []
    const cachedItems = mergeBoundedActivityItems(activeItems, cachedEvm.items, 10_000)
    const currentTime = Date.now()
    const supportedChainIds = Object.freeze([
      ...(bitcoinHistory ? [bitcoinNetwork.chainId] : []),
      ...evmHistorySources.map(source => source.chainId),
      ...(solanaHistory ? [solanaNetwork.chainId] : []),
      ...(nearHistory ? [nearNetwork.chainId] : [])
    ])
    const requestedChainIdSet = chainIds ? new Set(chainIds) : null
    const staleChainIds = supportedChainIds.filter(chainId => {
      if (requestedChainIdSet && !requestedChainIdSet.has(chainId)) return false
      if (historyPageCount > 1) {
        return chainId.startsWith('eip155:') && cachedEvm.hasMoreByChainId.has(chainId)
      }
      const refreshedAt = activeCache?.refreshedAtByChainId[chainId]
      if (chainId.startsWith('eip155:')) {
        const retryAfter = cachedEvm.retryAfterByChainId[chainId]
        return retryAfter === undefined || retryAfter <= currentTime
      }
      const refreshTtl = activeItems.some(
        item =>
          item.status !== 'final' &&
          item.status !== 'failed' &&
          activityItemIncludesChain(item, chainId)
      )
        ? PENDING_ACTIVITY_REFRESH_TTL_MS
        : ACTIVITY_REFRESH_TTL_MS
      return (
        refreshedAt === undefined ||
        refreshedAt > currentTime ||
        currentTime - refreshedAt >= refreshTtl
      )
    })
    if (staleChainIds.length === 0) return cachedItems
    const staleChainIdSet = new Set<string>(staleChainIds)
    const refreshScopeKey = `${scope.keyDomainId}:${scope.accountId}:${cachePartition}:`
    const refreshKey = `${refreshScopeKey}${accountMode}:${[...staleChainIds].sort().join(',')}:${historyPageCount}`
    const existingRefresh = supplementalRefreshes.get(refreshKey)
    if (existingRefresh) return existingRefresh
    const priorRefreshes = [...supplementalRefreshes]
      .filter(([key]) => key.startsWith(refreshScopeKey))
      .map(([, work]) => work)
    if (priorRefreshes.length > 0) {
      await Promise.allSettled(priorRefreshes)
      return loadSupplementalItems(scope, accountMode, chainIds, historyPageCount)
    }

    const refresh = (async () => {
      const cachedBitcoinItems = filterItemsForChain(activeItems, bitcoinNetwork.chainId)
      const cachedSolanaItems = filterItemsForChainFamily(activeItems, 'solana')
      const cachedNearItems = filterItemsForChainFamily(activeItems, 'near')
      const [bitcoinItems, evmItems, solanaItems, nearItems] = await Promise.all([
        staleChainIdSet.has(bitcoinNetwork.chainId)
          ? loadBitcoinItems(scope, cachedBitcoinItems, addressType)
          : Object.freeze([]),
        loadEvmItems(
          scope,
          accountMode,
          staleChainIdSet,
          cachedEvm.items,
          historyPageCount,
          cachedEvm.hasMoreKeys
        ),
        staleChainIdSet.has(solanaNetwork.chainId)
          ? loadSolanaItems(scope, cachedSolanaItems)
          : Object.freeze([]),
        staleChainIdSet.has(nearNetwork.chainId)
          ? loadNearItems(scope, cachedNearItems)
          : Object.freeze([])
      ])
      const refreshedItems = Object.freeze([
        ...bitcoinItems,
        ...evmItems,
        ...solanaItems,
        ...nearItems
      ])
      const refreshedAt = Date.now()
      const cacheWriteKey = `${scope.keyDomainId}:${scope.accountId}:${cachePartition}`
      let committedItems: readonly ActivityItem[] = refreshedItems
      const previousWrite = supplementalCacheWrites.get(cacheWriteKey) ?? Promise.resolve()
      const cacheWrite = previousWrite
        .catch(() => {})
        .then(async () => {
          const latest = await historyCache.read(scope, cachePartition).catch(() => activeCache)
          const retainedItems = mergeBoundedActivityItems(
            cachedItems,
            latest?.items ?? [],
            10_000
          ).filter(item => !staleChainIds.some(chainId => activityItemIncludesChain(item, chainId)))
          committedItems = mergeBoundedActivityItems(retainedItems, refreshedItems, 10_000)
          const retainedNonEvmItems = (latest?.items ?? activeItems).filter(
            item => !staleChainIds.some(chainId => activityItemIncludesChain(item, chainId))
          )
          const nonEvmItems = mergeBoundedActivityItems(
            retainedNonEvmItems,
            refreshedItems.filter(item => !isEvmActivityItem(item))
          )
          const refreshedAtByChainId = Object.freeze({
            ...(latest?.refreshedAtByChainId ?? activeCache?.refreshedAtByChainId ?? {}),
            ...Object.fromEntries(staleChainIds.map(chainId => [chainId, refreshedAt]))
          })
          await historyCache
            .write(scope, refreshedAtByChainId, nonEvmItems, cachePartition)
            .catch(error => {
              console.warn(
                `[Activity] History cache write failed: ${error instanceof Error ? error.name : 'UnknownError'}`
              )
            })
        })
      supplementalCacheWrites.set(cacheWriteKey, cacheWrite)
      await cacheWrite
      if (supplementalCacheWrites.get(cacheWriteKey) === cacheWrite) {
        supplementalCacheWrites.delete(cacheWriteKey)
      }
      return committedItems
    })().finally(() => {
      if (supplementalRefreshes.get(refreshKey) === refresh) {
        supplementalRefreshes.delete(refreshKey)
      }
    })
    supplementalRefreshes.set(refreshKey, refresh)
    return refresh
  }

  const loadCachedSupplementalItems = async (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all'
  ): Promise<readonly ActivityItem[]> => {
    const addressType = await accountPreferences.get({
      network: DEFAULT_NETWORK,
      keyDomainId: scope.keyDomainId,
      accountId: scope.accountId
    })
    const partition = bitcoinActivityCachePartition(addressType)
    const snapshot = await historyCache.read(scope, partition).catch(() => null)
    const evm = await loadCachedEvmItems(scope, accountMode).catch(() => ({ items: [] }))
    return mergeBoundedActivityItems(snapshot?.items ?? [], evm.items, 10_000)
  }

  const loadSupplementalHasMore = async (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    chainIds?: readonly string[]
  ): Promise<boolean> => {
    const cached = await loadCachedEvmItems(scope, accountMode)
    return [...cached.hasMoreByChainId].some(chainId => !chainIds || chainIds.includes(chainId))
  }

  const filterLocalGraphs = async (
    scope: ActivityScope,
    graphs: readonly TransactionGraph[]
  ): Promise<readonly TransactionGraph[]> => {
    if (!bitcoinDiscovery) return graphs
    const context = await loadActiveBitcoinDiscoveryContext(
      storageRepository,
      bitcoinNetwork.chainId
    )
    if (
      !context ||
      context.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
      context.chainAccount.scope.accountId !== scope.accountId
    ) {
      return filterLocalGraphsForActiveBitcoinAddress(graphs, bitcoinNetwork.chainId, new Set())
    }
    const [state, addressType] = await Promise.all([
      bitcoinDiscovery.get({
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex
      }),
      accountPreferences.get({
        network: DEFAULT_NETWORK,
        keyDomainId: scope.keyDomainId,
        accountId: scope.accountId
      })
    ])
    const ownedAddresses = new Set(
      (state?.observations ?? [])
        .filter(observation => isActiveBitcoinAddressObservation(observation, addressType))
        .map(observation => observation.derived.address)
    )
    return filterLocalGraphsForActiveBitcoinAddress(graphs, bitcoinNetwork.chainId, ownedAddresses)
  }

  return new ActivityCoordinator({
    storageRepository,
    transactionRepository: new IndexedDbTransactionRepository(),
    loadZcashTransactions: scope =>
      loadTransactions(buildAccountKey(DEFAULT_NETWORK, scope.keyDomainId, scope.accountId)),
    loadSupplementalItems,
    loadCachedSupplementalItems,
    loadSupplementalHasMore,
    ...(evmHistorySources.length > 0
      ? {
          loadPrivateExecutionAddresses: async (
            scope: ActivityScope,
            localGraphs: readonly TransactionGraph[]
          ) => {
            const account = await resolveEvmMainAddress(storageRepository, scope)
            if (!account?.privateAvailable) return Object.freeze([])
            if (await credentialSession.hasUnlockSession()) {
              try {
                const derived = await peaSigner.deriveGlobalPea(
                  scope.keyDomainId,
                  account.addressIndex
                )
                return Object.freeze([derived.address.toLowerCase()])
              } catch (error) {
                logger.warn(
                  `Activity Private address derivation failed: ${formatLogError(error)}`,
                  scope.keyDomainId,
                  scope.accountId
                )
              }
            }
            const inferred = inferPrivateExecutionAddressFromLocalGraphs(
              localGraphs,
              scope,
              account.main
            )
            return Object.freeze(inferred ? [inferred] : [])
          }
        }
      : {}),
    filterLocalGraphs
  })
}
