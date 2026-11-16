import { mutateTransactions } from '@/lib/indexed-db'
import type { Transaction } from '@/types'
import {
  isDuplicateWasmRow,
  localShieldedSendHashSet,
  localTxHashSet
} from '@/lib/tx-history-dedup'
import {
  mergeTransactionUpdate,
  synchronizeInternalTransferConfirmations,
  type ZcashConfirmation
} from '@/lib/transaction-status'

export interface AddTransactionRequest {
  accountKey: string
  transaction: Omit<Transaction, 'id'>
}

export class TransactionRecorder {
  async addTransaction(req: AddTransactionRequest): Promise<Transaction> {
    const { accountKey, transaction } = req

    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const newTx: Transaction = { ...transaction, id }

    await mutateTransactions(accountKey, existingTxs => [...existingTxs, newTx])

    this.broadcastTransactionAdded(accountKey)

    return newTx
  }

  async updateTransaction(
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction>,
    options: { onlyIfUnsubmitted?: boolean } = {}
  ): Promise<void> {
    await mutateTransactions(accountKey, txs => {
      const updatedTxs = txs.map(tx =>
        tx.id === transactionId && (!options.onlyIfUnsubmitted || !tx.txHash)
          ? mergeTransactionUpdate(tx, updates)
          : tx
      )
      const synchronizedTxs = synchronizeInternalTransferConfirmations(updatedTxs)
      const localHashes = localTxHashSet(synchronizedTxs)
      const localShieldedSendHashes = localShieldedSendHashSet(synchronizedTxs)
      return synchronizedTxs.filter(
        tx => !isDuplicateWasmRow(tx, localHashes, localShieldedSendHashes)
      )
    })

    this.broadcastTransactionUpdated(accountKey, transactionId)
  }

  async updateTerminalTransaction(
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction> & { status: 'success' | 'failed' },
    confirmation?: ZcashConfirmation
  ): Promise<{ found: boolean; shouldNotify: boolean; statusMatches: boolean }> {
    let found = false
    let shouldNotify = false
    let statusMatches = false
    await mutateTransactions(accountKey, txs => {
      const updated = txs.map(tx => {
        if (tx.id !== transactionId) return tx
        found = true
        const { txHash: monitoredHash, ...statusUpdates } = updates
        const mergedUpdates = {
          ...statusUpdates,
          ...(!tx.txHash && monitoredHash ? { txHash: monitoredHash } : {})
        }
        const updated = mergeTransactionUpdate(tx, mergedUpdates, confirmation)
        statusMatches = updated.status === updates.status
        shouldNotify = statusMatches && (!updated.notified || updated.status !== tx.status)
        return updated
      })
      return synchronizeInternalTransferConfirmations(updated)
    })
    if (found) this.broadcastTransactionUpdated(accountKey, transactionId)
    return { found, shouldNotify, statusMatches }
  }

  async markTerminalNotified(
    accountKey: string,
    transactionId: string,
    status: 'success' | 'failed'
  ): Promise<{ found: boolean; newlyNotified: boolean }> {
    let found = false
    let newlyNotified = false
    await mutateTransactions(accountKey, txs =>
      txs.map(tx => {
        if (tx.id !== transactionId) return tx
        found = true
        if (tx.status !== status || tx.notified) return tx
        newlyNotified = true
        return { ...tx, notified: true }
      })
    )
    return { found, newlyNotified }
  }

  private broadcastTransactionAdded(accountKey: string) {
    void chrome.runtime
      .sendMessage({
        type: 'TRANSACTION_ADDED',
        accountKey
      })
      .catch(() => {})
  }

  private broadcastTransactionUpdated(accountKey: string, transactionId: string) {
    void chrome.runtime
      .sendMessage({
        type: 'TRANSACTION_UPDATED',
        accountKey,
        transactionId
      })
      .catch(() => {})
  }
}

export const transactionRecorder = new TransactionRecorder()
