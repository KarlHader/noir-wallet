import type { StorageV2GenerationId } from '@/ports/repositories'

export const STORAGE_V2_DATABASE = Object.freeze({
  name: 'noir-wallet-storage-v2-db',
  version: 1
})

export const STORAGE_V2_DATABASE_STORES = Object.freeze({
  metadata: 'metadata',
  keyDomains: 'keyDomains',
  accounts: 'accounts',
  chainAccounts: 'chainAccounts',
  addresses: 'addresses'
})

export const STORAGE_V2_ALL_DATABASE_STORES = Object.freeze(
  Object.values(STORAGE_V2_DATABASE_STORES)
)
export const STORAGE_V2_ACTIVE_POINTER_RECORD_KEY = 'active-pointer'
export const STORAGE_V2_BY_GENERATION_INDEX = 'byGeneration'

function createEntityStore(database: IDBDatabase, name: string): IDBObjectStore {
  const store = database.createObjectStore(name, { keyPath: ['generationId', 'entityId'] })
  store.createIndex(STORAGE_V2_BY_GENERATION_INDEX, 'generationId', { unique: false })
  return store
}

export function openStorageV2Database(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, STORAGE_V2_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Storage V2 database open failed'))
    request.onblocked = () => reject(new Error('Storage V2 database upgrade is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORAGE_V2_DATABASE_STORES.metadata)) {
        database.createObjectStore(STORAGE_V2_DATABASE_STORES.metadata)
      }
      for (const storeName of [
        STORAGE_V2_DATABASE_STORES.keyDomains,
        STORAGE_V2_DATABASE_STORES.accounts,
        STORAGE_V2_DATABASE_STORES.chainAccounts,
        STORAGE_V2_DATABASE_STORES.addresses
      ]) {
        if (!database.objectStoreNames.contains(storeName)) {
          createEntityStore(database, storeName)
        }
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

export function openExistingStorageV2Database(databaseName: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let missing = false
    let blocked = false
    const request = indexedDB.open(databaseName, STORAGE_V2_DATABASE.version)
    // Metadata reads must not recreate a database removed by Reset Wallet.
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0 || !request.transaction) {
        blocked = true
        reject(new Error('Unexpected Storage V2 database upgrade'))
        request.transaction?.abort()
        return
      }
      missing = true
      request.transaction.abort()
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked || missing) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      if (missing && request.error?.name === 'AbortError') {
        resolve(null)
        return
      }
      reject(request.error ?? new Error('Storage V2 database open failed'))
    }
    request.onblocked = () => {
      blocked = true
      reject(new Error('Storage V2 database open is blocked'))
    }
  })
}

export async function runWithStorageV2Database<T>(
  databaseName: string,
  operation: (database: IDBDatabase) => Promise<T>
): Promise<T> {
  const database = await openStorageV2Database(databaseName)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

export function storageV2ManifestRecordKey(generationId: StorageV2GenerationId): string {
  return `manifest:${generationId}`
}

export interface StoredStorageV2Entity {
  readonly generationId: StorageV2GenerationId
  readonly entityId: string
  readonly entity: unknown
}

export function storedStorageV2Entity(
  generationId: StorageV2GenerationId,
  entity: { readonly id: string }
): StoredStorageV2Entity {
  return Object.freeze({ generationId, entityId: entity.id, entity })
}

export function parseStoredStorageV2Entity(
  value: unknown,
  expectedGenerationId: StorageV2GenerationId
): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(value, 'generationId') ||
    !Object.prototype.hasOwnProperty.call(value, 'entityId') ||
    !Object.prototype.hasOwnProperty.call(value, 'entity') ||
    (value as { generationId?: unknown }).generationId !== expectedGenerationId ||
    typeof (value as { entityId?: unknown }).entityId !== 'string'
  ) {
    throw new Error('Invalid persisted Storage V2 entity')
  }
  const record = value as { entityId: string; entity: unknown }
  if (
    typeof record.entity !== 'object' ||
    record.entity === null ||
    Array.isArray(record.entity) ||
    (record.entity as { id?: unknown }).id !== record.entityId
  ) {
    throw new Error('Persisted Storage V2 entity id mismatch')
  }
  return record.entity
}
