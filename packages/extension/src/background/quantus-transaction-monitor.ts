import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  ChromeSessionQuantusPendingTransferStore,
  createConfiguredQuantusRpcClient,
  QuantusTransactionMonitor,
  type QuantusPendingBroadcastRecoveryResult,
  type QuantusTransactionMonitorResult
} from '@/infrastructure/chains/quantus'
import { resolveQuantusRuntimeNetworkConfig } from '@/core/chains/quantus'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'

export const QUANTUS_TRANSACTION_MONITOR_ALARM = 'quantus-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export interface BackgroundQuantusTransactionMonitorController {
  readonly recoverSignedTransfers: () => Promise<QuantusPendingBroadcastRecoveryResult>
}

export class BackgroundQuantusTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: QuantusTransactionMonitor
  private readonly chainId: ReturnType<typeof resolveQuantusRuntimeNetworkConfig>['chainId']

  constructor(
    private readonly controller: BackgroundQuantusTransactionMonitorController,
    endpointSettings?: ChainEndpointSettings
  ) {
    const network = resolveQuantusRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
    this.chainId = network.chainId
    this.monitor = new QuantusTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      pendingStore: new ChromeSessionQuantusPendingTransferStore(),
      chainId: network.chainId,
      rpc: createConfiguredQuantusRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
    })
  }

  async init(): Promise<QuantusTransactionMonitorResult> {
    return this.poll()
  }

  async handleAlarm(): Promise<QuantusTransactionMonitorResult> {
    return this.poll()
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
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId: this.chainId,
      family: 'quantus'
    })
  }

  private async poll(): Promise<QuantusTransactionMonitorResult> {
    const recovery = await this.controller.recoverSignedTransfers()
    const scopes = await this.loadPersistedScopes()
    if (scopes.length > 0) await this.monitor.loadMetadata().catch(() => {})
    const result = await this.monitor.poll(scopes)
    const errors = recovery.errors + result.errors
    if (errors > 0) {
      console.warn(`[Quantus Transaction Monitor] ${errors} observation(s) failed`)
    }
    if (recovery.pending > 0 || result.checked > 0 || errors > 0) {
      await chrome.alarms.create(QUANTUS_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(QUANTUS_TRANSACTION_MONITOR_ALARM)
    }
    return Object.freeze({
      checked: result.checked + recovery.attempted,
      applied: result.applied + recovery.broadcast,
      unchanged: result.unchanged + recovery.pending,
      errors
    })
  }
}
