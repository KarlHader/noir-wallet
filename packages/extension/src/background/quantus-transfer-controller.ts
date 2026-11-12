import type { ChainId } from '@/core/chains/domain'
import { parseQuantusAddress } from '@/core/chains/quantus'
import type { KeyDomainSource, SigningSummary } from '@/core/keyring/domain'
import {
  parseTransactionId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import type { Account, ChainAccount } from '@/core/accounts/domain'
import type {
  QuantusSignedOnlyDelivery,
  QuantusTransferOrchestrator,
  QuantusTransferSubmission
} from '@/infrastructure/chains/quantus'
import { accountContextTransition } from './account-context-transition'

export interface ActiveQuantusTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly keyDomainSource: KeyDomainSource
}

export interface BackgroundQuantusTransferControllerOptions {
  readonly orchestrator: Pick<
    QuantusTransferOrchestrator,
    | 'prepare'
    | 'approve'
    | 'signOnly'
    | 'findSignedOnlyForIntent'
    | 'getPendingApproval'
    | 'reject'
    | 'resumeBroadcast'
    | 'resumePendingBroadcasts'
    | 'cancelAwaitingApprovalsForScope'
    | 'cancelAwaitingApprovalsExceptScope'
    | 'cancelAllAwaitingApprovals'
    | 'clearPendingTransfers'
    | 'getTransferGraph'
  >
  readonly loadActiveContext: () => Promise<ActiveQuantusTransferContext | null>
}

export interface BackgroundQuantusTransferReview {
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

interface QuantusTransferIntent {
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive: boolean
}

const MAXIMUM_U128 = (1n << 128n) - 1n

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Quantus transfer intent')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Invalid Quantus transfer intent')
  }
  return value as Record<string, unknown>
}

function parseIntent(value: unknown): QuantusTransferIntent {
  const record = readRecord(value)
  const required = ['recipient', 'amountRaw']
  const allowed = ['recipient', 'amountRaw', 'keepAlive']
  if (
    !required.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !allowed.includes(key)) ||
    typeof record.recipient !== 'string' ||
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
    // Keep-alive stays the safe default; draining an account must be explicit.
    keepAlive: record.keepAlive === undefined ? true : record.keepAlive
  })
}

function toBackgroundReview(value: {
  readonly graph: TransactionGraph
  readonly signing: {
    readonly chainId: ChainId
    readonly summary: SigningSummary
    readonly payloadFingerprint: { readonly algorithm: 'sha256'; readonly digestHex: string }
    readonly expiresAt: number
  }
}): BackgroundQuantusTransferReview {
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

export class BackgroundQuantusTransferController {
  constructor(private readonly options: BackgroundQuantusTransferControllerOptions) {}

  async prepare(intentValue: unknown): Promise<BackgroundQuantusTransferReview> {
    const intent = parseIntent(intentValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      return toBackgroundReview(
        await this.options.orchestrator.prepare({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          recipient: intent.recipient,
          amountRaw: intent.amountRaw,
          keepAlive: intent.keepAlive
        })
      )
    })
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundQuantusTransferReview | null> {
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

  async approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<QuantusTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  /**
   * Confirms a dApp-reviewed transfer. The guard runs inside the same
   * active-operation boundary as the confirmation, so a permission, account or
   * network change cannot land between the dApp authorization check and signing.
   */
  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveQuantusTransferContext) => Promise<void>
  ): Promise<QuantusTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  /**
   * Signs a dApp-reviewed native transfer without submitting it. The guard runs
   * at the confirmation boundary, exactly like `approveForDApp`.
   */
  async findSignedOnlyForDApp(intentValue: unknown, origin: string): Promise<string | null> {
    const intent = parseIntent(intentValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (context.chainAccount.identity.kind !== 'account-identifier') return null
      return this.options.orchestrator.findSignedOnlyForIntent({
        scope: context.chainAccount.scope,
        chainId: context.chainAccount.scope.chainId,
        signerAddress: context.chainAccount.identity.value,
        recipient: intent.recipient,
        amountRaw: intent.amountRaw,
        origin
      })
    })
  }

  async signForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveQuantusTransferContext) => Promise<void>,
    origin: string,
    idempotencyKey: string
  ): Promise<QuantusSignedOnlyDelivery> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      await authorize(context)
      return this.options.orchestrator.signOnly({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint,
        origin,
        idempotencyKey
      })
    })
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActiveQuantusTransferContext) => Promise<void>
  ): Promise<QuantusTransferSubmission> {
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

  async resumeBroadcast(transactionIdValue: string): Promise<QuantusTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      return this.options.orchestrator.resumeBroadcast({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  async getTransferStatus(
    transactionIdValue: string
  ): Promise<Readonly<{ graph: TransactionGraph }> | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      const graph = await this.options.orchestrator.getTransferGraph({
        scope: context.chainAccount.scope,
        transactionId
      })
      return graph ? Object.freeze({ graph }) : null
    })
  }

  cancelAwaitingApprovalsForScope(scope: TransactionAccountScope): Promise<number> {
    return this.options.orchestrator.cancelAwaitingApprovalsForScope(scope)
  }

  cancelAwaitingApprovalsExceptScope(scope: TransactionAccountScope): Promise<number> {
    return this.options.orchestrator.cancelAwaitingApprovalsExceptScope(scope)
  }

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.options.orchestrator.cancelAllAwaitingApprovals()
  }

  clearPendingTransfers(): Promise<number> {
    return this.options.orchestrator.clearPendingTransfers()
  }

  recoverSignedTransfers() {
    return this.options.orchestrator.resumePendingBroadcasts()
  }

  private async requireActiveContext(): Promise<ActiveQuantusTransferContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('The active Account has no Quantus ChainAccount')
    // Quantus signing is software-only: ML-DSA hardware and imported-key
    // families are not part of this milestone.
    if (context.keyDomainSource.kind !== 'software') {
      throw new Error('The active key domain cannot sign Quantus transactions')
    }
    return context
  }
}
