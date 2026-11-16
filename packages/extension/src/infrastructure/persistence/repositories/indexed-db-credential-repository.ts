import type { CredentialGenerationId, EngineCredentialRef } from '@/core/keyring/domain'
import {
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef
} from '@/core/keyring/domain'
import type {
  CredentialActivationResult,
  CredentialEnvelopeWriteStatus,
  CredentialJournalAdvanceStatus,
  CredentialJournalWriteStatus,
  CredentialRetiredEnvelopePurgeStatus,
  CredentialRepository,
  CredentialRetirementRecord,
  CredentialRetirementWriteStatus,
  CredentialSetRecord,
  CredentialSetWriteStatus,
  CredentialTransactionId,
  CredentialTransactionJournal,
  CredentialTransactionOperation,
  CredentialTransactionStageStatus,
  EncryptedCredentialEnvelopeRecord
} from '@/ports/repositories'
import {
  parseCredentialRetirementRecord,
  parseCredentialSetRecord,
  parseCredentialTransactionId,
  parseCredentialTransactionJournal,
  parseEncryptedCredentialEnvelopeRecord
} from '../schema/credential-repository-validation'
import {
  CredentialRepositoryState,
  type CredentialRepositorySnapshot
} from './credential-repository-state'

export const CREDENTIAL_REPOSITORY_DATABASE = Object.freeze({
  name: 'noir-wallet-credential-db',
  version: 1
})

const STORE_NAMES = Object.freeze({
  envelopes: 'encryptedCredentialEnvelopes',
  credentialSets: 'credentialSets',
  journals: 'credentialTransactionJournals',
  retirements: 'credentialRetirements'
})

const ALL_STORE_NAMES = Object.freeze(Object.values(STORE_NAMES))
const CREDENTIAL_SET_GENERATION_INDEX = 'byCredentialGenerationId'

export interface IndexedDbCredentialRepositoryOptions {
  readonly databaseName?: string
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, CREDENTIAL_REPOSITORY_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Credential database open failed'))
    request.onblocked = () => reject(new Error('Credential database upgrade is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAMES.envelopes)) {
        database.createObjectStore(STORE_NAMES.envelopes, { keyPath: 'aad.credentialRef' })
      }
      if (!database.objectStoreNames.contains(STORE_NAMES.credentialSets)) {
        const store = database.createObjectStore(STORE_NAMES.credentialSets, {
          keyPath: 'credentialSetRef'
        })
        store.createIndex(CREDENTIAL_SET_GENERATION_INDEX, 'manifest.credentialGenerationId', {
          unique: true
        })
      }
      if (!database.objectStoreNames.contains(STORE_NAMES.journals)) {
        database.createObjectStore(STORE_NAMES.journals, { keyPath: 'transactionId' })
      }
      if (!database.objectStoreNames.contains(STORE_NAMES.retirements)) {
        database.createObjectStore(STORE_NAMES.retirements, { keyPath: 'credentialSetRef' })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

function getRequestResult(request: IDBRequest): unknown | null {
  return request.result === undefined ? null : request.result
}

function readOne(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  indexName?: string
): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const store = transaction.objectStore(storeName)
    const request = indexName ? store.index(indexName).get(key) : store.get(key)
    let value: unknown | null = null
    request.onsuccess = () => {
      value = getRequestResult(request)
    }
    transaction.oncomplete = () => resolve(value)
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Credential database read failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Credential database read aborted'))
  })
}

function readSnapshotRequests(transaction: IDBTransaction): {
  readonly requests: readonly IDBRequest<unknown[]>[]
  snapshot(): CredentialRepositorySnapshot
} {
  const envelopeRequest = transaction.objectStore(STORE_NAMES.envelopes).getAll()
  const credentialSetRequest = transaction.objectStore(STORE_NAMES.credentialSets).getAll()
  const journalRequest = transaction.objectStore(STORE_NAMES.journals).getAll()
  const retirementRequest = transaction.objectStore(STORE_NAMES.retirements).getAll()
  return {
    requests: [envelopeRequest, credentialSetRequest, journalRequest, retirementRequest],
    snapshot: () => ({
      envelopes: envelopeRequest.result.map(parseEncryptedCredentialEnvelopeRecord),
      credentialSets: credentialSetRequest.result.map(parseCredentialSetRecord),
      journals: journalRequest.result.map(parseCredentialTransactionJournal),
      retirements: retirementRequest.result.map(parseCredentialRetirementRecord)
    })
  }
}

function writeSnapshot(transaction: IDBTransaction, snapshot: CredentialRepositorySnapshot): void {
  const envelopeStore = transaction.objectStore(STORE_NAMES.envelopes)
  const credentialSetStore = transaction.objectStore(STORE_NAMES.credentialSets)
  const journalStore = transaction.objectStore(STORE_NAMES.journals)
  const retirementStore = transaction.objectStore(STORE_NAMES.retirements)
  envelopeStore.clear()
  credentialSetStore.clear()
  journalStore.clear()
  retirementStore.clear()
  snapshot.envelopes.forEach(record => envelopeStore.put(record))
  snapshot.credentialSets.forEach(record => credentialSetStore.put(record))
  snapshot.journals.forEach(record => journalStore.put(record))
  snapshot.retirements.forEach(record => retirementStore.put(record))
}

async function runWithDatabase<T>(
  databaseName: string,
  operation: (database: IDBDatabase) => Promise<T>
): Promise<T> {
  const database = await openDatabase(databaseName)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

export class IndexedDbCredentialRepository implements CredentialRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbCredentialRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? CREDENTIAL_REPOSITORY_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid credential database name')
    }
  }

  async stageTransaction(
    journal: CredentialTransactionJournal,
    envelopes: readonly EncryptedCredentialEnvelopeRecord[],
    credentialSets: readonly CredentialSetRecord[]
  ): Promise<CredentialTransactionStageStatus> {
    return this.mutate(state => state.stageTransaction(journal, envelopes, credentialSets))
  }

  async putEnvelope(
    record: EncryptedCredentialEnvelopeRecord
  ): Promise<CredentialEnvelopeWriteStatus> {
    return this.mutate(state => state.putEnvelope(record))
  }

  async getEnvelope(refValue: EngineCredentialRef) {
    const ref = parseEngineCredentialRef(refValue)
    return this.readRecord(STORE_NAMES.envelopes, ref, parseEncryptedCredentialEnvelopeRecord)
  }

  async putCredentialSet(record: CredentialSetRecord): Promise<CredentialSetWriteStatus> {
    return this.mutate(state => state.putCredentialSet(record))
  }

  async getCredentialSet(refValue: CredentialSetRecord['credentialSetRef']) {
    const ref = parseCredentialRef(refValue)
    return this.readRecord(STORE_NAMES.credentialSets, ref, parseCredentialSetRecord)
  }

  async getCredentialSetByGeneration(generationIdValue: CredentialGenerationId) {
    const generationId = parseCredentialGenerationId(generationIdValue)
    return this.readRecord(
      STORE_NAMES.credentialSets,
      generationId,
      parseCredentialSetRecord,
      CREDENTIAL_SET_GENERATION_INDEX
    )
  }

  async createJournal(
    journal: CredentialTransactionJournal
  ): Promise<CredentialJournalWriteStatus> {
    return this.mutate(state => state.createJournal(journal))
  }

  async getJournal(transactionIdValue: CredentialTransactionId) {
    const transactionId = parseCredentialTransactionId(transactionIdValue)
    return this.readRecord(STORE_NAMES.journals, transactionId, parseCredentialTransactionJournal)
  }

  async findIncompleteJournal(operation: CredentialTransactionOperation) {
    return this.readState(state => state.findIncompleteJournal(operation))
  }

  async advanceJournal(
    journal: CredentialTransactionJournal,
    expectedRevision: number
  ): Promise<CredentialJournalAdvanceStatus> {
    return this.mutate(state => state.advanceJournal(journal, expectedRevision))
  }

  async retire(record: CredentialRetirementRecord): Promise<CredentialRetirementWriteStatus> {
    return this.mutate(state => state.retire(record))
  }

  async purgeRetiredEnvelopes(
    ref: CredentialSetRecord['credentialSetRef'],
    transactionId: CredentialTransactionId
  ): Promise<CredentialRetiredEnvelopePurgeStatus> {
    return this.mutate(state => state.purgeRetiredEnvelopes(ref, transactionId))
  }

  async getRetirement(refValue: CredentialSetRecord['credentialSetRef']) {
    const ref = parseCredentialRef(refValue)
    return this.readRecord(STORE_NAMES.retirements, ref, parseCredentialRetirementRecord)
  }

  async validateForActivation(
    ref: CredentialSetRecord['credentialSetRef'],
    keyDomainId: CredentialSetRecord['manifest']['keyDomainId'],
    committingTransactionId?: CredentialTransactionId
  ): Promise<CredentialActivationResult> {
    return this.readState(state =>
      state.validateForActivation(ref, keyDomainId, committingTransactionId)
    )
  }

  private async readRecord<T>(
    storeName: string,
    key: IDBValidKey,
    parse: (value: unknown) => T,
    indexName?: string
  ): Promise<T | null> {
    return runWithDatabase(this.databaseName, async database => {
      const value = await readOne(database, storeName, key, indexName)
      return value === null ? null : parse(value)
    })
  }

  private async readState<T>(read: (state: CredentialRepositoryState) => T): Promise<T> {
    return runWithDatabase(
      this.databaseName,
      database =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(ALL_STORE_NAMES, 'readonly')
          const source = readSnapshotRequests(transaction)
          let result: T | undefined
          let failure: unknown
          let remaining = source.requests.length
          for (const request of source.requests) {
            request.onsuccess = () => {
              remaining -= 1
              if (remaining !== 0) return
              try {
                result = read(new CredentialRepositoryState(source.snapshot()))
              } catch (error) {
                failure = error
                transaction.abort()
              }
            }
          }
          transaction.oncomplete = () => resolve(result as T)
          transaction.onerror = () =>
            reject(failure ?? transaction.error ?? new Error('Credential database read failed'))
          transaction.onabort = () =>
            reject(failure ?? transaction.error ?? new Error('Credential database read aborted'))
        })
    )
  }

  private async mutate<T>(mutation: (state: CredentialRepositoryState) => T): Promise<T> {
    return runWithDatabase(
      this.databaseName,
      database =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(ALL_STORE_NAMES, 'readwrite')
          const source = readSnapshotRequests(transaction)
          let result: T | undefined
          let failure: unknown
          let remaining = source.requests.length
          for (const request of source.requests) {
            request.onsuccess = () => {
              remaining -= 1
              if (remaining !== 0) return
              try {
                const state = new CredentialRepositoryState(source.snapshot())
                result = mutation(state)
                writeSnapshot(transaction, state.snapshot())
              } catch (error) {
                failure = error
                transaction.abort()
              }
            }
          }
          transaction.oncomplete = () => resolve(result as T)
          transaction.onerror = () =>
            reject(failure ?? transaction.error ?? new Error('Credential database write failed'))
          transaction.onabort = () =>
            reject(failure ?? transaction.error ?? new Error('Credential database write aborted'))
        })
    )
  }
}
