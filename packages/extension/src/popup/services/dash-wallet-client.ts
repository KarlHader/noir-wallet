import {
  parseTransactionGraph,
  parseTransactionId,
  TRANSACTION_FAILURE_CODES,
  TRANSACTION_LIFECYCLE_STATUSES,
  type TransactionFailureCode,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus
} from '@/core/transactions/domain'
import type { SigningSummary } from '@/core/keyring/domain'
import type { EvmTransferActivity } from '@/popup/services/evm-transfer-activity'

export interface DashTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: SigningSummary
    readonly payloadFingerprint: { readonly algorithm: 'sha256'; readonly digestHex: string }
    readonly expiresAt: number
  }
}

export interface DashTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface DashExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type DashTransferApprovalResult = DashTransferSubmission | DashExternalSignatureRequired

export interface DashTransferIntent {
  readonly recipient: string
  readonly amount:
    | { readonly mode: 'exact'; readonly valueDuffs: string }
    | { readonly mode: 'max' }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

async function send(message: Record<string, unknown>): Promise<unknown> {
  const response = await chrome.runtime.sendMessage(message)
  const record = readRecord(response, 'Dash transfer response')
  if (typeof record.error === 'string') throw new Error(record.error)
  if (!Object.prototype.hasOwnProperty.call(record, 'result')) {
    throw new Error('Dash wallet is unavailable')
  }
  return record.result
}

function parseDashTransferStatus(value: unknown): EvmTransferActivity | null {
  if (value === null) return null
  const record = readRecord(value, 'Dash transfer status')
  if (
    typeof record.status !== 'string' ||
    !(TRANSACTION_LIFECYCLE_STATUSES as readonly string[]).includes(record.status) ||
    !Number.isSafeInteger(record.updatedAt) ||
    (record.updatedAt as number) < 0
  ) {
    throw new Error('Invalid Dash transfer status')
  }
  const status = record.status as TransactionLifecycleStatus
  const updatedAt = record.updatedAt as number
  const transactionHash =
    typeof record.transactionHash === 'string' ? record.transactionHash : undefined
  const confirmations = parseOptionalCount(record.confirmations)
  const requiredConfirmations = parseOptionalCount(record.requiredConfirmations)
  const failureCode =
    typeof record.failureCode === 'string' &&
    (TRANSACTION_FAILURE_CODES as readonly string[]).includes(record.failureCode)
      ? (record.failureCode as TransactionFailureCode)
      : undefined
  return {
    status,
    updatedAt,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(confirmations === undefined ? {} : { confirmations }),
    ...(requiredConfirmations === undefined ? {} : { requiredConfirmations }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(record.reconfirming === true ? { reconfirming: true as const } : {})
  }
}

function parseOptionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid Dash transfer status')
  }
  return value as number
}

function parseReview(value: unknown): DashTransferReview {
  const record = readRecord(value, 'Dash transfer review')
  const review = readRecord(record.review, 'Dash transfer review')
  const fingerprint = readRecord(review.payloadFingerprint, 'Dash payload fingerprint')
  if (
    review.operation !== 'transaction' ||
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    typeof review.expiresAt !== 'number'
  ) {
    throw new Error('Invalid Dash transfer review')
  }
  return {
    graph: parseTransactionGraph(record.graph),
    review: {
      chainId: String(review.chainId),
      operation: 'transaction',
      summary: review.summary as SigningSummary,
      payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint.digestHex },
      expiresAt: review.expiresAt
    }
  }
}

function parseSubmission(value: unknown): DashTransferSubmission {
  const record = readRecord(value, 'Dash transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid Dash transfer submission')
  }
  return { status: record.status, graph: parseTransactionGraph(record.graph) }
}

function parseApprovalResult(value: unknown): DashTransferApprovalResult {
  const record = readRecord(value, 'Dash transfer submission')
  if (record.status !== 'external-signature-required') return parseSubmission(value)
  const graph = parseTransactionGraph(record.graph)
  if (
    typeof record.transactionId !== 'string' ||
    record.transactionId !== graph.root.id ||
    typeof record.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.payloadFingerprint) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) < 0
  ) {
    throw new Error('Invalid Dash transfer submission')
  }
  return {
    status: 'external-signature-required',
    graph,
    transactionId: parseTransactionId(record.transactionId),
    payloadFingerprint: record.payloadFingerprint,
    expiresAt: record.expiresAt as number
  }
}

export const dashWalletClient = Object.freeze({
  prepareTransfer(intent: DashTransferIntent): Promise<DashTransferReview> {
    return send({ type: 'PREPARE_DASH_TRANSFER', intent }).then(parseReview)
  },
  getPendingTransfer(transactionId: TransactionId): Promise<DashTransferReview | null> {
    return send({
      type: 'GET_PENDING_DASH_TRANSFER',
      transactionId: parseTransactionId(transactionId)
    }).then(value => (value === null ? null : parseReview(value)))
  },
  approveTransfer(
    transactionId: TransactionId,
    payloadFingerprint: string
  ): Promise<DashTransferApprovalResult> {
    return send({
      type: 'APPROVE_DASH_TRANSFER',
      transactionId: parseTransactionId(transactionId),
      payloadFingerprint
    }).then(parseApprovalResult)
  },
  rejectTransfer(transactionId: TransactionId): Promise<void> {
    return send({
      type: 'REJECT_DASH_TRANSFER',
      transactionId: parseTransactionId(transactionId)
    }).then(() => undefined)
  },
  resumeTransfer(transactionId: TransactionId): Promise<DashTransferSubmission> {
    return send({
      type: 'RESUME_DASH_TRANSFER',
      transactionId: parseTransactionId(transactionId)
    }).then(parseSubmission)
  },
  getTransferActivity(graph: TransactionGraph): Promise<EvmTransferActivity | null> {
    return send({
      type: 'REFRESH_DASH_TRANSFER_STATUS',
      transactionId: graph.root.id
    }).then(parseDashTransferStatus)
  }
})
