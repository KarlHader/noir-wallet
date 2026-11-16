import type { BitcoinAddressObservation, BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import type { TransactionId } from '@/core/transactions/domain'
import type { BitcoinAddressDerivationPort } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import { DedupPromise } from '@/lib/async-utils'
import type { BitcoinDiscoveryRepository } from './bitcoin-discovery-repository'
import { hasExactKeys, isRecord } from './bitcoin-discovery-persistence-model'
import {
  bitcoinChangeReservationKey,
  parseBitcoinChangeReservationScope,
  type BitcoinChangeReservation,
  type BitcoinChangeReservationRepository,
  type BitcoinChangeReservationScope
} from './bitcoin-change-reservation-model'

export interface ReserveBitcoinChangeInput extends BitcoinChangeReservationScope {
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface BitcoinChangeReservationCoordinatorOptions {
  readonly discoveryRepository: BitcoinDiscoveryRepository
  readonly reservationRepository: BitcoinChangeReservationRepository
  readonly derivation: BitcoinAddressDerivationPort
  readonly ensureDiscovered?: (
    scope: BitcoinChangeReservationScope,
    addressIndex: number
  ) => Promise<BitcoinAddressObservation>
  readonly now?: () => number
}

function requiredMinimumAddressIndex(
  state: Awaited<ReturnType<BitcoinDiscoveryRepository['get']>>,
  addressType: BitcoinSupportedAddressType
): number {
  if (state === null) {
    throw new Error('Bitcoin change discovery must complete before reserving an address')
  }
  const cursors = state.checkpoint.cursors.filter(
    cursor => cursor.target.addressType === addressType && cursor.target.change
  )
  if (cursors.length !== 1 || !cursors[0].complete) {
    throw new Error('Bitcoin change discovery must complete before reserving an address')
  }
  let highestUsedAddressIndex = -1
  for (const observation of state.observations) {
    if (
      observation.derived.addressType === addressType &&
      observation.derived.change &&
      observation.activity.used
    ) {
      highestUsedAddressIndex = Math.max(highestUsedAddressIndex, observation.derived.addressIndex)
    }
  }
  return highestUsedAddressIndex + 1
}

export class BitcoinChangeReservationCoordinator {
  private readonly reservations = new Map<string, DedupPromise<BitcoinChangeReservation>>()

  constructor(private readonly options: BitcoinChangeReservationCoordinatorOptions) {}

  async reserve(input: ReserveBitcoinChangeInput): Promise<BitcoinChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(
        input,
        ['chainAccount', 'accountIndex', 'addressType', 'transactionId'],
        ['signal']
      ) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw new Error('Invalid Bitcoin change reservation input')
    }
    const scope = parseBitcoinChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressType: input.addressType
    })
    const key = bitcoinChangeReservationKey(scope, input.transactionId)
    const gate = this.reservations.get(key) ?? new DedupPromise<BitcoinChangeReservation>()
    this.reservations.set(key, gate)
    return gate
      .run(() => this.reserveOnce(input, scope))
      .finally(() => {
        if (!gate.isPending) this.reservations.delete(key)
      })
  }

  commit(
    scope: BitcoinChangeReservationScope,
    transactionId: TransactionId
  ): Promise<BitcoinChangeReservation> {
    return this.options.reservationRepository.transition({
      ...parseBitcoinChangeReservationScope(scope),
      transactionId,
      state: 'committed',
      now: this.now()
    })
  }

  abandon(
    scope: BitcoinChangeReservationScope,
    transactionId: TransactionId
  ): Promise<BitcoinChangeReservation> {
    return this.options.reservationRepository.transition({
      ...parseBitcoinChangeReservationScope(scope),
      transactionId,
      state: 'abandoned',
      now: this.now()
    })
  }

  private async reserveOnce(
    input: ReserveBitcoinChangeInput,
    scope: BitcoinChangeReservationScope
  ): Promise<BitcoinChangeReservation> {
    if (input.signal?.aborted) throw new Error('Bitcoin change reservation was cancelled')
    const existing = await this.options.reservationRepository.get(scope, input.transactionId)
    let allocation = existing
    if (allocation === null) {
      const discovery = await this.options.discoveryRepository.get({
        chainAccount: scope.chainAccount,
        accountIndex: scope.accountIndex
      })
      const minimumAddressIndex = requiredMinimumAddressIndex(discovery, scope.addressType)
      allocation = await this.options.reservationRepository.allocate({
        ...scope,
        transactionId: input.transactionId,
        minimumAddressIndex,
        now: this.now()
      })
    }
    if (allocation.state === 'abandoned') {
      throw new Error('Abandoned Bitcoin change reservation cannot resume')
    }
    if (allocation.state === 'committed') return allocation
    try {
      if (input.signal?.aborted) throw new Error('Bitcoin change reservation was cancelled')
      const observation = await this.options.ensureDiscovered?.(scope, allocation.addressIndex)
      if (observation && (observation.activity.used || observation.utxos.length > 0)) {
        throw new Error('Ledger Bitcoin change address is already used')
      }
      if (allocation.state === 'reserved') {
        if (
          observation &&
          (allocation.address?.address !== observation.derived.address ||
            allocation.address.derivationPath !== observation.derived.derivationPath)
        ) {
          throw new Error('Ledger Bitcoin change reservation conflicts with discovery')
        }
        return allocation
      }
      const address = await this.options.derivation.deriveAddress(
        scope.chainAccount.scope.keyDomainId,
        {
          chainId: scope.chainAccount.scope.chainId,
          addressType: scope.addressType,
          accountIndex: scope.accountIndex,
          change: true,
          addressIndex: allocation.addressIndex
        },
        input.signal
      )
      if (
        observation &&
        (address.address !== observation.derived.address ||
          address.derivationPath !== observation.derived.derivationPath)
      ) {
        throw new Error('Ledger Bitcoin change address conflicts with discovery')
      }
      if (input.signal?.aborted) throw new Error('Bitcoin change reservation was cancelled')
      return this.options.reservationRepository.bindAddress({
        ...scope,
        transactionId: input.transactionId,
        address,
        now: this.now()
      })
    } catch (error) {
      await this.options.reservationRepository.transition({
        ...scope,
        transactionId: input.transactionId,
        state: 'abandoned',
        now: this.now()
      })
      throw error
    }
  }

  private now(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Bitcoin change reservation timestamp')
    }
    return value
  }
}
