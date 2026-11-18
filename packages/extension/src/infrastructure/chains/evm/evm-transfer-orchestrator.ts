import { KeyringError } from '@/core/keyring/ports'
import type { ChainAccount } from '@/core/accounts/domain'
import { parseAccountId } from '@/core/accounts/domain'
import type { Network } from '@/types'
import type { AssetRegistry } from '@/core/chains/registry'
import type { ChainId } from '@/core/chains/domain'
import { parseKeyDomainId, type SigningSummary } from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import {
  hasDestinationSettlementEvidence,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import type {
  NearIntentsTransactionBinding,
  RheaSwapTransactionBinding
} from '@/core/transactions/domain'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import type { EvmFeeSelection } from './evm-fee-tier'
import type { TransactionRepository } from '@/ports/repositories'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'
import {
  assertEvmSigningSummaryMatchesPrepared,
  assertEvmReplacementNonceAvailable,
  assertEvmTransferFresh,
  buildEvmCancelTransaction,
  buildEvmContractCall,
  buildEvmNonceRecoveryTransaction,
  buildEvmSpeedUpTransaction,
  buildEvmTransfer,
  computeEvmSigningPayloadFingerprint,
  createEvmSigningPreparePayload,
  createEvmSigningSummary,
  EvmTransactionError,
  estimateEvmContractCallFee,
  estimateEvmTransferFee,
  type EvmContractCallIntent,
  type EvmFeeEstimate,
  type PeaEvmExecutionAccount,
  type EvmTransferIntent
} from './evm-transaction-builder'
import { parseEvmAccountBinding } from './evm-account'
import { isEvmSpeedUpReplacement } from './evm-speed-up'
import {
  type AwaitingApprovalEvmTransfer,
  type AwaitingExternalSignatureEvmTransfer,
  type EvmExternalSignerBinding,
  type EvmPendingTransferStore,
  type PendingEvmTransfer,
  type PendingEvmSigningTransfer,
  type SignedPendingEvmTransfer
} from './evm-pending-transfer-store'
import { classifyEvmContractCall, createEvmTransferGraph } from './evm-transaction-graph'
import { broadcastSignedEvmTransaction } from './evm-transaction-observer'
import {
  EvmRpcError,
  type EvmBroadcastRpc,
  type EvmNonceQueueEndpointSelector,
  type EvmNonceQueueRpc,
  type EvmTransactionRpc
} from './evm-rpc-client'
import {
  assertSignedEvmTransactionMatchesPrepared,
  createKeystoneSignedEvmTransaction,
  serializePreparedEvmUnsignedTransaction
} from './evm-signed-transaction'
import {
  createKeystoneEthereumSignRequest,
  parseKeystoneEthereumSignatureCborBase64
} from '@/lib/keystone'
import { bytesToBase64, hexToBytes } from '@/lib/bytes'
import type { LedgerEvmSigningRequest } from '@/lib/ledger/evm'

export interface EvmTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: ReturnType<typeof createEvmSigningPreparePayload>,
    signal?: AbortSignal
  ) => Promise<PreparedSigningCommand>
  readonly confirm: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal
  ) => Promise<SigningResult>
  readonly cancel: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    commandId: SigningCommandId,
    signal?: AbortSignal
  ) => Promise<void>
}

type EvmTransferRpc = EvmTransactionRpc &
  EvmBroadcastRpc &
  EvmNonceQueueRpc &
  Partial<EvmNonceQueueEndpointSelector>

export interface EvmTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: EvmPendingTransferStore
  readonly signer: EvmTransferSigningPort
  readonly rpc: EvmTransferRpc
  readonly assets: AssetRegistry
  readonly networkMode?: Network
  readonly now?: () => number
  readonly createId?: () => string
  readonly createExternalRequestId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  readonly onBroadcastAccepted?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void
  readonly onMonitoringRequired?: () => Promise<void> | void
  readonly assertSpeedUpAllowed?: (original: TransactionGraph) => Promise<void>
}

export interface PrepareEvmTransferInput {
  readonly chainAccount: ChainAccount
  readonly intent: EvmTransferIntent | EvmContractCallIntent
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
  readonly rheaSwapBinding?: RheaSwapTransactionBinding
  readonly feeSelection?: EvmFeeSelection
  readonly feeTier?: NetworkFeeTier
  readonly signingMode?: 'internal' | 'keystone' | 'ledger'
  readonly externalSigner?: Omit<EvmExternalSignerBinding, 'requestId'>
  readonly signal?: AbortSignal
  readonly replacementOf?: Readonly<{
    transactionId: TransactionId
    transactionHash: string
    nonce: string
    maxFeePerGasWei: string
    maxPriorityFeePerGasWei: string
  }>
  readonly replacementMayBeUnknown?: boolean
  readonly speedUpOf?: TransactionGraph
  readonly nonceRecoveryNonce?: string
}

export interface EvmNonceRecoveryState {
  readonly chainId: ChainId
  readonly pendingNonce: string
  readonly highestLocalNonce: string
  readonly action: 'retry-broadcast' | 'fill-gap'
  readonly transactionId?: TransactionId
}

export interface PrepareEvmCancelInput {
  readonly chainAccount: ChainAccount
  readonly originalTransactionId: TransactionId
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly signingMode?: 'internal' | 'keystone' | 'ledger'
  readonly externalSigner?: Omit<EvmExternalSignerBinding, 'requestId'>
  readonly feeSelection?: EvmFeeSelection
  readonly signal?: AbortSignal
}

export interface PreparedEvmTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinueEvmTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveEvmTransferInput extends ContinueEvmTransferInput {
  readonly payloadFingerprint: string
}

export interface EvmTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface EvmExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type EvmTransferApprovalResult = EvmTransferSubmission | EvmExternalSignatureRequired

export interface EvmExternalSigningRequest {
  readonly vendor?: 'keystone' | 'ledger'
  readonly ledgerRequest?: LedgerEvmSigningRequest
  readonly transactionId: TransactionId
  readonly scope: TransactionAccountScope
  readonly summary: SigningSummary
  readonly request: Extract<
    PreparedSigningCommand['execution'],
    { readonly kind: 'external' }
  >['request']
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface SubmitEvmExternalSignatureInput extends ContinueEvmTransferInput {
  readonly payloadFingerprint: string
  readonly signatureCborBase64: string
}

const KEYSTONE_EVM_SIGNING_TTL_MS = 10 * 60 * 1000

function nonceQueueUnavailable(): EvmTransactionError {
  return new EvmTransactionError('nonce-queue-unavailable', 'Unable to verify the EVM send queue')
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

export class EvmTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: EvmPendingTransferStore
  private readonly signer: EvmTransferSigningPort
  private readonly rpc: EvmTransferRpc
  private readonly assets: AssetRegistry
  private readonly networkMode: Network
  private readonly now: () => number
  private readonly createId: () => string
  private readonly createExternalRequestId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly onBroadcastAccepted?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void
  private readonly onMonitoringRequired?: () => Promise<void> | void
  private readonly assertSpeedUpAllowed?: (original: TransactionGraph) => Promise<void>
  private readonly senderApprovalTails = new Map<string, Promise<void>>()
  private readonly senderPreparationTails = new Map<string, Promise<void>>()

  constructor(options: EvmTransferOrchestratorOptions) {
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.signer = options.signer
    this.rpc = options.rpc
    this.assets = options.assets
    this.networkMode = options.networkMode ?? 'mainnet'
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.createExternalRequestId = options.createExternalRequestId ?? (() => crypto.randomUUID())
    this.onPendingBroadcast = options.onPendingBroadcast
    this.onBroadcastAccepted = options.onBroadcastAccepted
    this.onMonitoringRequired = options.onMonitoringRequired
    this.assertSpeedUpAllowed = options.assertSpeedUpAllowed
  }

  async prepare(input: PrepareEvmTransferInput): Promise<PreparedEvmTransferApproval> {
    const sender = (
      input.executionAccount ??
      parseEvmAccountBinding(input.chainAccount, input.chainAccount.scope.chainId)
    ).address.toLowerCase()
    const key = this.senderKey(input.chainAccount.scope.chainId, sender)
    return this.runSenderPreparationExclusive(key, () => this.prepareExclusive(input, sender))
  }

  async estimateFee(
    input: Pick<
      PrepareEvmTransferInput,
      'chainAccount' | 'intent' | 'executionAccount' | 'feeSelection' | 'feeTier' | 'signal'
    >
  ): Promise<EvmFeeEstimate> {
    const buildInput = {
      chainId: input.chainAccount.scope.chainId,
      chainAccount: input.chainAccount,
      assets: this.assets,
      rpc: this.rpc,
      ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
      ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
      ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier }),
      signal: input.signal
    }
    return 'calldata' in input.intent
      ? estimateEvmContractCallFee({ ...buildInput, intent: input.intent })
      : estimateEvmTransferFee({ ...buildInput, intent: input.intent })
  }

  async prepareCancel(input: PrepareEvmCancelInput): Promise<PreparedEvmTransferApproval> {
    const scope = normalizeScope(input.chainAccount.scope)
    const originalTransactionId = parseTransactionId(input.originalTransactionId)
    const original = await this.repository.get(scope, originalTransactionId)
    if (
      !original ||
      (original.root.status !== 'broadcast' && original.root.status !== 'confirming') ||
      hasDestinationSettlementEvidence(original.segments)
    ) {
      throw new Error('Only a pending EVM transaction can be cancelled')
    }
    const segment = original.segments.find(
      candidate =>
        candidate.role === 'origin' &&
        candidate.target.kind === 'onchain' &&
        candidate.target.chainId === input.chainAccount.scope.chainId
    )
    const transactionHash = segment?.evidence?.transactionHash
    const evm = original.root.intent?.evm
    const sender = original.root.intent?.sender
    if (
      !segment ||
      (segment.status !== 'broadcast' && segment.status !== 'confirming') ||
      segment.evidence?.replacementTransactionHash !== undefined ||
      !transactionHash ||
      !evm ||
      !sender
    ) {
      throw new Error('Pending EVM transaction does not contain replacement metadata')
    }
    const executionAccount = input.executionAccount
    const activeSender = (
      executionAccount ??
      parseEvmAccountBinding(input.chainAccount, input.chainAccount.scope.chainId)
    ).address
    if (
      sender.chainId !== input.chainAccount.scope.chainId ||
      sender.address.toLowerCase() !== activeSender.toLowerCase()
    ) {
      throw new Error('Pending EVM transaction does not belong to the active signer')
    }
    const existing = await this.repository.list({
      scope,
      chainId: input.chainAccount.scope.chainId,
      statuses: ['prepared', 'approved', 'signed', 'broadcast', 'confirming', 'final'],
      limit: 200
    })
    if (
      existing.some(
        graph =>
          graph.root.kind === 'cancel' &&
          graph.root.relation?.kind === 'replacement-of' &&
          graph.root.relation.transactionId === originalTransactionId
      )
    ) {
      throw new Error('A cancellation replacement already exists')
    }
    for (const pending of await this.pendingStore.list()) {
      const pendingGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
      if (
        pendingGraph?.root.kind === 'cancel' &&
        pendingGraph.root.relation?.kind === 'replacement-of' &&
        pendingGraph.root.relation.transactionId === originalTransactionId
      ) {
        throw new Error('A cancellation replacement already exists')
      }
    }
    return this.prepare({
      chainAccount: input.chainAccount,
      intent: Object.freeze({
        chainId: input.chainAccount.scope.chainId,
        contractAddress: activeSender,
        valueRaw: '0',
        calldata: '0x'
      }),
      ...(executionAccount === undefined ? {} : { executionAccount }),
      ...(input.signingMode === undefined ? {} : { signingMode: input.signingMode }),
      ...(input.externalSigner === undefined ? {} : { externalSigner: input.externalSigner }),
      ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
      signal: input.signal,
      replacementOf: Object.freeze({
        transactionId: originalTransactionId,
        transactionHash,
        nonce: evm.nonce,
        maxFeePerGasWei: evm.maxFeePerGasWei,
        maxPriorityFeePerGasWei: evm.maxPriorityFeePerGasWei
      }),
      replacementMayBeUnknown: original.root.status === 'broadcast'
    })
  }

  async prepareSpeedUp(input: PrepareEvmCancelInput): Promise<PreparedEvmTransferApproval> {
    const scope = normalizeScope(input.chainAccount.scope)
    const originalTransactionId = parseTransactionId(input.originalTransactionId)
    const original = await this.repository.get(scope, originalTransactionId)
    const segment = original?.segments.find(
      candidate =>
        candidate.role === 'origin' &&
        candidate.target.kind === 'onchain' &&
        candidate.target.chainId === input.chainAccount.scope.chainId
    )
    const transactionHash = segment?.evidence?.transactionHash
    const unsignedTransaction = original?.root.intent?.evm?.unsignedTransaction
    const sender = original?.root.intent?.sender
    const activeSender = (
      input.executionAccount ??
      parseEvmAccountBinding(input.chainAccount, input.chainAccount.scope.chainId)
    ).address
    if (
      !original ||
      original.root.kind === 'cancel' ||
      hasDestinationSettlementEvidence(original.segments) ||
      (original.root.status !== 'broadcast' && original.root.status !== 'confirming') ||
      (segment?.status !== 'broadcast' && segment?.status !== 'confirming') ||
      !transactionHash ||
      segment.evidence?.replacementTransactionHash !== undefined ||
      !unsignedTransaction ||
      !sender ||
      sender.chainId !== input.chainAccount.scope.chainId ||
      sender.address.toLowerCase() !== activeSender.toLowerCase() ||
      unsignedTransaction.chainId !== input.chainAccount.scope.chainId.slice('eip155:'.length) ||
      (original.root.intent?.protocol !== undefined &&
        original.root.intent.protocol.expiresAt <= this.now())
    ) {
      throw new EvmTransactionError('stale-nonce', 'Pending EVM transaction cannot be sped up')
    }
    await this.checkSpeedUpAllowed(original)
    const existing = await this.repository.list({
      scope,
      chainId: input.chainAccount.scope.chainId,
      statuses: ['prepared', 'approved', 'signed', 'broadcast', 'confirming', 'final'],
      limit: 200
    })
    const pendingGraphs = await Promise.all(
      (await this.pendingStore.list()).map(pending =>
        this.pendingStore.getReviewGraph(pending.transactionId)
      )
    )
    if (
      [...existing, ...pendingGraphs].some(
        graph =>
          graph?.root.relation?.kind === 'replacement-of' &&
          graph.root.relation.transactionId === originalTransactionId
      )
    ) {
      throw new EvmTransactionError('stale-nonce', 'An EVM replacement already exists')
    }
    return this.prepare({
      chainAccount: input.chainAccount,
      intent: {
        chainId: input.chainAccount.scope.chainId,
        contractAddress: unsignedTransaction.to,
        valueRaw: unsignedTransaction.value,
        calldata: unsignedTransaction.input
      },
      ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
      ...(input.signingMode === undefined ? {} : { signingMode: input.signingMode }),
      ...(input.externalSigner === undefined ? {} : { externalSigner: input.externalSigner }),
      ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
      signal: input.signal,
      speedUpOf: original,
      replacementMayBeUnknown: original.root.status === 'broadcast'
    })
  }

  async getNonceRecovery(input: {
    readonly chainAccount: ChainAccount
    readonly executionAccount?: PeaEvmExecutionAccount
  }): Promise<EvmNonceRecoveryState | null> {
    const chainId = input.chainAccount.scope.chainId
    const sender = (
      input.executionAccount ?? parseEvmAccountBinding(input.chainAccount, chainId)
    ).address.toLowerCase()
    const scope = normalizeScope(input.chainAccount.scope)
    const queue = await this.readNonceQueue(scope, chainId, sender)
    for (const pending of await this.pendingStore.list()) {
      if (pending.phase !== 'signed' || !scopesMatch(pending.scope, scope)) continue
      const graph = await this.pendingStore.getReviewGraph(pending.transactionId)
      if (!graph || this.graphNonce(graph, chainId, sender) !== queue.nextNonce) continue
      return Object.freeze({
        chainId,
        pendingNonce: queue.nextNonce.toString(),
        highestLocalNonce: (queue.gapHighest ?? queue.nextNonce).toString(),
        action: 'retry-broadcast',
        transactionId: pending.transactionId
      })
    }
    if (queue.uncertainHead) throw nonceQueueUnavailable()
    if (queue.gapHighest === null) return null
    return Object.freeze({
      chainId,
      pendingNonce: queue.nextNonce.toString(),
      highestLocalNonce: queue.gapHighest.toString(),
      action: 'fill-gap'
    })
  }

  async prepareNonceRecovery(input: {
    readonly chainAccount: ChainAccount
    readonly executionAccount?: PeaEvmExecutionAccount
    readonly feeSelection?: EvmFeeSelection
    readonly signingMode?: 'internal' | 'keystone' | 'ledger'
    readonly externalSigner?: Omit<EvmExternalSignerBinding, 'requestId'>
  }): Promise<PreparedEvmTransferApproval> {
    const state = await this.getNonceRecovery(input)
    if (!state) throw new EvmTransactionError('stale-nonce', 'No EVM nonce gap remains')
    if (state.action === 'retry-broadcast') {
      throw new EvmTransactionError('stale-nonce', 'Retry the signed EVM transaction first')
    }
    const sender = (
      input.executionAccount ??
      parseEvmAccountBinding(input.chainAccount, input.chainAccount.scope.chainId)
    ).address
    return this.prepare({
      chainAccount: input.chainAccount,
      intent: Object.freeze({
        chainId: input.chainAccount.scope.chainId,
        contractAddress: sender,
        valueRaw: '0',
        calldata: '0x'
      }),
      ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
      ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
      ...(input.signingMode === undefined ? {} : { signingMode: input.signingMode }),
      ...(input.externalSigner === undefined ? {} : { externalSigner: input.externalSigner }),
      nonceRecoveryNonce: state.pendingNonce
    })
  }

  private async prepareExclusive(
    input: PrepareEvmTransferInput,
    sender: string
  ): Promise<PreparedEvmTransferApproval> {
    const isCancel = input.replacementOf !== undefined
    const isSpeedUp = input.speedUpOf !== undefined
    const isNonceRecovery = input.nonceRecoveryNonce !== undefined
    const isContractCall = 'calldata' in input.intent
    if (input.nearIntentsBinding && input.rheaSwapBinding) {
      throw new Error('EVM transaction cannot bind multiple protocols')
    }
    if (isContractCall && input.nearIntentsBinding) {
      throw new Error('EVM contract calls cannot bind a Near Intents transfer')
    }
    if (isNonceRecovery) {
      const state = await this.getNonceRecovery({
        chainAccount: input.chainAccount,
        ...(input.executionAccount === undefined
          ? {}
          : { executionAccount: input.executionAccount })
      })
      if (state?.action !== 'fill-gap' || state.pendingNonce !== input.nonceRecoveryNonce) {
        throw new EvmTransactionError('stale-nonce', 'EVM nonce recovery state changed')
      }
      if (
        (
          await this.listUnexpiredPendingTransfers(input.chainAccount.scope.chainId, sender)
        ).active.some(
          pending =>
            pending.phase !== 'signed' &&
            pending.prepared.chainId === input.chainAccount.scope.chainId &&
            pending.prepared.from.toLowerCase() === sender &&
            pending.prepared.transaction.nonce === state.pendingNonce
        )
      ) {
        throw new EvmTransactionError(
          'stale-nonce',
          'Review the existing transaction at this nonce first'
        )
      }
    }
    const nonceFloor =
      isCancel || isSpeedUp || isNonceRecovery
        ? undefined
        : await this.readLocalNonceFloor(
            normalizeScope(input.chainAccount.scope),
            input.chainAccount.scope.chainId,
            sender,
            input.signal
          )
    const sharedBuildInput = {
      chainId: input.chainAccount.scope.chainId,
      chainAccount: input.chainAccount,
      ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
      assets: this.assets,
      rpc: this.rpc,
      ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
      ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier }),
      ...(nonceFloor === undefined ? {} : { nonceFloor }),
      signal: input.signal,
      now: this.now
    }
    const prepared = isSpeedUp
      ? await buildEvmSpeedUpTransaction({
          chainId: input.chainAccount.scope.chainId,
          chainAccount: input.chainAccount,
          ...(input.executionAccount === undefined
            ? {}
            : { executionAccount: input.executionAccount }),
          assets: this.assets,
          rpc: this.rpc,
          original: {
            transactionHash: input.speedUpOf!.segments.find(segment => segment.role === 'origin')!
              .evidence!.transactionHash!,
            transaction: input.speedUpOf!.root.intent!.evm!.unsignedTransaction!
          },
          ...(input.replacementMayBeUnknown ? { allowUnknownAtNonce: true } : {}),
          ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
          signal: input.signal,
          now: this.now
        })
      : isCancel
        ? await buildEvmCancelTransaction({
            chainId: input.chainAccount.scope.chainId,
            chainAccount: input.chainAccount,
            ...(input.executionAccount === undefined
              ? {}
              : { executionAccount: input.executionAccount }),
            assets: this.assets,
            rpc: this.rpc,
            original: input.replacementOf,
            ...(input.replacementMayBeUnknown ? { allowUnknownAtNonce: true } : {}),
            ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
            signal: input.signal,
            now: this.now
          })
        : isNonceRecovery
          ? await buildEvmNonceRecoveryTransaction({
              chainId: input.chainAccount.scope.chainId,
              chainAccount: input.chainAccount,
              ...(input.executionAccount === undefined
                ? {}
                : { executionAccount: input.executionAccount }),
              assets: this.assets,
              rpc: this.rpc,
              nonce: input.nonceRecoveryNonce ?? '',
              ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
              signal: input.signal,
              now: this.now
            })
          : isContractCall
            ? await buildEvmContractCall({ ...sharedBuildInput, intent: input.intent })
            : await buildEvmTransfer({ ...sharedBuildInput, intent: input.intent })
    const expectedFingerprint = await computeEvmSigningPayloadFingerprint(prepared.transaction)
    let externalSigner: EvmExternalSignerBinding | null = null
    const signing =
      input.signingMode === 'keystone' || input.signingMode === 'ledger'
        ? await (async (): Promise<PreparedSigningCommand> => {
            if (!input.externalSigner) {
              throw new Error('Hardware EVM signing requires an authenticated public account')
            }
            const requestId = this.createExternalRequestId()
            externalSigner = Object.freeze({
              ...input.externalSigner,
              vendor: input.signingMode === 'ledger' ? 'ledger' : 'keystone',
              requestId
            })
            const unsignedTransactionHex = serializePreparedEvmUnsignedTransaction(prepared)
            const request =
              input.signingMode === 'ledger'
                ? null
                : createKeystoneEthereumSignRequest({
                    requestId,
                    unsignedTransactionHex,
                    chainId: Number(prepared.transaction.chainId),
                    derivationPath: input.externalSigner.derivationPath,
                    masterFingerprintHex: input.externalSigner.masterFingerprintHex!,
                    address: input.externalSigner.address
                  })
            return Object.freeze({
              commandId: parseSigningCommandId(
                `signing-command:${input.signingMode}-evm:${requestId}`
              ),
              chainId: prepared.chainId,
              operation: 'transaction' as const,
              summary: await createEvmSigningSummary(prepared),
              payloadFingerprint: Object.freeze({
                algorithm: 'sha256' as const,
                digestHex: expectedFingerprint
              }),
              execution: Object.freeze({
                kind: 'external' as const,
                request: Object.freeze({
                  encoding: 'base64' as const,
                  value: request?.cborBase64 ?? bytesToBase64(hexToBytes(unsignedTransactionHex))
                })
              }),
              expiresAt: this.timestamp() + KEYSTONE_EVM_SIGNING_TTL_MS
            })
          })()
        : await this.signer.prepare(
            input.chainAccount.scope.keyDomainId,
            createEvmSigningPreparePayload(
              prepared,
              input.executionAccount === undefined ? 'main' : 'private'
            ),
            input.signal
          )
    try {
      await assertEvmSigningSummaryMatchesPrepared(prepared, signing.summary)
      if (
        signing.summary.review.level === 'blocked' ||
        signing.expiresAt <= this.now() ||
        signing.payloadFingerprint.digestHex !== expectedFingerprint
      ) {
        throw new Error('EVM signing request cannot be approved')
      }
    } catch {
      await this.cancelPreparedSigning(
        input.chainAccount.scope.keyDomainId,
        signing,
        input.signal
      ).catch(() => {})
      throw new Error('EVM signing request cannot be approved')
    }

    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:evm:${id}`)
    const segmentId = parseTransactionSegmentId(`segment:evm:${id}`)
    const nearIntents = input.nearIntentsBinding
      ? Object.freeze({
          binding: input.nearIntentsBinding,
          segmentIds: Object.freeze({
            relay: parseTransactionSegmentId(`segment:evm:${id}:relay`),
            destination: parseTransactionSegmentId(`segment:evm:${id}:destination`),
            refund: parseTransactionSegmentId(`segment:evm:${id}:refund`)
          })
        })
      : undefined
    const rheaSwap = input.rheaSwapBinding
      ? Object.freeze({
          binding: input.rheaSwapBinding,
          segmentIds: Object.freeze({
            relay: parseTransactionSegmentId(`segment:evm:${id}:rhea-relay`),
            destination: parseTransactionSegmentId(`segment:evm:${id}:rhea-destination`),
            refund: parseTransactionSegmentId(`segment:evm:${id}:rhea-refund`)
          })
        })
      : undefined
    const scope = normalizeScope(input.chainAccount.scope)
    let graph = createEvmTransferGraph({
      prepared,
      scope,
      transactionId,
      segmentId,
      assets: this.assets,
      chainAccountId: input.chainAccount.id,
      ...(nearIntents === undefined ? {} : { nearIntents }),
      ...(rheaSwap === undefined ? {} : { rheaSwap })
    })
    if (input.replacementOf) {
      graph = parseTransactionGraph({
        ...graph,
        root: {
          ...graph.root,
          kind: 'cancel',
          intent: graph.root.intent
            ? { ...graph.root.intent, direction: 'self' }
            : graph.root.intent,
          relation: {
            kind: 'replacement-of',
            transactionId: input.replacementOf.transactionId
          }
        }
      })
    } else if (input.speedUpOf) {
      const originalIntent = input.speedUpOf.root.intent!
      const maximumFee =
        BigInt(prepared.transaction.gasLimit) *
        BigInt(
          prepared.transaction.type === 'legacy'
            ? prepared.transaction.gasPrice
            : prepared.transaction.maxFeePerGas
        )
      graph = parseTransactionGraph({
        ...graph,
        root: {
          ...graph.root,
          kind: input.speedUpOf.root.kind,
          intent: {
            ...originalIntent,
            feeLimit: originalIntent.feeLimit
              ? { ...originalIntent.feeLimit, amountRaw: maximumFee.toString() }
              : graph.root.intent?.feeLimit,
            evm: {
              ...originalIntent.evm,
              maxFeePerGasWei:
                prepared.transaction.type === 'legacy'
                  ? prepared.transaction.gasPrice
                  : prepared.transaction.maxFeePerGas,
              maxPriorityFeePerGasWei:
                prepared.transaction.type === 'legacy'
                  ? '0'
                  : prepared.transaction.maxPriorityFeePerGas,
              unsignedTransaction: prepared.transaction
            }
          },
          relation: {
            kind: 'replacement-of',
            transactionId: input.speedUpOf.root.id
          }
        }
      })
    }
    const pending: AwaitingApprovalEvmTransfer = Object.freeze({
      schemaVersion: 2,
      phase: 'awaiting-approval',
      transactionId,
      segmentId,
      scope,
      prepared,
      signingSummary: signing.summary,
      signingCommandId: signing.commandId,
      signingExecution: signing.execution,
      externalSigner,
      payloadFingerprint: signing.payloadFingerprint.digestHex,
      expiresAt: signing.expiresAt
    })

    try {
      await this.pendingStore.put(pending, graph)
      return Object.freeze({ graph, signing })
    } catch (error) {
      await Promise.all([
        this.pendingStore.delete(transactionId).catch(() => {}),
        this.cancelPreparedSigning(
          input.chainAccount.scope.keyDomainId,
          signing,
          input.signal
        ).catch(() => {})
      ])
      throw error
    }
  }

  private senderKey(chainId: string, sender: string): string {
    return `${this.networkMode}:${chainId}:${sender.toLowerCase()}`
  }

  private graphNonce(graph: TransactionGraph, chainId: ChainId, sender: string): bigint | null {
    const intent = graph.root.intent
    if (
      intent?.sender?.chainId !== chainId ||
      intent.sender.address.toLowerCase() !== sender.toLowerCase()
    ) {
      return null
    }
    const origin = graph.segments.find(segment => segment.role === 'origin')
    const value =
      intent.evm?.nonce ??
      /^evm-nonce:(0|[1-9][0-9]*)$/.exec(origin?.evidence?.externalReference ?? '')?.[1]
    return value === undefined ? null : BigInt(value)
  }

  private async runSenderPreparationExclusive<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.senderPreparationTails.get(key) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.senderPreparationTails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.senderPreparationTails.get(key) === tail) this.senderPreparationTails.delete(key)
    }
  }

  private async readNonceQueue(
    scope: TransactionAccountScope,
    chainId: ChainId,
    sender: string,
    signal?: AbortSignal
  ): Promise<{ nextNonce: bigint; gapHighest: bigint | null; uncertainHead: boolean }> {
    const persisted = await this.repository.list({
      scope,
      chainId,
      statuses: ['signed', 'broadcast', 'confirming'],
      limit: 200
    })
    const candidates = persisted.flatMap(graph => {
      const nonce = this.graphNonce(graph, chainId, sender)
      if (nonce === null) return []
      const origin = graph.segments.find(segment => segment.role === 'origin')
      return [{ nonce, hash: origin?.evidence?.transactionHash }]
    })
    const observe = (rpc: EvmNonceQueueRpc) =>
      this.observeNonceQueue(rpc, sender, candidates, signal)
    try {
      if (this.rpc.withNonceQueueEndpoint) {
        return await this.rpc.withNonceQueueEndpoint(observe, signal)
      }
      await this.rpc.assertExpectedChain(signal)
      return await observe(this.rpc)
    } catch (error) {
      if (error instanceof EvmRpcError && error.code !== 'cancelled') {
        throw nonceQueueUnavailable()
      }
      throw error
    }
  }

  private async observeNonceQueue(
    rpc: EvmNonceQueueRpc,
    sender: string,
    candidates: readonly { nonce: bigint; hash: string | undefined }[],
    signal?: AbortSignal
  ): Promise<{ nextNonce: bigint; gapHighest: bigint | null; uncertainHead: boolean }> {
    const pendingNonce = BigInt(await rpc.getPendingNonce(sender, signal))
    if (!candidates.some(candidate => candidate.nonce >= pendingNonce)) {
      return { nextNonce: pendingNonce, gapHighest: null, uncertainHead: false }
    }

    const latestNonce = BigInt(await rpc.getTransactionCount(sender, 'latest', signal))
    const initialNextNonce = latestNonce > pendingNonce ? latestNonce : pendingNonce
    let includedFloor = initialNextNonce
    const pending = new Set<bigint>()
    const unresolved = new Set<bigint>()
    const remaining = candidates.filter(candidate => candidate.nonce >= initialNextNonce)
    for (let offset = 0; offset < remaining.length; offset += 4) {
      const observations = await Promise.all(
        remaining.slice(offset, offset + 4).map(async ({ nonce, hash }) => {
          if (!hash) return { nonce, status: 'unknown' }
          const location = await rpc.getTransactionLocation(hash, signal)
          if (location.status !== 'unknown') return { nonce, status: location.status }
          const receipt = await rpc.getTransactionReceipt(hash, signal)
          return {
            nonce,
            status: receipt?.transactionHash === hash.toLowerCase() ? 'included' : 'unknown'
          }
        })
      )
      for (const { nonce, status } of observations) {
        if (status === 'included' && nonce >= includedFloor) includedFloor = nonce + 1n
        if (status === 'pending') pending.add(nonce)
        if (status === 'unknown') unresolved.add(nonce)
      }
    }
    let nextNonce = includedFloor
    while (pending.has(nextNonce)) nextNonce += 1n
    const uncertainHead = unresolved.has(nextNonce)
    let gapHighest: bigint | null = null
    if (!uncertainHead) {
      for (const nonce of pending) {
        if (nonce > nextNonce && (gapHighest === null || nonce > gapHighest)) gapHighest = nonce
      }
    }
    if (gapHighest !== null || uncertainHead) {
      const refreshedPending = BigInt(await rpc.getPendingNonce(sender, signal))
      const refreshedLatest = BigInt(await rpc.getTransactionCount(sender, 'latest', signal))
      if (
        refreshedPending !== pendingNonce ||
        refreshedLatest !== latestNonce ||
        latestNonce > pendingNonce ||
        includedFloor > initialNextNonce
      ) {
        throw new EvmRpcError('invalid-response', 'The EVM send queue changed during verification')
      }
    }
    return { nextNonce, gapHighest, uncertainHead }
  }

  private async readLocalNonceFloor(
    scope: TransactionAccountScope,
    chainId: ChainId,
    sender: string,
    signal?: AbortSignal,
    protectedTransactionId?: TransactionId
  ): Promise<string> {
    const queue = await this.readNonceQueue(scope, chainId, sender, signal)
    if (queue.gapHighest !== null) {
      throw new EvmTransactionError(
        'nonce-recovery-required',
        `Resolve EVM nonce ${queue.nextNonce} before preparing another transaction`
      )
    }
    if (queue.uncertainHead) {
      throw nonceQueueUnavailable()
    }
    let nonceFloor = queue.nextNonce
    const { active: pendingRecords } = await this.listUnexpiredPendingTransfers(
      chainId,
      sender,
      protectedTransactionId
    )
    for (const pending of pendingRecords) {
      if (pending.phase === 'signed') {
        const graph = await this.pendingStore.getReviewGraph(pending.transactionId)
        const sameScope =
          pending.scope.keyDomainId === scope.keyDomainId &&
          pending.scope.accountId === scope.accountId
        if ((graph && this.graphNonce(graph, chainId, sender) !== null) || (!graph && sameScope)) {
          throw new EvmTransactionError(
            'stale-nonce',
            'A signed EVM transaction has an uncertain broadcast status'
          )
        }
        continue
      }
      if (pending.prepared.chainId !== chainId || pending.prepared.from.toLowerCase() !== sender) {
        continue
      }
      const nonce = BigInt(pending.prepared.transaction.nonce)
      if (pending.transactionId === protectedTransactionId && nonce !== queue.nextNonce) {
        throw new EvmTransactionError('stale-nonce', 'The next EVM nonce changed. Review again')
      }
      if (nonce >= nonceFloor) nonceFloor = nonce + 1n
    }
    return nonceFloor.toString()
  }

  private async listUnexpiredPendingTransfers(
    chainId: ChainId,
    sender: string,
    protectedTransactionId?: TransactionId
  ): Promise<{
    active: readonly PendingEvmTransfer[]
    expired: readonly PendingEvmSigningTransfer[]
  }> {
    const active: PendingEvmTransfer[] = []
    const expired: PendingEvmSigningTransfer[] = []
    for (const candidate of await this.pendingStore.list()) {
      if (
        candidate.phase !== 'signed' &&
        candidate.transactionId !== protectedTransactionId &&
        candidate.prepared.chainId === chainId &&
        candidate.prepared.from.toLowerCase() === sender.toLowerCase() &&
        this.now() >= candidate.expiresAt
      ) {
        await this.failAwaitingApproval(candidate)
        expired.push(candidate)
      } else {
        active.push(candidate)
      }
    }
    return { active, expired }
  }

  async getPendingApproval(
    input: ContinueEvmTransferInput
  ): Promise<PreparedEvmTransferApproval | null> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'awaiting-approval') {
      return null
    }
    if (this.now() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      return null
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, graph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending EVM transfer integrity check failed')
    }
    return Object.freeze({
      graph,
      signing: Object.freeze({
        commandId: pending.signingCommandId,
        chainId: pending.prepared.chainId,
        operation: 'transaction' as const,
        summary: pending.signingSummary,
        payloadFingerprint: Object.freeze({
          algorithm: 'sha256' as const,
          digestHex: pending.payloadFingerprint
        }),
        execution: pending.signingExecution,
        expiresAt: pending.expiresAt
      })
    })
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

  clearPendingTransfers(): Promise<number> {
    return this.pendingStore.clear()
  }

  cancelAllAwaitingApprovals(signal?: AbortSignal): Promise<number> {
    return this.cancelAwaitingApprovals(() => true, signal)
  }

  async approve(input: ApproveEvmTransferInput): Promise<EvmTransferApprovalResult> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending EVM transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('EVM transfer is already signed; resume its broadcast instead')
    }
    return this.runSenderApprovalExclusive(
      `${pending.prepared.chainId}:${pending.prepared.from.toLowerCase()}`,
      () => this.approveExclusive(input)
    )
  }

  private async approveExclusive(
    input: ApproveEvmTransferInput
  ): Promise<EvmTransferApprovalResult> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending EVM transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('EVM transfer is already signed; resume its broadcast instead')
    }
    if (pending.phase === 'awaiting-external-signature') {
      throw new Error('EVM transfer is already awaiting an external signature')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('EVM approval payload fingerprint does not match')
    }

    if (this.now() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('EVM signing request expired')
    }

    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending EVM transfer integrity check failed')
    }
    const rheaBinding = currentGraph.root.intent?.protocol
    if (rheaBinding?.provider === 'rhea-cross-chain-dex' && rheaBinding.expiresAt <= this.now()) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('RHEA Swap quote expired')
    }

    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')
    if (graph.root.status === 'failed' || graph.root.status === 'final') {
      throw new Error('EVM transaction is already terminal')
    }
    try {
      await this.assertApprovalNonce(pending, currentGraph, input.signal)
    } catch (error) {
      if (
        error instanceof EvmTransactionError &&
        (error.code === 'stale-nonce' || error.code === 'nonce-recovery-required')
      ) {
        await this.failAwaitingApproval(pending, input.signal)
      }
      throw error
    }

    if (pending.signingExecution.kind === 'external') {
      if (pending.externalSigner === null) {
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('External EVM signing request has no authenticated signer binding')
      }
      const externalPending: AwaitingExternalSignatureEvmTransfer = Object.freeze({
        ...pending,
        phase: 'awaiting-external-signature',
        signingExecution: pending.signingExecution,
        externalSigner: pending.externalSigner
      })
      try {
        await this.pendingStore.put(externalPending, graph)
      } catch {
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('External EVM signing request could not be persisted')
      }
      return Object.freeze({
        status: 'external-signature-required' as const,
        graph,
        transactionId: pending.transactionId,
        payloadFingerprint: pending.payloadFingerprint,
        expiresAt: pending.expiresAt
      })
    }

    try {
      await this.pendingStore.put(pending, graph)
    } catch {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Approved EVM signing request could not be persisted')
    }

    let signed: SigningResult
    try {
      signed = await this.signer.confirm(
        pending.scope.keyDomainId,
        pending.signingCommandId,
        input.signal
      )
    } catch (error) {
      if (isUnrecoverableSigningError(error)) {
        await this.failAwaitingApproval(pending, input.signal)
      }
      throw error
    }
    if (
      signed.kind !== 'signed-payload' ||
      signed.payload.encoding !== 'hex' ||
      signed.transactionId === undefined
    ) {
      await this.failConsumedSigning(pending)
      throw new Error('Signed EVM transaction failed integrity validation (result-envelope)')
    }
    try {
      await assertSignedEvmTransactionMatchesPrepared(pending.prepared, {
        rawTransaction: signed.payload.value,
        transactionHash: signed.transactionId
      })
    } catch (error) {
      await this.failConsumedSigning(pending)
      throw error
    }

    const signedPending: SignedPendingEvmTransfer = Object.freeze({
      schemaVersion: 2,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      rawTransaction: signed.payload.value,
      transactionHash: signed.transactionId,
      signedAt: this.now()
    })
    try {
      graph = this.transitionReviewGraph(pending, graph, 'signed', {
        transactionHash: signedPending.transactionHash,
        externalReference: `evm-nonce:${pending.prepared.transaction.nonce}`
      })
      await this.pendingStore.put(signedPending, graph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed EVM transaction could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  private async assertApprovalNonce(
    pending: PendingEvmSigningTransfer,
    graph: TransactionGraph,
    signal?: AbortSignal
  ): Promise<void> {
    const prepared = pending.prepared
    if (prepared.kind === 'nonce-recovery') {
      const queue = await this.readNonceQueue(
        pending.scope,
        prepared.chainId,
        prepared.from,
        signal
      )
      const currentNonce = queue.nextNonce.toString()
      if (queue.gapHighest === null || currentNonce !== prepared.transaction.nonce) {
        throw new EvmTransactionError('stale-nonce', 'EVM nonce recovery state changed')
      }
      for (const candidate of (
        await this.listUnexpiredPendingTransfers(
          prepared.chainId,
          prepared.from,
          pending.transactionId
        )
      ).active) {
        if (candidate.transactionId === pending.transactionId) continue
        if (candidate.phase === 'signed') {
          const signedGraph = await this.pendingStore.getReviewGraph(candidate.transactionId)
          if (
            signedGraph &&
            this.graphNonce(signedGraph, prepared.chainId, prepared.from) === BigInt(currentNonce)
          ) {
            throw new EvmTransactionError('stale-nonce', 'Retry the signed EVM transaction first')
          }
        } else if (
          candidate.prepared.chainId === prepared.chainId &&
          candidate.prepared.from.toLowerCase() === prepared.from.toLowerCase() &&
          candidate.prepared.transaction.nonce === currentNonce
        ) {
          throw new EvmTransactionError('stale-nonce', 'EVM nonce recovery state changed')
        }
      }
      return
    }
    if (graph.root.kind === 'cancel') {
      const originalId = graph.root.relation?.transactionId
      const original = originalId ? await this.repository.get(graph.root.scope, originalId) : null
      const origin = original?.segments.find(segment => segment.role === 'origin')
      const originalHash = origin?.evidence?.transactionHash
      if (
        !original ||
        !originalHash ||
        (original.root.status !== 'broadcast' && original.root.status !== 'confirming') ||
        hasDestinationSettlementEvidence(original.segments) ||
        (origin.status !== 'broadcast' && origin.status !== 'confirming') ||
        origin.evidence?.replacementTransactionHash !== undefined
      ) {
        throw new EvmTransactionError('stale-nonce', 'The original EVM transaction is unavailable')
      }
      await this.rpc.assertExpectedChain(signal)
      await assertEvmReplacementNonceAvailable(
        this.rpc,
        prepared.from,
        BigInt(prepared.transaction.nonce),
        signal
      )
      const location = await this.rpc.getTransactionLocation(originalHash, signal)
      if (location.status === 'pending') return
      if (location.status !== 'unknown' || original.root.status !== 'broadcast') {
        throw new EvmTransactionError(
          'stale-nonce',
          'The original EVM transaction is no longer pending'
        )
      }
      if ((await this.rpc.getPendingNonce(prepared.from, signal)) !== prepared.transaction.nonce) {
        throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
      }
      return
    }
    if (prepared.kind === 'speed-up') {
      const originalId = graph.root.relation?.transactionId
      const original = originalId ? await this.repository.get(graph.root.scope, originalId) : null
      const origin = original?.segments.find(segment => segment.role === 'origin')
      const originalHash = origin?.evidence?.transactionHash
      if (
        !original ||
        !originalHash ||
        (original.root.status !== 'broadcast' && original.root.status !== 'confirming') ||
        hasDestinationSettlementEvidence(original.segments) ||
        (origin.status !== 'broadcast' && origin.status !== 'confirming') ||
        origin.evidence?.replacementTransactionHash !== undefined ||
        (original.root.intent?.protocol !== undefined &&
          original.root.intent.protocol.expiresAt <= this.now()) ||
        !isEvmSpeedUpReplacement(original, graph) ||
        JSON.stringify(graph.root.intent?.evm?.unsignedTransaction) !==
          JSON.stringify(prepared.transaction)
      ) {
        throw new EvmTransactionError('stale-nonce', 'The original EVM transaction is unavailable')
      }
      await this.checkSpeedUpAllowed(original)
      await this.rpc.assertExpectedChain(signal)
      await assertEvmReplacementNonceAvailable(
        this.rpc,
        prepared.from,
        BigInt(prepared.transaction.nonce),
        signal
      )
      const location = await this.rpc.getTransactionLocation(originalHash, signal)
      if (location.status === 'pending') return
      if (location.status !== 'unknown' || original.root.status !== 'broadcast') {
        throw new EvmTransactionError(
          'stale-nonce',
          'The original EVM transaction is no longer pending'
        )
      }
      if ((await this.rpc.getPendingNonce(prepared.from, signal)) !== prepared.transaction.nonce) {
        throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
      }
      return
    }
    await assertEvmTransferFresh(prepared, this.rpc, signal)
    const preparedNonce = BigInt(prepared.transaction.nonce)
    const { active, expired } = await this.listUnexpiredPendingTransfers(
      prepared.chainId,
      prepared.from,
      pending.transactionId
    )
    if (expired.some(candidate => BigInt(candidate.prepared.transaction.nonce) < preparedNonce)) {
      throw new EvmTransactionError('stale-nonce', 'An earlier EVM review expired. Review again')
    }
    for (const candidate of active) {
      if (
        candidate.transactionId !== pending.transactionId &&
        candidate.phase !== 'signed' &&
        candidate.prepared.chainId === prepared.chainId &&
        candidate.prepared.from.toLowerCase() === prepared.from.toLowerCase() &&
        BigInt(candidate.prepared.transaction.nonce) < preparedNonce
      ) {
        throw new EvmTransactionError('stale-nonce', 'Approve the earlier EVM nonce first')
      }
    }
    await this.readLocalNonceFloor(
      pending.scope,
      prepared.chainId,
      prepared.from,
      signal,
      pending.transactionId
    )
  }

  private async checkSpeedUpAllowed(original: TransactionGraph): Promise<void> {
    if (original.root.intent?.shield && !this.assertSpeedUpAllowed) {
      throw new EvmTransactionError('stale-nonce', 'Confidential funding quote is unavailable')
    }
    await this.assertSpeedUpAllowed?.(original)
  }

  private async runSenderApprovalExclusive<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.senderApprovalTails.get(key) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.senderApprovalTails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.senderApprovalTails.get(key) === tail) this.senderApprovalTails.delete(key)
    }
  }

  async reject(input: ContinueEvmTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending EVM approval was not found')
    }
    const reviewGraph = await this.requireReviewGraph(pending)
    const graph = this.transitionReviewGraph(pending, reviewGraph, 'failed', undefined, {
      code: 'user-rejected',
      occurredAt: this.now()
    })
    await Promise.all([
      this.pendingStore.delete(transactionId),
      this.cancelPendingSigning(pending, input.signal).catch(() => {})
    ])
    return graph
  }

  async getExternalSigningRequest(
    input: ContinueEvmTransferInput
  ): Promise<EvmExternalSigningRequest | null> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (
      !pending ||
      !scopesMatch(pending.scope, scope) ||
      pending.phase !== 'awaiting-external-signature'
    ) {
      return null
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      return null
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, graph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending EVM transfer integrity check failed')
    }
    return Object.freeze({
      transactionId: pending.transactionId,
      scope: pending.scope,
      summary: pending.signingSummary,
      request: pending.signingExecution.request,
      ...(pending.externalSigner.vendor === 'ledger' ? { vendor: 'ledger' as const } : {}),
      ...(pending.externalSigner.vendor === 'ledger'
        ? {
            ledgerRequest: Object.freeze({
              kind: 'transaction' as const,
              derivationPath: pending.externalSigner.derivationPath,
              expectedAddress: pending.externalSigner.address,
              unsignedTransactionHex: serializePreparedEvmUnsignedTransaction(pending.prepared)
            })
          }
        : {}),
      payloadFingerprint: pending.payloadFingerprint,
      expiresAt: pending.expiresAt
    })
  }

  async submitExternalSignature(
    input: SubmitEvmExternalSignatureInput
  ): Promise<EvmTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (
      !pending ||
      !scopesMatch(pending.scope, scope) ||
      pending.phase !== 'awaiting-external-signature'
    ) {
      throw new Error('Pending external EVM signing request was not found')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('External EVM signature payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('EVM signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending EVM transfer integrity check failed')
    }
    await this.assertApprovalNonce(pending, currentGraph, input.signal)
    let signed: Awaited<ReturnType<typeof createKeystoneSignedEvmTransaction>>
    try {
      const signatureHex =
        pending.externalSigner.vendor === 'ledger'
          ? input.signatureCborBase64
          : (() => {
              const response = parseKeystoneEthereumSignatureCborBase64(input.signatureCborBase64)
              if (response.requestId !== pending.externalSigner.requestId) {
                throw new Error('Keystone EVM signature request ID does not match')
              }
              return response.signatureHex
            })()
      signed = await createKeystoneSignedEvmTransaction(pending.prepared, signatureHex)
    } catch (error) {
      await this.failConsumedSigning(pending)
      throw error
    }
    const signedPending: SignedPendingEvmTransfer = Object.freeze({
      schemaVersion: 2,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      rawTransaction: signed.rawTransaction,
      transactionHash: signed.transactionHash,
      signedAt: this.timestamp()
    })
    let signedGraph: TransactionGraph
    try {
      signedGraph = this.transitionReviewGraph(pending, currentGraph, 'signed', {
        transactionHash: signedPending.transactionHash,
        externalReference: `evm-nonce:${pending.prepared.transaction.nonce}`
      })
      await this.pendingStore.put(signedPending, signedGraph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed EVM transaction could not be persisted')
    }
    const graph = await this.persistSignedGraph(signedPending, signedGraph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async resumeBroadcast(input: ContinueEvmTransferInput): Promise<EvmTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
      throw new Error('Signed EVM transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  private async broadcast(
    pending: SignedPendingEvmTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<EvmTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    let accepted = false
    try {
      await broadcastSignedEvmTransaction({
        rawTransaction: pending.rawTransaction,
        expectedTransactionHash: pending.transactionHash,
        rpc: this.rpc,
        signal
      })
      accepted = true
    } catch {
      accepted = await this.rpc.hasTransaction(pending.transactionHash, signal).catch(() => false)
    }
    if (!accepted) {
      await Promise.resolve(this.onPendingBroadcast?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    const graph = await this.applyStatus(pending, 'broadcast', {
      transactionHash: pending.transactionHash
    })
    await this.pendingStore.delete(pending.transactionId)
    if (graph.root.kind === 'cancel' && graph.root.relation?.kind === 'replacement-of') {
      await this.markOriginalReplacementBroadcast(graph, pending.transactionHash).catch(() => {})
    }
    await Promise.all([
      Promise.resolve(this.onBroadcastAccepted?.(graph, currentGraph === undefined)).catch(
        () => {}
      ),
      Promise.resolve(this.onMonitoringRequired?.()).catch(() => {})
    ])
    return Object.freeze({ status: 'broadcast', graph })
  }

  private async markOriginalReplacementBroadcast(
    cancellation: TransactionGraph,
    replacementTransactionHash: string
  ): Promise<void> {
    const relation = cancellation.root.relation
    if (relation?.kind !== 'replacement-of') return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const original = await this.repository.get(cancellation.root.scope, relation.transactionId)
      const segment = original?.segments.find(candidate => candidate.role === 'origin')
      if (
        !original ||
        !segment ||
        original.root.status === 'final' ||
        original.root.status === 'failed'
      ) {
        return
      }
      const observedAt = this.now()
      const result = await this.repository.applySegmentEvent({
        scope: original.root.scope,
        transactionId: original.root.id,
        segmentId: segment.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:evm:${this.createId()}`),
          status: segment.status,
          cause: 'progress' as const,
          observedAt,
          evidence: Object.freeze({
            ...(segment.evidence?.transactionHash === undefined
              ? {}
              : { transactionHash: segment.evidence.transactionHash }),
            ...(segment.evidence?.externalReference === undefined
              ? {}
              : { externalReference: segment.evidence.externalReference }),
            replacementTransactionHash
          })
        }),
        expectedRootRevision: original.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status !== 'revision-conflict') return
    }
    throw new Error('EVM cancellation replacement link could not be persisted')
  }

  private async failAwaitingApproval(
    pending: PendingEvmSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.all([
      this.pendingStore.delete(pending.transactionId),
      this.cancelPendingSigning(pending, signal).catch(() => {})
    ])
  }

  private async cancelAwaitingApprovals(
    matches: (pending: PendingEvmSigningTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (candidate): candidate is PendingEvmSigningTransfer =>
        candidate.phase !== 'signed' && matches(candidate)
    )
    for (const candidate of pending) {
      try {
        await this.cancelPendingSigning(candidate, signal)
      } catch (error) {
        if (!isUnrecoverableSigningError(error)) throw error
      }
      await this.pendingStore.delete(candidate.transactionId)
    }
    return pending.length
  }

  private async failConsumedSigning(pending: PendingEvmSigningTransfer): Promise<void> {
    await this.pendingStore.delete(pending.transactionId)
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingEvmTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          candidate.target.chainId.startsWith('eip155:')
      )
      if (
        (graph?.root.kind === 'transfer' ||
          graph?.root.kind === 'contract-call' ||
          graph?.root.kind === 'swap' ||
          graph?.root.kind === 'supply') &&
        segment?.target.kind === 'onchain' &&
        segment.target.chainId.startsWith('eip155:')
      ) {
        const occurredAt = this.now()
        await this.applyStatus(
          { scope, transactionId, segmentId: segment.id },
          'failed',
          undefined,
          { code: 'integrity-failure', occurredAt },
          occurredAt
        ).catch(() => {})
      }
      throw new Error('Pending EVM transfer integrity check failed')
    }
  }

  private pendingMatchesGraph(
    pending: PendingEvmSigningTransfer,
    graph: TransactionGraph
  ): boolean {
    const intent = graph.root.intent
    if (pending.prepared.kind === 'speed-up') {
      const transaction = pending.prepared.transaction
      const evidence = intent?.evm?.unsignedTransaction
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      return (
        graph.root.id === pending.transactionId &&
        scopesMatch(graph.root.scope, pending.scope) &&
        (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
        graph.root.relation?.kind === 'replacement-of' &&
        graph.root.relation.transactionId !== graph.root.id &&
        intent?.sender?.chainId === pending.prepared.chainId &&
        intent.sender.address.toLowerCase() === pending.prepared.from.toLowerCase() &&
        evidence !== undefined &&
        JSON.stringify(evidence) === JSON.stringify(transaction) &&
        intent.feeLimit?.amountRaw ===
          (
            BigInt(transaction.gasLimit) *
            BigInt(transaction.type === 'legacy' ? transaction.gasPrice : transaction.maxFeePerGas)
          ).toString() &&
        graph.segments.length === 1 &&
        segment?.role === 'origin' &&
        segment.target.kind === 'onchain' &&
        segment.target.chainId === pending.prepared.chainId &&
        (segment.status === 'prepared' || segment.status === 'approved')
      )
    }
    const rheaBinding =
      intent?.protocol?.provider === 'rhea-cross-chain-dex' ? intent.protocol : undefined
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const maximumFee = (
      BigInt(pending.prepared.transaction.gasLimit) *
      BigInt(
        pending.prepared.transaction.type === 'legacy'
          ? pending.prepared.transaction.gasPrice
          : pending.prepared.transaction.maxFeePerGas
      )
    ).toString()
    const contractCall = classifyEvmContractCall(pending.prepared)
    const isContractCall = contractCall !== null
    const isCancel =
      graph.root.kind === 'cancel' &&
      (pending.prepared.kind === 'cancel' || pending.prepared.kind === 'nonce-recovery')
    const primaryAmountMatches = rheaBinding
      ? intent?.primaryAmount?.assetId === rheaBinding.origin.assetId &&
        intent.primaryAmount.amountRaw === rheaBinding.originAmountRaw
      : (isContractCall || isCancel) && pending.prepared.amountRaw === '0'
        ? intent?.primaryAmount === undefined
        : intent?.primaryAmount?.assetId === pending.prepared.assetId &&
          intent.primaryAmount.amountRaw === pending.prepared.amountRaw
    const protocolMatchesPrepared =
      rheaBinding === undefined ||
      (rheaBinding.origin.chainId === pending.prepared.chainId &&
        rheaBinding.sender === pending.prepared.from &&
        rheaBinding.sourceTarget === pending.prepared.recipient)
    return (
      graph.root.id === pending.transactionId &&
      scopesMatch(graph.root.scope, pending.scope) &&
      (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
      (isCancel
        ? graph.root.kind === 'cancel'
        : isContractCall
          ? graph.root.kind ===
            (rheaBinding?.userAction ?? (rheaBinding ? 'swap' : contractCall.kind))
          : graph.root.kind === 'transfer' ||
            graph.root.kind === 'swap' ||
            graph.root.kind === 'supply') &&
      intent?.schemaVersion === 1 &&
      intent.direction ===
        (isCancel
          ? 'self'
          : isContractCall
            ? 'contract'
            : pending.prepared.from.toLowerCase() === pending.prepared.recipient.toLowerCase()
              ? 'self'
              : 'outgoing') &&
      primaryAmountMatches &&
      protocolMatchesPrepared &&
      intent.feeLimit?.amountRaw === maximumFee &&
      intent.sender?.chainId === pending.prepared.chainId &&
      intent.sender.address === pending.prepared.from &&
      intent.recipient?.chainId === pending.prepared.chainId &&
      intent.recipient.address === pending.prepared.recipient &&
      (!isCancel ||
        (pending.prepared.kind === 'nonce-recovery'
          ? graph.root.relation === undefined
          : graph.root.relation?.kind === 'replacement-of' &&
            graph.root.relation.transactionId !== graph.root.id)) &&
      segment?.target.kind === 'onchain' &&
      segment.target.chainId === pending.prepared.chainId &&
      (segment.status === 'prepared' || segment.status === 'approved')
    )
  }

  private async pendingIntegrityMatchesGraph(
    pending: PendingEvmSigningTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    try {
      await assertEvmSigningSummaryMatchesPrepared(pending.prepared, pending.signingSummary)
      return (
        (await computeEvmSigningPayloadFingerprint(pending.prepared.transaction)) ===
          pending.payloadFingerprint &&
        (pending.signingExecution.kind === 'internal' || pending.externalSigner !== null) &&
        this.pendingMatchesGraph(pending, graph)
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(pending: PendingEvmTransfer): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending EVM review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalEvmTransfer, 'transactionId' | 'segmentId'>,
    graph: TransactionGraph,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.now()
  ): TransactionGraph {
    return transitionPendingTransactionGraph({
      reference: pending,
      graph,
      status,
      eventId: `event:evm:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'EVM'
    })
  }

  private async persistSignedGraph(
    pending: SignedPendingEvmTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      label: 'EVM'
    })
  }

  private async requireGraph(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    segmentId: AwaitingApprovalEvmTransfer['segmentId']
  ): Promise<TransactionGraph> {
    const graph = await this.repository.get(scope, transactionId)
    if (!graph || !graph.segments.some(segment => segment.id === segmentId)) {
      throw new Error('Persisted EVM transaction graph was not found')
    }
    return graph
  }

  private async applyStatus(
    pending: Pick<AwaitingApprovalEvmTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.now()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:evm:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending.scope, pending.transactionId, pending.segmentId)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted EVM transaction segment was not found')
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
      throw new Error(`EVM transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('EVM transaction lifecycle update conflicted twice')
  }

  private cancelPreparedSigning(
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    signing: PreparedSigningCommand,
    signal?: AbortSignal
  ): Promise<void> {
    return signing.execution.kind === 'external'
      ? Promise.resolve()
      : this.cancelInternalSigning(keyDomainId, signing.commandId, signal)
  }

  private cancelPendingSigning(
    pending: PendingEvmSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    return pending.signingExecution.kind === 'external'
      ? Promise.resolve()
      : this.cancelInternalSigning(pending.scope.keyDomainId, pending.signingCommandId, signal)
  }

  private async cancelInternalSigning(
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
      throw new Error('Invalid EVM transfer timestamp')
    }
    return value
  }
}
