import type { AccountId, AccountIndex, ChainAccount } from '@/core/accounts/domain'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseTimestamp
} from './bitcoin-discovery-persistence-model'
import { parseBitcoinChangeReservationScope } from './bitcoin-change-reservation-model'
import { BITCOIN_MAXIMUM_SELECTION_UTXOS } from './bitcoin-transaction-model'

export const BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION = 1 as const
export const BITCOIN_INPUT_RESERVATION_STATES = Object.freeze(['reserved', 'committed'] as const)

export type BitcoinInputReservationState = (typeof BITCOIN_INPUT_RESERVATION_STATES)[number]

export interface BitcoinInputOutpoint {
  readonly transactionId: string
  readonly outputIndex: number
}

export interface BitcoinInputReservationScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly addressType: BitcoinSupportedAddressType
}

export interface BitcoinInputReservation extends BitcoinInputReservationScope {
  readonly schemaVersion: typeof BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly state: BitcoinInputReservationState
  readonly outpoints: readonly BitcoinInputOutpoint[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReserveBitcoinInputsInput extends BitcoinInputReservationScope {
  readonly transactionId: TransactionId
  readonly outpoints: readonly BitcoinInputOutpoint[]
  readonly now: number
}

export interface CommitBitcoinInputsInput extends BitcoinInputReservationScope {
  readonly transactionId: TransactionId
  readonly now: number
}

export interface StoredBitcoinInputReservation {
  readonly schemaVersion: 1
  readonly reservationKey: string
  readonly accountKey: string
  readonly scopeKey: string
  readonly outpointKeys: readonly string[]
  readonly reservation: BitcoinInputReservation
}

export interface BitcoinInputReservationRepository {
  get(
    scope: BitcoinInputReservationScope,
    transactionId: TransactionId
  ): Promise<BitcoinInputReservation | null>
  list(scope: BitcoinInputReservationScope): Promise<readonly BitcoinInputReservation[]>
  listByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<readonly BitcoinInputReservation[]>
  reserve(input: ReserveBitcoinInputsInput): Promise<BitcoinInputReservation>
  commit(input: CommitBitcoinInputsInput): Promise<BitcoinInputReservation>
  release(scope: BitcoinInputReservationScope, transactionId: TransactionId): Promise<void>
  retireCommitted(
    scope: BitcoinInputReservationScope,
    transactionId: TransactionId
  ): Promise<boolean>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

function parseOutputIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error('Invalid Bitcoin input output index')
  }
  return value as number
}

function compareOutpoints(left: BitcoinInputOutpoint, right: BitcoinInputOutpoint): number {
  const transactionOrder = left.transactionId.localeCompare(right.transactionId)
  return transactionOrder === 0 ? left.outputIndex - right.outputIndex : transactionOrder
}

export function parseBitcoinInputOutpoints(value: unknown): readonly BitcoinInputOutpoint[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > BITCOIN_MAXIMUM_SELECTION_UTXOS
  ) {
    throw new Error('Invalid Bitcoin input outpoints')
  }
  const seen = new Set<string>()
  const outpoints = value.map(candidate => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['transactionId', 'outputIndex']) ||
      typeof candidate.transactionId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate.transactionId)
    ) {
      throw new Error('Invalid Bitcoin input outpoint')
    }
    const outputIndex = parseOutputIndex(candidate.outputIndex)
    const key = `${candidate.transactionId}:${outputIndex}`
    if (seen.has(key)) throw new Error('Duplicate Bitcoin input outpoint')
    seen.add(key)
    return Object.freeze({ transactionId: candidate.transactionId, outputIndex })
  })
  return Object.freeze(outpoints.sort(compareOutpoints))
}

export function parseBitcoinInputReservationScope(value: unknown): BitcoinInputReservationScope {
  return parseBitcoinChangeReservationScope(value)
}

export function bitcoinInputReservationScopeKey(scopeValue: BitcoinInputReservationScope): string {
  const scope = parseBitcoinInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressType: scopeValue.addressType
  })
  return JSON.stringify([scope.chainAccount.id, scope.addressType])
}

export function bitcoinInputReservationKey(
  scopeValue: BitcoinInputReservationScope,
  transactionIdValue: TransactionId
): string {
  const scope = parseBitcoinInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressType: scopeValue.addressType
  })
  return JSON.stringify([scope.chainAccount.id, parseTransactionId(transactionIdValue)])
}

export function bitcoinInputOutpointKey(
  scopeValue: BitcoinInputReservationScope,
  outpointValue: BitcoinInputOutpoint
): string {
  const scope = parseBitcoinInputReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressType: scopeValue.addressType
  })
  const outpoint = parseBitcoinInputOutpoints([outpointValue])[0]
  return JSON.stringify([scope.chainAccount.id, outpoint.transactionId, outpoint.outputIndex])
}

function sameScope(
  left: BitcoinInputReservationScope,
  right: BitcoinInputReservationScope
): boolean {
  return bitcoinInputReservationScopeKey(left) === bitcoinInputReservationScopeKey(right)
}

export function parseBitcoinInputReservation(
  value: unknown,
  expectedScope?: BitcoinInputReservationScope,
  expectedTransactionId?: TransactionId
): BitcoinInputReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainAccount',
      'accountIndex',
      'addressType',
      'transactionId',
      'state',
      'outpoints',
      'createdAt',
      'updatedAt'
    ]) ||
    value.schemaVersion !== BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION ||
    !(BITCOIN_INPUT_RESERVATION_STATES as readonly unknown[]).includes(value.state)
  ) {
    throw new Error('Invalid Bitcoin input reservation')
  }
  const scope = parseBitcoinInputReservationScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex,
    addressType: value.addressType
  })
  const transactionId = parseTransactionId(value.transactionId)
  const outpoints = parseBitcoinInputOutpoints(value.outpoints)
  const createdAt = parseTimestamp(value.createdAt)
  const updatedAt = parseTimestamp(value.updatedAt)
  if (
    updatedAt < createdAt ||
    (expectedScope !== undefined && !sameScope(scope, expectedScope)) ||
    (expectedTransactionId !== undefined && transactionId !== expectedTransactionId)
  ) {
    throw new Error('Inconsistent Bitcoin input reservation')
  }
  return Object.freeze({
    schemaVersion: BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION,
    ...scope,
    transactionId,
    state: value.state as BitcoinInputReservationState,
    outpoints,
    createdAt,
    updatedAt
  })
}

export function storedBitcoinInputReservation(
  reservationValue: BitcoinInputReservation
): StoredBitcoinInputReservation {
  const reservation = parseBitcoinInputReservation(reservationValue)
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: bitcoinInputReservationKey(reservation, reservation.transactionId),
    accountKey: accountKey(reservation.chainAccount.scope),
    scopeKey: bitcoinInputReservationScopeKey(reservation),
    outpointKeys: Object.freeze(
      reservation.outpoints.map(outpoint => bitcoinInputOutpointKey(reservation, outpoint))
    ),
    reservation
  })
}

export function parseStoredBitcoinInputReservation(
  value: unknown,
  expectedScope?: BitcoinInputReservationScope,
  expectedTransactionId?: TransactionId
): StoredBitcoinInputReservation {
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
    throw new Error('Invalid stored Bitcoin input reservation')
  }
  const reservation = parseBitcoinInputReservation(
    value.reservation,
    expectedScope,
    expectedTransactionId
  )
  const expected = storedBitcoinInputReservation(reservation)
  if (
    value.reservationKey !== expected.reservationKey ||
    value.accountKey !== expected.accountKey ||
    value.scopeKey !== expected.scopeKey ||
    JSON.stringify(value.outpointKeys) !== JSON.stringify(expected.outpointKeys)
  ) {
    throw new Error('Stored Bitcoin input reservation keys do not match')
  }
  return expected
}

export function parseBitcoinInputReservationAccountScope(value: unknown): {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
} {
  return parseAccountScope(value)
}
