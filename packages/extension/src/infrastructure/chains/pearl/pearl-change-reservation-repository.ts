import type { AccountId } from '@/core/accounts/domain'
import { PEARL_MAXIMUM_ADDRESSES_PER_TARGET } from '@/core/chains/pearl'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseTimestamp
} from './pearl-discovery-persistence-model'
import {
  PEARL_CHANGE_RESERVATION_SCHEMA_VERSION,
  pearlChangeReservationKey,
  pearlChangeScopeKey,
  parsePearlChangeAccountScope,
  parsePearlChangeReservationScope,
  parseMinimumPearlChangeAddressIndex,
  parseStoredPearlChangeReservation,
  type AllocatePearlChangeInput,
  type BindPearlChangeAddressInput,
  type PearlChangeReservation,
  type PearlChangeReservationRepository,
  type PearlChangeReservationScope,
  type StoredPearlChangeReservation,
  type TransitionPearlChangeInput
} from './pearl-change-reservation-model'

export const PEARL_CHANGE_RESERVATION_DATABASE = Object.freeze({
  name: 'noir-wallet-pearl-change-v1-db',
  version: 1
})

const RESERVATIONS_STORE = 'reservations'
const BY_ACCOUNT = 'byAccount'
const BY_SCOPE = 'byScope'

export interface IndexedDbPearlChangeReservationRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Pearl change request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Pearl change transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Pearl change transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, PEARL_CHANGE_RESERVATION_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Pearl change database open failed'))
    request.onblocked = () => reject(new Error('Pearl change database open is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(RESERVATIONS_STORE)) {
        const reservations = database.createObjectStore(RESERVATIONS_STORE, {
          keyPath: 'reservationKey'
        })
        reservations.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        reservations.createIndex(BY_SCOPE, 'scopeKey', { unique: false })
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

function storedReservation(reservation: PearlChangeReservation): StoredPearlChangeReservation {
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: pearlChangeReservationKey(reservation, reservation.transactionId),
    accountKey: accountKey(reservation.chainAccount.scope),
    scopeKey: pearlChangeScopeKey(reservation),
    reservation
  })
}

function assertTimestampAdvance(current: PearlChangeReservation, next: number): void {
  if (next < current.updatedAt) {
    throw new Error('Pearl change reservation timestamp cannot move backwards')
  }
}

export class IndexedDbPearlChangeReservationRepository implements PearlChangeReservationRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbPearlChangeReservationRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PEARL_CHANGE_RESERVATION_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Pearl change database name')
    }
  }

  async get(
    scopeValue: PearlChangeReservationScope,
    transactionIdValue: TransactionId
  ): Promise<PearlChangeReservation | null> {
    const scope = parsePearlChangeReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const value = await requestResult<unknown>(
        store.get(pearlChangeReservationKey(scope, transactionId))
      )
      return value === undefined ? null : parseStoredPearlChangeReservation(value).reservation
    })
  }

  async allocate(input: AllocatePearlChangeInput): Promise<PearlChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressScheme',
        'transactionId',
        'minimumAddressIndex',
        'now'
      ])
    ) {
      throw new Error('Invalid Pearl change allocation input')
    }
    const scope = parsePearlChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const transactionId = parseTransactionId(input.transactionId)
    const minimumAddressIndex = parseMinimumPearlChangeAddressIndex(input.minimumAddressIndex)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue !== undefined) {
        const existing = parseStoredPearlChangeReservation(existingValue).reservation
        if (existing.state === 'abandoned') {
          throw new Error('Abandoned Pearl change reservation cannot resume')
        }
        return existing
      }
      const values = await requestResult<unknown[]>(
        store
          .index(BY_SCOPE)
          .getAll(
            IDBKeyRange.only(pearlChangeScopeKey(scope)),
            PEARL_MAXIMUM_ADDRESSES_PER_TARGET + 1
          )
      )
      if (values.length > PEARL_MAXIMUM_ADDRESSES_PER_TARGET) {
        throw new Error('Pearl change reservation capacity exceeded')
      }
      let addressIndex = minimumAddressIndex
      for (const value of values) {
        const reservation = parseStoredPearlChangeReservation(value).reservation
        addressIndex = Math.max(addressIndex, reservation.addressIndex + 1)
      }
      if (addressIndex >= PEARL_MAXIMUM_ADDRESSES_PER_TARGET) {
        throw new Error('Pearl change reservation capacity exceeded')
      }
      const reservation: PearlChangeReservation = Object.freeze({
        schemaVersion: PEARL_CHANGE_RESERVATION_SCHEMA_VERSION,
        ...scope,
        transactionId,
        state: 'allocating',
        addressIndex,
        address: null,
        createdAt: now,
        updatedAt: now
      })
      store.add(storedReservation(reservation))
      return reservation
    })
  }

  async bindAddress(input: BindPearlChangeAddressInput): Promise<PearlChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressScheme',
        'transactionId',
        'address',
        'now'
      ])
    ) {
      throw new Error('Invalid Pearl change address binding input')
    }
    const scope = parsePearlChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue === undefined) throw new Error('Pearl change reservation is missing')
      const existing = parseStoredPearlChangeReservation(existingValue).reservation
      assertTimestampAdvance(existing, now)
      if (existing.state === 'abandoned') {
        throw new Error('Abandoned Pearl change reservation cannot bind an address')
      }
      const candidate = Object.freeze({
        ...existing,
        state: existing.state === 'allocating' ? ('reserved' as const) : existing.state,
        address: input.address,
        updatedAt: now
      })
      const parsed = parseStoredPearlChangeReservation(storedReservation(candidate)).reservation
      if (
        existing.address !== null &&
        JSON.stringify(existing.address) !== JSON.stringify(parsed.address)
      ) {
        throw new Error('Pearl change reservation address conflicts with persisted data')
      }
      if (existing.address !== null) return existing
      store.put(storedReservation(parsed))
      return parsed
    })
  }

  async transition(input: TransitionPearlChangeInput): Promise<PearlChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressScheme',
        'transactionId',
        'state',
        'now'
      ])
    ) {
      throw new Error('Invalid Pearl change reservation transition input')
    }
    const scope = parsePearlChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    if (input.state !== 'committed' && input.state !== 'abandoned') {
      throw new Error('Invalid Pearl change reservation transition')
    }
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = pearlChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue === undefined) throw new Error('Pearl change reservation is missing')
      const existing = parseStoredPearlChangeReservation(existingValue).reservation
      assertTimestampAdvance(existing, now)
      if (existing.state === input.state) return existing
      if (
        (input.state === 'committed' && existing.state !== 'reserved') ||
        (input.state === 'abandoned' &&
          existing.state !== 'allocating' &&
          existing.state !== 'reserved')
      ) {
        throw new Error('Invalid Pearl change reservation transition')
      }
      const next = Object.freeze({ ...existing, state: input.state, updatedAt: now })
      store.put(storedReservation(next))
      return next
    })
  }

  async deleteByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number> {
    const scope = parsePearlChangeAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const keys = await requestResult<IDBValidKey[]>(
        store.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(accountKey(scope)))
      )
      for (const key of keys) store.delete(key)
      return keys.length
    })
  }
}

export function deleteIndexedDbPearlChangeReservations(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PEARL_CHANGE_RESERVATION_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Pearl change deletion failed'))
    request.onblocked = () => reject(new Error('Pearl change deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
