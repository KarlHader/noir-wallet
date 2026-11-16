import {
  parseAccountId,
  parseAddressId,
  parseChainAccountId,
  type AccountId,
  type AddressId,
  type ChainAccountId
} from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import type {
  StorageV2ActivePointer,
  StorageV2GenerationId,
  StorageV2GenerationManifest,
  StorageV2Repository,
  StorageV2Snapshot
} from '@/ports/repositories'
import {
  parseStorageV2Account,
  parseStorageV2ActivePointer,
  parseStorageV2Address,
  parseStorageV2ChainAccount,
  parseStorageV2GenerationId,
  parseStorageV2GenerationManifest,
  parseStorageV2KeyDomain
} from '../schema'
import {
  openExistingStorageV2Database,
  parseStoredStorageV2Entity,
  runWithStorageV2Database,
  STORAGE_V2_ACTIVE_POINTER_RECORD_KEY,
  STORAGE_V2_ALL_DATABASE_STORES,
  STORAGE_V2_BY_GENERATION_INDEX,
  STORAGE_V2_DATABASE,
  STORAGE_V2_DATABASE_STORES,
  storageV2ManifestRecordKey
} from './indexed-db-storage-v2-database'
import {
  canonicalStorageV2Snapshot,
  readStorageV2SnapshotInTransaction,
  storageV2SnapshotsEqual,
  waitForStorageV2Transaction,
  writeStorageV2Snapshot
} from './indexed-db-storage-v2-snapshot'

export interface IndexedDbStorageV2RepositoryOptions {
  readonly databaseName?: string
}

type EntityParser<T> = (value: unknown) => T

export class IndexedDbStorageV2Repository implements StorageV2Repository {
  private readonly databaseName: string

  constructor(options: IndexedDbStorageV2RepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? STORAGE_V2_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Storage V2 database name')
    }
  }

  async getActivePointer(): Promise<StorageV2ActivePointer | null> {
    return this.readMetadata(STORAGE_V2_ACTIVE_POINTER_RECORD_KEY, parseStorageV2ActivePointer)
  }

  async getManifest(
    generationIdValue: StorageV2GenerationId
  ): Promise<StorageV2GenerationManifest | null> {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    return this.readMetadata(
      storageV2ManifestRecordKey(generationId),
      parseStorageV2GenerationManifest
    )
  }

  async getSnapshot(generationIdValue: StorageV2GenerationId): Promise<StorageV2Snapshot | null> {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    return runWithStorageV2Database(this.databaseName, database => {
      const transaction = database.transaction(STORAGE_V2_ALL_DATABASE_STORES, 'readonly')
      const source = readStorageV2SnapshotInTransaction(transaction, generationId)
      let snapshot: StorageV2Snapshot | null = null
      let error: unknown
      let remaining = source.requests.length
      for (const request of source.requests) {
        request.onsuccess = () => {
          remaining -= 1
          if (remaining !== 0) return
          try {
            snapshot = source.parse()
          } catch (cause) {
            error = cause
            transaction.abort()
          }
        }
      }
      return waitForStorageV2Transaction(
        transaction,
        () => snapshot,
        () => error
      )
    })
  }

  async getKeyDomain(generationId: StorageV2GenerationId, keyDomainId: KeyDomainId) {
    return this.readEntity(
      STORAGE_V2_DATABASE_STORES.keyDomains,
      parseStorageV2GenerationId(generationId),
      parseKeyDomainId(keyDomainId),
      parseStorageV2KeyDomain
    )
  }

  async getAccount(generationId: StorageV2GenerationId, accountId: AccountId) {
    return this.readEntity(
      STORAGE_V2_DATABASE_STORES.accounts,
      parseStorageV2GenerationId(generationId),
      parseAccountId(accountId),
      parseStorageV2Account
    )
  }

  async getChainAccount(generationId: StorageV2GenerationId, chainAccountId: ChainAccountId) {
    return this.readEntity(
      STORAGE_V2_DATABASE_STORES.chainAccounts,
      parseStorageV2GenerationId(generationId),
      parseChainAccountId(chainAccountId),
      parseStorageV2ChainAccount
    )
  }

  async getAddress(generationId: StorageV2GenerationId, addressId: AddressId) {
    return this.readEntity(
      STORAGE_V2_DATABASE_STORES.addresses,
      parseStorageV2GenerationId(generationId),
      parseAddressId(addressId),
      parseStorageV2Address
    )
  }

  async listAccounts(generationId: StorageV2GenerationId, keyDomainId: KeyDomainId) {
    const snapshot = await this.requireSnapshot(generationId)
    const parsedKeyDomainId = parseKeyDomainId(keyDomainId)
    return Object.freeze(
      snapshot.accounts
        .filter(account => account.keyDomainId === parsedKeyDomainId)
        .sort(
          (left, right) => left.accountIndex - right.accountIndex || left.id.localeCompare(right.id)
        )
    )
  }

  async listChainAccounts(
    generationId: StorageV2GenerationId,
    scope: {
      readonly keyDomainId: KeyDomainId
      readonly accountId: AccountId
      readonly chainId?: ChainId
    }
  ) {
    const snapshot = await this.requireSnapshot(generationId)
    const keyDomainId = parseKeyDomainId(scope.keyDomainId)
    const accountId = parseAccountId(scope.accountId)
    const chainId = scope.chainId === undefined ? undefined : parseChainId(scope.chainId).id
    return Object.freeze(
      snapshot.chainAccounts.filter(
        account =>
          account.scope.keyDomainId === keyDomainId &&
          account.scope.accountId === accountId &&
          (chainId === undefined || account.scope.chainId === chainId)
      )
    )
  }

  async listAddresses(generationId: StorageV2GenerationId, chainAccountId: ChainAccountId) {
    const snapshot = await this.requireSnapshot(generationId)
    const parsedChainAccountId = parseChainAccountId(chainAccountId)
    return Object.freeze(
      snapshot.addresses.filter(address => address.chainAccountId === parsedChainAccountId)
    )
  }

  async stage(snapshotValue: StorageV2Snapshot): Promise<void> {
    const snapshot = canonicalStorageV2Snapshot(snapshotValue)
    await runWithStorageV2Database(this.databaseName, database => {
      const transaction = database.transaction(STORAGE_V2_ALL_DATABASE_STORES, 'readwrite')
      const source = readStorageV2SnapshotInTransaction(transaction, snapshot.manifest.generationId)
      let error: unknown
      let remaining = source.requests.length
      for (const request of source.requests) {
        request.onsuccess = () => {
          remaining -= 1
          if (remaining !== 0) return
          try {
            const existing = source.parse()
            if (existing) {
              if (!storageV2SnapshotsEqual(existing, snapshot)) {
                throw new Error('Storage V2 generation id conflict')
              }
              return
            }
            writeStorageV2Snapshot(transaction, snapshot)
          } catch (cause) {
            error = cause
            transaction.abort()
          }
        }
      }
      return waitForStorageV2Transaction(
        transaction,
        () => undefined,
        () => error
      )
    })
  }

  async discardUncommittedGeneration(generationIdValue: StorageV2GenerationId): Promise<void> {
    const generationId = parseStorageV2GenerationId(generationIdValue)
    await runWithStorageV2Database(this.databaseName, database => {
      const transaction = database.transaction(STORAGE_V2_ALL_DATABASE_STORES, 'readwrite')
      const metadata = transaction.objectStore(STORAGE_V2_DATABASE_STORES.metadata)
      const pointerRequest = metadata.get(STORAGE_V2_ACTIVE_POINTER_RECORD_KEY)
      const entityRequests = [
        STORAGE_V2_DATABASE_STORES.keyDomains,
        STORAGE_V2_DATABASE_STORES.accounts,
        STORAGE_V2_DATABASE_STORES.chainAccounts,
        STORAGE_V2_DATABASE_STORES.addresses
      ].map(storeName => ({
        storeName,
        request: transaction
          .objectStore(storeName)
          .index(STORAGE_V2_BY_GENERATION_INDEX)
          .getAllKeys(IDBKeyRange.only(generationId))
      }))
      let error: unknown
      let remaining = entityRequests.length + 1
      const apply = () => {
        remaining -= 1
        if (remaining !== 0) return
        try {
          if (
            pointerRequest.result !== undefined &&
            parseStorageV2ActivePointer(pointerRequest.result).generationId === generationId
          ) {
            throw new Error('Cannot discard the active Storage V2 generation')
          }
          metadata.delete(storageV2ManifestRecordKey(generationId))
          for (const { storeName, request } of entityRequests) {
            const store = transaction.objectStore(storeName)
            request.result.forEach(key => store.delete(key))
          }
        } catch (cause) {
          error = cause
          transaction.abort()
        }
      }
      pointerRequest.onsuccess = apply
      entityRequests.forEach(({ request }) => {
        request.onsuccess = apply
      })
      return waitForStorageV2Transaction(
        transaction,
        () => undefined,
        () => error
      )
    })
  }

  async commit(
    pointerValue: StorageV2ActivePointer,
    expectedActiveGenerationIdValue: StorageV2GenerationId | null
  ): Promise<'committed' | 'active-generation-changed'> {
    const pointer = parseStorageV2ActivePointer(pointerValue)
    const expected =
      expectedActiveGenerationIdValue === null
        ? null
        : parseStorageV2GenerationId(expectedActiveGenerationIdValue)
    return runWithStorageV2Database(this.databaseName, database => {
      const transaction = database.transaction(STORAGE_V2_DATABASE_STORES.metadata, 'readwrite')
      const store = transaction.objectStore(STORAGE_V2_DATABASE_STORES.metadata)
      const activeRequest = store.get(STORAGE_V2_ACTIVE_POINTER_RECORD_KEY)
      const manifestRequest = store.get(storageV2ManifestRecordKey(pointer.generationId))
      let result: 'committed' | 'active-generation-changed' = 'active-generation-changed'
      let error: unknown
      let remaining = 2
      const apply = () => {
        remaining -= 1
        if (remaining !== 0) return
        try {
          const active =
            activeRequest.result === undefined
              ? null
              : parseStorageV2ActivePointer(activeRequest.result)
          if (active?.generationId !== expected && !(active === null && expected === null)) return
          if (manifestRequest.result === undefined) {
            throw new Error('Storage V2 commit generation is missing')
          }
          const manifest = parseStorageV2GenerationManifest(manifestRequest.result)
          if (
            manifest.status !== 'verified' ||
            manifest.sourceFingerprint !== pointer.sourceFingerprint ||
            manifest.verifiedAt === undefined ||
            pointer.committedAt < manifest.verifiedAt
          ) {
            throw new Error('Storage V2 commit pointer does not match a verified generation')
          }
          store.put(pointer, STORAGE_V2_ACTIVE_POINTER_RECORD_KEY)
          result = 'committed'
        } catch (cause) {
          error = cause
          transaction.abort()
        }
      }
      activeRequest.onsuccess = apply
      manifestRequest.onsuccess = apply
      return waitForStorageV2Transaction(
        transaction,
        () => result,
        () => error
      )
    })
  }

  private async requireSnapshot(generationId: StorageV2GenerationId): Promise<StorageV2Snapshot> {
    const snapshot = await this.getSnapshot(parseStorageV2GenerationId(generationId))
    if (!snapshot) throw new Error('Storage V2 generation not found')
    return snapshot
  }

  private async readMetadata<T>(key: IDBValidKey, parse: EntityParser<T>): Promise<T | null> {
    const database = await openExistingStorageV2Database(this.databaseName)
    if (!database) return null
    try {
      return await new Promise<T | null>((resolve, reject) => {
        const transaction = database.transaction(STORAGE_V2_DATABASE_STORES.metadata, 'readonly')
        const request = transaction.objectStore(STORAGE_V2_DATABASE_STORES.metadata).get(key)
        let result: T | null = null
        let error: unknown
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) result = parse(request.result)
          } catch (cause) {
            error = cause
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(error ?? transaction.error ?? new Error('Storage V2 metadata read failed'))
        transaction.onabort = () =>
          reject(error ?? transaction.error ?? new Error('Storage V2 metadata read aborted'))
      })
    } finally {
      database.close()
    }
  }

  private async readEntity<T>(
    storeName: string,
    generationId: StorageV2GenerationId,
    entityId: string,
    parse: EntityParser<T>
  ): Promise<T | null> {
    return runWithStorageV2Database(
      this.databaseName,
      database =>
        new Promise<T | null>((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readonly')
          const request = transaction.objectStore(storeName).get([generationId, entityId])
          let result: T | null = null
          let error: unknown
          request.onsuccess = () => {
            try {
              if (request.result !== undefined) {
                result = parse(parseStoredStorageV2Entity(request.result, generationId))
              }
            } catch (cause) {
              error = cause
              transaction.abort()
            }
          }
          transaction.oncomplete = () => resolve(result)
          transaction.onerror = () =>
            reject(error ?? transaction.error ?? new Error('Storage V2 entity read failed'))
          transaction.onabort = () =>
            reject(error ?? transaction.error ?? new Error('Storage V2 entity read aborted'))
        })
    )
  }
}
