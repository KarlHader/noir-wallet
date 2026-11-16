import { getBitcoinNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  bitcoinDiscoveryAddressTypeComplete,
  IndexedDbBitcoinDiscoveryRepository,
  IndexedDbBitcoinInputReservationRepository,
  isActiveBitcoinAddressObservation,
  isLedgerBitcoinAccountObservation,
  loadActiveBitcoinDiscoveryContext,
  parseBitcoinAddressType,
  type BitcoinInputReservationRepository,
  type BitcoinDiscoveryState
} from '@/infrastructure/chains/bitcoin'
import { bitcoinAccountRootFromPath } from '@/infrastructure/chains/bitcoin/bitcoin-transaction-model'
import { isFixedSingleAddressBitcoinCheckpoint } from '@/infrastructure/chains/bitcoin/bitcoin-discovery-persistence-model'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import type { KeyDomainSource } from '@/core/keyring/domain'
import { isStoredAccountNetworkEnabledForSource } from '@/lib/wallet-metadata-storage'
import {
  DEFAULT_BITCOIN_ADDRESS_TYPE,
  getBitcoinAccountPreferences,
  type BitcoinAccountPreferencesRepository
} from './bitcoin-account-preferences'
import { scanBackgroundBitcoinAddressType } from './bitcoin-transfer'

export interface BitcoinDerivedAddressBalance {
  readonly value: string
  readonly addressType: BitcoinSupportedAddressType
  readonly addressScheme:
    | 'bitcoin-p2pkh'
    | 'bitcoin-p2sh-p2wpkh'
    | 'bitcoin-p2wpkh'
    | 'bitcoin-p2tr'
  readonly change: boolean
  readonly addressIndex: number
  readonly derivationPath: string
  readonly used: boolean
  readonly confirmedRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly utxoCount: number
}

export interface BitcoinAddressBalanceCatalog {
  readonly walletId: string
  readonly accountId: string
  readonly accountIndex: number
  readonly accountDerivationPath: string
  readonly chainId: string
  readonly updatedAt: number
  readonly activeAddressType: BitcoinSupportedAddressType
  readonly confirmedRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly addresses: readonly BitcoinDerivedAddressBalance[]
}

function outpointKey(transactionId: string, outputIndex: number): string {
  return `${transactionId}:${outputIndex}`
}

function observationTotals(
  observation: BitcoinDiscoveryState['observations'][number],
  unavailableOutpoints: ReadonlySet<string>,
  seenOutpoints?: Set<string>
) {
  let confirmed = 0n
  let available = 0n
  let pending = 0n
  for (const utxo of observation.utxos) {
    const outpoint = outpointKey(utxo.transactionId, utxo.outputIndex)
    if (seenOutpoints?.has(outpoint)) {
      throw new Error('Ledger Bitcoin balance contains a duplicate outpoint')
    }
    seenOutpoints?.add(outpoint)
    const value = BigInt(utxo.valueRaw)
    if (utxo.status.confirmed) {
      confirmed += value
      if (!unavailableOutpoints.has(outpoint)) {
        available += value
      }
    } else pending += value
  }
  return { confirmed, available, pending }
}

export function projectBitcoinAddressBalanceCatalog(
  state: BitcoinDiscoveryState,
  unavailableOutpoints: ReadonlySet<string> = new Set(),
  activeAddressType: BitcoinSupportedAddressType = DEFAULT_BITCOIN_ADDRESS_TYPE,
  ledgerAccountRoot?: string
): BitcoinAddressBalanceCatalog {
  if (
    ledgerAccountRoot !== undefined &&
    bitcoinAccountRootFromPath(
      state.chainAccount.derivation.path,
      state.chainAccount.scope.chainId,
      'p2wpkh',
      false,
      0
    ) !== ledgerAccountRoot
  ) {
    throw new Error('Ledger Bitcoin balance scope does not match the active account')
  }
  let confirmed = 0n
  let available = 0n
  let pending = 0n
  const seenOutpoints = ledgerAccountRoot === undefined ? undefined : new Set<string>()
  const entries = state.observations
    .filter(observation =>
      ledgerAccountRoot === undefined
        ? isActiveBitcoinAddressObservation(observation, activeAddressType)
        : observation.derived.addressType === activeAddressType &&
          isLedgerBitcoinAccountObservation(observation, ledgerAccountRoot)
    )
    .map(observation => {
      const totals = observationTotals(observation, unavailableOutpoints, seenOutpoints)
      confirmed += totals.confirmed
      available += totals.available
      pending += totals.pending
      return { observation, totals }
    })
    .map(({ observation, totals }) =>
      Object.freeze({
        value: observation.derived.address,
        addressType: observation.derived.addressType,
        addressScheme: observation.derived.addressScheme,
        change: observation.derived.change,
        addressIndex: observation.derived.addressIndex,
        derivationPath: observation.derived.derivationPath,
        used: observation.activity.used,
        confirmedRaw: totals.confirmed.toString(),
        availableRaw: totals.available.toString(),
        pendingRaw: totals.pending.toString(),
        utxoCount: observation.utxos.length
      })
    )

  return Object.freeze({
    walletId: state.chainAccount.scope.keyDomainId,
    accountId: state.chainAccount.scope.accountId,
    accountIndex: state.accountIndex,
    accountDerivationPath: state.chainAccount.derivation.path,
    chainId: state.chainAccount.scope.chainId,
    updatedAt: state.updatedAt,
    activeAddressType,
    confirmedRaw: confirmed.toString(),
    availableRaw: available.toString(),
    pendingRaw: pending.toString(),
    addresses: Object.freeze(entries)
  })
}

export class BitcoinAddressBalancesCoordinator {
  constructor(
    private readonly storageRepository = new IndexedDbStorageV2Repository(),
    private readonly discoveryRepository = new IndexedDbBitcoinDiscoveryRepository(),
    private readonly inputReservations: Pick<
      BitcoinInputReservationRepository,
      'list'
    > = new IndexedDbBitcoinInputReservationRepository(),
    private readonly chainId = getBitcoinNetworkConfig(DEFAULT_NETWORK).chainId,
    private readonly preferences: Pick<
      BitcoinAccountPreferencesRepository,
      'get' | 'set'
    > = getBitcoinAccountPreferences(),
    private readonly scanAddressType: (
      addressType: BitcoinSupportedAddressType
    ) => Promise<BitcoinDiscoveryState | null> = scanBackgroundBitcoinAddressType,
    private readonly isNetworkEnabled: (
      source: KeyDomainSource,
      walletId: string,
      accountId: string
    ) => Promise<boolean> = (source, walletId, accountId) =>
      isStoredAccountNetworkEnabledForSource(
        source,
        walletId,
        accountId,
        DEFAULT_NETWORK,
        'bitcoin'
      )
  ) {}

  private accountNetworkEnabled(
    context: NonNullable<Awaited<ReturnType<typeof loadActiveBitcoinDiscoveryContext>>>
  ) {
    return this.isNetworkEnabled(
      context.keyDomainSource,
      context.chainAccount.scope.keyDomainId,
      context.chainAccount.scope.accountId
    )
  }

  async readActive(): Promise<BitcoinAddressBalanceCatalog | null> {
    const context = await loadActiveBitcoinDiscoveryContext(this.storageRepository, this.chainId)
    if (!context || !(await this.accountNetworkEnabled(context))) return null
    const state = await this.discoveryRepository.get({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    })
    if (!state) return null
    const activeAddressType = await this.preferences.get({
      network: DEFAULT_NETWORK,
      keyDomainId: context.chainAccount.scope.keyDomainId,
      accountId: context.chainAccount.scope.accountId
    })
    const unavailableOutpoints = new Set<string>()
    const reservations = await this.inputReservations.list({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      addressType: activeAddressType
    })
    for (const reservation of reservations) {
      for (const outpoint of reservation.outpoints) {
        unavailableOutpoints.add(outpointKey(outpoint.transactionId, outpoint.outputIndex))
      }
    }
    const ledgerRoot =
      context.keyDomainSource.kind === 'hardware' && context.keyDomainSource.vendor === 'ledger'
        ? bitcoinAccountRootFromPath(
            context.chainAccount.derivation.path,
            context.chainAccount.scope.chainId,
            'p2wpkh',
            false,
            0
          )
        : undefined
    if (
      ledgerRoot !== undefined &&
      (isFixedSingleAddressBitcoinCheckpoint(state.checkpoint) ||
        !bitcoinDiscoveryAddressTypeComplete(state, 'p2wpkh'))
    )
      return null
    if (!(await this.accountNetworkEnabled(context))) return null
    return projectBitcoinAddressBalanceCatalog(
      state,
      unavailableOutpoints,
      activeAddressType,
      ledgerRoot
    )
  }

  async setActive(input: {
    readonly walletId: string
    readonly accountId: string
    readonly addressType: unknown
  }): Promise<BitcoinAddressBalanceCatalog | null> {
    const context = await loadActiveBitcoinDiscoveryContext(this.storageRepository, this.chainId)
    if (
      !context ||
      context.chainAccount.scope.keyDomainId !== input.walletId ||
      context.chainAccount.scope.accountId !== input.accountId
    ) {
      throw new Error('Bitcoin account preference does not match the active Account')
    }
    if (!(await this.accountNetworkEnabled(context))) {
      throw new Error('Bitcoin is not enabled for this Account')
    }
    const addressType = parseBitcoinAddressType(input.addressType)
    if (context.keyDomainSource.kind === 'hardware' && addressType !== 'p2wpkh') {
      throw new Error('Keystone Bitcoin accounts support only Native SegWit')
    }
    const state = await this.scanAddressType(addressType)
    if (
      !state ||
      state.chainAccount.id !== context.chainAccount.id ||
      !bitcoinDiscoveryAddressTypeComplete(state, addressType)
    ) {
      throw new Error('Bitcoin account discovery did not complete')
    }
    if (!(await this.accountNetworkEnabled(context))) {
      throw new Error('Bitcoin is not enabled for this Account')
    }
    await this.preferences.set(
      {
        network: DEFAULT_NETWORK,
        keyDomainId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      },
      addressType
    )
    return this.readActive()
  }
}

export function createBackgroundBitcoinAddressBalancesCoordinator() {
  return new BitcoinAddressBalancesCoordinator()
}
