import type { AccountAddresses, Transaction } from '../../types/wallet.ts'
import type { ZcashTransactionContext } from '../worker/types.ts'
import { isDuplicateWasmRow, localTxHashSet, normalizeTxHash } from '../../lib/tx-history-dedup.ts'
import {
  applyTransactionBroadcast,
  applyZcashWorkerBroadcast
} from '../../lib/transaction-replacement.ts'
import {
  mergeTransactionUpdate,
  synchronizeInternalTransferConfirmations,
  type ZcashConfirmation
} from '../../lib/transaction-status.ts'
import {
  applyExternalReceiveConfirmations,
  associateIncomingIntentsTransactions,
  mergeTransactionsWithWasmHistory
} from './transparent-history.ts'

type TerminalStatus = 'success' | 'failed'

export type LocalZcashActivityWrite =
  | { kind: 'add'; transaction: Transaction }
  | {
      kind: 'update'
      id: string
      updates: Partial<Transaction>
      onlyIfUnsubmitted?: boolean
    }
  | {
      kind: 'terminal'
      id: string
      updates: Partial<Transaction> & { status: TerminalStatus }
      confirmation?: ZcashConfirmation
    }
  | { kind: 'notified'; id: string; status: TerminalStatus }
  | { kind: 'broadcast'; id: string; hash: string; hashes: string[]; expiryHeight?: number }
  | {
      kind: 'worker-broadcast'
      context: ZcashTransactionContext
      walletId: string
      result: { txHash: string; txHashes: string[] }
    }
  | {
      kind: 'history'
      wasm?: Transaction[]
      receipts: Transaction[]
      addresses?: AccountAddresses
    }
  | { kind: 'receive-confirmations'; observed: ReadonlyMap<string, number> }
  | {
      kind: 'recipients'
      addresses: ReadonlyMap<string, string>
      originalAmounts: ReadonlyMap<string, string>
    }

function updateRows(
  current: Transaction[],
  update: (transaction: Transaction) => Transaction
): Transaction[] {
  const next = current.map(update)
  return next.every((transaction, index) => transaction === current[index]) ? current : next
}

export function applyLocalZcashActivityWrite(
  current: Transaction[],
  write: LocalZcashActivityWrite
): { transactions: Transaction[]; newWasmTransactionCount?: number } {
  if (write.kind === 'history') {
    const merged = mergeTransactionsWithWasmHistory(
      current,
      write.wasm ?? [],
      write.receipts,
      write.addresses
    )
    return { ...merged, transactions: associateIncomingIntentsTransactions(merged.transactions) }
  }

  let next: Transaction[]
  switch (write.kind) {
    case 'add':
      if (current.some(transaction => transaction.id === write.transaction.id)) {
        throw new Error('Transaction ID already exists')
      }
      next = [...current, write.transaction]
      break
    case 'update':
    case 'terminal':
      next = updateRows(current, transaction => {
        if (transaction.id !== write.id) return transaction
        if (write.kind === 'update' && write.onlyIfUnsubmitted && transaction.txHash) {
          return transaction
        }
        const { id: _id, network: _network, txHash, ...updates } = write.updates
        const evidence = !transaction.txHash && txHash ? { ...updates, txHash } : updates
        const merged = mergeTransactionUpdate(
          transaction,
          evidence,
          write.kind === 'terminal' ? write.confirmation : undefined
        )
        return (Object.keys(evidence) as (keyof Transaction)[]).every(
          key => merged[key] === transaction[key]
        )
          ? transaction
          : merged
      })
      break
    case 'notified':
      return {
        transactions: updateRows(current, transaction =>
          transaction.id === write.id &&
          transaction.status === write.status &&
          !transaction.notified
            ? { ...transaction, notified: true }
            : transaction
        )
      }
    case 'broadcast':
      next = applyTransactionBroadcast(
        current,
        write.id,
        write.hash,
        write.expiryHeight,
        write.hashes
      )
      break
    case 'worker-broadcast':
      next = applyZcashWorkerBroadcast(current, write.context, write.walletId, write.result)
      break
    case 'receive-confirmations':
      next = applyExternalReceiveConfirmations(current, write.observed)
      break
    case 'recipients':
      next = updateRows(current, transaction => {
        if (transaction.type !== 'send' || transaction.to) return transaction
        const hash = normalizeTxHash(transaction.txHash)
        if (write.originalAmounts.get(hash) !== transaction.amount) return transaction
        const to = write.addresses.get(hash)
        return to ? { ...transaction, to } : transaction
      })
      break
  }

  if (next === current) return { transactions: current }
  const synchronized = synchronizeInternalTransferConfirmations(next)
  const localHashes = localTxHashSet(synchronized)
  return {
    transactions: synchronized.filter(transaction => !isDuplicateWasmRow(transaction, localHashes))
  }
}
