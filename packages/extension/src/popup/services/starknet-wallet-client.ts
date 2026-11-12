import {
  parseTransactionGraph,
  parseTransactionId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import type { EvmTransferActivity } from './evm-transfer-activity'

export interface StarknetTransferReview {
  readonly graph: TransactionGraph
  readonly maxFeeRaw: string
  readonly deployMaxFeeRaw: string | null
  readonly invokeMaxFeeRaw: string
  readonly payloadFingerprint: string
  readonly deploysAccount: boolean
}

export interface StarknetTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

async function send<T>(
  type: string,
  payload: Record<string, unknown>,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...payload })
  if (!response || typeof response !== 'object') throw new Error('Starknet transfer failed')
  if ('error' in response && response.error) {
    throw new Error(
      typeof response.error === 'string' ? response.error : 'Starknet transfer failed'
    )
  }
  return parse((response as { result?: unknown }).result)
}

function parseReview(value: unknown): StarknetTransferReview {
  if (typeof value !== 'object' || value === null) throw new Error('Starknet review is invalid')
  const record = value as Record<string, unknown>
  const graph = parseTransactionGraph(record.graph)
  if (typeof record.maxFeeRaw !== 'string' || typeof record.payloadFingerprint !== 'string') {
    throw new Error('Starknet review is invalid')
  }
  return {
    graph,
    maxFeeRaw: record.maxFeeRaw,
    deployMaxFeeRaw: typeof record.deployMaxFeeRaw === 'string' ? record.deployMaxFeeRaw : null,
    invokeMaxFeeRaw:
      typeof record.invokeMaxFeeRaw === 'string' ? record.invokeMaxFeeRaw : record.maxFeeRaw,
    payloadFingerprint: record.payloadFingerprint,
    deploysAccount: record.deploysAccount === true
  }
}

function parseSubmission(value: unknown): StarknetTransferSubmission {
  if (typeof value !== 'object' || value === null) throw new Error('Starknet submission is invalid')
  const record = value as Record<string, unknown>
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Starknet submission is invalid')
  }
  return { status: record.status, graph: parseTransactionGraph(record.graph) }
}

export const starknetWalletClient = {
  prepareTransfer(intent: {
    readonly assetId: string
    readonly recipient: string
    readonly amountRaw: string
  }) {
    return send('PREPARE_STARKNET_TRANSFER', { intent }, parseReview)
  },
  quoteMaximum(assetId: string) {
    return send('QUOTE_STARKNET_TRANSFER_MAX', { intent: { assetId } }, value =>
      typeof value === 'string' || value === null ? value : null
    )
  },
  approveTransfer(transactionId: TransactionId, payloadFingerprint: string) {
    return send(
      'APPROVE_STARKNET_TRANSFER',
      { transactionId: parseTransactionId(transactionId), payloadFingerprint },
      parseSubmission
    )
  },
  rejectTransfer(transactionId: TransactionId) {
    return send(
      'REJECT_STARKNET_TRANSFER',
      { transactionId: parseTransactionId(transactionId) },
      value => parseTransactionGraph(value)
    )
  },
  resumeTransfer(transactionId: TransactionId) {
    return send(
      'RESUME_STARKNET_TRANSFER',
      { transactionId: parseTransactionId(transactionId) },
      parseSubmission
    )
  },
  getTransferActivity(_graph: TransactionGraph): Promise<EvmTransferActivity | null> {
    return Promise.resolve(null)
  }
}
