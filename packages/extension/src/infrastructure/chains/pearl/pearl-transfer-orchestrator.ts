type LedgerPearlSigningRequest = never
import { KeyringError } from '@/core/keyring/ports'
import { Buffer } from 'buffer'
import type { ChainAccount } from '@/core/accounts/domain'
import { parseAccountId } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import { parseKeyDomainId, type SigningSummary } from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import {
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegmentEvent,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type {
  NearIntentsTransactionBinding,
  RheaSwapTransactionBinding
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'
import type { PearlChangeReservationCoordinator } from './pearl-change-reservation-coordinator'
import {
  parsePearlChangeReservation,
  type PearlChangeReservation
} from './pearl-change-reservation-model'
import {
  parsePearlInputOutpoints,
  parsePearlInputReservation,
  type PearlInputOutpoint,
  type PearlInputReservation,
  type PearlInputReservationRepository
} from './pearl-input-reservation-model'
import {
  pearlChainAccountsMatch,
  parseScope as parsePearlDiscoveryScope
} from './pearl-discovery-persistence-model'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import {
  type AwaitingApprovalPearlTransfer,
  type AwaitingExternalSignaturePearlTransfer,
  type PearlPendingTransferStore,
  type PendingPearlTransfer,
  type PendingPearlSigningTransfer,
  type SignedPendingPearlTransfer,
  type SigningPearlTransfer
} from './pearl-pending-transfer-store'
import {
  assertPearlTransferRejectable,
  isPearlSigningInterrupted,
  PEARL_INTERRUPTED_SIGNING_GRACE_MS,
  startsPearlSigning
} from './pearl-pending-transfer-lifecycle'
import { finalizePearlPsbt } from './pearl-psbt-finalizer'
import { parsePreparedPearlPsbt } from './pearl-prepared-psbt-validator'
import {
  assertPearlSigningSummaryMatchesPrepared,
  computePearlSigningPayloadFingerprint,
  createPearlSigningSummary,
  createPearlSigningPreparePayload,
  KEYSTONE_PEARL_SIGNING_TTL_MS,
  normalizePearlSigningSummary,
  type PearlSigningPreparePayload
} from './pearl-signing-summary-validator'
import { createPearlTransferGraph } from './pearl-transaction-graph'
import { parsePearlAddress, type PreparedPearlPsbt } from './pearl-transaction-model'
import {
  broadcastSignedPearlTransaction,
  parsePearlFinalityConfirmations,
  type PearlMonitorRpc
} from './pearl-transaction-observer'

export interface PearlTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: PearlSigningPreparePayload,
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
  ) => Promise<boolean | void>
}

export interface PearlTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: PearlPendingTransferStore
  readonly signer: PearlTransferSigningPort
  readonly rpc: Pick<PearlMonitorRpc, 'broadcastRawTransaction' | 'getTransactionStatus'>
  readonly assets: AssetRegistry
  readonly changeReservations: Pick<PearlChangeReservationCoordinator, 'commit' | 'abandon'>
  readonly inputReservations: Pick<PearlInputReservationRepository, 'commit' | 'release' | 'list'>
  readonly now?: () => number
  readonly createId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  readonly onBroadcastAccepted?: (
    input: {
      readonly scope: TransactionAccountScope
      readonly transactionId: string
      readonly rawTransactionHex: string
      readonly spentOutpoints: readonly PearlInputOutpoint[]
      readonly graph: TransactionGraph
    },
    recovered: boolean
  ) => Promise<void> | void
  readonly onMonitoringRequired?: () => Promise<void> | void
}

export interface PreparePearlTransferInput {
  readonly chainAccount: ChainAccount
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly prepared: PreparedPearlPsbt
  readonly signerAddress: string
  readonly changeReservation: PearlChangeReservation | null
  readonly inputReservation: PearlInputReservation
  readonly requiredConfirmations: number
  readonly signingMode?: 'internal' | 'keystone' | 'ledger'
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
  readonly rheaSwapBinding?: RheaSwapTransactionBinding
  readonly signal?: AbortSignal
}

export interface PreparedPearlTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinuePearlTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApprovePearlTransferInput extends ContinuePearlTransferInput {
  readonly payloadFingerprint: string
}

export interface PearlTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface PearlExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type PearlTransferApprovalResult = PearlTransferSubmission | PearlExternalSignatureRequired

export interface PearlPendingRecoveryResult {
  readonly resumedBroadcasts: number
  readonly reconciledSignings: number
}

export interface PearlExternalSigningRequest {
  readonly vendor?: 'keystone' | 'ledger'
  readonly ledgerRequest?: LedgerPearlSigningRequest
  readonly transactionId: TransactionId
  readonly scope: TransactionAccountScope
  readonly chainId: string
  readonly summary: SigningSummary
  readonly request: Extract<
    PreparedSigningCommand['execution'],
    { readonly kind: 'external' }
  >['request']
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface SubmitPearlExternalSignatureInput extends ContinuePearlTransferInput {
  readonly payloadFingerprint: string
  readonly signedPsbtBase64: string
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

function normalizeChangeReservation(
  value: PearlChangeReservation | null,
  transactionId: TransactionId,
  chainAccount: ChainAccount,
  prepared: PreparedPearlPsbt,
  signerAddress: string
): PearlChangeReservation | null {
  if (value === null) {
    if (prepared.changeAddress !== null && prepared.changeAddress !== signerAddress) {
      throw new Error('Prepared Pearl change output requires a reservation')
    }
    return null
  }
  const reservation = parsePearlChangeReservation(value, undefined, transactionId)
  if (
    reservation.state !== 'reserved' ||
    reservation.address === null ||
    prepared.changeAddress === null ||
    !pearlChainAccountsMatch(reservation.chainAccount, chainAccount) ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressScheme !== prepared.addressScheme ||
    reservation.address.address !== prepared.changeAddress
  ) {
    throw new Error('Pearl change reservation does not match the prepared transfer')
  }
  return reservation
}

function normalizeInputReservation(
  value: PearlInputReservation,
  transactionId: TransactionId,
  chainAccount: ChainAccount,
  prepared: PreparedPearlPsbt
): PearlInputReservation {
  const reservation = parsePearlInputReservation(value, undefined, transactionId)
  const parsedPrepared = parsePreparedPearlPsbt(prepared)
  const expectedOutpoints = parsePearlInputOutpoints(
    parsedPrepared.psbt.txInputs.map(input => ({
      transactionId: Buffer.from(input.hash).reverse().toString('hex'),
      outputIndex: input.index
    }))
  )
  if (
    reservation.state !== 'reserved' ||
    !pearlChainAccountsMatch(reservation.chainAccount, chainAccount) ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressScheme !== prepared.addressScheme ||
    JSON.stringify(reservation.outpoints) !== JSON.stringify(expectedOutpoints)
  ) {
    throw new Error('Pearl input reservation does not match the prepared transfer')
  }
  return reservation
}

export class PearlTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: PearlPendingTransferStore
  private readonly signer: PearlTransferSigningPort
  private readonly rpc: Pick<PearlMonitorRpc, 'broadcastRawTransaction' | 'getTransactionStatus'>
  private readonly assets: AssetRegistry
  private readonly changeReservations: Pick<PearlChangeReservationCoordinator, 'commit' | 'abandon'>
  private readonly inputReservations: Pick<
    PearlInputReservationRepository,
    'commit' | 'release' | 'list'
  >
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly onBroadcastAccepted?: PearlTransferOrchestratorOptions['onBroadcastAccepted']
  private readonly onMonitoringRequired?: () => Promise<void> | void
  private readonly transactionLocks = new Map<string, SerialTaskQueue>()
  private recoveryGate: DedupPromise<PearlPendingRecoveryResult> | null = null

  constructor(options: PearlTransferOrchestratorOptions) {
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.signer = options.signer
    this.rpc = options.rpc
    this.assets = options.assets
    this.changeReservations = options.changeReservations
    this.inputReservations = options.inputReservations
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.onPendingBroadcast = options.onPendingBroadcast
    this.onBroadcastAccepted = options.onBroadcastAccepted
    this.onMonitoringRequired = options.onMonitoringRequired
  }

  /**
   * Releases reserved inputs whose pending review was lost (session clear / cleanup)
   * without abandoning the IndexedDB reservation. Committed spends stay reserved until
   * discovery retires them.
   */
  async releaseOrphanedInputReservations(input: {
    readonly chainAccount: ChainAccount
    readonly accountIndex: number
    readonly addressScheme?: 'pearl_p2tr'
  }): Promise<number> {
    const scope = parsePearlDiscoveryScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex
    })
    const addressScheme = input.addressScheme ?? 'pearl_p2tr'
    const reservationScope = Object.freeze({
      chainAccount: scope.chainAccount,
      accountIndex: scope.accountIndex,
      addressScheme
    })
    const pendingIds = new Set(
      (await this.pendingStore.list())
        .filter(candidate => scopesMatch(candidate.scope, scope.chainAccount.scope))
        .map(candidate => candidate.transactionId)
    )
    const reservations = await this.inputReservations.list(reservationScope)
    let released = 0
    for (const reservation of reservations) {
      if (reservation.state !== 'reserved') continue
      if (pendingIds.has(reservation.transactionId)) continue
      await this.inputReservations.release(reservationScope, reservation.transactionId)
      released += 1
    }
    return released
  }

  async prepare(input: PreparePearlTransferInput): Promise<PreparedPearlTransferApproval> {
    const transactionId = parseTransactionId(input.transactionId)
    const segmentId = parseTransactionSegmentId(input.segmentId)
    const requiredConfirmations = parsePearlFinalityConfirmations(input.requiredConfirmations)
    const discoveryScope = parsePearlDiscoveryScope({
      chainAccount: input.chainAccount,
      accountIndex: input.prepared.accountIndex
    })
    if (discoveryScope.chainAccount.scope.chainId !== input.prepared.chainId) {
      throw new Error('Pearl ChainAccount does not match the prepared transfer')
    }
    const scope = normalizeScope(discoveryScope.chainAccount.scope)
    const signerAddress = parsePearlAddress(input.signerAddress, input.prepared.chainId)
    const changeReservation = normalizeChangeReservation(
      input.changeReservation,
      transactionId,
      discoveryScope.chainAccount,
      input.prepared,
      signerAddress
    )
    const inputReservation = normalizeInputReservation(
      input.inputReservation,
      transactionId,
      discoveryScope.chainAccount,
      input.prepared
    )
    const createdAt = this.timestamp()
    if (input.nearIntentsBinding && input.rheaSwapBinding) {
      throw new Error('Pearl transfer cannot bind multiple swap protocols')
    }
    const protocol = input.nearIntentsBinding ?? input.rheaSwapBinding
    const protocolBinding = protocol
      ? Object.freeze({
          binding: protocol,
          segmentIds: Object.freeze({
            relay: parseTransactionSegmentId(`${segmentId}:relay`),
            destination: parseTransactionSegmentId(`${segmentId}:destination`),
            refund: parseTransactionSegmentId(`${segmentId}:refund`)
          })
        })
      : undefined
    const graph = createPearlTransferGraph({
      prepared: input.prepared,
      sender: signerAddress,
      scope,
      transactionId,
      segmentId,
      assets: this.assets,
      requiredConfirmations,
      createdAt,
      chainAccountId: discoveryScope.chainAccount.id,
      ...(protocolBinding === undefined ? {} : { protocol: protocolBinding })
    })

    let signing: PreparedSigningCommand | undefined
    try {
      const expectedFingerprint = await computePearlSigningPayloadFingerprint(input.prepared)
      signing =
        input.signingMode === 'keystone' || input.signingMode === 'ledger'
          ? Object.freeze({
              commandId: parseSigningCommandId(
                `signing-command:${input.signingMode}-pearl:${this.createId()}`
              ),
              chainId: input.prepared.chainId,
              operation: 'transaction' as const,
              summary: createPearlSigningSummary(input.prepared, signerAddress),
              payloadFingerprint: Object.freeze({
                algorithm: 'sha256' as const,
                digestHex: expectedFingerprint
              }),
              execution: Object.freeze({
                kind: 'external' as const,
                request: Object.freeze({
                  encoding: 'base64' as const,
                  value: input.prepared.psbtBase64
                })
              }),
              expiresAt: createdAt + KEYSTONE_PEARL_SIGNING_TTL_MS
            })
          : await this.signer.prepare(
              scope.keyDomainId,
              createPearlSigningPreparePayload(input.prepared),
              input.signal
            )
      signing = Object.freeze({
        ...signing,
        summary: normalizePearlSigningSummary(input.prepared, signing.summary, signerAddress)
      })
      if (
        signing.summary.review.level === 'blocked' ||
        signing.expiresAt <= this.timestamp() ||
        signing.payloadFingerprint.digestHex !== expectedFingerprint
      ) {
        throw new Error('Pearl signing request cannot be approved')
      }
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(signing === undefined
          ? []
          : [this.cancelPreparedSigning(scope.keyDomainId, signing, input.signal)]),
        this.abandonReservation(changeReservation),
        this.releaseInputs(inputReservation)
      ])
      if (cleanup.some(result => result.status === 'rejected')) {
        throw new Error('Pearl signing preparation cleanup failed')
      }
      throw error
    }
    if (signing === undefined) {
      throw new Error('Pearl signing request was not prepared')
    }

    const pending: AwaitingApprovalPearlTransfer = Object.freeze({
      schemaVersion: 3,
      phase: 'awaiting-approval',
      transactionId,
      segmentId,
      scope,
      requiredConfirmations,
      changeReservation,
      inputReservation,
      prepared: input.prepared,
      signer: signerAddress,
      signingSummary: signing.summary,
      signingCommandId: signing.commandId,
      signingExecution: signing.execution,
      payloadFingerprint: signing.payloadFingerprint.digestHex,
      expiresAt: signing.expiresAt
    })

    try {
      await this.pendingStore.put(pending, graph)
      return Object.freeze({ graph, signing })
    } catch (error) {
      const results = await Promise.allSettled([
        this.pendingStore.delete(transactionId),
        this.cancelPreparedSigning(scope.keyDomainId, signing, input.signal),
        this.abandonReservation(changeReservation),
        this.releaseInputs(inputReservation)
      ])
      if (results.some(result => result.status === 'rejected')) {
        throw new Error('Pearl transfer preparation cleanup failed')
      }
      throw error
    }
  }

  async getPendingApproval(
    input: ContinuePearlTransferInput
  ): Promise<PreparedPearlTransferApproval | null> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'awaiting-approval') {
      return null
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      return null
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, graph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Pearl transfer integrity check failed')
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

  async cancelExpiredApprovalsForScope(
    scopeValue: TransactionAccountScope,
    signal?: AbortSignal
  ): Promise<number> {
    const scope = normalizeScope(scopeValue)
    const now = this.timestamp()
    const pending = (await this.pendingStore.list()).filter(
      (
        candidate
      ): candidate is AwaitingApprovalPearlTransfer | AwaitingExternalSignaturePearlTransfer =>
        (candidate.phase === 'awaiting-approval' ||
          candidate.phase === 'awaiting-external-signature') &&
        scopesMatch(candidate.scope, scope) &&
        now >= candidate.expiresAt
    )
    for (const candidate of pending) {
      await this.failAwaitingApproval(candidate, signal)
    }
    return pending.length
  }

  clearPendingTransfers(): Promise<number> {
    return this.pendingStore.clear()
  }

  cancelAllAwaitingApprovals(signal?: AbortSignal): Promise<number> {
    return this.cancelAwaitingApprovals(() => true, signal)
  }

  async approve(input: ApprovePearlTransferInput): Promise<PearlTransferApprovalResult> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    return this.withTransactionLock(transactionId, () =>
      this.approveLocked(input, scope, transactionId)
    )
  }

  private async approveLocked(
    input: ApprovePearlTransferInput,
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PearlTransferApprovalResult> {
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending Pearl transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('Pearl transfer is already signed; resume its broadcast instead')
    }
    if (pending.phase === 'awaiting-external-signature') {
      throw new Error('Pearl transfer is already awaiting an external signature')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('Pearl approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      if (pending.phase === 'signing') {
        await this.reconcileInterruptedSigning(pending)
        throw new Error('Pearl signing request expired')
      }
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pearl signing request expired')
    }

    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Pearl transfer integrity check failed')
    }
    const rheaBinding = currentGraph.root.intent?.protocol
    if (
      rheaBinding?.provider === 'rhea-cross-chain-dex' &&
      rheaBinding.expiresAt <= this.timestamp()
    ) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('RHEA Swap quote expired')
    }
    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')

    if (pending.signingExecution.kind === 'external') {
      const externalPending: AwaitingExternalSignaturePearlTransfer = Object.freeze({
        ...pending,
        phase: 'awaiting-external-signature',
        signingExecution: pending.signingExecution
      })
      try {
        await this.pendingStore.put(externalPending, graph)
      } catch {
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('External Pearl signing request could not be persisted')
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
      if (pending.phase === 'awaiting-approval') {
        await this.pendingStore.put(startsPearlSigning(pending, this.timestamp()), graph)
      }
    } catch {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Approved Pearl signing request could not be persisted')
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
        // The Worker never produced a signature, so the reservations stay safe to release.
        await this.failConsumedSigning(pending)
        throw error
      }
      // Keep the signing claim: a lost response may still have produced a signature.
      throw new Error('Pearl signing outcome is unknown; retry to reconcile the transfer')
    }

    let finalized: ReturnType<typeof finalizePearlPsbt>
    try {
      if (
        signed.kind !== 'signed-payload' ||
        signed.payload.encoding !== 'base64' ||
        signed.transactionId !== pending.prepared.unsignedTransactionId
      ) {
        throw new Error('WASM did not return the prepared signed Pearl PSBT')
      }
      finalized = finalizePearlPsbt({
        prepared: pending.prepared,
        signedPsbtBase64: signed.payload.value
      })
      if (finalized.transactionId !== signed.transactionId) {
        throw new Error('Signed Pearl transaction ID does not match the prepared PSBT')
      }
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Pearl transaction failed integrity validation')
    }

    const signedPending: SignedPendingPearlTransfer = Object.freeze({
      schemaVersion: 3,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      requiredConfirmations: pending.requiredConfirmations,
      changeReservation: pending.changeReservation,
      inputReservation: pending.inputReservation,
      rawTransactionHex: finalized.rawTransactionHex,
      transactionHash: finalized.transactionId,
      signedAt: this.timestamp()
    })
    try {
      graph = this.transitionReviewGraph(pending, graph, 'signed', {
        transactionHash: signedPending.transactionHash,
        requiredConfirmations: signedPending.requiredConfirmations
      })
      await this.pendingStore.put(signedPending, graph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Pearl transaction could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async getExternalSigningRequest(
    input: ContinuePearlTransferInput
  ): Promise<PearlExternalSigningRequest | null> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    return this.withTransactionLock(transactionId, () =>
      this.getExternalSigningRequestLocked(scope, transactionId, input.signal)
    )
  }

  private async getExternalSigningRequestLocked(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    signal?: AbortSignal
  ): Promise<PearlExternalSigningRequest | null> {
    const pending = await this.readPending(scope, transactionId)
    if (
      !pending ||
      !scopesMatch(pending.scope, scope) ||
      pending.phase !== 'awaiting-external-signature'
    ) {
      return null
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, signal)
      return null
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, graph))) {
      await this.failAwaitingApproval(pending, signal)
      throw new Error('Pending Pearl transfer integrity check failed')
    }
    return Object.freeze({
      transactionId: pending.transactionId,
      scope: pending.scope,
      chainId: pending.prepared.chainId,
      summary: pending.signingSummary,
      request: pending.signingExecution.request,
      ...(pending.signingCommandId.startsWith('signing-command:ledger-pearl:')
        ? { vendor: 'ledger' as const }
        : {}),
      payloadFingerprint: pending.payloadFingerprint,
      expiresAt: pending.expiresAt
    })
  }

  async submitExternalSignature(
    input: SubmitPearlExternalSignatureInput
  ): Promise<PearlTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    return this.withTransactionLock(transactionId, async () => {
      const pending = await this.readPending(scope, transactionId)
      if (
        !pending ||
        !scopesMatch(pending.scope, scope) ||
        (pending.phase !== 'awaiting-external-signature' && pending.phase !== 'signing')
      ) {
        throw new Error('Pending external Pearl signing request was not found')
      }
      if (
        !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
        input.payloadFingerprint !== pending.payloadFingerprint
      ) {
        throw new Error('External Pearl signature payload fingerprint does not match')
      }
      if (this.timestamp() >= pending.expiresAt) {
        if (pending.phase === 'signing') {
          await this.reconcileInterruptedSigning(pending)
          throw new Error('Pearl signing request expired')
        }
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('Pearl signing request expired')
      }
      const currentGraph = await this.requireReviewGraph(pending)
      if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('Pending Pearl transfer integrity check failed')
      }
      if (pending.phase === 'awaiting-external-signature') {
        try {
          await this.pendingStore.put(startsPearlSigning(pending, this.timestamp()), currentGraph)
        } catch {
          await this.failAwaitingApproval(pending, input.signal)
          throw new Error('External Pearl signature claim could not be persisted')
        }
      }
      let finalized: ReturnType<typeof finalizePearlPsbt>
      try {
        finalized = finalizePearlPsbt({
          prepared: pending.prepared,
          signedPsbtBase64: input.signedPsbtBase64
        })
      } catch {
        await this.failConsumedSigning(pending)
        throw new Error('Signed Pearl transaction failed integrity validation')
      }
      const signedPending: SignedPendingPearlTransfer = Object.freeze({
        schemaVersion: 3,
        phase: 'signed',
        transactionId: pending.transactionId,
        segmentId: pending.segmentId,
        scope: pending.scope,
        requiredConfirmations: pending.requiredConfirmations,
        changeReservation: pending.changeReservation,
        inputReservation: pending.inputReservation,
        rawTransactionHex: finalized.rawTransactionHex,
        transactionHash: finalized.transactionId,
        signedAt: this.timestamp()
      })
      let signedGraph: TransactionGraph
      try {
        signedGraph = this.transitionReviewGraph(pending, currentGraph, 'signed', {
          transactionHash: signedPending.transactionHash,
          requiredConfirmations: signedPending.requiredConfirmations
        })
        await this.pendingStore.put(signedPending, signedGraph)
      } catch {
        await this.failConsumedSigning(pending)
        throw new Error('Signed Pearl transaction could not be persisted')
      }
      const graph = await this.persistSignedGraph(signedPending, signedGraph)
      return this.broadcast(signedPending, input.signal, graph)
    })
  }

  async reject(input: ContinuePearlTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    return this.withTransactionLock(transactionId, () =>
      this.rejectLocked(scope, transactionId, input.signal)
    )
  }

  private async rejectLocked(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    signal?: AbortSignal
  ): Promise<TransactionGraph> {
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending Pearl approval was not found')
    }
    assertPearlTransferRejectable(pending)
    const reviewGraph = await this.requireReviewGraph(pending)
    const graph = this.transitionReviewGraph(pending, reviewGraph, 'failed', undefined, {
      code: 'user-rejected',
      occurredAt: this.timestamp()
    })
    await this.cancelPendingSigning(pending, signal)
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(transactionId)
    return graph
  }

  async resumeBroadcast(input: ContinuePearlTransferInput): Promise<PearlTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    return this.withTransactionLock(transactionId, async () => {
      const pending = await this.readPending(scope, transactionId)
      if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
        throw new Error('Signed Pearl transfer was not found')
      }
      return this.broadcast(pending, input.signal)
    })
  }

  private async broadcast(
    pending: SignedPendingPearlTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<PearlTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    let accepted = false
    try {
      await broadcastSignedPearlTransaction({
        rawTransactionHex: pending.rawTransactionHex,
        expectedTransactionId: pending.transactionHash,
        rpc: this.rpc,
        signal
      })
      accepted = true
    } catch {
      accepted = await this.rpc
        .getTransactionStatus(pending.transactionHash, signal)
        .then(() => true)
        .catch(() => false)
    }
    if (!accepted) {
      await Promise.resolve(this.onPendingBroadcast?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }

    const graph = await this.applyStatus(pending, 'broadcast', {
      transactionHash: pending.transactionHash,
      confirmations: 0,
      requiredConfirmations: pending.requiredConfirmations
    })
    try {
      await Promise.all([
        this.commitReservation(pending.changeReservation),
        this.commitInputs(pending.inputReservation)
      ])
      await this.pendingStore.delete(pending.transactionId)
    } catch {
      // Keep the signed record so the recovery sweep can finish the commit.
      await Promise.resolve(this.onMonitoringRequired?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast' as const, graph })
    }
    await Promise.all([
      Promise.resolve(
        this.onBroadcastAccepted?.(
          {
            scope: pending.scope,
            transactionId: pending.transactionHash,
            rawTransactionHex: pending.rawTransactionHex,
            spentOutpoints: pending.inputReservation.outpoints,
            graph
          },
          currentGraph === undefined
        )
      ).catch(() => {}),
      Promise.resolve(this.onMonitoringRequired?.()).catch(() => {})
    ])
    return Object.freeze({ status: 'broadcast', graph })
  }

  private async failAwaitingApproval(
    pending: PendingPearlSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await this.cancelPendingSigning(pending, signal)
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(pending.transactionId)
  }

  private async cancelAwaitingApprovals(
    matches: (pending: PendingPearlTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (
        candidate
      ): candidate is AwaitingApprovalPearlTransfer | AwaitingExternalSignaturePearlTransfer =>
        (candidate.phase === 'awaiting-approval' ||
          candidate.phase === 'awaiting-external-signature') &&
        matches(candidate)
    )
    for (const candidate of pending) {
      await this.withTransactionLock(candidate.transactionId, async () => {
        const current = await this.pendingStore.get(candidate.transactionId).catch(() => null)
        // A concurrent approval may have started signing; its claim owns the cleanup.
        if (
          !current ||
          (current.phase !== 'awaiting-approval' && current.phase !== 'awaiting-external-signature')
        ) {
          return
        }
        await this.cancelPendingSigning(current, signal)
        await this.abandonReservation(current.changeReservation)
        await this.releaseInputs(current.inputReservation)
        await this.pendingStore.delete(current.transactionId)
      })
    }
    return pending.length
  }

  private async failConsumedSigning(pending: PendingPearlSigningTransfer): Promise<void> {
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(pending.transactionId)
  }

  /**
   * Resolves a signing claim whose outcome is unknown after a lost response or
   * a Worker restart. A transaction that already reached the chain keeps its
   * reservations; otherwise the signature never left the wallet.
   */
  private async reconcileInterruptedSigning(pending: SigningPearlTransfer): Promise<void> {
    const transactionHash = pending.prepared.unsignedTransactionId
    const confirmedOnChain = await this.rpc
      .getTransactionStatus(transactionHash)
      .then(() => true)
      .catch(() => false)
    if (!confirmedOnChain) {
      await this.failConsumedSigning(pending)
      return
    }
    const graph = await this.requireReviewGraph(pending).catch(() => null)
    if (graph) {
      await this.applyStatus(pending, 'broadcast', {
        transactionHash,
        confirmations: 0,
        requiredConfirmations: pending.requiredConfirmations
      }).catch(() => {})
    }
    await this.commitReservation(pending.changeReservation).catch(() => {})
    await this.commitInputs(pending.inputReservation).catch(() => {})
    await this.pendingStore.delete(pending.transactionId).catch(() => {})
    await Promise.resolve(this.onMonitoringRequired?.()).catch(() => {})
  }

  /**
   * Completes transfers interrupted between signing, broadcast and reservation
   * commit. Signed records are re-broadcast idempotently; signing claims are
   * reconciled once their grace period has elapsed.
   */
  recoverPendingTransfers(
    input: {
      readonly graceMs?: number
    } = {}
  ): Promise<PearlPendingRecoveryResult> {
    const graceMs = input.graceMs ?? PEARL_INTERRUPTED_SIGNING_GRACE_MS
    this.recoveryGate ??= new DedupPromise<PearlPendingRecoveryResult>()
    const gate = this.recoveryGate
    return gate
      .run(() => this.runPendingRecovery(graceMs))
      .finally(() => {
        if (!gate.isPending) this.recoveryGate = null
      })
  }

  private async runPendingRecovery(graceMs: number): Promise<PearlPendingRecoveryResult> {
    let resumedBroadcasts = 0
    let reconciledSignings = 0
    for (const pending of await this.pendingStore.list()) {
      if (pending.phase === 'signed') {
        await this.withTransactionLock(pending.transactionId, async () => {
          const current = await this.pendingStore.get(pending.transactionId).catch(() => null)
          if (!current || current.phase !== 'signed') return
          await this.broadcast(current)
        })
          .then(() => {
            resumedBroadcasts += 1
          })
          .catch(() => {})
        continue
      }
      if (!isPearlSigningInterrupted(pending, this.timestamp(), graceMs)) continue
      await this.withTransactionLock(pending.transactionId, async () => {
        const current = await this.pendingStore.get(pending.transactionId).catch(() => null)
        if (!current || current.phase !== 'signing') return
        await this.reconcileInterruptedSigning(current)
      })
        .then(() => {
          reconciledSignings += 1
        })
        .catch(() => {})
    }
    return Object.freeze({ resumedBroadcasts, reconciledSignings })
  }

  private withTransactionLock<T>(
    transactionId: TransactionId,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = String(transactionId)
    const queue = this.transactionLocks.get(key) ?? new SerialTaskQueue()
    this.transactionLocks.set(key, queue)
    return queue.run(operation).finally(() => {
      if (this.transactionLocks.get(key) === queue) this.transactionLocks.delete(key)
    })
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingPearlTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          (candidate.target.chainId === 'bip122:a18d3093b7ff618f0cdd073fa3d10374' ||
            candidate.target.chainId === 'bip122:b0c86d0cd8825f4d72260d2de46f4704')
      )
      if (
        (graph?.root.kind === 'transfer' ||
          graph?.root.kind === 'swap' ||
          graph?.root.kind === 'supply') &&
        segment?.target.kind === 'onchain'
      ) {
        const occurredAt = this.timestamp()
        await this.applyStatus(
          { scope, transactionId, segmentId: segment.id },
          'failed',
          undefined,
          { code: 'integrity-failure', occurredAt },
          occurredAt
        ).catch(() => {})
      }
      throw new Error('Pending Pearl transfer integrity check failed')
    }
  }

  private pendingMatchesGraph(
    pending: PendingPearlSigningTransfer,
    graph: TransactionGraph
  ): boolean {
    const intent = graph.root.intent
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const expectedAssetId = `${pending.prepared.chainId}/slip44:808276`
    return (
      graph.root.id === pending.transactionId &&
      scopesMatch(graph.root.scope, pending.scope) &&
      (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
      intent?.schemaVersion === 1 &&
      intent.direction === (pending.signer === pending.prepared.recipient ? 'self' : 'outgoing') &&
      intent.primaryAmount?.assetId === expectedAssetId &&
      intent.primaryAmount.amountRaw === pending.prepared.amountSats &&
      intent.feeLimit?.assetId === expectedAssetId &&
      intent.feeLimit.amountRaw === pending.prepared.feeSats &&
      intent.sender?.chainId === pending.prepared.chainId &&
      intent.sender.address === pending.signer &&
      intent.recipient?.chainId === pending.prepared.chainId &&
      intent.recipient.address === pending.prepared.recipient &&
      segment?.target.kind === 'onchain' &&
      segment.target.chainId === pending.prepared.chainId &&
      (segment.status === 'prepared' || segment.status === 'approved') &&
      segment.evidence?.requiredConfirmations === pending.requiredConfirmations
    )
  }

  private async pendingIntegrityMatchesGraph(
    pending: PendingPearlSigningTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    try {
      assertPearlSigningSummaryMatchesPrepared(
        pending.prepared,
        pending.signingSummary,
        pending.signer
      )
      return (
        (await computePearlSigningPayloadFingerprint(pending.prepared)) ===
          pending.payloadFingerprint && this.pendingMatchesGraph(pending, graph)
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(pending: PendingPearlTransfer): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending Pearl review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalPearlTransfer, 'transactionId' | 'segmentId'>,
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
      eventId: `event:pearl:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'Pearl'
    })
  }

  private async persistSignedGraph(
    pending: SignedPendingPearlTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      validateEvidence: segment =>
        segment.evidence?.requiredConfirmations === pending.requiredConfirmations,
      label: 'Pearl'
    })
  }

  private async requireGraph(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    segmentId: TransactionSegmentId
  ): Promise<TransactionGraph> {
    const graph = await this.repository.get(scope, transactionId)
    if (!graph || !graph.segments.some(segment => segment.id === segmentId)) {
      throw new Error('Persisted Pearl transaction graph was not found')
    }
    return graph
  }

  private async applyStatus(
    pending: Pick<AwaitingApprovalPearlTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:pearl:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending.scope, pending.transactionId, pending.segmentId)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted Pearl transaction segment was not found')
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
      throw new Error(`Pearl transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('Pearl transaction lifecycle update conflicted twice')
  }

  private abandonReservation(reservation: PearlChangeReservation | null): Promise<void> {
    if (reservation === null) return Promise.resolve()
    return this.changeReservations
      .abandon(
        {
          chainAccount: reservation.chainAccount,
          accountIndex: reservation.accountIndex,
          addressScheme: reservation.addressScheme
        },
        reservation.transactionId
      )
      .then(() => {})
  }

  private commitReservation(reservation: PearlChangeReservation | null): Promise<void> {
    if (reservation === null) return Promise.resolve()
    return this.changeReservations
      .commit(
        {
          chainAccount: reservation.chainAccount,
          accountIndex: reservation.accountIndex,
          addressScheme: reservation.addressScheme
        },
        reservation.transactionId
      )
      .then(() => {})
  }

  private releaseInputs(reservation: PearlInputReservation): Promise<void> {
    return this.inputReservations.release(
      {
        chainAccount: reservation.chainAccount,
        accountIndex: reservation.accountIndex,
        addressScheme: reservation.addressScheme
      },
      reservation.transactionId
    )
  }

  private commitInputs(reservation: PearlInputReservation): Promise<void> {
    return this.inputReservations
      .commit({
        chainAccount: reservation.chainAccount,
        accountIndex: reservation.accountIndex,
        addressScheme: reservation.addressScheme,
        transactionId: reservation.transactionId,
        now: this.timestamp()
      })
      .then(() => {})
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

  private cancelPreparedSigning(
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    signing: PreparedSigningCommand,
    signal?: AbortSignal
  ): Promise<void> {
    return signing.execution.kind === 'external'
      ? Promise.resolve()
      : this.cancelSigning(keyDomainId, signing.commandId, signal)
  }

  private cancelPendingSigning(
    pending: PendingPearlSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    return pending.signingExecution.kind === 'external'
      ? Promise.resolve()
      : this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, signal)
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Pearl transfer timestamp')
    }
    return value
  }
}
