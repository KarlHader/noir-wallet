import { trackEvent } from '@/background/analytics/reporter'
import { getBitcoinNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { dappManager } from '@/core/dapp/dapp-manager'
import {
  createConfiguredBitcoinEsploraClient,
  loadActiveBitcoinDiscoveryContext
} from '@/infrastructure/chains/bitcoin'
import { BitcoinMultichainDerivationClient } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import { BitcoinAddressDerivationRouter } from '@/infrastructure/keyring/bitcoin-address-derivation-router'
import { BitcoinMultichainSigningClient } from '@/infrastructure/keyring/multichain/bitcoin-signing-client'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import { accountContextTransition } from './account-context-transition'
import { BackgroundBitcoinDAppHandler } from './bitcoin-dapp-handler'
import type { BackgroundBitcoinTransferController } from './bitcoin-transfer-controller'
import { createBackgroundBitcoinPortfolioCoordinator } from './bitcoin-transfer'
import { credentialSession } from './credential-session'
import { dappHandler } from './dapp-handler'
import { getBitcoinAccountPreferences } from './bitcoin-account-preferences'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import {
  filterEnabledDAppContext,
  isDAppNetworkEnabled,
  listDAppChainAccounts
} from './dapp-chain-account-catalog'

export function createBackgroundBitcoinDAppHandler(
  transferController: BackgroundBitcoinTransferController | null,
  customRpcUrl?: string
): BackgroundBitcoinDAppHandler {
  const network = getBitcoinNetworkConfig(DEFAULT_NETWORK)
  const storageRepository = new IndexedDbStorageV2Repository()
  const accountPreferences = getBitcoinAccountPreferences()
  return new BackgroundBitcoinDAppHandler({
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: async () =>
      filterEnabledDAppContext(
        await loadActiveBitcoinDiscoveryContext(storageRepository, network.chainId),
        'bitcoin'
      ),
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'bitcoin',
        isNetworkEnabled: isDAppNetworkEnabled,
        resolveAddress: async ({ account, addresses }) => {
          const addressType = await accountPreferences.get({
            network: DEFAULT_NETWORK,
            keyDomainId: account.keyDomainId,
            accountId: account.id
          })
          const addressScheme = BITCOIN_ADDRESS_POLICY.importDiscovery.find(
            target => target.addressType === addressType
          )?.addressScheme
          if (!addressScheme) return null
          const candidates = addresses.filter(
            address => address.scheme === addressScheme && address.purpose === 'receive'
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
    getAddressType: context =>
      accountPreferences.get({
        network: DEFAULT_NETWORK,
        keyDomainId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      }),
    transferController,
    derivation: new BitcoinAddressDerivationRouter({
      software: new BitcoinMultichainDerivationClient({ credentials: credentialSession }),
      storageRepository,
      credentialRepository: new IndexedDbCredentialRepository(),
      credentials: credentialSession,
      network: DEFAULT_NETWORK
    }),
    signer: new BitcoinMultichainSigningClient({ credentials: credentialSession }),
    rpc: createConfiguredBitcoinEsploraClient(DEFAULT_NETWORK, customRpcUrl),
    portfolio: createBackgroundBitcoinPortfolioCoordinator()
  })
}
