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
import type { SolanaTransactionSigningPreparePayload } from '@/infrastructure/keyring/multichain/solana-signing-client'
import type { LedgerSigningResume } from '@/infrastructure/keyring/multichain/ledger-signing-bridge'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'
import {
  type AwaitingApprovalSolanaTransfer,
  type PendingSolanaTransfer,
  type SignedPendingSolanaTransfer,
  type SolanaPendingTransferStore
} from './solana-pending-transfer-store'
import type { SolanaBroadcastRpc, SolanaReadRpc } from './solana-rpc-types'
import {
  assertSolanaTransferSigningMatchesPrepared,
  computeSolanaTransactionFingerprint,
  prepareSolanaNativeTransfer,
  prepareSolanaTokenTransfer
} from './solana-transfer-preparer'
import { createSolanaTransferGraph } from './solana-transaction-graph'
import { parseSignedSolanaTransaction } from './solana-signed-transaction'

export interface SolanaTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: SolanaTransactionSigningPreparePayload,
    signal?: AbortSignal
  ) => Promise<PreparedSigningCommand>
  readonly confirm: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal,
    origin?: string,
    execution?: SigningExecution,
    resume?: LedgerSigningResume<SolanaTransactionSigningPreparePayload>
  ) => Promise<SigningResult>
  readonly cancel: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal
  ) => Promise<void>
}

export interface SolanaTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: SolanaPendingTransferStore
  readonly signer: SolanaTransferSigningPort
  readonly rpc: SolanaReadRpc & SolanaBroadcastRpc
  readonly assets: AssetRegistry
  readonly now?: () => number
  readonly createId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  readonly canBroadcastSigned?: (scope: TransactionAccountScope) => Promise<boolean> | boolean
  readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void
}

interface PrepareSolanaTransferBaseInput {
  readonly chainAccount: ChainAccount
  readonly accountIndex: number
  readonly recipient: string
  readonly signal?: AbortSignal
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
}

export type PrepareSolanaTransferInput = PrepareSolanaTransferBaseInput &
  (
    | Readonly<{ readonly assetId: string; readonly amountRaw: string }>
    | Readonly<{ readonly lamports: string }>
  )

export interface PreparedSolanaTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinueSolanaTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveSolanaTransferInput extends ContinueSolanaTransferInput {
  readonly payloadFingerprint: string
}

export interface SolanaTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface SolanaPendingBroadcastRecoveryResult {
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

function parseAccountIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error('Invalid Solana account index')
  }
  return value
}

function pendingSigning(pending: AwaitingApprovalSolanaTransfer): PreparedSigningCommand {
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

export class SolanaTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: SolanaPendingTransferStore
  private readonly signer: SolanaTransferSigningPort
  private readonly rpc: SolanaReadRpc & SolanaBroadcastRpc
  private readonly assets: AssetRegistry
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly canBroadcastSigned?: SolanaTransferOrchestratorOptions['canBroadcastSigned']
  private readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void

  constructor(options: SolanaTransferOrchestratorOptions) {
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.signer = options.signer
    this.rpc = options.rpc
    this.assets = options.assets
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.onPendingBroadcast = options.onPendingBroadcast
    this.canBroadcastSigned = options.canBroadcastSigned
    this.onMonitoringRequired = options.onMonitoringRequired
  }

  async prepare(input: PrepareSolanaTransferInput): Promise<PreparedSolanaTransferApproval> {
    if (input.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Solana transfer requires an account-identifier binding')
    }
    const accountIndex = parseAccountIndex(input.accountIndex)
    const assetId =
      'assetId' in input ? input.assetId : `${input.chainAccount.scope.chainId}/slip44:501`
    const amountRaw = 'amountRaw' in input ? input.amountRaw : input.lamports
    const asset = this.assets.resolve(assetId)
    if (asset.asset.chainId !== input.chainAccount.scope.chainId) {
      throw new Error('Solana transfer asset does not match its ChainAccount')
    }
    const prepared =
      asset.asset.kind === 'native'
        ? await prepareSolanaNativeTransfer({
            chainId: input.chainAccount.scope.chainId,
            sender: input.chainAccount.identity.value,
            recipient: input.recipient,
            lamports: amountRaw,
            rpc: this.rpc,
            signal: input.signal
          })
        : await prepareSolanaTokenTransfer({
            chainId: input.chainAccount.scope.chainId,
            assetId: asset.asset.id,
            sender: input.chainAccount.identity.value,
            recipient: input.recipient,
            mint: asset.asset.reference,
            decimals: asset.metadata.decimals,
            amountRaw,
            rpc: this.rpc,
            signal: input.signal
          })
    const signing = await this.signer.prepare(
      input.chainAccount.scope.keyDomainId,
      Object.freeze({
        kind: 'solana-transaction' as const,
        chainId: input.chainAccount.scope.chainId,
        accountIndex,
        transaction: prepared.transactionBase64
      }),
      input.signal
    )
    try {
      await assertSolanaTransferSigningMatchesPrepared(prepared, signing)
      if (signing.expiresAt <= this.timestamp()) {
        throw new Error('Solana signing request expired during preparation')
      }
    } catch {
      await this.cancelSigning(
        input.chainAccount.scope.keyDomainId,
        signing.commandId,
        input.signal
      ).catch(() => {})
      throw new Error('Solana signing request cannot be approved')
    }
    if (signing.summary.schema !== 'solana.transaction.v1') {
      throw new Error('Solana signing request cannot be approved')
    }
    const signingSummary = signing.summary

    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:solana:${id}`)
    const segmentId = parseTransactionSegmentId(`segment:solana:${id}`)
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
    const graph = createSolanaTransferGraph({
      prepared,
      scope,
      transactionId,
      segmentId,
      assets: this.assets,
      createdAt,
      chainAccountId: input.chainAccount.id,
      ...(nearIntents === undefined ? {} : { nearIntents })
    })
    const pending: AwaitingApprovalSolanaTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'awaiting-approval',
      transactionId,
      segmentId,
      scope,
      prepared,
      signingSummary,
      signingCommandId: signing.commandId,
      signingExecution: signing.execution,
      accountIndex,
      payloadFingerprint: signing.payloadFingerprint.digestHex,
      expiresAt: signing.expiresAt
    })
    try {
      await this.pendingStore.put(pending, graph)
      return Object.freeze({ graph, signing })
    } catch (error) {
      await Promise.all([
        this.pendingStore.delete(transactionId).catch(() => {}),
        this.cancelSigning(scope.keyDomainId, signing.commandId, input.signal).catch(() => {})
      ])
      throw error
    }
  }

  async getPendingApproval(
    input: ContinueSolanaTransferInput
  ): Promise<PreparedSolanaTransferApproval | null> {
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
      throw new Error('Pending Solana transfer integrity check failed')
    }
    return Object.freeze({
      graph,
      signing: pendingSigning(pending)
    })
  }

  async approve(input: ApproveSolanaTransferInput): Promise<SolanaTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending Solana transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('Solana transfer is already signed; resume its broadcast instead')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('Solana approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Solana signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Solana transfer integrity check failed')
    }
    if ((await this.rpc.getBlockHeight(input.signal)) > pending.prepared.lastValidBlockHeight) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Solana transfer blockhash expired')
    }

    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')
    try {
      await this.pendingStore.put(pending, graph)
    } catch {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Approved Solana signing request could not be persisted')
    }
    let signed: SigningResult
    try {
      signed = await this.signer.confirm(
        pending.scope.keyDomainId,
        pending.signingCommandId,
        input.signal,
        undefined,
        pending.signingExecution,
        pending.signingExecution?.kind === 'external' && pending.accountIndex !== undefined
          ? {
              accountId: pending.scope.accountId,
              payload: {
                kind: 'solana-transaction',
                chainId: parseChainId(pending.prepared.chainId).id,
                accountIndex: pending.accountIndex,
                transaction: pending.prepared.transactionBase64
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
      throw new Error('Signed Solana transaction failed integrity validation')
    }
    let parsedSigned: ReturnType<typeof parseSignedSolanaTransaction>
    try {
      parsedSigned = parseSignedSolanaTransaction(signed.payload.value, signed.transactionId)
      if (parsedSigned.messageBase64 !== pending.prepared.messageBase64) {
        throw new Error('Signed Solana message does not match the prepared message')
      }
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Solana transaction failed integrity validation')
    }
    const signedPending: SignedPendingSolanaTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      ...parsedSigned,
      lastValidBlockHeight: pending.prepared.lastValidBlockHeight,
      signedAt: this.timestamp()
    })
    try {
      graph = this.transitionReviewGraph(pending, graph, 'signed', {
        transactionHash: signedPending.transactionHash,
        externalReference: `solana-blockhash:${pending.prepared.recentBlockhash}`
      })
      await this.pendingStore.put(signedPending, graph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Solana transaction could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async reject(input: ContinueSolanaTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending Solana approval was not found')
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

  async resumeBroadcast(input: ContinueSolanaTransferInput): Promise<SolanaTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
      throw new Error('Signed Solana transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  async resumePendingBroadcasts(): Promise<SolanaPendingBroadcastRecoveryResult> {
    const signed = (await this.pendingStore.list()).filter(
      (candidate): candidate is SignedPendingSolanaTransfer => candidate.phase === 'signed'
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
    pending: SignedPendingSolanaTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<SolanaTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    if ((await this.canBroadcastSigned?.(pending.scope)) === false) {
      await Promise.resolve(this.onPendingBroadcast?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    let accepted = false
    try {
      accepted =
        (await this.rpc.broadcastSignedTransaction(pending.transactionBase64, signal)) ===
        pending.transactionHash
    } catch {
      accepted = false
    }
    if (!accepted) {
      const observed = await this.rpc
        .getSignatureStatus(pending.transactionHash, signal)
        .catch(() => null)
      accepted = observed !== null && observed.status !== 'unknown'
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
    matches: (pending: AwaitingApprovalSolanaTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (candidate): candidate is AwaitingApprovalSolanaTransfer =>
        candidate.phase === 'awaiting-approval' && matches(candidate)
    )
    for (const candidate of pending) {
      await this.cancelSigning(candidate.scope.keyDomainId, candidate.signingCommandId, signal)
      await this.pendingStore.delete(candidate.transactionId)
    }
    return pending.length
  }

  private async failAwaitingApproval(
    pending: AwaitingApprovalSolanaTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.all([
      this.pendingStore.delete(pending.transactionId),
      this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, signal).catch(
        () => {}
      )
    ])
  }

  private async failConsumedSigning(pending: AwaitingApprovalSolanaTransfer): Promise<void> {
    await this.pendingStore.delete(pending.transactionId)
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingSolanaTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          candidate.target.chainId.startsWith('solana:')
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
      throw new Error('Pending Solana transfer integrity check failed')
    }
  }

  private async pendingIntegrityMatchesGraph(
    pending: AwaitingApprovalSolanaTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const intent = graph.root.intent
    try {
      await assertSolanaTransferSigningMatchesPrepared(pending.prepared, {
        commandId: pending.signingCommandId,
        chainId: parseChainId(pending.prepared.chainId).id,
        operation: 'transaction',
        summary: pending.signingSummary,
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: pending.payloadFingerprint
        },
        execution: pending.signingExecution ?? { kind: 'internal' },
        expiresAt: pending.expiresAt
      })
      const tokenTransfer = 'kind' in pending.prepared
      const primaryAssetId = tokenTransfer
        ? pending.prepared.assetId
        : `${pending.prepared.chainId}/slip44:501`
      const primaryAmountRaw = tokenTransfer
        ? pending.prepared.amountRaw
        : pending.prepared.lamports
      return (
        pending.payloadFingerprint ===
          (await computeSolanaTransactionFingerprint(pending.prepared.transactionBase64)) &&
        graph.root.id === pending.transactionId &&
        scopesMatch(graph.root.scope, pending.scope) &&
        graph.root.kind === 'transfer' &&
        (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
        intent?.schemaVersion === 1 &&
        intent.primaryAmount?.assetId === primaryAssetId &&
        intent.primaryAmount.amountRaw === primaryAmountRaw &&
        intent.feeLimit?.assetId === `${pending.prepared.chainId}/slip44:501` &&
        intent.feeLimit.amountRaw === pending.prepared.feeLamports &&
        intent.sender?.chainId === pending.prepared.chainId &&
        intent.sender.address === pending.prepared.sender &&
        intent.recipient?.chainId === pending.prepared.chainId &&
        intent.recipient.address === pending.prepared.recipient &&
        segment?.target.kind === 'onchain' &&
        segment.target.chainId === pending.prepared.chainId &&
        (segment.status === 'prepared' || segment.status === 'approved')
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(pending: PendingSolanaTransfer): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending Solana review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalSolanaTransfer, 'transactionId' | 'segmentId'>,
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
      eventId: `event:solana:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'Solana'
    })
  }

  private async persistSignedGraph(
    pending: SignedPendingSolanaTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      label: 'Solana'
    })
  }

  private requireGraph(
    pending: Pick<PendingSolanaTransfer, 'scope' | 'transactionId' | 'segmentId'>
  ): Promise<TransactionGraph> {
    return this.repository.get(pending.scope, pending.transactionId).then(graph => {
      if (!graph || !graph.segments.some(segment => segment.id === pending.segmentId)) {
        throw new Error('Persisted Solana transaction graph was not found')
      }
      return graph
    })
  }

  private async applyStatus(
    pending: Pick<PendingSolanaTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:solana:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted Solana transaction segment was not found')
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
      throw new Error(`Solana transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('Solana transaction lifecycle update conflicted twice')
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
      throw new Error('Invalid Solana transfer timestamp')
    }
    return value
  }
}
