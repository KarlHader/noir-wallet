import type { DeviceIdentity, IdentityStore } from '@/core/multisig/identity'
import { IDENTITY_PUBLIC_KEY_BYTES } from '@/core/multisig/identity'

export const MULTISIG_IDENTITY_DB_NAME = 'noir-multisig-identity'
const STORE_NAME = 'identity'
const RECORD_KEY = 'device'
const RECORD_VERSION = 1

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(MULTISIG_IDENTITY_DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
  return requestResult(request)
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Partial<CryptoKeyPair>
  return pair.privateKey instanceof CryptoKey && pair.publicKey instanceof CryptoKey
}

function parseRecord(value: unknown): DeviceIdentity | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.version !== RECORD_VERSION) return null
  const { publicKey, signingKeys, agreementKeys } = record
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== IDENTITY_PUBLIC_KEY_BYTES) {
    return null
  }
  if (!isKeyPair(signingKeys) || !isKeyPair(agreementKeys)) return null
  return { publicKey, signingKeys, agreementKeys }
}

// CryptoKey objects are structured-cloneable, which is what lets non-extractable keys persist.
export function createIndexedDbIdentityStore(): IdentityStore {
  async function run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ) {
    const db = await openDatabase()
    try {
      return await requestResult(action(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)))
    } finally {
      db.close()
    }
  }

  return {
    async load() {
      return parseRecord(await run('readonly', store => store.get(RECORD_KEY)))
    },
    async save(identity) {
      await run('readwrite', store =>
        store.put(
          {
            version: RECORD_VERSION,
            publicKey: identity.publicKey,
            signingKeys: identity.signingKeys,
            agreementKeys: identity.agreementKeys,
            createdAt: Date.now()
          },
          RECORD_KEY
        )
      )
    },
    async clear() {
      await run('readwrite', store => store.delete(RECORD_KEY))
    }
  }
}

export async function deleteMultisigIdentity(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MULTISIG_IDENTITY_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    // onblocked is ignored: the delete stays queued and onsuccess fires once other connections close.
  })
}
