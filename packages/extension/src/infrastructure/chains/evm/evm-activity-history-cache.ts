import { parseActivityReadModel, type ActivityItem, type ActivityScope } from '@/core/activity'
import { parseChainId } from '@/core/chains/registry'
import { isZeroValueEvmTokenActivity } from './evm-indexed-activity'

const DB_NAME = 'noir-wallet-evm-history-cache'
const DB_VERSION = 2
const STORE_NAME = 'records'
const MAX_ITEMS = 2_000

export interface EvmHistoryCacheRecord {
  readonly schemaVersion: 1
  readonly chainId: string
  readonly address: string
  readonly scope: ActivityScope
  readonly lastAttemptAt: number
  readonly successfulSyncAt: number | null
  readonly retryAfter: number
  readonly hasMore?: boolean
  readonly historyPageCount?: number
  readonly historySyncAt?: number | null
  readonly items: readonly ActivityItem[]
}

export interface EvmHistoryCacheRepository {
  readonly read: (
    chainId: string,
    address: string,
    scope: ActivityScope
  ) => Promise<EvmHistoryCacheRecord | null>
  readonly write: (record: EvmHistoryCacheRecord) => Promise<void>
}

export async function listEvmHistoryCacheByScope(
  scopeValue: ActivityScope
): Promise<readonly EvmHistoryCacheRecord[]> {
  const scope = parseActivityReadModel({
    scope: scopeValue,
    items: [],
    partialItemCount: 0
  }).scope
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const completion = transactionDone(transaction)
    const records: EvmHistoryCacheRecord[] = []
    const request = transaction.objectStore(STORE_NAME).openCursor()
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return resolve()
        const parsed = parseCacheRecord(cursor.value)
        if (
          parsed?.scope.keyDomainId === scope.keyDomainId &&
          parsed.scope.accountId === scope.accountId
        ) {
          if (cursor.key === scopedCacheKey(scope, parsed.chainId, parsed.address)) {
            records.push(parsed)
          }
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('Failed to scan EVM history cache'))
    })
    await completion
    return Object.freeze(records)
  } finally {
    database.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
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

function parseAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error('Invalid EVM history cache address')
  }
  return value
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid EVM history cache ${label}`)
  }
  return value
}

function parseItems(
  value: unknown,
  scope: ActivityScope,
  chainId: string
): readonly ActivityItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new Error('Invalid EVM history cache items')
  }
  const model = parseActivityReadModel({
    scope,
    items: value,
    partialItemCount: value.filter(item => isRecord(item) && item.completeness === 'partial').length
  })
  for (const item of model.items) {
    if (
      item.source !== 'rpc' ||
      !item.id.startsWith(`rpc:evm:${chainId}:`) ||
      item.segments.some(
        segment => segment.target.kind !== 'onchain' || segment.target.chainId !== chainId
      )
    ) {
      throw new Error('EVM history cache item does not match its chain')
    }
  }
  return Object.freeze(model.items.filter(item => !isZeroValueEvmTokenActivity(item)))
}

function parseCurrentRecord(value: Record<string, unknown>): EvmHistoryCacheRecord {
  if (
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'chainId',
        'address',
        'scope',
        'lastAttemptAt',
        'successfulSyncAt',
        'retryAfter',
        'items'
      ],
      ['hasMore', 'historyPageCount', 'historySyncAt']
    ) ||
    value.schemaVersion !== 1
  ) {
    throw new Error('Invalid EVM history cache record')
  }
  if (typeof value.chainId !== 'string') throw new Error('Invalid EVM history cache chain')
  const chainId = parseChainId(value.chainId).id
  if (!chainId.startsWith('eip155:')) throw new Error('EVM history cache requires an EVM chain')
  const address = parseAddress(value.address)
  const lastAttemptAt = parseTimestamp(value.lastAttemptAt, 'last attempt')
  const successfulSyncAt =
    value.successfulSyncAt === null
      ? null
      : parseTimestamp(value.successfulSyncAt, 'successful sync')
  const retryAfter = parseTimestamp(value.retryAfter, 'retry time')
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new Error('Invalid EVM history cache pagination state')
  }
  if (
    value.historyPageCount !== undefined &&
    (typeof value.historyPageCount !== 'number' ||
      !Number.isSafeInteger(value.historyPageCount) ||
      value.historyPageCount < 1 ||
      value.historyPageCount > 10)
  ) {
    throw new Error('Invalid EVM history cache page count')
  }
  const historySyncAt =
    value.historySyncAt === undefined || value.historySyncAt === null
      ? value.historySyncAt
      : parseTimestamp(value.historySyncAt, 'history sync')
  if (successfulSyncAt !== null && successfulSyncAt > lastAttemptAt) {
    throw new Error('EVM history cache successful sync exceeds its last attempt')
  }
  if (
    historySyncAt !== undefined &&
    historySyncAt !== null &&
    (successfulSyncAt === null || historySyncAt > successfulSyncAt)
  ) {
    throw new Error('EVM history cache history sync exceeds its successful sync')
  }
  if (retryAfter < lastAttemptAt) {
    throw new Error('EVM history cache retry time precedes its last attempt')
  }
  const parsed = parseActivityReadModel({
    scope: value.scope,
    items: [],
    partialItemCount: 0
  })
  return Object.freeze({
    schemaVersion: 1,
    chainId,
    address,
    scope: parsed.scope,
    lastAttemptAt,
    successfulSyncAt,
    retryAfter,
    ...(value.hasMore === undefined ? {} : { hasMore: value.hasMore }),
    ...(value.historyPageCount === undefined ? {} : { historyPageCount: value.historyPageCount }),
    ...(historySyncAt === undefined ? {} : { historySyncAt }),
    items: parseItems(value.items, parsed.scope, chainId)
  })
}

function parseCacheRecord(value: unknown): EvmHistoryCacheRecord | null {
  if (!isRecord(value)) return null
  try {
    return parseCurrentRecord(value)
  } catch {
    return null
  }
}

function cacheRecordMatchesScope(value: unknown, scope: ActivityScope): boolean {
  if (!isRecord(value)) return false
  const candidateScope = isRecord(value.scope) ? value.scope : null
  return (
    candidateScope?.keyDomainId === scope.keyDomainId &&
    candidateScope.accountId === scope.accountId
  )
}

function cacheKey(chainId: string, address: string): string {
  const parsedChain = parseChainId(chainId)
  if (!parsedChain.id.startsWith('eip155:')) throw new Error('Invalid EVM history cache chain')
  return `${parsedChain.id}:${parseAddress(address.toLowerCase())}`
}

function scopedCacheKey(scope: ActivityScope, chainId: string, address: string): string {
  const parsedScope = parseActivityReadModel({ scope, items: [], partialItemCount: 0 }).scope
  return `${parsedScope.keyDomainId}:${parsedScope.accountId}:${cacheKey(chainId, address)}`
}

let legacyCleanup: Promise<void> | null = null

async function removeLegacyRecords(database: IDBDatabase): Promise<void> {
  const stores = [STORE_NAME, ...(database.objectStoreNames.contains('items') ? ['items'] : [])]
  const transaction = database.transaction(stores, 'readwrite')
  const completion = transactionDone(transaction)
  if (database.objectStoreNames.contains('items')) {
    transaction.objectStore('items').clear()
  }
  const request = transaction.objectStore(STORE_NAME).openCursor()
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve()
      const parsed = parseCacheRecord(cursor.value)
      if (!parsed || cursor.key !== scopedCacheKey(parsed.scope, parsed.chainId, parsed.address)) {
        cursor.delete()
      }
      cursor.continue()
    }
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to remove legacy EVM history'))
  })
  await completion
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      legacyCleanup ??= removeLegacyRecords(database).catch(error => {
        legacyCleanup = null
        throw error
      })
      legacyCleanup.then(
        () => resolve(database),
        error => {
          database.close()
          reject(error)
        }
      )
    }
    request.onerror = () => reject(request.error ?? new Error('Failed to open EVM history cache'))
    request.onblocked = () => {
      blocked = true
      reject(new Error('EVM history cache upgrade is blocked'))
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('EVM history cache request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('EVM history cache transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('EVM history cache transaction was aborted'))
  })
}

async function readRecord(
  chainId: string,
  address: string,
  scope: ActivityScope
): Promise<EvmHistoryCacheRecord | null> {
  const key = scopedCacheKey(scope, chainId, address)
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const completion = transactionDone(transaction)
    const raw = await requestResult(transaction.objectStore(STORE_NAME).get(key))
    await completion
    const parsed = parseCacheRecord(raw)
    return parsed?.chainId === parseChainId(chainId).id &&
      parsed.address === address.toLowerCase() &&
      parsed.scope.keyDomainId === scope.keyDomainId &&
      parsed.scope.accountId === scope.accountId
      ? parsed
      : null
  } finally {
    database.close()
  }
}

async function writeRecord(record: EvmHistoryCacheRecord): Promise<void> {
  const parsed = parseCurrentRecord(record as unknown as Record<string, unknown>)
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const completion = transactionDone(transaction)
    const store = transaction.objectStore(STORE_NAME)
    const key = scopedCacheKey(parsed.scope, parsed.chainId, parsed.address)
    const current = parseCacheRecord(await requestResult(store.get(key)))
    store.put(mergeEvmHistoryCacheRecords(current, parsed), key)
    await completion
  } finally {
    database.close()
  }
}

export function mergeEvmHistoryCacheRecords(
  current: EvmHistoryCacheRecord | null,
  incoming: EvmHistoryCacheRecord
): EvmHistoryCacheRecord {
  if (!current) return incoming
  if (
    current.scope.keyDomainId !== incoming.scope.keyDomainId ||
    current.scope.accountId !== incoming.scope.accountId ||
    current.chainId !== incoming.chainId ||
    current.address !== incoming.address
  ) {
    throw new Error('EVM history cache key does not match its record')
  }
  const byId = new Map(current.items.map(item => [item.id, item] as const))
  for (const item of incoming.items) {
    const previous = byId.get(item.id)
    if (!previous || item.updatedAt >= previous.updatedAt) byId.set(item.id, item)
  }
  const newest = current.lastAttemptAt > incoming.lastAttemptAt ? current : incoming
  const currentDepth = current.historyPageCount ?? 1
  const incomingDepth = incoming.historyPageCount ?? 1
  const currentHistorySyncAt = current.historySyncAt ?? current.successfulSyncAt ?? -1
  const incomingHistorySyncAt = incoming.historySyncAt ?? incoming.successfulSyncAt ?? -1
  const currentScanSucceeded = currentHistorySyncAt === current.lastAttemptAt
  const incomingScanSucceeded = incomingHistorySyncAt === incoming.lastAttemptAt
  let pagination = newest
  if (currentDepth !== incomingDepth) {
    pagination = currentDepth > incomingDepth ? current : incoming
  } else if (currentHistorySyncAt !== incomingHistorySyncAt) {
    pagination = currentHistorySyncAt > incomingHistorySyncAt ? current : incoming
  } else if (currentScanSucceeded !== incomingScanSucceeded) {
    pagination = currentScanSucceeded ? current : incoming
  }
  const latestSuccessfulSyncAt = Math.max(
    current.successfulSyncAt ?? -1,
    incoming.successfulSyncAt ?? -1
  )
  return parseCurrentRecord({
    ...newest,
    successfulSyncAt: latestSuccessfulSyncAt < 0 ? null : latestSuccessfulSyncAt,
    hasMore: pagination.hasMore,
    historyPageCount: pagination.historyPageCount,
    historySyncAt: pagination.historySyncAt ?? pagination.successfulSyncAt,
    items: [...byId.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, MAX_ITEMS)
  })
}

export const indexedDbEvmHistoryCache: EvmHistoryCacheRepository = Object.freeze({
  read: readRecord,
  write: writeRecord
})

function deleteStoreRecordsByScope(store: IDBObjectStore, scope: ActivityScope): Promise<number> {
  return new Promise((resolve, reject) => {
    let deleted = 0
    const request = store.openCursor()
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to scan EVM history cache for account cleanup'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(deleted)
        return
      }
      if (cacheRecordMatchesScope(cursor.value, scope)) {
        cursor.delete()
        deleted += 1
      }
      cursor.continue()
    }
  })
}

export async function deleteHistoryCacheByAccountScope(scopeValue: ActivityScope): Promise<number> {
  const scope = parseActivityReadModel({
    scope: scopeValue,
    items: [],
    partialItemCount: 0
  }).scope
  const database = await openDatabase()
  try {
    const storeNames = [
      STORE_NAME,
      ...(database.objectStoreNames.contains('items') ? ['items'] : [])
    ]
    const transaction = database.transaction(storeNames, 'readwrite')
    const completion = transactionDone(transaction)
    const counts = await Promise.all(
      storeNames.map(storeName =>
        deleteStoreRecordsByScope(transaction.objectStore(storeName), scope)
      )
    )
    await completion
    return counts.reduce((total, count) => total + count, 0)
  } finally {
    database.close()
  }
}

export async function deleteHistoryCache(): Promise<void> {
  try {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const completion = transactionDone(transaction)
      transaction.objectStore(STORE_NAME).clear()
      await completion
      if (database.objectStoreNames.contains('items')) {
        const legacyTransaction = database.transaction('items', 'readwrite')
        const legacyCompletion = transactionDone(legacyTransaction)
        legacyTransaction.objectStore('items').clear()
        await legacyCompletion
      }
    } finally {
      database.close()
    }
  } catch {
    // Wallet reset cleanup remains best-effort across browser storage implementations.
  }
}
