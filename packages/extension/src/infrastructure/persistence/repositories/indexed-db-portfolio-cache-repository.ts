import {
  parseAccountId,
  parseChainAccountId,
  type AccountId,
  type ChainAccountId
} from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parsePortfolioSourceState } from '@/core/portfolio'
import type { PortfolioScope } from '@/core/portfolio'
import type {
  PortfolioCacheRecord,
  PortfolioCacheRepository,
  StorageV2GenerationId
} from '@/ports/repositories'
import { parseStorageV2ChainAccount, parseStorageV2GenerationId } from '../schema'
import type { Network } from '@/types/wallet'

export const PORTFOLIO_CACHE_DATABASE = Object.freeze({
  name: 'noir-wallet-portfolio-v2-db',
  version: 2
})

const STORE = 'sources'
const INVALIDATIONS = 'invalidations'
const BY_ACCOUNT = 'byAccount'
const BY_GENERATION = 'byGeneration'
const BY_GENERATION_ACCOUNT = 'byGenerationAccount'
const MAXIMUM_SOURCES_PER_ACCOUNT = 100
const MAXIMUM_INVALIDATIONS_PER_SCOPE = 200

export type PortfolioInvalidationDomain = 'chain' | 'confidential'

export interface PortfolioInvalidationRecordScope {
  readonly network: Network
  readonly generationId: StorageV2GenerationId
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface PortfolioInvalidationMarker {
  readonly chainId: ChainId
  readonly domain: PortfolioInvalidationDomain
  readonly revision: number
  readonly invalidatedAt: number
}

interface StoredPortfolioInvalidation
  extends PortfolioInvalidationRecordScope, PortfolioInvalidationMarker {
  readonly schemaVersion: 1
  readonly accountKey: string
  readonly scopeKey: string
}

interface StoredPortfolioCacheRecord extends PortfolioCacheRecord {
  readonly schemaVersion: 1
  readonly chainAccountId: string
  readonly accountKey: string
  readonly generationAccountKey: string
}

export interface IndexedDbPortfolioCacheRepositoryOptions {
  readonly databaseName?: string
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
  const allowed = [...required, ...optional]
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.includes(key))
  )
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid Portfolio cache timestamp')
  }
  return value
}

function parseScope(value: PortfolioScope): PortfolioScope {
  if (!isRecord(value) || !hasExactKeys(value, ['keyDomainId', 'accountId'])) {
    throw new Error('Invalid Portfolio cache Account scope')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function accountKey(scope: PortfolioScope): string {
  return JSON.stringify([scope.keyDomainId, scope.accountId])
}

function generationAccountKey(generationId: StorageV2GenerationId, scope: PortfolioScope): string {
  return JSON.stringify([generationId, scope.keyDomainId, scope.accountId])
}

function parseInvalidationScope(
  value: PortfolioInvalidationRecordScope
): PortfolioInvalidationRecordScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['network', 'generationId', 'keyDomainId', 'accountId']) ||
    (value.network !== 'mainnet' && value.network !== 'testnet')
  ) {
    throw new Error('Invalid Portfolio invalidation scope')
  }
  return Object.freeze({
    network: value.network,
    generationId: parseStorageV2GenerationId(value.generationId),
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function invalidationScopeKey(scope: PortfolioInvalidationRecordScope): string {
  return JSON.stringify([scope.network, scope.generationId, scope.keyDomainId, scope.accountId])
}

function invalidationKey(
  scope: PortfolioInvalidationRecordScope,
  marker: Pick<PortfolioInvalidationMarker, 'chainId' | 'domain'>
): string[] {
  return [
    scope.network,
    scope.generationId,
    scope.keyDomainId,
    scope.accountId,
    marker.chainId,
    marker.domain
  ]
}

function parseInvalidationMarker(value: unknown): PortfolioInvalidationMarker {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['chainId', 'domain', 'revision', 'invalidatedAt']) ||
    typeof value.chainId !== 'string' ||
    (value.domain !== 'chain' && value.domain !== 'confidential') ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new Error('Invalid Portfolio invalidation marker')
  }
  return Object.freeze({
    chainId: parseChainId(value.chainId).id,
    domain: value.domain,
    revision: value.revision,
    invalidatedAt: parseTimestamp(value.invalidatedAt)
  })
}

function parseStoredInvalidation(value: unknown): StoredPortfolioInvalidation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'network',
      'generationId',
      'keyDomainId',
      'accountId',
      'chainId',
      'domain',
      'revision',
      'invalidatedAt',
      'accountKey',
      'scopeKey'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.accountKey !== 'string' ||
    typeof value.scopeKey !== 'string'
  ) {
    throw new Error('Invalid persisted Portfolio invalidation')
  }
  const scope = parseInvalidationScope({
    network: value.network as Network,
    generationId: value.generationId as StorageV2GenerationId,
    keyDomainId: value.keyDomainId as KeyDomainId,
    accountId: value.accountId as AccountId
  })
  const marker = parseInvalidationMarker({
    chainId: value.chainId,
    domain: value.domain,
    revision: value.revision,
    invalidatedAt: value.invalidatedAt
  })
  if (value.accountKey !== accountKey(scope) || value.scopeKey !== invalidationScopeKey(scope)) {
    throw new Error('Persisted Portfolio invalidation index mismatch')
  }
  return Object.freeze({
    schemaVersion: 1,
    ...scope,
    ...marker,
    accountKey: value.accountKey,
    scopeKey: value.scopeKey
  })
}

function toStoredRecord(recordValue: PortfolioCacheRecord): StoredPortfolioCacheRecord {
  if (
    !isRecord(recordValue) ||
    !hasExactKeys(recordValue, ['generationId', 'cachedAt', 'source'])
  ) {
    throw new Error('Invalid Portfolio cache record')
  }
  const generationId = parseStorageV2GenerationId(recordValue.generationId)
  const cachedAt = parseTimestamp(recordValue.cachedAt)
  const chainAccount = parseStorageV2ChainAccount(recordValue.source.chainAccount)
  const state = parsePortfolioSourceState({
    status: recordValue.source.status,
    balances: recordValue.source.balances,
    ...(recordValue.source.errorCode === undefined
      ? {}
      : { errorCode: recordValue.source.errorCode })
  })
  const source = Object.freeze({ chainAccount, ...state })
  if (state.balances.some(balance => balance.updatedAt > cachedAt)) {
    throw new Error('Portfolio cache timestamp is older than its balance snapshot')
  }
  return Object.freeze({
    schemaVersion: 1,
    generationId,
    cachedAt,
    chainAccountId: chainAccount.id,
    accountKey: accountKey(chainAccount.scope),
    generationAccountKey: generationAccountKey(generationId, chainAccount.scope),
    source
  })
}

function fromStoredRecord(value: unknown): PortfolioCacheRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'generationId',
      'cachedAt',
      'chainAccountId',
      'accountKey',
      'generationAccountKey',
      'source'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.chainAccountId !== 'string' ||
    typeof value.accountKey !== 'string' ||
    typeof value.generationAccountKey !== 'string' ||
    !isRecord(value.source) ||
    !hasExactKeys(value.source, ['chainAccount', 'status', 'balances'], ['errorCode'])
  ) {
    throw new Error('Invalid persisted Portfolio cache record')
  }
  const generationId = parseStorageV2GenerationId(value.generationId)
  const cachedAt = parseTimestamp(value.cachedAt)
  const chainAccount = parseStorageV2ChainAccount(value.source.chainAccount)
  const state = parsePortfolioSourceState({
    status: value.source.status,
    balances: value.source.balances,
    ...(value.source.errorCode === undefined ? {} : { errorCode: value.source.errorCode })
  })
  if (state.balances.some(balance => balance.updatedAt > cachedAt)) {
    throw new Error('Persisted Portfolio cache timestamp is older than its balance snapshot')
  }
  if (
    parseChainAccountId(value.chainAccountId) !== chainAccount.id ||
    value.accountKey !== accountKey(chainAccount.scope) ||
    value.generationAccountKey !== generationAccountKey(generationId, chainAccount.scope)
  ) {
    throw new Error('Persisted Portfolio cache index mismatch')
  }
  return Object.freeze({
    generationId,
    cachedAt,
    source: Object.freeze({ chainAccount, ...state })
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Portfolio cache request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Portfolio cache transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Portfolio cache transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, PORTFOLIO_CACHE_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Portfolio cache open failed'))
    request.onblocked = () => reject(new Error('Portfolio cache upgrade is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, {
          keyPath: ['generationId', 'chainAccountId']
        })
        store.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        store.createIndex(BY_GENERATION, 'generationId', { unique: false })
        store.createIndex(BY_GENERATION_ACCOUNT, 'generationAccountKey', { unique: false })
      }
      if (!database.objectStoreNames.contains(INVALIDATIONS)) {
        const store = database.createObjectStore(INVALIDATIONS, {
          keyPath: ['network', 'generationId', 'keyDomainId', 'accountId', 'chainId', 'domain']
        })
        store.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        store.createIndex(BY_GENERATION, 'generationId', { unique: false })
        store.createIndex(BY_GENERATION_ACCOUNT, 'scopeKey', { unique: false })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

async function runStores<T>(
  databaseName: string,
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const database = await openDatabase(databaseName)
  const transaction = database.transaction([...storeNames], mode)
  const completion = transactionDone(transaction)
  try {
    const result = await operation(transaction)
    await completion
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The transaction may already be complete.
    }
    await completion.catch(() => {})
    throw error
  } finally {
    database.close()
  }
}

function runDatabase<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  return runStores(databaseName, [STORE], mode, transaction =>
    operation(transaction.objectStore(STORE))
  )
}

function deleteByIndex(store: IDBObjectStore, indexName: string, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let deleted = 0
    const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(key))
    request.onerror = () => reject(request.error ?? new Error('Portfolio cache cursor failed'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(deleted)
        return
      }
      store.delete(cursor.primaryKey)
      deleted += 1
      cursor.continue()
    }
  })
}

export class IndexedDbPortfolioCacheRepository implements PortfolioCacheRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbPortfolioCacheRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PORTFOLIO_CACHE_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Portfolio cache database name')
    }
  }

  async get(generationIdValue: StorageV2GenerationId, chainAccountIdValue: ChainAccountId) {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    const chainAccountId = parseChainAccountId(chainAccountIdValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const value = await requestResult<unknown>(store.get([generationId, chainAccountId]))
      return value === undefined ? null : fromStoredRecord(value)
    })
  }

  async list(generationIdValue: StorageV2GenerationId, scopeValue: PortfolioScope) {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    const scope = parseScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store
          .index(BY_GENERATION_ACCOUNT)
          .getAll(IDBKeyRange.only(generationAccountKey(generationId, scope)), 101)
      )
      if (values.length > MAXIMUM_SOURCES_PER_ACCOUNT) {
        throw new Error('Portfolio cache Account capacity is corrupted')
      }
      return Object.freeze(values.map(fromStoredRecord))
    })
  }

  async put(recordValue: PortfolioCacheRecord): Promise<void> {
    const record = toStoredRecord(recordValue)
    await runDatabase(this.databaseName, 'readwrite', async store => {
      const existing = await requestResult<unknown>(
        store.get([record.generationId, record.chainAccountId])
      )
      if (existing === undefined) {
        const count = await requestResult(
          store.index(BY_GENERATION_ACCOUNT).count(IDBKeyRange.only(record.generationAccountKey))
        )
        if (count >= MAXIMUM_SOURCES_PER_ACCOUNT) {
          throw new Error('Portfolio cache Account capacity exceeded')
        }
      } else {
        const previous = fromStoredRecord(existing)
        if (previous.cachedAt >= record.cachedAt) return
      }
      store.put(record)
    })
  }

  async markStaleByAccountScope(
    scopeValue: PortfolioScope,
    chainIds: readonly string[],
    now = Date.now(),
    generationIdValue?: StorageV2GenerationId
  ): Promise<number> {
    const scope = parseScope(scopeValue)
    const timestamp = parseTimestamp(now)
    const generationId =
      generationIdValue === undefined ? undefined : parseStorageV2GenerationId(generationIdValue)
    const selectedChains = new Set(chainIds)
    if (selectedChains.size === 0) return 0
    return runDatabase(
      this.databaseName,
      'readwrite',
      store =>
        new Promise<number>((resolve, reject) => {
          let marked = 0
          const request = store.index(BY_ACCOUNT).openCursor(IDBKeyRange.only(accountKey(scope)))
          request.onerror = () =>
            reject(request.error ?? new Error('Portfolio cache cursor failed'))
          request.onsuccess = () => {
            try {
              const cursor = request.result
              if (!cursor) {
                resolve(marked)
                return
              }
              const existing = fromStoredRecord(cursor.value)
              if (
                selectedChains.has(existing.source.chainAccount.scope.chainId) &&
                (generationId === undefined || existing.generationId === generationId)
              ) {
                const cachedAt = Math.max(timestamp, existing.cachedAt + 1)
                const record = toStoredRecord({
                  generationId: existing.generationId,
                  cachedAt,
                  source: Object.freeze({
                    chainAccount: existing.source.chainAccount,
                    status: 'loading',
                    balances: existing.source.balances
                  })
                })
                cursor.update(record)
                marked += 1
              }
              cursor.continue()
            } catch (error) {
              reject(error)
            }
          }
        })
    )
  }

  async markInvalidated(
    scopeValue: PortfolioInvalidationRecordScope,
    chainIds: readonly string[],
    domain: PortfolioInvalidationDomain = 'chain',
    now = Date.now()
  ): Promise<readonly PortfolioInvalidationMarker[]> {
    const scope = parseInvalidationScope(scopeValue)
    if (domain !== 'chain' && domain !== 'confidential') {
      throw new Error('Invalid Portfolio invalidation domain')
    }
    const invalidatedAt = parseTimestamp(now)
    const chains = [...new Set(chainIds.map(chainId => parseChainId(chainId).id))]
    if (chains.length === 0) return Object.freeze([])
    return runStores(this.databaseName, [INVALIDATIONS], 'readwrite', async transaction => {
      const store = transaction.objectStore(INVALIDATIONS)
      const count = await requestResult(
        store.index(BY_GENERATION_ACCOUNT).count(IDBKeyRange.only(invalidationScopeKey(scope)))
      )
      let available = MAXIMUM_INVALIDATIONS_PER_SCOPE - count
      const markers: PortfolioInvalidationMarker[] = []
      for (const chainId of chains) {
        const key = invalidationKey(scope, { chainId, domain })
        const existing = await requestResult<unknown>(store.get(key))
        if (existing === undefined && available-- <= 0) {
          throw new Error('Portfolio invalidation scope capacity exceeded')
        }
        const previous = existing === undefined ? null : parseStoredInvalidation(existing)
        const revision = (previous?.revision ?? 0) + 1
        if (!Number.isSafeInteger(revision))
          throw new Error('Portfolio invalidation revision exhausted')
        const marker = Object.freeze({ chainId, domain, revision, invalidatedAt })
        store.put({
          schemaVersion: 1,
          ...scope,
          ...marker,
          accountKey: accountKey(scope),
          scopeKey: invalidationScopeKey(scope)
        } satisfies StoredPortfolioInvalidation)
        markers.push(marker)
      }
      return Object.freeze(markers)
    })
  }

  async listInvalidated(
    scopeValue: PortfolioInvalidationRecordScope
  ): Promise<readonly PortfolioInvalidationMarker[]> {
    const scope = parseInvalidationScope(scopeValue)
    return runStores(this.databaseName, [INVALIDATIONS], 'readonly', async transaction => {
      const values = await requestResult<unknown[]>(
        transaction
          .objectStore(INVALIDATIONS)
          .index(BY_GENERATION_ACCOUNT)
          .getAll(
            IDBKeyRange.only(invalidationScopeKey(scope)),
            MAXIMUM_INVALIDATIONS_PER_SCOPE + 1
          )
      )
      if (values.length > MAXIMUM_INVALIDATIONS_PER_SCOPE) {
        throw new Error('Portfolio invalidation scope capacity is corrupted')
      }
      return Object.freeze(
        values.map(value => {
          const stored = parseStoredInvalidation(value)
          return Object.freeze({
            chainId: stored.chainId,
            domain: stored.domain,
            revision: stored.revision,
            invalidatedAt: stored.invalidatedAt
          })
        })
      )
    })
  }

  async acknowledgeInvalidated(
    scopeValue: PortfolioInvalidationRecordScope,
    markersValue: readonly PortfolioInvalidationMarker[]
  ): Promise<number> {
    const scope = parseInvalidationScope(scopeValue)
    const markers = markersValue.map(parseInvalidationMarker)
    if (markers.length === 0) return 0
    return runStores(this.databaseName, [INVALIDATIONS], 'readwrite', async transaction => {
      const store = transaction.objectStore(INVALIDATIONS)
      let acknowledged = 0
      for (const marker of markers) {
        const key = invalidationKey(scope, marker)
        const existing = await requestResult<unknown>(store.get(key))
        if (existing === undefined) continue
        if (parseStoredInvalidation(existing).revision !== marker.revision) continue
        store.delete(key)
        acknowledged += 1
      }
      return acknowledged
    })
  }

  async deleteByAccountScope(scopeValue: PortfolioScope): Promise<number> {
    const scope = parseScope(scopeValue)
    return runStores(this.databaseName, [STORE, INVALIDATIONS], 'readwrite', async transaction => {
      const removed = await Promise.all([
        deleteByIndex(transaction.objectStore(STORE), BY_ACCOUNT, accountKey(scope)),
        deleteByIndex(transaction.objectStore(INVALIDATIONS), BY_ACCOUNT, accountKey(scope))
      ])
      return removed[0] + removed[1]
    })
  }

  async deleteGeneration(generationIdValue: StorageV2GenerationId): Promise<number> {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    return runStores(this.databaseName, [STORE, INVALIDATIONS], 'readwrite', async transaction => {
      const removed = await Promise.all([
        deleteByIndex(transaction.objectStore(STORE), BY_GENERATION, generationId),
        deleteByIndex(transaction.objectStore(INVALIDATIONS), BY_GENERATION, generationId)
      ])
      return removed[0] + removed[1]
    })
  }
}

export function deleteIndexedDbPortfolioCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PORTFOLIO_CACHE_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Portfolio cache deletion failed'))
    request.onblocked = () => reject(new Error('Portfolio cache deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
