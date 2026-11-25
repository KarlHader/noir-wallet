import { DEFAULT_NETWORK, getNetworkConfig } from '@/lib/runtime-network'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import { readActiveStorageV2Snapshot } from '@/core/keyring/application/active-storage-v2-snapshot'
import type {
  NearIntentsTransactionBinding,
  TransactionAccountScope
} from '@/core/transactions/domain'
import { parseSwapStatusResponse } from '@/core/services/intents-api'
import type { OneClickViewer } from '@/core/services/near-intents/one-click-order'
import {
  NearIntentsTransactionMonitor,
  parseNearIntentsStatusObservation,
  type NearIntentsDestinationObservation,
  type NearIntentsTransactionMonitorResult
} from '@/infrastructure/transactions'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { getRequiredConfirmations } from '@/lib/transaction-status'
import { lookupTransaction } from '@/lib/zcash-node-rpc'
import { parseConfidentialOneClickStatus } from './confidential-funding-api'
import { queryOneClickOrderStatus } from './one-click-status'

export const NEAR_INTENTS_TRANSACTION_MONITOR_ALARM = 'near-intents-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

function readLegacyRefundViewer(
  binding: NearIntentsTransactionBinding,
  network: typeof DEFAULT_NETWORK
): OneClickViewer | undefined {
  const { origin, refundAddress: walletAddress } = binding
  if (origin.chainId.startsWith('eip155:')) {
    return {
      chainFamily: 'evm',
      walletAddress,
      signingMode: binding.userAction === 'transfer' ? 'private' : 'public'
    }
  }
  if (origin.chainId === getBitcoinChainId(network)) return { chainFamily: 'btc', walletAddress }
  if (origin.chainId.startsWith('solana:')) return { chainFamily: 'solana', walletAddress }
  if (origin.chainId.startsWith('near:')) return { chainFamily: 'near', walletAddress }
}

export class BackgroundNearIntentsTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly monitor: NearIntentsTransactionMonitor

  constructor() {
    this.monitor = new NearIntentsTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      fetchStatus: async (depositAddress, binding, scope) => {
        const network = DEFAULT_NETWORK
        const viewer = binding.viewer ?? readLegacyRefundViewer(binding, network)
        if (!viewer) return null
        const value = await queryOneClickOrderStatus({
          network,
          walletId: scope.keyDomainId,
          accountId: scope.accountId,
          order: {
            depositAddress,
            ...(binding.depositMemo === undefined ? {} : { depositMemo: binding.depositMemo }),
            viewer
          }
        })
        if (value === null) return null
        if (binding.userAction === 'transfer') {
          const status = parseConfidentialOneClickStatus(value, depositAddress, binding.depositMemo)
          const normalized = status.status.toUpperCase()
          return parseNearIntentsStatusObservation({
            status:
              normalized === 'SUCCESS' || normalized === 'COMPLETED'
                ? 'SUCCESS'
                : normalized === 'REFUNDED' || normalized === 'FAILED'
                  ? normalized
                  : 'PENDING',
            ...(status.settledAmountOutRaw === undefined
              ? {}
              : { amountOutRaw: status.settledAmountOutRaw }),
            originTransactionHashes: [],
            destinationTransactionHashes: status.transactionHash ? [status.transactionHash] : []
          })
        }
        const status = parseSwapStatusResponse(value)
        return parseNearIntentsStatusObservation({
          status:
            status.status === 'SUCCESS' ||
            status.status === 'REFUNDED' ||
            status.status === 'FAILED'
              ? status.status
              : 'PENDING',
          ...(status.originAsset === undefined ? {} : { originAsset: status.originAsset }),
          ...(status.destinationAsset === undefined
            ? {}
            : { destinationAsset: status.destinationAsset }),
          ...(status.swapDetails?.amountOutFormatted === undefined
            ? {}
            : { amountOutFormatted: status.swapDetails.amountOutFormatted }),
          originTransactionHashes:
            status.swapDetails?.originChainTxHashes?.map(transaction => transaction.hash) ?? [],
          destinationTransactionHashes:
            status.swapDetails?.destinationChainTxHashes?.map(transaction => transaction.hash) ?? []
        })
      },
      observeDestination: (chainId, transactionHash) =>
        this.observeDestination(chainId, transactionHash)
    })
  }

  async init(): Promise<NearIntentsTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  async handleAlarm(): Promise<NearIntentsTransactionMonitorResult> {
    return this.poll(await this.loadPersistedScopes())
  }

  private async loadPersistedScopes(): Promise<readonly TransactionAccountScope[]> {
    const snapshot = await readActiveStorageV2Snapshot(this.storageRepository)
    if (!snapshot) return Object.freeze([])
    const scopes = new Map<string, TransactionAccountScope>()
    for (const chainAccount of snapshot.chainAccounts) {
      const scope = Object.freeze({
        keyDomainId: chainAccount.scope.keyDomainId,
        accountId: chainAccount.scope.accountId
      })
      scopes.set(JSON.stringify([scope.keyDomainId, scope.accountId]), scope)
    }
    return Object.freeze([...scopes.values()])
  }

  private async observeDestination(
    chainId: string,
    transactionHash: string
  ): Promise<NearIntentsDestinationObservation | null> {
    if (chainId !== getZcashChainId(DEFAULT_NETWORK)) return null
    const rpcUrl = getNetworkConfig(DEFAULT_NETWORK).nodeRpcUrl
    if (!rpcUrl) throw new Error('Zcash destination monitor RPC is unavailable')
    const lookup = await lookupTransaction(rpcUrl, transactionHash)
    const requiredConfirmations = getRequiredConfirmations('receive')
    if (lookup.status === 'error') throw new Error('Zcash destination observation failed')
    if (lookup.status !== 'confirmed') {
      return Object.freeze({ status: 'broadcast', confirmations: 0, requiredConfirmations })
    }
    return Object.freeze({
      status: lookup.confirmations >= requiredConfirmations ? 'final' : 'confirming',
      confirmations: lookup.confirmations,
      requiredConfirmations
    })
  }

  private async poll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<NearIntentsTransactionMonitorResult> {
    const result = await this.monitor.poll(scopes)
    if (result.applied > 0) {
      await chrome.runtime.sendMessage({ type: 'TRANSACTION_STATUS_UPDATED' }).catch(() => {})
    }
    if (result.errors > 0) {
      console.warn(`[Near Intents Transaction Monitor] ${result.errors} observation(s) failed`)
    }
    if (result.pending > 0 || result.errors > 0) {
      await chrome.alarms.create(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM)
    }
    return result
  }
}
