import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import { DASH_GAP_LIMIT, DASH_MAX_ADDRESSES_PER_CHAIN } from './config'
import {
  dashAddressPath,
  dashScopeKey,
  hasExactKeys,
  isRecord,
  parseDashDiscoveryScope,
  parseDashP2pkhAddress,
  parseDashTimestamp,
  type DashDerivedAddress,
  type DashDiscoveryObservation,
  type DashDiscoveryScope
} from './dash-discovery-model'

/** Matches the Dash transfer approval window. Timed-out reservations can be reused. */
export const DASH_CHANGE_RESERVATION_TTL_MS = 5 * 60 * 1000

export const DASH_CHANGE_RESERVATION_STATES = Object.freeze([
  'allocating',
  'reserved',
  'committed',
  'abandoned'
] as const)

export type DashChangeReservationState = (typeof DASH_CHANGE_RESERVATION_STATES)[number]

export interface DashChangeReservation extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly state: DashChangeReservationState
  readonly addressIndex: number
  readonly address: DashDerivedAddress | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AllocateDashChangeInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly minimumAddressIndex: number
  readonly now: number
}

export interface BindDashChangeAddressInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly address: DashDerivedAddress
  readonly now: number
}

export interface TransitionDashChangeInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly state: 'committed' | 'abandoned'
  readonly now: number
}

export interface DashChangeReservationRepository {
  get(
    scope: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>,
    transactionId: TransactionId
  ): Promise<DashChangeReservation | null>
  list(
    scope: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<readonly DashChangeReservation[]>
  allocate(input: AllocateDashChangeInput): Promise<DashChangeReservation>
  bindAddress(input: BindDashChangeAddressInput): Promise<DashChangeReservation>
  transition(input: TransitionDashChangeInput): Promise<DashChangeReservation>
  deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number>
}

export function dashChangeReservationKey(scope: DashDiscoveryScope, transactionId: string): string {
  return JSON.stringify([dashScopeKey(scope), transactionId])
}

function parseAddress(
  value: unknown,
  scope: DashDiscoveryScope,
  addressIndex: number
): DashDerivedAddress {
  if (
    !isRecord(value) ||
    value.change !== true ||
    value.addressIndex !== addressIndex ||
    value.privacy !== 'transparent' ||
    value.scheme !== 'dash_p2pkh' ||
    value.purpose !== 'change'
  ) {
    throw new Error('Invalid Dash change address')
  }
  const path = dashAddressPath(
    scope.chainAccount.scope.chainId,
    scope.accountIndex,
    true,
    addressIndex,
    false
  )
  if (value.derivationPath !== path || value.chainId !== scope.chainAccount.scope.chainId) {
    throw new Error('Invalid Dash change address')
  }
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    network: scope.network,
    accountIndex: scope.accountIndex,
    change: true,
    addressIndex,
    address: parseDashP2pkhAddress(String(value.address), scope.chainAccount.scope.chainId),
    scheme: 'dash_p2pkh',
    purpose: 'change',
    privacy: 'transparent',
    derivationScheme: 'bip44',
    derivationPath: path,
    publicKey: String(value.publicKey),
    scriptPubKey: String(value.scriptPubKey)
  })
}

export function parseDashChangeReservation(
  value: unknown,
  scope: DashDiscoveryScope
): DashChangeReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'chainAccount',
      'accountIndex',
      'network',
      'imported',
      'transactionId',
      'state',
      'addressIndex',
      'address',
      'createdAt',
      'updatedAt'
    ]) ||
    !(DASH_CHANGE_RESERVATION_STATES as readonly unknown[]).includes(value.state)
  ) {
    throw new Error('Invalid Dash change reservation')
  }
  if (scope.imported) throw new Error('Imported Dash keys have no change address')
  const parsedScope = parseDashDiscoveryScope({
    chainAccount: value.chainAccount as DashDiscoveryScope['chainAccount'],
    accountIndex: value.accountIndex as DashDiscoveryScope['accountIndex']
  })
  if (dashScopeKey(parsedScope) !== dashScopeKey(scope)) {
    throw new Error('Dash change reservation belongs to another account')
  }
  if (
    !Number.isSafeInteger(value.addressIndex) ||
    (value.addressIndex as number) < 0 ||
    (value.addressIndex as number) >= DASH_MAX_ADDRESSES_PER_CHAIN
  ) {
    throw new Error('Invalid Dash change address index')
  }
  const addressIndex = value.addressIndex as number
  const address =
    value.address === null ? null : parseAddress(value.address, parsedScope, addressIndex)
  if ((value.state === 'reserved' || value.state === 'committed') && address === null) {
    throw new Error('Dash change reservation is missing its address')
  }
  return Object.freeze({
    ...parsedScope,
    transactionId: parseTransactionId(value.transactionId),
    state: value.state as DashChangeReservationState,
    addressIndex,
    address,
    createdAt: parseDashTimestamp(value.createdAt),
    updatedAt: parseDashTimestamp(value.updatedAt)
  })
}

export function nextDashChangeStartIndex(
  observations: readonly DashDiscoveryObservation[]
): number {
  let highestUsed = -1
  for (const observation of observations) {
    if (!observation.derived.change) continue
    if (observation.transactions.length === 0 && observation.utxos.length === 0) continue
    highestUsed = Math.max(highestUsed, observation.derived.addressIndex)
  }
  return highestUsed + 1
}

function reservationOccupiesIndex(
  reservation: {
    readonly state: string
    readonly createdAt?: number
  },
  now: number | undefined
): boolean {
  if (reservation.state === 'abandoned') return false
  if (reservation.state === 'committed') return true
  if (reservation.state !== 'reserved' && reservation.state !== 'allocating') return false
  const createdAt = reservation.createdAt
  if (now === undefined || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) {
    return true
  }
  return now < createdAt + DASH_CHANGE_RESERVATION_TTL_MS
}

export function nextDashChangeIndex(
  reservations: readonly {
    readonly state: string
    readonly addressIndex: number
    readonly createdAt?: number
  }[],
  minimumAddressIndex: number,
  now?: number
): number {
  if (!Number.isSafeInteger(minimumAddressIndex) || minimumAddressIndex < 0) {
    throw new Error('Invalid Dash change address index')
  }
  const used = new Set(
    reservations
      .filter(reservation => reservationOccupiesIndex(reservation, now))
      .map(reservation => reservation.addressIndex)
  )
  let index = minimumAddressIndex
  while (used.has(index)) index += 1
  if (index >= minimumAddressIndex + DASH_GAP_LIMIT) {
    throw new Error('Dash change address is outside the scanned gap')
  }
  if (index >= DASH_MAX_ADDRESSES_PER_CHAIN) throw new Error('Dash change addresses are exhausted')
  return index
}
