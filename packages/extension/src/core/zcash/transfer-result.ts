import type {
  TransferEstimate,
  TransferResult,
  TransferSubmissionStatus
} from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { MAX_MARGINAL_FEE_ZATS } from '../../config/fee'

export type { TransferEstimate, TransferResult }

const SUBMISSION_STATUSES = new Set<TransferSubmissionStatus>([
  'submitted',
  'rejected',
  'unknown',
  'not_attempted'
])

export class TransactionSubmissionUnknownError extends Error {
  readonly txId: string
  readonly txIds: string[]

  constructor(txId: string, diagnosticMessage?: string, txIds: string[] = [txId]) {
    super(
      diagnosticMessage ||
        'Transaction submission could not be confirmed. Check Activity before trying again.'
    )
    this.name = 'TransactionSubmissionUnknown'
    this.txId = txId
    this.txIds = txIds
  }
}

export function isTransactionSubmissionUnknown(
  error: unknown
): error is Error & { txId: string; txIds?: string[] } {
  return (
    error instanceof Error &&
    error.name === 'TransactionSubmissionUnknown' &&
    typeof (error as Error & { txId?: unknown }).txId === 'string' &&
    (error as Error & { txId: string }).txId.length > 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isZatsString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

export function parseTransferEstimate(
  value: unknown,
  expectedMarginalFeeZats?: number
): TransferEstimate {
  if (
    !isRecord(value) ||
    !isZatsString(value.amountZats) ||
    !isZatsString(value.feeZats) ||
    !isZatsString(value.marginalFeeZats) ||
    !Number.isSafeInteger(Number(value.marginalFeeZats)) ||
    Number(value.marginalFeeZats) <= 0 ||
    Number(value.marginalFeeZats) > MAX_MARGINAL_FEE_ZATS * 4 ||
    !Number.isSafeInteger(value.transactionCount) ||
    (value.transactionCount as number) < 1 ||
    !Array.isArray(value.stepFeesZats) ||
    value.stepFeesZats.length !== value.transactionCount ||
    !value.stepFeesZats.every(isZatsString)
  ) {
    throw new Error('Invalid transfer estimate returned by WASM')
  }

  const totalFee = value.stepFeesZats.reduce((sum, fee) => sum + BigInt(fee), 0n)
  if (totalFee !== BigInt(value.feeZats)) {
    throw new Error('Transfer estimate fee total does not match its steps')
  }
  if (
    expectedMarginalFeeZats !== undefined &&
    BigInt(value.marginalFeeZats) !== BigInt(expectedMarginalFeeZats)
  ) {
    throw new Error('Transfer estimate does not use the confirmed network fee')
  }

  return value as unknown as TransferEstimate
}

export function parseTransferResult(value: unknown): TransferResult {
  if (
    !isRecord(value) ||
    !['success', 'partial', 'failed', 'unknown'].includes(String(value.status)) ||
    !Array.isArray(value.txIds) ||
    value.txIds.length < 1 ||
    !value.txIds.every(txId => typeof txId === 'string' && txId.length > 0) ||
    typeof value.finalTxId !== 'string' ||
    value.finalTxId !== value.txIds.at(-1) ||
    !Array.isArray(value.transactions) ||
    value.transactions.length !== value.txIds.length
  ) {
    throw new Error('Invalid transfer result returned by WASM')
  }

  const txIds = value.txIds
  const transactionsValid = value.transactions.every((transaction, index) => {
    if (!isRecord(transaction)) return false
    return (
      transaction.txId === txIds[index] &&
      typeof transaction.status === 'string' &&
      SUBMISSION_STATUSES.has(transaction.status as TransferSubmissionStatus) &&
      (transaction.errorCode === undefined || Number.isInteger(transaction.errorCode)) &&
      (transaction.errorMessage === undefined || typeof transaction.errorMessage === 'string')
    )
  })
  if (!transactionsValid) {
    throw new Error('Invalid transfer transaction details returned by WASM')
  }

  const submittedCount = value.transactions.filter(
    transaction => transaction.status === 'submitted'
  ).length
  const unknownCount = value.transactions.filter(
    transaction => transaction.status === 'unknown'
  ).length
  const statusValid =
    (value.status === 'success' && submittedCount === value.transactions.length) ||
    (value.status === 'partial' &&
      submittedCount > 0 &&
      unknownCount === 0 &&
      submittedCount < value.transactions.length) ||
    (value.status === 'failed' && submittedCount === 0 && unknownCount === 0) ||
    (value.status === 'unknown' && unknownCount > 0)
  if (!statusValid) {
    throw new Error('Transfer result status does not match its submissions')
  }

  return value as unknown as TransferResult
}

export function requireSuccessfulTransfer(result: TransferResult): {
  txHash: string
  txHashes: string[]
} {
  if (result.status === 'success') {
    return { txHash: result.finalTxId, txHashes: result.txIds }
  }

  if (result.status === 'unknown') {
    const uncertain = result.transactions.find(transaction => transaction.status === 'unknown')
    throw new TransactionSubmissionUnknownError(
      uncertain?.txId ?? result.finalTxId,
      uncertain?.errorMessage,
      [...result.txIds]
    )
  }

  const submittedTxIds = result.transactions
    .filter(transaction => transaction.status === 'submitted')
    .map(transaction => transaction.txId)
  const firstError = result.transactions.find(transaction => transaction.errorMessage)?.errorMessage

  if (submittedTxIds.length > 0) {
    throw new Error(
      `Transfer was partially submitted (${submittedTxIds.length}/${result.transactions.length}). ` +
        `Wait for wallet sync before retrying. Submitted transaction IDs: ${submittedTxIds.join(', ')}`
    )
  }

  throw new Error(firstError || 'Transfer was not submitted')
}
