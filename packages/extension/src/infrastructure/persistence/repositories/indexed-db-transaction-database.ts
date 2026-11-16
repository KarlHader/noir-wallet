import { parseChainId } from '@/core/chains/registry'
import {
  TRANSACTION_LIFECYCLE_STATUSES,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  type TransactionEventId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import {
  isTransactionRepositoryRecord,
  transactionScopeKey
} from './transaction-repository-support'

export const TRANSACTION_V2_DATABASE = Object.freeze({
  name: 'noir-wallet-transactions-v2-db',
  version: 1
})

export const TRANSACTION_V2_DATABASE_STORES = Object.freeze({
  graphs: 'graphs',
  events: 'events'
})

export const TRANSACTION_V2_DATABASE_INDEXES = Object.freeze({
  graphsByAccount: 'byAccount',
  eventsByTransaction: 'byTransaction'
})

export interface StoredTransactionGraphRecord {
  readonly schemaVersion: 1
  readonly transactionId: TransactionId
  readonly accountKey: string
  readonly chainIds: readonly string[]
  readonly status: TransactionGraph['root']['status']
  readonly createdAt: number
  readonly updatedAt: number
  readonly graph: TransactionGraph
}

export interface StoredTransactionEventRecord {
  readonly schemaVersion: 1
  readonly transactionId: TransactionId
  readonly eventId: TransactionEventId
  readonly fingerprint: string | null
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => required.includes(key))
  )
}

function graphChainIds(graph: TransactionGraph): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        graph.segments.flatMap(segment =>
          segment.target.kind === 'onchain' ? [segment.target.chainId] : []
        )
      )
    ].sort()
  )
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function createStoredTransactionGraphRecord(
  graphValue: TransactionGraph
): StoredTransactionGraphRecord {
  const graph = parseTransactionGraph(graphValue)
  return Object.freeze({
    schemaVersion: 1,
    transactionId: graph.root.id,
    accountKey: transactionScopeKey(graph.root.scope),
    chainIds: graphChainIds(graph),
    status: graph.root.status,
    createdAt: graph.root.createdAt,
    updatedAt: graph.root.updatedAt,
    graph
  })
}

export function parseStoredTransactionGraphRecord(value: unknown): StoredTransactionGraphRecord {
  if (
    !isTransactionRepositoryRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'transactionId',
      'accountKey',
      'chainIds',
      'status',
      'createdAt',
      'updatedAt',
      'graph'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.accountKey !== 'string' ||
    !Array.isArray(value.chainIds) ||
    value.chainIds.length > 32 ||
    new Set(value.chainIds).size !== value.chainIds.length ||
    value.chainIds.some(chainId => typeof chainId !== 'string') ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(
      value.status as StoredTransactionGraphRecord['status']
    ) ||
    typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) {
    throw new Error('Invalid persisted transaction graph record')
  }
  const transactionId = parseTransactionId(value.transactionId)
  const graph = parseTransactionGraph(value.graph)
  const chainIds = Object.freeze(value.chainIds.map(chainId => parseChainId(chainId as string).id))
  if (
    transactionId !== graph.root.id ||
    value.accountKey !== transactionScopeKey(graph.root.scope) ||
    value.status !== graph.root.status ||
    value.createdAt !== graph.root.createdAt ||
    value.updatedAt !== graph.root.updatedAt ||
    !arraysEqual(chainIds, graphChainIds(graph))
  ) {
    throw new Error('Persisted transaction graph index mismatch')
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId,
    accountKey: value.accountKey,
    chainIds,
    status: graph.root.status,
    createdAt: graph.root.createdAt,
    updatedAt: graph.root.updatedAt,
    graph
  })
}

export function createStoredTransactionEventRecord(
  transactionId: TransactionId,
  eventId: TransactionEventId,
  fingerprint: string | null
): StoredTransactionEventRecord {
  if (fingerprint !== null && fingerprint.length > 16_384) {
    throw new Error('Transaction event fingerprint exceeds the storage limit')
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId: parseTransactionId(transactionId),
    eventId: parseTransactionEventId(eventId),
    fingerprint
  })
}

export function parseStoredTransactionEventRecord(value: unknown): StoredTransactionEventRecord {
  if (
    !isTransactionRepositoryRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'transactionId', 'eventId', 'fingerprint']) ||
    value.schemaVersion !== 1 ||
    (value.fingerprint !== null &&
      (typeof value.fingerprint !== 'string' || value.fingerprint.length > 16_384))
  ) {
    throw new Error('Invalid persisted transaction event record')
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId: parseTransactionId(value.transactionId),
    eventId: parseTransactionEventId(value.eventId),
    fingerprint: value.fingerprint as string | null
  })
}

export function openTransactionV2Database(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, TRANSACTION_V2_DATABASE.version)
    request.onerror = () =>
      reject(request.error ?? new Error('Transaction V2 database open failed'))
    request.onblocked = () => reject(new Error('Transaction V2 database upgrade is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(TRANSACTION_V2_DATABASE_STORES.graphs)) {
        const graphs = database.createObjectStore(TRANSACTION_V2_DATABASE_STORES.graphs, {
          keyPath: 'transactionId'
        })
        graphs.createIndex(TRANSACTION_V2_DATABASE_INDEXES.graphsByAccount, 'accountKey', {
          unique: false
        })
      }
      if (!database.objectStoreNames.contains(TRANSACTION_V2_DATABASE_STORES.events)) {
        const events = database.createObjectStore(TRANSACTION_V2_DATABASE_STORES.events, {
          keyPath: ['transactionId', 'eventId']
        })
        events.createIndex(TRANSACTION_V2_DATABASE_INDEXES.eventsByTransaction, 'transactionId', {
          unique: false
        })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

export async function runWithTransactionV2Database<T>(
  databaseName: string,
  operation: (database: IDBDatabase) => Promise<T>
): Promise<T> {
  const database = await openTransactionV2Database(databaseName)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

export function deleteTransactionV2Database(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onerror = () =>
      reject(request.error ?? new Error('Transaction V2 database deletion failed'))
    request.onblocked = () => reject(new Error('Transaction V2 database deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
