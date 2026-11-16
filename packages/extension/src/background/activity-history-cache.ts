import { parseActivityReadModel, type ActivityItem, type ActivityScope } from '@/core/activity'
import { getBitcoinChainId } from '@/core/chains/registry/product-chain-definitions'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import type { Network } from '@/types'

const LEGACY_STORAGE_KEY_PREFIX = 'activity_history_cache_v2:'
const STORAGE_KEY_PREFIX = 'activity_history_cache_v3:'
const DB_NAME = 'noir-wallet-activity-history-cache'
const DB_VERSION = 1
const STORE_NAME = 'records'
const SCHEMA_VERSION = 2
export const ACTIVITY_HISTORY_CACHE_ITEM_LIMIT = 50

interface PersistentStorageArea {
  readonly get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
  readonly remove: (keys: string | string[]) => Promise<void>
}

interface ActivityHistoryStore {
  readonly read: (key: string) => Promise<unknown>
  readonly write: (key: string, value: unknown) => Promise<void>
  readonly removeLegacyProjections: () => Promise<void>
  readonly deleteByPrefixes: (prefixes: readonly string[]) => Promise<void>
  readonly clear: () => Promise<void>
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open Activity history cache'))
    request.onblocked = () => {
      blocked = true
      reject(new Error('Activity history cache upgrade is blocked'))
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Activity history cache request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Activity history cache transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Activity history cache transaction aborted'))
  })
}

const indexedDbActivityHistoryStore: ActivityHistoryStore = {
  async read(key) {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const completion = transactionDone(transaction)
      const value = await requestResult(transaction.objectStore(STORE_NAME).get(key))
      await completion
      return value
    } finally {
      database.close()
    }
  },
  async write(key, value) {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const completion = transactionDone(transaction)
      transaction.objectStore(STORE_NAME).put(value, key)
      await completion
    } finally {
      database.close()
    }
  },
  async removeLegacyProjections() {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const completion = transactionDone(transaction)
      const request = transaction.objectStore(STORE_NAME).openCursor()
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return resolve()
          if (
            typeof cursor.key === 'string' &&
            cursor.key.startsWith(STORAGE_KEY_PREFIX) &&
            (/-evm-(?:main|private|all)$/.test(cursor.key) ||
              !isRecord(cursor.value) ||
              cursor.value.schemaVersion !== SCHEMA_VERSION ||
              hasLegacyEvmData(cursor.value))
          ) {
            cursor.delete()
          }
          cursor.continue()
        }
        request.onerror = () =>
          reject(request.error ?? new Error('Failed to scan legacy Activity history'))
      })
      await completion
    } finally {
      database.close()
    }
  },
  async deleteByPrefixes(prefixes) {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const completion = transactionDone(transaction)
      const store = transaction.objectStore(STORE_NAME)
      const request = store.openKeyCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const cursorKey = cursor.key
        if (
          typeof cursorKey === 'string' &&
          prefixes.some(prefix => cursorKey.startsWith(prefix))
        ) {
          store.delete(cursor.primaryKey)
        }
        cursor.continue()
      }
      await completion
    } finally {
      database.close()
    }
  },
  async clear() {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const completion = transactionDone(transaction)
      transaction.objectStore(STORE_NAME).clear()
      await completion
    } finally {
      database.close()
    }
  }
}

interface ActivityHistoryCacheRecord {
  readonly refreshedAtByChainId: Readonly<Record<string, number>>
  readonly items: readonly ActivityItem[]
}

function storageKey(network: Network, scope: ActivityScope, partition = 'default'): string {
  if (!/^[a-z0-9-]{1,64}$/.test(partition)) {
    throw new Error('Invalid Activity history cache partition')
  }
  return `${STORAGE_KEY_PREFIX}${network}:${scope.keyDomainId}:${scope.accountId}:${partition}`
}

function isEvmItem(item: ActivityItem): boolean {
  return item.segments.some(
    segment => segment.target.kind === 'onchain' && segment.target.chainId.startsWith('eip155:')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasLegacyEvmData(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (
    isRecord(value.refreshedAtByChainId) &&
    Object.keys(value.refreshedAtByChainId).some(chainId => chainId.startsWith('eip155:'))
  ) {
    return true
  }
  return (
    Array.isArray(value.items) &&
    value.items.some(
      item =>
        isRecord(item) &&
        Array.isArray(item.segments) &&
        item.segments.some(
          segment =>
            isRecord(segment) &&
            isRecord(segment.target) &&
            segment.target.kind === 'onchain' &&
            typeof segment.target.chainId === 'string' &&
            segment.target.chainId.startsWith('eip155:')
        )
    )
  )
}

function parseRecord(
  value: unknown,
  scope: ActivityScope,
  network: Network
): ActivityHistoryCacheRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isRecord(value.refreshedAtByChainId) ||
    !Array.isArray(value.items)
  ) {
    return null
  }
  try {
    const model = parseActivityReadModel({
      scope,
      items: value.items,
      partialItemCount: value.items.filter(
        item => isRecord(item) && item.completeness === 'partial'
      ).length
    })
    if (model.items.some(item => item.source !== 'rpc' || isEvmItem(item))) return null
    const allowedChains = new Set([
      getBitcoinChainId(network),
      getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId,
      getNearNetworkConfig(network).chainId
    ])
    const refreshedAtByChainId = Object.fromEntries(
      Object.entries(value.refreshedAtByChainId).filter(
        (entry): entry is [string, number] =>
          allowedChains.has(entry[0]) &&
          typeof entry[1] === 'number' &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0
      )
    )
    if (
      Object.keys(refreshedAtByChainId).length !== Object.keys(value.refreshedAtByChainId).length ||
      model.items.some(item =>
        item.segments.some(
          segment => segment.target.kind !== 'onchain' || !allowedChains.has(segment.target.chainId)
        )
      )
    ) {
      return null
    }
    const items = Object.freeze(
      [...model.items]
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            right.createdAt - left.createdAt ||
            left.id.localeCompare(right.id)
        )
        .slice(0, ACTIVITY_HISTORY_CACHE_ITEM_LIMIT)
    )
    return Object.freeze({
      refreshedAtByChainId: Object.freeze(refreshedAtByChainId),
      items
    })
  } catch {
    return null
  }
}

export class ActivityHistoryCache {
  private legacyCleanup: Promise<void> | null = null

  constructor(
    private readonly network: Network,
    private readonly storage: PersistentStorageArea = chrome.storage.local,
    private readonly repository: ActivityHistoryStore = indexedDbActivityHistoryStore
  ) {}

  private async removeLegacyChromeRecords(): Promise<void> {
    if (!this.legacyCleanup) {
      this.legacyCleanup = (async () => {
        const results = await Promise.allSettled([
          (async () => {
            const stored = await this.storage.get(null)
            const keys = Object.keys(stored).filter(key =>
              key.startsWith(LEGACY_STORAGE_KEY_PREFIX)
            )
            if (keys.length > 0) await this.storage.remove(keys)
          })(),
          this.repository.removeLegacyProjections()
        ])
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })().catch(() => {
        this.legacyCleanup = null
      })
    }
    await this.legacyCleanup
  }

  async read(scope: ActivityScope, partition?: string): Promise<ActivityHistoryCacheRecord | null> {
    await this.removeLegacyChromeRecords()
    const key = storageKey(this.network, scope, partition)
    return parseRecord(await this.repository.read(key), scope, this.network)
  }

  async write(
    scope: ActivityScope,
    refreshedAtByChainId: Readonly<Record<string, number>>,
    items: readonly ActivityItem[],
    partition?: string
  ): Promise<void> {
    const parsed = parseRecord(
      {
        schemaVersion: SCHEMA_VERSION,
        refreshedAtByChainId: Object.fromEntries(
          Object.entries(refreshedAtByChainId).filter(([chainId]) => !chainId.startsWith('eip155:'))
        ),
        items: [...items]
          .filter(item => !isEvmItem(item))
          .sort(
            (left, right) =>
              right.updatedAt - left.updatedAt ||
              right.createdAt - left.createdAt ||
              left.id.localeCompare(right.id)
          )
          .slice(0, ACTIVITY_HISTORY_CACHE_ITEM_LIMIT)
      },
      scope,
      this.network
    )
    if (!parsed) throw new Error('Invalid Activity history cache record')
    const key = storageKey(this.network, scope, partition)
    await this.repository.write(key, {
      schemaVersion: SCHEMA_VERSION,
      refreshedAtByChainId: parsed.refreshedAtByChainId,
      items: parsed.items
    })
  }

  async deleteByScope(scope: ActivityScope): Promise<void> {
    const stored = await this.storage.get(null)
    const prefixes = [
      `${STORAGE_KEY_PREFIX}mainnet:${scope.keyDomainId}:${scope.accountId}:`,
      `${STORAGE_KEY_PREFIX}testnet:${scope.keyDomainId}:${scope.accountId}:`
    ]
    const legacyPrefixes = [
      `${LEGACY_STORAGE_KEY_PREFIX}mainnet:${scope.keyDomainId}:${scope.accountId}:`,
      `${LEGACY_STORAGE_KEY_PREFIX}testnet:${scope.keyDomainId}:${scope.accountId}:`
    ]
    const keys = Object.keys(stored).filter(key =>
      legacyPrefixes.some(prefix => key.startsWith(prefix))
    )
    await this.repository.deleteByPrefixes(prefixes)
    if (keys.length > 0) await this.storage.remove(keys)
  }

  async clear(): Promise<void> {
    const stored = await this.storage.get(null)
    const keys = Object.keys(stored).filter(key => key.startsWith(LEGACY_STORAGE_KEY_PREFIX))
    await this.repository.clear()
    if (keys.length > 0) await this.storage.remove(keys)
  }
}
