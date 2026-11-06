import type { ChainId } from '@/core/chains/domain'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import {
  parseTransactionId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import {
  parseEvmContractCallIntent,
  parseEvmTransferIntent,
  type EvmPendingTransferStore,
  type EvmNonceRecoveryState,
  type PeaEvmExecutionAccount,
  type EvmTransferApprovalResult,
  type EvmTransferSubmission,
  type PendingEvmTransfer
} from '@/infrastructure/chains/evm'
import type {
  BackgroundEvmExternalSigningRequest,
  BackgroundEvmTransferReview,
  EvmTransferExecutionMode
} from './evm-transfer-controller'

export interface BackgroundEvmTransferRouteController {
  readonly prepare: (
    intentValue: unknown,
    nearIntentsBindingValue?: unknown,
    feeTierValue?: unknown,
    executionModeValue?: unknown,
    executionAccount?: PeaEvmExecutionAccount,
    rheaSwapBindingValue?: unknown,
    debugRequestId?: string
  ) => Promise<BackgroundEvmTransferReview>
  readonly prepareContractCall: (
    intentValue: unknown,
    feeTierValue?: unknown,
    rheaSwapBindingValue?: unknown,
    executionAccount?: PeaEvmExecutionAccount,
    executionModeValue?: unknown,
    debugRequestId?: string
  ) => Promise<BackgroundEvmTransferReview>
  readonly getTokenAllowance: (
    token: string,
    spender: string,
    expectedOwner: string,
    executionModeValue?: unknown
  ) => Promise<string>
  readonly approve: (
    transactionIdValue: string,
    payloadFingerprint: string
  ) => Promise<EvmTransferApprovalResult>
  readonly approveForDApp: (
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (
      context: import('@/infrastructure/chains/evm').ActiveEvmPortfolioContext
    ) => Promise<void>
  ) => Promise<EvmTransferApprovalResult>
  readonly prepareCancel: (
    originalTransactionIdValue: string,
    executionModeValue?: unknown
  ) => Promise<BackgroundEvmTransferReview>
  readonly getNonceRecovery: (executionModeValue?: unknown) => Promise<EvmNonceRecoveryState | null>
  readonly prepareNonceRecovery: (
    executionModeValue?: unknown,
    feeSelectionValue?: unknown
  ) => Promise<BackgroundEvmTransferReview>
  readonly getPendingApproval: (
    transactionIdValue: string
  ) => Promise<BackgroundEvmTransferReview | null>
  readonly getExternalSigningRequest: (
    transactionIdValue: string
  ) => Promise<BackgroundEvmExternalSigningRequest | null>
  readonly submitExternalSignature: (
    transactionIdValue: string,
    payloadFingerprint: string,
    signatureCborBase64: string
  ) => Promise<EvmTransferSubmission>
  readonly reject: (transactionIdValue: string) => Promise<TransactionGraph>
  readonly rejectForScope: (
    transactionIdValue: string,
    scope: TransactionAccountScope
  ) => Promise<TransactionGraph>
  readonly resumeBroadcast: (transactionIdValue: string) => Promise<EvmTransferSubmission>
  readonly cancelAwaitingApprovalsForScope: (scope: TransactionAccountScope) => Promise<number>
  readonly cancelAwaitingApprovalsExceptScope: (scope: TransactionAccountScope) => Promise<number>
  readonly clearPendingTransfers: () => Promise<number>
  readonly cancelAllAwaitingApprovals: () => Promise<number>
}

type MaintenanceController = Pick<
  BackgroundEvmTransferRouteController,
  | 'cancelAwaitingApprovalsForScope'
  | 'cancelAwaitingApprovalsExceptScope'
  | 'clearPendingTransfers'
  | 'cancelAllAwaitingApprovals'
>

export interface BackgroundEvmTransferRouterOptions {
  readonly controllers: ReadonlyMap<ChainId, BackgroundEvmTransferRouteController>
  readonly pendingStore: EvmPendingTransferStore
  readonly transactions: TransactionRepository
}

function preparedChainId(pending: PendingEvmTransfer): ChainId | null {
  if (pending.phase === 'signed') return null
  return pending.prepared.chainId
}

function resolveSignedGraphChainId(graph: TransactionGraph): ChainId {
  const originSegments = graph.segments.flatMap(segment =>
    segment.role === 'origin' && segment.target.kind === 'onchain' ? [segment.target] : []
  )
  if (originSegments.length !== 1) {
    throw new Error('Signed EVM transfer has an ambiguous origin chain')
  }
  const chain = parseChainId(originSegments[0].chainId)
  if (chain.namespace !== 'eip155') {
    throw new Error('Signed EVM transfer origin is not an EVM chain')
  }
  const senderChainId = graph.root.intent?.sender?.chainId
  const primaryAssetId = graph.root.intent?.primaryAmount?.assetId
  const feeAssetId = graph.root.intent?.feeLimit?.assetId
  const primaryAssetMatches =
    (graph.root.kind === 'contract-call' || graph.root.kind === 'cancel') &&
    primaryAssetId === undefined
      ? true
      : primaryAssetId !== undefined && parseAssetId(primaryAssetId).chainId === chain.id
  if (
    senderChainId !== chain.id ||
    !primaryAssetMatches ||
    feeAssetId === undefined ||
    parseAssetId(feeAssetId).chainId !== chain.id
  ) {
    throw new Error('Signed EVM transfer graph chain binding is invalid')
  }
  return chain.id
}

export class BackgroundEvmTransferRouter {
  private readonly controllers: ReadonlyMap<ChainId, BackgroundEvmTransferRouteController>
  private readonly maintenanceController: MaintenanceController

  constructor(private readonly options: BackgroundEvmTransferRouterOptions) {
    if (options.controllers.size === 0) {
      throw new Error('EVM transfer router requires at least one network controller')
    }
    this.controllers = new Map(options.controllers)
    this.maintenanceController = this.controllers.values().next().value as MaintenanceController
  }

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown,
    feeTierValue?: unknown,
    executionMode: EvmTransferExecutionMode = 'main',
    rheaSwapBindingValue?: unknown,
    debugRequestId?: string
  ): Promise<BackgroundEvmTransferReview> {
    const intent = parseEvmTransferIntent(intentValue)
    const chainId = parseAssetId(intent.assetId).chainId
    const controller = this.requireController(chainId)
    const result = await controller.prepare(
      intent,
      nearIntentsBindingValue,
      feeTierValue,
      executionMode,
      undefined,
      rheaSwapBindingValue,
      debugRequestId
    )
    if (result.review.chainId !== chainId) {
      throw new Error('Prepared EVM transfer was returned by the wrong network controller')
    }
    return result
  }

  async prepareContractCall(
    intentValue: unknown,
    feeTierValue?: unknown,
    rheaSwapBindingValue?: unknown,
    executionMode: EvmTransferExecutionMode = 'main',
    debugRequestId?: string
  ): Promise<BackgroundEvmTransferReview> {
    const intent = parseEvmContractCallIntent(intentValue)
    const controller = this.requireController(intent.chainId)
    const result = await controller.prepareContractCall(
      intent,
      feeTierValue,
      rheaSwapBindingValue,
      undefined,
      executionMode,
      debugRequestId
    )
    if (result.review.chainId !== intent.chainId) {
      throw new Error('Prepared EVM contract call was returned by the wrong network controller')
    }
    return result
  }

  async getTokenAllowance(
    chainIdValue: string,
    token: string,
    spender: string,
    expectedOwner: string,
    executionMode: EvmTransferExecutionMode = 'main'
  ): Promise<string> {
    const chain = parseChainId(chainIdValue)
    if (chain.namespace !== 'eip155') throw new Error('EVM allowance requires an EVM chain')
    return this.requireController(chain.id).getTokenAllowance(
      token,
      spender,
      expectedOwner,
      executionMode
    )
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundEvmTransferReview | null> {
    const routed = await this.resolvePendingController(transactionIdValue)
    return routed?.controller.getPendingApproval(routed.transactionId) ?? null
  }

  async hasPendingTransferForScope(
    transactionIdValue: string,
    scope: TransactionAccountScope
  ): Promise<boolean> {
    const pending = await this.options.pendingStore.get(parseTransactionId(transactionIdValue))
    if (!pending) return false
    if (
      pending.scope.keyDomainId !== scope.keyDomainId ||
      pending.scope.accountId !== scope.accountId
    ) {
      throw new Error('Pending EVM transfer belongs to another account')
    }
    return true
  }

  async prepareCancel(
    chainIdValue: string,
    originalTransactionIdValue: string,
    executionMode: EvmTransferExecutionMode = 'main'
  ): Promise<BackgroundEvmTransferReview> {
    const chain = parseChainId(chainIdValue)
    if (chain.namespace !== 'eip155') throw new Error('EVM cancel requires an EVM chain')
    const result = await this.requireController(chain.id).prepareCancel(
      originalTransactionIdValue,
      executionMode
    )
    if (result.review.chainId !== chain.id) {
      throw new Error('Prepared EVM cancel was returned by the wrong network controller')
    }
    return result
  }

  async getNonceRecovery(
    chainIdValue: string,
    executionMode: EvmTransferExecutionMode = 'main'
  ): Promise<EvmNonceRecoveryState | null> {
    const chain = parseChainId(chainIdValue)
    if (chain.namespace !== 'eip155') throw new Error('EVM nonce recovery requires an EVM chain')
    const state = await this.requireController(chain.id).getNonceRecovery(executionMode)
    if (state && state.chainId !== chain.id) {
      throw new Error('EVM nonce recovery returned the wrong chain')
    }
    return state
  }

  async prepareNonceRecovery(
    chainIdValue: string,
    executionMode: EvmTransferExecutionMode = 'main',
    feeSelectionValue?: unknown
  ): Promise<BackgroundEvmTransferReview> {
    const chain = parseChainId(chainIdValue)
    if (chain.namespace !== 'eip155') throw new Error('EVM nonce recovery requires an EVM chain')
    const result = await this.requireController(chain.id).prepareNonceRecovery(
      executionMode,
      feeSelectionValue
    )
    if (result.review.chainId !== chain.id) {
      throw new Error('Prepared EVM nonce recovery was returned by the wrong chain')
    }
    return result
  }

  async approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<EvmTransferApprovalResult> {
    const routed = await this.requirePendingController(transactionIdValue)
    return routed.controller.approve(routed.transactionId, payloadFingerprint)
  }

  async approveForPublic(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (
      context: import('@/infrastructure/chains/evm').ActiveEvmPortfolioContext
    ) => Promise<void>
  ): Promise<EvmTransferApprovalResult> {
    const routed = await this.requirePendingController(transactionIdValue)
    return routed.controller.approveForDApp(routed.transactionId, payloadFingerprint, authorize)
  }

  async getExternalSigningRequest(
    transactionIdValue: string
  ): Promise<BackgroundEvmExternalSigningRequest | null> {
    const routed = await this.resolvePendingController(transactionIdValue)
    return routed?.controller.getExternalSigningRequest(routed.transactionId) ?? null
  }

  async submitExternalSignature(
    transactionIdValue: string,
    payloadFingerprint: string,
    signatureCborBase64: string
  ): Promise<EvmTransferSubmission> {
    const routed = await this.requirePendingController(transactionIdValue)
    return routed.controller.submitExternalSignature(
      routed.transactionId,
      payloadFingerprint,
      signatureCborBase64
    )
  }

  async reject(transactionIdValue: string): Promise<TransactionGraph> {
    const routed = await this.requirePendingController(transactionIdValue)
    return routed.controller.reject(routed.transactionId)
  }

  async rejectForScope(
    transactionIdValue: string,
    scope: TransactionAccountScope
  ): Promise<boolean> {
    return (await this.rejectForScopeWithGraph(transactionIdValue, scope)) !== null
  }

  async rejectForScopeWithGraph(
    transactionIdValue: string,
    scope: TransactionAccountScope
  ): Promise<TransactionGraph | null> {
    const routed = await this.resolvePendingController(transactionIdValue)
    if (!routed) return null
    return routed.controller.rejectForScope(routed.transactionId, scope)
  }

  async resumeBroadcast(transactionIdValue: string): Promise<EvmTransferSubmission> {
    const routed = await this.requirePendingController(transactionIdValue)
    return routed.controller.resumeBroadcast(routed.transactionId)
  }

  cancelAwaitingApprovalsForScope(
    scope: Parameters<MaintenanceController['cancelAwaitingApprovalsForScope']>[0]
  ): Promise<number> {
    return this.maintenanceController.cancelAwaitingApprovalsForScope(scope)
  }

  cancelAwaitingApprovalsExceptScope(
    scope: Parameters<MaintenanceController['cancelAwaitingApprovalsExceptScope']>[0]
  ): Promise<number> {
    return this.maintenanceController.cancelAwaitingApprovalsExceptScope(scope)
  }

  clearPendingTransfers(): Promise<number> {
    return this.maintenanceController.clearPendingTransfers()
  }

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.maintenanceController.cancelAllAwaitingApprovals()
  }

  private async requirePendingController(transactionIdValue: string) {
    const routed = await this.resolvePendingController(transactionIdValue)
    if (!routed) throw new Error('Pending EVM transfer was not found')
    return routed
  }

  private async resolvePendingController(transactionIdValue: string): Promise<{
    readonly transactionId: string
    readonly controller: BackgroundEvmTransferRouteController
  } | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    const pending = await this.options.pendingStore.get(transactionId)
    if (!pending) return null
    let chainId = preparedChainId(pending)
    if (chainId === null) {
      const graph = await this.options.transactions.get(pending.scope, transactionId)
      if (!graph) throw new Error('Signed EVM transfer graph was not found')
      chainId = resolveSignedGraphChainId(graph)
    }
    return Object.freeze({ transactionId, controller: this.requireController(chainId) })
  }

  private requireController(chainId: ChainId): BackgroundEvmTransferRouteController {
    const controller = this.controllers.get(chainId)
    if (!controller) throw new Error('The selected EVM network is unavailable')
    return controller
  }
}
