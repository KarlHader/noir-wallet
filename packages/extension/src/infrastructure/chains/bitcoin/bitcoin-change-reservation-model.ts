import type { AccountId, AccountIndex, ChainAccount } from '@/core/accounts/domain'
import {
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType,
  type DerivedBitcoinAddress
} from '@/core/chains/bitcoin'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  accountKey,
  hasExactKeys,
  isRecord,
  parseAccountScope,
  parseScope,
  parseTimestamp
} from './bitcoin-discovery-persistence-model'

export const BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION = 1 as const
export const BITCOIN_CHANGE_RESERVATION_STATES = Object.freeze([
  'allocating',
  'reserved',
  'committed',
  'abandoned'
] as const)

export type BitcoinChangeReservationState = (typeof BITCOIN_CHANGE_RESERVATION_STATES)[number]

export interface BitcoinChangeReservationScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly addressType: BitcoinSupportedAddressType
}

export interface BitcoinChangeReservation extends BitcoinChangeReservationScope {
  readonly schemaVersion: typeof BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly state: BitcoinChangeReservationState
  readonly addressIndex: number
  readonly address: DerivedBitcoinAddress | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AllocateBitcoinChangeInput extends BitcoinChangeReservationScope {
  readonly transactionId: TransactionId
  readonly minimumAddressIndex: number
  readonly now: number
}

export interface BindBitcoinChangeAddressInput extends BitcoinChangeReservationScope {
  readonly transactionId: TransactionId
  readonly address: DerivedBitcoinAddress
  readonly now: number
}

export interface TransitionBitcoinChangeInput extends BitcoinChangeReservationScope {
  readonly transactionId: TransactionId
  readonly state: Extract<BitcoinChangeReservationState, 'committed' | 'abandoned'>
  readonly now: number
}

export interface BitcoinChangeReservationRepository {
  get(
    scope: BitcoinChangeReservationScope,
    transactionId: TransactionId
  ): Promise<BitcoinChangeReservation | null>
  allocate(input: AllocateBitcoinChangeInput): Promise<BitcoinChangeReservation>
  bindAddress(input: BindBitcoinChangeAddressInput): Promise<BitcoinChangeReservation>
  transition(input: TransitionBitcoinChangeInput): Promise<BitcoinChangeReservation>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

export interface StoredBitcoinChangeReservation {
  readonly schemaVersion: 1
  readonly reservationKey: string
  readonly accountKey: string
  readonly scopeKey: string
  readonly reservation: BitcoinChangeReservation
}

function parseAddressType(value: unknown): BitcoinSupportedAddressType {
  if (value !== 'p2pkh' && value !== 'p2sh-p2wpkh' && value !== 'p2wpkh' && value !== 'p2tr') {
    throw new Error('Invalid Bitcoin change address type')
  }
  return value
}

function parseAddressIndex(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseState(value: unknown): BitcoinChangeReservationState {
  if (!(BITCOIN_CHANGE_RESERVATION_STATES as readonly unknown[]).includes(value)) {
    throw new Error('Invalid Bitcoin change reservation state')
  }
  return value as BitcoinChangeReservationState
}

function parseOptionalMasterFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    throw new Error('Invalid Bitcoin change address master fingerprint')
  }
  return value
}

export function parseBitcoinChangeReservationScope(value: unknown): BitcoinChangeReservationScope {
  if (!isRecord(value) || !hasExactKeys(value, ['chainAccount', 'accountIndex', 'addressType'])) {
    throw new Error('Invalid Bitcoin change reservation scope')
  }
  const scope = parseScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex
  })
  return Object.freeze({
    ...scope,
    addressType: parseAddressType(value.addressType)
  })
}

export function bitcoinChangeScopeKey(scopeValue: BitcoinChangeReservationScope): string {
  const scope = parseBitcoinChangeReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressType: scopeValue.addressType
  })
  return JSON.stringify([scope.chainAccount.id, scope.addressType])
}

export function bitcoinChangeReservationKey(
  scopeValue: BitcoinChangeReservationScope,
  transactionIdValue: TransactionId
): string {
  const scope = parseBitcoinChangeReservationScope({
    chainAccount: scopeValue.chainAccount,
    accountIndex: scopeValue.accountIndex,
    addressType: scopeValue.addressType
  })
  const transactionId = parseTransactionId(transactionIdValue)
  return JSON.stringify([scope.chainAccount.id, scope.addressType, transactionId])
}

function parseDerivedChangeAddress(
  value: unknown,
  scope: BitcoinChangeReservationScope,
  addressIndex: number
): DerivedBitcoinAddress {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'chainId',
        'addressType',
        'accountIndex',
        'change',
        'addressIndex',
        'address',
        'addressScheme',
        'derivationScheme',
        'derivationPath',
        'publicKey'
      ],
      ['masterFingerprint', 'scriptPubKey', 'redeemScript']
    )
  ) {
    throw new Error('Invalid derived Bitcoin change address')
  }
  const coinType =
    scope.chainAccount.scope.chainId === 'bip122:000000000019d6689c085ae165831e93' ? 0 : 1
  const profile =
    scope.addressType === 'p2pkh'
      ? ({ purpose: 44, addressScheme: 'bitcoin-p2pkh', derivationScheme: 'bip44' } as const)
      : scope.addressType === 'p2sh-p2wpkh'
        ? ({
            purpose: 49,
            addressScheme: 'bitcoin-p2sh-p2wpkh',
            derivationScheme: 'bip49'
          } as const)
        : scope.addressType === 'p2wpkh'
          ? ({ purpose: 84, addressScheme: 'bitcoin-p2wpkh', derivationScheme: 'bip84' } as const)
          : ({ purpose: 86, addressScheme: 'bitcoin-p2tr', derivationScheme: 'bip86' } as const)
  const derivationPath =
    scope.addressType === 'p2wpkh'
      ? `${scope.chainAccount.derivation.path.replace(/\/0\/0$/, '')}/1/${addressIndex}`
      : `m/${profile.purpose}'/${coinType}'/${scope.accountIndex}'/1/${addressIndex}`
  const addressScheme = profile.addressScheme
  const derivationScheme = profile.derivationScheme
  if (
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.addressType !== scope.addressType ||
    value.accountIndex !== scope.accountIndex ||
    value.change !== true ||
    value.addressIndex !== addressIndex ||
    value.addressScheme !== addressScheme ||
    value.derivationScheme !== derivationScheme ||
    value.derivationPath !== derivationPath ||
    typeof value.publicKey !== 'string' ||
    !/^0x0[23][0-9a-f]{64}$/.test(value.publicKey)
  ) {
    throw new Error('Derived Bitcoin change address does not match its reservation')
  }
  const masterFingerprint = parseOptionalMasterFingerprint(value.masterFingerprint)
  const scriptPubKey = value.scriptPubKey
  const redeemScript = value.redeemScript
  if (
    (scriptPubKey !== undefined &&
      (typeof scriptPubKey !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(scriptPubKey))) ||
    (redeemScript !== undefined &&
      (typeof redeemScript !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(redeemScript))) ||
    ((scope.addressType === 'p2pkh' || scope.addressType === 'p2sh-p2wpkh') &&
      scriptPubKey === undefined) ||
    (scope.addressType === 'p2sh-p2wpkh' && redeemScript === undefined) ||
    (scope.addressType !== 'p2sh-p2wpkh' && redeemScript !== undefined)
  ) {
    throw new Error('Invalid derived Bitcoin change address scripts')
  }
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    addressType: scope.addressType,
    accountIndex: scope.accountIndex,
    change: true,
    addressIndex,
    address: parseSupportedBitcoinAddress(
      value.address,
      scope.chainAccount.scope.chainId,
      scope.addressType
    ),
    addressScheme,
    derivationScheme,
    derivationPath,
    publicKey: value.publicKey,
    ...(masterFingerprint === undefined ? {} : { masterFingerprint }),
    ...(scriptPubKey === undefined ? {} : { scriptPubKey }),
    ...(redeemScript === undefined ? {} : { redeemScript })
  })
}

export function parseBitcoinChangeReservation(
  value: unknown,
  expectedScope?: BitcoinChangeReservationScope,
  expectedTransactionId?: TransactionId
): BitcoinChangeReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainAccount',
      'accountIndex',
      'addressType',
      'transactionId',
      'state',
      'addressIndex',
      'address',
      'createdAt',
      'updatedAt'
    ]) ||
    value.schemaVersion !== BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION
  ) {
    throw new Error('Invalid Bitcoin change reservation')
  }
  const scope = parseBitcoinChangeReservationScope({
    chainAccount: value.chainAccount,
    accountIndex: value.accountIndex,
    addressType: value.addressType
  })
  const transactionId = parseTransactionId(value.transactionId)
  const state = parseState(value.state)
  const addressIndex = parseAddressIndex(value.addressIndex, 'Bitcoin change address index')
  const createdAt = parseTimestamp(value.createdAt)
  const updatedAt = parseTimestamp(value.updatedAt)
  const address =
    value.address === null ? null : parseDerivedChangeAddress(value.address, scope, addressIndex)
  if (
    updatedAt < createdAt ||
    (state === 'allocating' && address !== null) ||
    ((state === 'reserved' || state === 'committed') && address === null) ||
    (expectedScope !== undefined &&
      bitcoinChangeScopeKey(scope) !== bitcoinChangeScopeKey(expectedScope)) ||
    (expectedTransactionId !== undefined && transactionId !== expectedTransactionId)
  ) {
    throw new Error('Inconsistent Bitcoin change reservation')
  }
  return Object.freeze({
    schemaVersion: 1,
    ...scope,
    transactionId,
    state,
    addressIndex,
    address,
    createdAt,
    updatedAt
  })
}

export function parseStoredBitcoinChangeReservation(
  value: unknown,
  expectedScope?: BitcoinChangeReservationScope,
  expectedTransactionId?: TransactionId
): StoredBitcoinChangeReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'reservationKey',
      'accountKey',
      'scopeKey',
      'reservation'
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw new Error('Invalid stored Bitcoin change reservation')
  }
  const reservation = parseBitcoinChangeReservation(
    value.reservation,
    expectedScope,
    expectedTransactionId
  )
  const expectedReservationKey = bitcoinChangeReservationKey(reservation, reservation.transactionId)
  const expectedAccountKey = accountKey(reservation.chainAccount.scope)
  const expectedScopeKey = bitcoinChangeScopeKey(reservation)
  if (
    value.reservationKey !== expectedReservationKey ||
    value.accountKey !== expectedAccountKey ||
    value.scopeKey !== expectedScopeKey
  ) {
    throw new Error('Stored Bitcoin change reservation keys do not match')
  }
  return Object.freeze({
    schemaVersion: 1,
    reservationKey: expectedReservationKey,
    accountKey: expectedAccountKey,
    scopeKey: expectedScopeKey,
    reservation
  })
}

export function parseBitcoinChangeAccountScope(value: unknown): {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
} {
  return parseAccountScope(value)
}

export function parseMinimumBitcoinChangeAddressIndex(value: unknown): number {
  return parseAddressIndex(value, 'minimum Bitcoin change address index')
}
