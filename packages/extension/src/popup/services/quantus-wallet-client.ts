import {
  QUANTUS_WALLET_RUNTIME_ERROR_CODES,
  createQuantusWalletRuntimeError,
  parseQuantusAddress,
  type QuantusWalletRuntimeErrorCode
} from '@/core/chains/quantus'
import { parseChainId } from '@/core/chains/registry'
import { parseSigningSummary, type QuantusTransferSummary } from '@/core/keyring/domain'
import {
  parseTransactionGraph,
  parseTransactionId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'

import type { EvmTransferActivity } from './evm-transfer-activity'

export interface QuantusTransferIntent {
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive?: boolean
}

export interface QuantusTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: QuantusTransferSummary
    readonly payloadFingerprint: {
      readonly algorithm: 'sha256'
      readonly digestHex: string
    }
    readonly expiresAt: number
  }
}

export interface QuantusTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export type QuantusWalletClientErrorCode = QuantusWalletRuntimeErrorCode | 'invalid-response'

export class QuantusWalletClientError extends Error {
  readonly code: QuantusWalletClientErrorCode

  constructor(code: QuantusWalletClientErrorCode, message: string) {
    super(message)
    this.name = 'QuantusWalletClientError'
    this.code = code
  }
}

export interface QuantusWalletClient {
  readonly prepareTransfer: (intent: QuantusTransferIntent) => Promise<QuantusTransferReview>
  readonly getPendingTransfer: (
    transactionId: TransactionId
  ) => Promise<QuantusTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<QuantusTransferSubmission>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<QuantusTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<EvmTransferActivity | null>
}

export type QuantusRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

const MAXIMUM_U128 = (1n << 128n) - 1n
const runtimeErrorCodes = new Set<QuantusWalletRuntimeErrorCode>(QUANTUS_WALLET_RUNTIME_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuantusWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new QuantusWalletClientError('invalid-response', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new QuantusWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseRuntimeError(value: unknown): QuantusWalletClientError {
  const record = readRecord(value, 'Quantus runtime error')
  assertExactKeys(record, ['code', 'message'], 'Quantus runtime error')
  if (
    typeof record.code !== 'string' ||
    !runtimeErrorCodes.has(record.code as QuantusWalletRuntimeErrorCode) ||
    typeof record.message !== 'string'
  ) {
    throw new QuantusWalletClientError('invalid-response', 'Invalid Quantus runtime error')
  }
  const canonical = createQuantusWalletRuntimeError(record.code as QuantusWalletRuntimeErrorCode)
  if (record.message !== canonical.message) {
    throw new QuantusWalletClientError('invalid-response', 'Invalid Quantus runtime error')
  }
  return new QuantusWalletClientError(canonical.code, canonical.message)
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'Quantus runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'Quantus runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'Quantus runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof QuantusWalletClientError) throw error
    throw new QuantusWalletClientError('invalid-response', 'Invalid Quantus runtime result')
  }
}

function parseIntent(value: QuantusTransferIntent): QuantusTransferIntent {
  const record = readRecord(value, 'Quantus transfer intent')
  const required = ['recipient', 'amountRaw']
  const allowed = ['recipient', 'amountRaw', 'keepAlive']
  if (
    !required.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !allowed.includes(key)) ||
    typeof record.amountRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(record.amountRaw) ||
    BigInt(record.amountRaw) > MAXIMUM_U128 ||
    (record.keepAlive !== undefined && typeof record.keepAlive !== 'boolean')
  ) {
    throw new Error('Invalid Quantus transfer intent')
  }
  return Object.freeze({
    recipient: parseQuantusAddress(record.recipient, 'Quantus recipient'),
    amountRaw: record.amountRaw,
    ...(record.keepAlive === undefined ? {} : { keepAlive: record.keepAlive })
  })
}

function parseReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: QuantusTransferIntent
): QuantusTransferReview {
  const record = readRecord(value, 'Quantus transfer review')
  assertExactKeys(record, ['graph', 'review'], 'Quantus transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared' || graph.root.kind !== 'transfer') {
    throw new Error('Quantus transfer review requires a prepared transfer')
  }
  if (expectedTransactionId !== undefined && graph.root.id !== expectedTransactionId) {
    throw new Error('Quantus transaction response does not match the request')
  }
  const review = readRecord(record.review, 'Quantus signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'Quantus signing review'
  )
  if (typeof review.chainId !== 'string' || review.operation !== 'transaction') {
    throw new Error('Invalid Quantus signing context')
  }
  const chain = parseChainId(review.chainId)
  if (chain.namespace !== 'quantus') throw new Error('Invalid Quantus signing chain')
  const fingerprint = readRecord(review.payloadFingerprint, 'Quantus payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'Quantus payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid Quantus payload fingerprint')
  }
  if (!Number.isSafeInteger(review.expiresAt) || (review.expiresAt as number) < 0) {
    throw new Error('Invalid Quantus signing expiry')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'quantus',
    chainId: chain.id,
    operation: 'transaction'
  })
  if (summary.schema !== 'quantus.transfer.v1') throw new Error('Invalid Quantus review summary')
  const intent = graph.root.intent
  const segments = graph.segments.filter(
    candidate =>
      candidate.role === 'origin' &&
      candidate.target.kind === 'onchain' &&
      candidate.target.chainId === chain.id
  )
  if (
    segments.length !== 1 ||
    graph.segments.length !== 1 ||
    intent?.schemaVersion !== 1 ||
    intent.sender?.chainId !== chain.id ||
    intent.recipient?.chainId !== chain.id ||
    intent.sender.address !== summary.fields.signerAddress ||
    intent.recipient.address !== summary.fields.recipient ||
    intent.primaryAmount?.assetId !== `${chain.id}/slip44:189189` ||
    intent.primaryAmount.amountRaw !== summary.fields.amountRaw ||
    intent.feeLimit?.amountRaw !== summary.fields.feeLimitRaw
  ) {
    throw new Error('Quantus signing review does not match its transaction graph')
  }
  if (
    expectedIntent &&
    (intent.recipient.address !== expectedIntent.recipient ||
      intent.primaryAmount.amountRaw !== expectedIntent.amountRaw)
  ) {
    throw new Error('Quantus transfer response does not match the requested intent')
  }
  return Object.freeze({
    graph,
    review: Object.freeze({
      chainId: chain.id,
      operation: 'transaction' as const,
      summary,
      payloadFingerprint: Object.freeze({
        algorithm: 'sha256' as const,
        digestHex: fingerprint.digestHex as string
      }),
      expiresAt: review.expiresAt as number
    })
  })
}

function parseSubmission(value: unknown, transactionId: TransactionId): QuantusTransferSubmission {
  const record = readRecord(value, 'Quantus transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'Quantus transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid Quantus transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.id !== transactionId || graph.root.status !== expectedStatus) {
    throw new Error('Quantus transfer submission does not match its transaction')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseClientInput<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof QuantusWalletClientError) throw error
    throw new QuantusWalletClientError('invalid-request', 'The Quantus wallet request is invalid')
  }
}

function toActivity(graph: TransactionGraph): EvmTransferActivity | null {
  const segment = graph.segments.find(candidate => candidate.role === 'origin')
  if (!segment) return null
  return Object.freeze({
    status: graph.root.status,
    updatedAt: graph.root.updatedAt,
    ...(segment.evidence?.transactionHash === undefined
      ? {}
      : { transactionHash: segment.evidence.transactionHash }),
    ...(segment.evidence?.replacementTransactionHash === undefined
      ? {}
      : { replacementTransactionHash: segment.evidence.replacementTransactionHash }),
    ...(segment.evidence?.confirmations === undefined
      ? {}
      : { confirmations: segment.evidence.confirmations }),
    ...(segment.evidence?.requiredConfirmations === undefined
      ? {}
      : { requiredConfirmations: segment.evidence.requiredConfirmations }),
    ...(graph.root.failure === undefined ? {} : { failureCode: graph.root.failure.code }),
    ...(graph.root.reconfirming === true ? { reconfirming: true as const } : {})
  })
}

export function createQuantusWalletClient(
  sendMessage: QuantusRuntimeMessenger
): QuantusWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parser: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parser)

  return Object.freeze({
    prepareTransfer: async (intentValue: QuantusTransferIntent) => {
      const intent = parseClientInput(() => parseIntent(intentValue))
      return send({ type: 'PREPARE_QUANTUS_TRANSFER', intent }, value =>
        parseReview(value, undefined, intent)
      )
    },
    getPendingTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'GET_PENDING_QUANTUS_TRANSFER', transactionId }, value =>
        value === null ? null : parseReview(value, transactionId)
      )
    },
    approveTransfer: async (transactionIdValue: TransactionId, fingerprintValue: string) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      const payloadFingerprint = parseClientInput(() => {
        if (!/^[0-9a-f]{64}$/.test(fingerprintValue)) throw new Error('Invalid fingerprint')
        return fingerprintValue
      })
      return send({ type: 'APPROVE_QUANTUS_TRANSFER', transactionId, payloadFingerprint }, value =>
        parseSubmission(value, transactionId)
      )
    },
    rejectTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'REJECT_QUANTUS_TRANSFER', transactionId }, value => {
        const graph = parseTransactionGraph(value)
        if (graph.root.id !== transactionId) {
          throw new Error('Quantus rejection does not match its transaction')
        }
        return graph
      })
    },
    resumeTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'RESUME_QUANTUS_TRANSFER', transactionId }, value =>
        parseSubmission(value, transactionId)
      )
    },
    getTransferActivity: async (graphValue: TransactionGraph) => {
      const graph = parseClientInput(() => parseTransactionGraph(graphValue))
      return send({ type: 'GET_QUANTUS_TRANSFER_STATUS', transactionId: graph.root.id }, value => {
        if (value === null) return null
        const record = readRecord(value, 'Quantus transfer status')
        assertExactKeys(record, ['graph'], 'Quantus transfer status')
        const persisted = parseTransactionGraph(record.graph)
        if (persisted.root.id !== graph.root.id) {
          throw new Error('Quantus transfer status does not match its transaction')
        }
        return toActivity(persisted)
      })
    }
  })
}

export const quantusWalletClient = createQuantusWalletClient(message =>
  chrome.runtime.sendMessage(message)
)
