import type { PearlAddressObservation } from '@/core/chains/pearl'
import type { TransactionId } from '@/core/transactions/domain'
import type { PearlAddressDerivationPort } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import { DedupPromise } from '@/lib/async-utils'
import type { PearlDiscoveryRepository } from './pearl-discovery-repository'
import { hasExactKeys, isRecord } from './pearl-discovery-persistence-model'
import {
  pearlChangeReservationKey,
  parsePearlChangeReservationScope,
  type PearlChangeReservation,
  type PearlChangeReservationRepository,
  type PearlChangeReservationScope
} from './pearl-change-reservation-model'

export interface ReservePearlChangeInput extends PearlChangeReservationScope {
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface PearlChangeReservationCoordinatorOptions {
  readonly discoveryRepository: PearlDiscoveryRepository
  readonly reservationRepository: PearlChangeReservationRepository
  readonly derivation: PearlAddressDerivationPort
  readonly ensureDiscovered?: (
    scope: PearlChangeReservationScope,
    addressIndex: number
  ) => Promise<PearlAddressObservation>
  readonly now?: () => number
}

function requiredMinimumAddressIndex(
  state: Awaited<ReturnType<PearlDiscoveryRepository['get']>>
): number {
  if (state === null) {
    throw new Error('Pearl change discovery must complete before reserving an address')
  }
  const cursors = state.checkpoint.cursors.filter(cursor => cursor.target.change)
  if (cursors.length !== 1 || !cursors[0].complete) {
    throw new Error('Pearl change discovery must complete before reserving an address')
  }
  let highestUsedAddressIndex = -1
  for (const observation of state.observations) {
    if (observation.derived.change && observation.activity.used) {
      highestUsedAddressIndex = Math.max(highestUsedAddressIndex, observation.derived.addressIndex)
    }
  }
  return highestUsedAddressIndex + 1
}

export class PearlChangeReservationCoordinator {
  private readonly reservations = new Map<string, DedupPromise<PearlChangeReservation>>()

  constructor(private readonly options: PearlChangeReservationCoordinatorOptions) {}

  async reserve(input: ReservePearlChangeInput): Promise<PearlChangeReservation> {
    if (
      !isRecord(input) ||
      !hasExactKeys(
        input,
        ['chainAccount', 'accountIndex', 'addressScheme', 'transactionId'],
        ['signal']
      ) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw new Error('Invalid Pearl change reservation input')
    }
    const scope = parsePearlChangeReservationScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex,
      addressScheme: input.addressScheme
    })
    const key = pearlChangeReservationKey(scope, input.transactionId)
    const gate = this.reservations.get(key) ?? new DedupPromise<PearlChangeReservation>()
    this.reservations.set(key, gate)
    return gate
      .run(() => this.reserveOnce(input, scope))
      .finally(() => {
        if (!gate.isPending) this.reservations.delete(key)
      })
  }

  commit(
    scope: PearlChangeReservationScope,
    transactionId: TransactionId
  ): Promise<PearlChangeReservation> {
    return this.options.reservationRepository.transition({
      ...parsePearlChangeReservationScope(scope),
      transactionId,
      state: 'committed',
      now: this.now()
    })
  }

  abandon(
    scope: PearlChangeReservationScope,
    transactionId: TransactionId
  ): Promise<PearlChangeReservation> {
    return this.options.reservationRepository.transition({
      ...parsePearlChangeReservationScope(scope),
      transactionId,
      state: 'abandoned',
      now: this.now()
    })
  }

  private async reserveOnce(
    input: ReservePearlChangeInput,
    scope: PearlChangeReservationScope
  ): Promise<PearlChangeReservation> {
    if (input.signal?.aborted) throw new Error('Pearl change reservation was cancelled')
    const existing = await this.options.reservationRepository.get(scope, input.transactionId)
    let allocation = existing
    if (allocation === null) {
      const discovery = await this.options.discoveryRepository.get({
        chainAccount: scope.chainAccount,
        accountIndex: scope.accountIndex
      })
      const minimumAddressIndex = requiredMinimumAddressIndex(discovery)
      allocation = await this.options.reservationRepository.allocate({
        ...scope,
        transactionId: input.transactionId,
        minimumAddressIndex,
        now: this.now()
      })
    }
    if (allocation.state === 'abandoned') {
      throw new Error('Abandoned Pearl change reservation cannot resume')
    }
    if (allocation.state === 'committed') return allocation
    try {
      if (input.signal?.aborted) throw new Error('Pearl change reservation was cancelled')
      const observation = await this.options.ensureDiscovered?.(scope, allocation.addressIndex)
      if (observation && (observation.activity.used || observation.utxos.length > 0)) {
        throw new Error('Ledger Pearl change address is already used')
      }
      if (allocation.state === 'reserved') {
        if (
          observation &&
          (allocation.address?.address !== observation.derived.address ||
            allocation.address.derivationPath !== observation.derived.derivationPath)
        ) {
          throw new Error('Ledger Pearl change reservation conflicts with discovery')
        }
        return allocation
      }
      const address = await this.options.derivation.deriveAddress(
        scope.chainAccount.scope.keyDomainId,
        {
          chainId: scope.chainAccount.scope.chainId,
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
        throw new Error('Ledger Pearl change address conflicts with discovery')
      }
      if (input.signal?.aborted) throw new Error('Pearl change reservation was cancelled')
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
      throw new Error('Invalid Pearl change reservation timestamp')
    }
    return value
  }
}
