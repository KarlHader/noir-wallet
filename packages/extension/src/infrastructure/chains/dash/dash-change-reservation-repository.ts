import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  dashAccountKey,
  dashScopeKey,
  DASH_DISCOVERY_DATABASE,
  isRecord,
  parseDashDiscoveryScope,
  parseDashTimestamp,
  type DashDiscoveryScope
} from './dash-discovery-model'
import { openDashDiscoveryDatabase } from './dash-discovery-repository'
import {
  dashChangeReservationKey,
  nextDashChangeIndex,
  parseDashChangeReservation,
  type AllocateDashChangeInput,
  type BindDashChangeAddressInput,
  type DashChangeReservation,
  type DashChangeReservationRepository,
  type TransitionDashChangeInput
} from './dash-change-reservation-model'

const STORE = 'change-reservations'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Dash change reservation request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Dash change reservation transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Dash change reservation transaction aborted'))
  })
}

function storedRecord(reservation: DashChangeReservation) {
  const scope = parseDashDiscoveryScope(reservation)
  return Object.freeze({
    schemaVersion: 1 as const,
    reservationKey: dashChangeReservationKey(scope, reservation.transactionId),
    scopeKey: dashScopeKey(scope),
    accountKey: dashAccountKey(scope.chainAccount.scope),
    reservation
  })
}

async function withStore<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const database = await openDashDiscoveryDatabase(databaseName)
  try {
    const transaction = database.transaction(STORE, mode)
    const result = await operation(transaction.objectStore(STORE), transaction)
    await transactionDone(transaction)
    return result
  } finally {
    database.close()
  }
}

function readReservations(
  values: readonly unknown[],
  scope: DashDiscoveryScope
): readonly DashChangeReservation[] {
  return Object.freeze(
    values.map(value => {
      if (!isRecord(value)) throw new Error('Stored Dash change reservation is invalid')
      return parseDashChangeReservation(value.reservation, scope)
    })
  )
}

export class IndexedDbDashChangeReservationRepository implements DashChangeReservationRepository {
  constructor(private readonly databaseName = DASH_DISCOVERY_DATABASE.name) {}

  async get(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>,
    transactionIdValue: TransactionId
  ): Promise<DashChangeReservation | null> {
    const scope = parseDashDiscoveryScope(scopeValue)
    if (scope.imported) throw new Error('Imported Dash keys have no change address')
    const transactionId = parseTransactionId(transactionIdValue)
    return withStore(this.databaseName, 'readonly', async store => {
      const stored = await requestResult<unknown>(
        store.get(dashChangeReservationKey(scope, transactionId))
      )
      if (stored === undefined) return null
      if (!isRecord(stored)) throw new Error('Stored Dash change reservation is invalid')
      return parseDashChangeReservation(stored.reservation, scope)
    })
  }

  list(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<readonly DashChangeReservation[]> {
    const scope = parseDashDiscoveryScope(scopeValue)
    if (scope.imported) return Promise.resolve(Object.freeze([]))
    return withStore(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store.index('byScope').getAll(dashScopeKey(scope))
      )
      return readReservations(values, scope)
    })
  }

  async allocate(input: AllocateDashChangeInput): Promise<DashChangeReservation> {
    const scope = parseDashDiscoveryScope(input)
    if (scope.imported) throw new Error('Imported Dash keys have no change address')
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseDashTimestamp(input.now)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const values = await requestResult<unknown[]>(
        store.index('byScope').getAll(dashScopeKey(scope))
      )
      const existing = readReservations(values, scope)
      const same = existing.find(reservation => reservation.transactionId === transactionId)
      if (same && same.state !== 'abandoned') return same
      const reservation = Object.freeze({
        ...scope,
        transactionId,
        state: 'allocating' as const,
        addressIndex: nextDashChangeIndex(existing, input.minimumAddressIndex, now),
        address: null,
        createdAt: now,
        updatedAt: now
      })
      transaction.objectStore(STORE).put(storedRecord(reservation))
      return reservation
    })
  }

  async bindAddress(input: BindDashChangeAddressInput): Promise<DashChangeReservation> {
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseDashTimestamp(input.now)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const stored = await requestResult<unknown>(
        store.get(dashChangeReservationKey(scope, transactionId))
      )
      if (!isRecord(stored)) throw new Error('Dash change reservation is missing')
      const current = parseDashChangeReservation(stored.reservation, scope)
      if (current.state !== 'allocating' && current.state !== 'reserved') {
        throw new Error('Dash change reservation cannot bind an address')
      }
      if (input.address.addressIndex !== current.addressIndex || input.address.change !== true) {
        throw new Error('Dash change address does not match the reservation')
      }
      const reservation = parseDashChangeReservation(
        { ...current, state: 'reserved', address: input.address, updatedAt: now },
        scope
      )
      transaction.objectStore(STORE).put(storedRecord(reservation))
      return reservation
    })
  }

  async transition(input: TransitionDashChangeInput): Promise<DashChangeReservation> {
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseDashTimestamp(input.now)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const stored = await requestResult<unknown>(
        store.get(dashChangeReservationKey(scope, transactionId))
      )
      if (!isRecord(stored)) throw new Error('Dash change reservation is missing')
      const current = parseDashChangeReservation(stored.reservation, scope)
      if (
        current.state === 'abandoned' ||
        (input.state === 'committed' && current.address === null)
      ) {
        throw new Error('Dash change reservation cannot change state')
      }
      const reservation = parseDashChangeReservation(
        { ...current, state: input.state, updatedAt: now },
        scope
      )
      transaction.objectStore(STORE).put(storedRecord(reservation))
      return reservation
    })
  }

  async deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number> {
    const accountKey = dashAccountKey(scope)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const values = await requestResult<unknown[]>(store.index('byAccount').getAll(accountKey))
      for (const value of values) {
        if (!isRecord(value) || typeof value.reservationKey !== 'string') {
          throw new Error('Stored Dash change reservation account index is invalid')
        }
        transaction.objectStore(STORE).delete(value.reservationKey)
      }
      return values.length
    })
  }
}
