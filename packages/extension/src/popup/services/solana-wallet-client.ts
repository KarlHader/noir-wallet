import {
  SOLANA_WALLET_RUNTIME_ERROR_CODES,
  createSolanaWalletRuntimeError,
  parseSolanaPublicKey,
  type SolanaWalletRuntimeErrorCode
} from '@/core/chains/solana'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseSigningSummary, type SolanaTransactionSummary } from '@/core/keyring/domain'
import {
  parseTransactionGraph,
  parseTransactionId,
  type NearIntentsTransactionBinding,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import {
  parseSolanaTransferActivityResponse,
  type EvmTransferActivity as SolanaTransferActivity
} from './evm-transfer-activity'

export interface SolanaTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

export interface SolanaTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: SolanaTransactionSummary
    readonly payloadFingerprint: {
      readonly algorithm: 'sha256'
      readonly digestHex: string
    }
    readonly expiresAt: number
  }
}

export interface SolanaTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export type SolanaWalletClientErrorCode = SolanaWalletRuntimeErrorCode | 'invalid-response'

export class SolanaWalletClientError extends Error {
  readonly code: SolanaWalletClientErrorCode

  constructor(code: SolanaWalletClientErrorCode, message: string) {
    super(message)
    this.name = 'SolanaWalletClientError'
    this.code = code
  }
}

export interface SolanaWalletClient {
  readonly prepareTransfer: (
    intent: SolanaTransferIntent,
    options?: Readonly<{ nearIntentsBinding?: NearIntentsTransactionBinding }>
  ) => Promise<SolanaTransferReview>
  readonly getPendingTransfer: (
    transactionId: TransactionId
  ) => Promise<SolanaTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<SolanaTransferSubmission>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<SolanaTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<SolanaTransferActivity | null>
}

export type SolanaRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const runtimeErrorCodes = new Set<SolanaWalletRuntimeErrorCode>(SOLANA_WALLET_RUNTIME_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SolanaWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SolanaWalletClientError('invalid-response', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new SolanaWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseRuntimeError(value: unknown): SolanaWalletClientError {
  const record = readRecord(value, 'Solana runtime error')
  assertExactKeys(record, ['code', 'message'], 'Solana runtime error')
  if (
    typeof record.code !== 'string' ||
    !runtimeErrorCodes.has(record.code as SolanaWalletRuntimeErrorCode) ||
    typeof record.message !== 'string'
  ) {
    throw new SolanaWalletClientError('invalid-response', 'Invalid Solana runtime error')
  }
  const canonical = createSolanaWalletRuntimeError(record.code as SolanaWalletRuntimeErrorCode)
  if (record.message !== canonical.message) {
    throw new SolanaWalletClientError('invalid-response', 'Invalid Solana runtime error')
  }
  return new SolanaWalletClientError(canonical.code, canonical.message)
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'Solana runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'Solana runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'Solana runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof SolanaWalletClientError) throw error
    throw new SolanaWalletClientError('invalid-response', 'Invalid Solana runtime result')
  }
}

function parseTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function parseIntent(value: SolanaTransferIntent): SolanaTransferIntent {
  const record = readRecord(value, 'Solana transfer intent')
  assertExactKeys(record, ['assetId', 'recipient', 'amountRaw'], 'Solana transfer intent')
  if (
    typeof record.assetId !== 'string' ||
    typeof record.amountRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(record.amountRaw) ||
    BigInt(record.amountRaw) > MAXIMUM_U64
  ) {
    throw new Error('Invalid Solana transfer intent')
  }
  const asset = parseAssetId(record.assetId)
  const chain = parseChainId(asset.chainId)
  if (
    chain.namespace !== 'solana' ||
    !((asset.namespace === 'slip44' && asset.reference === '501') || asset.namespace === 'token')
  ) {
    throw new Error('Invalid Solana transfer asset')
  }
  return Object.freeze({
    assetId: record.assetId,
    recipient: parseSolanaPublicKey(record.recipient),
    amountRaw: record.amountRaw
  })
}

function parseReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: SolanaTransferIntent
): SolanaTransferReview {
  const record = readRecord(value, 'Solana transfer review')
  assertExactKeys(record, ['graph', 'review'], 'Solana transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared' || graph.root.kind !== 'transfer') {
    throw new Error('Solana transfer review requires a prepared transfer')
  }
  if (expectedTransactionId !== undefined && graph.root.id !== expectedTransactionId) {
    throw new Error('Solana transaction response does not match the request')
  }
  const review = readRecord(record.review, 'Solana signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'Solana signing review'
  )
  if (typeof review.chainId !== 'string' || review.operation !== 'transaction') {
    throw new Error('Invalid Solana signing context')
  }
  const chain = parseChainId(review.chainId)
  if (chain.namespace !== 'solana') throw new Error('Invalid Solana signing chain')
  const fingerprint = readRecord(review.payloadFingerprint, 'Solana payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'Solana payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid Solana payload fingerprint')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'solana',
    chainId: chain.id,
    operation: 'transaction'
  })
  if (summary.schema !== 'solana.transaction.v1') throw new Error('Invalid Solana review summary')
  const segment = graph.segments.filter(
    candidate =>
      candidate.role === 'origin' &&
      candidate.target.kind === 'onchain' &&
      candidate.target.chainId === chain.id
  )
  const primaryAsset = graph.root.intent?.primaryAmount?.assetId
  const asset = primaryAsset ? parseAssetId(primaryAsset) : null
  const nativeInterpretation = summary.fields.instructions[0]?.interpretation
  const associatedInterpretation = summary.fields.instructions[0]?.interpretation
  const tokenInterpretation = summary.fields.instructions[1]?.interpretation
  const nativeMatches =
    asset?.namespace === 'slip44' &&
    asset.reference === '501' &&
    summary.fields.instructions.length === 1 &&
    nativeInterpretation?.kind === 'system-transfer' &&
    nativeInterpretation.from === graph.root.intent?.sender?.address &&
    nativeInterpretation.to === graph.root.intent?.recipient?.address &&
    nativeInterpretation.lamports === graph.root.intent?.primaryAmount?.amountRaw
  const tokenMatches =
    asset?.namespace === 'token' &&
    summary.fields.instructions.length === 2 &&
    associatedInterpretation?.kind === 'associated-token-create-idempotent' &&
    associatedInterpretation.payer === graph.root.intent?.sender?.address &&
    associatedInterpretation.owner === graph.root.intent?.recipient?.address &&
    associatedInterpretation.mint === asset.reference &&
    tokenInterpretation?.kind === 'spl-token-transfer' &&
    tokenInterpretation.authority === graph.root.intent?.sender?.address &&
    tokenInterpretation.destination === associatedInterpretation.associatedAccount &&
    tokenInterpretation.mint === asset.reference &&
    tokenInterpretation.amountRaw === graph.root.intent?.primaryAmount?.amountRaw
  if (
    segment.length !== 1 ||
    graph.segments.length !== 1 ||
    graph.root.intent?.sender?.chainId !== chain.id ||
    graph.root.intent.recipient?.chainId !== chain.id ||
    (!nativeMatches && !tokenMatches)
  ) {
    throw new Error('Solana signing review does not match its transaction graph')
  }
  if (
    expectedIntent &&
    (graph.root.intent.primaryAmount?.assetId !== expectedIntent.assetId ||
      graph.root.intent.primaryAmount.amountRaw !== expectedIntent.amountRaw ||
      graph.root.intent.recipient.address !== expectedIntent.recipient)
  ) {
    throw new Error('Solana transfer response does not match the requested intent')
  }
  return Object.freeze({
    graph,
    review: Object.freeze({
      chainId: chain.id,
      operation: 'transaction' as const,
      summary,
      payloadFingerprint: Object.freeze({
        algorithm: 'sha256' as const,
        digestHex: fingerprint.digestHex
      }),
      expiresAt: parseTimestamp(review.expiresAt, 'Solana signing expiry')
    })
  })
}

function parseSubmission(value: unknown, transactionId: TransactionId): SolanaTransferSubmission {
  const record = readRecord(value, 'Solana transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'Solana transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid Solana transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.id !== transactionId || graph.root.status !== expectedStatus) {
    throw new Error('Solana transfer submission does not match its transaction')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseClientInput<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof SolanaWalletClientError) throw error
    throw new SolanaWalletClientError('invalid-request', 'The Solana wallet request is invalid')
  }
}

export function createSolanaWalletClient(sendMessage: SolanaRuntimeMessenger): SolanaWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parser: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parser)

  return Object.freeze({
    prepareTransfer: async (
      intentValue: SolanaTransferIntent,
      options?: Readonly<{ nearIntentsBinding?: NearIntentsTransactionBinding }>
    ) => {
      const intent = parseClientInput(() => parseIntent(intentValue))
      return send(
        {
          type: 'PREPARE_SOLANA_TRANSFER',
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
      return send({ type: 'GET_PENDING_SOLANA_TRANSFER', transactionId }, value =>
        value === null ? null : parseReview(value, transactionId)
      )
    },
    approveTransfer: async (transactionIdValue: TransactionId, fingerprintValue: string) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      const payloadFingerprint = parseClientInput(() => {
        if (!/^[0-9a-f]{64}$/.test(fingerprintValue)) throw new Error('Invalid fingerprint')
        return fingerprintValue
      })
      return send({ type: 'APPROVE_SOLANA_TRANSFER', transactionId, payloadFingerprint }, value =>
        parseSubmission(value, transactionId)
      )
    },
    rejectTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'REJECT_SOLANA_TRANSFER', transactionId }, value => {
        const graph = parseTransactionGraph(value)
        if (graph.root.id !== transactionId) {
          throw new Error('Solana rejection does not match its transaction')
        }
        return graph
      })
    },
    resumeTransfer: async (transactionIdValue: TransactionId) => {
      const transactionId = parseClientInput(() => parseTransactionId(transactionIdValue))
      return send({ type: 'RESUME_SOLANA_TRANSFER', transactionId }, value =>
        parseSubmission(value, transactionId)
      )
    },
    getTransferActivity: async (graphValue: TransactionGraph) => {
      const graph = parseClientInput(() => parseTransactionGraph(graphValue))
      const response = await sendMessage({ type: 'GET_ACTIVITY', action: 'read' })
      try {
        return parseSolanaTransferActivityResponse(response, graph)
      } catch {
        throw new SolanaWalletClientError('invalid-response', 'Invalid Solana activity result')
      }
    }
  })
}

export const solanaWalletClient = createSolanaWalletClient(message =>
  chrome.runtime.sendMessage(message)
)
