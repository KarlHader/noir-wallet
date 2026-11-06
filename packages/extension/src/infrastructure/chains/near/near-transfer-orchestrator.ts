import { KeyringError } from '@/core/keyring/ports'
import { parseAccountId, type ChainAccount } from '@/core/accounts/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningExecution,
  SigningResult
} from '@/core/keyring/ports'
import type { LedgerSigningResume } from '@/infrastructure/keyring/multichain/ledger-signing-bridge'
import type { NearSigningPreparePayload } from '@/infrastructure/keyring/multichain/signing-adapter-near'
import {
  type NearIntentsTransactionBinding,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import type { NearTransactionSigningPreparePayload } from '@/infrastructure/keyring/multichain/near-signing-client'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'

import {
  type AwaitingApprovalNearTransfer,
  type NearPendingTransferStore,
  type PendingNearTransfer,
  type SignedPendingNearTransfer
} from './near-pending-transfer-store'
import type { NearBroadcastRpc, NearReadRpc } from './near-rpc-types'
import {
  assertNearTransferSigningMatchesPrepared,
  computeNearTransactionFingerprint,
  prepareNearNativeTransfer,
  prepareNearTokenTransfer
} from './near-transfer-preparer'
import { createNearTransferGraph } from './near-transaction-graph'

export interface NearTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: NearTransactionSigningPreparePayload,
    signal?: AbortSignal
  ) => Promise<PreparedSigningCommand>
  readonly confirm: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal,
    origin?: string,
    execution?: SigningExecution,
    resume?: LedgerSigningResume<NearSigningPreparePayload>
  ) => Promise<SigningResult>
  readonly cancel: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal
  ) => Promise<void>
}

export interface NearTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: NearPendingTransferStore
  readonly signer: NearTransferSigningPort
  readonly rpc: NearReadRpc & NearBroadcastRpc
  readonly assets: AssetRegistry
  readonly now?: () => number
  readonly createId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void
}

interface PrepareNearTransferBaseInput {
  readonly chainAccount: ChainAccount
  readonly accountIndex: number
  readonly publicKey: string
  readonly receiverId: string
  readonly signal?: AbortSignal
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
}

export type PrepareNearTransferInput = PrepareNearTransferBaseInput &
  (
    | Readonly<{ readonly assetId: string; readonly amountRaw: string }>
    | Readonly<{ readonly depositYocto: string }>
  )

export interface PreparedNearTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
  readonly debit: {
    readonly maximumFeeRaw: string
    readonly storageReserveRaw: string
  }
}

export interface ContinueNearTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveNearTransferInput extends ContinueNearTransferInput {
  readonly payloadFingerprint: string
}

export interface NearTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface NearPendingBroadcastRecoveryResult {
  readonly attempted: number
  readonly broadcast: number
  readonly pending: number
  readonly errors: number
}

function normalizeScope(value: TransactionAccountScope): TransactionAccountScope {
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function scopesMatch(left: TransactionAccountScope, right: TransactionAccountScope): boolean {
  return left.keyDomainId === right.keyDomainId && left.accountId === right.accountId
}

function isUnrecoverableSigningError(error: unknown): boolean {
  return (
    error instanceof KeyringError &&
    (error.code === 'SIGNING_COMMAND_EXPIRED' ||
      error.code === 'SIGNING_COMMAND_NOT_FOUND' ||
      error.code === 'SIGNING_COMMAND_CANCELLED')
  )
}

function pendingSigning(pending: AwaitingApprovalNearTransfer): PreparedSigningCommand {
  return Object.freeze({
    commandId: pending.signingCommandId,
    chainId: parseChainId(pending.prepared.chainId).id,
    operation: 'transaction' as const,
    summary: pending.signingSummary,
    payloadFingerprint: Object.freeze({
      algorithm: 'sha256' as const,
      digestHex: pending.payloadFingerprint
    }),
    execution: pending.signingExecution ?? Object.freeze({ kind: 'internal' as const }),
    expiresAt: pending.expiresAt
  })
}

export class NearTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: NearPendingTransferStore
  private readonly signer: NearTransferSigningPort
  private readonly rpc: NearReadRpc & NearBroadcastRpc
  private readonly assets: AssetRegistry
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void

  constructor(options: NearTransferOrchestratorOptions) {
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.signer = options.signer
    this.rpc = options.rpc
    this.assets = options.assets
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.onPendingBroadcast = options.onPendingBroadcast
    this.onMonitoringRequired = options.onMonitoringRequired
  }

  async prepare(input: PrepareNearTransferInput): Promise<PreparedNearTransferApproval> {
    if (input.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('NEAR transfer requires an account-identifier binding')
    }
    const assetId =
      'assetId' in input ? input.assetId : `${input.chainAccount.scope.chainId}/slip44:397`
    const amountRaw = 'amountRaw' in input ? input.amountRaw : input.depositYocto
    const asset = this.assets.resolve(assetId)
    if (asset.asset.chainId !== input.chainAccount.scope.chainId) {
      throw new Error('NEAR transfer asset does not match its ChainAccount')
    }
    const prepared =
      asset.asset.kind === 'native'
        ? await prepareNearNativeTransfer({
            chainId: input.chainAccount.scope.chainId,
            accountIndex: input.accountIndex,
            signerId: input.chainAccount.identity.value,
            publicKey: input.publicKey,
            receiverId: input.receiverId,
            depositYocto: amountRaw,
            rpc: this.rpc,
            signal: input.signal
          })
        : await prepareNearTokenTransfer({
            chainId: input.chainAccount.scope.chainId,
            accountIndex: input.accountIndex,
            assetId: asset.asset.id,
            signerId: input.chainAccount.identity.value,
            publicKey: input.publicKey,
            recipientId: input.receiverId,
            contractId: asset.asset.reference.replace(/%5F/gi, '_'),
            amountRaw,
            rpc: this.rpc,
            signal: input.signal
          })
    const signingTransaction = Object.freeze({
      chainId: prepared.transaction.chainId,
      accountIndex: prepared.transaction.accountIndex,
      signerId: prepared.transaction.signerId,
      receiverId: prepared.transaction.receiverId,
      nonce: prepared.transaction.nonce,
      blockHash: prepared.transaction.blockHash,
      actions: prepared.transaction.actions
    })
    const signing = await this.signer.prepare(
      input.chainAccount.scope.keyDomainId,
      Object.freeze({
        kind: 'near-transaction' as const,
        chainId: input.chainAccount.scope.chainId,
        accountIndex: prepared.accountIndex,
        transaction: signingTransaction
      }),
      input.signal
    )
    try {
      await assertNearTransferSigningMatchesPrepared(prepared, signing)
      if (signing.expiresAt <= this.timestamp()) {
        throw new Error('NEAR signing request expired during preparation')
      }
    } catch {
      await this.cancelSigning(
        input.chainAccount.scope.keyDomainId,
        signing.commandId,
        input.signal
      ).catch(() => {})
      throw new Error('NEAR signing request cannot be approved')
    }
    if (signing.summary.schema !== 'near.transaction.v1') {
      throw new Error('NEAR signing request cannot be approved')
    }

    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:near:${id}`)
    const segmentId = parseTransactionSegmentId(`segment:near:${id}`)
    const nearIntents = input.nearIntentsBinding
      ? Object.freeze({
          binding: input.nearIntentsBinding,
          segmentIds: Object.freeze({
            relay: parseTransactionSegmentId(`${segmentId}:relay`),
            destination: parseTransactionSegmentId(`${segmentId}:destination`),
            refund: parseTransactionSegmentId(`${segmentId}:refund`)
          })
        })
      : undefined
    const scope = normalizeScope(input.chainAccount.scope)
    const createdAt = this.timestamp()
    const graph = createNearTransferGraph({
      prepared,
      scope,
      transactionId,
      segmentId,
      assets: this.assets,
      createdAt,
      chainAccountId: input.chainAccount.id,
      ...(nearIntents === undefined ? {} : { nearIntents })
    })
    const pending: AwaitingApprovalNearTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'awaiting-approval',
      transactionId,
      segmentId,
      scope,
      prepared,
      signingSummary: signing.summary,
      signingCommandId: signing.commandId,
      signingExecution: signing.execution,
      payloadFingerprint: signing.payloadFingerprint.digestHex,
      expiresAt: signing.expiresAt
    })
    try {
      await this.pendingStore.put(pending, graph)
      return Object.freeze({
        graph,
        signing,
        debit: Object.freeze({
          maximumFeeRaw: prepared.maximumFeeYocto,
          storageReserveRaw: prepared.storageReserveYocto
        })
      })
    } catch (error) {
      await Promise.all([
        this.pendingStore.delete(transactionId).catch(() => {}),
        this.cancelSigning(scope.keyDomainId, signing.commandId, input.signal).catch(() => {})
      ])
      throw error
    }
  }

  async getPendingApproval(
    input: ContinueNearTransferInput
  ): Promise<PreparedNearTransferApproval | null> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || pending.phase !== 'awaiting-approval' || !scopesMatch(pending.scope, scope)) {
      return null
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      return null
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, graph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending NEAR transfer integrity check failed')
    }
    return Object.freeze({
      graph,
      signing: pendingSigning(pending),
      debit: Object.freeze({
        maximumFeeRaw: pending.prepared.maximumFeeYocto,
        storageReserveRaw: pending.prepared.storageReserveYocto
      })
    })
  }

  async approve(input: ApproveNearTransferInput): Promise<NearTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending NEAR transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('NEAR transfer is already signed; resume its broadcast instead')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('NEAR approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('NEAR signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending NEAR transfer integrity check failed')
    }

    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')
    try {
      await this.pendingStore.put(pending, graph)
    } catch {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Approved NEAR signing request could not be persisted')
    }
    let signed: SigningResult
    try {
      signed = await this.signer.confirm(
        pending.scope.keyDomainId,
        pending.signingCommandId,
        input.signal,
        undefined,
        pending.signingExecution,
        pending.signingExecution?.kind === 'external'
          ? {
              accountId: pending.scope.accountId,
              payload: {
                kind: 'near-transaction',
                chainId: parseChainId(pending.prepared.chainId).id,
                accountIndex: pending.prepared.transaction.accountIndex,
                transaction: { ...pending.prepared.transaction }
              },
              prepared: pendingSigning(pending)
            }
          : undefined
      )
    } catch (error) {
      if (isUnrecoverableSigningError(error)) {
        await this.failAwaitingApproval(pending, input.signal)
      }
      throw error
    }
    if (
      signed.kind !== 'signed-payload' ||
      signed.payload.encoding !== 'base64' ||
      signed.transactionId === undefined
    ) {
      await this.failConsumedSigning(pending)
      throw new Error('Signed NEAR transaction failed integrity validation')
    }
    const signedPending: SignedPendingNearTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      transactionBase64: signed.payload.value,
      transactionHash: signed.transactionId,
      signerId: pending.prepared.signerId,
      signedAt: this.timestamp()
    })
    try {
      graph = this.transitionReviewGraph(pending, graph, 'signed', {
        transactionHash: signedPending.transactionHash,
        externalReference: `near-blockhash:${pending.prepared.transaction.blockHash}`
      })
      await this.pendingStore.put(signedPending, graph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed NEAR transaction could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async reject(input: ContinueNearTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending NEAR approval was not found')
    }
    const reviewGraph = await this.requireReviewGraph(pending)
    const graph = this.transitionReviewGraph(pending, reviewGraph, 'failed', undefined, {
      code: 'user-rejected',
      occurredAt: this.timestamp()
    })
    await Promise.all([
      this.pendingStore.delete(transactionId),
      this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, input.signal).catch(
        () => {}
      )
    ])
    return graph
  }

  async resumeBroadcast(input: ContinueNearTransferInput): Promise<NearTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
      throw new Error('Signed NEAR transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  async resumePendingBroadcasts(): Promise<NearPendingBroadcastRecoveryResult> {
    const signed = (await this.pendingStore.list()).filter(
      (candidate): candidate is SignedPendingNearTransfer => candidate.phase === 'signed'
    )
    let broadcast = 0
    let pending = 0
    let errors = 0
    for (const candidate of signed) {
      try {
        const result = await this.broadcast(candidate)
        if (result.status === 'broadcast') broadcast += 1
        else pending += 1
      } catch {
        errors += 1
      }
    }
    return Object.freeze({ attempted: signed.length, broadcast, pending, errors })
  }

  async cancelAwaitingApprovalsForScope(
    scopeValue: TransactionAccountScope,
    signal?: AbortSignal
  ): Promise<number> {
    const scope = normalizeScope(scopeValue)
    return this.cancelAwaitingApprovals(candidate => scopesMatch(candidate.scope, scope), signal)
  }

  async cancelAwaitingApprovalsExceptScope(
    scopeValue: TransactionAccountScope,
    signal?: AbortSignal
  ): Promise<number> {
    const scope = normalizeScope(scopeValue)
    return this.cancelAwaitingApprovals(candidate => !scopesMatch(candidate.scope, scope), signal)
  }

  cancelAllAwaitingApprovals(signal?: AbortSignal): Promise<number> {
    return this.cancelAwaitingApprovals(() => true, signal)
  }

  clearPendingTransfers(): Promise<number> {
    return this.pendingStore.clear()
  }

  private async broadcast(
    pending: SignedPendingNearTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<NearTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    let accepted = false
    try {
      accepted =
        (await this.rpc.broadcastSignedTransaction(pending.transactionBase64, signal)) ===
        pending.transactionHash
    } catch {
      accepted = false
    }
    if (!accepted) {
      await Promise.resolve(this.onPendingBroadcast?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    const graph = await this.applyStatus(pending, 'broadcast', {
      transactionHash: pending.transactionHash
    })
    await this.pendingStore.delete(pending.transactionId)
    await Promise.resolve(this.onMonitoringRequired?.(graph, currentGraph === undefined)).catch(
      () => {}
    )
    return Object.freeze({ status: 'broadcast', graph })
  }

  private async cancelAwaitingApprovals(
    matches: (pending: AwaitingApprovalNearTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (candidate): candidate is AwaitingApprovalNearTransfer =>
        candidate.phase === 'awaiting-approval' && matches(candidate)
    )
    for (const candidate of pending) {
      await this.cancelSigning(candidate.scope.keyDomainId, candidate.signingCommandId, signal)
      await this.pendingStore.delete(candidate.transactionId)
    }
    return pending.length
  }

  private async failAwaitingApproval(
    pending: AwaitingApprovalNearTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.all([
      this.pendingStore.delete(pending.transactionId),
      this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, signal).catch(
        () => {}
      )
    ])
  }

  private async failConsumedSigning(pending: AwaitingApprovalNearTransfer): Promise<void> {
    await this.pendingStore.delete(pending.transactionId)
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingNearTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          candidate.target.chainId.startsWith('near:')
      )
      if (graph?.root.kind === 'transfer' && segment) {
        const occurredAt = this.timestamp()
        await this.applyStatus(
          { scope, transactionId, segmentId: segment.id },
          'failed',
          undefined,
          { code: 'integrity-failure', occurredAt },
          occurredAt
        ).catch(() => {})
      }
      throw new Error('Pending NEAR transfer integrity check failed')
    }
  }

  private async pendingIntegrityMatchesGraph(
    pending: AwaitingApprovalNearTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const intent = graph.root.intent
    try {
      await assertNearTransferSigningMatchesPrepared(pending.prepared, {
        commandId: pending.signingCommandId,
        chainId: parseChainId(pending.prepared.chainId).id,
        operation: 'transaction',
        summary: pending.signingSummary,
        payloadFingerprint: { algorithm: 'sha256', digestHex: pending.payloadFingerprint },
        execution: pending.signingExecution ?? { kind: 'internal' },
        expiresAt: pending.expiresAt
      })
      const tokenTransfer = 'kind' in pending.prepared
      const primaryAssetId = tokenTransfer
        ? pending.prepared.assetId
        : `${pending.prepared.chainId}/slip44:397`
      const primaryAmountRaw = tokenTransfer
        ? pending.prepared.amountRaw
        : pending.prepared.depositYocto
      const recipientId = tokenTransfer ? pending.prepared.recipientId : pending.prepared.receiverId
      return (
        pending.payloadFingerprint ===
          (await computeNearTransactionFingerprint(pending.prepared.transaction)) &&
        graph.root.id === pending.transactionId &&
        scopesMatch(graph.root.scope, pending.scope) &&
        graph.root.kind === 'transfer' &&
        (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
        intent?.schemaVersion === 1 &&
        intent.primaryAmount?.assetId === primaryAssetId &&
        intent.primaryAmount.amountRaw === primaryAmountRaw &&
        intent.feeLimit?.assetId === `${pending.prepared.chainId}/slip44:397` &&
        intent.feeLimit.amountRaw === pending.prepared.maximumFeeYocto &&
        intent.sender?.chainId === pending.prepared.chainId &&
        intent.sender.address === pending.prepared.signerId &&
        intent.recipient?.chainId === pending.prepared.chainId &&
        intent.recipient.address === recipientId &&
        segment?.target.kind === 'onchain' &&
        segment.target.chainId === pending.prepared.chainId &&
        (segment.status === 'prepared' || segment.status === 'approved')
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(pending: PendingNearTransfer): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending NEAR review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalNearTransfer, 'transactionId' | 'segmentId'>,
    graph: TransactionGraph,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): TransactionGraph {
    return transitionPendingTransactionGraph({
      reference: pending,
      graph,
      status,
      eventId: `event:near:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'NEAR'
    })
  }

  private async persistSignedGraph(
    pending: SignedPendingNearTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      label: 'NEAR'
    })
  }

  private requireGraph(
    pending: Pick<PendingNearTransfer, 'scope' | 'transactionId' | 'segmentId'>
  ): Promise<TransactionGraph> {
    return this.repository.get(pending.scope, pending.transactionId).then(graph => {
      if (!graph || !graph.segments.some(segment => segment.id === pending.segmentId)) {
        throw new Error('Persisted NEAR transaction graph was not found')
      }
      return graph
    })
  }

  private async applyStatus(
    pending: Pick<PendingNearTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:near:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted NEAR transaction segment was not found')
      if (segment.status === 'final' || segment.status === 'failed') return graph
      if (
        status !== 'failed' &&
        hasReachedTransactionStatus(
          segment.status as Exclude<TransactionLifecycleStatus, 'failed'>,
          status as Exclude<TransactionLifecycleStatus, 'failed'>
        )
      ) {
        return graph
      }
      const result = await this.repository.applySegmentEvent({
        scope: pending.scope,
        transactionId: pending.transactionId,
        segmentId: pending.segmentId,
        event,
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status === 'applied' && result.graph) return result.graph
      if (result.status === 'duplicate-event' && result.graph) return result.graph
      if (result.status === 'revision-conflict') continue
      throw new Error(`NEAR transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('NEAR transaction lifecycle update conflicted twice')
  }

  private async cancelSigning(
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.signer.cancel(keyDomainId, commandId, signal)
    } catch (error) {
      if (!isUnrecoverableSigningError(error)) throw error
    }
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid NEAR transfer timestamp')
    }
    return value
  }
}
