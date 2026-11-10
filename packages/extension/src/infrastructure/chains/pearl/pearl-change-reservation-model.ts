import type { AccountId, AccountIndex, ChainAccount } from '@/core/accounts/domain'
import {
  PEARL_MAXIMUM_ADDRESSES_PER_TARGET,
  parseSupportedPearlAddress,
  type DerivedPearlAddress
} from '@/core/chains/pearl'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseScope,
  parseTimestamp
} from './pearl-discovery-persistence-model'

export const PEARL_CHANGE_RESERVATION_SCHEMA_VERSION = 1 as const
export const PEARL_CHANGE_RESERVATION_STATES = Object.freeze([
  'allocating',
  'reserved',
  'committed',
  'abandoned'
] as const)

export type PearlChangeReservationState = (typeof PEARL_CHANGE_RESERVATION_STATES)[number]

export interface PearlChangeReservationScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly addressScheme: 'pearl_p2tr'
}

export interface PearlChangeReservation extends PearlChangeReservationScope {
  readonly schemaVersion: typeof PEARL_CHANGE_RESERVATION_SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly state: PearlChangeReservationState
  readonly addressIndex: number
  readonly address: DerivedPearlAddress | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AllocatePearlChangeInput extends PearlChangeReservationScope {
  readonly transactionId: TransactionId
  readonly minimumAddressIndex: number
  readonly now: number
}

export interface BindPearlChangeAddressInput extends PearlChangeReservationScope {
  readonly transactionId: TransactionId
  readonly address: DerivedPearlAddress
  readonly now: number
}

export interface TransitionPearlChangeInput extends PearlChangeReservationScope {
  readonly transactionId: TransactionId
  readonly state: Extract<PearlChangeReservationState, 'committed' | 'abandoned'>
  readonly now: number
}

export interface PearlChangeReservationRepository {
  get(
    scope: PearlChangeReservationScope,
    transactionId: TransactionId
  ): Promise<PearlChangeReservation | null>
  allocate(input: AllocatePearlChangeInput): Promise<PearlChangeReservation>
  bindAddress(input: BindPearlChangeAddressInput): Promise<PearlChangeReservation>
  transition(input: TransitionPearlChangeInput): Promise<PearlChangeReservation>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

export interface StoredPearlChangeReservation {
  readonly schemaVersion: 1
  readonly reservationKey: string
  readonly accountKey: string
  readonly scopeKey: string
  readonly reservation: PearlChangeReservation
}

function parseAddressScheme(value: unknown): 'pearl_p2tr' {
  if (value !== 'pearl_p2tr') {
    throw new Error('Invalid Pearl change address scheme')
  }
  return 'pearl_p2tr'
}

function parseAddressIndex(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= PEARL_MAXIMUM_ADDRESSES_PER_TARGET
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseState(value: unknown): PearlChangeReservationState {
  if (!(PEARL_CHANGE_RESERVATION_STATES as readonly unknown[]).includes(value)) {
    throw new Error('Invalid Pearl change reservation state')
  }
  return value as PearlChangeReservationState
}

function parseOptionalMasterFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    throw new Error('Invalid Pearl change address master fingerprint')
  }
  return value
}

export function parsePearlChangeReservationScope(value: unknown): PearlChangeReservationScope {
  if (!isRecord(value) || !hasExactKeys(value, ['chainAccount', 'accountIndex', 'addressScheme'])) {
    throw new Error('Invalid Pearl change reservation scope')
  }
  const scope = parseScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex
  })
  return Object.freeze({
    ...scope,
    addressScheme: parseAddressScheme(value.addressScheme)
  })
}

export function pearlChangeScopeKey(scopeValue: PearlChangeReservationScope): string {
  const scope = parsePearlChangeReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressScheme: scopeValue.addressScheme
  })
  return JSON.stringify([scope.chainAccount.id, scope.addressScheme])
}

export function pearlChangeReservationKey(
  scopeValue: PearlChangeReservationScope,
  transactionIdValue: TransactionId
): string {
  const scope = parsePearlChangeReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressScheme: scopeValue.addressScheme
  })
  const transactionId = parseTransactionId(transactionIdValue)
  return JSON.stringify([scope.chainAccount.id, scope.addressScheme, transactionId])
}

function parseDerivedChangeAddress(
  value: unknown,
  scope: PearlChangeReservationScope,
  addressIndex: number
): DerivedPearlAddress {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'chainId',
      'accountIndex',
      'change',
      'addressIndex',
      'address',
      'addressScheme',
      'derivationScheme',
      'derivationPath',
      'publicKey',
      'masterFingerprint',
      'scriptPubKey'
    ])
  ) {
    throw new Error('Invalid derived Pearl change address')
  }
  const coinType =
    scope.chainAccount.scope.chainId === 'bip122:a18d3093b7ff618f0cdd073fa3d10374' ? 808276 : 1
  const derivationPath = `m/86'/${coinType}'/${scope.accountIndex}'/1/${addressIndex}`
  if (
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.accountIndex !== scope.accountIndex ||
    value.change !== true ||
    value.addressIndex !== addressIndex ||
    value.addressScheme !== 'pearl_p2tr' ||
    scope.addressScheme !== 'pearl_p2tr' ||
    value.derivationScheme !== 'bip86' ||
    value.derivationPath !== derivationPath ||
    typeof value.publicKey !== 'string' ||
    !/^0x0[23][0-9a-f]{64}$/.test(value.publicKey) ||
    typeof value.scriptPubKey !== 'string' ||
    !/^0x5120[0-9a-f]{64}$/.test(value.scriptPubKey)
  ) {
    throw new Error('Derived Pearl change address does not match its reservation')
  }
  const masterFingerprint = parseOptionalMasterFingerprint(value.masterFingerprint)
  if (masterFingerprint === undefined) {
    throw new Error('Invalid derived Pearl change address master fingerprint')
  }
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    accountIndex: scope.accountIndex,
    change: true,
    addressIndex,
    address: parseSupportedPearlAddress(String(value.address), scope.chainAccount.scope.chainId),
    addressScheme: 'pearl_p2tr' as const,
    derivationScheme: 'bip86' as const,
    derivationPath,
    publicKey: value.publicKey,
    masterFingerprint,
    scriptPubKey: value.scriptPubKey
  })
}

export function parsePearlChangeReservation(
  value: unknown,
  expectedScope?: PearlChangeReservationScope,
  expectedTransactionId?: TransactionId
): PearlChangeReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainAccount',
      'accountIndex',
      'addressScheme',
      'transactionId',
      'state',
      'addressIndex',
      'address',
      'createdAt',
      'updatedAt'
    ]) ||
    value.schemaVersion !== PEARL_CHANGE_RESERVATION_SCHEMA_VERSION
  ) {
    throw new Error('Invalid Pearl change reservation')
  }
  const scope = parsePearlChangeReservationScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex,
    addressScheme: value.addressScheme
  })
  const transactionId = parseTransactionId(value.transactionId)
  if (
    (expectedScope !== undefined &&
      (scope.chainAccount.id !== expectedScope.chainAccount.id ||
        scope.accountIndex !== expectedScope.accountIndex ||
        scope.addressScheme !== expectedScope.addressScheme)) ||
    (expectedTransactionId !== undefined && transactionId !== expectedTransactionId)
  ) {
    throw new Error('Pearl change reservation scope mismatch')
  }
  const state = parseState(value.state)
  const addressIndex = parseAddressIndex(value.addressIndex, 'Pearl change address index')
  const createdAt = parseTimestamp(value.createdAt)
  const updatedAt = parseTimestamp(value.updatedAt)
  if (updatedAt < createdAt) {
    throw new Error('Invalid Pearl change reservation timestamps')
  }
  const address =
    value.address === null ? null : parseDerivedChangeAddress(value.address, scope, addressIndex)
  if ((state === 'allocating') !== (address === null)) {
    throw new Error('Pearl change reservation address state is inconsistent')
  }
  return Object.freeze({
    schemaVersion: PEARL_CHANGE_RESERVATION_SCHEMA_VERSION,
    chainAccount: scope.chainAccount,
    accountIndex: scope.accountIndex,
    addressScheme: scope.addressScheme,
    transactionId,
    state,
    addressIndex,
    address,
    createdAt,
    updatedAt
  })
}

export function parseStoredPearlChangeReservation(value: unknown): StoredPearlChangeReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'reservationKey',
      'accountKey',
      'scopeKey',
      'reservation'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.reservationKey !== 'string' ||
    typeof value.accountKey !== 'string' ||
    typeof value.scopeKey !== 'string'
  ) {
    throw new Error('Invalid stored Pearl change reservation')
  }
  const reservation = parsePearlChangeReservation(value.reservation)
  const expectedReservationKey = pearlChangeReservationKey(reservation, reservation.transactionId)
  const expectedScopeKey = pearlChangeScopeKey(reservation)
  const expectedAccountKey = accountKey(reservation.chainAccount.scope)
  if (
    value.reservationKey !== expectedReservationKey ||
    value.scopeKey !== expectedScopeKey ||
    value.accountKey !== expectedAccountKey
  ) {
    throw new Error('Stored Pearl change reservation keys are inconsistent')
  }
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: expectedReservationKey,
    accountKey: expectedAccountKey,
    scopeKey: expectedScopeKey,
    reservation
  })
}

export function parsePearlChangeAccountScope(value: unknown): {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
} {
  return parseAccountScope(value)
}

export function parseMinimumPearlChangeAddressIndex(value: unknown): number {
  return parseAddressIndex(value, 'minimum Pearl change address index')
}
