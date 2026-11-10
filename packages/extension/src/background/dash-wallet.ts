import { getDashNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import {
  DashDiscoveryCoordinator,
  DashGapLimitScanner,
  loadActiveDashDiscoveryContext,
  DashPortfolioCoordinator,
  DashTransactionRecovery,
  DashTransferOrchestrator,
  DashTransferPreparationCoordinator,
  IndexedDbDashChangeReservationRepository,
  IndexedDbDashDiscoveryRepository,
  IndexedDbDashInputReservationRepository,
  createChromeSessionDashPendingTransferStore,
  createConfiguredDashInsightClient,
  dashCurrentReceiveAddress,
  parseDashP2pkhAddress
} from '@/infrastructure/chains/dash'
import { DashAddressDerivationRouter } from '@/infrastructure/keyring/dash-address-derivation-router'
import { DashMultichainDerivationClient } from '@/infrastructure/keyring/multichain/dash-derivation-client'
import { DashMultichainSigningClient } from '@/infrastructure/keyring/multichain/dash-signing-client'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { BackgroundDashTransferController } from './dash-transfer-controller'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import { credentialSession } from './credential-session'

interface BackgroundDashRuntime {
  readonly portfolio: DashPortfolioCoordinator
  readonly discovery: DashDiscoveryCoordinator
  readonly changeReservations: IndexedDbDashChangeReservationRepository
  readonly transfer: BackgroundDashTransferController
  readonly recover: () => Promise<void>
}

let backgroundDashRuntime: BackgroundDashRuntime | null = null

function createBackgroundDashRuntime(): BackgroundDashRuntime {
  const network = getDashNetworkConfig(DEFAULT_NETWORK)
  const storageRepository = new IndexedDbStorageV2Repository()
  const discoveryRepository = new IndexedDbDashDiscoveryRepository()
  const inputReservations = new IndexedDbDashInputReservationRepository()
  const changeReservations = new IndexedDbDashChangeReservationRepository()
  const softwareDerivation = new DashMultichainDerivationClient({ credentials: credentialSession })
  const credentialRepository = new IndexedDbCredentialRepository()
  const derivation = new DashAddressDerivationRouter({
    software: softwareDerivation,
    storageRepository,
    credentialRepository,
    credentials: credentialSession,
    network: DEFAULT_NETWORK
  })
  const rpc = createConfiguredDashInsightClient(DEFAULT_NETWORK)
  const discovery = new DashDiscoveryCoordinator({
    storageRepository,
    discoveryRepository,
    scanner: new DashGapLimitScanner({ derivation, rpc }),
    changeReservations,
    chainId: network.chainId
  })
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
  const assets = createAssetRegistry(
    chains,
    filterAssetDefinitionsForChains(
      getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK),
      chains
    )
  )
  const portfolio = new DashPortfolioCoordinator({
    storageRepository,
    discovery,
    inputReservations,
    chainId: network.chainId,
    chains,
    assets,
    onRefreshError: (error, context) => {
      logger.warn(
        `Dash portfolio refresh failed: ${formatLogError(error)}`,
        context.chainAccount.scope.keyDomainId,
        context.chainAccount.scope.accountId
      )
    }
  })
  const preparation = new DashTransferPreparationCoordinator({
    discoveryRepository,
    derivation,
    rpc,
    inputReservations,
    changeReservations
  })
  const signer = new DashMultichainSigningClient({ credentials: credentialSession })
  const orchestrator = new DashTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: createChromeSessionDashPendingTransferStore(chrome.storage.session),
    signer,
    rpc,
    assets,
    changeReservations,
    inputReservations
  })
  const transfer = new BackgroundDashTransferController({
    preparation,
    orchestrator,
    loadActiveContext: () => loadActiveDashDiscoveryContext(storageRepository, network.chainId),
    scanActive: () => discovery.scanActive(),
    readAuthorization: async context => {
      if (
        context.keyDomainSource.kind === 'hardware' &&
        context.keyDomainSource.vendor === 'ledger'
      ) {
        const pointer = await storageRepository.getActivePointer()
        if (!pointer || pointer.generationId !== context.generationId) {
          throw new Error('Dash account changed before signing')
        }
        const snapshot = await storageRepository.getSnapshot(pointer.generationId)
        const keyDomain = snapshot?.keyDomains.find(
          item => item.id === context.chainAccount.scope.keyDomainId
        )
        if (!snapshot || !keyDomain || keyDomain.source.kind !== 'hardware') {
          throw new Error('Dash account changed before signing')
        }
        const activation = await credentialRepository.validateForActivation(
          keyDomain.credentialRef,
          keyDomain.id
        )
        if (activation.status !== 'active' || !activation.record) {
          throw new Error('Dash account changed before signing')
        }
        return {
          credentialGenerationId: activation.record.manifest.credentialGenerationId
        }
      }
      return {
        credentialGenerationId: (
          await credentialSession.getCredentialBinding(context.chainAccount.scope.keyDomainId)
        ).credentialGenerationId
      }
    },
    requiredConfirmations: network.requiredConfirmations
  })
  const recovery = new DashTransactionRecovery(orchestrator)
  return Object.freeze({
    portfolio,
    discovery,
    changeReservations,
    transfer,
    recover: () => recovery.recoverSignedBroadcasts().then(() => undefined)
  })
}

function getBackgroundDashRuntime(): BackgroundDashRuntime {
  backgroundDashRuntime ??= createBackgroundDashRuntime()
  return backgroundDashRuntime
}

export function createBackgroundDashPortfolioCoordinator(): DashPortfolioCoordinator {
  return getBackgroundDashRuntime().portfolio
}

export function createBackgroundDashTransferController(): BackgroundDashTransferController {
  return getBackgroundDashRuntime().transfer
}

export function recoverBackgroundDashTransfers(): Promise<void> {
  return getBackgroundDashRuntime().recover()
}

export async function readBackgroundDashReceiveAddress(scope: {
  readonly keyDomainId: string
  readonly accountId: string
  readonly chainId: string
}): Promise<Readonly<{ address: string; privacy: 'transparent' }> | null> {
  const network = getDashNetworkConfig(DEFAULT_NETWORK)
  if (scope.chainId !== network.chainId) return null
  const state = await getBackgroundDashRuntime().discovery.readCachedActive()
  if (
    !state ||
    state.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
    state.chainAccount.scope.accountId !== scope.accountId ||
    state.chainAccount.scope.chainId !== scope.chainId
  ) {
    return null
  }
  const address = dashCurrentReceiveAddress(state)
  if (!address) return null
  return Object.freeze({
    address: parseDashP2pkhAddress(address, scope.chainId),
    privacy: 'transparent'
  })
}
