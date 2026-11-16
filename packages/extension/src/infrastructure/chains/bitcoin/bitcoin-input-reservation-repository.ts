import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseTimestamp
} from './bitcoin-discovery-persistence-model'
import {
  BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION,
  bitcoinInputOutpointKey,
  bitcoinInputReservationKey,
  bitcoinInputReservationScopeKey,
  parseBitcoinInputOutpoints,
  parseBitcoinInputReservationAccountScope,
  parseBitcoinInputReservationScope,
  parseStoredBitcoinInputReservation,
  storedBitcoinInputReservation,
  type BitcoinInputReservation,
  type BitcoinInputReservationRepository,
  type BitcoinInputReservationScope,
  type CommitBitcoinInputsInput,
  type ReserveBitcoinInputsInput
} from './bitcoin-input-reservation-model'

export const BITCOIN_INPUT_RESERVATION_DATABASE = Object.freeze({
  name: 'noir-wallet-bitcoin-input-v1-db',
  version: 2
})

const RESERVATIONS_STORE = 'reservations'
const BY_ACCOUNT = 'byAccount'
const BY_SCOPE = 'byScope'
const BY_OUTPOINT = 'byOutpoint'
const MAXIMUM_RESERVATIONS_PER_SCOPE = 1_024
const MAXIMUM_RESERVATIONS_PER_ACCOUNT = 4_096

export interface IndexedDbBitcoinInputReservationRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin input request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Bitcoin input transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Bitcoin input transaction aborted'))
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, BITCOIN_INPUT_RESERVATION_DATABASE.version)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin input database open failed'))
    request.onblocked = () => reject(new Error('Bitcoin input database open is blocked'))
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
  left: BitcoinInputReservation['outpoints'],
  right: BitcoinInputReservation['outpoints']
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class IndexedDbBitcoinInputReservationRepository implements BitcoinInputReservationRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbBitcoinInputReservationRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? BITCOIN_INPUT_RESERVATION_DATABASE.name
    if (!this.databaseName || this.databaseName.length > 256) {
      throw new Error('Invalid Bitcoin input database name')
    }
  }

  async get(
    scopeValue: BitcoinInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<BitcoinInputReservation | null> {
    const scope = parseBitcoinInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const value = await requestResult<unknown>(
        store.get(bitcoinInputReservationKey(scope, transactionId))
      )
      return value === undefined
        ? null
        : parseStoredBitcoinInputReservation(value, scope, transactionId).reservation
    })
  }

  async reserve(input: ReserveBitcoinInputsInput): Promise<BitcoinInputReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        'chainAccount',
        'accountIndex',
        'addressType',
        'transactionId',
        'outpoints',
        'now'
      ])
    ) {
      throw new Error('Invalid Bitcoin input reservation request')
    }
    const scope = parseBitcoinInputReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const transactionId = parseTransactionId(input.transactionId)
    const outpoints = parseBitcoinInputOutpoints(input.outpoints)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinInputReservationKey(scope, transactionId)
      const existingValue = await requestResult<unknown>(store.get(key))
      if (existingValue !== undefined) {
        const existing = parseStoredBitcoinInputReservation(
          existingValue,
          scope,
          transactionId
        ).reservation
        if (!sameOutpoints(existing.outpoints, outpoints)) {
          throw new Error('Bitcoin transaction input reservation conflicts with persisted data')
        }
        return existing
      }

      const scopeReservations = await requestResult<IDBValidKey[]>(
        store
          .index(BY_SCOPE)
          .getAllKeys(
            IDBKeyRange.only(bitcoinInputReservationScopeKey(scope)),
            MAXIMUM_RESERVATIONS_PER_SCOPE + 1
          )
      )
      if (scopeReservations.length >= MAXIMUM_RESERVATIONS_PER_SCOPE) {
        throw new Error('Bitcoin input reservation capacity exceeded')
      }

      for (const outpoint of outpoints) {
        const conflict = await requestResult<unknown>(
          store.index(BY_OUTPOINT).get(bitcoinInputOutpointKey(scope, outpoint))
        )
        if (conflict !== undefined) {
          throw new Error('Bitcoin input is already reserved by another transaction')
        }
      }
      const reservation: BitcoinInputReservation = Object.freeze({
        schemaVersion: BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION,
        ...scope,
        transactionId,
        state: 'reserved',
        outpoints,
        createdAt: now,
        updatedAt: now
      })
      store.add(storedBitcoinInputReservation(reservation))
      return reservation
    })
  }

  async list(
    scopeValue: BitcoinInputReservationScope
  ): Promise<readonly BitcoinInputReservation[]> {
    const scope = parseBitcoinInputReservationScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store
          .index(BY_SCOPE)
          .getAll(
            IDBKeyRange.only(bitcoinInputReservationScopeKey(scope)),
            MAXIMUM_RESERVATIONS_PER_SCOPE + 1
          )
      )
      if (values.length > MAXIMUM_RESERVATIONS_PER_SCOPE) {
        throw new Error('Bitcoin input reservation capacity is corrupted')
      }
      return Object.freeze(
        values
          .map(value => parseStoredBitcoinInputReservation(value, scope).reservation)
          .sort((left, right) => left.transactionId.localeCompare(right.transactionId))
      )
    })
  }

  async listByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<readonly BitcoinInputReservation[]> {
    const scope = parseBitcoinInputReservationAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store
          .index(BY_ACCOUNT)
          .getAll(IDBKeyRange.only(accountKey(scope)), MAXIMUM_RESERVATIONS_PER_ACCOUNT + 1)
      )
      if (values.length > MAXIMUM_RESERVATIONS_PER_ACCOUNT) {
        throw new Error('Bitcoin Account input reservation capacity is corrupted')
      }
      return Object.freeze(
        values
          .map(value => parseStoredBitcoinInputReservation(value).reservation)
          .map(reservation => {
            if (
              reservation.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
              reservation.chainAccount.scope.accountId !== scope.accountId
            ) {
              throw new Error('Bitcoin input reservation Account index is corrupted')
            }
            return reservation
          })
          .sort((left, right) => left.transactionId.localeCompare(right.transactionId))
      )
    })
  }

  async commit(input: CommitBitcoinInputsInput): Promise<BitcoinInputReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, ['chainAccount', 'accountIndex', 'addressType', 'transactionId', 'now'])
    ) {
      throw new Error('Invalid Bitcoin input reservation commit')
    }
    const scope = parseBitcoinInputReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseTimestamp(input.now)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) throw new Error('Bitcoin input reservation is missing')
      const existing = parseStoredBitcoinInputReservation(value, scope, transactionId).reservation
      if (now < existing.updatedAt) {
        throw new Error('Bitcoin input reservation timestamp cannot move backwards')
      }
      if (existing.state === 'committed') return existing
      const committed = Object.freeze({ ...existing, state: 'committed' as const, updatedAt: now })
      store.put(storedBitcoinInputReservation(committed))
      return committed
    })
  }

  async release(
    scopeValue: BitcoinInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<void> {
    const scope = parseBitcoinInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    await runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) return
      const existing = parseStoredBitcoinInputReservation(value, scope, transactionId).reservation
      if (existing.state === 'committed') {
        throw new Error('Committed Bitcoin inputs cannot be released')
      }
      store.delete(key)
    })
  }

  async retireCommitted(
    scopeValue: BitcoinInputReservationScope,
    transactionIdValue: TransactionId
  ): Promise<boolean> {
    const scope = parseBitcoinInputReservationScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const key = bitcoinInputReservationKey(scope, transactionId)
      const value = await requestResult<unknown>(store.get(key))
      if (value === undefined) return false
      const existing = parseStoredBitcoinInputReservation(value, scope, transactionId).reservation
      if (existing.state !== 'committed') {
        throw new Error('Only committed Bitcoin inputs can be retired')
      }
      store.delete(key)
      return true
    })
  }

  async deleteByAccountScope(scopeValue: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number> {
    const scope = parseBitcoinInputReservationAccountScope(scopeValue)
    return runDatabase(this.databaseName, 'readwrite', async store => {
      const keys = await requestResult<IDBValidKey[]>(
        store.index(BY_ACCOUNT).getAllKeys(IDBKeyRange.only(accountKey(scope)))
      )
      for (const key of keys) store.delete(key)
      return keys.length
    })
  }
}

export function deleteIndexedDbBitcoinInputReservations(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BITCOIN_INPUT_RESERVATION_DATABASE.name)
    request.onerror = () => reject(request.error ?? new Error('Bitcoin input deletion failed'))
    request.onblocked = () => reject(new Error('Bitcoin input deletion is blocked'))
    request.onsuccess = () => resolve()
  })
}
