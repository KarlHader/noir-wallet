import type { ActivityItem, ActivityScope } from '@/core/activity'
import { EvmRpcError } from './evm-rpc-client'
import { isZeroValueEvmTokenActivity } from './evm-indexed-activity'
import {
  indexedDbEvmHistoryCache,
  type EvmHistoryCacheRecord,
  type EvmHistoryCacheRepository
} from './evm-activity-history-cache'
import type {
  EvmActivityHistorySource,
  FindEvmConfirmedReplacementInput,
  ReadEvmAddressActivityInput
} from './evm-indexed-activity'
import type {
  EvmAnkrHistoryClient,
  EvmAnkrHistoryResult,
  EvmAnkrHistoryTarget
} from './evm-ankr-history-client'

const DEFAULT_SUCCESS_TTL_MS = 5 * 60_000
const DEFAULT_PENDING_TTL_MS = 30_000
const DEFAULT_FAILURE_BACKOFF_MS = 60_000
const MAX_ITEMS = 2_000
const REORG_OVERLAP_BLOCKS = 12
const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__

function logInfo(message: string): void {
  if (debugLogsEnabled) console.info(message)
}

function logWarning(message: string): void {
  if (debugLogsEnabled) console.warn(message)
}

interface EvmCachedHistorySourceOptions {
  readonly chainId: string
  readonly source: EvmActivityHistorySource
  readonly cache?: EvmHistoryCacheRepository
  readonly now?: () => number
  readonly successTtlMs?: number
  readonly pendingTtlMs?: number
  readonly failureBackoffMs?: number
}

interface EvmCachedOnlyHistorySourceOptions {
  readonly chainId: string
  readonly cache?: EvmHistoryCacheRepository
}

function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid EVM history address')
  return value.toLowerCase()
}

function rescopeItems(
  items: readonly ActivityItem[],
  scope: ActivityScope
): readonly ActivityItem[] {
  return Object.freeze(
    items.map(item =>
      item.scope.keyDomainId === scope.keyDomainId && item.scope.accountId === scope.accountId
        ? item
        : Object.freeze({ ...item, scope })
    )
  )
}

function isLegacyInferredEvmActivity(item: ActivityItem): boolean {
  return (
    item.source === 'rpc' &&
    item.id.startsWith('rpc:evm:') &&
    (item.kind === 'supply' ||
      item.kind === 'withdraw' ||
      item.kind === 'claim' ||
      item.kind === 'borrow' ||
      item.kind === 'repay') &&
    !item.segments.some(segment => segment.evidence?.assetEffects)
  )
}

function normalizeLegacyInferredEvmActivity(item: ActivityItem): ActivityItem {
  if (!isLegacyInferredEvmActivity(item)) return item
  const snapshot = item.snapshot
  if (!snapshot) {
    return Object.freeze({
      ...item,
      kind: 'contract-call' as const,
      completeness: 'partial' as const
    })
  }
  const { primaryAmount, ...rest } = snapshot
  return Object.freeze({
    ...item,
    kind: 'contract-call' as const,
    completeness: 'partial' as const,
    snapshot: Object.freeze({
      ...rest,
      direction: 'contract' as const,
      ...(primaryAmount?.assetId.includes('/slip44:') ? { primaryAmount } : {})
    })
  })
}

function normalizeItems(
  fresh: readonly ActivityItem[],
  scope: ActivityScope
): readonly ActivityItem[] {
  const byId = new Map<string, ActivityItem>()
  for (const item of fresh) {
    const normalized = normalizeLegacyInferredEvmActivity(item)
    if (isZeroValueEvmTokenActivity(normalized)) continue
    if (!byId.has(normalized.id)) byId.set(normalized.id, normalized)
  }
  return rescopeItems(
    [...byId.values()]
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id)
      )
      .slice(0, MAX_ITEMS),
    scope
  )
}

function itemBlockHeight(item: ActivityItem): number | null {
  const heights = item.segments.flatMap(segment => {
    const height = segment.evidence?.blockHeight
    return typeof height === 'number' && Number.isSafeInteger(height) && height >= 0 ? [height] : []
  })
  return heights.length === 0 ? null : Math.max(...heights)
}

function incrementalStartBlock(record: EvmHistoryCacheRecord | null): number | undefined {
  if (!record || record.successfulSyncAt === null) return undefined
  if (record.items.some(isLegacyInferredEvmActivity)) return undefined
  if (record.items.some(item => item.completeness === 'partial')) return undefined
  const heights = record.items.flatMap(item => {
    const height = itemBlockHeight(item)
    return height === null ? [] : [height]
  })
  if (heights.length === 0) return undefined
  return Math.max(0, Math.max(...heights) - REORG_OVERLAP_BLOCKS)
}

function mergeItems(
  previous: readonly ActivityItem[],
  fresh: readonly ActivityItem[],
  scope: ActivityScope
): readonly ActivityItem[] {
  const byId = new Map(previous.map(item => [item.id, item] as const))
  for (const item of fresh) {
    const segment = item.segments.find(value => value.role === 'origin')
    if (
      item.source === 'rpc' &&
      segment?.target.kind === 'onchain' &&
      segment.evidence?.transactionHash &&
      item.id.startsWith(`rpc:evm:${segment.target.chainId}:${segment.evidence.transactionHash}:`)
    ) {
      const chainId = segment.target.chainId
      const hash = segment.evidence.transactionHash.toLowerCase()
      for (const [id, cached] of byId) {
        if (
          cached.source === 'rpc' &&
          cached.id.startsWith(`rpc:evm:${chainId}:${hash}:`) &&
          cached.segments?.some(
            value =>
              value.target?.kind === 'onchain' &&
              value.target.chainId === chainId &&
              value.evidence?.transactionHash?.toLowerCase() === hash
          )
        ) {
          byId.delete(id)
        }
      }
    }
    byId.set(item.id, item)
  }
  return normalizeItems([...byId.values()], scope)
}

function hasPendingItems(items: readonly ActivityItem[]): boolean {
  return items.some(item => item.status !== 'final' && item.status !== 'failed')
}

function cacheRetryAfter(record: EvmHistoryCacheRecord, pendingTtlMs: number): number {
  return record.successfulSyncAt === record.lastAttemptAt && hasPendingItems(record.items)
    ? Math.min(record.retryAfter, record.lastAttemptAt + pendingTtlMs)
    : record.retryAfter
}

function successfulRecord(input: {
  readonly chainId: string
  readonly address: string
  readonly scope: ActivityScope
  readonly attemptedAt: number
  readonly previous: EvmHistoryCacheRecord | null
  readonly fresh: readonly ActivityItem[]
  readonly partial: boolean
  readonly hasMore?: boolean
  readonly fullScan?: boolean
  readonly historyPageCount?: number
  readonly successTtlMs: number
  readonly pendingTtlMs: number
}): EvmHistoryCacheRecord {
  const items = mergeItems(input.previous?.items ?? [], input.fresh, input.scope)
  return Object.freeze({
    schemaVersion: 1,
    chainId: input.chainId,
    address: input.address,
    scope: input.scope,
    lastAttemptAt: input.attemptedAt,
    successfulSyncAt: input.attemptedAt,
    retryAfter:
      input.attemptedAt +
      (input.partial || hasPendingItems(items) ? input.pendingTtlMs : input.successTtlMs),
    hasMore:
      (input.historyPageCount ?? 1) > 1
        ? (input.hasMore ?? false)
        : (input.previous?.historyPageCount ?? 1) > 1
          ? (input.previous?.hasMore ?? false)
          : input.fullScan
            ? (input.hasMore ?? false)
            : (input.previous?.hasMore ?? false) || (input.hasMore ?? false),
    historyPageCount: Math.max(input.historyPageCount ?? 1, input.previous?.historyPageCount ?? 1),
    historySyncAt:
      (input.historyPageCount ?? 1) > 1 || (input.previous?.historyPageCount ?? 1) <= 1
        ? input.attemptedAt
        : (input.previous?.historySyncAt ?? input.previous?.successfulSyncAt ?? null),
    items
  })
}

function failedRecord(input: {
  readonly chainId: string
  readonly address: string
  readonly scope: ActivityScope
  readonly attemptedAt: number
  readonly previous: EvmHistoryCacheRecord | null
  readonly failureBackoffMs: number
}): EvmHistoryCacheRecord {
  return Object.freeze({
    schemaVersion: 1,
    chainId: input.chainId,
    address: input.address,
    scope: input.scope,
    lastAttemptAt: input.attemptedAt,
    successfulSyncAt: input.previous?.successfulSyncAt ?? null,
    retryAfter: input.attemptedAt + input.failureBackoffMs,
    hasMore: input.previous?.hasMore ?? false,
    historyPageCount: input.previous?.historyPageCount ?? 1,
    historySyncAt: input.previous?.historySyncAt ?? input.previous?.successfulSyncAt ?? null,
    items: normalizeItems(input.previous?.items ?? [], input.scope)
  })
}

function validateDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60_000) {
    throw new Error(`Invalid EVM history ${label}`)
  }
  return value
}

export function createCachedEvmActivityHistorySource(
  options: EvmCachedHistorySourceOptions
): EvmActivityHistorySource {
  const cache = options.cache ?? indexedDbEvmHistoryCache
  const now = options.now ?? Date.now
  const successTtlMs = validateDuration(
    options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS,
    'success TTL'
  )
  const pendingTtlMs = validateDuration(
    options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS,
    'pending TTL'
  )
  const failureBackoffMs = validateDuration(
    options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS,
    'failure backoff'
  )
  const pending = new Map<string, Promise<readonly ActivityItem[]>>()
  const addressQueue = new Map<string, Promise<void>>()

  async function persist(record: EvmHistoryCacheRecord): Promise<void> {
    try {
      await cache.write(record)
    } catch (error) {
      logWarning(
        `[EVM History] cache write failed chain=${options.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
      )
    }
  }

  async function refresh(
    address: string,
    input: ReadEvmAddressActivityInput,
    previous: EvmHistoryCacheRecord | null
  ): Promise<readonly ActivityItem[]> {
    const addressKey = JSON.stringify([input.scope.keyDomainId, input.scope.accountId, address])
    const key = JSON.stringify([addressKey, input.historyPageCount ?? 1])
    const existing = input.signal ? undefined : pending.get(key)
    if (existing) return existing

    const predecessor = addressQueue.get(addressKey)
    const work = (async () => {
      if (predecessor) await predecessor
      const latestPrevious = predecessor
        ? await cache.read(options.chainId, address, input.scope).catch(() => previous)
        : previous
      const attemptedAt = now()
      try {
        const sourceInput = {
          ...input,
          address,
          fromBlock:
            (input.historyPageCount ?? 1) > 1 ? undefined : incrementalStartBlock(latestPrevious)
        }
        const result = options.source.readAddressActivityWithMetadata
          ? await options.source.readAddressActivityWithMetadata(sourceInput)
          : { items: await options.source.readAddressActivity(sourceInput), hasMore: false }
        const fresh = result.items
        const record = successfulRecord({
          chainId: options.chainId,
          address,
          scope: input.scope,
          attemptedAt,
          previous: latestPrevious,
          fresh,
          partial: fresh.some(item => item.completeness === 'partial'),
          hasMore: result.hasMore,
          fullScan: sourceInput.fromBlock === undefined,
          historyPageCount: input.historyPageCount,
          successTtlMs,
          pendingTtlMs
        })
        await persist(record)
        logInfo(`[EVM History] refreshed chain=${options.chainId} items=${record.items.length}`)
        return record.items
      } catch (error) {
        if (!(error instanceof EvmRpcError && error.code === 'cancelled')) {
          await persist(
            failedRecord({
              chainId: options.chainId,
              address,
              scope: input.scope,
              attemptedAt,
              previous: latestPrevious,
              failureBackoffMs
            })
          )
        }
        throw error
      }
    })().finally(() => {
      if (pending.get(key) === work) pending.delete(key)
    })
    const tail = work.then(
      () => {},
      () => {}
    )
    addressQueue.set(addressKey, tail)
    void tail.then(() => {
      if (addressQueue.get(addressKey) === tail) addressQueue.delete(addressKey)
    })
    if (!input.signal) pending.set(key, work)
    return work
  }

  return Object.freeze({
    readAddressActivity: async (input: ReadEvmAddressActivityInput) => {
      const address = normalizeAddress(input.address)
      let cached: EvmHistoryCacheRecord | null = null
      try {
        cached = await cache.read(options.chainId, address, input.scope)
      } catch (error) {
        logWarning(
          `[EVM History] cache read failed chain=${options.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
        )
      }

      const currentTime = now()
      if (cached) {
        const items = normalizeItems(cached.items, input.scope)
        if (
          items.length !== cached.items.length ||
          items.some((item, index) => item !== cached.items[index])
        ) {
          await persist({ ...cached, scope: input.scope, items })
        }
        const retryAfter = cacheRetryAfter(cached, pendingTtlMs)
        logInfo(
          `[EVM History] cache hit chain=${options.chainId} items=${items.length} successful=${cached.successfulSyncAt !== null}`
        )
        if (
          currentTime >= retryAfter ||
          cached.items.some(isLegacyInferredEvmActivity) ||
          (input.historyPageCount ?? 1) > 1
        ) {
          try {
            return await refresh(address, input, cached)
          } catch (error) {
            logWarning(
              `[EVM History] refresh failed chain=${options.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
            )
            if ((input.historyPageCount ?? 1) > 1) throw error
          }
        }
        return items
      }

      logInfo(`[EVM History] cache miss chain=${options.chainId}`)
      return refresh(address, input, null)
    },
    findConfirmedReplacement: (input: FindEvmConfirmedReplacementInput) =>
      options.source.findConfirmedReplacement(input)
  })
}

export function createCachedOnlyEvmActivityHistorySource(
  options: EvmCachedOnlyHistorySourceOptions
): EvmActivityHistorySource {
  const cache = options.cache ?? indexedDbEvmHistoryCache

  return Object.freeze({
    readAddressActivity: async (input: ReadEvmAddressActivityInput) => {
      const address = normalizeAddress(input.address)
      try {
        const cached = await cache.read(options.chainId, address, input.scope)
        if (!cached) {
          logInfo(`[EVM History] cache miss chain=${options.chainId} remote=unavailable`)
          return Object.freeze([])
        }
        const items = normalizeItems(cached.items, input.scope)
        if (items.length !== cached.items.length) {
          try {
            await cache.write({ ...cached, scope: input.scope, items })
          } catch (error) {
            logWarning(
              `[EVM History] cache trim failed chain=${options.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
            )
          }
        }
        logInfo(
          `[EVM History] cache hit chain=${options.chainId} items=${items.length} remote=unavailable`
        )
        return items
      } catch (error) {
        logWarning(
          `[EVM History] cache read failed chain=${options.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
        )
        return Object.freeze([])
      }
    },
    findConfirmedReplacement: async () => null
  })
}

export function createCachedEvmAnkrHistoryBatchSource(options: {
  readonly source: EvmAnkrHistoryClient
  readonly cache?: EvmHistoryCacheRepository
  readonly now?: () => number
}) {
  const cache = options.cache ?? indexedDbEvmHistoryCache
  const now = options.now ?? Date.now
  const pending = new Map<string, Promise<ReadonlyMap<string, readonly ActivityItem[]>>>()

  async function persist(record: EvmHistoryCacheRecord): Promise<void> {
    try {
      await cache.write(record)
    } catch (error) {
      logWarning(
        `[EVM History] batch cache write failed chain=${record.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
      )
    }
  }

  return Object.freeze({
    readAddressActivities: async (
      targets: readonly Omit<EvmAnkrHistoryTarget, 'fromBlock'>[],
      signal?: AbortSignal
    ): Promise<ReadonlyMap<string, readonly ActivityItem[]>> => {
      if (targets.length === 0) return new Map()
      const address = normalizeAddress(targets[0].address)
      const scope = targets[0].scope
      if (
        targets.some(
          target =>
            normalizeAddress(target.address) !== address ||
            target.scope.keyDomainId !== scope.keyDomainId ||
            target.scope.accountId !== scope.accountId
        ) ||
        new Set(targets.map(target => target.chainId)).size !== targets.length
      ) {
        throw new Error('Invalid EVM history batch target partition')
      }
      const key = JSON.stringify([
        scope.keyDomainId,
        scope.accountId,
        address,
        targets.map(target => target.chainId).sort()
      ])
      const existing = signal ? undefined : pending.get(key)
      if (existing) return existing
      const work = (async () => {
        const cached = await Promise.all(
          targets.map(async target => {
            try {
              return await cache.read(target.chainId, address, scope)
            } catch (error) {
              logWarning(
                `[EVM History] batch cache read failed chain=${target.chainId} error=${error instanceof Error ? error.name : 'UnknownError'}`
              )
              return null
            }
          })
        )
        const output = new Map<string, readonly ActivityItem[]>()
        const attemptedAt = now()
        const due = targets.flatMap((target, index) => {
          const record = cached[index]
          if (
            record &&
            !record.items.some(isLegacyInferredEvmActivity) &&
            attemptedAt < cacheRetryAfter(record, DEFAULT_PENDING_TTL_MS)
          ) {
            output.set(target.chainId, normalizeItems(record?.items ?? [], scope))
            return []
          }
          return [
            { ...target, address, fromBlock: incrementalStartBlock(record), previous: record }
          ]
        })
        if (due.length === 0) return output

        let fresh: ReadonlyMap<string, EvmAnkrHistoryResult>
        try {
          fresh = await options.source.readAddressActivities(due, signal)
        } catch (error) {
          fresh = new Map(due.map(target => [target.chainId, { error }]))
        }
        const resolved = new Map(fresh)
        const missingFromSharedPage =
          due.length > 1
            ? due.filter(target => {
                const result = resolved.get(target.chainId)
                return result !== undefined && 'incomplete' in result && result.retrySingleChain
              })
            : []
        for (let index = 0; index < missingFromSharedPage.length; index += 2) {
          await Promise.all(
            missingFromSharedPage.slice(index, index + 2).map(async target => {
              try {
                const single = await options.source.readAddressActivities([target], signal)
                resolved.set(
                  target.chainId,
                  single.get(target.chainId) ?? { incomplete: true, retrySingleChain: false }
                )
              } catch (error) {
                resolved.set(target.chainId, { error })
              }
            })
          )
        }
        await Promise.all(
          due.map(async target => {
            const result = resolved.get(target.chainId)
            const previous = target.previous
            if (result && 'incomplete' in result) {
              const failure = failedRecord({
                chainId: target.chainId,
                address,
                scope,
                attemptedAt,
                previous,
                failureBackoffMs: DEFAULT_FAILURE_BACKOFF_MS
              })
              output.set(target.chainId, failure.items)
              await persist(failure)
              return
            }
            if (!result || 'error' in result) {
              const failure = failedRecord({
                chainId: target.chainId,
                address,
                scope,
                attemptedAt,
                previous,
                failureBackoffMs: DEFAULT_FAILURE_BACKOFF_MS
              })
              output.set(target.chainId, failure.items)
              if (!(result?.error instanceof EvmRpcError && result.error.code === 'cancelled')) {
                await persist(failure)
              }
              return
            }
            const record = successfulRecord({
              chainId: target.chainId,
              address,
              scope,
              attemptedAt,
              previous,
              fresh: result.items,
              partial: result.partial,
              hasMore: result.hasMore,
              fullScan: target.fromBlock === undefined,
              historyPageCount: 1,
              successTtlMs: DEFAULT_SUCCESS_TTL_MS,
              pendingTtlMs: DEFAULT_PENDING_TTL_MS
            })
            output.set(target.chainId, record.items)
            await persist(record)
          })
        )
        return output
      })().finally(() => {
        if (pending.get(key) === work) pending.delete(key)
      })
      if (!signal) pending.set(key, work)
      return work
    }
  })
}
