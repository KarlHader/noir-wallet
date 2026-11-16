import {
  getDiagnosticEntryByteSize,
  retainDiagnosticEntries,
  sanitizeDiagnosticMessage,
  type DiagnosticLogDraft,
  type DiagnosticLogEntry
} from '@/lib/diagnostic-log'

const DB_NAME = 'noir-diagnostic-logs'
const STORE_NAME = 'entries'
let connection: Promise<IDBDatabase> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let saltPromise: Promise<string> | null = null

function getConnection(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onclose = () => {
        connection = null
        saltPromise = null
      }
      db.onversionchange = () => {
        db.close()
        connection = null
        saltPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      connection = null
      reject(request.error)
    }
  })
  return connection
}

export function formatDiagnosticContext(walletId?: string, accountId?: string): Promise<string> {
  if (!walletId && !accountId) return Promise.resolve('')
  saltPromise ??= getConnection()
    .then(
      db =>
        new Promise<string>((resolve, reject) => {
          const transaction = db.transaction('metadata', 'readwrite')
          const store = transaction.objectStore('metadata')
          const request = store.get('fingerprint_salt')
          let salt = ''
          request.onsuccess = () => {
            try {
              salt =
                typeof request.result === 'string' && request.result.length >= 16
                  ? request.result
                  : crypto.randomUUID()
              if (salt !== request.result) store.put(salt, 'fingerprint_salt')
            } catch (error) {
              transaction.abort()
              reject(error)
            }
          }
          transaction.oncomplete = () => resolve(salt)
          transaction.onabort = transaction.onerror = () => reject(transaction.error)
        })
    )
    .catch(error => {
      saltPromise = null
      throw error
    })
  return saltPromise.then(async salt => {
    const labels = await Promise.all(
      [
        ['wallet', walletId],
        ['account', accountId]
      ].map(async ([kind, id]) => {
        if (!id) return ''
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`${salt}:${id}`)
        )
        const fingerprint = Array.from(new Uint8Array(digest))
          .slice(0, 6)
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('')
        return `[${kind}:${fingerprint}]`
      })
    )
    return labels.filter(Boolean).join(' ')
  })
}

export async function appendDiagnosticLog(
  draft: DiagnosticLogDraft,
  scope?: { walletId?: string; accountId?: string }
): Promise<void> {
  const context = await formatDiagnosticContext(scope?.walletId, scope?.accountId)
  const safe: DiagnosticLogEntry = {
    ...draft,
    message: sanitizeDiagnosticMessage([draft.message, context].filter(Boolean).join(' ')),
    timestamp:
      draft.timestamp > Date.now() + 300_000 || draft.timestamp <= 0 ? Date.now() : draft.timestamp,
    byteSize: 0
  }
  safe.byteSize = getDiagnosticEntryByteSize(safe)
  const pending = writeQueue.then(async () => {
    const db = await getConnection()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.add(safe)
    const request = store.getAll()
    const entries = await new Promise<DiagnosticLogEntry[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as DiagnosticLogEntry[])
      request.onerror = () => reject(request.error)
    })
    const retained = retainDiagnosticEntries(entries)
    const ids = new Set(retained.map(entry => entry.id))
    for (const entry of entries)
      if (entry.id !== undefined && !ids.has(entry.id)) store.delete(entry.id)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  })
  writeQueue = pending.catch(() => {})
  return pending
}

export async function exportDiagnosticLogs(): Promise<{
  text: string
  filename: string
  count: number
}> {
  await writeQueue
  const db = await getConnection()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const request = store.getAll()
  const entries = await new Promise<DiagnosticLogEntry[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as DiagnosticLogEntry[])
    request.onerror = () => reject(request.error)
  })
  const retained = retainDiagnosticEntries(entries)
  const ids = new Set(retained.map(entry => entry.id))
  for (const entry of entries)
    if (entry.id !== undefined && !ids.has(entry.id)) store.delete(entry.id)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
  const exportedAt = new Date()
  const lines = [
    'Noir Wallet Diagnostics',
    `Version: ${chrome.runtime.getManifest().version}`,
    `Network: ${__NETWORK_MODE__}`,
    `Exported at: ${exportedAt.toISOString()}`,
    `Entries: ${retained.length}`,
    '',
    ...retained.map(
      entry =>
        `[${new Date(entry.timestamp).toISOString()}] [${entry.source}] [${entry.level.toUpperCase()}]${entry.contextId ? ` [${entry.contextId}:${entry.sequence}]` : ''} ${sanitizeDiagnosticMessage(entry.message)}`
    )
  ]
  const stamp = exportedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return {
    text: `${lines.join('\n')}\n`,
    filename: `noir-wallet-diagnostics-${stamp}.txt`,
    count: retained.length
  }
}
