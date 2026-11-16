import { WALLET_CONFIG } from '@/config/wallet'
import { getNetworkConfig } from '@/lib/runtime-network'
import { fetchSwapStatus } from '@/core/services/intents-api'
import { formatChainName } from '@/lib/format'
import { getCrossChainCompletionStatus } from '@/lib/cross-chain-transaction'
import { getTransactionConfirmations } from '@/lib/zcash-node-rpc'
import type { Transaction } from '@/types'

const ORPHAN_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000

async function checkZcashTransactionOnChain(
  transactionHash: string,
  network: 'mainnet' | 'testnet'
): Promise<boolean> {
  const rpcUrl = getNetworkConfig(network).nodeRpcUrl
  if (!rpcUrl) return false

  const confirmations = await getTransactionConfirmations(rpcUrl, transactionHash)
  return confirmations !== null && confirmations >= WALLET_CONFIG.MIN_CONFIRMATIONS
}

export async function recheckPendingTransaction(
  transaction: Transaction,
  now = Date.now()
): Promise<Partial<Transaction> | null> {
  if (
    transaction.status === 'relay_confirmed' &&
    getCrossChainCompletionStatus(transaction.type, {
      destinationAsset: transaction.quoteBinding?.destinationAsset
    }) === 'success'
  ) {
    return { status: 'success', notified: true }
  }

  if (transaction.depositAddress) {
    const status = await fetchSwapStatus(transaction.depositAddress)
    if (!status) return null
    if (status.status === 'SUCCESS' || status.status === 'FAILED' || status.status === 'REFUNDED') {
      const completionStatus =
        status.status === 'SUCCESS'
          ? getCrossChainCompletionStatus(transaction.type, {
              destinationAsset:
                status.destinationAsset || transaction.quoteBinding?.destinationAsset
            })
          : 'failed'
      const updates: Partial<Transaction> = {
        status: completionStatus,
        notified: completionStatus === 'success'
      }
      const chainHashes: { hash: string; chain: string }[] = []
      status.swapDetails?.originChainTxHashes?.forEach(hash => {
        chainHashes.push({ hash: hash.hash, chain: formatChainName('near') })
      })
      status.swapDetails?.destinationChainTxHashes?.forEach(hash => {
        chainHashes.push({ hash: hash.hash, chain: formatChainName('zec') })
      })
      if (chainHashes.length > 0) updates.chainHashes = chainHashes
      if (status.status === 'REFUNDED') updates.memo = 'Refunded'
      return updates
    }
    return null
  }

  if (
    transaction.txHash &&
    (transaction.type === 'send' ||
      transaction.type === 'shield' ||
      transaction.type === 'unshield')
  ) {
    const confirmed = await checkZcashTransactionOnChain(transaction.txHash, transaction.network)
    return confirmed ? { status: 'success', notified: true } : null
  }

  if (!transaction.txHash && now - transaction.timestamp > ORPHAN_TRANSACTION_TIMEOUT_MS) {
    return { status: 'failed', notified: true }
  }

  return null
}
