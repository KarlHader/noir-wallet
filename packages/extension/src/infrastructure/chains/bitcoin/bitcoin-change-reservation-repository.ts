import type { AccountId } from '@/core/accounts/domain'
import { BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET } from '@/core/chains/bitcoin'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseTimestamp
} from './bitcoin-discovery-persistence-model'
import {
  BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION,
  bitcoinChangeReservationKey,
  bitcoinChangeScopeKey,
  parseBitcoinChangeAccountScope,
  parseBitcoinChangeReservationScope,
  parseMinimumBitcoinChangeAddressIndex,
  parseStoredBitcoinChangeReservation,
  type AllocateBitcoinChangeInput,
  type BindBitcoinChangeAddressInput,
  type BitcoinChangeReservation,
  type BitcoinChangeReservationRepository,
  type BitcoinChangeReservationScope,
  type StoredBitcoinChangeReservation,
  type TransitionBitcoinChangeInput
} from './bitcoin-change-reservation-model'

export const BITCOIN_CHANGE_RESERVATION_DATABASE = Object.freeze({
  name: 'noir-wallet-bitcoin-change-v1-db',
  version: 1
})

const RESERVATIONS_STORE = 'reservations'
const BY_ACCOUNT = 'byAccount'
const BY_SCOPE = 'byScope'

export interface IndexedDbBitcoinChangeReservationRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin change request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Bitcoin change transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Bitcoin change transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, BITCOIN_CHANGE_RESERVATION_DATABASE.version)
    request.onerror = () =>
      reject(request.error ?? new Error('Bitcoin change database open failed'))
    request.onblocked = () => reject(new Error('Bitcoin change database open is blocked'))
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

function storedReservation(reservation: BitcoinChangeReservation): StoredBitcoinChangeReservation {
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: bitcoinChangeReservationKey(reservation, reservation.transactionId),
    accountKey: accountKey(reservation.chainAccount.scope),
    scopeKey: bitcoinChangeScopeKey(reservation),
    reservation
  })
}

function assertTimestampAdvance(current: BitcoinChangeReservation, next: number): void {
  if (next < current.updatedAt) {
    throw new Error('Bitcoin change reservation timestamp cannot move backwards')
  }
}

export class IndexedDbBitcoinChangeReservationRepository implements BitcoinChangeReservationRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbBitcoinChangeReservationRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? BITCOIN_CHANGE_RESERVATION_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Bitcoin change database name')
    }
  }

  async get(
    scopeValue: BitcoinChangeReservationScope,
    transactionIdValue: TransactionId
  ): Promise<BitcoinChangeReservation | null> {
    const scope = parseBitcoinChangeReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const value = await requestResult<unknown>(
        store.get(bitcoinChangeReservationKey(scope, transactionId))
      )
      return value === undefined
        ? null
        : parseStoredBitcoinChangeReservation(value, scope, transactionId).reservation
    })
  }

  async allocate(input: AllocateBitcoinChangeInput): Promise<BitcoinChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressType',
        'transactionId',
        'minimumAddressIndex',
        'now'
      ])
    ) {
      throw new Error('Invalid Bitcoin change allocation input')
    }
    const scope = parseBitcoinChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const transactionId = parseTransactionId(input.transactionId)
    const minimumAddressIndex = parseMinimumBitcoinChangeAddressIndex(input.minimumAddressIndex)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue !== undefined) {
        const existing = parseStoredBitcoinChangeReservation(
          existingValue,
          scope,
          transactionId
        ).reservation
        if (existing.state === 'abandoned') {
          throw new Error('Abandoned Bitcoin change reservation cannot resume')
        }
        return existing
      }
      const values = await requestResult<unknown[]>(
        store
          .index(BY_SCOPE)
          .getAll(
            IDBKeyRange.only(bitcoinChangeScopeKey(scope)),
            BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET + 1
          )
      )
      if (values.length > BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET) {
        throw new Error('Bitcoin change reservation capacity exceeded')
      }
      let addressIndex = minimumAddressIndex
      for (const value of values) {
        const reservation = parseStoredBitcoinChangeReservation(value, scope).reservation
        addressIndex = Math.max(addressIndex, reservation.addressIndex + 1)
      }
      if (addressIndex >= BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET) {
        throw new Error('Bitcoin change reservation capacity exceeded')
      }
      const reservation: BitcoinChangeReservation = Object.freeze({
        schemaVersion: BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION,
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

  async bindAddress(input: BindBitcoinChangeAddressInput): Promise<BitcoinChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressType',
        'transactionId',
        'address',
        'now'
      ])
    ) {
      throw new Error('Invalid Bitcoin change address binding input')
    }
    const scope = parseBitcoinChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue === undefined) throw new Error('Bitcoin change reservation is missing')
      const existing = parseStoredBitcoinChangeReservation(
        existingValue,
        scope,
        transactionId
      ).reservation
      assertTimestampAdvance(existing, now)
      if (existing.state === 'abandoned') {
        throw new Error('Abandoned Bitcoin change reservation cannot bind an address')
      }
      const candidate = Object.freeze({
        ...existing,
        state: existing.state === 'allocating' ? ('reserved' as const) : existing.state,
        address: input.address,
        updatedAt: now
      })
      const parsed = parseStoredBitcoinChangeReservation(
        storedReservation(candidate),
        scope,
        transactionId
      ).reservation
      if (
        existing.address !== null &&
        JSON.stringify(existing.address) !== JSON.stringify(parsed.address)
      ) {
        throw new Error('Bitcoin change reservation address conflicts with persisted data')
      }
      if (existing.address !== null) return existing
      store.put(storedReservation(parsed))
      return parsed
    })
  }

  async transition(input: TransitionBitcoinChangeInput): Promise<BitcoinChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressType',
        'transactionId',
        'state',
        'now'
      ])
    ) {
      throw new Error('Invalid Bitcoin change reservation transition input')
    }
    const scope = parseBitcoinChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    if (input.state !== 'committed' && input.state !== 'abandoned') {
      throw new Error('Invalid Bitcoin change reservation transition')
    }
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinChangeReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue === undefined) throw new Error('Bitcoin change reservation is missing')
      const existing = parseStoredBitcoinChangeReservation(
        existingValue,
        scope,
        transactionId
      ).reservation
      assertTimestampAdvance(existing, now)
      if (existing.state === input.state) return existing
      if (
        (input.state === 'committed' && existing.state !== 'reserved') ||
        (input.state === 'abandoned' &&
          existing.state !== 'allocating' &&
          existing.state !== 'reserved')
      ) {
        throw new Error('Invalid Bitcoin change reservation transition')
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
    const scope = parseBitcoinChangeAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const keys = await requestResult<IDBValidKey[]>(
        store.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(accountKey(scope)))
      )
      for (const key of keys) store.delete(key)
      return keys.length
    })
  }
}

export function deleteIndexedDbBitcoinChangeReservations(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BITCOIN_CHANGE_RESERVATION_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin change deletion failed'))
    request.onblocked = () => reject(new Error('Bitcoin change deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
