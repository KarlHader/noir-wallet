import { getBitcoinNetworkConfig } from '@/config/networks'
import { parseAccountId } from '@/core/accounts/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { LedgerBitcoinSigningRequest } from '@/lib/ledger/bitcoin'
import {
  BITCOIN_WALLET_RUNTIME_ERROR_CODES,
  createBitcoinWalletRuntimeError,
  type BitcoinWalletRuntimeErrorCode,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import {
  getTransactionProtocolIntentKind,
  parseTransactionGraph,
  parseTransactionId,
  parseNetworkFeeTier,
  type TransactionGraph,
  type TransactionId,
  type NearIntentsTransactionBinding,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import {
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinPublicKey,
  parseBitcoinTransferIntent,
  type BitcoinTransferIntent
} from '@/infrastructure/chains/bitcoin'
import {
  parseBitcoinTransferActivityResponse,
  type BitcoinTransferActivity
} from './evm-transfer-activity'

export type { BitcoinTransferActivity } from './evm-transfer-activity'

export type BitcoinWalletClientErrorCode = BitcoinWalletRuntimeErrorCode | 'invalid-response'

export class BitcoinWalletClientError extends Error {
  readonly code: BitcoinWalletClientErrorCode

  constructor(code: BitcoinWalletClientErrorCode, message: string) {
    super(message)
    this.name = 'BitcoinWalletClientError'
    this.code = code
  }
}

export interface BitcoinTransferReview {
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

export interface BitcoinTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface BitcoinExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface BitcoinExternalSigningRequest {
  readonly vendor: 'keystone' | 'ledger'
  readonly ledgerRequest?: Extract<LedgerBitcoinSigningRequest, { kind: 'psbt' }>
  readonly transactionId: TransactionId
  readonly scope: { readonly keyDomainId: string; readonly accountId: string }
  readonly chainId: string
  readonly summary: SigningSummary
  readonly request: { readonly encoding: 'base64'; readonly value: string }
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type BitcoinTransferApprovalResult =
  | BitcoinTransferSubmission
  | BitcoinExternalSignatureRequired

export interface BitcoinTransferPrepareOptions {
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
  readonly rheaSwapBinding?: import('@/core/transactions/domain').RheaSwapTransactionBinding
  readonly feeTier?: NetworkFeeTier
  readonly bitcoinAddressType?: BitcoinSupportedAddressType
}

export interface BitcoinWalletIdentity {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
  readonly addressType: BitcoinSupportedAddressType
}

export interface BitcoinWalletClient {
  readonly getActiveIdentity: () => Promise<BitcoinWalletIdentity>
  readonly prepareTransfer: (
    intent: BitcoinTransferIntent,
    options?: BitcoinTransferPrepareOptions
  ) => Promise<BitcoinTransferReview>
  readonly getPendingTransfer: (
    transactionId: TransactionId
  ) => Promise<BitcoinTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<BitcoinTransferApprovalResult>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly getExternalSigningRequest: (
    transactionId: TransactionId
  ) => Promise<BitcoinExternalSigningRequest | null>
  readonly submitExternalSignature: (
    transactionId: TransactionId,
    payloadFingerprint: string,
    signedPsbtBase64: string
  ) => Promise<BitcoinTransferSubmission>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<BitcoinTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<BitcoinTransferActivity | null>
}

export type BitcoinRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

const chainId = parseChainId(getBitcoinNetworkConfig(DEFAULT_NETWORK).chainId).id
const runtimeErrorCodes = new Set<BitcoinWalletRuntimeErrorCode>(BITCOIN_WALLET_RUNTIME_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BitcoinWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BitcoinWalletClientError('invalid-response', `${label} must be a plain object`)
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
    throw new BitcoinWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseRuntimeError(value: unknown): BitcoinWalletClientError {
  const error = readRecord(value, 'Bitcoin runtime error')
  assertExactKeys(error, ['code', 'message'], 'Bitcoin runtime error')
  if (
    typeof error.code !== 'string' ||
    !runtimeErrorCodes.has(error.code as BitcoinWalletRuntimeErrorCode) ||
    typeof error.message !== 'string'
  ) {
    throw new BitcoinWalletClientError('invalid-response', 'Invalid Bitcoin runtime error')
  }
  const canonical = createBitcoinWalletRuntimeError(error.code as BitcoinWalletRuntimeErrorCode)
  if (error.message !== canonical.message) {
    throw new BitcoinWalletClientError('invalid-response', 'Invalid Bitcoin runtime error')
  }
  return new BitcoinWalletClientError(canonical.code, canonical.message)
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'Bitcoin runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'Bitcoin runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'Bitcoin runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof BitcoinWalletClientError) throw error
    throw new BitcoinWalletClientError('invalid-response', 'Invalid Bitcoin runtime result')
  }
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid Bitcoin signing expiry')
  }
  return value as number
}

function assertGraphTransactionId(graph: TransactionGraph, expected: TransactionId): void {
  if (graph.root.id !== expected) {
    throw new Error('Bitcoin transaction response does not match the request')
  }
}

function assertGraphTransferIntent(graph: TransactionGraph, expected: BitcoinTransferIntent): void {
  const intent = graph.root.intent
  const isSelfTransfer =
    intent?.sender?.chainId === chainId && intent.sender.address === expected.recipient
  if (
    intent?.direction !== (isSelfTransfer ? 'self' : 'outgoing') ||
    intent.primaryAmount?.assetId !== `${chainId}/slip44:0` ||
    intent.recipient?.chainId !== chainId ||
    intent.recipient.address !== expected.recipient ||
    (expected.amount.mode === 'exact' &&
      intent.primaryAmount.amountRaw !== expected.amount.valueSats)
  ) {
    throw new Error('Bitcoin transfer response does not match the requested intent')
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
    throw new Error('Bitcoin signing review does not match its transaction graph')
  }
  const protocol = graph.root.intent.protocol
  if (protocol === undefined) {
    if (graph.root.kind !== 'transfer' || graph.segments.length !== 1) {
      throw new Error('Bitcoin signing review has an invalid transfer graph')
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
    throw new Error('Bitcoin signing review has an invalid protocol graph')
  }
}

function parseTransferReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: BitcoinTransferIntent
): BitcoinTransferReview {
  const record = readRecord(value, 'Bitcoin transfer review')
  assertExactKeys(record, ['graph', 'review'], 'Bitcoin transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared') {
    throw new Error('Bitcoin transfer review requires a prepared transaction')
  }
  if (expectedTransactionId) assertGraphTransactionId(graph, expectedTransactionId)
  if (expectedIntent) assertGraphTransferIntent(graph, expectedIntent)
  const review = readRecord(record.review, 'Bitcoin signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'Bitcoin signing review'
  )
  if (review.chainId !== chainId || review.operation !== 'transaction') {
    throw new Error('Invalid Bitcoin signing context')
  }
  const fingerprint = readRecord(review.payloadFingerprint, 'Bitcoin payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'Bitcoin payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid Bitcoin payload fingerprint')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'bitcoin',
    chainId,
    operation: 'transaction'
  })
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
): BitcoinTransferSubmission {
  const record = readRecord(value, 'Bitcoin transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'Bitcoin transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid Bitcoin transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  assertGraphTransactionId(graph, expectedTransactionId)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.status !== expectedStatus) {
    throw new Error('Bitcoin transfer submission status does not match its graph')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseApprovalResult(
  value: unknown,
  expectedTransactionId: TransactionId
): BitcoinTransferApprovalResult {
  const record = readRecord(value, 'Bitcoin transfer approval result')
  if (record.status !== 'external-signature-required') {
    return parseSubmission(value, expectedTransactionId)
  }
  assertExactKeys(
    record,
    ['status', 'graph', 'transactionId', 'payloadFingerprint', 'expiresAt'],
    'Bitcoin external signing handoff'
  )
  const graph = parseTransactionGraph(record.graph)
  assertGraphTransactionId(graph, expectedTransactionId)
  if (
    graph.root.status !== 'approved' ||
    record.transactionId !== expectedTransactionId ||
    typeof record.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
  ) {
    throw new Error('Bitcoin external signing handoff does not match its transaction')
  }
  return Object.freeze({
    status: 'external-signature-required' as const,
    graph,
    transactionId: expectedTransactionId,
    payloadFingerprint: record.payloadFingerprint,
    expiresAt: parseTimestamp(record.expiresAt)
  })
}

function parseCanonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2 * 1024 * 1024 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseExternalSigningRequest(
  value: unknown,
  expectedTransactionId: TransactionId
): BitcoinExternalSigningRequest | null {
  if (value === null) return null
  const record = readRecord(value, 'Bitcoin external signing request')
  const vendor = record.vendor === 'ledger' ? 'ledger' : 'keystone'
  assertExactKeys(
    record,
    vendor === 'ledger'
      ? [
          'transactionId',
          'scope',
          'chainId',
          'summary',
          'request',
          'payloadFingerprint',
          'expiresAt',
          'vendor',
          'ledgerRequest'
        ]
      : record.vendor === 'keystone'
        ? [
            'transactionId',
            'scope',
            'chainId',
            'summary',
            'request',
            'payloadFingerprint',
            'expiresAt',
            'vendor'
          ]
        : [
            'transactionId',
            'scope',
            'chainId',
            'summary',
            'request',
            'payloadFingerprint',
            'expiresAt'
          ],
    'Bitcoin external signing request'
  )
  const request = readRecord(record.request, 'Bitcoin external signing payload')
  assertExactKeys(request, ['encoding', 'value'], 'Bitcoin external signing payload')
  if (
    record.transactionId !== expectedTransactionId ||
    request.encoding !== 'base64' ||
    typeof record.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
  ) {
    throw new Error('Bitcoin external signing request does not match its transaction')
  }
  if (record.chainId !== chainId) {
    throw new Error('Bitcoin external signing request has an invalid chain')
  }
  const scope = readRecord(record.scope, 'Bitcoin external signing scope')
  assertExactKeys(scope, ['keyDomainId', 'accountId'], 'Bitcoin external signing scope')
  const keyDomainId = parseKeyDomainId(scope.keyDomainId)
  const accountId = parseAccountId(scope.accountId)
  const summary = parseSigningSummary(record.summary, {
    family: 'bitcoin',
    chainId,
    operation: 'transaction'
  })
  let ledgerRequest: Extract<LedgerBitcoinSigningRequest, { kind: 'psbt' }> | undefined
  if (vendor === 'ledger') {
    const ledger = readRecord(record.ledgerRequest, 'Ledger Bitcoin signing request')
    assertExactKeys(
      ledger,
      ['kind', 'psbtBase64', 'accountPath', 'masterFingerprintHex', 'expectedAddress', 'network'],
      'Ledger Bitcoin signing request'
    )
    if (
      ledger.kind !== 'psbt' ||
      ledger.psbtBase64 !== request.value ||
      typeof ledger.accountPath !== 'string' ||
      !new RegExp(`^m/84'/${DEFAULT_NETWORK === 'mainnet' ? 0 : 1}'/(?:0|[1-9][0-9]*)'$`).test(
        ledger.accountPath
      ) ||
      typeof ledger.masterFingerprintHex !== 'string' ||
      !/^[0-9a-fA-F]{8}$/.test(ledger.masterFingerprintHex) ||
      typeof ledger.expectedAddress !== 'string' ||
      !new RegExp(`^${DEFAULT_NETWORK === 'mainnet' ? 'bc' : 'tb'}1q[ac-hj-np-z02-9]{38}$`).test(
        ledger.expectedAddress
      ) ||
      typeof ledger.network !== 'string' ||
      ledger.network !== DEFAULT_NETWORK
    ) {
      throw new Error('Ledger Bitcoin signing request does not match its transaction')
    }
    ledgerRequest = Object.freeze({
      kind: 'psbt',
      psbtBase64: ledger.psbtBase64 as string,
      accountPath: ledger.accountPath,
      masterFingerprintHex: ledger.masterFingerprintHex,
      expectedAddress: ledger.expectedAddress,
      network: ledger.network
    })
  }
  return Object.freeze({
    vendor,
    ...(ledgerRequest ? { ledgerRequest } : {}),
    transactionId: expectedTransactionId,
    scope: Object.freeze({ keyDomainId, accountId }),
    chainId,
    summary,
    request: Object.freeze({
      encoding: 'base64' as const,
      value: parseCanonicalBase64(request.value, 'Bitcoin PSBT signing payload')
    }),
    payloadFingerprint: record.payloadFingerprint,
    expiresAt: parseTimestamp(record.expiresAt)
  })
}

function parseWalletIdentity(value: unknown): BitcoinWalletIdentity {
  const record = readRecord(value, 'Bitcoin wallet identity')
  assertExactKeys(
    record,
    ['chainId', 'address', 'publicKey', 'addressType'],
    'Bitcoin wallet identity'
  )
  if (record.chainId !== chainId) {
    throw new Error('Bitcoin wallet identity belongs to another chain')
  }
  const addressType = parseBitcoinAddressType(record.addressType)
  return Object.freeze({
    chainId,
    address: parseBitcoinAddress(record.address, chainId, addressType),
    publicKey: parseBitcoinPublicKey(record.publicKey),
    addressType
  })
}

function parseClientInput<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof BitcoinWalletClientError) throw error
    throw new BitcoinWalletClientError('invalid-request', 'The Bitcoin wallet request is invalid')
  }
}

function parseFingerprint(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid Bitcoin payload fingerprint')
  }
  return value
}

export function createBitcoinWalletClient(
  sendMessage: BitcoinRuntimeMessenger
): BitcoinWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parseResult: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parseResult)

  return Object.freeze({
    getActiveIdentity: () => send({ type: 'GET_BITCOIN_WALLET_IDENTITY' }, parseWalletIdentity),
    prepareTransfer: async (
      intent: BitcoinTransferIntent,
      options?: BitcoinTransferPrepareOptions
    ) => {
      const parsedIntent = parseClientInput(() => parseBitcoinTransferIntent(intent, chainId))
      const feeTier =
        options?.feeTier === undefined
          ? undefined
          : parseClientInput(() => parseNetworkFeeTier(options.feeTier))
      const bitcoinAddressType =
        options?.bitcoinAddressType === undefined
          ? undefined
          : parseClientInput(() => parseBitcoinAddressType(options.bitcoinAddressType))
      return send(
        {
          type: 'PREPARE_BITCOIN_TRANSFER',
          intent: parsedIntent,
          ...(options?.nearIntentsBinding === undefined
            ? {}
            : { nearIntentsBinding: options.nearIntentsBinding }),
          ...(options?.rheaSwapBinding === undefined
            ? {}
            : { rheaSwapBinding: options.rheaSwapBinding }),
          ...(feeTier === undefined ? {} : { feeTier }),
          ...(bitcoinAddressType === undefined ? {} : { bitcoinAddressType })
        },
        value => parseTransferReview(value, undefined, parsedIntent)
      )
    },
    getPendingTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'GET_PENDING_BITCOIN_TRANSFER', transactionId: parsedId }, value =>
        value === null ? null : parseTransferReview(value, parsedId)
      )
    },
    approveTransfer: async (transactionId: TransactionId, payloadFingerprint: string) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'APPROVE_BITCOIN_TRANSFER',
          transactionId: parsedId,
          payloadFingerprint: parseClientInput(() => parseFingerprint(payloadFingerprint))
        },
        value => parseApprovalResult(value, parsedId)
      )
    },
    rejectTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'REJECT_BITCOIN_TRANSFER', transactionId: parsedId }, value => {
        const graph = parseTransactionGraph(value)
        assertGraphTransactionId(graph, parsedId)
        return graph
      })
    },
    getExternalSigningRequest: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        { type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST', transactionId: parsedId },
        value => parseExternalSigningRequest(value, parsedId)
      )
    },
    submitExternalSignature: async (
      transactionId: TransactionId,
      payloadFingerprint: string,
      signedPsbtBase64: string
    ) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
          transactionId: parsedId,
          payloadFingerprint: parseClientInput(() => parseFingerprint(payloadFingerprint)),
          signedPsbtBase64: parseClientInput(() =>
            parseCanonicalBase64(signedPsbtBase64, 'signed Bitcoin PSBT')
          )
        },
        value => parseSubmission(value, parsedId)
      )
    },
    resumeTransfer: async (transactionId: TransactionId) => {
      const parsedId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'RESUME_BITCOIN_TRANSFER', transactionId: parsedId }, value =>
        parseSubmission(value, parsedId)
      )
    },
    getTransferActivity: async (graph: TransactionGraph) => {
      const parsedGraph = parseClientInput(() => parseTransactionGraph(graph))
      const response = await sendMessage({ type: 'GET_BITCOIN_ACTIVITY', action: 'read' })
      const envelope = readRecord(response, 'Activity response')
      if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
        assertExactKeys(envelope, ['error'], 'Activity error response')
        throw parseRuntimeError(envelope.error)
      }
      try {
        return parseBitcoinTransferActivityResponse(envelope, parsedGraph)
      } catch {
        throw new BitcoinWalletClientError('invalid-response', 'Invalid Bitcoin runtime result')
      }
    }
  })
}

export const bitcoinWalletClient = createBitcoinWalletClient(message =>
  chrome.runtime.sendMessage(message)
)
