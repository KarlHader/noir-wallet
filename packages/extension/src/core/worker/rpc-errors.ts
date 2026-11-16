import { TimeoutError } from '../../lib/async-utils'
import {
  isTransactionSubmissionUnknown,
  TransactionSubmissionUnknownError
} from '@/core/zcash/transfer-result'

export interface WorkerRpcErrorResponse {
  error: string
  errorType?: 'timeout' | 'submission_unknown'
  txId?: string
  txIds?: string[]
}

const isBoundedTransactionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value)

function boundedTransactionIds(txId: string, value: unknown): string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every(isBoundedTransactionId) &&
    value.includes(txId)
    ? [...value]
    : [txId]
}

export function encodeWorkerRpcError(error: unknown): WorkerRpcErrorResponse {
  return {
    error: error instanceof Error ? error.message : 'Worker RPC routing failed',
    ...(error instanceof TimeoutError ? { errorType: 'timeout' as const } : {}),
    ...(isTransactionSubmissionUnknown(error) && isBoundedTransactionId(error.txId)
      ? {
          errorType: 'submission_unknown' as const,
          txId: error.txId,
          txIds: boundedTransactionIds(error.txId, error.txIds)
        }
      : {})
  }
}

export function decodeWorkerRpcError(response: WorkerRpcErrorResponse): Error {
  if (response.errorType === 'submission_unknown' && isBoundedTransactionId(response.txId)) {
    return new TransactionSubmissionUnknownError(
      response.txId,
      response.error,
      boundedTransactionIds(response.txId, response.txIds)
    )
  }
  return response.errorType === 'timeout'
    ? new TimeoutError(response.error)
    : new Error(response.error)
}
