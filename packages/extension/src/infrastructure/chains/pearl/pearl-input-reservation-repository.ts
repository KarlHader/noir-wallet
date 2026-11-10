import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseTimestamp
} from './pearl-discovery-persistence-model'
import {
  PEARL_INPUT_RESERVATION_SCHEMA_VERSION,
  pearlInputOutpointKey,
  pearlInputReservationKey,
  pearlInputReservationScopeKey,
  parsePearlInputOutpoints,
  parsePearlInputReservationAccountScope,
  parsePearlInputReservationScope,
  parseStoredPearlInputReservation,
  storedPearlInputReservation,
  type PearlInputReservation,
  type PearlInputReservationRepository,
  type PearlInputReservationScope,
  type CommitPearlInputsInput,
  type ReservePearlInputsInput
} from './pearl-input-reservation-model'

export const PEARL_INPUT_RESERVATION_DATABASE = Object.freeze({
  name: 'noir-wallet-pearl-input-v1-db',
  version: 2
})

const RESERVATIONS_STORE = 'reservations'
const BY_ACCOUNT = 'byAccount'
const BY_SCOPE = 'byScope'
const BY_OUTPOINT = 'byOutpoint'
const MAXIMUM_RESERVATIONS_PER_SCOPE = 1_024
const MAXIMUM_RESERVATIONS_PER_ACCOUNT = 4_096

export interface IndexedDbPearlInputReservationRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Pearl input request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Pearl input transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Pearl input transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, PEARL_INPUT_RESERVATION_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Pearl input database open failed'))
    request.onblocked = () => reject(new Error('Pearl input database open is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      let reservations: IDBObjectStore
      if (!database.objectStoreNames.contains(RESERVATIONS_STORE)) {
        reservations = database.createObjectStore(RESERVATIONS_STORE, {
          keyPath: 'reservationKey'
        })
      } else {
        reservations = request.transaction!.objectStore(RESERVATIONS_STORE)
      }
      if (!reservations.indexNames.contains(BY_ACCOUNT)) {
        reservations.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
      }
      if (!reservations.indexNames.contains(BY_SCOPE)) {
        reservations.createIndex(BY_SCOPE, 'scopeKey', { unique: false })
      }
      if (!reservations.indexNames.contains(BY_OUTPOINT)) {
        reservations.createIndex(BY_OUTPOINT, 'outpointKeys', { unique: true, multiEntry: true })
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
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const database = await openDatabase(databaseName)
  const transaction = database.transaction(RESERVATIONS_STORE, mode)
  const completion = transactionDone(transaction)
  try {
    const result = await operation(transaction.objectStore(RESERVATIONS_STORE))
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

function sameOutpoints(
  left: PearlInputReservation['outpoints'],
  right: PearlInputReservation['outpoints']
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class IndexedDbPearlInputReservationRepository implements PearlInputReservationRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbPearlInputReservationRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PEARL_INPUT_RESERVATION_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Pearl input database name')
    }
  }

  async get(
    scopeValue: PearlInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<PearlInputReservation | null> {
    const scope = parsePearlInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const value = await requestResult<unknown>(
        store.get(pearlInputReservationKey(scope, transactionId))
      )
      return value === undefined
        ? null
        : parseStoredPearlInputReservation(value, scope, transactionId).reservation
    })
  }

  async reserve(input: ReservePearlInputsInput): Promise<PearlInputReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressScheme',
        'transactionId',
        'outpoints',
        'now'
      ])
    ) {
      throw new Error('Invalid Pearl input reservation request')
    }
    const scope = parsePearlInputReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const transactionId = parseTransactionId(input.transactionId)
    const outpoints = parsePearlInputOutpoints(input.outpoints)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlInputReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue !== undefined) {
        const existing = parseStoredPearlInputReservation(
          existingValue,
          scope,
          transactionId
        ).reservation
        if (!sameOutpoints(existing.outpoints, outpoints)) {
          throw new Error('Pearl transaction input reservation conflicts with persisted data')
        }
        return existing
      }

      const scopeReservations = await requestResult<IDBValidKey[]>(
        store
          .index(BY_SCOPE)
          .getAllKeys(
            IDBKeyRange.only(pearlInputReservationScopeKey(scope)),
            MAXIMUM_RESERVATIONS_PER_SCOPE + 1
          )
      )
      if (scopeReservations.length >= MAXIMUM_RESERVATIONS_PER_SCOPE) {
        throw new Error('Pearl input reservation capacity exceeded')
      }

      for (const outpoint of outpoints) {
        const conflict = await requestResult<unknown>(
          store.index(BY_OUTPOINT).get(pearlInputOutpointKey(scope, outpoint))
        )
        if (conflict !== undefined) {
          throw new Error('Pearl input is already reserved by another transaction')
        }
      }
      const reservation: PearlInputReservation = Object.freeze({
        schemaVersion: PEARL_INPUT_RESERVATION_SCHEMA_VERSION,
        ...scope,
        transactionId,
        state: 'reserved',
        outpoints,
        createdAt: now,
        updatedAt: now
      })
      store.add(storedPearlInputReservation(reservation))
      return reservation
    })
  }

  async list(scopeValue: PearlInputReservationScope): Promise<readonly PearlInputReservation[]> {
    const scope = parsePearlInputReservationScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store
          .index(BY_SCOPE)
          .getAll(
            IDBKeyRange.only(pearlInputReservationScopeKey(scope)),
            MAXIMUM_RESERVATIONS_PER_SCOPE + 1
          )
      )
      if (values.length > MAXIMUM_RESERVATIONS_PER_SCOPE) {
        throw new Error('Pearl input reservation capacity is corrupted')
      }
      return Object.freeze(
        values
          .map(value => parseStoredPearlInputReservation(value, scope).reservation)
          .sort((left, right) => left.transactionId.localeCompare(right.transactionId))
      )
    })
  }

  async listByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<readonly PearlInputReservation[]> {
    const scope = parsePearlInputReservationAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store
          .index(BY_ACCOUNT)
          .getAll(IDBKeyRange.only(accountKey(scope)), MAXIMUM_RESERVATIONS_PER_ACCOUNT + 1)
      )
      if (values.length > MAXIMUM_RESERVATIONS_PER_ACCOUNT) {
        throw new Error('Pearl Account input reservation capacity is corrupted')
      }
      return Object.freeze(
        values
          .map(value => parseStoredPearlInputReservation(value).reservation)
          .map(reservation => {
            if (
              reservation.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
              reservation.chainAccount.scope.accountId !== scope.accountId
            ) {
              throw new Error('Pearl input reservation Account index is corrupted')
            }
            return reservation
          })
          .sort((left, right) => left.transactionId.localeCompare(right.transactionId))
      )
    })
  }

  async commit(input: CommitPearlInputsInput): Promise<PearlInputReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressScheme',
        'transactionId',
        'now'
      ])
    ) {
      throw new Error('Invalid Pearl input reservation commit')
    }
    const scope = parsePearlInputReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) throw new Error('Pearl input reservation is missing')
      const existing = parseStoredPearlInputReservation(value, scope, transactionId).reservation
      if (now < existing.updatedAt) {
        throw new Error('Pearl input reservation timestamp cannot move backwards')
      }
      if (existing.state === 'committed') return existing
      const committed = Object.freeze({ ...existing, state: 'committed' as const, updatedAt: now })
      store.put(storedPearlInputReservation(committed))
      return committed
    })
  }

  async release(
    scopeValue: PearlInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<void> {
    const scope = parsePearlInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    await runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) return
      const existing = parseStoredPearlInputReservation(value, scope, transactionId).reservation
      if (existing.state === 'committed') {
        throw new Error('Committed Pearl inputs cannot be released')
      }
      store.delete(key)
    })
  }

  async retireCommitted(
    scopeValue: PearlInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<boolean> {
    const scope = parsePearlInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) return false
      const existing = parseStoredPearlInputReservation(value, scope, transactionId).reservation
      if (existing.state !== 'committed') {
        throw new Error('Only committed Pearl inputs can be retired')
      }
      store.delete(key)
      return true
    })
  }

  async deleteByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number> {
    const scope = parsePearlInputReservationAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const keys = await requestResult<IDBValidKey[]>(
        store.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(accountKey(scope)))
      )
      for (const key of keys) store.delete(key)
      return keys.length
    })
  }
}

export function deleteIndexedDbPearlInputReservations(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PEARL_INPUT_RESERVATION_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Pearl input deletion failed'))
    request.onblocked = () => reject(new Error('Pearl input deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
