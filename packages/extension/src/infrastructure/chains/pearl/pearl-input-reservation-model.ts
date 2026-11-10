import type { AccountId, AccountIndex, ChainAccount } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseTimestamp
} from './pearl-discovery-persistence-model'
import { parsePearlChangeReservationScope } from './pearl-change-reservation-model'
import { PEARL_MAXIMUM_SELECTION_UTXOS } from './pearl-transaction-model'

export const PEARL_INPUT_RESERVATION_SCHEMA_VERSION = 1 as const
export const PEARL_INPUT_RESERVATION_STATES = Object.freeze(['reserved', 'committed'] as const)

export type PearlInputReservationState = (typeof PEARL_INPUT_RESERVATION_STATES)[number]

export interface PearlInputOutpoint {
  readonly transactionId: string
  readonly outputIndex: number
}

export interface PearlInputReservationScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly addressScheme: 'pearl_p2tr'
}

export interface PearlInputReservation extends PearlInputReservationScope {
  readonly schemaVersion: typeof PEARL_INPUT_RESERVATION_SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly state: PearlInputReservationState
  readonly outpoints: readonly PearlInputOutpoint[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReservePearlInputsInput extends PearlInputReservationScope {
  readonly transactionId: TransactionId
  readonly outpoints: readonly PearlInputOutpoint[]
  readonly now: number
}

export interface CommitPearlInputsInput extends PearlInputReservationScope {
  readonly transactionId: TransactionId
  readonly now: number
}

export interface StoredPearlInputReservation {
  readonly schemaVersion: 1
  readonly reservationKey: string
  readonly accountKey: string
  readonly scopeKey: string
  readonly outpointKeys: readonly string[]
  readonly reservation: PearlInputReservation
}

export interface PearlInputReservationRepository {
  get(
    scope: PearlInputReservationScope,
    transactionId: TransactionId
  ): Promise<PearlInputReservation | null>
  list(scope: PearlInputReservationScope): Promise<readonly PearlInputReservation[]>
  listByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<readonly PearlInputReservation[]>
  reserve(input: ReservePearlInputsInput): Promise<PearlInputReservation>
  commit(input: CommitPearlInputsInput): Promise<PearlInputReservation>
  release(scope: PearlInputReservationScope, transactionId: TransactionId): Promise<void>
  retireCommitted(scope: PearlInputReservationScope, transactionId: TransactionId): Promise<boolean>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

function parseOutputIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error('Invalid Pearl input output index')
  }
  return value as number
}

function compareOutpoints(left: PearlInputOutpoint, right: PearlInputOutpoint): number {
  const transactionOrder = left.transactionId.localeCompare(right.transactionId)
  return transactionOrder === 0 ? left.outputIndex - right.outputIndex : transactionOrder
}

export function parsePearlInputOutpoints(value: unknown): readonly PearlInputOutpoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PEARL_MAXIMUM_SELECTION_UTXOS) {
    throw new Error('Invalid Pearl input outpoints')
  }
  const seen = new Set<string>()
  const outpoints = value.map(candidate => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['transactionId', 'outputIndex']) ||
      typeof candidate.transactionId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate.transactionId)
    ) {
      throw new Error('Invalid Pearl input outpoint')
    }
    const outputIndex = parseOutputIndex(candidate.outputIndex)
    const key = `${candidate.transactionId}:${outputIndex}`
    if (seen.has(key)) throw new Error('Duplicate Pearl input outpoint')
    seen.add(key)
    return Object.freeze({ transactionId: candidate.transactionId, outputIndex })
  })
  return Object.freeze(outpoints.sort(compareOutpoints))
}

export function parsePearlInputReservationScope(value: unknown): PearlInputReservationScope {
  return parsePearlChangeReservationScope(value)
}

export function pearlInputReservationScopeKey(scopeValue: PearlInputReservationScope): string {
  const scope = parsePearlInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressScheme: scopeValue.addressScheme
  })
  return JSON.stringify([scope.chainAccount.id, scope.addressScheme])
}

export function pearlInputReservationKey(
  scopeValue: PearlInputReservationScope,
  transactionIdValue: TransactionId
): string {
  const scope = parsePearlInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressScheme: scopeValue.addressScheme
  })
  return JSON.stringify([scope.chainAccount.id, parseTransactionId(transactionIdValue)])
}

export function pearlInputOutpointKey(
  scopeValue: PearlInputReservationScope,
  outpointValue: PearlInputOutpoint
): string {
  const scope = parsePearlInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressScheme: scopeValue.addressScheme
  })
  const outpoint = parsePearlInputOutpoints([outpointValue])[0]
  return JSON.stringify([scope.chainAccount.id, outpoint.transactionId, outpoint.outputIndex])
}

function sameScope(left: PearlInputReservationScope, right: PearlInputReservationScope): boolean {
  return pearlInputReservationScopeKey(left) === pearlInputReservationScopeKey(right)
}

export function parsePearlInputReservation(
  value: unknown,
  expectedScope?: PearlInputReservationScope,
  expectedTransactionId?: TransactionId
): PearlInputReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainAccount',
      'accountIndex',
      'addressScheme',
      'transactionId',
      'state',
      'outpoints',
      'createdAt',
      'updatedAt'
    ]) ||
    value.schemaVersion !== PEARL_INPUT_RESERVATION_SCHEMA_VERSION ||
    !(PEARL_INPUT_RESERVATION_STATES as readonly unknown[]).includes(value.state)
  ) {
    throw new Error('Invalid Pearl input reservation')
  }
  const scope = parsePearlInputReservationScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex,
    addressScheme: value.addressScheme
  })
  const transactionId = parseTransactionId(value.transactionId)
  const outpoints = parsePearlInputOutpoints(value.outpoints)
  const createdAt = parseTimestamp(value.createdAt)
  const updatedAt = parseTimestamp(value.updatedAt)
  if (
    updatedAt < createdAt ||
    (expectedScope !== undefined && !sameScope(scope, expectedScope)) ||
    (expectedTransactionId !== undefined && transactionId !== expectedTransactionId)
  ) {
    throw new Error('Inconsistent Pearl input reservation')
  }
  return Object.freeze({
    schemaVersion: PEARL_INPUT_RESERVATION_SCHEMA_VERSION,
    ...scope,
    transactionId,
    state: value.state as PearlInputReservationState,
    outpoints,
    createdAt,
    updatedAt
  })
}

export function storedPearlInputReservation(
  reservationValue: PearlInputReservation
): StoredPearlInputReservation {
  const reservation = parsePearlInputReservation(reservationValue)
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: pearlInputReservationKey(reservation, reservation.transactionId),
    accountKey: accountKey(reservation.chainAccount.scope),
    scopeKey: pearlInputReservationScopeKey(reservation),
    outpointKeys: Object.freeze(
      reservation.outpoints.map(outpoint => pearlInputOutpointKey(reservation, outpoint))
    ),
    reservation
  })
}

export function parseStoredPearlInputReservation(
  value: unknown,
  expectedScope?: PearlInputReservationScope,
  expectedTransactionId?: TransactionId
): StoredPearlInputReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'reservationKey',
      'accountKey',
      'scopeKey',
      'outpointKeys',
      'reservation'
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw new Error('Invalid stored Pearl input reservation')
  }
  const reservation = parsePearlInputReservation(
    value.reservation,
    expectedScope,
    expectedTransactionId
  )
  const expected = storedPearlInputReservation(reservation)
  if (
    value.reservationKey !== expected.reservationKey ||
    value.accountKey !== expected.accountKey ||
    value.scopeKey !== expected.scopeKey ||
    JSON.stringify(value.outpointKeys) !== JSON.stringify(expected.outpointKeys)
  ) {
    throw new Error('Stored Pearl input reservation keys do not match')
  }
  return expected
}

export function parsePearlInputReservationAccountScope(value: unknown): {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
} {
  return parseAccountScope(value)
}
