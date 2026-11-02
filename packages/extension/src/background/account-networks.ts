import type { AccountId } from '@/core/accounts/domain'
import {
  keySourceSupportsAddressFamily,
  loadActiveReceiveWalletSet,
  resolveKeyDomain
} from '@/core/accounts/application'
import type { WalletDAppActiveAccount } from './wallet-dapp-connection'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  type AddressGatedChainRegistry
} from '@/core/chains/registry'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { HardwareCredentialMetadata } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { EvmNetworkConfig } from '@/config/networks'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import type { BitcoinAddressDerivationPort } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'

type AccountNetworksRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface AccountNetworkAddressSummary {
  readonly value: string
  readonly scheme: string
  readonly privacy: 'transparent' | 'shielded' | 'mixed'
  readonly preferredForReceive: boolean
}

export interface AccountNetworkSummary {
  readonly chainId: string
  readonly addresses: readonly AccountNetworkAddressSummary[]
  readonly accountDerivationPath?: string
  readonly privateExecutionAddress?: string
}

export interface AccountNetworksSummary {
  readonly walletId: KeyDomainId
  readonly walletDisplayName: string
  readonly walletCreatedAt: number
  readonly walletSource:
    | Readonly<{ readonly kind: 'software' }>
    | Readonly<{
        readonly kind: 'private-key'
        readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
        readonly bitcoinNetwork?: 'mainnet' | 'testnet'
      }>
    | Readonly<{ readonly kind: 'hardware'; readonly hardware: HardwareCredentialMetadata }>
  readonly accountId: AccountId
  readonly accountDisplayName: string
  readonly accountIndex: number
  readonly active: boolean
  readonly networks: readonly AccountNetworkSummary[]
}

export interface AccountNetworksCatalog {
  readonly generationId: StorageV2GenerationId
  readonly accounts: readonly AccountNetworksSummary[]
}

export interface AccountNetworksCoordinatorOptions {
  readonly repository: AccountNetworksRepository
  readonly chains: AddressGatedChainRegistry
  readonly getZcashShieldedReceiveAddress?: (scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
    readonly chainId: string
  }) => string | null
  readonly bitcoinDerivation?: BitcoinAddressDerivationPort
  readonly evmPeaDerivation?: Readonly<{
    deriveGlobalPea(
      keyDomainId: KeyDomainId,
      addressIndex: number
    ): Promise<Readonly<{ readonly address: string }>>
  }>
}

export class AccountNetworksCoordinator {
  constructor(private readonly options: AccountNetworksCoordinatorOptions) {}

  async readActiveAccount(): Promise<WalletDAppActiveAccount | null> {
    const active = await loadActiveReceiveWalletSet({
      repository: this.options.repository,
      chainRegistry: this.options.chains
    })
    const selection = active?.catalog.activeAccount
    if (!selection) return null
    return {
      reference: { walletId: selection.keyDomainId, accountId: selection.accountId },
      chainIds: active.availableChainAccounts.map(item => item.chain.id)
    }
  }

  async readCatalog(): Promise<AccountNetworksCatalog | null> {
    const pointer = await this.options.repository.getActivePointer()
    if (!pointer) return null

    const snapshot = await this.options.repository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }

    const chainOrder = new Map(
      this.options.chains.list().map((chain, index) => [chain.id, index] as const)
    )
    const accounts = await Promise.all(
      snapshot.accounts.map(async account => {
        const keyDomain = resolveKeyDomain(snapshot.keyDomains, account.keyDomainId)
        const seenChains = new Set<string>()
        const privateExecutionAddresses = new Map<number, Promise<string>>()
        const networks = (
          await Promise.all(
            snapshot.chainAccounts
              .filter(
                chainAccount =>
                  chainAccount.scope.keyDomainId === account.keyDomainId &&
                  chainAccount.scope.accountId === account.id
              )
              .map(async chainAccount => {
                const chain = this.options.chains.get(chainAccount.scope.chainId)
                if (!chain || !keySourceSupportsAddressFamily(keyDomain.source, chain.family))
                  return []
                if (seenChains.has(chain.id)) {
                  throw new Error('Account has duplicate enabled ChainAccounts')
                }
                seenChains.add(chain.id)

                // Rotation changes the receive selection, not the immutable account identity.
                const selectedShielded =
                  chain.family === 'zcash'
                    ? this.options.getZcashShieldedReceiveAddress?.(chainAccount.scope)
                    : null
                let addresses: readonly AccountNetworkAddressSummary[] = snapshot.addresses
                  .filter(
                    address =>
                      address.chainAccountId === chainAccount.id &&
                      address.purpose !== 'change' &&
                      (address.purpose === 'receive' || address.preferredForReceive) &&
                      chain.capabilities.address.addressSchemes.includes(address.scheme)
                  )
                  .sort(
                    (left, right) =>
                      Number(right.preferredForReceive) - Number(left.preferredForReceive)
                  )
                  .map(address =>
                    Object.freeze({
                      value:
                        selectedShielded &&
                        address.scheme === 'zcash-shielded-unified' &&
                        address.preferredForReceive
                          ? selectedShielded
                          : address.value,
                      scheme: address.scheme,
                      privacy: address.privacy,
                      preferredForReceive: address.preferredForReceive
                    })
                  )

                const bitcoinDerivation = this.options.bitcoinDerivation
                if (
                  chain.family === 'bitcoin' &&
                  keyDomain.source.kind === 'software' &&
                  bitcoinDerivation
                ) {
                  try {
                    const persistedAddresses = addresses
                    addresses = Object.freeze(
                      await Promise.all(
                        BITCOIN_ADDRESS_POLICY.importDiscovery.map(async target => {
                          const persisted = persistedAddresses.find(
                            address => address.scheme === target.addressScheme
                          )
                          if (persisted) {
                            return Object.freeze({
                              ...persisted,
                              preferredForReceive: target.createByDefault
                            })
                          }
                          const derived = await bitcoinDerivation.deriveAddress(
                            account.keyDomainId,
                            {
                              chainId: chain.id,
                              addressType: target.addressType,
                              accountIndex: account.accountIndex,
                              change: false,
                              addressIndex: 0
                            }
                          )
                          return Object.freeze({
                            value: derived.address,
                            scheme: derived.addressScheme,
                            privacy: 'transparent' as const,
                            preferredForReceive: target.createByDefault
                          })
                        })
                      )
                    )
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      (error.message !== 'Wallet is locked' &&
                        error.message !== 'Credential is not unlocked')
                    ) {
                      throw error
                    }
                    // Public metadata stays readable while the credential session is locked.
                  }
                }

                let privateExecutionAddress: string | undefined
                const evmPeaDerivation = this.options.evmPeaDerivation
                if (
                  chain.family === 'evm' &&
                  supportsEvmPrivateExecution(keyDomain.source) &&
                  evmPeaDerivation
                ) {
                  const binding = parseEvmAccountBinding(chainAccount, chain.id)
                  try {
                    let derived = privateExecutionAddresses.get(binding.addressIndex)
                    if (!derived) {
                      derived = evmPeaDerivation
                        .deriveGlobalPea(account.keyDomainId, binding.addressIndex)
                        .then(result => result.address)
                      privateExecutionAddresses.set(binding.addressIndex, derived)
                    }
                    privateExecutionAddress = await derived
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      (error.message !== 'Wallet is locked' &&
                        error.message !== 'Credential is not unlocked')
                    ) {
                      throw error
                    }
                    // Public account metadata stays readable while the credential session is locked.
                  }
                }

                if (addresses.length === 0) {
                  throw new Error('Enabled ChainAccount has no displayable Address')
                }
                return [
                  Object.freeze({
                    chainId: chain.id,
                    addresses: Object.freeze(addresses),
                    ...(chain.family === 'zcash'
                      ? { accountDerivationPath: chainAccount.derivation.path }
                      : {}),
                    ...(privateExecutionAddress === undefined ? {} : { privateExecutionAddress })
                  })
                ]
              })
          )
        )
          .flat()
          .sort(
            (left, right) =>
              (chainOrder.get(left.chainId) ?? Number.MAX_SAFE_INTEGER) -
              (chainOrder.get(right.chainId) ?? Number.MAX_SAFE_INTEGER)
          )

        return Object.freeze({
          walletId: account.keyDomainId,
          walletDisplayName: keyDomain.displayName,
          walletCreatedAt: keyDomain.createdAt,
          walletSource:
            keyDomain.source.kind === 'software'
              ? Object.freeze({ kind: 'software' as const })
              : keyDomain.source.kind === 'private-key'
                ? Object.freeze({
                    kind: 'private-key' as const,
                    chainFamily: keyDomain.source.chainFamily,
                    ...(keyDomain.source.bitcoinNetwork === undefined
                      ? {}
                      : { bitcoinNetwork: keyDomain.source.bitcoinNetwork })
                  })
                : Object.freeze({
                    kind: 'hardware' as const,
                    hardware: Object.freeze({
                      vendor: keyDomain.source.vendor,
                      firmwareProfile: keyDomain.source.firmwareProfile,
                      capabilities: keyDomain.source.capabilities
                    })
                  }),
          accountId: account.id,
          accountDisplayName: account.displayName,
          accountIndex: account.accountIndex,
          active:
            snapshot.manifest.activeAccount?.keyDomainId === account.keyDomainId &&
            snapshot.manifest.activeAccount.accountId === account.id,
          networks: Object.freeze(networks)
        })
      })
    )

    return Object.freeze({
      generationId: pointer.generationId,
      accounts: Object.freeze(accounts)
    })
  }
}

export function createBackgroundAccountNetworksCoordinator(
  customEvmNetworks: readonly EvmNetworkConfig[] = [],
  bitcoinDerivation?: BitcoinAddressDerivationPort,
  evmPeaDerivation?: AccountNetworksCoordinatorOptions['evmPeaDerivation'],
  getZcashShieldedReceiveAddress?: AccountNetworksCoordinatorOptions['getZcashShieldedReceiveAddress']
): AccountNetworksCoordinator {
  return new AccountNetworksCoordinator({
    repository: new IndexedDbStorageV2Repository(),
    chains: createBuildAddressGatedChainRegistry(
      createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
    ),
    bitcoinDerivation,
    evmPeaDerivation,
    getZcashShieldedReceiveAddress
  })
}
