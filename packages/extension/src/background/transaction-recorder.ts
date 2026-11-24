import { writeLocalActivity } from '@/infrastructure/persistence/repositories/local-activity'
import type { Transaction } from '@/types'
import type { ZcashConfirmation } from '@/lib/transaction-status'

export interface AddTransactionRequest {
  accountKey: string
  transaction: Omit<Transaction, 'id'>
}

export class TransactionRecorder {
  async addTransaction(req: AddTransactionRequest): Promise<Transaction> {
    const { accountKey, transaction } = req

    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const newTx: Transaction = { ...transaction, id }

    await writeLocalActivity('legacy-zcash', accountKey, { kind: 'add', transaction: newTx })

    this.broadcastTransactionAdded(accountKey)

    return newTx
  }

  async updateTransaction(
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction>,
    options: { onlyIfUnsubmitted?: boolean } = {}
  ): Promise<void> {
    const result = await writeLocalActivity('legacy-zcash', accountKey, {
      kind: 'update',
      id: transactionId,
      updates,
      onlyIfUnsubmitted: options.onlyIfUnsubmitted
    })
    if (result.changed) this.broadcastTransactionUpdated(accountKey, transactionId)
  }

  async updateTerminalTransaction(
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction> & { status: 'success' | 'failed' },
    confirmation?: ZcashConfirmation
  ): Promise<{ found: boolean; shouldNotify: boolean; statusMatches: boolean }> {
    const result = await writeLocalActivity('legacy-zcash', accountKey, {
      kind: 'terminal',
      id: transactionId,
      updates,
      confirmation
    })
    const previous = result.previous.find(transaction => transaction.id === transactionId)
    const transaction = result.transactions.find(transaction => transaction.id === transactionId)
    const found = Boolean(previous)
    const statusMatches = transaction?.status === updates.status
    const shouldNotify =
      statusMatches && (!transaction.notified || previous?.status !== transaction.status)
    if (result.changed) this.broadcastTransactionUpdated(accountKey, transactionId)
    return { found, shouldNotify, statusMatches }
  }

  async markTerminalNotified(
    accountKey: string,
    transactionId: string,
    status: 'success' | 'failed'
  ): Promise<{ found: boolean; newlyNotified: boolean }> {
    const result = await writeLocalActivity('legacy-zcash', accountKey, {
      kind: 'notified',
      id: transactionId,
      status
    })
    const previous = result.previous.find(transaction => transaction.id === transactionId)
    return { found: Boolean(previous), newlyNotified: result.changed }
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
