import { getPearlNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import {
  PearlTransactionMonitor,
  PearlDiscoveryRefresher,
  PearlOwnedTransactionBalanceUpdater,
  IndexedDbPearlDiscoveryRepository,
  IndexedDbPearlInputReservationRepository,
  createConfiguredPearlBlockbookClient,
  type PearlTransactionMonitorResult
} from '@/infrastructure/chains/pearl'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { logger } from '@/lib/logger'

export const PEARL_TRANSACTION_MONITOR_ALARM = 'pearl-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export class BackgroundPearlTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: PearlTransactionMonitor

  constructor(customRpcUrl?: string) {
    const network = getPearlNetworkConfig(DEFAULT_NETWORK)
    const rpc = createConfiguredPearlBlockbookClient(DEFAULT_NETWORK, customRpcUrl)
    const discoveryRepository = new IndexedDbPearlDiscoveryRepository()
    const discoveryRefresher = new PearlDiscoveryRefresher({ rpc, concurrency: 1 })
    const balanceUpdater = new PearlOwnedTransactionBalanceUpdater({
      storageRepository: this.storageRepository,
      discoveryRepository,
      chainId: network.chainId,
      onUpdated: scope =>
        chrome.runtime
          .sendMessage({
            type: 'PORTFOLIO_UPDATED',
            walletId: scope.keyDomainId,
            accountId: scope.accountId
          })
          .catch(() => {})
    })
    this.monitor = new PearlTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      chainId: network.chainId,
      rpc,
      conflictSource: rpc,
      inputReservations: new IndexedDbPearlInputReservationRepository(),
      discoveryRepository,
      discoveryRefresher,
      requiredConfirmations: network.requiredConfirmations,
      onBalanceRefreshRequired: async ({ graph, observation }) => {
        const result = await balanceUpdater.applyObservation(observation)
        if (result.errors > 0) {
          logger.warn(
            'Pearl confirmation balance update was incomplete',
            graph.root.scope.keyDomainId,
            graph.root.scope.accountId
          )
        }
      }
    })
  }

  async init(): Promise<PearlTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  async handleAlarm(): Promise<PearlTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  private async loadPersistedScopes(): Promise<readonly TransactionAccountScope[]> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    const chainId = getPearlNetworkConfig(DEFAULT_NETWORK).chainId
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId,
      family: 'pearl'
    })
  }

  private async poll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<PearlTransactionMonitorResult> {
    const result = await this.monitor.poll(scopes)
    if (result.errors > 0) {
      console.warn(`[Pearl Transaction Monitor] ${result.errors} observation(s) failed`)
    }
    if (result.checked > 0 || result.pendingReconciliation > 0 || result.errors > 0) {
      await chrome.alarms.create(PEARL_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(PEARL_TRANSACTION_MONITOR_ALARM)
    }
    return result
  }
}
