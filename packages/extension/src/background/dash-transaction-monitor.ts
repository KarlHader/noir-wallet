import { getDashNetworkConfig } from '@/config/networks'
import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createConfiguredDashInsightClient,
  DashTransactionMonitor,
  type DashTransactionMonitorResult
} from '@/infrastructure/chains/dash'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { parseTransactionId, type TransactionAccountScope } from '@/core/transactions/domain'

export const DASH_TRANSACTION_MONITOR_ALARM = 'dash-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export class BackgroundDashTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: DashTransactionMonitor

  constructor() {
    const network = getDashNetworkConfig(DEFAULT_NETWORK)
    if (network.requiredConfirmations !== 6) {
      throw new Error('Dash finality requires 6 confirmations')
    }
    this.monitor = new DashTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      rpc: createConfiguredDashInsightClient(DEFAULT_NETWORK)
    })
  }

  async init(): Promise<DashTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  async handleAlarm(): Promise<DashTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  async refreshTransaction(transactionId: string) {
    const id = parseTransactionId(transactionId)
    for (const scope of await this.loadPersistedScopes()) {
      const status = await this.monitor.checkTransaction(scope, id)
      if (status) return status
    }
    return null
  }

  private async loadPersistedScopes(): Promise<readonly TransactionAccountScope[]> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    const chainId = getDashNetworkConfig(DEFAULT_NETWORK).chainId
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId,
      family: 'dash'
    })
  }

  private async poll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<DashTransactionMonitorResult> {
    const result = await this.monitor.poll(scopes)
    if (result.checked > 0 || result.errors > 0) {
      await chrome.alarms.create(DASH_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(DASH_TRANSACTION_MONITOR_ALARM)
    }
    return result
  }
}
