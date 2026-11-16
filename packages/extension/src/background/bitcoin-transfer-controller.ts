import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
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
  parseBitcoinTransferIntent,
  parseBitcoinAddressType,
  parseBitcoinFeeRate,
  bitcoinFeeTargetBlocks,
  type ActiveBitcoinDiscoveryContext,
  type BitcoinDiscoveryState,
  type BitcoinTransferOrchestrator,
  type BitcoinTransferPreparationCoordinator,
  type BitcoinExternalSigningRequest,
  type BitcoinTransferApprovalResult,
  type BitcoinTransferSubmission,
  type PreparedBitcoinTransferApproval
} from '@/infrastructure/chains/bitcoin'
import { accountContextTransition } from './account-context-transition'

export interface BackgroundBitcoinTransferControllerOptions {
  readonly preparation: Pick<BitcoinTransferPreparationCoordinator, 'prepare'>
  readonly orchestrator: Pick<
    BitcoinTransferOrchestrator,
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
  >
  readonly loadActiveContext: () => Promise<ActiveBitcoinDiscoveryContext | null>
  readonly scanActive: (
    addressType: BitcoinSupportedAddressType
  ) => Promise<BitcoinDiscoveryState | null>
  readonly getAddressType?: (
    context: ActiveBitcoinDiscoveryContext
  ) => Promise<BitcoinSupportedAddressType>
  readonly requiredConfirmations: number
  readonly resolveLedgerSigner?: (context: ActiveBitcoinDiscoveryContext) => Promise<{
    readonly accountPath: string
    readonly masterFingerprintHex: string
    readonly expectedAddress: string
    readonly network: 'mainnet' | 'testnet'
  }>
  readonly createId?: () => string
}

export interface BackgroundBitcoinTransferReview {
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

const DEFAULT_ADDRESS_TYPE: BitcoinSupportedAddressType = 'p2wpkh'
function toBackgroundReview(
  value: PreparedBitcoinTransferApproval
): BackgroundBitcoinTransferReview {
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
  discovery: BitcoinDiscoveryState,
  context: ActiveBitcoinDiscoveryContext
): void {
  if (
    discovery.chainAccount.id !== context.chainAccount.id ||
    discovery.chainAccount.scope.keyDomainId !== context.chainAccount.scope.keyDomainId ||
    discovery.chainAccount.scope.accountId !== context.chainAccount.scope.accountId ||
    discovery.chainAccount.scope.chainId !== context.chainAccount.scope.chainId ||
    discovery.accountIndex !== context.accountIndex
  ) {
    throw new Error('Bitcoin discovery does not match the active Account')
  }
}

export class BackgroundBitcoinTransferController {
  private readonly createId: () => string

  constructor(private readonly options: BackgroundBitcoinTransferControllerOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown,
    feeTierValue?: unknown,
    addressTypeValue?: unknown,
    feeRateSatsPerVbyteValue?: unknown,
    rheaSwapBindingValue?: unknown
  ): Promise<BackgroundBitcoinTransferReview> {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const intent = parseBitcoinTransferIntent(intentValue, context.chainAccount.scope.chainId)
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
          : parseBitcoinFeeRate(feeRateSatsPerVbyteValue)
      const addressType =
        addressTypeValue === undefined
          ? ((await this.options.getAddressType?.(context)) ?? DEFAULT_ADDRESS_TYPE)
          : parseBitcoinAddressType(addressTypeValue)
      if (context.keyDomainSource.kind === 'hardware' && addressType !== DEFAULT_ADDRESS_TYPE) {
        throw new Error('Hardware Bitcoin transfers support only the Native SegWit account')
      }
      const discovery = await this.options.scanActive(addressType)
      if (!discovery) throw new Error('Bitcoin discovery did not complete for the active Account')
      assertDiscoveryMatchesContext(discovery, context)
      await this.options.orchestrator.cancelExpiredApprovalsForScope(context.chainAccount.scope)
      const id = this.createId()
      const transactionId = parseTransactionId(`transaction:bitcoin:${id}`)
      const segmentId = parseTransactionSegmentId(`segment:bitcoin:${id}`)
      const plan = await this.options.preparation.prepare({
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex,
        transactionId,
        addressType,
        recipient: intent.recipient,
        amount: intent.amount,
        ...(context.keyDomainSource.kind === 'hardware' &&
        context.keyDomainSource.vendor === 'ledger'
          ? { ledgerAccount: true }
          : {}),
        ...(feeRateSatsPerVbyteValue === undefined
          ? { feeTargetBlocks: bitcoinFeeTargetBlocks(feeTier) }
          : { feeRateSatsPerVbyte })
      })
      return toBackgroundReview(
        await this.options.orchestrator.prepare({
          chainAccount: context.chainAccount,
          transactionId,
          segmentId,
          prepared: plan.prepared,
          signerAddress: plan.signerAddress,
          changeReservation: plan.changeReservation,
          inputReservation: plan.inputReservation,
          requiredConfirmations: this.options.requiredConfirmations,
          signingMode:
            context.keyDomainSource.kind === 'hardware'
              ? context.keyDomainSource.vendor === 'ledger'
                ? 'ledger'
                : 'keystone'
              : 'internal',
          ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding }),
          ...(rheaSwapBinding === undefined ? {} : { rheaSwapBinding })
        })
      )
    })
  }

  async approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<BitcoinTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveBitcoinDiscoveryContext) => Promise<void>
  ): Promise<BitcoinTransferApprovalResult> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActiveBitcoinDiscoveryContext) => Promise<void>
  ): Promise<BitcoinTransferApprovalResult> {
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
    transactionIdValue: string
  ): Promise<BitcoinExternalSigningRequest | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveHardwareContext()
      const request = await this.options.orchestrator.getExternalSigningRequest({
        scope: context.chainAccount.scope,
        transactionId
      })
      if (!request || request.vendor !== 'ledger') return request
      if (!this.options.resolveLedgerSigner) throw new Error('Ledger Bitcoin signer is unavailable')
      if (request.request.encoding !== 'base64' || typeof request.request.value !== 'string') {
        throw new Error('Invalid Ledger Bitcoin PSBT request')
      }
      const signer = await this.options.resolveLedgerSigner(context)
      return Object.freeze({
        ...request,
        ledgerRequest: Object.freeze({
          kind: 'psbt' as const,
          psbtBase64: request.request.value,
          ...signer
        })
      })
    })
  }

  async submitExternalSignature(
    transactionIdValue: string,
    payloadFingerprint: string,
    signedPsbtBase64: string
  ): Promise<BitcoinTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveHardwareContext()
      return this.options.orchestrator.submitExternalSignature({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint,
        signedPsbtBase64
      })
    })
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundBitcoinTransferReview | null> {
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

  async resumeBroadcast(transactionIdValue: string): Promise<BitcoinTransferSubmission> {
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

  private async requireActiveContext(): Promise<ActiveBitcoinDiscoveryContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('The active Account has no Bitcoin ChainAccount')
    return context
  }

  private async requireActiveHardwareContext(): Promise<ActiveBitcoinDiscoveryContext> {
    const context = await this.requireActiveContext()
    if (
      context.keyDomainSource.kind !== 'hardware' ||
      (context.keyDomainSource.vendor !== 'keystone' &&
        context.keyDomainSource.vendor !== 'ledger') ||
      !context.keyDomainSource.capabilities.includes('bitcoin')
    ) {
      throw new Error('The active Wallet is not a Bitcoin-capable hardware Wallet')
    }
    return context
  }
}
