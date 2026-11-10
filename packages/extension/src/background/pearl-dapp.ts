import { trackEvent } from '@/background/analytics/reporter'
import { PearlProviderError } from '@/core/dapp/pearl-provider'
import { getPearlNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { dappManager } from '@/core/dapp/dapp-manager'
import {
  createConfiguredPearlBlockbookClient,
  IndexedDbPearlDiscoveryRepository,
  loadActivePearlDiscoveryContext
} from '@/infrastructure/chains/pearl'
import { PearlMultichainDerivationClient } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import { PearlMultichainSigningClient } from '@/infrastructure/keyring/multichain/pearl-signing-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { logger } from '@/lib/logger'
import { accountContextTransition } from './account-context-transition'
import { BackgroundPearlDAppHandler } from './pearl-dapp-handler'
import type { BackgroundPearlTransferController } from './pearl-transfer-controller'
import {
  getBackgroundPearlBalanceUpdater,
  hasBackgroundPearlTransferCapability
} from './pearl-transfer'
import { credentialSession } from './credential-session'
import { dappHandler } from './dapp-handler'
import { listDAppChainAccounts } from './dapp-chain-account-catalog'
import { ensureActiveSoftwarePearlNetworkAccount } from './pearl-network-metadata'

export function createBackgroundPearlDAppHandler(
  transferController: BackgroundPearlTransferController | null,
  customRpcUrl?: string,
  options: {
    readonly ensureSoftwarePearlAccount?: (
      storageRepository: IndexedDbStorageV2Repository
    ) => Promise<void>
  } = {}
): BackgroundPearlDAppHandler {
  const network = getPearlNetworkConfig(DEFAULT_NETWORK)
  const storageRepository = new IndexedDbStorageV2Repository()
  const discoveryRepository = new IndexedDbPearlDiscoveryRepository()
  const loadActiveContext = async () => {
    const chainId = getPearlNetworkConfig(DEFAULT_NETWORK).chainId
    const existing = await loadActivePearlDiscoveryContext(storageRepository, chainId)
    if (existing) return existing
    if (!options.ensureSoftwarePearlAccount) {
      throw new PearlProviderError(
        4100,
        'The active wallet has no Pearl account (provisioning hook unavailable).'
      )
    }
    await options.ensureSoftwarePearlAccount(storageRepository)
    const provisioned = await loadActivePearlDiscoveryContext(storageRepository, chainId)
    if (provisioned) return provisioned
    throw new PearlProviderError(
      4100,
      `The active wallet has no Pearl account after provisioning (chainId=${chainId}).`
    )
  }
  return new BackgroundPearlDAppHandler({
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext,
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: getPearlNetworkConfig(DEFAULT_NETWORK).chainId,
        family: 'pearl',
        resolveAddress: ({ addresses }) => {
          const candidates = addresses.filter(
            address => address.scheme === 'pearl_p2tr' && address.purpose === 'receive'
          )
          return (
            (
              candidates.find(
                address =>
                  address.derivation?.path === 'm' || address.derivation?.path.endsWith('/0/0')
              ) ?? candidates[0]
            )?.value ?? null
          )
        }
      }),
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    transferController,
    derivation: new PearlMultichainDerivationClient({ credentials: credentialSession }),
    signer: new PearlMultichainSigningClient({ credentials: credentialSession }),
    discoveryRepository,
    rpc: createConfiguredPearlBlockbookClient(DEFAULT_NETWORK, customRpcUrl),
    onOwnedBroadcast: async input => {
      if (!hasBackgroundPearlTransferCapability()) return
      const result = await getBackgroundPearlBalanceUpdater().applyBroadcast(input)
      if (result.errors > 0) {
        logger.warn(
          'Pearl dApp post-broadcast balance update was incomplete',
          input.scope.keyDomainId,
          input.scope.accountId
        )
      }
    }
  })
}

export function createEnsureActiveSoftwarePearlAccount(options: {
  readonly synchronizeSoftwareWalletNetworkMetadata: () => Promise<void>
  readonly synchronizeNetworkAccountMetadata: Parameters<
    typeof ensureActiveSoftwarePearlNetworkAccount
  >[0]['synchronizeNetworkAccountMetadata']
  readonly deriveBitcoinAddress: Parameters<
    typeof ensureActiveSoftwarePearlNetworkAccount
  >[0]['deriveBitcoinAddress']
  readonly derivePearlAddress: Parameters<
    typeof ensureActiveSoftwarePearlNetworkAccount
  >[0]['derivePearlAddress']
}): (storageRepository: IndexedDbStorageV2Repository) => Promise<void> {
  return storageRepository =>
    ensureActiveSoftwarePearlNetworkAccount({
      network: DEFAULT_NETWORK,
      storageRepository,
      hasUnlockSession: () => credentialSession.hasUnlockSession(),
      synchronizeSoftwareWalletNetworkMetadata: options.synchronizeSoftwareWalletNetworkMetadata,
      synchronizeNetworkAccountMetadata: options.synchronizeNetworkAccountMetadata,
      deriveBitcoinAddress: options.deriveBitcoinAddress,
      derivePearlAddress: options.derivePearlAddress
    })
}
