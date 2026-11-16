import {
  parseTransactionId,
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionEventId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import type {
  ApplyTransactionSegmentEventInput,
  TransactionCreateResult,
  TransactionListQuery,
  TransactionMutationResult,
  TransactionRepository
} from '@/ports/repositories'
import {
  TRANSACTION_V2_DATABASE,
  TRANSACTION_V2_DATABASE_INDEXES,
  TRANSACTION_V2_DATABASE_STORES,
  createStoredTransactionEventRecord,
  createStoredTransactionGraphRecord,
  deleteTransactionV2Database,
  parseStoredTransactionEventRecord,
  parseStoredTransactionGraphRecord,
  runWithTransactionV2Database
} from './indexed-db-transaction-database'
import {
  TRANSACTION_REPOSITORY_LIMITS,
  assertPersistableTransactionGraph,
  applyParsedTransactionMutation,
  collectKnownTransactionEvents,
  parseTransactionListQuery,
  parseTransactionMutation,
  parseTransactionRepositoryIdentity,
  parseTransactionRepositoryScope,
  transactionEventFingerprint,
  transactionGraphFingerprint,
  transactionGraphMatchesScope,
  transactionScopeKey
} from './transaction-repository-support'

export interface IndexedDbTransactionRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

async function runTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const transaction = database.transaction(storeNames, mode)
  const completion = transactionCompletion(transaction)
  try {
    const result = await operation(transaction)
    await completion
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The transaction may already have failed or completed.
    }
    await completion.catch(() => {})
    throw error
  }
}

function eventKey(transactionId: TransactionId, eventId: TransactionEventId): string[] {
  return [transactionId, eventId]
}

function deleteEventsForTransaction(
  eventStore: IDBObjectStore,
  transactionId: TransactionId
): Promise<void> {
  const index = eventStore.index(TRANSACTION_V2_DATABASE_INDEXES.eventsByTransaction)
  return new Promise((resolve, reject) => {
    const request = index.openKeyCursor(IDBKeyRange.only(transactionId))
    request.onerror = () => reject(request.error ?? new Error('Transaction event cursor failed'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      eventStore.delete(cursor.primaryKey)
      cursor.continue()
    }
  })
}

export class IndexedDbTransactionRepository implements TransactionRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbTransactionRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? TRANSACTION_V2_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Transaction V2 database name')
    }
  }

  async create(value: TransactionGraph): Promise<TransactionCreateResult> {
    const graph = parseTransactionGraph(value)
    assertPersistableTransactionGraph(graph)
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs, TRANSACTION_V2_DATABASE_STORES.events],
        'readwrite',
        async transaction => {
          const graphStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.graphs)
          const eventStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.events)
          const rawExisting = await requestResult<unknown>(graphStore.get(graph.root.id))
          if (rawExisting !== undefined) {
            const existing = parseStoredTransactionGraphRecord(rawExisting).graph
            return Object.freeze({
              status:
                transactionGraphFingerprint(existing) === transactionGraphFingerprint(graph)
                  ? 'already-exists'
                  : 'id-conflict',
              graph: existing
            })
          }

          const accountKey = transactionScopeKey(graph.root.scope)
          const accountCount = await requestResult(
            graphStore
              .index(TRANSACTION_V2_DATABASE_INDEXES.graphsByAccount)
              .count(IDBKeyRange.only(accountKey))
          )
          if (accountCount >= TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount) {
            throw new Error('Transaction repository Account capacity exceeded')
          }

          graphStore.add(createStoredTransactionGraphRecord(graph))
          for (const [eventId, fingerprint] of collectKnownTransactionEvents(graph)) {
            eventStore.add(createStoredTransactionEventRecord(graph.root.id, eventId, fingerprint))
          }
          return Object.freeze({ status: 'created' as const, graph })
        }
      )
    )
  }

  async get(
    scopeValue: TransactionAccountScope,
    transactionIdValue: TransactionId
  ): Promise<TransactionGraph | null> {
    const { scope, transactionId } = parseTransactionRepositoryIdentity(
      scopeValue,
      transactionIdValue
    )
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs],
        'readonly',
        async transaction => {
          const value = await requestResult<unknown>(
            transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.graphs).get(transactionId)
          )
          if (value === undefined) return null
          const graph = parseStoredTransactionGraphRecord(value).graph
          return transactionGraphMatchesScope(graph, scope) ? graph : null
        }
      )
    )
  }

  async list(queryValue: TransactionListQuery): Promise<readonly TransactionGraph[]> {
    const query = parseTransactionListQuery(queryValue)
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs],
        'readonly',
        async transaction => {
          const accountKey = transactionScopeKey(query.scope)
          const values = await requestResult<unknown[]>(
            transaction
              .objectStore(TRANSACTION_V2_DATABASE_STORES.graphs)
              .index(TRANSACTION_V2_DATABASE_INDEXES.graphsByAccount)
              .getAll(
                IDBKeyRange.only(accountKey),
                TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount + 1
              )
          )
          if (values.length > TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount) {
            throw new Error('Transaction repository Account capacity is corrupted')
          }
          const graphs = values
            .map(value => parseStoredTransactionGraphRecord(value).graph)
            .filter(graph => {
              if (!transactionGraphMatchesScope(graph, query.scope)) {
                throw new Error('Persisted transaction Account index mismatch')
              }
              if (query.statuses && !query.statuses.has(graph.root.status)) return false
              return (
                query.chainId === undefined ||
                graph.segments.some(
                  segment =>
                    segment.target.kind === 'onchain' && segment.target.chainId === query.chainId
                )
              )
            })
            .sort(
              (left, right) =>
                right.root.updatedAt - left.root.updatedAt ||
                right.root.createdAt - left.root.createdAt ||
                left.root.id.localeCompare(right.root.id)
            )
            .slice(0, query.limit)
          return Object.freeze(graphs)
        }
      )
    )
  }

  async listRheaSwapQuoteHandlesByAccountScope(
    scopeValue: TransactionAccountScope
  ): Promise<readonly string[]> {
    const scope = parseTransactionRepositoryScope(scopeValue)
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs],
        'readonly',
        async transaction => {
          const values = await requestResult<unknown[]>(
            transaction
              .objectStore(TRANSACTION_V2_DATABASE_STORES.graphs)
              .index(TRANSACTION_V2_DATABASE_INDEXES.graphsByAccount)
              .getAll(
                IDBKeyRange.only(transactionScopeKey(scope)),
                TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount + 1
              )
          )
          if (values.length > TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount) {
            throw new Error('Transaction repository Account capacity is corrupted')
          }
          const handles = new Set<string>()
          for (const value of values) {
            const graph = parseStoredTransactionGraphRecord(value).graph
            if (!transactionGraphMatchesScope(graph, scope)) {
              throw new Error('Persisted transaction Account index mismatch')
            }
            const binding = graph.root.intent?.protocol
            if (binding?.provider === 'rhea-cross-chain-dex') handles.add(binding.quoteHandle)
          }
          return Object.freeze([...handles])
        }
      )
    )
  }

  async applySegmentEvent(
    inputValue: ApplyTransactionSegmentEventInput
  ): Promise<TransactionMutationResult> {
    const input = parseTransactionMutation(inputValue)
    const fingerprint = transactionEventFingerprint(input.event)
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs, TRANSACTION_V2_DATABASE_STORES.events],
        'readwrite',
        async transaction => {
          const graphStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.graphs)
          const eventStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.events)
          const rawGraph = await requestResult<unknown>(graphStore.get(input.transactionId))
          const graph =
            rawGraph === undefined ? undefined : parseStoredTransactionGraphRecord(rawGraph).graph
          if (!graph || !transactionGraphMatchesScope(graph, input.scope)) {
            return Object.freeze({ status: 'not-found' as const })
          }

          const rawEvent = await requestResult<unknown>(
            eventStore.get(eventKey(input.transactionId, input.event.id))
          )
          if (rawEvent !== undefined) {
            const existing = parseStoredTransactionEventRecord(rawEvent)
            return Object.freeze({
              status:
                existing.fingerprint === null || existing.fingerprint === fingerprint
                  ? ('duplicate-event' as const)
                  : ('event-conflict' as const),
              graph
            })
          }

          const mutation = applyParsedTransactionMutation(graph, input)
          if (mutation.status !== 'applied' && mutation.status !== 'ignored-stale') {
            return mutation
          }
          const eventCount = await requestResult(
            eventStore
              .index(TRANSACTION_V2_DATABASE_INDEXES.eventsByTransaction)
              .count(IDBKeyRange.only(input.transactionId))
          )
          if (eventCount >= TRANSACTION_REPOSITORY_LIMITS.eventsPerTransaction) {
            throw new Error('Transaction event capacity exceeded')
          }
          eventStore.add(
            createStoredTransactionEventRecord(input.transactionId, input.event.id, fingerprint)
          )
          if (mutation.status === 'applied' && mutation.graph) {
            graphStore.put(createStoredTransactionGraphRecord(mutation.graph))
          }
          return mutation
        }
      )
    )
  }

  async hasAppliedEvent(
    scopeValue: TransactionAccountScope,
    transactionIdValue: TransactionId,
    eventIdValue: TransactionEventId
  ): Promise<boolean> {
    const { scope, transactionId, eventId } = parseTransactionRepositoryIdentity(
      scopeValue,
      transactionIdValue,
      eventIdValue
    )
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs, TRANSACTION_V2_DATABASE_STORES.events],
        'readonly',
        async transaction => {
          const rawGraph = await requestResult<unknown>(
            transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.graphs).get(transactionId)
          )
          if (rawGraph === undefined) return false
          const graph = parseStoredTransactionGraphRecord(rawGraph).graph
          if (!transactionGraphMatchesScope(graph, scope)) return false
          const event = await requestResult<unknown>(
            transaction
              .objectStore(TRANSACTION_V2_DATABASE_STORES.events)
              .get(eventKey(transactionId, eventId))
          )
          if (event === undefined) return false
          parseStoredTransactionEventRecord(event)
          return true
        }
      )
    )
  }

  async deleteByAccountScope(scopeValue: TransactionAccountScope): Promise<number> {
    const scope = parseTransactionRepositoryScope(scopeValue)
    return runWithTransactionV2Database(this.databaseName, database =>
      runTransaction(
        database,
        [TRANSACTION_V2_DATABASE_STORES.graphs, TRANSACTION_V2_DATABASE_STORES.events],
        'readwrite',
        async transaction => {
          const graphStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.graphs)
          const eventStore = transaction.objectStore(TRANSACTION_V2_DATABASE_STORES.events)
          const transactionIds = await requestResult<IDBValidKey[]>(
            graphStore
              .index(TRANSACTION_V2_DATABASE_INDEXES.graphsByAccount)
              .getAllKeys(
                IDBKeyRange.only(transactionScopeKey(scope)),
                TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount + 1
              )
          )
          if (transactionIds.length > TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount) {
            throw new Error('Transaction repository Account capacity is corrupted')
          }
          for (const rawTransactionId of transactionIds) {
            if (typeof rawTransactionId !== 'string') {
              throw new Error('Invalid persisted transaction ID key')
            }
            const transactionId = parseTransactionId(rawTransactionId)
            graphStore.delete(transactionId)
            await deleteEventsForTransaction(eventStore, transactionId)
          }
          return transactionIds.length
        }
      )
    )
  }
}

export function deleteIndexedDbTransactionPersistence(): Promise<void> {
  return deleteTransactionV2Database(TRANSACTION_V2_DATABASE.name)
}
