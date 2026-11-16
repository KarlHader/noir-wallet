import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import { getSolanaNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createConfiguredSolanaRpcClient,
  SolanaTransactionMonitor,
  type SolanaPendingBroadcastRecoveryResult,
  type SolanaTransactionMonitorResult
} from '@/infrastructure/chains/solana'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'

export const SOLANA_TRANSACTION_MONITOR_ALARM = 'solana-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export interface BackgroundSolanaTransactionMonitorController {
  readonly recoverSignedTransfers: () => Promise<SolanaPendingBroadcastRecoveryResult>
}

export class BackgroundSolanaTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: SolanaTransactionMonitor

  constructor(private readonly controller: BackgroundSolanaTransactionMonitorController) {
    const network = getSolanaNetworkConfig(DEFAULT_NETWORK === 'mainnet' ? 'mainnet' : 'devnet')
    this.monitor = new SolanaTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      chainId: network.chainId,
      rpc: createConfiguredSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
    })
  }

  async init(): Promise<SolanaTransactionMonitorResult> {
    return this.poll()
  }

  async handleAlarm(): Promise<SolanaTransactionMonitorResult> {
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
      chainId: getSolanaNetworkConfig(DEFAULT_NETWORK === 'mainnet' ? 'mainnet' : 'devnet').chainId,
      family: 'solana'
    })
  }

  private async poll(): Promise<SolanaTransactionMonitorResult> {
    const recovery = await this.controller.recoverSignedTransfers()
    const result = await this.monitor.poll(await this.loadPersistedScopes())
    const errors = recovery.errors + result.errors
    if (errors > 0) {
      console.warn(`[Solana Transaction Monitor] ${errors} observation(s) failed`)
    }
    if (recovery.pending > 0 || result.checked > 0 || errors > 0) {
      await chrome.alarms.create(SOLANA_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(SOLANA_TRANSACTION_MONITOR_ALARM)
    }
    return Object.freeze({
      checked: result.checked + recovery.attempted,
      applied: result.applied + recovery.broadcast,
      unchanged: result.unchanged + recovery.pending,
      errors
    })
  }
}
