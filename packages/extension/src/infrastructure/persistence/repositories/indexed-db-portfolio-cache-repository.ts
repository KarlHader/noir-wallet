import { parseAccountId, parseChainAccountId, type ChainAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parsePortfolioSourceState } from '@/core/portfolio'
import type { PortfolioScope } from '@/core/portfolio'
import type {
  PortfolioCacheRecord,
  PortfolioCacheRepository,
  StorageV2GenerationId
} from '@/ports/repositories'
import { parseStorageV2ChainAccount, parseStorageV2GenerationId } from '../schema'

export const PORTFOLIO_CACHE_DATABASE = Object.freeze({
  name: 'noir-wallet-portfolio-v2-db',
  version: 1
})

const STORE = 'sources'
const BY_ACCOUNT = 'byAccount'
const BY_GENERATION = 'byGeneration'
const BY_GENERATION_ACCOUNT = 'byGenerationAccount'
const MAXIMUM_SOURCES_PER_ACCOUNT = 100

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
      if (database.objectStoreNames.contains(STORE)) return
      const store = database.createObjectStore(STORE, {
        keyPath: ['generationId', 'chainAccountId']
      })
      store.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
      store.createIndex(BY_GENERATION, 'generationId', { unique: false })
      store.createIndex(BY_GENERATION_ACCOUNT, 'generationAccountKey', { unique: false })
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

async function runDatabase<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const database = await openDatabase(databaseName)
  const transaction = database.transaction(STORE, mode)
  const completion = transactionDone(transaction)
  try {
    const result = await operation(transaction.objectStore(STORE))
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
        fromStoredRecord(existing)
      }
      store.put(record)
    })
  }

  async deleteByAccountScope(scopeValue: PortfolioScope): Promise<number> {
    const scope = parseScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', store =>
      deleteByIndex(store, BY_ACCOUNT, accountKey(scope))
    )
  }

  async deleteGeneration(generationIdValue: StorageV2GenerationId): Promise<number> {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    return runDatabase(this.databaseName, 'readwrite', store =>
      deleteByIndex(store, BY_GENERATION, generationId)
    )
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
