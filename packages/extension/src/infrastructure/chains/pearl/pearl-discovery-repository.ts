import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { assertPearlDiscoveryRefreshTransition } from './pearl-discovery-refresh'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  sameJson,
  type PearlDiscoveryProgress,
  type PearlDiscoveryRefresh,
  type PearlDiscoveryRepository,
  type PearlDiscoveryScope,
  type PearlDiscoveryState,
  type PearlDiscoveryTargetExtension,
  type StoredPearlObservationRecord,
  type StoredPearlScanRecord
} from './pearl-discovery-persistence-model'
import {
  addressKey,
  observationKey,
  parseObservation
} from './pearl-discovery-persistence-observation'
import {
  assertInitialProgress,
  assertPearlDiscoveryTargetExtension,
  assertProgressAdvance,
  parseState,
  parseStoredObservation,
  parseStoredScan
} from './pearl-discovery-persistence-progress'

export const PEARL_DISCOVERY_DATABASE = Object.freeze({
  name: 'noir-wallet-pearl-discovery-v1-db',
  version: 1
})

export const PEARL_DISCOVERY_READ_STAGES = Object.freeze([
  'scope',
  'database',
  'scan-record',
  'observation-records',
  'state'
] as const)

export type PearlDiscoveryReadStage = (typeof PEARL_DISCOVERY_READ_STAGES)[number]

export class PearlDiscoveryReadError extends Error {
  readonly stage: PearlDiscoveryReadStage
  readonly cause: unknown

  constructor(stage: PearlDiscoveryReadStage, cause: unknown) {
    super(`Pearl discovery ${stage} read failed`)
    this.name = 'PearlDiscoveryReadError'
    this.stage = stage
    this.cause = cause
  }
}

async function atReadStage<T>(
  stage: PearlDiscoveryReadStage,
  operation: () => Promise<T> | T
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PearlDiscoveryReadError) throw error
    throw new PearlDiscoveryReadError(stage, error)
  }
}

const SCANS_STORE = 'scans'
const OBSERVATIONS_STORE = 'observations'
const BY_ACCOUNT = 'byAccount'
const BY_CHAIN_ACCOUNT = 'byChainAccount'
const BY_ADDRESS = 'byAddress'
const MAXIMUM_OBSERVATIONS = 40_000

export interface IndexedDbPearlDiscoveryRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Pearl discovery request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Pearl discovery transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Pearl discovery transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, PEARL_DISCOVERY_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Pearl discovery open failed'))
    request.onblocked = () => reject(new Error('Pearl discovery database upgrade is blocked'))
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

export class IndexedDbPearlDiscoveryRepository implements PearlDiscoveryRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbPearlDiscoveryRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PEARL_DISCOVERY_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Pearl discovery database name')
    }
  }

  async get(scopeValue: PearlDiscoveryScope): Promise<PearlDiscoveryState | null> {
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
            throw new PearlDiscoveryReadError(
              'state',
              new Error('Pearl discovery contains orphaned observations')
            )
          }
          return null
        }
        if (observationValues.length > MAXIMUM_OBSERVATIONS) {
          throw new PearlDiscoveryReadError(
            'state',
            new Error('Pearl discovery observation capacity is corrupted')
          )
        }
        return atReadStage('state', () => parseState(scan, observationValues, scope))
      })
    )
  }

  async putProgress(progressValue: PearlDiscoveryProgress): Promise<void> {
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
      throw new Error('Invalid Pearl discovery progress')
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
          throw new Error('Pearl discovery contains an orphaned observation')
        }
        assertInitialProgress(checkpoint, observation)
      } else {
        const existingScan = parseStoredScan(existingScanValue, scope)
        if (updatedAt < existingScan.updatedAt) {
          throw new Error('Pearl discovery timestamp cannot move backwards')
        }
        if (sameJson(existingScan.checkpoint, checkpoint)) {
          if (existingObservationValue === undefined) {
            throw new Error('Pearl discovery idempotent progress is missing its observation')
          }
          const existingObservation = parseStoredObservation(existingObservationValue, scope)
          if (!sameJson(existingObservation.observation, observation)) {
            throw new Error('Pearl discovery observation conflicts with persisted progress')
          }
        } else {
          if (existingObservationValue !== undefined) {
            throw new Error('Pearl discovery address index already exists')
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
          throw new Error('Pearl discovery derived the same address at multiple paths')
        }
      }
      const storedObservation: StoredPearlObservationRecord = Object.freeze({
        schemaVersion: 1,
        observationKey: key,
        chainAccountId: scope.chainAccount.id,
        accountKey: accountKey(scope.chainAccount.scope),
        addressKey: addressKey(scope.chainAccount.id, observation),
        observation
      })
      const storedScan: StoredPearlScanRecord = Object.freeze({
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

  async putRefresh(refreshValue: PearlDiscoveryRefresh): Promise<void> {
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
      throw new Error('Invalid Pearl discovery refresh')
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
        throw new Error('Pearl discovery refresh requires persisted state')
      }
      const existingObservationValues = await requestResult<unknown[]>(
        observations
          .index(BY_CHAIN_ACCOUNT)
          .getAll(IDBKeyRange.only(scope.chainAccount.id), MAXIMUM_OBSERVATIONS + 1)
      )
      if (existingObservationValues.length > MAXIMUM_OBSERVATIONS) {
        throw new Error('Pearl discovery observation capacity is corrupted')
      }
      const existing = parseState(existingScanValue, existingObservationValues, scope)
      if (updatedAt < existing.updatedAt) {
        throw new Error('Pearl discovery timestamp cannot move backwards')
      }
      assertPearlDiscoveryRefreshTransition(existing, checkpoint, refreshedObservations)
      for (const observation of refreshedObservations) {
        const storedObservation: StoredPearlObservationRecord = Object.freeze({
          schemaVersion: 1,
          observationKey: observationKey(scope.chainAccount.id, observation),
          chainAccountId: scope.chainAccount.id,
          accountKey: accountKey(scope.chainAccount.scope),
          addressKey: addressKey(scope.chainAccount.id, observation),
          observation
        })
        observations.put(storedObservation)
      }
      const storedScan: StoredPearlScanRecord = Object.freeze({
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

  async extendTargets(extensionValue: PearlDiscoveryTargetExtension): Promise<void> {
    if (
      !isRecord(extensionValue) ||
      !hasExactKeys(extensionValue, ['chainAccount', 'accountIndex', 'checkpoint', 'updatedAt'])
    ) {
      throw new Error('Invalid Pearl discovery target extension')
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
        throw new Error('Pearl discovery target extension requires persisted state')
      }
      const existingObservationValues = await requestResult<unknown[]>(
        observations
          .index(BY_CHAIN_ACCOUNT)
          .getAll(IDBKeyRange.only(scope.chainAccount.id), MAXIMUM_OBSERVATIONS + 1)
      )
      if (existingObservationValues.length > MAXIMUM_OBSERVATIONS) {
        throw new Error('Pearl discovery observation capacity is corrupted')
      }
      const existing = parseState(existingScanValue, existingObservationValues, scope)
      if (updatedAt < existing.updatedAt) {
        throw new Error('Pearl discovery timestamp cannot move backwards')
      }
      assertPearlDiscoveryTargetExtension(existing.checkpoint, checkpoint, existing.observations)
      const storedScan: StoredPearlScanRecord = Object.freeze({
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

export function deleteIndexedDbPearlDiscovery(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PEARL_DISCOVERY_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Pearl discovery deletion failed'))
    request.onblocked = () => reject(new Error('Pearl discovery deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}

export type {
  PearlDiscoveryProgress,
  PearlDiscoveryRefresh,
  PearlDiscoveryRepository,
  PearlDiscoveryScope,
  PearlDiscoveryState,
  PearlDiscoveryTargetExtension
} from './pearl-discovery-persistence-model'
