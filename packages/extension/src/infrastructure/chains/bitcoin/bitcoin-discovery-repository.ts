import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { assertBitcoinDiscoveryRefreshTransition } from './bitcoin-discovery-refresh'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  sameJson,
  type BitcoinDiscoveryProgress,
  type BitcoinDiscoveryRefresh,
  type BitcoinDiscoveryRepository,
  type BitcoinDiscoveryScope,
  type BitcoinDiscoveryState,
  type BitcoinDiscoveryTargetExtension,
  type StoredObservationRecord,
  type StoredScanRecord
} from './bitcoin-discovery-persistence-model'
import {
  addressKey,
  observationKey,
  parseObservation
} from './bitcoin-discovery-persistence-observation'
import {
  assertInitialProgress,
  assertBitcoinDiscoveryTargetExtension,
  assertProgressAdvance,
  parseState,
  parseStoredObservation,
  parseStoredScan
} from './bitcoin-discovery-persistence-progress'

export const BITCOIN_DISCOVERY_DATABASE = Object.freeze({
  name: 'noir-wallet-bitcoin-discovery-v1-db',
  version: 1
})

export const BITCOIN_DISCOVERY_READ_STAGES = Object.freeze([
  'scope',
  'database',
  'scan-record',
  'observation-records',
  'state'
] as const)

export type BitcoinDiscoveryReadStage = (typeof BITCOIN_DISCOVERY_READ_STAGES)[number]

export class BitcoinDiscoveryReadError extends Error {
  readonly stage: BitcoinDiscoveryReadStage
  readonly cause: unknown

  constructor(stage: BitcoinDiscoveryReadStage, cause: unknown) {
    super(`Bitcoin discovery ${stage} read failed`)
    this.name = 'BitcoinDiscoveryReadError'
    this.stage = stage
    this.cause = cause
  }
}

async function atReadStage<T>(
  stage: BitcoinDiscoveryReadStage,
  operation: () => Promise<T> | T
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof BitcoinDiscoveryReadError) throw error
    throw new BitcoinDiscoveryReadError(stage, error)
  }
}

const SCANS_STORE = 'scans'
const OBSERVATIONS_STORE = 'observations'
const BY_ACCOUNT = 'byAccount'
const BY_CHAIN_ACCOUNT = 'byChainAccount'
const BY_ADDRESS = 'byAddress'
const MAXIMUM_OBSERVATIONS = 40_000

export interface IndexedDbBitcoinDiscoveryRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin discovery request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Bitcoin discovery transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Bitcoin discovery transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, BITCOIN_DISCOVERY_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin discovery open failed'))
    request.onblocked = () => reject(new Error('Bitcoin discovery database upgrade is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SCANS_STORE)) {
        const scans = database.createObjectStore(SCANS_STORE, { keyPath: 'chainAccountId' })
        scans.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
      }
      if (!database.objectStoreNames.contains(OBSERVATIONS_STORE)) {
        const observations = database.createObjectStore(OBSERVATIONS_STORE, {
          keyPath: 'observationKey'
        })
        observations.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        observations.createIndex(BY_CHAIN_ACCOUNT, 'chainAccountId', { unique: false })
        observations.createIndex(BY_ADDRESS, 'addressKey', { unique: true })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

async function runDatabase<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const database = await openDatabase(databaseName)
  const transaction = database.transaction([SCANS_STORE, OBSERVATIONS_STORE], mode)
  const completion = transactionDone(transaction)
  try {
    const result = await operation(transaction)
    await completion
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The transaction may already be complete.
    }
    await completion.catch(() => {})
    throw error
  } finally {
    database.close()
  }
}

export class IndexedDbBitcoinDiscoveryRepository implements BitcoinDiscoveryRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbBitcoinDiscoveryRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? BITCOIN_DISCOVERY_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Bitcoin discovery database name')
    }
  }

  async get(scopeValue: BitcoinDiscoveryScope): Promise<BitcoinDiscoveryState | null> {
    const scope = await atReadStage('scope', () => parseScope(scopeValue))
    return atReadStage('database', () =>
      runDatabase(this.databaseName, 'readonly', async transaction => {
        const scans = transaction.objectStore(SCANS_STORE)
        const observations = transaction.objectStore(OBSERVATIONS_STORE)
        const scan = await atReadStage('scan-record', () =>
          requestResult<unknown>(scans.get(scope.chainAccount.id))
        )
        const observationValues = await atReadStage('observation-records', () =>
          requestResult<unknown[]>(
            observations
              .index(BY_CHAIN_ACCOUNT)
              .getAll(IDBKeyRange.only(scope.chainAccount.id), MAXIMUM_OBSERVATIONS + 1)
          )
        )
        if (scan === undefined) {
          if (observationValues.length > 0) {
            throw new BitcoinDiscoveryReadError(
              'state',
              new Error('Bitcoin discovery contains orphaned observations')
            )
          }
          return null
        }
        if (observationValues.length > MAXIMUM_OBSERVATIONS) {
          throw new BitcoinDiscoveryReadError(
            'state',
            new Error('Bitcoin discovery observation capacity is corrupted')
          )
        }
        return atReadStage('state', () => parseState(scan, observationValues, scope))
      })
    )
  }

  async putProgress(progressValue: BitcoinDiscoveryProgress): Promise<void> {
    if (
      !isRecord(progressValue) ||
      !hasExactKeys(progressValue, [
        'chainAccount',
        'accountIndex',
        'checkpoint',
        'observation',
        'updatedAt'
      ])
    ) {
      throw new Error('Invalid Bitcoin discovery progress')
    }
    const scope = parseScope({
      chainAccount: progressValue.chainAccount,
      accountIndex: progressValue.accountIndex
    })
    const checkpoint = parseCheckpoint(progressValue.checkpoint, scope)
    const observation = parseObservation(progressValue.observation, scope)
    const updatedAt = parseTimestamp(progressValue.updatedAt)
    await runDatabase(this.databaseName, 'readwrite', async transaction => {
      const scans = transaction.objectStore(SCANS_STORE)
      const observations = transaction.objectStore(OBSERVATIONS_STORE)
      const existingScanValue = await requestResult<unknown>(scans.get(scope.chainAccount.id))
      const key = observationKey(scope.chainAccount.id, observation)
      const existingObservationValue = await requestResult<unknown>(observations.get(key))
      if (existingScanValue === undefined) {
        if (existingObservationValue !== undefined) {
          throw new Error('Bitcoin discovery contains an orphaned observation')
        }
        assertInitialProgress(checkpoint, observation)
      } else {
        const existingScan = parseStoredScan(existingScanValue, scope)
        if (updatedAt < existingScan.updatedAt) {
          throw new Error('Bitcoin discovery timestamp cannot move backwards')
        }
        if (sameJson(existingScan.checkpoint, checkpoint)) {
          if (existingObservationValue === undefined) {
            throw new Error('Bitcoin discovery idempotent progress is missing its observation')
          }
          const existingObservation = parseStoredObservation(existingObservationValue, scope)
          if (!sameJson(existingObservation.observation, observation)) {
            throw new Error('Bitcoin discovery observation conflicts with persisted progress')
          }
        } else {
          if (existingObservationValue !== undefined) {
            throw new Error('Bitcoin discovery address index already exists')
          }
          assertProgressAdvance(existingScan.checkpoint, checkpoint, observation)
        }
      }

      const duplicateAddress = await requestResult<unknown>(
        observations.index(BY_ADDRESS).get(addressKey(scope.chainAccount.id, observation))
      )
      if (duplicateAddress !== undefined) {
        const parsed = parseStoredObservation(duplicateAddress, scope)
        if (parsed.observationKey !== key) {
          throw new Error('Bitcoin discovery derived the same address at multiple paths')
        }
      }
      const storedObservation: StoredObservationRecord = Object.freeze({
        schemaVersion: 1,
        observationKey: key,
        chainAccountId: scope.chainAccount.id,
        accountKey: accountKey(scope.chainAccount.scope),
        addressKey: addressKey(scope.chainAccount.id, observation),
        observation
      })
      const storedScan: StoredScanRecord = Object.freeze({
        schemaVersion: 1,
        chainAccountId: scope.chainAccount.id,
        accountKey: accountKey(scope.chainAccount.scope),
        chainAccount: scope.chainAccount,
        accountIndex: scope.accountIndex,
        checkpoint,
        updatedAt
      })
      observations.put(storedObservation)
      scans.put(storedScan)
    })
  }

  async putRefresh(refreshValue: BitcoinDiscoveryRefresh): Promise<void> {
    if (
      !isRecord(refreshValue) ||
      !hasExactKeys(refreshValue, [
        'chainAccount',
        'accountIndex',
        'checkpoint',
        'observations',
        'updatedAt'
      ]) ||
      !Array.isArray(refreshValue.observations) ||
      refreshValue.observations.length > MAXIMUM_OBSERVATIONS
    ) {
      throw new Error('Invalid Bitcoin discovery refresh')
    }
    const scope = parseScope({
      chainAccount: refreshValue.chainAccount,
      accountIndex: refreshValue.accountIndex
    })
    const checkpoint = parseCheckpoint(refreshValue.checkpoint, scope)
    const refreshedObservations = refreshValue.observations.map(value =>
      parseObservation(value, scope)
    )
    const updatedAt = parseTimestamp(refreshValue.updatedAt)
    await runDatabase(this.databaseName, 'readwrite', async transaction => {
      const scans = transaction.objectStore(SCANS_STORE)
      const observations = transaction.objectStore(OBSERVATIONS_STORE)
      const existingScanValue = await requestResult<unknown>(scans.get(scope.chainAccount.id))
      if (existingScanValue === undefined) {
        throw new Error('Bitcoin discovery refresh requires persisted state')
      }
      const existingObservationValues = await requestResult<unknown[]>(
        observations
          .index(BY_CHAIN_ACCOUNT)
          .getAll(IDBKeyRange.only(scope.chainAccount.id), MAXIMUM_OBSERVATIONS + 1)
      )
      if (existingObservationValues.length > MAXIMUM_OBSERVATIONS) {
        throw new Error('Bitcoin discovery observation capacity is corrupted')
      }
      const existing = parseState(existingScanValue, existingObservationValues, scope)
      if (updatedAt < existing.updatedAt) {
        throw new Error('Bitcoin discovery timestamp cannot move backwards')
      }
      assertBitcoinDiscoveryRefreshTransition(existing, checkpoint, refreshedObservations)
      for (const observation of refreshedObservations) {
        const storedObservation: StoredObservationRecord = Object.freeze({
          schemaVersion: 1,
          observationKey: observationKey(scope.chainAccount.id, observation),
          chainAccountId: scope.chainAccount.id,
          accountKey: accountKey(scope.chainAccount.scope),
          addressKey: addressKey(scope.chainAccount.id, observation),
          observation
        })
        observations.put(storedObservation)
      }
      const storedScan: StoredScanRecord = Object.freeze({
        schemaVersion: 1,
        chainAccountId: scope.chainAccount.id,
        accountKey: accountKey(scope.chainAccount.scope),
        chainAccount: scope.chainAccount,
        accountIndex: scope.accountIndex,
        checkpoint,
        updatedAt
      })
      scans.put(storedScan)
    })
  }

  async extendTargets(extensionValue: BitcoinDiscoveryTargetExtension): Promise<void> {
    if (
      !isRecord(extensionValue) ||
      !hasExactKeys(extensionValue, ['chainAccount', 'accountIndex', 'checkpoint', 'updatedAt'])
    ) {
      throw new Error('Invalid Bitcoin discovery target extension')
    }
    const scope = parseScope({
      chainAccount: extensionValue.chainAccount,
      accountIndex: extensionValue.accountIndex
    })
    const checkpoint = parseCheckpoint(extensionValue.checkpoint, scope)
    const updatedAt = parseTimestamp(extensionValue.updatedAt)
    await runDatabase(this.databaseName, 'readwrite', async transaction => {
      const scans = transaction.objectStore(SCANS_STORE)
      const observations = transaction.objectStore(OBSERVATIONS_STORE)
      const existingScanValue = await requestResult<unknown>(scans.get(scope.chainAccount.id))
      if (existingScanValue === undefined) {
        throw new Error('Bitcoin discovery target extension requires persisted state')
      }
      const existingObservationValues = await requestResult<unknown[]>(
        observations
          .index(BY_CHAIN_ACCOUNT)
          .getAll(IDBKeyRange.only(scope.chainAccount.id), MAXIMUM_OBSERVATIONS + 1)
      )
      if (existingObservationValues.length > MAXIMUM_OBSERVATIONS) {
        throw new Error('Bitcoin discovery observation capacity is corrupted')
      }
      const existing = parseState(existingScanValue, existingObservationValues, scope)
      if (updatedAt < existing.updatedAt) {
        throw new Error('Bitcoin discovery timestamp cannot move backwards')
      }
      assertBitcoinDiscoveryTargetExtension(existing.checkpoint, checkpoint, existing.observations)
      const storedScan: StoredScanRecord = Object.freeze({
        schemaVersion: 1,
        chainAccountId: scope.chainAccount.id,
        accountKey: accountKey(scope.chainAccount.scope),
        chainAccount: scope.chainAccount,
        accountIndex: scope.accountIndex,
        checkpoint,
        updatedAt
      })
      scans.put(storedScan)
    })
  }

  async deleteByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number> {
    const scope = parseAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', async transaction => {
      const scans = transaction.objectStore(SCANS_STORE)
      const observations = transaction.objectStore(OBSERVATIONS_STORE)
      const key = accountKey(scope)
      const scanKeys = await requestResult<IDBValidKey[]>(
        scans.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(key))
      )
      const observationKeys = await requestResult<IDBValidKey[]>(
        observations.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(key))
      )
      for (const scanKey of scanKeys) scans.delete(scanKey)
      for (const observationKeyValue of observationKeys) observations.delete(observationKeyValue)
      return scanKeys.length
    })
  }
}

export function deleteIndexedDbBitcoinDiscovery(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BITCOIN_DISCOVERY_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin discovery deletion failed'))
    request.onblocked = () => reject(new Error('Bitcoin discovery deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}

export type {
  BitcoinDiscoveryProgress,
  BitcoinDiscoveryRefresh,
  BitcoinDiscoveryRepository,
  BitcoinDiscoveryScope,
  BitcoinDiscoveryState,
  BitcoinDiscoveryTargetExtension
} from './bitcoin-discovery-persistence-model'
