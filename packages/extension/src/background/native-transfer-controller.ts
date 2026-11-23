import type { Account, ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainSource, SigningSummary } from '@/core/keyring/domain'
import type { PreparedSigningCommand } from '@/core/keyring/ports'
import {
  parseNearIntentsTransactionBinding,
  parseTransactionId,
  type NearIntentsTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import { accountContextTransition } from './account-context-transition'

export interface ActiveNativeTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly keyDomainSource: KeyDomainSource
}

export interface BackgroundNativeTransferReview {
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

export interface NativeTransferRecoveryResult {
  readonly attempted: number
  readonly broadcast: number
  readonly pending: number
  readonly errors: number
}

interface NativeTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

interface ScopedTransfer {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
}

interface NativeTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface NativeTransferControllerOptions<Context, PrepareInput, Prepared> {
  readonly orchestrator: {
    prepare(input: PrepareInput): Promise<Prepared>
    getPendingApproval(input: ScopedTransfer): Promise<Prepared | null>
    approve(
      input: ScopedTransfer & { payloadFingerprint: string }
    ): Promise<NativeTransferSubmission>
    reject(input: ScopedTransfer): Promise<TransactionGraph>
    resumeBroadcast(input: ScopedTransfer): Promise<NativeTransferSubmission>
    resumePendingBroadcasts(): Promise<NativeTransferRecoveryResult>
    cancelAwaitingApprovalsForScope(scope: TransactionAccountScope): Promise<number>
    cancelAwaitingApprovalsExceptScope(scope: TransactionAccountScope): Promise<number>
    cancelAllAwaitingApprovals(): Promise<number>
    clearPendingTransfers(): Promise<number>
  }
  readonly loadActiveContext: () => Promise<Context | null>
}

interface NativeTransferAdapter<Context, PrepareInput, Prepared, Review> {
  readonly family: 'near' | 'solana'
  readonly maximumAmount: bigint
  parseRecipient(value: string): string
  toPrepareInput(
    context: Context,
    intent: NativeTransferIntent,
    binding: NearIntentsTransactionBinding | undefined
  ): PrepareInput
  toReview(prepared: Prepared): Review
}

export function projectNativeTransferReview(value: {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}): BackgroundNativeTransferReview {
  return Object.freeze({
    graph: value.graph,
    review: Object.freeze({
      chainId: value.signing.chainId,
      operation: 'transaction',
      summary: value.signing.summary,
      payloadFingerprint: value.signing.payloadFingerprint,
      expiresAt: value.signing.expiresAt
    })
  })
}

export class BackgroundNativeTransferController<
  Context extends ActiveNativeTransferContext,
  PrepareInput,
  Prepared,
  Review extends BackgroundNativeTransferReview
> {
  private readonly label: 'NEAR' | 'Solana'

  constructor(
    private readonly options: NativeTransferControllerOptions<Context, PrepareInput, Prepared>,
    private readonly adapter: NativeTransferAdapter<Context, PrepareInput, Prepared, Review>
  ) {
    this.label = adapter.family === 'near' ? 'NEAR' : 'Solana'
  }

  async prepare(intentValue: unknown, nearIntentsBindingValue?: unknown): Promise<Review> {
    const intent = this.parseIntent(intentValue)
    const binding =
      nearIntentsBindingValue === undefined
        ? undefined
        : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (!intent.assetId.startsWith(`${context.chainAccount.scope.chainId}/`)) {
        throw new Error(`${this.label} transfer asset does not match the active network`)
      }
      const prepared = await this.options.orchestrator.prepare(
        this.adapter.toPrepareInput(context, intent, binding)
      )
      return this.adapter.toReview(prepared)
    })
  }

  async getPendingApproval(transactionId: string): Promise<Review | null> {
    return this.runScopedTransfer(transactionId, async input => {
      const pending = await this.options.orchestrator.getPendingApproval(input)
      return pending ? this.adapter.toReview(pending) : null
    })
  }

  async approve(
    transactionId: string,
    payloadFingerprint: string
  ): Promise<NativeTransferSubmission> {
    return this.approveWithGuard(transactionId, payloadFingerprint)
  }

  async approveForDApp(
    transactionId: string,
    payloadFingerprint: string,
    authorize: (context: Context) => Promise<void>
  ): Promise<NativeTransferSubmission> {
    return this.approveWithGuard(transactionId, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionId: string,
    payloadFingerprint: string,
    authorize?: (context: Context) => Promise<void>
  ): Promise<NativeTransferSubmission> {
    return this.runScopedTransfer(
      transactionId,
      input => this.options.orchestrator.approve({ ...input, payloadFingerprint }),
      authorize
    )
  }

  async reject(transactionId: string): Promise<TransactionGraph> {
    return this.runScopedTransfer(transactionId, input => this.options.orchestrator.reject(input))
  }

  async resumeBroadcast(transactionId: string): Promise<NativeTransferSubmission> {
    return this.runScopedTransfer(transactionId, input =>
      this.options.orchestrator.resumeBroadcast(input)
    )
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

  recoverSignedTransfers(): Promise<NativeTransferRecoveryResult> {
    return accountContextTransition.runActiveOperation(() =>
      this.options.orchestrator.resumePendingBroadcasts()
    )
  }

  private async runScopedTransfer<Result>(
    transactionIdValue: string,
    operation: (input: ScopedTransfer) => Promise<Result>,
    authorize?: (context: Context) => Promise<void>
  ): Promise<Result> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (authorize) await authorize(context)
      return operation({ scope: context.chainAccount.scope, transactionId })
    })
  }

  private async requireActiveContext(): Promise<Context> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error(`The active Account has no ${this.label} ChainAccount`)
    const { keyDomainSource } = context
    const { family } = this.adapter
    if (
      (keyDomainSource.kind === 'hardware' &&
        (keyDomainSource.vendor !== 'ledger' || !keyDomainSource.capabilities.includes(family))) ||
      (keyDomainSource.kind === 'private-key' && keyDomainSource.chainFamily !== family)
    ) {
      throw new Error(`The active key domain cannot sign ${this.label} transactions`)
    }
    return context
  }

  private parseIntent(value: unknown): NativeTransferIntent {
    const errorMessage = `Invalid ${this.label} transfer intent`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(errorMessage)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(errorMessage)
    }
    const record = value as Record<string, unknown>
    const keys = ['assetId', 'recipient', 'amountRaw']
    if (
      Object.keys(record).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
      typeof record.assetId !== 'string' ||
      typeof record.recipient !== 'string' ||
      typeof record.amountRaw !== 'string' ||
      !/^[1-9][0-9]*$/.test(record.amountRaw) ||
      BigInt(record.amountRaw) > this.adapter.maximumAmount
    ) {
      throw new Error(errorMessage)
    }
    return Object.freeze({
      assetId: record.assetId,
      recipient: this.adapter.parseRecipient(record.recipient),
      amountRaw: record.amountRaw
    })
  }
}
