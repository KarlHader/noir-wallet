import { getDashNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { dappManager } from '@/core/dapp/dapp-manager'
import { findLedgerPublicAccount } from '@/core/wallet/ledger-hardware-credential'
import {
  createConfiguredDashInsightClient,
  loadActiveDashDiscoveryContext
} from '@/infrastructure/chains/dash'
import { DashAddressDerivationRouter } from '@/infrastructure/keyring/dash-address-derivation-router'
import { DashMultichainDerivationClient } from '@/infrastructure/keyring/multichain/dash-derivation-client'
import { DashMultichainSigningClient } from '@/infrastructure/keyring/multichain/dash-signing-client'
import { readActiveLedgerHardwareCredential } from '@/infrastructure/keyring/active-hardware-credential-inventory'
import { deriveLedgerDashP2pkh } from '@/lib/ledger/dash-model'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import { accountContextTransition } from './account-context-transition'
import { BackgroundDashDAppHandler } from './dash-dapp-handler'
import type { BackgroundDashTransferController } from './dash-transfer-controller'
import { createBackgroundDashPortfolioCoordinator } from './dash-wallet'
import { credentialSession } from './credential-session'
import { dappHandler } from './dapp-handler'
import { listDAppChainAccounts } from './dapp-chain-account-catalog'
import { trackEvent } from '@/background/analytics/reporter'
import type { ActiveDashDiscoveryContext } from '@/infrastructure/chains/dash/dash-discovery-coordinator'

export function createBackgroundDashDAppHandler(
  transferController: BackgroundDashTransferController | null
): BackgroundDashDAppHandler {
  const network = getDashNetworkConfig(DEFAULT_NETWORK)
  const storageRepository = new IndexedDbStorageV2Repository()
  const credentialRepository = new IndexedDbCredentialRepository()
  return new BackgroundDashDAppHandler({
    enabled: true,
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: () => loadActiveDashDiscoveryContext(storageRepository, network.chainId),
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'dash',
        resolveAddress: async ({ addresses }) => {
          const candidates = addresses.filter(
            address => address.scheme === 'dash_p2pkh' && address.purpose === 'receive'
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
    derivation: new DashAddressDerivationRouter({
      software: new DashMultichainDerivationClient({ credentials: credentialSession }),
      storageRepository,
      credentialRepository,
      credentials: credentialSession,
      network: DEFAULT_NETWORK
    }),
    signer: new DashMultichainSigningClient({ credentials: credentialSession }),
    portfolio: createBackgroundDashPortfolioCoordinator(),
    rpc: createConfiguredDashInsightClient(DEFAULT_NETWORK),
    loadLedgerAccount: (context, address) =>
      loadLedgerDashAccount(storageRepository, credentialRepository, context, address)
  })
}

export function loadLedgerDashAccountBinding(
  context: ActiveDashDiscoveryContext,
  address: string
): Promise<{
  readonly accountPath: string
  readonly xpub: string
  readonly expectedAddress: string
}> {
  return loadLedgerDashAccount(
    new IndexedDbStorageV2Repository(),
    new IndexedDbCredentialRepository(),
    context,
    address
  )
}

async function loadLedgerDashAccount(
  storageRepository: IndexedDbStorageV2Repository,
  credentialRepository: IndexedDbCredentialRepository,
  context: ActiveDashDiscoveryContext,
  address: string
) {
  if (context.keyDomainSource.kind !== 'hardware' || context.keyDomainSource.vendor !== 'ledger') {
    throw new Error('Ledger Dash account export is unavailable')
  }
  const pointer = await storageRepository.getActivePointer()
  if (!pointer || pointer.generationId !== context.generationId) {
    throw new Error('Dash account changed before Ledger signing')
  }
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot || snapshot.manifest.generationId !== context.generationId) {
    throw new Error('Dash account changed before Ledger signing')
  }
  const credential = await readActiveLedgerHardwareCredential(
    credentialRepository,
    snapshot,
    context.chainAccount.scope.keyDomainId,
    await credentialSession.getProvisioningPassword()
  )
  if (credential.firmwareProfile !== 'multi-app' || !credential.capabilities.includes('dash')) {
    throw new Error('Ledger Dash account export is unavailable')
  }
  const account = findLedgerPublicAccount(credential, {
    family: 'dash',
    accountIndex: context.accountIndex,
    network: 'mainnet'
  })
  if (!account || account.address !== address) {
    throw new Error('Ledger Dash account export does not match the active account')
  }
  const derived = deriveLedgerDashP2pkh(account.xpub, false, 0)
  if (derived.address !== address || `0x${derived.publicKey}` !== account.publicKey) {
    throw new Error('Ledger Dash account export does not match the active account')
  }
  return Object.freeze({
    accountPath: account.derivationPath,
    xpub: account.xpub,
    expectedAddress: derived.address
  })
}
