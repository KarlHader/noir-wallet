import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainSource, SigningSummary } from '@/core/keyring/domain'
import {
  parseNearIntentsTransactionBinding,
  parseTransactionId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import {
  parseSolanaPublicKey,
  type PreparedSolanaTransferApproval,
  type SolanaTransferOrchestrator,
  type SolanaTransferSubmission
} from '@/infrastructure/chains/solana'
import type { ChainAccount, Account } from '@/core/accounts/domain'
import { accountContextTransition } from './account-context-transition'

export interface ActiveSolanaTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly keyDomainSource: KeyDomainSource
}

export interface BackgroundSolanaTransferControllerOptions {
  readonly orchestrator: Pick<
    SolanaTransferOrchestrator,
    | 'prepare'
    | 'approve'
    | 'getPendingApproval'
    | 'reject'
    | 'resumeBroadcast'
    | 'resumePendingBroadcasts'
    | 'cancelAwaitingApprovalsForScope'
    | 'cancelAwaitingApprovalsExceptScope'
    | 'cancelAllAwaitingApprovals'
    | 'clearPendingTransfers'
  >
  readonly loadActiveContext: () => Promise<ActiveSolanaTransferContext | null>
}

export interface BackgroundSolanaTransferReview {
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

interface SolanaTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

const MAXIMUM_U64 = 18_446_744_073_709_551_615n

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Solana transfer intent')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Invalid Solana transfer intent')
  }
  return value as Record<string, unknown>
}

function parseIntent(value: unknown): SolanaTransferIntent {
  const record = readRecord(value)
  const keys = ['assetId', 'recipient', 'amountRaw']
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    typeof record.assetId !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.amountRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(record.amountRaw) ||
    BigInt(record.amountRaw) > MAXIMUM_U64
  ) {
    throw new Error('Invalid Solana transfer intent')
  }
  return Object.freeze({
    assetId: record.assetId,
    recipient: parseSolanaPublicKey(record.recipient),
    amountRaw: record.amountRaw
  })
}

function toBackgroundReview(value: PreparedSolanaTransferApproval): BackgroundSolanaTransferReview {
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

export class BackgroundSolanaTransferController {
  constructor(private readonly options: BackgroundSolanaTransferControllerOptions) {}

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown
  ): Promise<BackgroundSolanaTransferReview> {
    const intent = parseIntent(intentValue)
    const nearIntentsBinding =
      nearIntentsBindingValue === undefined
        ? undefined
        : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (!intent.assetId.startsWith(`${context.chainAccount.scope.chainId}/`)) {
        throw new Error('Solana transfer asset does not match the active network')
      }
      const base = {
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex,
        recipient: intent.recipient,
        ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding })
      }
      return toBackgroundReview(
        await this.options.orchestrator.prepare(
          intent.assetId === `${context.chainAccount.scope.chainId}/slip44:501`
            ? { ...base, lamports: intent.amountRaw }
            : { ...base, assetId: intent.assetId, amountRaw: intent.amountRaw }
        )
      )
    })
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundSolanaTransferReview | null> {
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
  ): Promise<SolanaTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveSolanaTransferContext) => Promise<void>
  ): Promise<SolanaTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActiveSolanaTransferContext) => Promise<void>
  ): Promise<SolanaTransferSubmission> {
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

  async resumeBroadcast(transactionIdValue: string): Promise<SolanaTransferSubmission> {
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

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.options.orchestrator.cancelAllAwaitingApprovals()
  }

  clearPendingTransfers(): Promise<number> {
    return this.options.orchestrator.clearPendingTransfers()
  }

  recoverSignedTransfers() {
    return accountContextTransition.runActiveOperation(() =>
      this.options.orchestrator.resumePendingBroadcasts()
    )
  }

  private async requireActiveContext(): Promise<ActiveSolanaTransferContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('The active Account has no Solana ChainAccount')
    if (
      (context.keyDomainSource.kind === 'hardware' &&
        (context.keyDomainSource.vendor !== 'ledger' ||
          !context.keyDomainSource.capabilities.includes('solana'))) ||
      (context.keyDomainSource.kind === 'private-key' &&
        context.keyDomainSource.chainFamily !== 'solana')
    ) {
      throw new Error('The active key domain cannot sign Solana transactions')
    }
    return context
  }
}
