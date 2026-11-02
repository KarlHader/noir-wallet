import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { parseAccountId } from '@/core/accounts/domain'
import type { LedgerEvmSigningRequest } from '@/lib/ledger/evm'
import { bytesToBase64, hexToBytes } from '@/lib/bytes'
import { parseActivityReadModel, type ActivityReadModel } from '@/core/activity'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetDisplayMetadata,
  parseChainId,
  type AssetDefinitionInput,
  type ChainRegistry
} from '@/core/chains/registry'
import {
  EVM_WALLET_RUNTIME_ERROR_CODES,
  createEvmWalletRuntimeError,
  type EvmWalletRuntimeErrorCode
} from '@/core/chains/evm'
import { parseKeyDomainId, parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import { parsePortfolioReadModel, type PortfolioReadModel } from '@/core/portfolio'
import {
  getTransactionProtocolIntentKind,
  parseTransactionGraph,
  parseTransactionId,
  type TransactionGraph,
  type TransactionId,
  type NearIntentsTransactionBinding,
  type RheaSwapTransactionBinding,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import {
  parseEvmContractCallIntent,
  parseEvmFeeSelection,
  parseEvmTransferIntent,
  type EvmContractCallIntent,
  type EvmFeeSelection,
  type EvmNonceRecoveryState,
  type EvmTransferIntent
} from '@/infrastructure/chains/evm'
import { parseEvmTransferActivityResponse, type EvmTransferActivity } from './evm-transfer-activity'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  detectedEvmAssetToDefinition,
  parseDetectedEvmAssetRecord,
  parseUserEvmAssetRecord,
  userEvmAssetToDefinition,
  type DetectedEvmAssetRecord,
  type UserEvmAssetRecord
} from '@/core/chains/user-assets'

export type { EvmTransferActivity } from './evm-transfer-activity'

export type EvmWalletClientErrorCode = EvmWalletRuntimeErrorCode | 'invalid-response'

export class EvmWalletClientError extends Error {
  readonly code: EvmWalletClientErrorCode
  readonly shortfallRaw?: string

  constructor(code: EvmWalletClientErrorCode, message: string, shortfallRaw?: string) {
    super(message)
    this.name = 'EvmWalletClientError'
    this.code = code
    this.shortfallRaw = shortfallRaw
  }
}

export interface EvmTransferReview {
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

export interface EvmTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface EvmExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type EvmTransferApprovalResult = EvmTransferSubmission | EvmExternalSignatureRequired

export interface EvmTransferPrepareOptions {
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
  readonly rheaSwapBinding?: RheaSwapTransactionBinding
  readonly feeTier?: NetworkFeeTier
  readonly feeSelection?: EvmFeeSelection
  readonly executionMode?: 'main' | 'private'
  readonly debugRequestId?: string
}

export interface EvmContractCallPrepareOptions {
  readonly rheaSwapBinding?: RheaSwapTransactionBinding
  readonly feeTier?: NetworkFeeTier
  readonly feeSelection?: EvmFeeSelection
  readonly executionMode?: 'main' | 'private'
  readonly debugRequestId?: string
}

export interface EvmExternalSigningRequest {
  readonly vendor: 'keystone' | 'ledger'
  readonly ledgerRequest?: Extract<LedgerEvmSigningRequest, { kind: 'transaction' }>
  readonly transactionId: TransactionId
  readonly scope: { readonly keyDomainId: string; readonly accountId: string }
  readonly summary: SigningSummary
  readonly chainId: string
  readonly request: { readonly encoding: 'base64'; readonly value: string }
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface EvmWalletClient {
  readonly getPortfolio: (
    action: 'read' | 'refresh',
    options?: {
      readonly forceDiscovery?: boolean
      readonly chainIds?: readonly string[]
    }
  ) => Promise<PortfolioReadModel | null>
  readonly getActivity: (
    action: 'read' | 'refresh',
    executionMode?: 'main' | 'private' | 'all',
    options?: { readonly chainIds?: readonly string[]; readonly historyPageCount?: number }
  ) => Promise<ActivityReadModel | null>
  readonly prepareTransfer: (
    intent: EvmTransferIntent,
    options?: EvmTransferPrepareOptions
  ) => Promise<EvmTransferReview>
  readonly prepareContractCall: (
    intent: EvmContractCallIntent,
    options?: EvmContractCallPrepareOptions
  ) => Promise<EvmTransferReview>
  readonly getTokenAllowance: (
    chainId: string,
    token: string,
    spender: string,
    expectedOwner: string,
    executionMode?: 'main' | 'private'
  ) => Promise<string>
  readonly prepareCancel: (
    chainId: string,
    originalTransactionId: TransactionId,
    executionMode?: 'main' | 'private'
  ) => Promise<EvmTransferReview>
  readonly getNonceRecovery: (
    chainId: string,
    executionMode?: 'main' | 'private'
  ) => Promise<EvmNonceRecoveryState | null>
  readonly prepareNonceRecovery: (
    chainId: string,
    executionMode?: 'main' | 'private',
    feeSelection?: EvmFeeSelection
  ) => Promise<EvmTransferReview>
  readonly getPendingTransfer: (transactionId: TransactionId) => Promise<EvmTransferReview | null>
  readonly approveTransfer: (
    transactionId: TransactionId,
    payloadFingerprint: string
  ) => Promise<EvmTransferApprovalResult>
  readonly rejectTransfer: (transactionId: TransactionId) => Promise<TransactionGraph>
  readonly getExternalSigningRequest: (
    transactionId: TransactionId
  ) => Promise<EvmExternalSigningRequest | null>
  readonly submitExternalSignature: (
    transactionId: TransactionId,
    payloadFingerprint: string,
    signatureCborBase64: string
  ) => Promise<EvmTransferSubmission>
  readonly resumeTransfer: (transactionId: TransactionId) => Promise<EvmTransferSubmission>
  readonly getTransferActivity: (graph: TransactionGraph) => Promise<EvmTransferActivity | null>
}

export type EvmRuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

function resolveProductRegistries(
  userAssets: readonly UserEvmAssetRecord[] = [],
  detectedAssets: readonly DetectedEvmAssetRecord[] = [],
  protocolAssets: readonly AssetDefinitionInput[] = []
) {
  const catalog = resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings())
  const custom = catalog.filter(network => network.source === 'custom')
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, custom)
  return Object.freeze({
    chains,
    assets: createAssetRegistry(chains, [
      ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, custom),
      ...userAssets.map(userEvmAssetToDefinition),
      ...detectedAssets.map(detectedEvmAssetToDefinition),
      ...protocolAssets
    ])
  })
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvmWalletClientError('invalid-response', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvmWalletClientError('invalid-response', `${label} must be a plain object`)
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
    throw new EvmWalletClientError('invalid-response', `${label} has invalid fields`)
  }
}

function parseProtocolAssetDefinitions(
  chains: ChainRegistry,
  value: unknown
): readonly AssetDefinitionInput[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error('Invalid Portfolio protocol asset inventory')
  }
  const candidates = value.map(candidate => {
    const record = readRecord(candidate, 'Portfolio protocol asset')
    assertExactKeys(
      record,
      ['chainId', 'namespace', 'reference', 'kind', 'metadata', 'source', 'verification'],
      'Portfolio protocol asset'
    )
    const metadata = readRecord(record.metadata, 'Portfolio protocol asset metadata')
    const metadataKeys = Object.keys(metadata)
    if (
      metadataKeys.length < 3 ||
      metadataKeys.length > 4 ||
      !['name', 'symbol', 'decimals'].every(key =>
        Object.prototype.hasOwnProperty.call(metadata, key)
      ) ||
      metadataKeys.some(key => !['name', 'symbol', 'decimals', 'iconUrl'].includes(key)) ||
      typeof record.chainId !== 'string' ||
      typeof record.namespace !== 'string' ||
      typeof record.reference !== 'string' ||
      record.kind !== 'token' ||
      record.source !== 'protocol' ||
      record.verification !== 'trusted'
    ) {
      throw new Error('Invalid Portfolio protocol asset')
    }
    return Object.freeze({
      chainId: record.chainId,
      namespace: record.namespace,
      reference: record.reference,
      kind: record.kind,
      metadata: parseAssetDisplayMetadata(metadata),
      source: record.source,
      verification: record.verification
    })
  })
  const registry = createAssetRegistry(chains, candidates)
  if (registry.list().length !== candidates.length) {
    throw new Error('Invalid Portfolio protocol asset inventory')
  }
  return Object.freeze(
    registry.list().map(entry => {
      const chain = chains.resolve(entry.asset.chainId)
      if (
        (chain.family !== 'solana' && chain.family !== 'near') ||
        entry.asset.kind !== 'token' ||
        (entry.asset.namespace !== 'token' && entry.asset.namespace !== 'nep141') ||
        entry.source !== 'protocol' ||
        entry.verification !== 'trusted'
      ) {
        throw new Error('Invalid Portfolio protocol asset')
      }
      return Object.freeze({
        chainId: entry.asset.chainId,
        namespace: entry.asset.namespace,
        reference: entry.asset.reference,
        kind: entry.asset.kind,
        metadata: entry.metadata,
        source: entry.source,
        verification: entry.verification
      })
    })
  )
}

const runtimeErrorCodes = new Set<EvmWalletRuntimeErrorCode>(EVM_WALLET_RUNTIME_ERROR_CODES)

function parseRuntimeError(value: unknown): EvmWalletClientError {
  const error = readRecord(value, 'EVM runtime error')
  const hasShortfall = Object.prototype.hasOwnProperty.call(error, 'shortfallRaw')
  assertExactKeys(
    error,
    hasShortfall ? ['code', 'message', 'shortfallRaw'] : ['code', 'message'],
    'EVM runtime error'
  )
  if (
    typeof error.code !== 'string' ||
    !runtimeErrorCodes.has(error.code as EvmWalletRuntimeErrorCode) ||
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    error.message.length > 256
  ) {
    throw new EvmWalletClientError('invalid-response', 'Invalid EVM runtime error')
  }
  const canonical = createEvmWalletRuntimeError(error.code as EvmWalletRuntimeErrorCode)
  if (error.message !== canonical.message) {
    throw new EvmWalletClientError('invalid-response', 'Invalid EVM runtime error')
  }
  if (
    hasShortfall &&
    (canonical.code !== 'insufficient-funds' ||
      typeof error.shortfallRaw !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(error.shortfallRaw))
  ) {
    throw new EvmWalletClientError('invalid-response', 'Invalid EVM runtime error')
  }
  return new EvmWalletClientError(
    canonical.code,
    canonical.message,
    hasShortfall ? (error.shortfallRaw as string) : undefined
  )
}

function parseRuntimeResult<T>(value: unknown, parseResult: (result: unknown) => T): T {
  const response = readRecord(value, 'EVM runtime response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    assertExactKeys(response, ['error'], 'EVM runtime error response')
    throw parseRuntimeError(response.error)
  }
  assertExactKeys(response, ['result'], 'EVM runtime result response')
  try {
    return parseResult(response.result)
  } catch (error) {
    if (error instanceof EvmWalletClientError) throw error
    throw new EvmWalletClientError('invalid-response', 'Invalid EVM runtime result')
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function assertGraphTransactionId(graph: TransactionGraph, expected: TransactionId): void {
  if (graph.root.id !== expected) {
    throw new Error('EVM transaction response does not match the request')
  }
}

function assertGraphTransferIntent(graph: TransactionGraph, expected: EvmTransferIntent): void {
  const intent = graph.root.intent
  const selfTransfer =
    intent?.direction === 'self' &&
    intent.sender !== undefined &&
    intent.recipient !== undefined &&
    intent.sender.chainId === intent.recipient.chainId &&
    intent.sender.address.toLowerCase() === intent.recipient.address.toLowerCase()
  if (
    (intent?.direction !== 'outgoing' && !selfTransfer) ||
    intent?.primaryAmount === undefined ||
    intent.primaryAmount.assetId !== expected.assetId ||
    intent.primaryAmount.amountRaw !== expected.amountRaw ||
    intent.recipient?.address.toLowerCase() !== expected.recipient.toLowerCase()
  ) {
    throw new Error('EVM transfer response does not match the requested intent')
  }
}

function assertGraphSigningContext(graph: TransactionGraph, chainId: string): void {
  const originSegments = graph.segments.filter(
    segment =>
      segment.role === 'origin' &&
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId
  )
  if (originSegments.length !== 1 || graph.root.intent?.sender?.chainId !== chainId) {
    throw new Error('EVM signing review does not match its transaction graph')
  }
  const protocol = graph.root.intent.protocol
  if (protocol === undefined) {
    if (graph.root.kind === 'contract-call' || graph.root.kind === 'approve') {
      if (
        graph.segments.length !== 1 ||
        graph.root.intent.direction !== 'contract' ||
        graph.root.intent.recipient?.chainId !== chainId ||
        !graph.root.intent.recipient.address
      ) {
        throw new Error('EVM signing review has an invalid contract graph')
      }
      return
    }
    if (graph.root.kind === 'cancel') {
      const sender = graph.root.intent.sender
      const recipient = graph.root.intent.recipient
      if (
        graph.segments.length !== 1 ||
        graph.root.intent.direction !== 'self' ||
        graph.root.intent.primaryAmount !== undefined ||
        !sender ||
        !recipient ||
        sender.chainId !== chainId ||
        recipient.chainId !== chainId ||
        sender.address.toLowerCase() !== recipient.address.toLowerCase() ||
        (graph.root.relation !== undefined && graph.root.relation.kind !== 'replacement-of')
      ) {
        throw new Error('EVM signing review has an invalid cancellation graph')
      }
      return
    }
    if (graph.root.kind !== 'transfer' || graph.segments.length !== 1) {
      throw new Error('EVM signing review has an invalid transfer graph')
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
    throw new Error('EVM signing review has an invalid protocol graph')
  }
}

function parseTransferReview(
  value: unknown,
  expectedTransactionId?: TransactionId,
  expectedIntent?: EvmTransferIntent
): EvmTransferReview {
  const record = readRecord(value, 'EVM transfer review')
  assertExactKeys(record, ['graph', 'review'], 'EVM transfer review')
  const graph = parseTransactionGraph(record.graph)
  if (graph.root.status !== 'prepared') {
    throw new Error('EVM transfer review requires a prepared transaction')
  }
  if (expectedTransactionId !== undefined) {
    assertGraphTransactionId(graph, expectedTransactionId)
  }
  if (expectedIntent !== undefined) {
    assertGraphTransferIntent(graph, expectedIntent)
  }
  const review = readRecord(record.review, 'EVM signing review')
  assertExactKeys(
    review,
    ['chainId', 'operation', 'summary', 'payloadFingerprint', 'expiresAt'],
    'EVM signing review'
  )
  if (typeof review.chainId !== 'string') throw new Error('Invalid EVM signing chain')
  const chainId = parseChainId(review.chainId)
  if (chainId.namespace !== 'eip155' || review.operation !== 'transaction') {
    throw new Error('Invalid EVM signing context')
  }
  const fingerprint = readRecord(review.payloadFingerprint, 'EVM payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], 'EVM payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  ) {
    throw new Error('Invalid EVM payload fingerprint')
  }
  const summary = parseSigningSummary(review.summary, {
    family: 'evm',
    chainId: chainId.id,
    operation: 'transaction'
  })
  assertGraphSigningContext(graph, chainId.id)
  if (graph.root.kind === 'contract-call' || graph.root.kind === 'approve') {
    const intent = graph.root.intent
    if (
      summary.schema !== 'evm.transaction.v1' ||
      intent?.sender?.address.toLowerCase() !== summary.fields.from.toLowerCase() ||
      intent?.recipient?.address.toLowerCase() !== summary.fields.to?.toLowerCase() ||
      (intent?.primaryAmount?.amountRaw ?? '0') !== summary.fields.valueWei ||
      intent?.feeLimit?.amountRaw !== summary.fields.maximumFeeWei
    ) {
      throw new Error('EVM contract graph does not match its signing summary')
    }
  }
  return Object.freeze({
    graph,
    review: Object.freeze({
      chainId: chainId.id,
      operation: 'transaction' as const,
      summary,
      payloadFingerprint: Object.freeze({
        algorithm: 'sha256' as const,
        digestHex: fingerprint.digestHex
      }),
      expiresAt: readTimestamp(review.expiresAt, 'EVM signing expiry')
    })
  })
}

function parseSubmission(
  value: unknown,
  expectedTransactionId: TransactionId
): EvmTransferSubmission {
  const record = readRecord(value, 'EVM transfer submission')
  assertExactKeys(record, ['status', 'graph'], 'EVM transfer submission')
  if (record.status !== 'broadcast' && record.status !== 'signed-pending-broadcast') {
    throw new Error('Invalid EVM transfer submission status')
  }
  const graph = parseTransactionGraph(record.graph)
  assertGraphTransactionId(graph, expectedTransactionId)
  const expectedStatus = record.status === 'broadcast' ? 'broadcast' : 'signed'
  if (graph.root.status !== expectedStatus) {
    throw new Error('EVM transfer submission status does not match its graph')
  }
  return Object.freeze({ status: record.status, graph })
}

function parseApprovalResult(
  value: unknown,
  expectedTransactionId: TransactionId
): EvmTransferApprovalResult {
  const record = readRecord(value, 'EVM transfer approval result')
  if (record.status !== 'external-signature-required') {
    return parseSubmission(value, expectedTransactionId)
  }
  assertExactKeys(
    record,
    ['status', 'graph', 'transactionId', 'payloadFingerprint', 'expiresAt'],
    'EVM external signing handoff'
  )
  const graph = parseTransactionGraph(record.graph)
  assertGraphTransactionId(graph, expectedTransactionId)
  if (
    graph.root.status !== 'approved' ||
    record.transactionId !== expectedTransactionId ||
    typeof record.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
  ) {
    throw new Error('EVM external signing handoff does not match its transaction')
  }
  return Object.freeze({
    status: 'external-signature-required' as const,
    graph,
    transactionId: expectedTransactionId,
    payloadFingerprint: record.payloadFingerprint,
    expiresAt: readTimestamp(record.expiresAt, 'EVM signing expiry')
  })
}

function parseCanonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 * 1024 ||
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
): EvmExternalSigningRequest | null {
  if (value === null) return null
  const record = readRecord(value, 'EVM external signing request')
  const vendor = record.vendor === 'ledger' ? 'ledger' : 'keystone'
  assertExactKeys(
    record,
    vendor === 'ledger'
      ? [
          'transactionId',
          'chainId',
          'scope',
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
            'chainId',
            'scope',
            'summary',
            'request',
            'payloadFingerprint',
            'expiresAt',
            'vendor'
          ]
        : [
            'transactionId',
            'chainId',
            'scope',
            'summary',
            'request',
            'payloadFingerprint',
            'expiresAt'
          ],
    'EVM external signing request'
  )
  const request = readRecord(record.request, 'EVM external signing payload')
  assertExactKeys(request, ['encoding', 'value'], 'EVM external signing payload')
  if (
    record.transactionId !== expectedTransactionId ||
    typeof record.chainId !== 'string' ||
    request.encoding !== 'base64' ||
    typeof record.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
  ) {
    throw new Error('EVM external signing request does not match its transaction')
  }
  const chainId = parseChainId(record.chainId)
  if (chainId.namespace !== 'eip155') {
    throw new Error('EVM external signing request has an invalid chain')
  }
  const scope = readRecord(record.scope, 'EVM external signing scope')
  assertExactKeys(scope, ['keyDomainId', 'accountId'], 'EVM external signing scope')
  const keyDomainId = parseKeyDomainId(scope.keyDomainId)
  const accountId = parseAccountId(scope.accountId)
  const summary = parseSigningSummary(record.summary, {
    family: 'evm',
    chainId: chainId.id,
    operation: 'transaction'
  })
  let ledgerRequest: Extract<LedgerEvmSigningRequest, { kind: 'transaction' }> | undefined
  if (vendor === 'ledger') {
    const ledger = readRecord(record.ledgerRequest, 'Ledger EVM signing request')
    assertExactKeys(
      ledger,
      ['kind', 'derivationPath', 'expectedAddress', 'unsignedTransactionHex'],
      'Ledger EVM signing request'
    )
    if (
      ledger.kind !== 'transaction' ||
      typeof ledger.derivationPath !== 'string' ||
      !/^m\/44'\/60'\/(?:0|[1-9][0-9]*)'\/0\/(?:0|[1-9][0-9]*)$/.test(ledger.derivationPath) ||
      typeof ledger.expectedAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(ledger.expectedAddress) ||
      typeof ledger.unsignedTransactionHex !== 'string' ||
      !/^0x02(?:[0-9a-fA-F]{2})+$/.test(ledger.unsignedTransactionHex) ||
      bytesToBase64(hexToBytes(ledger.unsignedTransactionHex)) !== request.value
    ) {
      throw new Error('Ledger EVM signing request does not match its transaction')
    }
    ledgerRequest = Object.freeze({
      kind: 'transaction',
      derivationPath: ledger.derivationPath,
      expectedAddress: ledger.expectedAddress,
      unsignedTransactionHex: ledger.unsignedTransactionHex
    })
  }
  return Object.freeze({
    vendor,
    ...(ledgerRequest ? { ledgerRequest } : {}),
    transactionId: expectedTransactionId,
    scope: Object.freeze({ keyDomainId, accountId }),
    summary,
    chainId: chainId.id,
    request: Object.freeze({
      encoding: 'base64' as const,
      value: parseCanonicalBase64(request.value, 'EVM signing request')
    }),
    payloadFingerprint: record.payloadFingerprint,
    expiresAt: readTimestamp(record.expiresAt, 'EVM signing expiry')
  })
}

function parseFingerprint(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new EvmWalletClientError('invalid-request', 'The EVM wallet request is invalid')
  }
  return value
}

function parseClientInput<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof EvmWalletClientError) throw error
    throw new EvmWalletClientError('invalid-request', 'The EVM wallet request is invalid')
  }
}

export function createEvmWalletClient(sendMessage: EvmRuntimeMessenger): EvmWalletClient {
  const send = async <T>(
    message: Readonly<Record<string, unknown>>,
    parseResult: (value: unknown) => T
  ): Promise<T> => parseRuntimeResult(await sendMessage(message), parseResult)

  return Object.freeze({
    getPortfolio: async (
      action: 'read' | 'refresh',
      options: {
        readonly forceDiscovery?: boolean
        readonly chainIds?: readonly string[]
      } = {}
    ) => {
      const requestedChainIds = options.chainIds
      const chainIds =
        requestedChainIds === undefined
          ? undefined
          : parseClientInput(() => {
              if (requestedChainIds.length === 0 || requestedChainIds.length > 64) {
                throw new Error('Invalid Portfolio refresh chain IDs')
              }
              const normalized = requestedChainIds.map(chainId => parseChainId(chainId).id)
              if (new Set(normalized).size !== normalized.length) {
                throw new Error('Duplicate Portfolio refresh chain IDs')
              }
              return Object.freeze(normalized)
            })
      const response = await sendMessage({
        type: 'GET_PORTFOLIO',
        action,
        ...(options.forceDiscovery === undefined ? {} : { forceDiscovery: options.forceDiscovery }),
        ...(chainIds === undefined ? {} : { chainIds })
      })
      return parseRuntimeResult(response, value => {
        const result = readRecord(value, 'Portfolio result')
        assertExactKeys(
          result,
          ['model', 'userAssets', 'detectedAssets', 'protocolAssets'],
          'Portfolio result'
        )
        if (!Array.isArray(result.userAssets) || result.userAssets.length > 64) {
          throw new Error('Invalid Portfolio user asset inventory')
        }
        const userAssets = result.userAssets.map(item =>
          parseUserEvmAssetRecord(resolveProductRegistries().chains, item)
        )
        if (!Array.isArray(result.detectedAssets) || result.detectedAssets.length > 512) {
          throw new Error('Invalid Portfolio detected asset inventory')
        }
        const detectedAssets = result.detectedAssets.map(item =>
          parseDetectedEvmAssetRecord(resolveProductRegistries().chains, item)
        )
        const baseRegistries = resolveProductRegistries(userAssets, detectedAssets)
        const protocolAssets = parseProtocolAssetDefinitions(
          baseRegistries.chains,
          result.protocolAssets
        )
        if (result.model === null) return null
        const { chains, assets } = resolveProductRegistries(
          userAssets,
          detectedAssets,
          protocolAssets
        )
        return parsePortfolioReadModel(result.model, chains, assets)
      })
    },
    getActivity: async (
      action: 'read' | 'refresh',
      executionMode: 'main' | 'private' | 'all' = 'all',
      options: { readonly chainIds?: readonly string[]; readonly historyPageCount?: number } = {}
    ) => {
      const requestedChainIds = options.chainIds
      const chainIds =
        requestedChainIds === undefined
          ? undefined
          : parseClientInput(() => {
              if (requestedChainIds.length === 0 || requestedChainIds.length > 64) {
                throw new Error('Invalid Activity refresh chain IDs')
              }
              const normalized = requestedChainIds.map(chainId => parseChainId(chainId).id)
              if (new Set(normalized).size !== normalized.length) {
                throw new Error('Duplicate Activity refresh chain IDs')
              }
              return Object.freeze(normalized)
            })
      const historyPageCount = options.historyPageCount
      if (
        historyPageCount !== undefined &&
        (!Number.isSafeInteger(historyPageCount) || historyPageCount < 1 || historyPageCount > 10)
      ) {
        throw new EvmWalletClientError('invalid-response', 'Invalid Activity history page count')
      }
      return send(
        {
          type: 'GET_ACTIVITY',
          action,
          executionMode,
          ...(chainIds === undefined ? {} : { chainIds }),
          ...(historyPageCount === undefined ? {} : { historyPageCount })
        },
        value => (value === null ? null : parseActivityReadModel(value))
      )
    },
    prepareTransfer: async (intent: EvmTransferIntent, options?: EvmTransferPrepareOptions) => {
      const parsedIntent = parseClientInput(() => parseEvmTransferIntent(intent))
      if (options?.feeTier !== undefined && options.feeSelection !== undefined) {
        throw new EvmWalletClientError('invalid-response', 'EVM fee selection is ambiguous')
      }
      const feeSelection =
        options?.feeSelection !== undefined
          ? parseClientInput(() => parseEvmFeeSelection(options.feeSelection))
          : options?.feeTier === undefined
            ? undefined
            : parseClientInput(() => parseEvmFeeSelection(options.feeTier))
      const executionMode = options?.executionMode ?? 'main'
      if (executionMode !== 'main' && executionMode !== 'private') {
        throw new EvmWalletClientError('invalid-response', 'Invalid EVM transfer execution mode')
      }
      return send(
        {
          type: 'PREPARE_EVM_TRANSFER',
          intent: parsedIntent,
          ...(options?.nearIntentsBinding === undefined
            ? {}
            : { nearIntentsBinding: options.nearIntentsBinding }),
          ...(options?.rheaSwapBinding === undefined
            ? {}
            : { rheaSwapBinding: options.rheaSwapBinding }),
          ...(feeSelection === undefined ? {} : { feeSelection }),
          executionMode,
          ...(options?.debugRequestId === undefined
            ? {}
            : { debugRequestId: options.debugRequestId })
        },
        value => parseTransferReview(value, undefined, parsedIntent)
      )
    },
    prepareContractCall: async (
      intent: EvmContractCallIntent,
      options?: EvmContractCallPrepareOptions
    ) => {
      const parsedIntent = parseClientInput(() => parseEvmContractCallIntent(intent))
      if (options?.feeTier !== undefined && options.feeSelection !== undefined) {
        throw new EvmWalletClientError('invalid-response', 'EVM fee selection is ambiguous')
      }
      const feeSelection =
        options?.feeSelection !== undefined
          ? parseClientInput(() => parseEvmFeeSelection(options.feeSelection))
          : options?.feeTier === undefined
            ? undefined
            : parseClientInput(() => parseEvmFeeSelection(options.feeTier))
      const executionMode = options?.executionMode ?? 'main'
      if (executionMode !== 'main' && executionMode !== 'private') {
        throw new EvmWalletClientError(
          'invalid-response',
          'Invalid EVM contract call execution mode'
        )
      }
      return send(
        {
          type: 'PREPARE_EVM_CONTRACT_CALL',
          intent: parsedIntent,
          ...(options?.rheaSwapBinding === undefined
            ? {}
            : { rheaSwapBinding: options.rheaSwapBinding }),
          ...(feeSelection === undefined ? {} : { feeSelection }),
          executionMode,
          ...(options?.debugRequestId === undefined
            ? {}
            : { debugRequestId: options.debugRequestId })
        },
        value => parseTransferReview(value)
      )
    },
    getTokenAllowance: async (
      chainId: string,
      token: string,
      spender: string,
      expectedOwner: string,
      executionMode: 'main' | 'private' = 'main'
    ) => {
      const parsedChainId = parseClientInput(() => parseChainId(chainId).id)
      if (
        !parsedChainId.startsWith('eip155:') ||
        [token, spender, expectedOwner].some(value => !/^0x[0-9a-fA-F]{40}$/.test(value)) ||
        (executionMode !== 'main' && executionMode !== 'private')
      ) {
        throw new EvmWalletClientError('invalid-request', 'Invalid EVM allowance request')
      }
      return send(
        {
          type: 'GET_EVM_TOKEN_ALLOWANCE',
          chainId: parsedChainId,
          token,
          spender,
          expectedOwner,
          executionMode
        },
        value => {
          if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
            throw new Error('Invalid EVM allowance response')
          }
          return value
        }
      )
    },
    prepareCancel: async (
      chainId: string,
      originalTransactionId: TransactionId,
      executionMode: 'main' | 'private' = 'main'
    ) => {
      const parsedChainId = parseClientInput(() => parseChainId(chainId).id)
      const parsedTransactionId = parseClientInput(() => parseTransactionId(originalTransactionId))
      if (!parsedChainId.startsWith('eip155:')) {
        throw new EvmWalletClientError('invalid-response', 'EVM cancel requires an EVM chain')
      }
      return send(
        {
          type: 'PREPARE_EVM_CANCEL',
          chainId: parsedChainId,
          originalTransactionId: parsedTransactionId,
          executionMode
        },
        value => {
          const prepared = parseTransferReview(value)
          if (
            prepared.review.chainId !== parsedChainId ||
            prepared.graph.root.relation?.kind !== 'replacement-of' ||
            prepared.graph.root.relation.transactionId !== parsedTransactionId
          ) {
            throw new Error('EVM cancellation review does not match its request')
          }
          return prepared
        }
      )
    },
    getNonceRecovery: async (chainId: string, executionMode: 'main' | 'private' = 'main') => {
      const parsedChainId = parseClientInput(() => parseChainId(chainId).id)
      if (!parsedChainId.startsWith('eip155:')) {
        throw new EvmWalletClientError('invalid-response', 'EVM recovery requires an EVM chain')
      }
      return send(
        { type: 'GET_EVM_NONCE_RECOVERY', chainId: parsedChainId, executionMode },
        value => {
          if (value === null) return null
          const record = readRecord(value, 'EVM nonce recovery')
          const allowed = [
            'chainId',
            'pendingNonce',
            'highestLocalNonce',
            'action',
            'transactionId'
          ]
          if (
            Object.keys(record).some(key => !allowed.includes(key)) ||
            record.chainId !== parsedChainId ||
            typeof record.pendingNonce !== 'string' ||
            !/^(0|[1-9][0-9]{0,19})$/.test(record.pendingNonce) ||
            typeof record.highestLocalNonce !== 'string' ||
            !/^(0|[1-9][0-9]{0,19})$/.test(record.highestLocalNonce) ||
            (record.action !== 'await-confirmation' &&
              BigInt(record.highestLocalNonce) < BigInt(record.pendingNonce)) ||
            (record.action !== 'retry-broadcast' &&
              record.action !== 'await-confirmation' &&
              record.action !== 'replace' &&
              record.action !== 'fill-gap') ||
            (record.action === 'fill-gap' && record.transactionId !== undefined) ||
            (record.action !== 'fill-gap' && record.transactionId === undefined)
          ) {
            throw new EvmWalletClientError('invalid-response', 'Invalid EVM nonce recovery')
          }
          return Object.freeze({
            chainId: parsedChainId,
            pendingNonce: record.pendingNonce,
            highestLocalNonce: record.highestLocalNonce,
            action: record.action,
            ...(record.transactionId === undefined
              ? {}
              : { transactionId: parseTransactionId(record.transactionId) })
          }) as EvmNonceRecoveryState
        }
      )
    },
    prepareNonceRecovery: async (
      chainId: string,
      executionMode: 'main' | 'private' = 'main',
      feeSelection?: EvmFeeSelection
    ) => {
      const parsedChainId = parseClientInput(() => parseChainId(chainId).id)
      if (!parsedChainId.startsWith('eip155:')) {
        throw new EvmWalletClientError('invalid-response', 'EVM recovery requires an EVM chain')
      }
      const parsedFeeSelection =
        feeSelection === undefined
          ? undefined
          : parseClientInput(() => parseEvmFeeSelection(feeSelection))
      return send(
        {
          type: 'PREPARE_EVM_NONCE_RECOVERY',
          chainId: parsedChainId,
          executionMode,
          ...(parsedFeeSelection === undefined ? {} : { feeSelection: parsedFeeSelection })
        },
        value => {
          const review = parseTransferReview(value)
          if (review.review.chainId !== parsedChainId || review.graph.root.kind !== 'cancel') {
            throw new Error('EVM nonce recovery review does not match its request')
          }
          return review
        }
      )
    },
    getPendingTransfer: async (transactionId: TransactionId) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'GET_PENDING_EVM_TRANSFER',
          transactionId: parsedTransactionId
        },
        value =>
          value === null ? null : parseTransferReview(value, parsedTransactionId, undefined)
      )
    },
    approveTransfer: async (transactionId: TransactionId, payloadFingerprint: string) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'APPROVE_EVM_TRANSFER',
          transactionId: parsedTransactionId,
          payloadFingerprint: parseClientInput(() => parseFingerprint(payloadFingerprint))
        },
        value => parseApprovalResult(value, parsedTransactionId)
      )
    },
    rejectTransfer: async (transactionId: TransactionId) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'REJECT_EVM_TRANSFER', transactionId: parsedTransactionId }, value => {
        const graph = parseTransactionGraph(value)
        assertGraphTransactionId(graph, parsedTransactionId)
        return graph
      })
    },
    getExternalSigningRequest: async (transactionId: TransactionId) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        { type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST', transactionId: parsedTransactionId },
        value => parseExternalSigningRequest(value, parsedTransactionId)
      )
    },
    submitExternalSignature: async (
      transactionId: TransactionId,
      payloadFingerprint: string,
      signatureCborBase64: string
    ) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send(
        {
          type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE',
          transactionId: parsedTransactionId,
          payloadFingerprint: parseClientInput(() => parseFingerprint(payloadFingerprint)),
          signatureCborBase64: parseClientInput(() =>
            /^0x[0-9a-f]{130}$/.test(signatureCborBase64)
              ? signatureCborBase64
              : parseCanonicalBase64(signatureCborBase64, 'Keystone EVM signature')
          )
        },
        value => parseSubmission(value, parsedTransactionId)
      )
    },
    resumeTransfer: async (transactionId: TransactionId) => {
      const parsedTransactionId = parseClientInput(() => parseTransactionId(transactionId))
      return send({ type: 'RESUME_EVM_TRANSFER', transactionId: parsedTransactionId }, value =>
        parseSubmission(value, parsedTransactionId)
      )
    },
    getTransferActivity: async (graph: TransactionGraph) => {
      const parsedGraph = parseClientInput(() => parseTransactionGraph(graph))
      const response = await sendMessage({ type: 'GET_ACTIVITY', action: 'read' })
      const envelope = readRecord(response, 'Activity response')
      if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
        assertExactKeys(envelope, ['error'], 'Activity error response')
        throw parseRuntimeError(envelope.error)
      }
      try {
        return parseEvmTransferActivityResponse(envelope, parsedGraph)
      } catch {
        throw new EvmWalletClientError('invalid-response', 'Invalid EVM runtime result')
      }
    }
  })
}

export const evmWalletClient = createEvmWalletClient(message => chrome.runtime.sendMessage(message))
