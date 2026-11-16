import type { Account, Address, ChainAccount } from '@/core/accounts/domain'
import type { KeyDomain } from '@/core/keyring/domain'
import type { StorageV2GenerationId, StorageV2Snapshot } from '@/ports/repositories'
import {
  parseStorageV2Account,
  parseStorageV2Address,
  parseStorageV2ChainAccount,
  parseStorageV2GenerationManifest,
  parseStorageV2KeyDomain,
  parseStorageV2Snapshot
} from '../schema'
import {
  parseStoredStorageV2Entity,
  STORAGE_V2_BY_GENERATION_INDEX,
  STORAGE_V2_DATABASE_STORES,
  storageV2ManifestRecordKey,
  storedStorageV2Entity
} from './indexed-db-storage-v2-database'

type EntityParser<T> = (value: unknown) => T

export function canonicalStorageV2Snapshot(value: StorageV2Snapshot): StorageV2Snapshot {
  const snapshot = parseStorageV2Snapshot(value)
  const byId = <T extends { readonly id: string }>(left: T, right: T) =>
    left.id.localeCompare(right.id)
  return parseStorageV2Snapshot({
    manifest: snapshot.manifest,
    keyDomains: [...snapshot.keyDomains].sort(byId),
    accounts: [...snapshot.accounts].sort(byId),
    chainAccounts: [...snapshot.chainAccounts].sort(byId),
    addresses: [...snapshot.addresses].sort(byId)
  })
}

export function storageV2SnapshotsEqual(
  left: StorageV2Snapshot,
  right: StorageV2Snapshot
): boolean {
  return (
    JSON.stringify(canonicalStorageV2Snapshot(left)) ===
    JSON.stringify(canonicalStorageV2Snapshot(right))
  )
}

function getAllByGeneration(
  transaction: IDBTransaction,
  storeName: string,
  generationId: StorageV2GenerationId
): IDBRequest<unknown[]> {
  return transaction
    .objectStore(storeName)
    .index(STORAGE_V2_BY_GENERATION_INDEX)
    .getAll(IDBKeyRange.only(generationId))
}

function parseStoredEntities<T>(
  values: readonly unknown[],
  generationId: StorageV2GenerationId,
  parse: EntityParser<T>
): readonly T[] {
  return Object.freeze(values.map(value => parse(parseStoredStorageV2Entity(value, generationId))))
}

export function readStorageV2SnapshotInTransaction(
  transaction: IDBTransaction,
  generationId: StorageV2GenerationId
) {
  const manifestRequest = transaction
    .objectStore(STORAGE_V2_DATABASE_STORES.metadata)
    .get(storageV2ManifestRecordKey(generationId))
  const keyDomainRequest = getAllByGeneration(
    transaction,
    STORAGE_V2_DATABASE_STORES.keyDomains,
    generationId
  )
  const accountRequest = getAllByGeneration(
    transaction,
    STORAGE_V2_DATABASE_STORES.accounts,
    generationId
  )
  const chainAccountRequest = getAllByGeneration(
    transaction,
    STORAGE_V2_DATABASE_STORES.chainAccounts,
    generationId
  )
  const addressRequest = getAllByGeneration(
    transaction,
    STORAGE_V2_DATABASE_STORES.addresses,
    generationId
  )
  const requests = [
    manifestRequest,
    keyDomainRequest,
    accountRequest,
    chainAccountRequest,
    addressRequest
  ] as const
  return {
    requests,
    parse(): StorageV2Snapshot | null {
      if (manifestRequest.result === undefined) {
        const hasOrphan = requests.slice(1).some(request => request.result.length > 0)
        if (hasOrphan) throw new Error('Storage V2 generation has orphaned entities')
        return null
      }
      return canonicalStorageV2Snapshot({
        manifest: parseStorageV2GenerationManifest(manifestRequest.result),
        keyDomains: parseStoredEntities(
          keyDomainRequest.result,
          generationId,
          parseStorageV2KeyDomain
        ),
        accounts: parseStoredEntities(accountRequest.result, generationId, parseStorageV2Account),
        chainAccounts: parseStoredEntities(
          chainAccountRequest.result,
          generationId,
          parseStorageV2ChainAccount
        ),
        addresses: parseStoredEntities(addressRequest.result, generationId, parseStorageV2Address)
      })
    }
  }
}

export function waitForStorageV2Transaction<T>(
  transaction: IDBTransaction,
  result: () => T,
  failure: () => unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result())
    transaction.onerror = () =>
      reject(failure() ?? transaction.error ?? new Error('Storage V2 transaction failed'))
    transaction.onabort = () =>
      reject(failure() ?? transaction.error ?? new Error('Storage V2 transaction aborted'))
  })
}

export function writeStorageV2Snapshot(
  transaction: IDBTransaction,
  snapshot: StorageV2Snapshot
): void {
  transaction
    .objectStore(STORAGE_V2_DATABASE_STORES.metadata)
    .put(snapshot.manifest, storageV2ManifestRecordKey(snapshot.manifest.generationId))
  const collections: ReadonlyArray<
    readonly [string, readonly (KeyDomain | Account | ChainAccount | Address)[]]
  > = [
    [STORAGE_V2_DATABASE_STORES.keyDomains, snapshot.keyDomains],
    [STORAGE_V2_DATABASE_STORES.accounts, snapshot.accounts],
    [STORAGE_V2_DATABASE_STORES.chainAccounts, snapshot.chainAccounts],
    [STORAGE_V2_DATABASE_STORES.addresses, snapshot.addresses]
  ]
  for (const [storeName, entities] of collections) {
    const store = transaction.objectStore(storeName)
    entities.forEach(entity =>
      store.put(storedStorageV2Entity(snapshot.manifest.generationId, entity))
    )
  }
}
