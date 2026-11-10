import type { SigningSummary } from '@/core/keyring/domain'
import {
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import type { ActiveDashDiscoveryContext } from '@/infrastructure/chains/dash/dash-discovery-coordinator'
import {
  parseDashRecipient,
  parseDashTransferAmount
} from '@/infrastructure/chains/dash/dash-transaction-model'
import type {
  DashTransferOrchestrator,
  DashTransferSubmission,
  PreparedDashTransferApproval
} from '@/infrastructure/chains/dash/dash-transfer-orchestrator'
import type { DashTransferPreparationCoordinator } from '@/infrastructure/chains/dash/dash-transfer-preparation-coordinator'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { accountContextTransition } from './account-context-transition'

export interface DashExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export function isDashExternalSignatureRequired(
  value: unknown
): value is DashExternalSignatureRequired {
  if (typeof value !== 'object' || value === null) return false
  const status = Reflect.get(value, 'status')
  return status === 'external-signature-required'
}

export interface BackgroundDashTransferReview {
  readonly graph: TransactionGraph
  readonly review: {
    readonly chainId: string
    readonly operation: 'transaction'
    readonly summary: SigningSummary
    readonly payloadFingerprint: { readonly algorithm: 'sha256'; readonly digestHex: string }
    readonly expiresAt: number
  }
}

function toReview(value: PreparedDashTransferApproval): BackgroundDashTransferReview {
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

function parseIntent(value: unknown, chainId: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Dash transfer')
  }
  const record = value as Record<string, unknown>
  return Object.freeze({
    recipient: parseDashRecipient(record.recipient, chainId),
    amount: parseDashTransferAmount(record.amount)
  })
}

export class BackgroundDashTransferController {
  private readonly createId: () => string

  constructor(
    private readonly options: {
      readonly preparation: Pick<DashTransferPreparationCoordinator, 'prepare'>
      readonly orchestrator: Pick<
        DashTransferOrchestrator,
        | 'prepare'
        | 'approve'
        | 'reject'
        | 'resumeBroadcast'
        | 'getPendingApproval'
        | 'getLedgerPsbt'
        | 'submitLedgerSignature'
        | 'cancelAllAwaitingApprovals'
      >
      readonly loadActiveContext: () => Promise<ActiveDashDiscoveryContext | null>
      readonly scanActive: () => Promise<unknown>
      readonly readAuthorization: (
        context: ActiveDashDiscoveryContext
      ) => Promise<{ readonly credentialGenerationId: string }>
      readonly requiredConfirmations: number
      readonly createId?: () => string
    }
  ) {
    if (options.requiredConfirmations !== 6)
      throw new Error('Dash finality requires 6 confirmations')
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  prepare(intentValue: unknown): Promise<BackgroundDashTransferReview> {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireOwnedContext()
      return this.prepareForContext(intentValue, context)
    })
  }

  prepareLedger(intentValue: unknown): Promise<BackgroundDashTransferReview> {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireLedgerContext()
      return this.prepareForContext(intentValue, context)
    })
  }

  private async prepareForContext(
    intentValue: unknown,
    context: ActiveDashDiscoveryContext
  ): Promise<BackgroundDashTransferReview> {
    const ledger = context.keyDomainSource.kind === 'hardware'
    const intent = parseIntent(intentValue, context.chainAccount.scope.chainId)
    const discovery = await this.options.scanActive()
    if (!discovery) throw new Error('Dash discovery did not complete for the active account')
    const authorization = await this.options.readAuthorization(context)
    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:dash:${id}`)
    const segmentId = parseTransactionSegmentId(`segment:dash:${id}`)
    const plan = await this.options.preparation.prepare({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      network: context.scope.network,
      imported: context.scope.imported,
      transactionId,
      recipient: intent.recipient,
      amount: intent.amount
    })
    return toReview(
      await this.options.orchestrator.prepare({
        chainAccount: context.chainAccount,
        transactionId,
        segmentId,
        prepared: plan.prepared,
        signerAddress: plan.signerAddress,
        changeReservation: plan.changeReservation,
        inputReservation: plan.inputReservation,
        authorization: {
          chainAccountId: context.chainAccount.id,
          credentialGenerationId: authorization.credentialGenerationId,
          chainId: context.chainAccount.scope.chainId,
          accountIndex: context.accountIndex
        },
        ...(ledger ? { signingMode: 'ledger' as const } : {})
      })
    )
  }

  approve(
    transactionIdValue: string,
    payloadFingerprint: string
  ): Promise<DashTransferSubmission | DashExternalSignatureRequired> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireOwnedContext()
      if (context.keyDomainSource.kind === 'hardware') {
        return this.ledgerApprovalHandoff(context, transactionId, payloadFingerprint)
      }
      if (context.keyDomainSource.kind !== 'software') {
        throw new Error('Dash transfers require a software account')
      }
      const authorization = await this.options.readAuthorization(context)
      return this.options.orchestrator.approve({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint,
        authorization: {
          chainAccountId: context.chainAccount.id,
          credentialGenerationId: authorization.credentialGenerationId,
          chainId: context.chainAccount.scope.chainId,
          accountIndex: context.accountIndex
        }
      })
    })
  }

  private async ledgerApprovalHandoff(
    context: ActiveDashDiscoveryContext,
    transactionId: TransactionId,
    payloadFingerprint: string
  ): Promise<DashExternalSignatureRequired> {
    const scope = context.chainAccount.scope
    const pending = await this.options.orchestrator.getPendingApproval({ scope, transactionId })
    if (!pending || pending.graph.root.id !== transactionId) {
      throw new Error('Pending Dash transfer was not found')
    }
    if (pending.signing.payloadFingerprint.digestHex !== payloadFingerprint) {
      throw new Error('Dash approval payload fingerprint does not match')
    }
    if (Date.now() >= pending.signing.expiresAt) throw new Error('Dash signing request expired')
    await this.options.orchestrator.getLedgerPsbt({ scope, transactionId })
    return Object.freeze({
      status: 'external-signature-required' as const,
      graph: pending.graph,
      transactionId,
      payloadFingerprint,
      expiresAt: pending.signing.expiresAt
    })
  }

  getLedgerPsbt(transactionIdValue: string): Promise<string> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireLedgerContext()
      return this.options.orchestrator.getLedgerPsbt({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  submitLedgerSignature(
    transactionIdValue: string,
    payloadFingerprint: string,
    signedTransactionHex: string
  ): Promise<DashTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireLedgerContext()
      const authorization = await this.options.readAuthorization(context)
      return this.options.orchestrator.submitLedgerSignature({
        scope: context.chainAccount.scope,
        transactionId,
        payloadFingerprint,
        signedTransactionHex,
        authorization: {
          chainAccountId: context.chainAccount.id,
          credentialGenerationId: authorization.credentialGenerationId,
          chainId: context.chainAccount.scope.chainId,
          accountIndex: context.accountIndex
        }
      })
    })
  }

  getPendingApproval(transactionIdValue: string): Promise<BackgroundDashTransferReview | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireOwnedContext()
      const pending = await this.options.orchestrator.getPendingApproval({
        scope: context.chainAccount.scope,
        transactionId
      })
      return pending ? toReview(pending) : null
    })
  }

  reject(transactionIdValue: string): Promise<TransactionGraph> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireOwnedContext()
      return this.options.orchestrator.reject({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  resumeBroadcast(transactionIdValue: string): Promise<DashTransferSubmission> {
    const transactionId = parseTransactionId(transactionIdValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireSoftwareContext()
      return this.options.orchestrator.resumeBroadcast({
        scope: context.chainAccount.scope,
        transactionId
      })
    })
  }

  cancelAllAwaitingApprovals(): Promise<number> {
    return this.options.orchestrator.cancelAllAwaitingApprovals()
  }

  private async requireSoftwareContext(): Promise<ActiveDashDiscoveryContext> {
    return this.requireTransferContext(false)
  }

  private async requireLedgerContext(): Promise<ActiveDashDiscoveryContext> {
    return this.requireTransferContext(true)
  }

  private async requireOwnedContext(): Promise<ActiveDashDiscoveryContext> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Error('Dash account is not available')
    if (context.keyDomainSource.kind === 'software') return context
    if (
      context.keyDomainSource.kind === 'hardware' &&
      context.keyDomainSource.vendor === 'ledger' &&
      context.chainAccount.scope.chainId === DASH_CHAIN_IDS.mainnet
    ) {
      return context
    }
    throw new Error('Dash transfers require a software account')
  }

  private async requireTransferContext(ledger: boolean): Promise<ActiveDashDiscoveryContext> {
    const context = await this.requireOwnedContext()
    if (ledger === (context.keyDomainSource.kind === 'hardware')) return context
    throw new Error('Dash transfers require a software account')
  }
}
