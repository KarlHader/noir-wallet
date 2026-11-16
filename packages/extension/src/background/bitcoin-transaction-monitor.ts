import { getBitcoinNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import {
  BitcoinTransactionMonitor,
  BitcoinDiscoveryRefresher,
  BitcoinOwnedTransactionBalanceUpdater,
  IndexedDbBitcoinDiscoveryRepository,
  IndexedDbBitcoinInputReservationRepository,
  createConfiguredBitcoinEsploraClient,
  type BitcoinTransactionMonitorResult
} from '@/infrastructure/chains/bitcoin'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { logger } from '@/lib/logger'

export const BITCOIN_TRANSACTION_MONITOR_ALARM = 'bitcoin-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export class BackgroundBitcoinTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: BitcoinTransactionMonitor

  constructor(customRpcUrl?: string) {
    const network = getBitcoinNetworkConfig(DEFAULT_NETWORK)
    const rpc = createConfiguredBitcoinEsploraClient(DEFAULT_NETWORK, customRpcUrl)
    const discoveryRepository = new IndexedDbBitcoinDiscoveryRepository()
    const discoveryRefresher = new BitcoinDiscoveryRefresher({ rpc, concurrency: 1 })
    const balanceUpdater = new BitcoinOwnedTransactionBalanceUpdater({
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
    this.monitor = new BitcoinTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      chainId: network.chainId,
      rpc,
      inputReservations: new IndexedDbBitcoinInputReservationRepository(),
      discoveryRepository,
      discoveryRefresher,
      requiredConfirmations: network.requiredConfirmations,
      onBalanceRefreshRequired: async ({ graph, observation }) => {
        const result = await balanceUpdater.applyObservation(observation)
        if (result.errors > 0) {
          logger.warn(
            'Bitcoin confirmation balance update was incomplete',
            graph.root.scope.keyDomainId,
            graph.root.scope.accountId
          )
        }
      }
    })
  }

  async init(): Promise<BitcoinTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  async handleAlarm(): Promise<BitcoinTransactionMonitorResult> {
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
    const chainId = getBitcoinNetworkConfig(DEFAULT_NETWORK).chainId
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId,
      family: 'bitcoin'
    })
  }

  private async poll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<BitcoinTransactionMonitorResult> {
    const result = await this.monitor.poll(scopes)
    if (result.errors > 0) {
      console.warn(`[Bitcoin Transaction Monitor] ${result.errors} observation(s) failed`)
    }
    if (result.checked > 0 || result.pendingReconciliation > 0 || result.errors > 0) {
      await chrome.alarms.create(BITCOIN_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(BITCOIN_TRANSACTION_MONITOR_ALARM)
    }
    return result
  }
}
