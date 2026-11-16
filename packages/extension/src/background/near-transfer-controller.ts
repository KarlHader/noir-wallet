import type { Account, ChainAccount } from '@/core/accounts/domain'
import { parseNearAccountId } from '@/core/chains/near'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainSource, SigningSummary } from '@/core/keyring/domain'
import {
  parseNearIntentsTransactionBinding,
  parseTransactionId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import {
  type NearTransferOrchestrator,
  type NearTransferSubmission,
  type PreparedNearTransferApproval
} from '@/infrastructure/chains/near'

import { accountContextTransition } from './account-context-transition'

export interface ActiveNearTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly keyDomainSource: KeyDomainSource
  readonly publicKey: string
}

export interface BackgroundNearTransferControllerOptions {
  readonly orchestrator: Pick<
    NearTransferOrchestrator,
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
  readonly loadActiveContext: () => Promise<ActiveNearTransferContext | null>
}

export interface BackgroundNearTransferReview {
  readonly graph: TransactionGraph
  readonly debit: {
    readonly maximumFeeRaw: string
    readonly storageReserveRaw: string
  }
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

interface NearTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

function parseIntent(value: unknown): NearTransferIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid NEAR transfer intent')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Invalid NEAR transfer intent')
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
    BigInt(record.amountRaw) > MAXIMUM_U128
  ) {
    throw new Error('Invalid NEAR transfer intent')
  }
  return Object.freeze({
    assetId: record.assetId,
    recipient: parseNearAccountId(record.recipient),
    amountRaw: record.amountRaw
  })
}

function toBackgroundReview(value: PreparedNearTransferApproval): BackgroundNearTransferReview {
  return Object.freeze({
    graph: value.graph,
    debit: value.debit,
    review: Object.freeze({
      chainId: value.signing.chainId,
      operation: 'transaction' as const,
      summary: value.signing.summary,
      payloadFingerprint: value.signing.payloadFingerprint,
      expiresAt: value.signing.expiresAt
    })
  })
}

export class BackgroundNearTransferController {
  constructor(private readonly options: BackgroundNearTransferControllerOptions) {}

  async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown
  ): Promise<BackgroundNearTransferReview> {
    const intent = parseIntent(intentValue)
    const nearIntentsBinding =
      nearIntentsBindingValue === undefined
        ? undefined
        : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireActiveContext()
      if (!intent.assetId.startsWith(`${context.chainAccount.scope.chainId}/`)) {
        throw new Error('NEAR transfer asset does not match the active network')
      }
      const base = {
        chainAccount: context.chainAccount,
        accountIndex: context.accountIndex,
        publicKey: context.publicKey,
        receiverId: intent.recipient,
        ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding })
      }
      return toBackgroundReview(
        await this.options.orchestrator.prepare(
          intent.assetId === `${context.chainAccount.scope.chainId}/slip44:397`
            ? { ...base, depositYocto: intent.amountRaw }
            : { ...base, assetId: intent.assetId, amountRaw: intent.amountRaw }
        )
      )
    })
  }

  async getPendingApproval(
    transactionIdValue: string
  ): Promise<BackgroundNearTransferReview | null> {
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
  ): Promise<NearTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint)
  }

  async approveForDApp(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize: (context: ActiveNearTransferContext) => Promise<void>
  ): Promise<NearTransferSubmission> {
    return this.approveWithGuard(transactionIdValue, payloadFingerprint, authorize)
  }

  private async approveWithGuard(
    transactionIdValue: string,
    payloadFingerprint: string,
    authorize?: (context: ActiveNearTransferContext) => Promise<void>
  ): Promise<NearTransferSubmission> {
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

  async resumeBroadcast(transactionIdValue: string): Promise<NearTransferSubmission> {
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

  private async requireActiveContext(): Promise<ActiveNearTransferContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('The active Account has no NEAR ChainAccount')
    if (
      (context.keyDomainSource.kind === 'hardware' &&
        (context.keyDomainSource.vendor !== 'ledger' ||
          !context.keyDomainSource.capabilities.includes('near'))) ||
      (context.keyDomainSource.kind === 'private-key' &&
        context.keyDomainSource.chainFamily !== 'near')
    ) {
      throw new Error('The active key domain cannot sign NEAR transactions')
    }
    return context
  }
}
