import {
  oneClickTokenKey,
  type OneClickTokenStore
} from '@/core/services/near-intents/one-click-status-client'
import { withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'

const DATABASE = 'noir-one-click-status'
const STORE = 'credentials'
const ENCRYPTION_KEY = 'encryption-key'
const encoder = new TextEncoder()

interface StoredToken {
  readonly walletId: string
  readonly accountId: string
  readonly iv: Uint8Array<ArrayBuffer>
  readonly encrypted: ArrayBuffer
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function operate<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const request = indexedDB.open(DATABASE, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE).createIndex('wallet', 'walletId')
  }
  const database = await requestResult(request)
  try {
    const transaction = database.transaction(STORE, mode)
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('1Click storage aborted'))
    })
    const [result] = await Promise.all([operation(transaction.objectStore(STORE)), completed])
    return result
  } finally {
    database.close()
  }
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  const existing = await operate('readonly', store => requestResult(store.get(ENCRYPTION_KEY)))
  if (existing) return existing
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ])
  return operate('readwrite', async store => {
    const current = await requestResult(store.get(ENCRYPTION_KEY))
    if (current) return current
    await requestResult(store.add(generated, ENCRYPTION_KEY))
    return generated
  })
}

async function decrypt(key: CryptoKey, id: string, record: StoredToken): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(id) },
    key,
    record.encrypted
  )
  return new TextDecoder().decode(plaintext)
}

async function readEntry(id: string): Promise<{
  key: CryptoKey | undefined
  record: StoredToken | undefined
}> {
  return operate('readonly', async store => {
    const [key, record] = await Promise.all([
      requestResult(store.get(ENCRYPTION_KEY)),
      requestResult(store.get(id))
    ])
    return { key, record }
  })
}

export const oneClickStatusTokens: OneClickTokenStore = {
  async read(scope) {
    const id = oneClickTokenKey(scope)
    const { key, record } = await readEntry(id)
    return key && record ? decrypt(key, id, record).catch(() => null) : null
  },

  async write(scope, token) {
    await withUndeletedWalletAccountMetadata(
      scope.walletId,
      scope.accountId,
      scope.network,
      async () => {
        const id = oneClickTokenKey(scope)
        const key = await loadOrCreateKey()
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
          key,
          encoder.encode(token)
        )
        await operate('readwrite', store =>
          requestResult(
            store.put({ walletId: scope.walletId, accountId: scope.accountId, iv, encrypted }, id)
          )
        )
      }
    )
  },

  async invalidate(scope, rejectedToken) {
    const id = oneClickTokenKey(scope)
    const { key, record } = await readEntry(id)
    if (!key || !record || (await decrypt(key, id, record).catch(() => null)) !== rejectedToken)
      return
    await operate('readwrite', async store => {
      const current: StoredToken | undefined = await requestResult(store.get(id))
      if (current && current.iv.every((byte, index) => byte === record.iv[index])) {
        await requestResult(store.delete(id))
      }
    })
  }
}

export async function removeOneClickStatusTokens(
  walletId: string,
  accountId?: string
): Promise<void> {
  await operate(
    'readwrite',
    store =>
      new Promise<void>((resolve, reject) => {
        const request = store.index('wallet').openCursor(IDBKeyRange.only(walletId))
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return resolve()
          if (accountId === undefined || (cursor.value as StoredToken).accountId === accountId) {
            cursor.delete()
          }
          cursor.continue()
        }
      })
  )
}
