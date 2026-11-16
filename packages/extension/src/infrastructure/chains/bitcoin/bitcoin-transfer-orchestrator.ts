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
import type { BitcoinChangeReservationCoordinator } from './bitcoin-change-reservation-coordinator'
import {
  parseBitcoinChangeReservation,
  type BitcoinChangeReservation
} from './bitcoin-change-reservation-model'
import {
  parseBitcoinInputOutpoints,
  parseBitcoinInputReservation,
  type BitcoinInputOutpoint,
  type BitcoinInputReservation,
  type BitcoinInputReservationRepository
} from './bitcoin-input-reservation-model'
import {
  bitcoinChainAccountsMatch,
  parseScope as parseBitcoinDiscoveryScope
} from './bitcoin-discovery-persistence-model'
import {
  type AwaitingApprovalBitcoinTransfer,
  type AwaitingExternalSignatureBitcoinTransfer,
  type BitcoinPendingTransferStore,
  type PendingBitcoinTransfer,
  type PendingBitcoinSigningTransfer,
  type SignedPendingBitcoinTransfer
} from './bitcoin-pending-transfer-store'
import { finalizeBitcoinPsbt } from './bitcoin-psbt-finalizer'
import { parsePreparedBitcoinPsbt } from './bitcoin-prepared-psbt-validator'
import {
  assertBitcoinSigningSummaryMatchesPrepared,
  computeBitcoinSigningPayloadFingerprint,
  createBitcoinSigningSummary,
  createBitcoinSigningPreparePayload,
  KEYSTONE_BITCOIN_SIGNING_TTL_MS,
  normalizeBitcoinSigningSummary,
  type BitcoinSigningPreparePayload
} from './bitcoin-signing-summary-validator'
import { createBitcoinTransferGraph } from './bitcoin-transaction-graph'
import { parseBitcoinAddress, type PreparedBitcoinPsbt } from './bitcoin-transaction-model'
import type { LedgerBitcoinSigningRequest } from '@/lib/ledger/bitcoin'
import {
  broadcastSignedBitcoinTransaction,
  parseBitcoinFinalityConfirmations,
  type BitcoinMonitorRpc
} from './bitcoin-transaction-observer'

export interface BitcoinTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: BitcoinSigningPreparePayload,
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

export interface BitcoinTransferOrchestratorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: BitcoinPendingTransferStore
  readonly signer: BitcoinTransferSigningPort
  readonly rpc: Pick<BitcoinMonitorRpc, 'broadcastRawTransaction' | 'getTransactionStatus'>
  readonly assets: AssetRegistry
  readonly changeReservations: Pick<BitcoinChangeReservationCoordinator, 'commit' | 'abandon'>
  readonly inputReservations: Pick<BitcoinInputReservationRepository, 'commit' | 'release'>
  readonly now?: () => number
  readonly createId?: () => string
  readonly onPendingBroadcast?: () => Promise<void> | void
  readonly onBroadcastAccepted?: (
    input: {
      readonly scope: TransactionAccountScope
      readonly transactionId: string
      readonly rawTransactionHex: string
      readonly spentOutpoints: readonly BitcoinInputOutpoint[]
      readonly graph: TransactionGraph
    },
    recovered: boolean
  ) => Promise<void> | void
  readonly onMonitoringRequired?: () => Promise<void> | void
}

export interface PrepareBitcoinTransferInput {
  readonly chainAccount: ChainAccount
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly prepared: PreparedBitcoinPsbt
  readonly signerAddress: string
  readonly changeReservation: BitcoinChangeReservation | null
  readonly inputReservation: BitcoinInputReservation
  readonly requiredConfirmations: number
  readonly signingMode?: 'internal' | 'keystone' | 'ledger'
  readonly nearIntentsBinding?: NearIntentsTransactionBinding
  readonly rheaSwapBinding?: RheaSwapTransactionBinding
  readonly signal?: AbortSignal
}

export interface PreparedBitcoinTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinueBitcoinTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveBitcoinTransferInput extends ContinueBitcoinTransferInput {
  readonly payloadFingerprint: string
}

export interface BitcoinTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export interface BitcoinExternalSignatureRequired {
  readonly status: 'external-signature-required'
  readonly graph: TransactionGraph
  readonly transactionId: TransactionId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export type BitcoinTransferApprovalResult =
  | BitcoinTransferSubmission
  | BitcoinExternalSignatureRequired

export interface BitcoinExternalSigningRequest {
  readonly vendor?: 'keystone' | 'ledger'
  readonly ledgerRequest?: LedgerBitcoinSigningRequest
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

export interface SubmitBitcoinExternalSignatureInput extends ContinueBitcoinTransferInput {
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
  value: BitcoinChangeReservation | null,
  transactionId: TransactionId,
  chainAccount: ChainAccount,
  prepared: PreparedBitcoinPsbt,
  signerAddress: string
): BitcoinChangeReservation | null {
  if (value === null) {
    if (prepared.changeAddress !== null && prepared.changeAddress !== signerAddress) {
      throw new Error('Prepared Bitcoin change output requires a reservation')
    }
    return null
  }
  const reservation = parseBitcoinChangeReservation(value, undefined, transactionId)
  if (
    reservation.state !== 'reserved' ||
    reservation.address === null ||
    prepared.changeAddress === null ||
    !bitcoinChainAccountsMatch(reservation.chainAccount, chainAccount) ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressType !== prepared.addressType ||
    reservation.address.address !== prepared.changeAddress
  ) {
    throw new Error('Bitcoin change reservation does not match the prepared transfer')
  }
  return reservation
}

function normalizeInputReservation(
  value: BitcoinInputReservation,
  transactionId: TransactionId,
  chainAccount: ChainAccount,
  prepared: PreparedBitcoinPsbt
): BitcoinInputReservation {
  const reservation = parseBitcoinInputReservation(value, undefined, transactionId)
  const parsedPrepared = parsePreparedBitcoinPsbt(prepared)
  const expectedOutpoints = parseBitcoinInputOutpoints(
    parsedPrepared.psbt.txInputs.map(input => ({
      transactionId: Buffer.from(input.hash).reverse().toString('hex'),
      outputIndex: input.index
    }))
  )
  if (
    reservation.state !== 'reserved' ||
    !bitcoinChainAccountsMatch(reservation.chainAccount, chainAccount) ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressType !== prepared.addressType ||
    JSON.stringify(reservation.outpoints) !== JSON.stringify(expectedOutpoints)
  ) {
    throw new Error('Bitcoin input reservation does not match the prepared transfer')
  }
  return reservation
}

export class BitcoinTransferOrchestrator {
  private readonly repository: TransactionRepository
  private readonly pendingStore: BitcoinPendingTransferStore
  private readonly signer: BitcoinTransferSigningPort
  private readonly rpc: Pick<BitcoinMonitorRpc, 'broadcastRawTransaction' | 'getTransactionStatus'>
  private readonly assets: AssetRegistry
  private readonly changeReservations: Pick<
    BitcoinChangeReservationCoordinator,
    'commit' | 'abandon'
  >
  private readonly inputReservations: Pick<BitcoinInputReservationRepository, 'commit' | 'release'>
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onPendingBroadcast?: () => Promise<void> | void
  private readonly onBroadcastAccepted?: BitcoinTransferOrchestratorOptions['onBroadcastAccepted']
  private readonly onMonitoringRequired?: () => Promise<void> | void

  constructor(options: BitcoinTransferOrchestratorOptions) {
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

  async prepare(input: PrepareBitcoinTransferInput): Promise<PreparedBitcoinTransferApproval> {
    const transactionId = parseTransactionId(input.transactionId)
    const segmentId = parseTransactionSegmentId(input.segmentId)
    const requiredConfirmations = parseBitcoinFinalityConfirmations(input.requiredConfirmations)
    const discoveryScope = parseBitcoinDiscoveryScope({
      chainAccount: input.chainAccount,
      accountIndex: input.prepared.accountIndex
    })
    if (discoveryScope.chainAccount.scope.chainId !== input.prepared.chainId) {
      throw new Error('Bitcoin ChainAccount does not match the prepared transfer')
    }
    const scope = normalizeScope(discoveryScope.chainAccount.scope)
    const signerAddress = parseBitcoinAddress(
      input.signerAddress,
      input.prepared.chainId,
      input.prepared.addressType
    )
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
      throw new Error('Bitcoin transfer cannot bind multiple swap protocols')
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
    const graph = createBitcoinTransferGraph({
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
      const expectedFingerprint = await computeBitcoinSigningPayloadFingerprint(input.prepared)
      signing =
        input.signingMode === 'keystone' || input.signingMode === 'ledger'
          ? Object.freeze({
              commandId: parseSigningCommandId(
                `signing-command:${input.signingMode}-bitcoin:${this.createId()}`
              ),
              chainId: input.prepared.chainId,
              operation: 'transaction' as const,
              summary: createBitcoinSigningSummary(input.prepared, signerAddress),
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
              expiresAt: createdAt + KEYSTONE_BITCOIN_SIGNING_TTL_MS
            })
          : await this.signer.prepare(
              scope.keyDomainId,
              createBitcoinSigningPreparePayload(input.prepared),
              input.signal
            )
      signing = Object.freeze({
        ...signing,
        summary: normalizeBitcoinSigningSummary(input.prepared, signing.summary, signerAddress)
      })
      if (
        signing.summary.review.level === 'blocked' ||
        signing.expiresAt <= this.timestamp() ||
        signing.payloadFingerprint.digestHex !== expectedFingerprint
      ) {
        throw new Error('Bitcoin signing request cannot be approved')
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
        throw new Error('Bitcoin signing preparation cleanup failed')
      }
      throw error
    }
    if (signing === undefined) {
      throw new Error('Bitcoin signing request was not prepared')
    }

    const pending: AwaitingApprovalBitcoinTransfer = Object.freeze({
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
        throw new Error('Bitcoin transfer preparation cleanup failed')
      }
      throw error
    }
  }

  async getPendingApproval(
    input: ContinueBitcoinTransferInput
  ): Promise<PreparedBitcoinTransferApproval | null> {
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
      throw new Error('Pending Bitcoin transfer integrity check failed')
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
      (candidate): candidate is PendingBitcoinSigningTransfer =>
        candidate.phase !== 'signed' &&
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

  async approve(input: ApproveBitcoinTransferInput): Promise<BitcoinTransferApprovalResult> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope)) {
      throw new Error('Pending Bitcoin transfer was not found')
    }
    if (pending.phase === 'signed') {
      throw new Error('Bitcoin transfer is already signed; resume its broadcast instead')
    }
    if (pending.phase === 'awaiting-external-signature') {
      throw new Error('Bitcoin transfer is already awaiting an external signature')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('Bitcoin approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Bitcoin signing request expired')
    }

    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Bitcoin transfer integrity check failed')
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
      const externalPending: AwaitingExternalSignatureBitcoinTransfer = Object.freeze({
        ...pending,
        phase: 'awaiting-external-signature',
        signingExecution: pending.signingExecution
      })
      try {
        await this.pendingStore.put(externalPending, graph)
      } catch {
        await this.failAwaitingApproval(pending, input.signal)
        throw new Error('External Bitcoin signing request could not be persisted')
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
      throw new Error('Approved Bitcoin signing request could not be persisted')
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

    let finalized: ReturnType<typeof finalizeBitcoinPsbt>
    try {
      if (
        signed.kind !== 'signed-payload' ||
        signed.payload.encoding !== 'base64' ||
        signed.transactionId !== pending.prepared.unsignedTransactionId
      ) {
        throw new Error('WASM did not return the prepared signed Bitcoin PSBT')
      }
      finalized = finalizeBitcoinPsbt({
        prepared: pending.prepared,
        signedPsbtBase64: signed.payload.value
      })
      if (
        (pending.prepared.addressType === 'p2wpkh' || pending.prepared.addressType === 'p2tr') &&
        finalized.transactionId !== signed.transactionId
      ) {
        throw new Error('Signed Bitcoin transaction ID does not match the prepared PSBT')
      }
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Bitcoin transaction failed integrity validation')
    }

    const signedPending: SignedPendingBitcoinTransfer = Object.freeze({
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
      throw new Error('Signed Bitcoin transaction could not be persisted')
    }
    graph = await this.persistSignedGraph(signedPending, graph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async getExternalSigningRequest(
    input: ContinueBitcoinTransferInput
  ): Promise<BitcoinExternalSigningRequest | null> {
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
      throw new Error('Pending Bitcoin transfer integrity check failed')
    }
    return Object.freeze({
      transactionId: pending.transactionId,
      scope: pending.scope,
      chainId: pending.prepared.chainId,
      summary: pending.signingSummary,
      request: pending.signingExecution.request,
      ...(pending.signingCommandId.startsWith('signing-command:ledger-bitcoin:')
        ? { vendor: 'ledger' as const }
        : {}),
      payloadFingerprint: pending.payloadFingerprint,
      expiresAt: pending.expiresAt
    })
  }

  async submitExternalSignature(
    input: SubmitBitcoinExternalSignatureInput
  ): Promise<BitcoinTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (
      !pending ||
      !scopesMatch(pending.scope, scope) ||
      pending.phase !== 'awaiting-external-signature'
    ) {
      throw new Error('Pending external Bitcoin signing request was not found')
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.payloadFingerprint) ||
      input.payloadFingerprint !== pending.payloadFingerprint
    ) {
      throw new Error('External Bitcoin signature payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Bitcoin signing request expired')
    }
    const currentGraph = await this.requireReviewGraph(pending)
    if (!(await this.pendingIntegrityMatchesGraph(pending, currentGraph))) {
      await this.failAwaitingApproval(pending, input.signal)
      throw new Error('Pending Bitcoin transfer integrity check failed')
    }
    let finalized: ReturnType<typeof finalizeBitcoinPsbt>
    try {
      finalized = finalizeBitcoinPsbt({
        prepared: pending.prepared,
        signedPsbtBase64: input.signedPsbtBase64
      })
    } catch {
      await this.failConsumedSigning(pending)
      throw new Error('Signed Bitcoin transaction failed integrity validation')
    }
    const signedPending: SignedPendingBitcoinTransfer = Object.freeze({
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
      throw new Error('Signed Bitcoin transaction could not be persisted')
    }
    const graph = await this.persistSignedGraph(signedPending, signedGraph)
    return this.broadcast(signedPending, input.signal, graph)
  }

  async reject(input: ContinueBitcoinTransferInput): Promise<TransactionGraph> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase === 'signed') {
      throw new Error('Pending Bitcoin approval was not found')
    }
    const reviewGraph = await this.requireReviewGraph(pending)
    const graph = this.transitionReviewGraph(pending, reviewGraph, 'failed', undefined, {
      code: 'user-rejected',
      occurredAt: this.timestamp()
    })
    await this.cancelPendingSigning(pending, input.signal)
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(transactionId)
    return graph
  }

  async resumeBroadcast(input: ContinueBitcoinTransferInput): Promise<BitcoinTransferSubmission> {
    const scope = normalizeScope(input.scope)
    const transactionId = parseTransactionId(input.transactionId)
    const pending = await this.readPending(scope, transactionId)
    if (!pending || !scopesMatch(pending.scope, scope) || pending.phase !== 'signed') {
      throw new Error('Signed Bitcoin transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  private async broadcast(
    pending: SignedPendingBitcoinTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<BitcoinTransferSubmission> {
    const signedGraph = await this.persistSignedGraph(pending, currentGraph)
    let accepted = false
    try {
      await broadcastSignedBitcoinTransaction({
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
    await Promise.all([
      this.commitReservation(pending.changeReservation),
      this.commitInputs(pending.inputReservation)
    ])
    await this.pendingStore.delete(pending.transactionId)
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
    pending: PendingBitcoinSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    await this.cancelPendingSigning(pending, signal)
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(pending.transactionId)
  }

  private async cancelAwaitingApprovals(
    matches: (pending: PendingBitcoinSigningTransfer) => boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const pending = (await this.pendingStore.list()).filter(
      (candidate): candidate is PendingBitcoinSigningTransfer =>
        candidate.phase !== 'signed' && matches(candidate)
    )
    for (const candidate of pending) {
      await this.cancelPendingSigning(candidate, signal)
      await this.abandonReservation(candidate.changeReservation)
      await this.releaseInputs(candidate.inputReservation)
      await this.pendingStore.delete(candidate.transactionId)
    }
    return pending.length
  }

  private async failConsumedSigning(pending: PendingBitcoinSigningTransfer): Promise<void> {
    await this.abandonReservation(pending.changeReservation)
    await this.releaseInputs(pending.inputReservation)
    await this.pendingStore.delete(pending.transactionId)
  }

  private async readPending(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<PendingBitcoinTransfer | null> {
    try {
      return await this.pendingStore.get(transactionId)
    } catch {
      await this.pendingStore.delete(transactionId).catch(() => {})
      const graph = await this.repository.get(scope, transactionId).catch(() => null)
      const segment = graph?.segments.find(
        candidate =>
          candidate.role === 'origin' &&
          candidate.target.kind === 'onchain' &&
          (candidate.target.chainId === 'bip122:000000000019d6689c085ae165831e93' ||
            candidate.target.chainId === 'bip122:000000000933ea01ad0ee984209779ba')
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
      throw new Error('Pending Bitcoin transfer integrity check failed')
    }
  }

  private pendingMatchesGraph(
    pending: PendingBitcoinSigningTransfer,
    graph: TransactionGraph
  ): boolean {
    const intent = graph.root.intent
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    const expectedAssetId = `${pending.prepared.chainId}/slip44:0`
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
    pending: PendingBitcoinSigningTransfer,
    graph: TransactionGraph
  ): Promise<boolean> {
    try {
      assertBitcoinSigningSummaryMatchesPrepared(
        pending.prepared,
        pending.signingSummary,
        pending.signer
      )
      return (
        (await computeBitcoinSigningPayloadFingerprint(pending.prepared)) ===
          pending.payloadFingerprint && this.pendingMatchesGraph(pending, graph)
      )
    } catch {
      return false
    }
  }

  private async requireReviewGraph(pending: PendingBitcoinTransfer): Promise<TransactionGraph> {
    const sessionGraph = await this.pendingStore.getReviewGraph(pending.transactionId)
    if (sessionGraph) return sessionGraph
    throw new Error('Pending Bitcoin review graph was not found')
  }

  private transitionReviewGraph(
    pending: Pick<AwaitingApprovalBitcoinTransfer, 'transactionId' | 'segmentId'>,
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
      eventId: `event:bitcoin:${this.createId()}`,
      observedAt,
      evidence,
      failure,
      label: 'Bitcoin'
    })
  }

  private async persistSignedGraph(
    pending: SignedPendingBitcoinTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      validateEvidence: segment =>
        segment.evidence?.requiredConfirmations === pending.requiredConfirmations,
      label: 'Bitcoin'
    })
  }

  private async requireGraph(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    segmentId: TransactionSegmentId
  ): Promise<TransactionGraph> {
    const graph = await this.repository.get(scope, transactionId)
    if (!graph || !graph.segments.some(segment => segment.id === segmentId)) {
      throw new Error('Persisted Bitcoin transaction graph was not found')
    }
    return graph
  }

  private async applyStatus(
    pending: Pick<AwaitingApprovalBitcoinTransfer, 'scope' | 'transactionId' | 'segmentId'>,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure'],
    observedAt = this.timestamp()
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:bitcoin:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt,
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.requireGraph(pending.scope, pending.transactionId, pending.segmentId)
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      if (!segment) throw new Error('Persisted Bitcoin transaction segment was not found')
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
      throw new Error(`Bitcoin transaction lifecycle update failed: ${result.status}`)
    }
    throw new Error('Bitcoin transaction lifecycle update conflicted twice')
  }

  private abandonReservation(reservation: BitcoinChangeReservation | null): Promise<void> {
    if (reservation === null) return Promise.resolve()
    return this.changeReservations
      .abandon(
        {
          chainAccount: reservation.chainAccount,
          accountIndex: reservation.accountIndex,
          addressType: reservation.addressType
        },
        reservation.transactionId
      )
      .then(() => {})
  }

  private commitReservation(reservation: BitcoinChangeReservation | null): Promise<void> {
    if (reservation === null) return Promise.resolve()
    return this.changeReservations
      .commit(
        {
          chainAccount: reservation.chainAccount,
          accountIndex: reservation.accountIndex,
          addressType: reservation.addressType
        },
        reservation.transactionId
      )
      .then(() => {})
  }

  private releaseInputs(reservation: BitcoinInputReservation): Promise<void> {
    return this.inputReservations.release(
      {
        chainAccount: reservation.chainAccount,
        accountIndex: reservation.accountIndex,
        addressType: reservation.addressType
      },
      reservation.transactionId
    )
  }

  private commitInputs(reservation: BitcoinInputReservation): Promise<void> {
    return this.inputReservations
      .commit({
        chainAccount: reservation.chainAccount,
        accountIndex: reservation.accountIndex,
        addressType: reservation.addressType,
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
    pending: PendingBitcoinSigningTransfer,
    signal?: AbortSignal
  ): Promise<void> {
    return pending.signingExecution.kind === 'external'
      ? Promise.resolve()
      : this.cancelSigning(pending.scope.keyDomainId, pending.signingCommandId, signal)
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Bitcoin transfer timestamp')
    }
    return value
  }
}
