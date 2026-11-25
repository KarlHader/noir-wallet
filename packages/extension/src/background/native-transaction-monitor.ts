import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import { readActiveStorageV2Snapshot } from '@/core/keyring/application/active-storage-v2-snapshot'
import { createConfiguredNearRpcClient, NearTransactionMonitor } from '@/infrastructure/chains/near'
import {
  createConfiguredSolanaRpcClient,
  SolanaTransactionMonitor
} from '@/infrastructure/chains/solana'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { NativeTransferRecoveryResult } from './native-transfer-controller'

export const NEAR_TRANSACTION_MONITOR_ALARM = 'near-transaction-monitor-alarm'
export const SOLANA_TRANSACTION_MONITOR_ALARM = 'solana-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

function createMonitorAdapter(family: 'near' | 'solana') {
  const repository = new IndexedDbTransactionRepository()
  if (family === 'near') {
    const { chainId, rpcUrl } = getNearNetworkConfig(DEFAULT_NETWORK)
    return {
      chainId,
      alarm: NEAR_TRANSACTION_MONITOR_ALARM,
      label: 'NEAR',
      monitor: new NearTransactionMonitor({
        repository,
        chainId,
        rpc: createConfiguredNearRpcClient({ chainId, rpcUrl })
      })
    }
  }

  const { chainId, rpcUrl } = getSolanaNetworkConfig(
    DEFAULT_NETWORK === 'mainnet' ? 'mainnet' : 'devnet'
  )
  return {
    chainId,
    alarm: SOLANA_TRANSACTION_MONITOR_ALARM,
    label: 'Solana',
    monitor: new SolanaTransactionMonitor({
      repository,
      chainId,
      rpc: createConfiguredSolanaRpcClient({ chainId, rpcUrl })
    })
  }
}

export function createBackgroundNativeTransactionMonitor(
  family: 'near' | 'solana',
  controller: { recoverSignedTransfers(): Promise<NativeTransferRecoveryResult> }
) {
  const storageRepository = new IndexedDbStorageV2Repository()
  const { chainId, alarm, label, monitor } = createMonitorAdapter(family)

  async function poll() {
    const recovery = await controller.recoverSignedTransfers()
    const snapshot = await readActiveStorageV2Snapshot(storageRepository)
    const scopes = snapshot
      ? listKeySourceAllowedAccountScopes({
          keyDomains: snapshot.keyDomains,
          chainAccounts: snapshot.chainAccounts,
          chainId,
          family
        })
      : Object.freeze([])
    const result = await monitor.poll(scopes)
    const errors = recovery.errors + result.errors
    if (errors > 0) console.warn(`[${label} Transaction Monitor] ${errors} observation(s) failed`)
    if (recovery.pending > 0 || result.checked > 0 || errors > 0) {
      await chrome.alarms.create(alarm, { delayInMinutes: POLL_DELAY_MINUTES })
    } else {
      await chrome.alarms.clear(alarm)
    }
    return Object.freeze({
      checked: result.checked + recovery.attempted,
      applied: result.applied + recovery.broadcast,
      unchanged: result.unchanged + recovery.pending,
      errors
    })
  }

  return { init: poll, handleAlarm: poll }
}
