import { getPearlNetworkConfig } from '@/config/networks'
import {
  PEARL_WALLET_RUNTIME_ERROR_CODES,
  createPearlWalletRuntimeError,
  type PearlWalletRuntimeErrorCode
} from '@/core/chains/pearl'
import { parseChainId } from '@/core/chains/registry'
import { parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  getTransactionProtocolIntentKind,
  parseTransactionGraph,
  parseTransactionId,
  parseNetworkFeeTier,
  type TransactionGraph,
  type TransactionId,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { parsePearlTransferIntent, type PearlTransferIntent } from '@/infrastructure/chains/pearl'
import {
  parseBitcoinTransferActivityResponse,
  type BitcoinTransferActivity
} from './evm-transfer-activity'

export type PearlTransferActivity = BitcoinTransferActivity

export type PearlWalletClientErrorCode = PearlWalletRuntimeErrorCode | 'invalid-response'

export class PearlWalletClientError extends Error {
  readonly code: PearlWalletClientErrorCode

  constructor(code: PearlWalletClientErrorCode, message: string) {
    super(message)
    this.name = 'PearlWalletClientError'
    this.code = code
  }
}

export interface PearlTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: SigningSummary
    readonly payloadFingerprint: {
      readonly algorithm: 'sha256'
      readonly digestHex: string
    }
    readonly expiresAt: number
  }
}

export interface PearlTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface PearlTransferPrepareOptions {
  readonly feeTier?: NetworkFeeTier
}

export interface PearlWalletClient {
  readonly prepareTransfer: (
    intent: PearlTransferIntent,
    options?: PearlTransferPrepareOptions
  ) => Promise<PearlTransferReview>
  readonly getPendingTransfer: (transactionId: TransactionId) => Promise<PearlTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<PearlTransferSubmission>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<PearlTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<PearlTransferActivity | null>
}

export type PearlRuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

const chainId = parseChainId(getPearlNetworkConfig(DEFAULT_NETWORK).chainId).id
const nativeAssetId = `${chainId}/slip44:808276`
const runtimeErrorCodes = new Set<PearlWalletRuntimeErrorCode>(PEARL_WALLET_RUNTIME_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PearlWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PearlWalletClientError('invalid-response', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== required.length ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new PearlWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseRuntimeError(value: unknown): PearlWalletClientError {
  const error = readRecord(value, 'Pearl runtime error')
  assertExactKeys(error, ['code', 'message'], 'Pearl runtime error')
  if (
    typeof error.code !== 'string' ||
    !runtimeErrorCodes.has(error.code as PearlWalletRuntimeErrorCode) ||
    typeof error.message !== 'string'
  ) {
    throw new PearlWalletClientError('invalid-response', 'Invalid Pearl runtime error')
  }
  const canonical = createPearlWalletRuntimeError(error.code as PearlWalletRuntimeErrorCode)
  if (error.message !== canonical.message) {
    throw new PearlWalletClientError('invalid-response', 'Invalid Pearl runtime error')
  }
  return new PearlWalletClientError(canonical.code, canonical.message)
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'Pearl runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'Pearl runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'Pearl runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof PearlWalletClientError) throw error
    throw new PearlWalletClientError('invalid-response', 'Invalid Pearl runtime result')
  }
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid Pearl signing expiry')
  }
  return value as number
}

function assertGraphTransactionId(graph: TransactionGraph, expected: TransactionId): void {
  if (graph.root.id !== expected) {
    throw new Error('Pearl transaction response does not match the request')
  }
}

function assertGraphTransferIntent(graph: TransactionGraph, expected: PearlTransferIntent): void {
  const intent = graph.root.intent
  const isSelfTransfer =
    intent?.sender?.chainId === chainId && intent.sender.address === expected.recipient
  if (
    intent?.direction !== (isSelfTransfer ? 'self' : 'outgoing') ||
    intent.primaryAmount?.assetId !== nativeAssetId ||
    intent.recipient?.chainId !== chainId ||
    intent.recipient.address !== expected.recipient ||
    (expected.amount.mode === 'exact' &&
      intent.primaryAmount.amountRaw !== expected.amount.valueSats)
  ) {
    throw new Error('Pearl transfer response does not match the requested intent')
  }
}

function assertGraphSigningContext(graph: TransactionGraph): void {
  const originSegments = graph.segments.filter(
    segment =>
      segment.role === 'origin' &&
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId
  )
  if (originSegments.length !== 1 || graph.root.intent?.sender?.chainId !== chainId) {
    throw new Error('Pearl signing review does not match its transaction graph')
  }
  const protocol = graph.root.intent.protocol
  if (protocol === undefined) {
    if (graph.root.kind !== 'transfer' || graph.segments.length !== 1) {
      throw new Error('Pearl signing review has an invalid transfer graph')
    }
    return
  }
  const sourceTarget =
    protocol.provider === 'near-intents' ? protocol.depositAddress : protocol.sourceTarget
  if (
    graph.root.kind !== getTransactionProtocolIntentKind(protocol) ||
    protocol.origin.chainId !== chainId ||
    graph.root.intent.recipient?.address !== sourceTarget ||
    graph.segments.length !== 4 ||
    graph.segments.filter(segment => segment.role === 'relay').length !== 1 ||
    graph.segments.filter(segment => segment.role === 'destination').length !== 1 ||
    graph.segments.filter(segment => segment.role === 'refund').length !== 1
  ) {
    throw new Error('Pearl signing review has an invalid protocol graph')
  }
}

function parseTransferReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: PearlTransferIntent
): PearlTransferReview {
  const record = readRecord(value, 'Pearl transfer review')
  assertExactKeys(record, ['graph', 'review'], 'Pearl transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared') {
    throw new Error('Pearl transfer review requires a prepared transaction')
  }
  if (expectedTransactionId) assertGraphTransactionId(graph, expectedTransactionId)
  if (expectedIntent) assertGraphTransferIntent(graph, expectedIntent)
  const review = readRecord(record.review, 'Pearl signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'Pearl signing review'
  )
  if (review.chainId !== chainId || review.operation !== 'transaction') {
    throw new Error('Invalid Pearl signing context')
  }
  const fingerprint = readRecord(review.payloadFingerprint, 'Pearl payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'Pearl payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid Pearl payload fingerprint')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'pearl',
    chainId,
    operation: 'transaction'
  })
  if (summary.schema !== 'pearl.psbt.v1') {
    throw new Error('Invalid Pearl review summary')
  }
  assertGraphSigningContext(graph)
  return Object.freeze({
    graph,
    review: Object.freeze({
      chainId,
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

function parseSubmission(
  value: unknown,
  expectedTransactionId: TransactionId
): PearlTransferSubmission {
  const record = readRecord(value, 'Pearl transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'Pearl transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid Pearl transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  assertGraphTransactionId(graph, expectedTransactionId)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.status !== expectedStatus) {
    throw new Error('Pearl transfer submission status does not match its graph')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseClientInput<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof PearlWalletClientError) throw error
    throw new PearlWalletClientError('invalid-request', 'The Pearl wallet request is invalid')
  }
}

function parseFingerprint(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid Pearl payload fingerprint')
  }
  return value
}

export function createPearlWalletClient(sendMessage: PearlRuntimeMessenger): PearlWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parseResult: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parseResult)

  return Object.freeze({
    prepareTransfer: async (intent: PearlTransferIntent, options?: PearlTransferPrepareOptions) => {
      const parsedIntent = parseClientInput(() => parsePearlTransferIntent(intent, chainId))
      const feeTier =
        options?.feeTier === undefined
          ? undefined
          : parseClientInput(() => parseNetworkFeeTier(options.feeTier))
      return send(
        {
          type: 'PREPARE_PEARL_TRANSFER',
          intent: parsedIntent,
          ...(feeTier === undefined ? {} : { feeTier })
        },
        value => parseTransferReview(value, undefined, parsedIntent)
      )
    },
    getPendingTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'GET_PENDING_PEARL_TRANSFER', transactionId: parsedId }, value =>
        value === null ? null : parseTransferReview(value, parsedId)
      )
    },
    approveTransfer: async (transactionId: TransactionId, payloadFingerprint: string) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'APPROVE_PEARL_TRANSFER',
          transactionId: parsedId,
          payloadFingerprint: parseClientInput(() => parseFingerprint(payloadFingerprint))
        },
        value => {
          const record = readRecord(value, 'Pearl transfer approval result')
          if (record.status === 'external-signature-required') {
            throw new PearlWalletClientError(
              'invalid-response',
              'Pearl hardware transfers are unsupported'
            )
          }
          return parseSubmission(value, parsedId)
        }
      )
    },
    rejectTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'REJECT_PEARL_TRANSFER', transactionId: parsedId }, value => {
        const graph = parseTransactionGraph(value)
        assertGraphTransactionId(graph, parsedId)
        return graph
      })
    },
    resumeTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'RESUME_PEARL_TRANSFER', transactionId: parsedId }, value =>
        parseSubmission(value, parsedId)
      )
    },
    getTransferActivity: async (graph: TransactionGraph) => {
      const parsedGraph = parseClientInput(() => parseTransactionGraph(graph))
      const response = await sendMessage({ type: 'GET_PEARL_ACTIVITY', action: 'read' })
      const envelope = readRecord(response, 'Activity response')
      if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
        assertExactKeys(envelope, ['error'], 'Activity error response')
        throw parseRuntimeError(envelope.error)
      }
      try {
        return parseBitcoinTransferActivityResponse(envelope, parsedGraph)
      } catch {
        throw new PearlWalletClientError('invalid-response', 'Invalid Pearl runtime result')
      }
    }
  })
}

export const pearlWalletClient = createPearlWalletClient(message =>
  chrome.runtime.sendMessage(message)
)
