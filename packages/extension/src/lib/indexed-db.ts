/**
 * IndexedDB Storage for Noir Wallet Database
 *
 * Provides persistent storage for WASM wallet database with large storage capacity.
 * Uses singleton pattern to maintain a single database connection.
 * Includes version management for WASM data compatibility.
 */

import type { Transaction } from '@/types'
import type { VerboseTransaction } from './zcash-node-rpc.ts'
import { isWalletSnapshotIntegrityError } from './wallet-snapshot-errors'
import type { JournalReplayEntry } from './sync-journal'

const DB_NAME = 'zcash-wallet-db'
// Schema versions must remain monotonic across builds that share an extension ID.
const DB_VERSION = 8
const STORE_NAME = 'walletData'
const TRANSACTIONS_STORE_NAME = 'transactions'
const TRANSPARENT_TRANSACTION_CACHE_STORE_NAME = 'transparentTransactionCache'
const LEGACY_TRANSPARENT_TX_CACHE_STORE_NAME = 'transparentTxCache'
const VOTING_DATA_STORE_NAME = 'votingData'
const WRITE_BLOCK_STORE_NAME = 'walletWriteBlocks'

function normalizeTransactions(value: unknown): Transaction[] {
  if (Array.isArray(value)) return value
  if (
    value &&
    typeof value === 'object' &&
    'transactions' in value &&
    Array.isArray((value as { transactions?: unknown }).transactions)
  ) {
    return (value as { transactions: Transaction[] }).transactions
  }
  return []
}

function normalizeTransparentTxCache(value: unknown): Record<string, VerboseTransaction> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, VerboseTransaction] =>
        /^[0-9a-fA-F]{64}$/.test(entry[0]) &&
        !!entry[1] &&
        typeof entry[1] === 'object' &&
        'txid' in entry[1] &&
        typeof entry[1].txid === 'string' &&
        entry[1].txid.toLowerCase() === entry[0].toLowerCase()
    )
  )
}
const JOURNAL_STORE_NAME = 'syncJournal'
const JOURNAL_MANIFEST_STORE_NAME = 'syncJournalManifest'

// WASM data version for compatibility checking
const WASM_DATA_VERSION = 1

interface WalletDbMetadata {
  version: number
  timestamp: number
  network: string
  walletId: string
}

interface WalletDbEntry {
  metadata: WalletDbMetadata
  data: Uint8Array
}

/**
 * Chunked manifest stored at the primary key. The DB bytes live in sibling
 * entries keyed `${key}::c::${i}`. Chunking is required because IndexedDB
 * enforces a hard per-value size limit (~127 MiB); a multi-year wallet DB
 * exceeds it and a single put() aborts the transaction.
 */
interface WalletDbChunkManifest {
  metadata: WalletDbMetadata
  chunked: true
  chunkCount: number
  chunkSizes: number[]
  totalBytes: number
}

// Keep each stored value comfortably under the IndexedDB per-value limit.
const DB_CHUNK_SIZE = 64 * 1024 * 1024

function walletDbChunkKey(key: string, index: number): string {
  return `${key}::c::${index}`
}

function walletDbChunkRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound(`${key}::c::`, `${key}::c::\uffff`)
}

function queueWalletWrite(
  tx: IDBTransaction,
  key: string,
  write: () => void
): { error: Error | null } {
  const guard = { error: null as Error | null }
  const [network, walletId, accountId] = key.split('_')
  const blockStore = tx.objectStore(WRITE_BLOCK_STORE_NAME)
  const abortIfBlocked = (blocked: unknown): boolean => {
    if (!blocked) return false
    guard.error = new Error('Wallet data is being removed')
    tx.abort()
    return true
  }
  const commit = () => {
    try {
      write()
    } catch (error) {
      guard.error = error instanceof Error ? error : new Error('Wallet data write failed')
      tx.abort()
    }
  }
  const walletBlock = blockStore.get(`${network}_${walletId}`)
  walletBlock.onsuccess = () => {
    if (abortIfBlocked(walletBlock.result)) return
    if (!accountId) {
      commit()
      return
    }
    const accountBlock = blockStore.get(key)
    accountBlock.onsuccess = () => {
      if (!abortIfBlocked(accountBlock.result)) commit()
    }
  }
  return guard
}

async function setWriteBlock(key: string, blocked: boolean): Promise<void> {
  const db = await getConnection()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(WRITE_BLOCK_STORE_NAME, 'readwrite')
    const store = tx.objectStore(WRITE_BLOCK_STORE_NAME)
    if (blocked) store.put(true, key)
    else store.delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Wallet write block failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Wallet write block aborted'))
  })
}

export function blockWalletRecords(network: string, walletId: string): Promise<void> {
  return setWriteBlock(`${network}_${walletId}`, true)
}

export function unblockWalletRecords(network: string, walletId: string): Promise<void> {
  return setWriteBlock(`${network}_${walletId}`, false)
}

export function blockAccountRecords(
  network: string,
  walletId: string,
  accountId: string
): Promise<void> {
  return setWriteBlock(`${network}_${walletId}_${accountId}`, true)
}

export function unblockAccountRecords(
  network: string,
  walletId: string,
  accountId: string
): Promise<void> {
  return setWriteBlock(`${network}_${walletId}_${accountId}`, false)
}

export async function nextUnusedDerivationIndex(
  network: string,
  walletId: string,
  highestLiveIndex: number
): Promise<number> {
  const db = await getConnection()
  const prefix = `${network}_${walletId}_`
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WRITE_BLOCK_STORE_NAME, 'readonly')
    const request = tx
      .objectStore(WRITE_BLOCK_STORE_NAME)
      .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    let highest = highestLiveIndex
    request.onsuccess = () => {
      for (const key of request.result) {
        if (typeof key !== 'string') continue
        const suffix = key.slice(prefix.length)
        if (!/^\d+$/.test(suffix)) continue
        const index = Number(suffix)
        if (Number.isSafeInteger(index)) highest = Math.max(highest, index)
      }
    }
    tx.oncomplete = () => resolve(highest + 1)
    tx.onerror = () => reject(tx.error ?? new Error('Unable to check removed account indices'))
    tx.onabort = () => reject(tx.error ?? new Error('Account index lookup aborted'))
  })
}

/**
 * Split source buffers into standalone chunks no larger than DB_CHUNK_SIZE.
 * Buffers already within the limit are stored as-is (no copy) so the streamed
 * worker chunks avoid a redundant 100MB+ reallocation.
 */
function toStorageChunks(sources: Uint8Array[]): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (const src of sources) {
    if (!(src instanceof Uint8Array) || src.byteLength === 0) {
      throw new Error('Failed to serialize wallet database snapshot: invalid or empty chunk')
    }
    if (src.byteLength <= DB_CHUNK_SIZE) {
      chunks.push(src)
      continue
    }
    for (let offset = 0; offset < src.byteLength; offset += DB_CHUNK_SIZE) {
      chunks.push(src.slice(offset, Math.min(offset + DB_CHUNK_SIZE, src.byteLength)))
    }
  }
  return chunks
}

// Singleton connection
let dbConnection: IDBDatabase | null = null
let dbConnectionPromise: Promise<IDBDatabase> | null = null

/**
 * Get or create IndexedDB connection (singleton pattern)
 */
async function getConnection(): Promise<IDBDatabase> {
  if (dbConnection) {
    return dbConnection
  }

  if (dbConnectionPromise) {
    return dbConnectionPromise
  }

  dbConnectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      dbConnectionPromise = null
      reject(request.error)
    }

    request.onsuccess = () => {
      const db = request.result
      dbConnection = db
      dbConnectionPromise = null

      db.onclose = () => {
        if (dbConnection === db) dbConnection = null
      }
      db.onversionchange = () => {
        db.close()
        if (dbConnection === db) dbConnection = null
      }

      resolve(db)
    }

    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
      if (!db.objectStoreNames.contains(TRANSACTIONS_STORE_NAME)) {
        db.createObjectStore(TRANSACTIONS_STORE_NAME)
      }
      if (db.objectStoreNames.contains(LEGACY_TRANSPARENT_TX_CACHE_STORE_NAME)) {
        db.deleteObjectStore(LEGACY_TRANSPARENT_TX_CACHE_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME)) {
        db.createObjectStore(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(JOURNAL_STORE_NAME)) {
        const journalStore = db.createObjectStore(JOURNAL_STORE_NAME, {
          keyPath: ['walletKey', 'seq']
        })
        journalStore.createIndex('byWallet', 'walletKey', { unique: false })
      }
      if (!db.objectStoreNames.contains(JOURNAL_MANIFEST_STORE_NAME)) {
        db.createObjectStore(JOURNAL_MANIFEST_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(VOTING_DATA_STORE_NAME)) {
        db.createObjectStore(VOTING_DATA_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(WRITE_BLOCK_STORE_NAME)) {
        db.createObjectStore(WRITE_BLOCK_STORE_NAME)
      }
    }
  })

  return dbConnectionPromise
}

/**
 * Save wallet database bytes to IndexedDB with version metadata.
 *
 * Bytes are stored as multiple chunk entries plus a manifest so arbitrarily
 * large wallet DBs stay under the IndexedDB per-value limit. Accepts either a
 * single buffer or the pre-chunked stream produced by the worker.
 *
 * @param key - Storage key (e.g., "testnet_walletId123")
 * @param data - Wallet database bytes, or an array of streamed chunks
 */
export async function saveWalletDb(key: string, data: Uint8Array | Uint8Array[]): Promise<void> {
  // Extract network and walletId from key (format: "network_walletId")
  const [network, walletId] = key.split('_')

  const chunks = toStorageChunks(Array.isArray(data) ? data : [data])
  if (chunks.length === 0) {
    throw new Error('Failed to serialize wallet database snapshot: empty snapshot')
  }
  const chunkSizes = chunks.map(c => c.byteLength)
  const totalBytes = chunkSizes.reduce((sum, n) => sum + n, 0)

  const manifest: WalletDbChunkManifest = {
    metadata: {
      version: WASM_DATA_VERSION,
      timestamp: Date.now(),
      network: network || 'unknown',
      walletId: walletId || 'unknown'
    },
    chunked: true,
    chunkCount: chunks.length,
    chunkSizes,
    totalBytes
  }

  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, WRITE_BLOCK_STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const guard = queueWalletWrite(transaction, key, () => {
      store.delete(walletDbChunkRange(key))
      chunks.forEach((chunk, i) => store.put(chunk, walletDbChunkKey(key, i)))
      store.put(manifest, key)
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    transaction.oncomplete = () =>
      finish(() => {
        console.log(
          `[IndexedDB] Saved ${totalBytes} bytes in ${chunks.length} chunk(s) for key: ${key} (version: ${WASM_DATA_VERSION})`
        )
        resolve()
      })
    transaction.onabort = () =>
      finish(() => {
        const err = guard.error ?? transaction.error ?? new Error('IndexedDB transaction aborted')
        console.warn(`[IndexedDB] save aborted for ${key}: ${err.name}: ${err.message}`)
        reject(err)
      })
    transaction.onerror = () =>
      finish(() => {
        const err = transaction.error || new Error('IndexedDB transaction error')
        console.warn(`[IndexedDB] save error for ${key}: ${err.name}: ${err.message}`)
        reject(err)
      })
  })
}

/**
 * Reassemble chunked wallet DB bytes into a single contiguous buffer.
 */
function loadChunkedWalletDb(
  store: IDBObjectStore,
  key: string,
  manifest: WalletDbChunkManifest,
  fail: (error: unknown) => void
): Uint8Array {
  const { chunkCount, chunkSizes, totalBytes } = manifest
  if (
    !Number.isSafeInteger(chunkCount) ||
    chunkCount <= 0 ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Array.isArray(chunkSizes) ||
    chunkSizes.length !== chunkCount ||
    chunkSizes.some(size => !Number.isSafeInteger(size) || size <= 0) ||
    chunkSizes.reduce((sum, size) => sum + size, 0) !== totalBytes
  ) {
    throw new Error('Invalid wallet database snapshot: inconsistent chunk manifest')
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (let i = 0; i < chunkCount; i++) {
    const chunkOffset = offset
    offset += chunkSizes[i]
    const request = store.get(walletDbChunkKey(key, i))
    request.onsuccess = () => {
      try {
        const value: unknown = request.result
        if (value === undefined) {
          throw new Error(`Missing chunk ${i}/${chunkCount} for key: ${key}`)
        }
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
          throw new Error(`Invalid wallet database snapshot: invalid chunk ${i}/${chunkCount}`)
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
        if (chunk.byteLength !== chunkSizes[i]) {
          throw new Error(
            `Invalid wallet database snapshot: chunk ${i}/${chunkCount} size mismatch`
          )
        }
        merged.set(chunk, chunkOffset)
      } catch (error) {
        fail(error)
      }
    }
    request.onerror = () => {
      fail(request.error || new Error('IndexedDB chunk read failed'))
    }
  }
  return merged
}

/**
 * Load wallet database bytes from IndexedDB with version check
 * @param key - Storage key (e.g., "testnet_walletId123")
 */
export async function loadWalletDb(key: string): Promise<Uint8Array | null> {
  try {
    return await readWalletDb(key)
  } catch (error) {
    if (!isWalletSnapshotIntegrityError(error)) throw error
    // A queued save may already have replaced the snapshot that failed validation.
    // Confirm against a fresh transaction before recommending a full rescan.
    return readWalletDb(key)
  }
}

async function readWalletDb(key: string): Promise<Uint8Array | null> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(key)
    let loaded: Uint8Array | null = null
    const fail = (error: unknown) => {
      try {
        transaction.abort()
      } catch {
        // The transaction may have already settled after a storage failure.
      }
      reject(error)
    }

    transaction.oncomplete = () => resolve(loaded)
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB load failed'))
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB load transaction aborted'))

    request.onsuccess = () => {
      try {
        const entry: unknown = request.result
        if (entry === undefined) return

        // Handle legacy data (direct Uint8Array without metadata)
        if (entry instanceof Uint8Array || entry instanceof ArrayBuffer) {
          console.warn(
            `[IndexedDB] Legacy data format detected for ${key}. Ignoring incompatible data.`
          )
          return
        }

        if (!entry || typeof entry !== 'object') {
          throw new Error('Invalid wallet database snapshot: invalid snapshot bytes')
        }

        // Check version compatibility
        const walletEntry = entry as WalletDbEntry | WalletDbChunkManifest
        if (!walletEntry.metadata || walletEntry.metadata.version !== WASM_DATA_VERSION) {
          const storedVersion = walletEntry.metadata?.version ?? 0
          console.warn(
            `[IndexedDB] Version mismatch for ${key}: stored=${storedVersion}, expected=${WASM_DATA_VERSION}. Ignoring incompatible data.`
          )
          return
        }

        if ('chunked' in walletEntry && walletEntry.chunked) {
          // Reuse the manifest transaction so concurrent saves cannot replace its chunks.
          loaded = loadChunkedWalletDb(store, key, walletEntry, fail)
          return
        }

        // Legacy single-value format (pre-chunking, still version-compatible)
        const singleEntry = walletEntry as WalletDbEntry
        const bytes: unknown = singleEntry.data
        if (
          (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) ||
          bytes.byteLength === 0
        ) {
          throw new Error('Invalid wallet database snapshot: invalid snapshot bytes')
        }
        loaded = new Uint8Array(bytes)
      } catch (error) {
        fail(error)
      }
    }
    request.onerror = () => fail(request.error || new Error('IndexedDB manifest read failed'))
  })
}

/**
 * Check whether a persisted wallet DB exists without loading full bytes.
 */
export async function hasWalletDb(key: string): Promise<boolean> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    let exists = false
    transaction.oncomplete = () => resolve(exists)
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB lookup failed'))
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB lookup transaction aborted'))
    request.onerror = () => reject(request.error || new Error('IndexedDB lookup failed'))

    request.onsuccess = () => {
      const entry: unknown = request.result
      if (entry instanceof Uint8Array || entry instanceof ArrayBuffer) {
        exists = entry.byteLength > 0
      } else if (entry && typeof entry === 'object') {
        const walletEntry = entry as Partial<WalletDbEntry & WalletDbChunkManifest>
        const bytes: unknown = walletEntry.data
        const versionOk = walletEntry.metadata?.version === WASM_DATA_VERSION
        exists =
          versionOk &&
          (walletEntry.chunked
            ? Number.isSafeInteger(walletEntry.totalBytes) && (walletEntry.totalBytes ?? 0) > 0
            : (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) && bytes.byteLength > 0)
      }
    }
  })
}

/**
 * Delete wallet database from IndexedDB
 * @param key - Storage key (e.g., "testnet_walletId123")
 */
export async function deleteWalletDb(key: string): Promise<void> {
  const db = await getConnection()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.delete(key)
    store.delete(walletDbChunkRange(key))

    transaction.oncomplete = () => {
      console.log(`[IndexedDB] Deleted wallet db for key: ${key}`)
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB delete transaction aborted'))
  })
}

/** Remove every persisted record belonging to one wallet in a single transaction. */
export async function deleteWalletRecords(network: string, walletId: string): Promise<void> {
  const db = await getConnection()
  const walletKey = `${network}_${walletId}`
  const accountRange = IDBKeyRange.bound(`${walletKey}_`, `${walletKey}_\uffff`)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [
        STORE_NAME,
        TRANSACTIONS_STORE_NAME,
        TRANSPARENT_TRANSACTION_CACHE_STORE_NAME,
        JOURNAL_STORE_NAME,
        JOURNAL_MANIFEST_STORE_NAME,
        VOTING_DATA_STORE_NAME,
        WRITE_BLOCK_STORE_NAME
      ],
      'readwrite'
    )
    tx.objectStore(WRITE_BLOCK_STORE_NAME).put(true, walletKey)
    tx.objectStore(STORE_NAME).delete(walletKey)
    tx.objectStore(STORE_NAME).delete(walletDbChunkRange(walletKey))
    tx.objectStore(TRANSACTIONS_STORE_NAME).delete(accountRange)
    tx.objectStore(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME).delete(accountRange)
    tx.objectStore(VOTING_DATA_STORE_NAME).delete(accountRange)
    tx.objectStore(JOURNAL_MANIFEST_STORE_NAME).delete(walletKey)
    const journal = tx.objectStore(JOURNAL_STORE_NAME)
    const cursor = journal.index('byWallet').openCursor(IDBKeyRange.only(walletKey))
    cursor.onsuccess = () => {
      if (!cursor.result) return
      cursor.result.delete()
      cursor.result.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Wallet data deletion failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Wallet data deletion aborted'))
  })
}

/** Discard a shared WASM snapshot while retaining account transaction history. */
export async function deleteWalletSnapshot(network: string, walletId: string): Promise<void> {
  const db = await getConnection()
  const walletKey = `${network}_${walletId}`
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_NAME, JOURNAL_STORE_NAME, JOURNAL_MANIFEST_STORE_NAME],
      'readwrite'
    )
    tx.objectStore(STORE_NAME).delete(walletKey)
    tx.objectStore(STORE_NAME).delete(walletDbChunkRange(walletKey))
    tx.objectStore(JOURNAL_MANIFEST_STORE_NAME).delete(walletKey)
    const cursor = tx
      .objectStore(JOURNAL_STORE_NAME)
      .index('byWallet')
      .openCursor(IDBKeyRange.only(walletKey))
    cursor.onsuccess = () => {
      if (!cursor.result) return
      cursor.result.delete()
      cursor.result.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Wallet snapshot deletion failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Wallet snapshot deletion aborted'))
  })
}

/** Reset all wallet-owned IndexedDB records after active writers have stopped. */
export async function clearAllWalletRecords(): Promise<void> {
  const db = await getConnection()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [
        STORE_NAME,
        TRANSACTIONS_STORE_NAME,
        TRANSPARENT_TRANSACTION_CACHE_STORE_NAME,
        JOURNAL_STORE_NAME,
        JOURNAL_MANIFEST_STORE_NAME,
        VOTING_DATA_STORE_NAME
      ],
      'readwrite'
    )
    for (const name of [
      STORE_NAME,
      TRANSACTIONS_STORE_NAME,
      TRANSPARENT_TRANSACTION_CACHE_STORE_NAME,
      JOURNAL_STORE_NAME,
      JOURNAL_MANIFEST_STORE_NAME,
      VOTING_DATA_STORE_NAME
    ]) {
      tx.objectStore(name).clear()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Wallet data reset failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Wallet data reset aborted'))
  })
}

/**
 * Close the database connection
 */
export function closeConnection(): void {
  if (dbConnection) {
    dbConnection.close()
    dbConnection = null
  }
}

export interface VotingStateEntry {
  revision: string
  bytes: Uint8Array
  updatedAt: number
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

export function validateVotingCheckpoint(
  current: VotingStateEntry | undefined,
  bytes: Uint8Array,
  revision: bigint
): 'write' | 'unchanged' {
  if (!current) return 'write'

  const currentRevision = BigInt(current.revision)
  if (revision < currentRevision) {
    throw new Error(
      `Refusing stale voting checkpoint revision ${revision}; current revision is ${currentRevision}`
    )
  }
  if (revision === currentRevision) {
    if (!equalBytes(current.bytes, bytes)) {
      throw new Error(`Conflicting voting checkpoint at revision ${revision}`)
    }
    return 'unchanged'
  }
  return 'write'
}

export async function loadVotingState(key: string): Promise<VotingStateEntry | null> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(VOTING_DATA_STORE_NAME, 'readonly')
    const request = transaction.objectStore(VOTING_DATA_STORE_NAME).get(key)
    request.onsuccess = () => {
      const entry = request.result as VotingStateEntry | undefined
      resolve(entry ? { ...entry, bytes: new Uint8Array(entry.bytes) } : null)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function saveVotingState(
  key: string,
  bytes: Uint8Array,
  revision: bigint
): Promise<void> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [VOTING_DATA_STORE_NAME, WRITE_BLOCK_STORE_NAME],
      'readwrite'
    )
    const store = transaction.objectStore(VOTING_DATA_STORE_NAME)
    let request: IDBRequest<VotingStateEntry | undefined>
    let updateError: Error | null = null
    const guard = queueWalletWrite(transaction, key, () => {
      request = store.get(key)
      request.onsuccess = () => {
        const current = request.result as VotingStateEntry | undefined
        let action: 'write' | 'unchanged'
        try {
          action = validateVotingCheckpoint(current, bytes, revision)
        } catch (error) {
          updateError = error instanceof Error ? error : new Error('Invalid voting checkpoint')
          transaction.abort()
          return
        }
        if (action === 'unchanged') return

        store.put(
          { revision: revision.toString(), bytes: new Uint8Array(bytes), updatedAt: Date.now() },
          key
        )
      }
    })

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(
        updateError ??
          guard.error ??
          transaction.error ??
          new Error('Voting checkpoint transaction aborted')
      )
  })
}

export async function deleteVotingState(key: string): Promise<void> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(VOTING_DATA_STORE_NAME, 'readwrite')
    transaction.objectStore(VOTING_DATA_STORE_NAME).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Voting state delete transaction aborted'))
  })
}

/**
 * Load transactions from IndexedDB
 * @param key - Storage key (e.g., "mainnet_walletId123_accountId456")
 */
export async function loadTransactions(key: string): Promise<Transaction[]> {
  try {
    const db = await getConnection()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSACTIONS_STORE_NAME, 'readonly')
      const store = transaction.objectStore(TRANSACTIONS_STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        const transactions = normalizeTransactions(request.result)
        console.log(`[IndexedDB] Loaded ${transactions.length} transactions for key: ${key}`)
        resolve(transactions)
      }
      request.onerror = () => reject(request.error)
    })
  } catch (e) {
    console.warn('[IndexedDB] Failed to load transactions:', e)
    return []
  }
}

/**
 * Atomically reads and replaces an account's transaction list.
 *
 * Keeping the read and write in one IndexedDB transaction prevents concurrent
 * background monitors, wallet-history refreshes, and popup updates from
 * overwriting each other's changes with stale snapshots.
 */
export async function mutateTransactions(
  key: string,
  updater: (transactions: Transaction[]) => Transaction[]
): Promise<Transaction[]> {
  const db = await getConnection()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [TRANSACTIONS_STORE_NAME, WRITE_BLOCK_STORE_NAME],
      'readwrite'
    )
    const store = transaction.objectStore(TRANSACTIONS_STORE_NAME)
    let request: IDBRequest<Transaction[]>
    let updatedTransactions: Transaction[] = []
    let updateError: unknown

    const guard = queueWalletWrite(transaction, key, () => {
      request = store.get(key)
      request.onsuccess = () => {
        try {
          updatedTransactions = updater(normalizeTransactions(request.result))
          store.put(updatedTransactions, key)
        } catch (error) {
          updateError = error
          transaction.abort()
        }
      }
    })

    transaction.oncomplete = () => {
      console.log(`[IndexedDB] Updated ${updatedTransactions.length} transactions for key: ${key}`)
      resolve(updatedTransactions)
    }
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(
        updateError ?? guard.error ?? transaction.error ?? new Error('Transaction update aborted')
      )
  })
}

/**
 * Delete transactions from IndexedDB
 * @param key - Storage key (e.g., "mainnet_walletId123_accountId456")
 */
export async function deleteTransactions(key: string): Promise<void> {
  const db = await getConnection()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSACTIONS_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(TRANSACTIONS_STORE_NAME)
    store.delete(key)

    transaction.oncomplete = () => {
      console.log(`[IndexedDB] Deleted transactions for key: ${key}`)
      resolve()
    }
    transaction.onerror = () => reject(transaction.error ?? new Error('Transaction delete failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction delete aborted'))
  })
}

/**
 * Merge transaction bodies used to reconstruct transparent history and recipients.
 */
export async function saveTransparentTxCache(
  key: string,
  transactions: ReadonlyMap<string, VerboseTransaction>
): Promise<void> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [TRANSPARENT_TRANSACTION_CACHE_STORE_NAME, WRITE_BLOCK_STORE_NAME],
      'readwrite'
    )
    const store = transaction.objectStore(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME)
    let request: IDBRequest<unknown>
    const guard = queueWalletWrite(transaction, key, () => {
      request = store.get(key)
      request.onsuccess = () => {
        // Receive and recipient recovery can finish concurrently for the same account.
        const cached = normalizeTransparentTxCache(request.result)
        store.put({ ...cached, ...Object.fromEntries(transactions) }, key)
      }
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(
        guard.error ?? transaction.error ?? new Error('Transparent transaction cache save aborted')
      )
  })
}

/**
 * Load cached transparent transaction details. Invalid persisted values are ignored.
 */
export async function loadTransparentTxCache(
  key: string
): Promise<Record<string, VerboseTransaction>> {
  try {
    const db = await getConnection()

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME).get(key)

      request.onsuccess = () => {
        resolve(normalizeTransparentTxCache(request.result))
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('[IndexedDB] Failed to load transparent transaction cache:', error)
    return {}
  }
}

/**
 * Delete persisted transparent transaction details for an account.
 */
export async function deleteTransparentTxCache(key: string): Promise<void> {
  const db = await getConnection()

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME, 'readwrite')
    transaction.objectStore(TRANSPARENT_TRANSACTION_CACHE_STORE_NAME).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(transaction.error || new Error('Transparent transaction cache delete aborted'))
  })
}

// ============================================================================
// Journal Store - for resumable sync
// ============================================================================

export interface JournalManifest {
  walletKey: string
  baseSnapshotSeq: number
  nextSeq: number
  totalBytes: number
  createdAt: number
  updatedAt: number
}

interface JournalEntry {
  walletKey: string
  seq: number
  rangeStart: number
  rangeEnd: number
  data: Uint8Array
  committedAt: number
}

function journalWalletKey(network: string, walletId: string): string {
  return `${network}_${walletId}`
}

export async function getJournalManifest(
  network: string,
  walletId: string
): Promise<JournalManifest | null> {
  try {
    const db = await getConnection()
    const key = journalWalletKey(network, walletId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_MANIFEST_STORE_NAME, 'readonly')
      const store = tx.objectStore(JOURNAL_MANIFEST_STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('[IndexedDB] Failed to load journal manifest:', e)
    return null
  }
}

export async function saveJournalManifest(manifest: JournalManifest): Promise<void> {
  const db = await getConnection()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([JOURNAL_MANIFEST_STORE_NAME, WRITE_BLOCK_STORE_NAME], 'readwrite')
    const store = tx.objectStore(JOURNAL_MANIFEST_STORE_NAME)
    const guard = queueWalletWrite(tx, manifest.walletKey, () => {
      store.put(manifest, manifest.walletKey)
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(guard.error ?? tx.error ?? new Error('Journal manifest save failed'))
    tx.onabort = () => reject(guard.error ?? tx.error ?? new Error('Journal manifest save aborted'))
  })
}

/**
 * Append a journal entry, assigning its seq from the manifest inside a single
 * transaction so concurrent appends can never reuse (and overwrite) a seq.
 */
export async function appendJournalEntry(
  network: string,
  walletId: string,
  rangeStart: number,
  rangeEnd: number,
  data: Uint8Array
): Promise<number> {
  const db = await getConnection()
  const walletKey = journalWalletKey(network, walletId)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [JOURNAL_STORE_NAME, JOURNAL_MANIFEST_STORE_NAME, WRITE_BLOCK_STORE_NAME],
      'readwrite'
    )
    const journalStore = tx.objectStore(JOURNAL_STORE_NAME)
    const manifestStore = tx.objectStore(JOURNAL_MANIFEST_STORE_NAME)

    let assignedSeq = 0
    let mReq: IDBRequest<JournalManifest | undefined>
    const guard = queueWalletWrite(tx, walletKey, () => {
      mReq = manifestStore.get(walletKey)
      mReq.onsuccess = () => {
        const existing = mReq.result as JournalManifest | undefined
        assignedSeq = existing?.nextSeq ?? 0

        const entry: JournalEntry = {
          walletKey,
          seq: assignedSeq,
          rangeStart,
          rangeEnd,
          data,
          committedAt: Date.now()
        }
        journalStore.put(entry)

        const manifest: JournalManifest = {
          walletKey,
          baseSnapshotSeq: existing?.baseSnapshotSeq ?? 0,
          nextSeq: assignedSeq + 1,
          totalBytes: (existing?.totalBytes ?? 0) + data.byteLength,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now()
        }
        manifestStore.put(manifest, walletKey)
      }
    })

    tx.oncomplete = () => resolve(assignedSeq)
    tx.onerror = () => reject(guard.error ?? tx.error ?? new Error('Journal append failed'))
    tx.onabort = () => reject(guard.error ?? tx.error ?? new Error('Journal append aborted'))
  })
}

/** Read a bounded page without retaining the rest of the recovery journal. */
export async function loadJournalPage(
  network: string,
  walletId: string,
  fromSeq: number,
  toSeq: number
): Promise<JournalReplayEntry[]> {
  if (
    !Number.isSafeInteger(fromSeq) ||
    !Number.isSafeInteger(toSeq) ||
    fromSeq < 0 ||
    toSeq < fromSeq
  ) {
    throw new Error('Invalid sync journal sequence range')
  }
  if (fromSeq === toSeq) return []

  const db = await getConnection()
  const walletKey = journalWalletKey(network, walletId)
  const maxEntries = 5
  const maxBytes = 8 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOURNAL_STORE_NAME, 'readonly')
    const results: JournalReplayEntry[] = []
    let totalBytes = 0
    let readError: unknown
    const fail = (error: unknown) => {
      readError = error
      reject(error)
      try {
        tx.abort()
      } catch {
        /* The transaction may already have aborted. */
      }
    }
    // The compound primary key supplies sequence ordering and excludes other wallets.
    const range = IDBKeyRange.bound([walletKey, fromSeq], [walletKey, toSeq], false, true)
    const req = tx.objectStore(JOURNAL_STORE_NAME).openCursor(range)
    req.onsuccess = () => {
      try {
        const cursor = req.result
        if (cursor) {
          const entry = cursor.value as JournalEntry
          if (!(entry.data instanceof Uint8Array)) {
            throw new Error(`Invalid sync journal data at sequence ${entry.seq}`)
          }
          // A single oversized entry must still make progress; never combine it.
          if (results.length > 0 && totalBytes + entry.data.byteLength > maxBytes) return
          results.push({ seq: entry.seq, data: entry.data })
          totalBytes += entry.data.byteLength
          if (results.length >= maxEntries || totalBytes >= maxBytes) return
          cursor.continue()
        }
      } catch (error) {
        fail(error)
      }
    }
    req.onerror = () => fail(req.error || new Error('Sync journal read failed'))
    tx.oncomplete = () => resolve(results)
    tx.onabort = () => reject(readError ?? tx.error ?? new Error('Sync journal read aborted'))
    tx.onerror = () => fail(tx.error || new Error('Sync journal read failed'))
  })
}

export async function clearJournalEntries(
  network: string,
  walletId: string,
  upToSeq?: number
): Promise<void> {
  try {
    const db = await getConnection()
    const walletKey = journalWalletKey(network, walletId)

    return new Promise((resolve, reject) => {
      const tx = db.transaction([JOURNAL_STORE_NAME, JOURNAL_MANIFEST_STORE_NAME], 'readwrite')
      const journalStore = tx.objectStore(JOURNAL_STORE_NAME)
      const manifestStore = tx.objectStore(JOURNAL_MANIFEST_STORE_NAME)
      const index = journalStore.index('byWallet')

      const req = index.openCursor(IDBKeyRange.only(walletKey))
      let clearedBytes = 0
      let maxClearedSeq = -1

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const entry = cursor.value as JournalEntry
          if (upToSeq === undefined || entry.seq <= upToSeq) {
            clearedBytes += entry.data.byteLength
            if (entry.seq > maxClearedSeq) maxClearedSeq = entry.seq
            cursor.delete()
          }
          cursor.continue()
        } else if (maxClearedSeq >= 0) {
          const mReq = manifestStore.get(walletKey)
          mReq.onsuccess = () => {
            const m = mReq.result as JournalManifest | undefined
            if (m) {
              m.baseSnapshotSeq = (upToSeq ?? maxClearedSeq) + 1
              m.totalBytes = Math.max(0, m.totalBytes - clearedBytes)
              m.updatedAt = Date.now()
              manifestStore.put(m, walletKey)
            }
          }
        }
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('[IndexedDB] Failed to clear journal entries:', e)
  }
}

export async function deleteJournal(network: string, walletId: string): Promise<void> {
  await clearJournalEntries(network, walletId)
  try {
    const db = await getConnection()
    const walletKey = journalWalletKey(network, walletId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_MANIFEST_STORE_NAME, 'readwrite')
      const store = tx.objectStore(JOURNAL_MANIFEST_STORE_NAME)
      store.delete(walletKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('[IndexedDB] Failed to delete journal manifest:', e)
  }
}
