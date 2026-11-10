import { loadActiveReceiveWalletSet } from '@/core/accounts/application'
import type { AccountId } from '@/core/accounts/domain'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import { parseSupportedPearlAddress } from '@/core/chains/pearl'
import { parseQuantusAddress } from '@/core/chains/quantus'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  type AddressGatedChainRegistry
} from '@/core/chains/registry'
import { isBitcoinChainId, isDashChainId } from '@/core/chains/registry/chain-ids'
import type { KeyDomainId } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { EvmNetworkConfig } from '@/config/networks'
import { parseDashP2pkhAddress } from '@/infrastructure/chains/dash/dash-discovery-model'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import { createBackgroundBitcoinAddressBalancesCoordinator } from './bitcoin-address-balances'
import {
  DEFAULT_BITCOIN_ADDRESS_TYPE,
  getBitcoinAccountPreferences
} from './bitcoin-account-preferences'

type ReceiveTargetsRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export type AdditionalReceiveTarget =
  | Readonly<{
      chainId: string
      kind: 'evm'
      address: string
    }>
  | Readonly<{
      chainId: string
      kind: 'bitcoin'
      address: string
      addressType: BitcoinSupportedAddressType
    }>
  | Readonly<{
      chainId: string
      kind: 'solana' | 'near' | 'pearl' | 'quantus'
      address: string
    }>
  | Readonly<{
      chainId: string
      kind: 'dash'
      address: string
    }>

export interface AdditionalReceiveTargetsSnapshot {
  readonly generationId: StorageV2GenerationId
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
  readonly targets: readonly AdditionalReceiveTarget[]
}

export interface AdditionalReceiveTargetsCoordinatorOptions {
  readonly repository: ReceiveTargetsRepository
  readonly chains: AddressGatedChainRegistry
  readonly getBitcoinReceiveTarget: (scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
    readonly chainId: string
    readonly nativeSegwitAddress?: string
  }) => Promise<Readonly<{ address: string; addressType: BitcoinSupportedAddressType }> | null>
  readonly getDashReceiveTarget?: (scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
    readonly chainId: string
  }) => Promise<Readonly<{ address: string; privacy: 'transparent' }> | null>
}

function parseEvmReceiveAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('Active EVM receive Address is invalid')
  }
  return value
}

export class AdditionalReceiveTargetsCoordinator {
  constructor(private readonly options: AdditionalReceiveTargetsCoordinatorOptions) {}

  readCurrentActive(): Promise<AdditionalReceiveTargetsSnapshot | null> {
    return this.read()
  }

  readActive(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<AdditionalReceiveTargetsSnapshot | null> {
    return this.read(scope)
  }

  private async read(scope?: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<AdditionalReceiveTargetsSnapshot | null> {
    const active = await loadActiveReceiveWalletSet({
      repository: this.options.repository,
      chainRegistry: this.options.chains
    })
    if (!active?.activeAccount) return null
    if (
      scope &&
      (active.activeAccount.keyDomainId !== scope.keyDomainId ||
        active.activeAccount.id !== scope.accountId)
    ) {
      return null
    }

    const targets: AdditionalReceiveTarget[] = []
    const chainIds = new Set<string>()
    const releaseOrder = new Map(
      this.options.chains.list().map((chain, index) => [chain.id, index] as const)
    )
    const orderedChainAccounts = [...active.availableChainAccounts].sort(
      (left, right) =>
        (releaseOrder.get(left.chain.id) ?? Number.MAX_SAFE_INTEGER) -
        (releaseOrder.get(right.chain.id) ?? Number.MAX_SAFE_INTEGER)
    )
    for (const available of orderedChainAccounts) {
      if (available.chain.family === 'zcash') continue
      if (chainIds.has(available.chain.id)) {
        throw new Error('Active receive targets contain a duplicate chain')
      }
      chainIds.add(available.chain.id)
      if (available.chain.family === 'dash') {
        if (!isDashChainId(available.chain.id)) {
          throw new Error('Dash receive target chain is invalid')
        }
        const discovered = this.options.getDashReceiveTarget
          ? await this.options.getDashReceiveTarget({
              keyDomainId: active.activeAccount.keyDomainId,
              accountId: active.activeAccount.id,
              chainId: available.chain.id
            })
          : null
        if (discovered && discovered.privacy !== 'transparent') {
          throw new Error('Dash receive address must stay transparent')
        }
        const fallback = available.addresses.find(
          candidate => candidate.scheme === 'dash_p2pkh' && candidate.preferredForReceive
        )
        if (fallback && fallback.privacy !== 'transparent') {
          throw new Error('Dash receive address must stay transparent')
        }
        const address = discovered?.address ?? fallback?.value
        if (!address) throw new Error('Active Dash receive address is unavailable')
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'dash' as const,
            address: parseDashP2pkhAddress(address, available.chain.id)
          })
        )
        continue
      }
      if (available.chain.family === 'bitcoin' && isBitcoinChainId(available.chain.id)) {
        const nativeSegwitAddress = available.addresses.find(
          candidate => candidate.scheme === 'bitcoin-p2wpkh' && candidate.preferredForReceive
        )?.value
        const selected = await this.options.getBitcoinReceiveTarget({
          keyDomainId: active.activeAccount.keyDomainId,
          accountId: active.activeAccount.id,
          chainId: available.chain.id,
          ...(nativeSegwitAddress === undefined ? {} : { nativeSegwitAddress })
        })
        if (!selected) throw new Error('Active Bitcoin receive Address is unavailable')
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'bitcoin' as const,
            addressType: selected.addressType,
            address: parseSupportedBitcoinAddress(
              selected.address,
              available.chain.id,
              selected.addressType
            )
          })
        )
        continue
      }

      const address = available.addresses.find(candidate => candidate.preferredForReceive)
      if (!address) throw new Error('Active ChainAccount has no preferred receive Address')

      if (available.chain.family === 'evm') {
        if (address.scheme !== 'evm') throw new Error('Active EVM receive scheme is unavailable')
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'evm' as const,
            address: parseEvmReceiveAddress(address.value)
          })
        )
        continue
      }

      if (available.chain.family === 'solana') {
        if (address.scheme !== 'solana') {
          throw new Error('Active Solana receive scheme is unavailable')
        }
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'solana' as const,
            address: parseSolanaPublicKey(address.value)
          })
        )
        continue
      }

      if (available.chain.family === 'near') {
        if (address.scheme !== 'near') {
          throw new Error('Active NEAR receive scheme is unavailable')
        }
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'near' as const,
            address: parseNearAccountId(address.value)
          })
        )
        continue
      }

      if (available.chain.family === 'pearl') {
        if (address.scheme !== 'pearl_p2tr') {
          throw new Error('Active Pearl receive scheme is unavailable')
        }
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'pearl' as const,
            address: parseSupportedPearlAddress(address.value, available.chain.id)
          })
        )
        continue
      }

      if (available.chain.family === 'quantus') {
        if (address.scheme !== 'quantus_ss58') {
          throw new Error('Active Quantus receive scheme is unavailable')
        }
        targets.push(
          Object.freeze({
            chainId: available.chain.id,
            kind: 'quantus' as const,
            address: parseQuantusAddress(address.value)
          })
        )
        continue
      }

      throw new Error('Enabled chain has no receive target adapter')
    }

    return Object.freeze({
      generationId: active.generationId,
      keyDomainId: active.activeAccount.keyDomainId,
      accountId: active.activeAccount.id,
      targets: Object.freeze(targets)
    })
  }
}

export function createBackgroundAdditionalReceiveTargetsCoordinator(
  customEvmNetworks: readonly EvmNetworkConfig[] = []
): AdditionalReceiveTargetsCoordinator {
  const bitcoinBalances = createBackgroundBitcoinAddressBalancesCoordinator()
  const bitcoinPreferences = getBitcoinAccountPreferences()
  return new AdditionalReceiveTargetsCoordinator({
    repository: new IndexedDbStorageV2Repository(),
    chains: createBuildAddressGatedChainRegistry(
      createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
    ),
    getDashReceiveTarget: async scope => {
      const { readBackgroundDashReceiveAddress } = await import('./dash-wallet')
      return readBackgroundDashReceiveAddress(scope)
    },
    getBitcoinReceiveTarget: async scope => {
      const activeAddressType = await bitcoinPreferences.get({
        network: DEFAULT_NETWORK,
        keyDomainId: scope.keyDomainId,
        accountId: scope.accountId
      })
      if (activeAddressType === DEFAULT_BITCOIN_ADDRESS_TYPE && scope.nativeSegwitAddress) {
        return Object.freeze({
          address: scope.nativeSegwitAddress,
          addressType: activeAddressType
        })
      }
      const catalog = await bitcoinBalances.readActive()
      if (
        !catalog ||
        catalog.walletId !== scope.keyDomainId ||
        catalog.accountId !== scope.accountId ||
        catalog.chainId !== scope.chainId
      ) {
        return null
      }
      const address = catalog.addresses.find(
        candidate =>
          candidate.addressType === activeAddressType &&
          !candidate.change &&
          candidate.addressIndex === 0
      )
      return address
        ? Object.freeze({ address: address.value, addressType: address.addressType })
        : null
    }
  })
}
