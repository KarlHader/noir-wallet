import type { ChainId } from '@/core/chains/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { SigningSummary } from '@/core/keyring/domain'
import {
  parseTransactionId,
  parseNearIntentsTransactionBinding,
  parseRheaSwapTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import {
  parseEvmContractCallIntent,
  parseEvmFeeSelection,
  parseEvmTransferIntent,
  type EvmFeeSelection,
  type EvmNonceRecoveryState,
  type ActiveEvmPortfolioContext,
  type EvmExternalSigningRequest,
  type PeaEvmExecutionAccount,
  type EvmTransferOrchestrator,
  type EvmTransferApprovalResult,
  type EvmTransferSubmission,
  type PreparedEvmTransferApproval,
  parseEvmAccountBinding
} from '@/infrastructure/chains/evm'
import { accountContextTransition } from './account-context-transition'
import { traceDebugStage } from '@/lib/debug-performance'

export interface BackgroundEvmTransferControllerOptions {
  readonly orchestrator: EvmTransferOrchestrator
  readonly loadActiveContext: () => Promise<ActiveEvmPortfolioContext | null>
  readonly resolveExternalSigner: (
    chainAccount: ActiveEvmPortfolioContext['chainAccount']
  ) => Promise<{
    readonly derivationPath: string
    readonly masterFingerprintHex?: string
    readonly address: string
  }>
  readonly resolvePrivateExecutionAccount?: (
    context: ActiveEvmPortfolioContext
  ) => Promise<PeaEvmExecutionAccount>
  readonly readTokenAllowance: (token: string, owner: string, spender: string) => Promise<string>
}

export type EvmTransferExecutionMode = 'main' | 'private'

export interface BackgroundEvmTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: ChainId
    readonly operation: 'transaction'
    readonly summary: SigningSummary
    readonly payloadFingerprint: {
      readonly algorithm: 'sha256'
      readonly digestHex: string
    }
    readonly expiresAt: number
  }
}

export interface BackgroundEvmExternalSigningRequest extends EvmExternalSigningRequest {
  readonly chainId: ChainId
}

function toBackgroundReview(value: PreparedEvmTransferApproval): BackgroundEvmTransferReview {
  return Object.freeze({
    graph: value.graph,
    review: Object.freeze({
      chainId: value.signing.chainId,
      operation: 'transaction' as const,
      summary: value.signing.summary,
      payloadFingerprint: value.signing.payloadFingerprint,
      expiresAt: value.signing.expiresAt
    })
  })
}

export class BackgroundEvmTransferController {
  private readonly orchestrator: EvmTransferOrchestrator
  private readonly loadActiveContext: () => Promise<ActiveEvmPortfolioContext | null>
  private readonly resolveExternalSigner: BackgroundEvmTransferControllerOptions['resolveExternalSigner']
  private readonly resolvePrivateExecutionAccount?: BackgroundEvmTransferControllerOptions['resolvePrivateExecutionAccount']
  private readonly readTokenAllowance: BackgroundEvmTransferControllerOptions['readTokenAllowance']

  constructor(options: BackgroundEvmTransferControllerOptions) {
    this.orchestrator = options.orchestrator
    this.loadActiveContext = options.loadActiveContext
    this.resolveExternalSigner = options.resolveExternalSigner
    this.resolvePrivateExecutionAccount = options.resolvePrivateExecutionAccount
    this.readTokenAllowance = options.readTokenAllowance
  }

  private async resolveTransactionExternalSigner(
    chainAccount: ActiveEvmPortfolioContext['chainAccount']
  ) {
    const signer = await this.resolveExternalSigner(chainAccount)
    return {
      derivationPath: signer.derivationPath,
      ...(signer.masterFingerprintHex === undefined
        ? {}
        : { masterFingerprintHex: signer.masterFingerprintHex }),
      address: signer.address
    }
  }

  async getLedgerSignerBinding(chainAccount: ActiveEvmPortfolioContext['chainAccount']) {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (
        context.keyDomainSource.kind !== 'hardware' ||
        context.keyDomainSource.vendor !== 'ledger' ||
        context.chainAccount.id !== chainAccount.id
      ) {
        throw new Error('Active EVM account is not an authenticated Ledger account')
      }
      return this.resolveExternalSigner(context.chainAccount)
    })
  }

  async getTokenAllowance(
    token: string,
    spender: string,
    expectedOwner: string,
    executionModeValue: unknown = 'main'
  ): Promise<string> {
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM allowance execution mode')
    }
    if (typeof expectedOwner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(expectedOwner)) {
      throw new Error('Invalid EVM allowance owner')
    }
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const owner =
        executionModeValue === 'private'
          ? (await this.requirePrivateExecutionAccount(context)).address
          : parseEvmAccountBinding(context.chainAccount, context.chainAccount.scope.chainId).address
      if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
        throw new Error('EVM allowance owner does not match the selected wallet address')
      }
      return this.readTokenAllowance(token, owner, spender)
    })
  }

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown,
    feeSelectionValue?: unknown,
    executionModeValue: unknown = 'main',
    executionAccount?: PeaEvmExecutionAccount,
    rheaSwapBindingValue?: unknown,
    debugRequestId?: string
  ): Promise<BackgroundEvmTransferReview> {
    const intent = parseEvmTransferIntent(intentValue)
    const nearIntentsBinding =
      nearIntentsBindingValue === undefined
        ? undefined
        : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
    const rheaSwapBinding =
      rheaSwapBindingValue === undefined
        ? undefined
        : parseRheaSwapTransactionBinding(rheaSwapBindingValue)
    const feeSelection =
      feeSelectionValue === undefined ? undefined : parseEvmFeeSelection(feeSelectionValue)
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM transfer execution mode')
    }
    if (executionAccount !== undefined && executionModeValue !== 'main') {
      throw new Error('EVM transfer execution account is ambiguous')
    }
    const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      debugRequestId ? traceDebugStage(debugRequestId, stage, operation) : operation()
    return accountContextTransition.runActiveOperation(async () => {
      const context = await measure('evm-load-active-context', () => this.requireActiveContext())
      if (!intent.assetId.startsWith(`${context.chainAccount.scope.chainId}/`)) {
        throw new Error('EVM transfer asset does not match the active network')
      }
      const selectedExecutionAccount =
        executionAccount ??
        (executionModeValue === 'private'
          ? await measure('evm-resolve-confidential-account', () =>
              this.requirePrivateExecutionAccount(context)
            )
          : undefined)
      return toBackgroundReview(
        await measure('evm-orchestrator-prepare', async () =>
          this.orchestrator.prepare({
            chainAccount: context.chainAccount,
            intent,
            ...(selectedExecutionAccount === undefined
              ? {}
              : { executionAccount: selectedExecutionAccount }),
            ...(feeSelection === undefined ? {} : { feeSelection }),
            ...(context.keyDomainSource.kind === 'hardware'
              ? {
                  signingMode:
                    context.keyDomainSource.vendor === 'ledger'
                      ? ('ledger' as const)
                      : ('keystone' as const),
                  externalSigner: await this.resolveTransactionExternalSigner(context.chainAccount)
                }
              : { signingMode: 'internal' as const }),
            ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding }),
            ...(rheaSwapBinding === undefined ? {} : { rheaSwapBinding })
          })
        )
      )
    })
  }

  async prepareContractCall(
    intentValue: unknown,
    feeSelectionValue?: unknown,
    rheaSwapBindingValue?: unknown,
    executionAccount?: PeaEvmExecutionAccount,
    executionModeValue: unknown = 'main',
    debugRequestId?: string
  ): Promise<BackgroundEvmTransferReview> {
    const intent = parseEvmContractCallIntent(intentValue)
    const rheaSwapBinding =
      rheaSwapBindingValue === undefined
        ? undefined
        : parseRheaSwapTransactionBinding(rheaSwapBindingValue)
    const feeSelection = parseEvmFeeSelection(
      feeSelectionValue ?? { kind: 'tier', tier: 'standard' }
    )
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM contract call execution mode')
    }
    if (executionAccount !== undefined && executionModeValue !== 'main') {
      throw new Error('EVM contract call execution account is ambiguous')
    }
    const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      debugRequestId ? traceDebugStage(debugRequestId, stage, operation) : operation()
    return accountContextTransition.runActiveOperation(async () => {
      const context = await measure('evm-load-active-context', () => this.requireActiveContext())
      if (intent.chainId !== context.chainAccount.scope.chainId) {
        throw new Error('EVM contract call does not match the active network')
      }
      const selectedExecutionAccount =
        executionAccount ??
        (executionModeValue === 'private'
          ? await measure('evm-resolve-confidential-account', () =>
              this.requirePrivateExecutionAccount(context)
            )
          : undefined)
      return toBackgroundReview(
        await measure('evm-orchestrator-prepare', async () =>
          this.orchestrator.prepare({
            chainAccount: context.chainAccount,
            intent,
            feeSelection,
            ...(rheaSwapBinding === undefined ? {} : { rheaSwapBinding }),
            ...(selectedExecutionAccount === undefined
              ? {}
              : { executionAccount: selectedExecutionAccount }),
            ...(context.keyDomainSource.kind === 'hardware'
              ? {
                  signingMode:
                    context.keyDomainSource.vendor === 'ledger'
                      ? ('ledger' as const)
                      : ('keystone' as const),
                  externalSigner: await this.resolveTransactionExternalSigner(context.chainAccount)
                }
              : { signingMode: 'internal' as const })
          })
        )
      )
    })
  }

  async prepareCancel(
    originalTransactionIdValue: string,
    executionModeValue: unknown = 'main'
  ): Promise<BackgroundEvmTransferReview> {
    const originalTransactionId = parseTransactionId(originalTransactionIdValue)
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM cancel execution mode')
    }
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const executionAccount =
        executionModeValue === 'private'
          ? await this.requirePrivateExecutionAccount(context)
          : undefined
      return toBackgroundReview(
        await this.orchestrator.prepareCancel({
          chainAccount: context.chainAccount,
          originalTransactionId,
          ...(executionAccount === undefined ? {} : { executionAccount }),
          ...(context.keyDomainSource.kind === 'hardware'
            ? {
                signingMode:
                  context.keyDomainSource.vendor === 'ledger'
                    ? ('ledger' as const)
                    : ('keystone' as const),
                externalSigner: await this.resolveTransactionExternalSigner(context.chainAccount)
              }
            : { signingMode: 'internal' as const })
        })
      )
    })
  }

  async getNonceRecovery(
    executionModeValue: unknown = 'main'
  ): Promise<EvmNonceRecoveryState | null> {
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM nonce recovery execution mode')
    }
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const executionAccount =
        executionModeValue === 'private'
          ? await this.requirePrivateExecutionAccount(context)
          : undefined
      return this.orchestrator.getNonceRecovery({
        chainAccount: context.chainAccount,
        ...(executionAccount === undefined ? {} : { executionAccount })
      })
    })
  }

  async prepareNonceRecovery(
    executionModeValue: unknown = 'main',
    feeSelectionValue?: unknown
  ): Promise<BackgroundEvmTransferReview> {
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('Invalid EVM nonce recovery execution mode')
    }
    const feeSelection: EvmFeeSelection | undefined =
      feeSelectionValue === undefined ? undefined : parseEvmFeeSelection(feeSelectionValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const executionAccount =
        executionModeValue === 'private'
          ? await this.requirePrivateExecutionAccount(context)
          : undefined
      return toBackgroundReview(
        await this.orchestrator.prepareNonceRecovery({
          chainAccount: context.chainAccount,
          ...(executionAccount === undefined ? {} : { executionAccount }),
          ...(feeSelection === undefined ? {} : { feeSelection }),
          ...(context.keyDomainSource.kind === 'hardware'
            ? {
                signingMode:
                  context.keyDomainSource.vendor === 'ledger'
                    ? ('ledger' as const)
                    : ('keystone' as const),
                externalSigner: await this.resolveTransactionExternalSigner(context.chainAccount)
              }
            : { signingMode: 'internal' as const })
        })
      )
    })
  }

  async approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<EvmTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveEvmPortfolioContext) => Promise<void>
  ): Promise<EvmTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActiveEvmPortfolioContext) => Promise<void>
  ): Promise<EvmTransferApprovalResult> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      await authorize?.(context)
      return this.orchestrator.approve({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint
      })
    })
  }

  async getExternalSigningRequest(
    transactionIdValue: string
  ): Promise<BackgroundEvmExternalSigningRequest | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveHardwareContext()
      const request = await this.orchestrator.getExternalSigningRequest({
        scope: context.chainAccount.scope,
        transactionId
      })
      return request
        ? Object.freeze({ ...request, chainId: context.chainAccount.scope.chainId })
        : null
    })
  }

  async submitExternalSignature(
    transactionIdValue: string,
    payloadFingerprint: string,
    signatureCborBase64: string
  ): Promise<EvmTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveHardwareContext()
      return this.orchestrator.submitExternalSignature({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint,
        signatureCborBase64
      })
    })
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundEvmTransferReview | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const pending = await this.orchestrator.getPendingApproval({
        scope: context.chainAccount.scope,
        transactionId
      })
      return pending ? toBackgroundReview(pending) : null
    })
  }

  async reject(transactionIdValue: string): Promise<TransactionGraph> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      return this.orchestrator.reject({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  rejectForScope(
    transactionIdValue: string,
    scope: TransactionAccountScope
  ): Promise<TransactionGraph> {
    return this.orchestrator.reject({
      scope,
      transactionId: parseTransactionId(transactionIdValue)
    })
  }

  async resumeBroadcast(transactionIdValue: string): Promise<EvmTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      return this.orchestrator.resumeBroadcast({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  cancelAwaitingApprovalsForScope(scope: TransactionAccountScope): Promise<number> {
    return this.orchestrator.cancelAwaitingApprovalsForScope(scope)
  }

  cancelAwaitingApprovalsExceptScope(scope: TransactionAccountScope): Promise<number> {
    return this.orchestrator.cancelAwaitingApprovalsExceptScope(scope)
  }

  clearPendingTransfers(): Promise<number> {
    return this.orchestrator.clearPendingTransfers()
  }

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.orchestrator.cancelAllAwaitingApprovals()
  }

  private async requireActiveContext(): Promise<ActiveEvmPortfolioContext> {
    const context = await this.loadActiveContext()
    if (!context) throw new Error('The active Account has no EVM ChainAccount')
    return context
  }

  private async requirePrivateExecutionAccount(
    context: ActiveEvmPortfolioContext
  ): Promise<PeaEvmExecutionAccount> {
    if (
      !supportsEvmPrivateExecution(context.keyDomainSource) ||
      !this.resolvePrivateExecutionAccount
    ) {
      throw new Error('Confidential address is unavailable for this wallet')
    }
    return this.resolvePrivateExecutionAccount(context)
  }

  private async requireActiveHardwareContext(): Promise<ActiveEvmPortfolioContext> {
    const context = await this.requireActiveContext()
    if (
      context.keyDomainSource.kind !== 'hardware' ||
      (context.keyDomainSource.vendor !== 'keystone' &&
        context.keyDomainSource.vendor !== 'ledger') ||
      !context.keyDomainSource.capabilities.includes('evm')
    ) {
      throw new Error('The active Wallet is not an EVM-capable hardware Wallet')
    }
    return context
  }
}
