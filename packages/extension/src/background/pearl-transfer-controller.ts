import type { SigningSummary } from '@/core/keyring/domain'
import {
  parseNearIntentsTransactionBinding,
  parseRheaSwapTransactionBinding,
  parseNetworkFeeTier,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import {
  parsePearlTransferIntent,
  parsePearlFeeRate,
  pearlFeeTargetBlocks,
  PearlTransactionBuildError,
  type ActivePearlDiscoveryContext,
  type PearlDiscoveryState,
  type PearlTransferOrchestrator,
  type PearlTransferPreparationCoordinator,
  type PearlExternalSigningRequest,
  type PearlPendingRecoveryResult,
  type PearlTransferApprovalResult,
  type PearlTransferSubmission,
  type PreparedPearlTransferApproval
} from '@/infrastructure/chains/pearl'
import { accountContextTransition } from './account-context-transition'

export interface BackgroundPearlTransferControllerOptions {
  readonly preparation: Pick<PearlTransferPreparationCoordinator, 'prepare'>
  readonly orchestrator: Pick<
    PearlTransferOrchestrator,
    | 'prepare'
    | 'approve'
    | 'getPendingApproval'
    | 'getExternalSigningRequest'
    | 'submitExternalSignature'
    | 'reject'
    | 'resumeBroadcast'
    | 'cancelAwaitingApprovalsForScope'
    | 'cancelAwaitingApprovalsExceptScope'
    | 'cancelAllAwaitingApprovals'
    | 'cancelExpiredApprovalsForScope'
    | 'clearPendingTransfers'
    | 'recoverPendingTransfers'
    | 'releaseOrphanedInputReservations'
  >
  readonly loadActiveContext: () => Promise<ActivePearlDiscoveryContext | null>
  readonly scanActive: (options?: {
    readonly forceRefresh?: boolean
  }) => Promise<PearlDiscoveryState | null>
  readonly requiredConfirmations: number
  readonly createId?: () => string
}

export interface BackgroundPearlTransferReview {
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

const DEFAULT_ADDRESS_SCHEME = 'pearl_p2tr' as const
function toBackgroundReview(value: PreparedPearlTransferApproval): BackgroundPearlTransferReview {
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

function assertDiscoveryMatchesContext(
  discovery: PearlDiscoveryState,
  context: ActivePearlDiscoveryContext
): void {
  if (
    discovery.chainAccount.id !== context.chainAccount.id ||
    discovery.chainAccount.scope.keyDomainId !== context.chainAccount.scope.keyDomainId ||
    discovery.chainAccount.scope.accountId !== context.chainAccount.scope.accountId ||
    discovery.chainAccount.scope.chainId !== context.chainAccount.scope.chainId ||
    discovery.accountIndex !== context.accountIndex
  ) {
    throw new Error('Pearl discovery does not match the active Account')
  }
}

export class BackgroundPearlTransferController {
  private readonly createId: () => string

  constructor(private readonly options: BackgroundPearlTransferControllerOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown,
    feeTierValue?: unknown,
    addressSchemeValue?: unknown,
    feeRateSatsPerVbyteValue?: unknown,
    rheaSwapBindingValue?: unknown
  ): Promise<BackgroundPearlTransferReview> {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const intent = parsePearlTransferIntent(intentValue, context.chainAccount.scope.chainId)
      const nearIntentsBinding =
        nearIntentsBindingValue === undefined
          ? undefined
          : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
      const rheaSwapBinding =
        rheaSwapBindingValue === undefined
          ? undefined
          : parseRheaSwapTransactionBinding(rheaSwapBindingValue)
      const feeTier = parseNetworkFeeTier(feeTierValue ?? 'standard')
      const feeRateSatsPerVbyte =
        feeRateSatsPerVbyteValue === undefined
          ? undefined
          : parsePearlFeeRate(feeRateSatsPerVbyteValue)
      if (
        addressSchemeValue !== undefined &&
        addressSchemeValue !== 'pearl_p2tr' &&
        addressSchemeValue !== 'p2tr'
      ) {
        throw new Error('Unsupported Pearl address scheme')
      }
      const addressScheme = DEFAULT_ADDRESS_SCHEME
      if (context.keyDomainSource.kind === 'hardware') {
        throw new Error('Pearl hardware transfers are unsupported')
      }
      let discovery = await this.options.scanActive()
      if (!discovery) throw new Error('Pearl discovery did not complete for the active Account')
      assertDiscoveryMatchesContext(discovery, context)
      await this.options.orchestrator.cancelExpiredApprovalsForScope(context.chainAccount.scope)
      await this.options.orchestrator.releaseOrphanedInputReservations({
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex,
        addressScheme
      })
      const preparationInput = {
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex,
        addressScheme,
        recipient: intent.recipient,
        amount: intent.amount,
        ...(feeRateSatsPerVbyteValue === undefined
          ? { feeTargetBlocks: pearlFeeTargetBlocks(feeTier) }
          : { feeRateSatsPerVbyte })
      } as const
      const buildPlan = async () => {
        const id = this.createId()
        const transactionId = parseTransactionId(`transaction:pearl:${id}`)
        const segmentId = parseTransactionSegmentId(`segment:pearl:${id}`)
        const plan = await this.options.preparation.prepare({
          ...preparationInput,
          transactionId
        })
        return Object.freeze({ plan, transactionId, segmentId })
      }
      let built: Awaited<ReturnType<typeof buildPlan>>
      try {
        built = await buildPlan()
      } catch (error) {
        // Stale discovery after an external broadcast can look solvent in portfolio while
        // reserved/spent outpoints leave coin selection empty until a forced refresh.
        if (!(error instanceof PearlTransactionBuildError) || error.code !== 'insufficient-funds') {
          throw error
        }
        discovery = await this.options.scanActive({ forceRefresh: true })
        if (!discovery) throw new Error('Pearl discovery did not complete for the active Account')
        assertDiscoveryMatchesContext(discovery, context)
        await this.options.orchestrator.releaseOrphanedInputReservations({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          addressScheme
        })
        built = await buildPlan()
      }
      return toBackgroundReview(
        await this.options.orchestrator.prepare({
          chainAccount: context.chainAccount,
          transactionId: built.transactionId,
          segmentId: built.segmentId,
          prepared: built.plan.prepared,
          signerAddress: built.plan.signerAddress,
          changeReservation: built.plan.changeReservation,
          inputReservation: built.plan.inputReservation,
          requiredConfirmations: this.options.requiredConfirmations,
          signingMode: 'internal',
          ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding }),
          ...(rheaSwapBinding === undefined ? {} : { rheaSwapBinding })
        })
      )
    })
  }

  async approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<PearlTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActivePearlDiscoveryContext) => Promise<void>
  ): Promise<PearlTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActivePearlDiscoveryContext) => Promise<void>
  ): Promise<PearlTransferApprovalResult> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      await authorize?.(context)
      return this.options.orchestrator.approve({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint
      })
    })
  }

  async getExternalSigningRequest(
    _transactionIdValue: string
  ): Promise<PearlExternalSigningRequest | null> {
    throw new Error('Pearl hardware transfers are unsupported')
  }

  async submitExternalSignature(
    _transactionIdValue: string,
    _payloadFingerprint: string,
    _signedPsbtBase64: string
  ): Promise<PearlTransferSubmission> {
    throw new Error('Pearl hardware transfers are unsupported')
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundPearlTransferReview | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const pending = await this.options.orchestrator.getPendingApproval({
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
      return this.options.orchestrator.reject({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  async resumeBroadcast(transactionIdValue: string): Promise<PearlTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      return this.options.orchestrator.resumeBroadcast({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  cancelAwaitingApprovalsForScope(scope: TransactionAccountScope): Promise<number> {
    return this.options.orchestrator.cancelAwaitingApprovalsForScope(scope)
  }

  cancelAwaitingApprovalsExceptScope(scope: TransactionAccountScope): Promise<number> {
    return this.options.orchestrator.cancelAwaitingApprovalsExceptScope(scope)
  }

  clearPendingTransfers(): Promise<number> {
    return this.options.orchestrator.clearPendingTransfers()
  }

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.options.orchestrator.cancelAllAwaitingApprovals()
  }

  recoverPendingTransfers(): Promise<PearlPendingRecoveryResult> {
    return this.options.orchestrator.recoverPendingTransfers()
  }

  private async requireActiveContext(): Promise<ActivePearlDiscoveryContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('The active Account has no Pearl ChainAccount')
    return context
  }
}
