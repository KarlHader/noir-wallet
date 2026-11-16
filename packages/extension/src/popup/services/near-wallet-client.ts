import {
  NEAR_WALLET_RUNTIME_ERROR_CODES,
  createNearWalletRuntimeError,
  parseNearAccountId,
  type NearWalletRuntimeErrorCode
} from '@/core/chains/near'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseSigningSummary, type NearTransactionSummary } from '@/core/keyring/domain'
import {
  parseTransactionGraph,
  parseTransactionId,
  type NearIntentsTransactionBinding,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import { parseNearLendingSupplyBinding } from '@/core/chains/near/near-burrow-supply-binding'

import {
  parseNearTransferActivityResponse,
  type EvmTransferActivity as NearTransferActivity
} from './evm-transfer-activity'

export interface NearTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

export interface NearTransferReview {
  readonly graph: TransactionGraph
  readonly debit: {
    readonly maximumFeeRaw: string
    readonly storageReserveRaw: string
  }
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: NearTransactionSummary
    readonly payloadFingerprint: {
      readonly algorithm: 'sha256'
      readonly digestHex: string
    }
    readonly expiresAt: number
  }
}

export interface NearTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export type NearWalletClientErrorCode = NearWalletRuntimeErrorCode | 'invalid-response'

export class NearWalletClientError extends Error {
  readonly code: NearWalletClientErrorCode

  constructor(code: NearWalletClientErrorCode, message: string) {
    super(message)
    this.name = 'NearWalletClientError'
    this.code = code
  }
}

export interface NearWalletClient {
  readonly prepareTransfer: (
    intent: NearTransferIntent,
    options?: Readonly<{
      nearIntentsBinding?: NearIntentsTransactionBinding
    }>
  ) => Promise<NearTransferReview>
  readonly getPendingTransfer: (transactionId: TransactionId) => Promise<NearTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<NearTransferSubmission>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<NearTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<NearTransferActivity | null>
}

export type NearRuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const runtimeErrorCodes = new Set<NearWalletRuntimeErrorCode>(NEAR_WALLET_RUNTIME_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NearWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NearWalletClientError('invalid-response', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new NearWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseRuntimeError(value: unknown): NearWalletClientError {
  const record = readRecord(value, 'NEAR runtime error')
  assertExactKeys(record, ['code', 'message'], 'NEAR runtime error')
  if (
    typeof record.code !== 'string' ||
    !runtimeErrorCodes.has(record.code as NearWalletRuntimeErrorCode) ||
    typeof record.message !== 'string'
  ) {
    throw new NearWalletClientError('invalid-response', 'Invalid NEAR runtime error')
  }
  const canonical = createNearWalletRuntimeError(record.code as NearWalletRuntimeErrorCode)
  if (record.message !== canonical.message) {
    throw new NearWalletClientError('invalid-response', 'Invalid NEAR runtime error')
  }
  return new NearWalletClientError(canonical.code, canonical.message)
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'NEAR runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'NEAR runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'NEAR runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof NearWalletClientError) throw error
    throw new NearWalletClientError('invalid-response', 'Invalid NEAR runtime result')
  }
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid NEAR signing expiry')
  }
  return value as number
}

function parseIntent(value: NearTransferIntent): NearTransferIntent {
  const record = readRecord(value, 'NEAR transfer intent')
  assertExactKeys(record, ['assetId', 'recipient', 'amountRaw'], 'NEAR transfer intent')
  if (
    typeof record.assetId !== 'string' ||
    typeof record.amountRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(record.amountRaw) ||
    BigInt(record.amountRaw) > MAXIMUM_U128
  ) {
    throw new Error('Invalid NEAR transfer intent')
  }
  const asset = parseAssetId(record.assetId)
  const chain = parseChainId(asset.chainId)
  if (
    chain.namespace !== 'near' ||
    !((asset.namespace === 'slip44' && asset.reference === '397') || asset.namespace === 'nep141')
  ) {
    throw new Error('Invalid NEAR transfer asset')
  }
  return Object.freeze({
    assetId: record.assetId,
    recipient: parseNearAccountId(record.recipient),
    amountRaw: record.amountRaw
  })
}

function parseReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: NearTransferIntent
): NearTransferReview {
  const record = readRecord(value, 'NEAR transfer review')
  assertExactKeys(record, ['graph', 'debit', 'review'], 'NEAR transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared' || graph.root.kind !== 'transfer') {
    throw new Error('NEAR transfer review requires a prepared transfer')
  }
  if (expectedTransactionId !== undefined && graph.root.id !== expectedTransactionId) {
    throw new Error('NEAR transaction response does not match the request')
  }
  const debit = readRecord(record.debit, 'NEAR transfer debit')
  assertExactKeys(debit, ['maximumFeeRaw', 'storageReserveRaw'], 'NEAR transfer debit')
  if (
    typeof debit.maximumFeeRaw !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(debit.maximumFeeRaw) ||
    BigInt(debit.maximumFeeRaw) > MAXIMUM_U128 ||
    typeof debit.storageReserveRaw !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(debit.storageReserveRaw) ||
    BigInt(debit.storageReserveRaw) > MAXIMUM_U128 ||
    debit.maximumFeeRaw !== graph.root.intent?.feeLimit?.amountRaw
  ) {
    throw new Error('Invalid NEAR transfer debit')
  }
  const review = readRecord(record.review, 'NEAR signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'NEAR signing review'
  )
  if (typeof review.chainId !== 'string' || review.operation !== 'transaction') {
    throw new Error('Invalid NEAR signing context')
  }
  const chain = parseChainId(review.chainId)
  if (chain.namespace !== 'near') throw new Error('Invalid NEAR signing chain')
  const fingerprint = readRecord(review.payloadFingerprint, 'NEAR payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'NEAR payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid NEAR payload fingerprint')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'near',
    chainId: chain.id,
    operation: 'transaction'
  })
  if (summary.schema !== 'near.transaction.v1') throw new Error('Invalid NEAR review summary')
  const segments = graph.segments.filter(
    candidate =>
      candidate.role === 'origin' &&
      candidate.target.kind === 'onchain' &&
      candidate.target.chainId === chain.id
  )
  const action = summary.fields.actions[0]
  const finalAction = summary.fields.actions.at(-1)
  const primaryAsset = graph.root.intent?.primaryAmount?.assetId
  const asset = primaryAsset ? parseAssetId(primaryAsset) : null
  const nativeMatches =
    asset?.namespace === 'slip44' &&
    asset.reference === '397' &&
    summary.fields.receiverId === graph.root.intent?.recipient?.address &&
    action?.kind === 'transfer' &&
    action.depositYocto === graph.root.intent?.primaryAmount?.amountRaw
  let tokenMatches = false
  if (
    asset?.namespace === 'nep141' &&
    summary.fields.receiverId === asset.reference.replace(/%5F/gi, '_') &&
    action?.kind === 'function-call' &&
    action.methodName === 'ft_transfer' &&
    action.args.encoding === 'base64' &&
    action.depositYocto === '1'
  ) {
    try {
      const decoded = JSON.parse(atob(action.args.value)) as unknown
      tokenMatches =
        typeof decoded === 'object' &&
        decoded !== null &&
        !Array.isArray(decoded) &&
        Object.keys(decoded).length === 2 &&
        (decoded as Record<string, unknown>).receiver_id ===
          graph.root.intent?.recipient?.address &&
        (decoded as Record<string, unknown>).amount === graph.root.intent?.primaryAmount?.amountRaw
    } catch {
      tokenMatches = false
    }
  }
  let lendingMatches = false
  if (
    finalAction?.kind === 'function-call' &&
    finalAction.methodName === 'ft_transfer_call' &&
    finalAction.args.encoding === 'base64' &&
    finalAction.depositYocto === '1' &&
    summary.fields.actions.every(
      candidate =>
        candidate.kind === 'function-call' &&
        ['storage_deposit', 'near_deposit', 'ft_transfer_call'].includes(candidate.methodName)
    )
  ) {
    try {
      const decoded = JSON.parse(atob(finalAction.args.value)) as unknown
      if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
        const args = decoded as Record<string, unknown>
        const recipient = graph.root.intent?.recipient?.address
        const sender = graph.root.intent?.sender?.address
        if (
          Object.keys(args).length === 3 &&
          typeof recipient === 'string' &&
          typeof sender === 'string' &&
          args.receiver_id === recipient &&
          args.amount === graph.root.intent?.primaryAmount?.amountRaw &&
          typeof args.msg === 'string'
        ) {
          parseNearLendingSupplyBinding(
            {
              tokenContractId: summary.fields.receiverId,
              recipientId: recipient,
              customRecipientMsg: args.msg
            },
            sender
          )
          lendingMatches = true
        }
      }
    } catch {
      lendingMatches = false
    }
  }
  if (
    segments.length !== 1 ||
    graph.segments.length !== 1 ||
    graph.root.intent?.sender?.chainId !== chain.id ||
    graph.root.intent.recipient?.chainId !== chain.id ||
    summary.fields.signerId !== graph.root.intent.sender.address ||
    (!nativeMatches && !tokenMatches && !lendingMatches)
  ) {
    throw new Error('NEAR signing review does not match its transaction graph')
  }
  if (
    expectedIntent &&
    (graph.root.intent.primaryAmount?.assetId !== expectedIntent.assetId ||
      graph.root.intent.primaryAmount.amountRaw !== expectedIntent.amountRaw ||
      graph.root.intent.recipient.address !== expectedIntent.recipient)
  ) {
    throw new Error('NEAR transfer response does not match the requested intent')
  }
  return Object.freeze({
    graph,
    debit: Object.freeze({
      maximumFeeRaw: debit.maximumFeeRaw,
      storageReserveRaw: debit.storageReserveRaw
    }),
    review: Object.freeze({
      chainId: chain.id,
      operation: 'transaction' as const,
      summary,
      payloadFingerprint: Object.freeze({
        algorithm: 'sha256' as const,
        digestHex: fingerprint.digestHex
      }),
      expiresAt: parseTimestamp(review.expiresAt)
    })
  })
}

function parseSubmission(value: unknown, transactionId: TransactionId): NearTransferSubmission {
  const record = readRecord(value, 'NEAR transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'NEAR transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid NEAR transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.id !== transactionId || graph.root.status !== expectedStatus) {
    throw new Error('NEAR transfer submission does not match its transaction')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseClientInput<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof NearWalletClientError) throw error
    throw new NearWalletClientError('invalid-request', 'The NEAR wallet request is invalid')
  }
}

export function createNearWalletClient(sendMessage: NearRuntimeMessenger): NearWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parser: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parser)

  return Object.freeze({
    prepareTransfer: async (
      intentValue: NearTransferIntent,
      options?: Readonly<{
        nearIntentsBinding?: NearIntentsTransactionBinding
      }>
    ) => {
      const intent = parseClientInput(() => parseIntent(intentValue))
      return send(
        {
          type: 'PREPARE_NEAR_TRANSFER',
          intent,
          ...(options?.nearIntentsBinding === undefined
            ? {}
            : { nearIntentsBinding: options.nearIntentsBinding })
        },
        value => parseReview(value, undefined, intent)
      )
    },
    getPendingTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'GET_PENDING_NEAR_TRANSFER', transactionId }, value =>
        value === null ? null : parseReview(value, transactionId)
      )
    },
    approveTransfer: async (transactionIdValue: TransactionId, fingerprintValue: string) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      const payloadFingerprint = parseClientInput(() => {
        if (!/^[0-9a-f]{64}$/.test(fingerprintValue)) throw new Error('Invalid fingerprint')
        return fingerprintValue
      })
      return send({ type: 'APPROVE_NEAR_TRANSFER', transactionId, payloadFingerprint }, value =>
        parseSubmission(value, transactionId)
      )
    },
    rejectTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'REJECT_NEAR_TRANSFER', transactionId }, value => {
        const graph = parseTransactionGraph(value)
        if (graph.root.id !== transactionId) {
          throw new Error('NEAR rejection does not match its transaction')
        }
        return graph
      })
    },
    resumeTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'RESUME_NEAR_TRANSFER', transactionId }, value =>
        parseSubmission(value, transactionId)
      )
    },
    getTransferActivity: async (graphValue: TransactionGraph) => {
      const graph = parseClientInput(() => parseTransactionGraph(graphValue))
      const response = await sendMessage({ type: 'GET_ACTIVITY', action: 'read' })
      try {
        return parseNearTransferActivityResponse(response, graph)
      } catch {
        throw new NearWalletClientError('invalid-response', 'Invalid NEAR activity result')
      }
    }
  })
}

export const nearWalletClient = createNearWalletClient(message =>
  chrome.runtime.sendMessage(message)
)
