import { getPearlNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import {
  PearlChangeReservationCoordinator,
  PearlDiscoveryCoordinator,
  PearlDiscoveryRefresher,
  PearlGapLimitScanner,
  PearlOwnedTransactionBalanceUpdater,
  PearlPortfolioCoordinator,
  PearlTransferOrchestrator,
  PearlTransferPreparationCoordinator,
  ChromeSessionPearlPendingTransferStore,
  createConfiguredPearlBlockbookClient,
  IndexedDbPearlChangeReservationRepository,
  IndexedDbPearlDiscoveryRepository,
  IndexedDbPearlInputReservationRepository,
  loadActivePearlDiscoveryContext
} from '@/infrastructure/chains/pearl'
import { PearlMultichainDerivationClient } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import { PearlMultichainSigningClient } from '@/infrastructure/keyring/multichain/pearl-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import { PEARL_TRANSACTION_MONITOR_ALARM } from './pearl-transaction-monitor'
import { NEAR_INTENTS_TRANSACTION_MONITOR_ALARM } from './near-intents-transaction-monitor'
import { BackgroundPearlTransferController } from './pearl-transfer-controller'
import { credentialSession } from './credential-session'
import { recordRheaSwapGraphBroadcast } from './rhea-swap'
import { reportBackgroundSendBroadcast } from './analytics/send-broadcast'

export { BackgroundPearlTransferController } from './pearl-transfer-controller'
export type {
  BackgroundPearlTransferControllerOptions,
  BackgroundPearlTransferReview
} from './pearl-transfer-controller'

interface BackgroundPearlRuntime {
  readonly controller: BackgroundPearlTransferController
  readonly portfolio: PearlPortfolioCoordinator
  readonly discovery: PearlDiscoveryCoordinator
  readonly balanceUpdater: PearlOwnedTransactionBalanceUpdater
}

let backgroundPearlRuntime: BackgroundPearlRuntime | null = null

export function hasBackgroundPearlTransferCapability(): boolean {
  const chain = createInitialProductChainRegistry(DEFAULT_NETWORK).resolve(
    getPearlNetworkConfig(DEFAULT_NETWORK).chainId
  )
  return (
    chain.capabilities.transaction.status === 'available' &&
    chain.capabilities.transaction.actions.includes('native-transfer')
  )
}

function createBackgroundPearlRuntime(customRpcUrl?: string): BackgroundPearlRuntime {
  const network = getPearlNetworkConfig(DEFAULT_NETWORK)
  const storageRepository = new IndexedDbStorageV2Repository()
  const discoveryRepository = new IndexedDbPearlDiscoveryRepository()
  const inputReservations = new IndexedDbPearlInputReservationRepository()
  const derivation = new PearlMultichainDerivationClient({ credentials: credentialSession })
  const rpc = createConfiguredPearlBlockbookClient(DEFAULT_NETWORK, customRpcUrl)
  const discoveryRefresher = new PearlDiscoveryRefresher({ rpc, concurrency: 1 })
  const notifyPortfolioUpdated = (scope: {
    readonly keyDomainId: string
    readonly accountId: string
  }) =>
    chrome.runtime
      .sendMessage({
        type: 'PORTFOLIO_UPDATED',
        walletId: scope.keyDomainId,
        accountId: scope.accountId
      })
      .catch(() => {})
  const balanceUpdater = new PearlOwnedTransactionBalanceUpdater({
    storageRepository,
    discoveryRepository,
    chainId: network.chainId,
    onUpdated: notifyPortfolioUpdated
  })
  const discovery = new PearlDiscoveryCoordinator({
    storageRepository,
    discoveryRepository,
    scanner: new PearlGapLimitScanner({ derivation, rpc }),
    refresher: discoveryRefresher,
    chainId: network.chainId,
    onProgress: (context, observation) => {
      if (!observation.activity.used && observation.utxos.length === 0) return
      void notifyPortfolioUpdated(context.chainAccount.scope)
    }
  })
  const changeReservations = new PearlChangeReservationCoordinator({
    discoveryRepository,
    reservationRepository: new IndexedDbPearlChangeReservationRepository(),
    derivation,
    ensureDiscovered: async (scope, addressIndex) => {
      const state = await discoveryRepository.get(scope)
      const observation = state?.observations.find(
        item => item.derived.change && item.derived.addressIndex === addressIndex
      )
      if (!observation) throw new Error('Pearl change address is not discovered')
      return observation
    }
  })
  const preparation = new PearlTransferPreparationCoordinator({
    discoveryRepository,
    derivation,
    rpc,
    inputReservations,
    changeReservations
  })
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
  const assets = createAssetRegistry(
    chains,
    getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK)
  )
  const scheduleMonitor = async () => {
    await Promise.all([
      chrome.alarms.create(PEARL_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
      chrome.alarms.create(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
    ])
  }
  const orchestrator = new PearlTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: new ChromeSessionPearlPendingTransferStore(),
    signer: new PearlMultichainSigningClient({ credentials: credentialSession }),
    rpc,
    assets,
    changeReservations,
    inputReservations,
    onPendingBroadcast: scheduleMonitor,
    onBroadcastAccepted: async (input, recovered) => {
      if (recovered) reportBackgroundSendBroadcast(input.graph)
      const result = await balanceUpdater.applyBroadcast(input)
      if (result.errors > 0) {
        logger.warn(
          'Pearl post-broadcast balance update was incomplete',
          input.scope.keyDomainId,
          input.scope.accountId
        )
      }
      await recordRheaSwapGraphBroadcast(input.graph).catch(error => {
        logger.warn(`RHEA Swap submission recovery was deferred: ${formatLogError(error)}`)
      })
    },
    onMonitoringRequired: scheduleMonitor
  })
  const controller = new BackgroundPearlTransferController({
    preparation,
    orchestrator,
    loadActiveContext: () => loadActivePearlDiscoveryContext(storageRepository, network.chainId),
    scanActive: () => discovery.scanActive(),
    requiredConfirmations: network.requiredConfirmations
  })
  const portfolio = new PearlPortfolioCoordinator({
    storageRepository,
    discovery,
    inputReservations,
    chainId: network.chainId,
    chains,
    assets,
    onRefreshError: (error, context) => {
      logger.warn(
        `Pearl portfolio refresh failed: ${formatLogError(error)}`,
        context.chainAccount.scope.keyDomainId,
        context.chainAccount.scope.accountId
      )
    }
  })
  return Object.freeze({ controller, portfolio, discovery, balanceUpdater })
}

function getBackgroundPearlRuntime(): BackgroundPearlRuntime {
  backgroundPearlRuntime ??= createBackgroundPearlRuntime()
  return backgroundPearlRuntime
}

export function createBackgroundPearlTransferController(): BackgroundPearlTransferController {
  return getBackgroundPearlRuntime().controller
}

export function createBackgroundPearlPortfolioCoordinator(): PearlPortfolioCoordinator {
  return getBackgroundPearlRuntime().portfolio
}

export function scanBackgroundPearlDiscovery() {
  return getBackgroundPearlRuntime().discovery.scanActive()
}

export function getBackgroundPearlBalanceUpdater(): PearlOwnedTransactionBalanceUpdater {
  return getBackgroundPearlRuntime().balanceUpdater
}

export async function reloadBackgroundPearlRuntime(
  customRpcUrl?: string,
  cancelAwaitingApprovals = true
): Promise<void> {
  if (backgroundPearlRuntime && cancelAwaitingApprovals) {
    await backgroundPearlRuntime.controller.cancelAllAwaitingApprovals()
  }
  backgroundPearlRuntime = createBackgroundPearlRuntime(customRpcUrl)
}

/**
 * Completes Pearl transfers interrupted between signing, broadcast and
 * reservation commit. Safe to run from the monitor alarm and at startup.
 */
export async function recoverPendingPearlTransfers(): Promise<void> {
  if (!hasBackgroundPearlTransferCapability()) return
  await getBackgroundPearlRuntime().controller.recoverPendingTransfers()
}
