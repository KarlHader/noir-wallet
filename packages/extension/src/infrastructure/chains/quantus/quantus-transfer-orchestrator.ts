import { parseAccountId, type ChainAccount } from '@/core/accounts/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  KeyringError,
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
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'
import { checkQuantusSignedTransferFee } from './quantus-signed-transfer-fee-policy'
import { verifyQuantusSignedTransfer } from './quantus-signed-extrinsic-verifier'
import type { QuantusSignedOnlyRecord, QuantusSignedOnlyStore } from './quantus-signed-only-store'
import { createQuantusTransferGraph } from './quantus-transaction-graph'
import { QuantusRpcError, type QuantusBroadcastRpc, type QuantusReadRpc } from './quantus-rpc-types'
import {
  prepareQuantusNativeTransfer,
  QuantusTransferError,
  type PreparedQuantusNativeTransfer
} from './quantus-transfer-preparer'
import {
  type AwaitingApprovalQuantusTransfer,
  type PendingQuantusTransfer,
  type SignedPendingQuantusTransfer,
  type QuantusPendingTransferStore
} from './quantus-pending-transfer-store'
import {
  parseQuantusSigningPreparePayload,
  type QuantusTransferPrepareRequest,
  type QuantusSigningPreparePayload
} from '../../keyring/multichain/signing-adapter-quantus'
import { computeQuantusTransferFingerprint } from '../../keyring/multichain/quantus-signing-client'

export interface QuantusTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: QuantusTransferPrepareRequest,
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

export interface QuantusTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: QuantusPendingTransferStore
  /** Separate store: no wallet recovery path may submit these bytes. */
  readonly signedOnlyStore: QuantusSignedOnlyStore
  readonly signer: QuantusTransferSigningPort
  readonly rpc: QuantusReadRpc & QuantusBroadcastRpc
  readonly assets: AssetRegistry
  readonly now?: () => number
  readonly createId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  /** Only fixed categories; never pass transaction bytes or RPC error text. */
  readonly onBroadcastAttempt?: (
    result:
      | 'accepted'
      | 'hash-mismatch'
      | 'rpc-error'
      | 'other-error'
      | 'pool-match'
      | 'pool-miss'
      | 'pool-error',
    rpcCode?: QuantusRpcError['code']
  ) => void
  readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void
}

export interface PrepareQuantusTransferInput {
  readonly chainAccount: ChainAccount
  readonly accountIndex: number
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive: boolean
  readonly signal?: AbortSignal
}

export interface PreparedQuantusTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinueQuantusTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveQuantusTransferInput extends ContinueQuantusTransferInput {
  readonly payloadFingerprint: string
}

export interface QuantusTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface SignQuantusTransferInput extends ContinueQuantusTransferInput {
  readonly payloadFingerprint: string
  /** Authorized dApp origin; bytes are only ever returned to this origin. */
  readonly origin: string
  /** Bounded digest of origin, account scope, network and reviewed intent. */
  readonly idempotencyKey: string
}

export interface QuantusSignedOnlyDelivery {
  readonly status: 'signed'
  readonly signedExtrinsicHex: string
  readonly extrinsicHash: string
  readonly graph: TransactionGraph
}

export interface LookupQuantusSignedOnlyInput {
  readonly scope: TransactionAccountScope
  readonly origin: string
  readonly idempotencyKey: string
  readonly signal?: AbortSignal
}

export interface QuantusPendingBroadcastRecoveryResult {
  readonly attempted: number
  readonly broadcast: number
  readonly pending: number
  readonly errors: number
}

const MAXIMUM_ACCOUNT_INDEX = 0x7fffffff

/**
 * Conservative signed-only validity bound. The verified era length equals the
 * reviewed period, but the engine chooses the era start, so the reservation ends
 * at most one extra period after the reviewed block.
 */
function signedOnlyEraDeath(record: {
  readonly eraBlockNumber: number
  readonly eraPeriod: number
}): number {
  return record.eraBlockNumber + 2 * record.eraPeriod
}

function readOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('Invalid Quantus signature origin')
  }
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== value) {
      throw new Error('Invalid Quantus signature origin')
    }
  } catch {
    throw new Error('Invalid Quantus signature origin')
  }
  return value
}

function readIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid Quantus signature idempotency key')
  }
  return value
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

function readAccountIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_ACCOUNT_INDEX) {
    throw new Error('Invalid Quantus account index')
  }
  return value
}

function pendingSigning(pending: AwaitingApprovalQuantusTransfer): PreparedSigningCommand {
  return Object.freeze({
    commandId: pending.signingCommandId,
    chainId: parseChainId(pending.request.chainId).id,
    operation: 'transaction' as const,
    summary: pending.signingSummary,
    payloadFingerprint: Object.freeze({
      algorithm: 'sha256' as const,
      digestHex: pending.payloadFingerprint
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: pending.expiresAt
  })
}

/**
 * Binds the staged review, the Worker-prepared request, and the reviewed debit
 * to one native transfer. Any disagreement cancels the one-time signing command
 * instead of approving an unreviewed payload.
 */
function assertApprovalMatchesPreparation(
  prepared: PreparedQuantusNativeTransfer,
  signing: PreparedSigningCommand,
  payload: QuantusSigningPreparePayload,
  fingerprint: string
): void {
  const summary = signing.summary
  if (summary.schema !== 'quantus.transfer.v1') {
    throw new Error('Quantus signing request is not a native transfer review')
  }
  if (
    signing.chainId !== parseChainId(prepared.request.chainId).id ||
    signing.operation !== 'transaction' ||
    signing.execution.kind !== 'internal' ||
    signing.payloadFingerprint.digestHex !== fingerprint
  ) {
    throw new Error('Quantus signing request does not match the reviewed transfer')
  }
  if (
    summary.fields.amountRaw !== prepared.debit.amountRaw ||
    summary.fields.feeLimitRaw !== prepared.debit.feeLimitRaw ||
    summary.fields.tipRaw !== prepared.debit.tipRaw ||
    summary.fields.recipient !== payload.transfer.recipient ||
    summary.fields.keepAlive !== payload.transfer.keepAlive ||
    summary.fields.nonce !== String(payload.transfer.nonce) ||
    summary.fields.eraPeriod !== payload.transfer.period ||
    summary.fields.blockNumber !== payload.transfer.blockNumber
  ) {
    throw new Error('Quantus review summary does not match the prepared transfer')
  }
}

export class QuantusTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: QuantusPendingTransferStore
  private readonly signedOnlyStore: QuantusSignedOnlyStore
  private readonly signer: QuantusTransferSigningPort
  private readonly rpc: QuantusReadRpc & QuantusBroadcastRpc
  private readonly assets: AssetRegistry
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly onBroadcastAttempt?: QuantusTransferOrchestratorOptions['onBroadcastAttempt']
  private readonly onMonitoringRequired?: (
    graph: TransactionGraph,
    recovered: boolean
  ) => Promise<void> | void

  constructor(options: QuantusTransferOrchestratorOptions) {
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.signedOnlyStore = options.signedOnlyStore
    this.signer = options.signer
    this.rpc = options.rpc
    this.assets = options.assets
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.onPendingBroadcast = options.onPendingBroadcast
    this.onBroadcastAttempt = options.onBroadcastAttempt
    this.onMonitoringRequired = options.onMonitoringRequired
  }

  async prepare(input: PrepareQuantusTransferInput): Promise<PreparedQuantusTransferApproval> {
    if (input.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Quantus transfer requires an account-identifier binding')
    }
    const accountIndex = readAccountIndex(input.accountIndex)
    const sender = input.chainAccount.identity.value
    const prepared = await prepareQuantusNativeTransfer({
      chainId: input.chainAccount.scope.chainId,
      accountIndex,
      address: sender,
      intent: Object.freeze({
        toAddress: input.recipient,
        amountRaw: input.amountRaw,
        keepAlive: input.keepAlive
      }),
      rpc: this.rpc,
      signal: input.signal
    })
    await this.assertNonceNotReserved(prepared, sender)
    const payload = parseQuantusSigningPreparePayload(prepared.request)
    const signing = await this.signer.prepare(
      input.chainAccount.scope.keyDomainId,
      prepared.request,
      input.signal
    )
    try {
      assertApprovalMatchesPreparation(
        prepared,
        signing,
        payload,
        await computeQuantusTransferFingerprint(payload.transfer, payload.feeLimitRaw)
      )
      if (signing.expiresAt <= this.timestamp()) {
        throw new Error('Quantus signing request expired during preparation')
      }
    } catch (error) {
      await this.cancelSigning(
        input.chainAccount.scope.keyDomainId,
        signing.commandId,
        input.signal
      ).catch(() => {})
      throw error instanceof Error ? error : new Error('Quantus signing request cannot be approved')
    }

    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:quantus:${id}`)
    const segmentId = parseTransactionSegmentId(`segment:quantus:${id}`)
    const scope = normalizeScope(input.chainAccount.scope)
    const createdAt = this.timestamp()
    const graph = createQuantusTransferGraph({
      request: prepared.request,
      senderAddress: sender,
      amountRaw: prepared.debit.amountRaw,
      feeLimitRaw: prepared.debit.feeLimitRaw,
      scope,
      transactionId,
      segmentId,
      assets: this.assets,
      createdAt,
      chainAccountId: input.chainAccount.id
    })
    const pending: AwaitingApprovalQuantusTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'awaiting-approval',
      transactionId,
      segmentId,
      scope,
      request: prepared.request,
      account: Object.freeze({
        freeRaw: prepared.account.free.toString(),
        reservedRaw: prepared.account.reserved.toString(),
        nonce: prepared.account.nonce
      }),
      debit: prepared.debit,
      signingSummary: signing.summary as AwaitingApprovalQuantusTransfer['signingSummary'],
      signingCommandId: signing.commandId,
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
    input: ContinueQuantusTransferInput
  ): Promise<PreparedQuantusTransferApproval | null> {
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
      throw new Error('Pending Quantus transfer integrity check failed')
    }
    return Object.freeze({ graph, signing: pendingSigning(pending) })
  }

  async approve(input: ApproveQuantusTransferInput): Promise<QuantusTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending Quantus transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('Quantus transfer is already signed; resume its broadcast instead')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('Quantus approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Quantus signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Quantus transfer integrity check failed')
    }
    await this.assertChainStateStillValid(pending, input.signal)

    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')
    try {
      await this.pendingStore.put(pending, graph)
    } catch {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Approved Quantus signing request could not be persisted')
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
      throw new Error('Signed Quantus transfer failed integrity validation')
    }
    let checked: Awaited<ReturnType<typeof checkQuantusSignedTransferFee>>
    try {
      checked = await checkQuantusSignedTransferFee({
        chainId: parseChainId(pending.request.chainId).id,
        summary: pending.signingSummary,
        signedExtrinsicHex: signed.payload.value,
        signerAddress: pending.signingSummary.fields.signerAddress,
        rpc: this.rpc,
        signal: input.signal
      })
    } catch {
      // The signed bytes never reach the RPC: a fee or balance change fails the
      // reviewed ceiling instead of being broadcast.
      await this.failConsumedSigning(pending)
      throw new Error('Signed Quantus transfer failed the reviewed fee ceiling')
    }
    const signedPending: SignedPendingQuantusTransfer = Object.freeze({
      schemaVersion: 1,
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      extrinsicHex: checked.signedExtrinsicHex,
      extrinsicHash: signed.transactionId,
      address: pending.signingSummary.fields.signerAddress,
      accountId: pending.signingSummary.fields.signerAccountId,
      scheme: pending.signingSummary.fields.scheme,
      nonce: pending.request.nonce,
      eraBlockNumber: pending.request.blockNumber,
      eraPeriod: pending.request.period,
      amountRaw: pending.debit.amountRaw,
      recipient: pending.request.toAddress,
      keepAlive: pending.request.keepAlive,
      feeLimitRaw: pending.debit.feeLimitRaw,
      measuredFeeRaw: checked.actualFeeRaw,
      signedAt: this.timestamp(),
      nextScanBlock: pending.request.blockNumber
    })
    try {
      graph = this.transitionReviewGraph(pending, graph, 'signed', {
        transactionHash: signedPending.extrinsicHash,
        externalReference: `quantus-era:${pending.request.blockNumber}+${pending.request.period}`
      })
      await this.pendingStore.put(signedPending, graph)
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Quantus transfer could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async reject(input: ContinueQuantusTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending Quantus approval was not found')
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

  async resumeBroadcast(input: ContinueQuantusTransferInput): Promise<QuantusTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
      throw new Error('Signed Quantus transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  async resumePendingBroadcasts(): Promise<QuantusPendingBroadcastRecoveryResult> {
    const signed = (await this.pendingStore.list()).filter(
      (candidate): candidate is SignedPendingQuantusTransfer =>
        candidate.phase === 'signed' && candidate.broadcastRejectedAt === undefined
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

  /**
   * Confirms a review as a signed-only handoff. The claim is persisted before the
   * Worker confirm so a lost response stays indeterminate instead of producing a
   * second signature; the exact bytes are verified against the reviewed summary
   * and the signed fee gate before they are persisted and returned. Nothing here
   * submits the transaction.
   */
  async signOnly(input: SignQuantusTransferInput): Promise<QuantusSignedOnlyDelivery> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const idempotencyKey = readIdempotencyKey(input.idempotencyKey)
    const origin = readOrigin(input.origin)

    // A retry for the same reviewed intent returns the same bytes, never a new signature.
    const existing = await this.findSignedOnly({
      scope,
      origin,
      idempotencyKey,
      signal: input.signal
    })
    if (existing) {
      if (existing.signedExtrinsicHex === undefined || existing.extrinsicHash === undefined) {
        throw new Error('Quantus signature request is still indeterminate; do not sign again')
      }
      const graph = await this.signedOnlyReviewGraph(existing)
      await this.pendingStore.delete(existing.transactionId).catch(() => {})
      await this.cancelSigning(scope.keyDomainId, existing.signingCommandId, input.signal).catch(
        () => {}
      )
      return Object.freeze({
        status: 'signed' as const,
        signedExtrinsicHex: existing.signedExtrinsicHex,
        extrinsicHash: existing.extrinsicHash,
        graph
      })
    }

    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending Quantus transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('Quantus transfer is already signed by a wallet send')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('Quantus signing payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Quantus signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Quantus transfer integrity check failed')
    }
    await this.assertChainStateStillValid(pending, input.signal)

    const chainId = parseChainId(pending.request.chainId).id
    // Bind the graph to the approved state, then claim the signing boundary. The
    // claim is written before the Worker confirm so a lost response leaves an
    // indeterminate record instead of a second signature.
    let graph = this.transitionReviewGraph(pending, currentGraph, 'approved')
    const now = this.timestamp()
    const claim: QuantusSignedOnlyRecord = Object.freeze({
      schemaVersion: 1,
      phase: 'signing-in-progress',
      transactionId,
      segmentId: pending.segmentId,
      chainAccountId: pending.signingSummary.fields.signerAccountId,
      scope,
      chainId,
      origin,
      idempotencyKey,
      recipient: pending.request.toAddress,
      amountRaw: pending.debit.amountRaw,
      keepAlive: true,
      payloadFingerprint: pending.payloadFingerprint,
      signingCommandId: pending.signingCommandId,
      signingSummary: pending.signingSummary,
      nonce: pending.request.nonce,
      eraBlockNumber: pending.request.blockNumber,
      eraPeriod: pending.request.period,
      feeLimitRaw: pending.debit.feeLimitRaw,
      approvalExpiresAt: pending.expiresAt,
      createdAt: now,
      updatedAt: now
    })
    try {
      await this.signedOnlyStore.put(claim)
      await this.pendingStore.put(pending, graph)
    } catch {
      await this.signedOnlyStore.delete(transactionId).catch(() => {})
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Signed-only Quantus claim could not be persisted')
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
        // The command never produced a signature, so this intent is conclusive.
        await this.finishSignedOnly(claim, 'expired', input.signal)
      }
      // Otherwise the claim stays `signing-in-progress`: the outcome is unknown and
      // this intent must never be signed again.
      throw error
    }

    let verified: ReturnType<typeof verifyQuantusSignedTransfer>
    try {
      if (
        signed.kind !== 'signed-payload' ||
        signed.payload.encoding !== 'hex' ||
        signed.transactionId === undefined
      ) {
        throw new Error('Signed Quantus transfer failed integrity validation')
      }
      verified = verifyQuantusSignedTransfer({
        summary: claim.signingSummary,
        signedExtrinsicHex: signed.payload.value,
        chainId
      })
      if (verified.extrinsicHash !== signed.transactionId) {
        throw new Error('Signed Quantus extrinsic hash does not match the signing result')
      }
    } catch {
      // An unverified signature is never delivered.
      await this.finishSignedOnly(claim, 'expired', input.signal)
      throw new Error('Signed Quantus transfer could not be verified against the review')
    }

    let checked: Awaited<ReturnType<typeof checkQuantusSignedTransferFee>>
    try {
      checked = await checkQuantusSignedTransferFee({
        chainId,
        summary: claim.signingSummary,
        signedExtrinsicHex: verified.signedExtrinsicHex,
        signerAddress: claim.signingSummary.fields.signerAddress,
        rpc: this.rpc,
        signal: input.signal
      })
    } catch {
      await this.finishSignedOnly(claim, 'expired', input.signal)
      throw new Error('Signed Quantus transfer failed the reviewed fee ceiling')
    }

    const signedOnlyRecord: QuantusSignedOnlyRecord = Object.freeze({
      ...claim,
      phase: 'signed-for-delivery',
      signedExtrinsicHex: verified.signedExtrinsicHex,
      extrinsicHash: verified.extrinsicHash,
      measuredFeeRaw: checked.actualFeeRaw,
      updatedAt: this.timestamp()
    })
    await this.signedOnlyStore.put(signedOnlyRecord)
    // Activity records only transactions the wallet broadcast, so these bytes are
    // deliberately kept out of the transaction repository.
    graph = this.transitionReviewGraph(pending, graph, 'signed', {
      transactionHash: verified.extrinsicHash,
      externalReference: `quantus-era:${pending.request.blockNumber}+${pending.request.period}`
    })
    // The signed-only record owns delivery now; the review entry must not be
    // resumable or cancellable any more.
    await this.pendingStore.delete(transactionId).catch(() => {})
    return Object.freeze({
      status: 'signed' as const,
      signedExtrinsicHex: verified.signedExtrinsicHex,
      extrinsicHash: verified.extrinsicHash,
      graph
    })
  }

  /**
   * Returns live signed-only bytes for the same origin, account and intent, or
   * null when this intent has no deliverable signature yet. Records past their
   * era are settled as expired so a stale nonce reservation cannot linger.
   */
  async findSignedOnly(
    input: LookupQuantusSignedOnlyInput
  ): Promise<QuantusSignedOnlyRecord | null> {
    const scope = normalizeScope(input.scope)
    const origin = readOrigin(input.origin)
    const idempotencyKey = readIdempotencyKey(input.idempotencyKey)
    const records = await this.signedOnlyStore.list()
    const matches = records.filter(
      record =>
        scopesMatch(record.scope, scope) &&
        record.origin === origin &&
        record.idempotencyKey === idempotencyKey
    )
    if (matches.length === 0) return null
    const head = await this.currentHead(input.signal)
    let result: QuantusSignedOnlyRecord | null = null
    for (const record of matches) {
      if (record.phase !== 'expired' && head >= signedOnlyEraDeath(record)) {
        await this.signedOnlyStore
          .put(Object.freeze({ ...record, phase: 'expired', expiredAt: this.timestamp() }))
          .catch(() => {})
        continue
      }
      if (record.phase === 'signing-in-progress') {
        throw new Error('Quantus signature request is indeterminate; do not sign again')
      }
      if (record.signedExtrinsicHex !== undefined && record.extrinsicHash !== undefined) {
        result = record
      }
    }
    return result
  }

  async findSignedOnlyForIntent(input: {
    readonly scope: TransactionAccountScope
    readonly origin: string
    readonly chainId: string
    readonly signerAddress: string
    readonly recipient: string
    readonly amountRaw: string
    readonly signal?: AbortSignal
  }): Promise<string | null> {
    const scope = normalizeScope(input.scope)
    const origin = readOrigin(input.origin)
    const matching = (await this.signedOnlyStore.list()).filter(
      record =>
        scopesMatch(record.scope, scope) &&
        record.origin === origin &&
        record.chainId === input.chainId &&
        record.signingSummary.fields.signerAddress === input.signerAddress &&
        record.recipient === input.recipient &&
        record.amountRaw === input.amountRaw &&
        record.keepAlive === true &&
        record.phase !== 'expired'
    )
    if (matching.length === 0) return null
    // More than one matching review cannot be disambiguated by a dApp intent alone.
    if (matching.length !== 1)
      throw new Error('Multiple signed Quantus transfers match this intent')
    const record = await this.findSignedOnly({
      scope,
      origin,
      idempotencyKey: matching[0].idempotencyKey,
      signal: input.signal
    })
    if (!record) return null
    if (!record.signedExtrinsicHex || !record.extrinsicHash) {
      throw new Error('Quantus signature request is indeterminate; do not sign again')
    }
    // The verified, origin-bound signed record owns the bytes for delivery and no
    // Activity record is written for it: the wallet never broadcast them.
    await this.pendingStore.delete(record.transactionId).catch(() => {})
    return record.signedExtrinsicHex
  }

  /** Marks bytes as delivered to the authorized origin after a repeat request. */
  async markSignedOnlyDelivered(transactionIdValue: string): Promise<void> {
    const transactionId = parseTransactionId(transactionIdValue)
    const record = await this.signedOnlyStore.get(transactionId)
    if (!record || record.phase !== 'signed-for-delivery') return
    await this.signedOnlyStore.put(
      Object.freeze({
        ...record,
        phase: 'delivered',
        deliveredAt: this.timestamp(),
        updatedAt: this.timestamp()
      })
    )
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

  /** Reads the persisted graph for Activity; a missing graph is not an error. */
  getTransferGraph(input: ContinueQuantusTransferInput): Promise<TransactionGraph | null> {
    return this.repository.get(normalizeScope(input.scope), parseTransactionId(input.transactionId))
  }

  /**
   * A live signed-only signature may still be submitted by its dApp, so neither a
   * wallet send nor another sign-only approval may reuse its nonce. A fresh RPC
   * nonce cannot prove unreleased bytes are harmless.
   */
  private async assertNonceNotReserved(
    prepared: PreparedQuantusNativeTransfer,
    signerAddress: string
  ): Promise<void> {
    const chainId = parseChainId(prepared.request.chainId).id
    const head = prepared.request.blockNumber
    const records = await this.signedOnlyStore.list()
    const reserved = records.some(
      record =>
        record.phase !== 'expired' &&
        record.chainId === chainId &&
        record.signingSummary.fields.signerAddress === signerAddress &&
        record.nonce === prepared.request.nonce &&
        signedOnlyEraDeath(record) > head
    )
    if (reserved) {
      throw new QuantusTransferError(
        'nonce-reserved',
        'A signed Quantus transfer is still pending for this account'
      )
    }
  }

  private async currentHead(signal?: AbortSignal): Promise<number> {
    const bestHead = await this.rpc.getBestHead(signal)
    const header = await this.rpc.getHeader(bestHead, signal)
    if (!Number.isSafeInteger(header.number) || header.number < 0) {
      throw new Error('Invalid Quantus best head')
    }
    return header.number
  }

  private async broadcast(
    pending: SignedPendingQuantusTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<QuantusTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    const observedGraph =
      signedGraph.segments.find(segment => segment.id === pending.segmentId)?.status === 'broadcast'
        ? signedGraph
        : null
    if (observedGraph) {
      await Promise.resolve(
        this.onMonitoringRequired?.(observedGraph, currentGraph === undefined)
      ).catch(() => {})
      return Object.freeze({ status: 'broadcast', graph: observedGraph })
    }
    if (pending.broadcastRejectedAt !== undefined) {
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    // A signed record may predate this build. An expired era cannot become valid
    // again, but its record must remain for finalized-chain reconciliation.
    if (
      pending.eraPeriod !== undefined &&
      pending.eraPeriod !== 0 &&
      (await this.currentHead(signal)) >= pending.eraBlockNumber + pending.eraPeriod
    ) {
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    let accepted = false
    try {
      accepted =
        (await this.rpc.submitExtrinsic(pending.extrinsicHex, signal)) === pending.extrinsicHash
      this.onBroadcastAttempt?.(accepted ? 'accepted' : 'hash-mismatch')
    } catch (error) {
      this.onBroadcastAttempt?.(
        error instanceof QuantusRpcError ? 'rpc-error' : 'other-error',
        error instanceof QuantusRpcError ? error.code : undefined
      )
      if (error instanceof QuantusRpcError && error.code === 'bad-signature') {
        await this.pendingStore.put(
          Object.freeze({ ...pending, broadcastRejectedAt: this.timestamp() }),
          signedGraph
        )
        return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
      }
    }
    if (!accepted) {
      // Pool membership is a hint that the node already holds these exact bytes;
      // inclusion, not pool state, is what the monitor treats as success.
      try {
        accepted = (await this.rpc.getPendingExtrinsics(signal)).some(
          extrinsic => extrinsic.toLowerCase() === pending.extrinsicHex
        )
        this.onBroadcastAttempt?.(accepted ? 'pool-match' : 'pool-miss')
      } catch {
        this.onBroadcastAttempt?.('pool-error')
      }
    }
    if (!accepted) {
      await Promise.resolve(this.onPendingBroadcast?.()).catch(() => {})
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    const graph = await this.applyStatus(pending, 'broadcast', {
      transactionHash: pending.extrinsicHash
    })
    await this.pendingStore
      .put(Object.freeze({ ...pending, broadcastAt: this.timestamp() }), graph)
      .catch(() => {})
    await Promise.resolve(this.onMonitoringRequired?.(graph, currentGraph === undefined)).catch(
      () => {}
    )
    return Object.freeze({ status: 'broadcast', graph })
  }

  private async assertChainStateStillValid(
    pending: AwaitingApprovalQuantusTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    const nextIndex = await this.rpc.getSystemAccountNextIndex(
      pending.signingSummary.fields.signerAddress,
      signal
    )
    if (nextIndex !== pending.request.nonce) {
      await this.failAwaitingApproval(pending, signal)
      throw new Error('Quantus account index changed; prepare the transfer again')
    }
    if (pending.request.period === 0) return
    const bestHead = await this.rpc.getBestHead(signal)
    const header = await this.rpc.getHeader(bestHead, signal)
    if (header.number >= pending.request.blockNumber + pending.request.period) {
      await this.failAwaitingApproval(pending, signal)
      throw new Error('Quantus transfer era expired')
    }
  }

  private async cancelAwaitingApprovals(
    matches: (pending: AwaitingApprovalQuantusTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (candidate): candidate is AwaitingApprovalQuantusTransfer =>
        candidate.phase === 'awaiting-approval' && matches(candidate)
    )
    for (const candidate of pending) {
      await this.cancelSigning(
        candidate.scope.keyDomainId,
        candidate.signingCommandId,
        signal
      ).catch(() => {})
      await this.pendingStore.delete(candidate.transactionId)
    }
    return pending.length
  }

  private async failAwaitingApproval(
    pending: AwaitingApprovalQuantusTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.all([
      this.pendingStore.delete(pending.transactionId),
      this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, signal).catch(
        () => {}
      )
    ])
  }

  private async failConsumedSigning(pending: AwaitingApprovalQuantusTransfer): Promise<void> {
    await this.pendingStore.delete(pending.transactionId)
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingQuantusTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          candidate.target.chainId.startsWith('quantus:')
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
      throw new Error('Pending Quantus transfer integrity check failed')
    }
  }

  private async pendingIntegrityMatchesGraph(
    pending: AwaitingApprovalQuantusTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const intent = graph.root.intent
    try {
      const payload = parseQuantusSigningPreparePayload(pending.request)
      const chainId = parseChainId(pending.request.chainId).id
      const nativeAssetId = `${chainId}/slip44:189189`
      assertApprovalMatchesPreparation(
        {
          request: pending.request,
          account: {
            free: BigInt(pending.account.freeRaw),
            reserved: BigInt(pending.account.reservedRaw),
            nonce: pending.account.nonce
          },
          debit: pending.debit
        },
        pendingSigning(pending),
        payload,
        await computeQuantusTransferFingerprint(payload.transfer, payload.feeLimitRaw)
      )
      if (
        pending.payloadFingerprint !==
        (await computeQuantusTransferFingerprint(payload.transfer, payload.feeLimitRaw))
      ) {
        return false
      }
      return (
        graph.root.id === pending.transactionId &&
        scopesMatch(graph.root.scope, pending.scope) &&
        graph.root.kind === 'transfer' &&
        (graph.root.status === 'prepared' || graph.root.status === 'approved') &&
        intent?.schemaVersion === 1 &&
        intent.primaryAmount?.assetId === nativeAssetId &&
        intent.primaryAmount.amountRaw === pending.debit.amountRaw &&
        intent.feeLimit?.assetId === nativeAssetId &&
        intent.feeLimit.amountRaw === pending.debit.feeLimitRaw &&
        intent.sender?.chainId === chainId &&
        intent.sender.address === pending.signingSummary.fields.signerAddress &&
        intent.recipient?.chainId === chainId &&
        intent.recipient.address === pending.request.toAddress &&
        segment?.target.kind === 'onchain' &&
        segment.target.chainId === chainId &&
        (segment.status === 'prepared' || segment.status === 'approved')
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(
    pending: Pick<PendingQuantusTransfer, 'transactionId'>
  ): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending Quantus review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalQuantusTransfer, 'transactionId' | 'segmentId'>,
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
      eventId: `event:quantus:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'Quantus'
    })
  }

  private async finishSignedOnly(
    claim: QuantusSignedOnlyRecord,
    phase: 'expired',
    signal?: AbortSignal
  ): Promise<void> {
    await this.signedOnlyStore
      .put(
        Object.freeze({ ...claim, phase, expiredAt: this.timestamp(), updatedAt: this.timestamp() })
      )
      .catch(() => {})
    await this.cancelSigning(claim.scope.keyDomainId, claim.signingCommandId, signal).catch(
      () => {}
    )
    await this.pendingStore.delete(claim.transactionId).catch(() => {})
  }

  private async signedOnlyReviewGraph(record: QuantusSignedOnlyRecord): Promise<TransactionGraph> {
    const graph = await this.requireReviewGraph(record)
    return this.transitionReviewGraph(record, graph, 'signed', {
      transactionHash: record.extrinsicHash,
      externalReference: `quantus-era:${record.eraBlockNumber}+${record.eraPeriod}`
    })
  }

  private async persistSignedGraph(
    pending: Pick<
      SignedPendingQuantusTransfer,
      'scope' | 'transactionId' | 'segmentId' | 'extrinsicHash'
    >,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: {
        scope: pending.scope,
        transactionId: pending.transactionId,
        segmentId: pending.segmentId,
        transactionHash: pending.extrinsicHash
      },
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      label: 'Quantus'
    })
  }

  private requireGraph(
    pending: Pick<PendingQuantusTransfer, 'scope' | 'transactionId' | 'segmentId'>
  ): Promise<TransactionGraph> {
    return this.repository.get(pending.scope, pending.transactionId).then(graph => {
      if (!graph || !graph.segments.some(segment => segment.id === pending.segmentId)) {
        throw new Error('Persisted Quantus transaction graph was not found')
      }
      return graph
    })
  }

  private async applyStatus(
    pending: Pick<PendingQuantusTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:quantus:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted Quantus transaction segment was not found')
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
      throw new Error(`Quantus transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('Quantus transaction lifecycle update conflicted twice')
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
      throw new Error('Invalid Quantus transfer timestamp')
    }
    return value
  }
}
