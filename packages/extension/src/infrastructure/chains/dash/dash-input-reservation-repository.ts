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
  dashInputOutpointKey,
  dashInputReservationKey,
  parseDashInputOutpoints,
  parseDashInputReservation,
  type CommitDashInputsInput,
  type DashInputReservation,
  type DashInputReservationRepository,
  type ReserveDashInputsInput
} from './dash-input-reservation-model'

const STORE = 'input-reservations'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Dash input reservation request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Dash input reservation transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Dash input reservation transaction aborted'))
  })
}

function storedRecord(reservation: DashInputReservation) {
  const scope = parseDashDiscoveryScope(reservation)
  return Object.freeze({
    schemaVersion: 1 as const,
    reservationKey: dashInputReservationKey(scope, reservation.transactionId),
    scopeKey: dashScopeKey(scope),
    accountKey: dashAccountKey(scope.chainAccount.scope),
    outpointKeys: reservation.outpoints.map(outpoint => dashInputOutpointKey(scope, outpoint)),
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

function reservationsFrom(
  values: readonly unknown[],
  scope: DashDiscoveryScope
): readonly DashInputReservation[] {
  return Object.freeze(
    values.map(value => {
      if (!isRecord(value)) throw new Error('Stored Dash input reservation is invalid')
      return parseDashInputReservation(value.reservation, scope)
    })
  )
}

export class IndexedDbDashInputReservationRepository implements DashInputReservationRepository {
  constructor(private readonly databaseName = DASH_DISCOVERY_DATABASE.name) {}

  list(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<readonly DashInputReservation[]> {
    const scope = parseDashDiscoveryScope(scopeValue)
    return withStore(this.databaseName, 'readonly', async store => {
      const values = await requestResult<unknown[]>(
        store.index('byScope').getAll(dashScopeKey(scope))
      )
      return reservationsFrom(values, scope)
    })
  }

  async reserve(input: ReserveDashInputsInput): Promise<DashInputReservation> {
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const outpoints = parseDashInputOutpoints(input.outpoints)
    const now = parseDashTimestamp(input.now)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const existingValues = await requestResult<unknown[]>(
        store.index('byScope').getAll(dashScopeKey(scope))
      )
      const existing = reservationsFrom(existingValues, scope)
      const same = existing.find(reservation => reservation.transactionId === transactionId)
      if (same) {
        if (same.state === 'committed')
          throw new Error('Committed Dash inputs cannot be reserved again')
        const sameOutpoints =
          same.outpoints.length === outpoints.length &&
          same.outpoints.every(
            (outpoint, index) =>
              outpoint.transactionId === outpoints[index]?.transactionId &&
              outpoint.outputIndex === outpoints[index]?.outputIndex
          )
        if (!sameOutpoints) throw new Error('Dash input reservation conflicts with itself')
        return same
      }
      const taken = new Set(
        existing.flatMap(reservation =>
          reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
        )
      )
      if (
        outpoints.some(outpoint => taken.has(`${outpoint.transactionId}:${outpoint.outputIndex}`))
      ) {
        throw new Error('Dash input is already reserved')
      }
      const reservation = Object.freeze({
        ...scope,
        transactionId,
        state: 'reserved' as const,
        outpoints,
        createdAt: now,
        updatedAt: now
      })
      transaction.objectStore(STORE).put(storedRecord(reservation))
      return reservation
    })
  }

  async commit(input: CommitDashInputsInput): Promise<DashInputReservation> {
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const now = parseDashTimestamp(input.now)
    return withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const key = dashInputReservationKey(scope, transactionId)
      const stored = await requestResult<unknown>(store.get(key))
      if (!isRecord(stored)) throw new Error('Dash input reservation is missing')
      const reservation = parseDashInputReservation(stored.reservation, scope)
      if (now < reservation.updatedAt)
        throw new Error('Dash input reservation timestamp moved backwards')
      const committed = Object.freeze({
        ...reservation,
        state: 'committed' as const,
        updatedAt: now
      })
      transaction.objectStore(STORE).put(storedRecord(committed))
      return committed
    })
  }

  async release(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>,
    transactionIdValue: TransactionId
  ): Promise<void> {
    const scope = parseDashDiscoveryScope(scopeValue)
    const transactionId = parseTransactionId(transactionIdValue)
    await withStore(this.databaseName, 'readwrite', async (store, transaction) => {
      const key = dashInputReservationKey(scope, transactionId)
      const stored = await requestResult<unknown>(store.get(key))
      if (stored === undefined) return
      if (!isRecord(stored)) throw new Error('Stored Dash input reservation is invalid')
      const reservation = parseDashInputReservation(stored.reservation, scope)
      if (reservation.state === 'committed')
        throw new Error('Committed Dash inputs cannot be released')
      transaction.objectStore(STORE).delete(key)
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
        if (
          !isRecord(value) ||
          value.accountKey !== accountKey ||
          typeof value.reservationKey !== 'string'
        ) {
          throw new Error('Stored Dash input reservation account index is invalid')
        }
        transaction.objectStore(STORE).delete(value.reservationKey)
      }
      return values.length
    })
  }
}

export class MemoryDashInputReservationRepository implements DashInputReservationRepository {
  private readonly reservations = new Map<string, DashInputReservation>()

  async list(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<readonly DashInputReservation[]> {
    const scope = parseDashDiscoveryScope(scopeValue)
    const key = dashScopeKey(scope)
    return Object.freeze(
      [...this.reservations.values()].filter(reservation => dashScopeKey(reservation) === key)
    )
  }

  async reserve(input: ReserveDashInputsInput): Promise<DashInputReservation> {
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const outpoints = parseDashInputOutpoints(input.outpoints)
    const now = parseDashTimestamp(input.now)
    const key = dashInputReservationKey(scope, transactionId)
    const existing = [...this.reservations.values()].filter(
      reservation => dashScopeKey(reservation) === dashScopeKey(scope)
    )
    const same = existing.find(reservation => reservation.transactionId === transactionId)
    if (same) {
      if (same.state === 'committed')
        throw new Error('Committed Dash inputs cannot be reserved again')
      return same
    }
    const taken = new Set(
      existing.flatMap(reservation =>
        reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
      )
    )
    if (
      outpoints.some(outpoint => taken.has(`${outpoint.transactionId}:${outpoint.outputIndex}`))
    ) {
      throw new Error('Dash input is already reserved')
    }
    const reservation = Object.freeze({
      ...scope,
      transactionId,
      state: 'reserved' as const,
      outpoints,
      createdAt: now,
      updatedAt: now
    })
    this.reservations.set(key, reservation)
    return reservation
  }

  async commit(input: CommitDashInputsInput): Promise<DashInputReservation> {
    const scope = parseDashDiscoveryScope(input)
    const key = dashInputReservationKey(scope, parseTransactionId(input.transactionId))
    const reservation = this.reservations.get(key)
    if (!reservation) throw new Error('Dash input reservation is missing')
    const committed = Object.freeze({
      ...reservation,
      state: 'committed' as const,
      updatedAt: parseDashTimestamp(input.now)
    })
    this.reservations.set(key, committed)
    return committed
  }

  async release(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>,
    transactionIdValue: TransactionId
  ): Promise<void> {
    const scope = parseDashDiscoveryScope(scopeValue)
    const key = dashInputReservationKey(scope, parseTransactionId(transactionIdValue))
    const reservation = this.reservations.get(key)
    if (reservation?.state === 'committed')
      throw new Error('Committed Dash inputs cannot be released')
    this.reservations.delete(key)
  }

  async deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number> {
    const accountKey = dashAccountKey(scope)
    let deleted = 0
    for (const [key, reservation] of this.reservations) {
      if (dashAccountKey(reservation.chainAccount.scope) !== accountKey) continue
      this.reservations.delete(key)
      deleted += 1
    }
    return deleted
  }
}
