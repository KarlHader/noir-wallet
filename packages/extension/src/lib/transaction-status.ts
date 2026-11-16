import { WALLET_CONFIG } from '../config/wallet.ts'
import type { Transaction, TransactionStatus, TransactionType } from '../types/wallet.ts'
import { isTransparentReceive, normalizeTxHash } from './tx-history-dedup.ts'

export interface ConfirmationState {
  status: TransactionStatus
  confirmations?: number
  requiredConfirmations?: number
}

export type ConfirmationTrust = 'trusted' | 'untrusted'

export interface ZcashConfirmation {
  txHash: string
  confirmations: number
}

export function getZcashConfirmationHeight(state: {
  currentHeight: number
  latestHeight: number
}): number {
  const currentHeight =
    Number.isSafeInteger(state.currentHeight) && state.currentHeight > 0 ? state.currentHeight : 0
  const latestHeight =
    Number.isSafeInteger(state.latestHeight) && state.latestHeight > 0 ? state.latestHeight : 0
  return Math.max(currentHeight, latestHeight)
}

export function getRequiredConfirmations(
  type: TransactionType,
  trust: ConfirmationTrust = 'untrusted'
): number {
  if (type === 'receive' && trust === 'trusted') {
    return WALLET_CONFIG.MIN_CONFIRMATIONS
  }

  return type === 'receive' || type === 'withdraw' || type === 'claim'
    ? WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS
    : WALLET_CONFIG.MIN_CONFIRMATIONS
}

export function isRecoverableZcashFailure(
  transaction: Pick<Transaction, 'id' | 'type' | 'status' | 'txHash'>
): boolean {
  return (
    !transaction.id.startsWith('wasm_') &&
    transaction.status === 'failed' &&
    (transaction.type === 'send' ||
      transaction.type === 'shield' ||
      transaction.type === 'receive' ||
      transaction.type === 'unshield') &&
    !!normalizeTxHash(transaction.txHash)
  )
}

export function resolveMinedTransactionStatus(
  status: string,
  minedHeight: number | null | undefined,
  chainTip: number,
  type: TransactionType,
  trust: ConfirmationTrust = 'untrusted',
  scannedHeight: number = chainTip
): ConfirmationState {
  if (status === 'expired') return { status: 'failed' }
  if (status !== 'mined') return { status: 'pending' }

  const requiredConfirmations = getRequiredConfirmations(type, trust)
  if (!minedHeight || minedHeight <= 0 || chainTip <= 0) {
    return { status: 'confirming', requiredConfirmations }
  }

  const confirmations = Math.max(0, chainTip - minedHeight + 1)
  return {
    status:
      confirmations >= requiredConfirmations && scannedHeight >= chainTip
        ? 'success'
        : 'confirming',
    confirmations,
    requiredConfirmations
  }
}

export function mergeTransactionUpdate(
  transaction: Transaction,
  updates: Partial<Transaction>,
  confirmation?: ZcashConfirmation
): Transaction {
  const currentHash = normalizeTxHash(transaction.txHash)
  const updatedHash = normalizeTxHash(updates.txHash)
  const confirmedHash = normalizeTxHash(confirmation?.txHash)
  if (
    transaction.status === 'failed' &&
    updates.status === 'success' &&
    isRecoverableZcashFailure(transaction) &&
    confirmation &&
    confirmedHash &&
    (currentHash || updatedHash) === confirmedHash &&
    (!updatedHash || updatedHash === confirmedHash) &&
    Number.isSafeInteger(confirmation.confirmations) &&
    confirmation.confirmations >= getRequiredConfirmations(transaction.type)
  ) {
    const { failureReason: _failureReason, ...recovered } = { ...transaction, ...updates }
    return {
      ...recovered,
      status: 'success',
      confirmations: confirmation.confirmations,
      requiredConfirmations: getRequiredConfirmations(transaction.type),
      notified: false
    }
  }

  // Pollers may finish out of order. Preserve finality while still accepting
  // neutral metadata such as destination hashes needed for history deduplication.
  const nextStatus = updates.status
  const isTerminal = transaction.status === 'success' || transaction.status === 'failed'
  const changesTerminalStatus = nextStatus != null && nextStatus !== transaction.status

  if (isTerminal && changesTerminalStatus) {
    const {
      status: _ignoredStatus,
      notified: _ignoredNotified,
      failureReason: _ignoredFailureReason,
      memo: _ignoredMemo,
      ...safeUpdates
    } = updates
    return { ...transaction, ...safeUpdates }
  }

  return { ...transaction, ...updates }
}

export function synchronizeInternalTransferConfirmations(
  transactions: Transaction[]
): Transaction[] {
  const sendConfirmationsByHash = new Map<string, number>()
  const unsettledSendHashes = new Set<string>()

  for (const transaction of transactions) {
    if (
      (transaction.type !== 'send' && transaction.type !== 'unshield') ||
      transaction.id.startsWith('wasm_') ||
      (transaction.status !== 'confirming' && transaction.status !== 'success')
    ) {
      continue
    }

    const txHash = normalizeTxHash(transaction.txHash)
    if (!txHash) continue
    if (transaction.status === 'confirming') unsettledSendHashes.add(txHash)

    const confirmations = Math.max(
      transaction.confirmations ?? 0,
      transaction.status === 'success' ? getRequiredConfirmations(transaction.type) : 0
    )
    if (confirmations <= 0) continue

    sendConfirmationsByHash.set(
      txHash,
      Math.max(sendConfirmationsByHash.get(txHash) ?? 0, confirmations)
    )
  }

  if (sendConfirmationsByHash.size === 0) return transactions

  return transactions.map(transaction => {
    const txHash = normalizeTxHash(transaction.txHash)
    const confirmationHint = sendConfirmationsByHash.get(txHash)
    if (confirmationHint == null) return transaction

    if (transaction.type === 'send' && !transaction.id.startsWith('wasm_')) {
      const requiredConfirmations = getRequiredConfirmations(transaction.type)
      return mergeTransactionUpdate(transaction, {
        status: transaction.status === 'success' ? 'success' : 'confirming',
        confirmations: confirmationHint,
        requiredConfirmations
      })
    }

    if (!isTransparentReceive(transaction)) return transaction

    const requiredConfirmations = getRequiredConfirmations('receive', 'trusted')
    const confirmations = Math.max(transaction.confirmations ?? 0, confirmationHint)

    return mergeTransactionUpdate(transaction, {
      status:
        !unsettledSendHashes.has(txHash) && confirmations >= requiredConfirmations
          ? 'success'
          : 'confirming',
      confirmations,
      requiredConfirmations
    })
  })
}
