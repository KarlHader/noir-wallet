import { Buffer } from 'buffer'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, Transaction } from 'bitcoinjs-lib'
import { assertDashHardwareSignedTransactionMatchesReview } from '@/lib/ledger/dash-model'
import {
  parseAccountId,
  parseAccountIndex,
  parseChainAccountId,
  type ChainAccount,
  type ChainAccountId
} from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { parseKeyDomainId, parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import {
  applyTransactionGraphEvent,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegmentEvent,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import { parseStorageV2ChainAccount } from '@/infrastructure/persistence/schema'
import type { TransactionRepository } from '@/ports/repositories'
import { DashRpcError } from './dash-insight-codecs'
import {
  DASH_CHANGE_RESERVATION_TTL_MS,
  parseDashChangeReservation,
  type DashChangeReservation,
  type DashChangeReservationRepository
} from './dash-change-reservation-model'
import {
  hasExactKeys,
  parseDashDiscoveryScope,
  type DashDiscoveryScope
} from './dash-discovery-model'
import {
  parseDashInputReservation,
  type DashInputReservation,
  type DashInputReservationRepository
} from './dash-input-reservation-model'
import { finalizeDashPsbt } from './dash-psbt-finalizer'
import {
  assertDashSigningSummaryMatchesPrepared,
  computeDashSigningPayloadFingerprint,
  createDashSigningSummary,
  parsePreparedDashPsbt
} from './dash-prepared-psbt-validator'
import {
  DASH_REQUIRED_CONFIRMATIONS,
  DashTransactionBuildError,
  failInvalidDashTransaction,
  isPlainRecord,
  parseDashChain,
  parseDashRecipient,
  type PreparedDashPsbt
} from './dash-transaction-model'
import {
  ChromeSessionPendingTransactionStore,
  type SessionStorageArea
} from '../pending-transaction-store'
import {
  hasReachedTransactionStatus,
  persistSignedTransactionGraph,
  transitionPendingTransactionGraph
} from '../pending-transaction-graph'

const APPROVAL_TTL_MS = DASH_CHANGE_RESERVATION_TTL_MS
const AMBIGUOUS_BROADCAST = new Set([
  'timeout',
  'network-unavailable',
  'rate-limited',
  'cancelled',
  'invalid-response'
])
const REJECTED_BROADCAST = new Set(['unauthorized', 'chain-mismatch'])

export interface DashTransferSigningPort {
  readonly prepare: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    payload: {
      readonly kind: 'dash-psbt'
      readonly chainId: ChainId
      readonly accountIndex: number
      readonly psbt: string
    },
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
  ) => Promise<boolean>
}

export interface DashTransferAuthorization {
  readonly chainAccountId: ChainAccountId
  readonly credentialGenerationId: string
  readonly chainId: string
  readonly accountIndex: number
}

export interface PrepareDashTransferInput {
  readonly chainAccount: ChainAccount
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly prepared: PreparedDashPsbt
  readonly signerAddress: string
  readonly changeReservation: DashChangeReservation | null
  readonly inputReservation: DashInputReservation
  readonly authorization: DashTransferAuthorization
  readonly signingMode?: 'internal' | 'ledger'
  readonly signal?: AbortSignal
}

export interface PreparedDashTransferApproval {
  readonly graph: TransactionGraph
  readonly signing: PreparedSigningCommand
}

export interface ContinueDashTransferInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly signal?: AbortSignal
}

export interface ApproveDashTransferInput extends ContinueDashTransferInput {
  readonly payloadFingerprint: string
  readonly authorization: DashTransferAuthorization
}

export interface SubmitLedgerDashSignatureInput extends ApproveDashTransferInput {
  readonly signedTransactionHex: string
}

export interface DashTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

interface PendingBase {
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
  readonly chainAccountId: ChainAccountId
  readonly requiredConfirmations: number
  readonly changeReservation: DashChangeReservation | null
  readonly inputReservation: DashInputReservation
  readonly authorization: DashTransferAuthorization
}

interface AwaitingDashApproval extends PendingBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedDashPsbt
  readonly signer: string
  readonly signingSummary: SigningSummary
  readonly signingCommandId: SigningCommandId
  readonly payloadFingerprint: string
  readonly expiresAt: number
  readonly signingMode?: 'ledger'
}

interface SignedDashTransfer extends PendingBase {
  readonly phase: 'signed'
  readonly rawTransactionHex: string
  readonly transactionHash: string
  readonly signedAt: number
}

type PendingDashTransfer = AwaitingDashApproval | SignedDashTransfer

export interface DashPendingTransferStore {
  get(transactionId: TransactionId): Promise<PendingDashTransfer | null>
  getReviewGraph(transactionId: TransactionId): Promise<TransactionGraph | null>
  put(record: PendingDashTransfer, graph: TransactionGraph | null): Promise<void>
  delete(transactionId: TransactionId): Promise<void>
  list(): Promise<readonly PendingDashTransfer[]>
}

export class MemoryDashPendingTransferStore implements DashPendingTransferStore {
  private readonly records = new Map<string, PendingDashTransfer>()
  private readonly graphs = new Map<string, TransactionGraph>()

  async get(transactionId: TransactionId): Promise<PendingDashTransfer | null> {
    return this.records.get(transactionId) ?? null
  }

  async getReviewGraph(transactionId: TransactionId): Promise<TransactionGraph | null> {
    return this.graphs.get(transactionId) ?? null
  }

  async put(record: PendingDashTransfer, graph: TransactionGraph | null): Promise<void> {
    this.records.set(record.transactionId, record)
    if (graph) this.graphs.set(record.transactionId, graph)
  }

  async delete(transactionId: TransactionId): Promise<void> {
    this.records.delete(transactionId)
    this.graphs.delete(transactionId)
  }

  async list(): Promise<readonly PendingDashTransfer[]> {
    return Object.freeze([...this.records.values()])
  }
}

export function createChromeSessionDashPendingTransferStore(
  storage: SessionStorageArea
): DashPendingTransferStore {
  const inner = new ChromeSessionPendingTransactionStore<PendingDashTransfer>({
    storage,
    recordKeyPrefix: 'dash_pending_transfer:',
    reviewGraphKeyPrefix: 'dash_pending_review_graph:',
    parseRecord: parseStoredPending,
    label: 'Dash'
  })
  return {
    get: transactionId => inner.get(transactionId),
    getReviewGraph: transactionId => inner.getReviewGraph(transactionId),
    put: (record, graph) => inner.put(record, graph ?? undefined),
    delete: transactionId => inner.delete(transactionId),
    list: () => inner.list()
  }
}

let dashEccReady = false

function ensureDashPsbtEcc(): void {
  if (dashEccReady) return
  initEccLib(secp256k1)
  dashEccReady = true
}

function rejectPending(): never {
  throw new Error('Invalid pending Dash transfer')
}

function parsePendingScope(value: unknown): TransactionAccountScope {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['keyDomainId', 'accountId'])) rejectPending()
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function parsePendingAuthorization(value: unknown): DashTransferAuthorization {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['chainAccountId', 'credentialGenerationId', 'chainId', 'accountIndex']) ||
    typeof value.chainAccountId !== 'string' ||
    typeof value.credentialGenerationId !== 'string' ||
    value.credentialGenerationId.length === 0 ||
    value.credentialGenerationId.trim() !== value.credentialGenerationId
  ) {
    rejectPending()
  }
  return Object.freeze({
    chainAccountId: parseChainAccountId(value.chainAccountId),
    credentialGenerationId: value.credentialGenerationId,
    chainId: parseChainId(parseDashChain(value.chainId)).id,
    accountIndex: parseAccountIndex(value.accountIndex)
  })
}

function parsePendingTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) rejectPending()
  return value as number
}

function reservationScope(value: Record<string, unknown>): DashDiscoveryScope {
  return parseDashDiscoveryScope({
    chainAccount: parseStorageV2ChainAccount(value.chainAccount),
    accountIndex: parseAccountIndex(value.accountIndex)
  })
}

function parsePendingBase(value: Record<string, unknown>): PendingBase {
  const scope = parsePendingScope(value.scope)
  const transactionId = parseTransactionId(value.transactionId)
  const chainAccountId =
    typeof value.chainAccountId === 'string'
      ? parseChainAccountId(value.chainAccountId)
      : rejectPending()
  if (value.requiredConfirmations !== DASH_REQUIRED_CONFIRMATIONS) rejectPending()
  if (!isPlainRecord(value.inputReservation)) rejectPending()
  const inputScope = reservationScope(value.inputReservation)
  const inputReservation = parseDashInputReservation(value.inputReservation, inputScope)
  if (
    inputReservation.transactionId !== transactionId ||
    inputReservation.chainAccount.id !== chainAccountId ||
    inputReservation.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
    inputReservation.chainAccount.scope.accountId !== scope.accountId
  ) {
    rejectPending()
  }
  let changeReservation: DashChangeReservation | null = null
  if (value.changeReservation !== null) {
    if (!isPlainRecord(value.changeReservation)) rejectPending()
    const changeScope = reservationScope(value.changeReservation)
    changeReservation = parseDashChangeReservation(value.changeReservation, changeScope)
    if (
      changeReservation.transactionId !== transactionId ||
      (changeReservation.state !== 'reserved' && changeReservation.state !== 'committed') ||
      changeReservation.chainAccount.id !== chainAccountId ||
      changeReservation.network !== inputReservation.network ||
      changeReservation.imported !== inputReservation.imported
    ) {
      rejectPending()
    }
  }
  const authorization = parsePendingAuthorization(value.authorization)
  if (
    authorization.chainAccountId !== chainAccountId ||
    authorization.accountIndex !== inputReservation.accountIndex
  ) {
    rejectPending()
  }
  return Object.freeze({
    transactionId,
    segmentId: parseTransactionSegmentId(value.segmentId),
    scope,
    chainAccountId,
    requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS,
    changeReservation,
    inputReservation,
    authorization
  })
}

function parseStoredPrepared(value: unknown): PreparedDashPsbt {
  ensureDashPsbtEcc()
  return parsePreparedDashPsbt(value as unknown as PreparedDashPsbt).prepared
}

function parseStoredPending(value: unknown): PendingDashTransfer {
  if (!isPlainRecord(value)) rejectPending()
  if (value.phase === 'awaiting-approval') {
    if (
      !hasExactKeys(
        value,
        [
          'phase',
          'transactionId',
          'segmentId',
          'scope',
          'chainAccountId',
          'requiredConfirmations',
          'changeReservation',
          'inputReservation',
          'authorization',
          'prepared',
          'signer',
          'signingSummary',
          'signingCommandId',
          'payloadFingerprint',
          'expiresAt'
        ],
        ['signingMode']
      )
    ) {
      rejectPending()
    }
    const base = parsePendingBase(value)
    const prepared = parseStoredPrepared(value.prepared)
    if (
      prepared.chainId !== base.authorization.chainId ||
      prepared.accountIndex !== base.authorization.accountIndex ||
      prepared.imported !== base.inputReservation.imported
    ) {
      rejectPending()
    }
    const signer = parseDashRecipient(value.signer, prepared.chainId)
    const signingSummary = parseSigningSummary(value.signingSummary, {
      family: 'dash',
      chainId: prepared.chainId,
      operation: 'transaction'
    })
    assertDashSigningSummaryMatchesPrepared(prepared, signingSummary, signer)
    if (typeof value.signingCommandId !== 'string' || typeof value.payloadFingerprint !== 'string')
      rejectPending()
    if (!/^[0-9a-f]{64}$/.test(value.payloadFingerprint)) rejectPending()
    if (value.signingMode !== undefined && value.signingMode !== 'ledger') rejectPending()
    return Object.freeze({
      ...base,
      phase: 'awaiting-approval',
      prepared,
      signer,
      signingSummary,
      signingCommandId: parseSigningCommandId(value.signingCommandId),
      payloadFingerprint: value.payloadFingerprint,
      expiresAt: parsePendingTimestamp(value.expiresAt),
      ...(value.signingMode === 'ledger' ? { signingMode: 'ledger' as const } : {})
    })
  }
  if (value.phase === 'signed') {
    if (
      !hasExactKeys(value, [
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'chainAccountId',
        'requiredConfirmations',
        'changeReservation',
        'inputReservation',
        'authorization',
        'rawTransactionHex',
        'transactionHash',
        'signedAt'
      ])
    ) {
      rejectPending()
    }
    const base = parsePendingBase(value)
    if (
      typeof value.rawTransactionHex !== 'string' ||
      value.rawTransactionHex.length === 0 ||
      value.rawTransactionHex.length % 2 !== 0 ||
      !/^[0-9a-f]+$/.test(value.rawTransactionHex) ||
      typeof value.transactionHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.transactionHash)
    ) {
      rejectPending()
    }
    return Object.freeze({
      ...base,
      phase: 'signed',
      rawTransactionHex: value.rawTransactionHex,
      transactionHash: value.transactionHash,
      signedAt: parsePendingTimestamp(value.signedAt)
    })
  }
  return rejectPending()
}

function scopeOf(account: ChainAccount): TransactionAccountScope {
  return Object.freeze({
    keyDomainId: parseKeyDomainId(account.scope.keyDomainId),
    accountId: parseAccountId(account.scope.accountId)
  })
}

function scopesMatch(left: TransactionAccountScope, right: TransactionAccountScope): boolean {
  return left.keyDomainId === right.keyDomainId && left.accountId === right.accountId
}

function authorizationMatches(
  stored: DashTransferAuthorization,
  live: DashTransferAuthorization
): boolean {
  return (
    stored.chainAccountId === live.chainAccountId &&
    stored.credentialGenerationId === live.credentialGenerationId &&
    stored.chainId === live.chainId &&
    stored.accountIndex === live.accountIndex &&
    stored.credentialGenerationId.length > 0
  )
}

function createDashTransferGraph(input: {
  readonly prepared: PreparedDashPsbt
  readonly sender: string
  readonly scope: TransactionAccountScope
  readonly chainAccountId: ChainAccountId
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly assets: AssetRegistry
  readonly createdAt: number
}): TransactionGraph {
  const { prepared } = parsePreparedDashPsbt(input.prepared)
  const sender = parseDashRecipient(input.sender, prepared.chainId)
  const asset = input.assets.resolve(`${prepared.chainId}/slip44:5`)
  if (
    asset.asset.chainId !== prepared.chainId ||
    asset.asset.kind !== 'native' ||
    asset.metadata.decimals !== 8
  ) {
    throw new Error('Invalid Dash native asset definition')
  }
  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [input.segmentId],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: sender === prepared.recipient ? 'self' : 'outgoing',
        primaryAmount: { assetId: asset.asset.id, amountRaw: prepared.amountDuffs },
        feeLimit: { assetId: asset.asset.id, amountRaw: prepared.feeDuffs },
        sender: { chainId: prepared.chainId, address: sender },
        recipient: { chainId: prepared.chainId, address: prepared.recipient }
      }
    },
    segments: [
      {
        id: input.segmentId,
        transactionId: input.transactionId,
        role: 'origin',
        target: {
          kind: 'onchain',
          chainId: prepared.chainId,
          chainAccountId: input.chainAccountId
        },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        revision: 0
      }
    ]
  })
}

export class DashTransferOrchestrator {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(
    private readonly options: {
      readonly repository: TransactionRepository
      readonly pendingStore: DashPendingTransferStore
      readonly signer: DashTransferSigningPort
      readonly rpc: {
        readonly broadcastRawTransaction: (
          rawTransactionHex: string,
          signal?: AbortSignal
        ) => Promise<string>
        readonly getTransaction: (
          transactionId: string,
          signal?: AbortSignal
        ) => Promise<{ readonly transactionId: string }>
      }
      readonly assets: AssetRegistry
      readonly changeReservations: Pick<DashChangeReservationRepository, 'transition'>
      readonly inputReservations: Pick<DashInputReservationRepository, 'commit' | 'release'>
      readonly now?: () => number
      readonly createId?: () => string
    }
  ) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(input: PrepareDashTransferInput): Promise<PreparedDashTransferApproval> {
    const prepared = parsePreparedDashPsbt(input.prepared).prepared
    const scope = scopeOf(input.chainAccount)
    if (
      input.chainAccount.scope.chainId !== prepared.chainId ||
      input.chainAccount.id !== input.authorization.chainAccountId ||
      input.authorization.chainId !== prepared.chainId ||
      input.authorization.accountIndex !== prepared.accountIndex ||
      input.authorization.credentialGenerationId.length === 0
    ) {
      failInvalidDashTransaction('Dash transfer authorization does not match the review')
    }
    const signer = parseDashRecipient(input.signerAddress, prepared.chainId)
    const discoveryScope = parseDashDiscoveryScope({
      chainAccount: input.chainAccount,
      accountIndex: parseAccountIndex(prepared.accountIndex)
    })
    if (discoveryScope.imported !== prepared.imported) {
      failInvalidDashTransaction('Dash account type does not match the prepared transfer')
    }
    const changeReservation = normalizeChange(
      input.changeReservation,
      discoveryScope,
      input.transactionId,
      prepared
    )
    const inputReservation = normalizeInputs(
      input.inputReservation,
      discoveryScope,
      input.transactionId,
      prepared
    )
    const summary = createDashSigningSummary(prepared, signer)
    assertDashSigningSummaryMatchesPrepared(prepared, summary, signer)
    const fingerprint = await computeDashSigningPayloadFingerprint(prepared.psbtBase64)
    const createdAt = this.timestamp()
    const ledger = input.signingMode === 'ledger'
    const signing = ledger
      ? Object.freeze({
          commandId: parseSigningCommandId(`signing-command:ledger-dash:${this.createId()}`),
          chainId: parseChainId(prepared.chainId).id,
          operation: 'transaction' as const,
          summary,
          payloadFingerprint: Object.freeze({
            algorithm: 'sha256' as const,
            digestHex: fingerprint
          }),
          execution: Object.freeze({
            kind: 'external' as const,
            request: Object.freeze({
              encoding: 'base64' as const,
              value: prepared.psbtBase64
            })
          }),
          expiresAt: createdAt + APPROVAL_TTL_MS
        })
      : await this.options.signer.prepare(
          scope.keyDomainId,
          {
            kind: 'dash-psbt',
            chainId: parseChainId(prepared.chainId).id,
            accountIndex: prepared.accountIndex,
            psbt: prepared.psbtBase64
          },
          input.signal
        )
    if (
      summary.schema !== 'dash.psbt.v1' ||
      signing.summary.schema !== 'dash.psbt.v1' ||
      signing.payloadFingerprint.digestHex.length !== 64
    ) {
      if (!ledger) await this.cancelSigning(scope, signing.commandId, input.signal)
      throw new Error('Dash signer did not return a PSBT review')
    }
    try {
      assertDashSigningSummaryMatchesPrepared(prepared, signing.summary, signer)
    } catch (error) {
      if (!ledger) await this.cancelSigning(scope, signing.commandId, input.signal)
      throw error
    }
    if (fingerprint !== signing.payloadFingerprint.digestHex) {
      if (!ledger) await this.cancelSigning(scope, signing.commandId, input.signal)
      throw new Error('Dash signing payload fingerprint does not match the reviewed PSBT')
    }
    const graph = createDashTransferGraph({
      prepared,
      sender: signer,
      scope,
      chainAccountId: input.chainAccount.id,
      transactionId: input.transactionId,
      segmentId: input.segmentId,
      assets: this.options.assets,
      createdAt
    })
    const pending: AwaitingDashApproval = Object.freeze({
      phase: 'awaiting-approval',
      transactionId: input.transactionId,
      segmentId: input.segmentId,
      scope,
      chainAccountId: input.chainAccount.id,
      requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS,
      changeReservation,
      inputReservation,
      authorization: Object.freeze({ ...input.authorization }),
      prepared,
      signer,
      signingSummary: signing.summary,
      signingCommandId: signing.commandId,
      payloadFingerprint: fingerprint,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      ...(ledger ? { signingMode: 'ledger' as const } : {})
    })
    await this.options.pendingStore.put(pending, graph)
    return Object.freeze({ graph, signing })
  }

  async approve(input: ApproveDashTransferInput): Promise<DashTransferSubmission> {
    const pending = await this.requireAwaiting(input)
    if (pending.signingMode === 'ledger') {
      throw new Error('Dash Ledger transfers are signed on the device')
    }
    if (!authorizationMatches(pending.authorization, input.authorization)) {
      throw new Error('Dash transfer authorization changed after review')
    }
    if (input.payloadFingerprint !== pending.payloadFingerprint) {
      throw new Error('Dash approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaiting(pending, input.signal, 'expired')
      throw new Error('Dash signing request expired')
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.integrityMatches(pending, graph))) {
      await this.failAwaiting(pending, input.signal, 'integrity-failure')
      throw new Error('Pending Dash transfer integrity check failed')
    }
    const approved = this.transition(pending, graph, 'approved')
    await this.options.pendingStore.put(pending, approved)
    let signed: SigningResult
    try {
      signed = await this.options.signer.confirm(
        pending.scope.keyDomainId,
        pending.signingCommandId,
        input.signal
      )
    } catch (error) {
      throw error
    }
    let finalized: ReturnType<typeof finalizeDashPsbt>
    try {
      if (signed.kind !== 'signed-payload' || signed.payload.encoding !== 'base64') {
        throw new Error('Dash signer did not return a PSBT')
      }
      finalized = finalizeDashPsbt({
        prepared: pending.prepared,
        signedPsbtBase64: signed.payload.value
      })
    } catch {
      await this.failAwaiting(pending, input.signal, 'integrity-failure')
      throw new Error('Signed Dash transaction failed integrity validation')
    }
    const signedPending: SignedDashTransfer = Object.freeze({
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      chainAccountId: pending.chainAccountId,
      requiredConfirmations: pending.requiredConfirmations,
      changeReservation: pending.changeReservation,
      inputReservation: pending.inputReservation,
      authorization: pending.authorization,
      rawTransactionHex: finalized.rawTransactionHex,
      transactionHash: finalized.transactionId,
      signedAt: this.timestamp()
    })
    const signedGraph = this.transition(signedPending, approved, 'signed', {
      transactionHash: finalized.transactionId,
      requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS
    })
    await this.options.pendingStore.put(signedPending, signedGraph)
    const persisted = await this.persistSigned(signedPending, signedGraph)
    return this.broadcast(signedPending, input.signal, persisted)
  }

  async getLedgerPsbt(input: ContinueDashTransferInput): Promise<string> {
    const pending = await this.requireAwaiting(input)
    if (pending.signingMode !== 'ledger') {
      throw new Error('Dash transfer is not awaiting a Ledger signature')
    }
    return pending.prepared.psbtBase64
  }

  async submitLedgerSignature(
    input: SubmitLedgerDashSignatureInput
  ): Promise<DashTransferSubmission> {
    const pending = await this.requireAwaiting(input)
    if (pending.signingMode !== 'ledger') {
      throw new Error('Dash transfer is not awaiting a Ledger signature')
    }
    if (!authorizationMatches(pending.authorization, input.authorization)) {
      throw new Error('Dash transfer authorization changed after review')
    }
    if (input.payloadFingerprint !== pending.payloadFingerprint) {
      throw new Error('Dash approval payload fingerprint does not match')
    }
    if (this.timestamp() >= pending.expiresAt) {
      await this.failAwaiting(pending, input.signal, 'expired')
      throw new Error('Dash signing request expired')
    }
    const graph = await this.requireReviewGraph(pending)
    if (!(await this.integrityMatches(pending, graph))) {
      await this.failAwaiting(pending, input.signal, 'integrity-failure')
      throw new Error('Pending Dash transfer integrity check failed')
    }
    let transactionHash: string
    try {
      assertDashHardwareSignedTransactionMatchesReview(
        pending.prepared.psbtBase64,
        input.signedTransactionHex,
        pending.prepared.chainId
      )
      transactionHash = Transaction.fromHex(input.signedTransactionHex).getId()
    } catch {
      await this.failAwaiting(pending, input.signal, 'integrity-failure')
      throw new Error('Signed Dash transaction failed integrity validation')
    }
    const approved = this.transition(pending, graph, 'approved')
    await this.options.pendingStore.put(pending, approved)
    const signedPending: SignedDashTransfer = Object.freeze({
      phase: 'signed',
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      scope: pending.scope,
      chainAccountId: pending.chainAccountId,
      requiredConfirmations: pending.requiredConfirmations,
      changeReservation: pending.changeReservation,
      inputReservation: pending.inputReservation,
      authorization: pending.authorization,
      rawTransactionHex: input.signedTransactionHex,
      transactionHash,
      signedAt: this.timestamp()
    })
    const signedGraph = this.transition(signedPending, approved, 'signed', {
      transactionHash,
      requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS
    })
    await this.options.pendingStore.put(signedPending, signedGraph)
    const persisted = await this.persistSigned(signedPending, signedGraph)
    return this.broadcast(signedPending, input.signal, persisted)
  }

  async reject(input: ContinueDashTransferInput): Promise<TransactionGraph> {
    const pending = await this.requireAwaiting(input)
    const graph = await this.requireReviewGraph(pending)
    const failed = this.transition(pending, graph, 'failed', undefined, {
      code: 'user-rejected',
      occurredAt: this.timestamp()
    })
    await this.releaseAll(pending, input.signal)
    await this.options.pendingStore.delete(pending.transactionId)
    return failed
  }

  async resumeBroadcast(input: ContinueDashTransferInput): Promise<DashTransferSubmission> {
    const pending = await this.options.pendingStore.get(parseTransactionId(input.transactionId))
    if (!pending || pending.phase !== 'signed' || !scopesMatch(pending.scope, input.scope)) {
      throw new Error('Signed Dash transfer was not found')
    }
    return this.broadcast(pending, input.signal)
  }

  async cancelAllAwaitingApprovals(signal?: AbortSignal): Promise<number> {
    const pending = (await this.options.pendingStore.list()).filter(
      (candidate): candidate is AwaitingDashApproval => candidate.phase === 'awaiting-approval'
    )
    for (const candidate of pending) {
      await this.reject({
        scope: candidate.scope,
        transactionId: candidate.transactionId,
        signal
      }).catch(() => undefined)
    }
    return pending.length
  }

  async listSignedPending(): Promise<readonly SignedDashTransfer[]> {
    return Object.freeze(
      (await this.options.pendingStore.list()).filter(
        (pending): pending is SignedDashTransfer => pending.phase === 'signed'
      )
    )
  }

  async getPendingApproval(
    input: ContinueDashTransferInput
  ): Promise<PreparedDashTransferApproval | null> {
    const pending = await this.options.pendingStore.get(parseTransactionId(input.transactionId))
    if (
      !pending ||
      pending.phase !== 'awaiting-approval' ||
      !scopesMatch(pending.scope, input.scope)
    )
      return null
    const graph = await this.requireReviewGraph(pending)
    return Object.freeze({
      graph,
      signing: {
        commandId: pending.signingCommandId,
        chainId: parseChainId(pending.prepared.chainId).id,
        operation: 'transaction' as const,
        summary: pending.signingSummary,
        payloadFingerprint: { algorithm: 'sha256' as const, digestHex: pending.payloadFingerprint },
        execution: { kind: 'internal' as const },
        expiresAt: pending.expiresAt
      }
    })
  }

  private async broadcast(
    pending: SignedDashTransfer,
    signal?: AbortSignal,
    currentGraph?: TransactionGraph
  ): Promise<DashTransferSubmission> {
    const signedGraph = await this.persistSigned(pending, currentGraph)
    let accepted = false
    let rejected = false
    try {
      const txid = await this.options.rpc.broadcastRawTransaction(pending.rawTransactionHex, signal)
      if (txid !== pending.transactionHash) rejected = true
      else accepted = true
    } catch (error) {
      if (error instanceof DashRpcError && AMBIGUOUS_BROADCAST.has(error.code)) {
        accepted = await this.alreadyVisible(pending.transactionHash, signal)
      } else if (error instanceof DashRpcError && REJECTED_BROADCAST.has(error.code)) {
        rejected = true
      } else if (error instanceof DashRpcError && error.code === 'not-found') {
        accepted = false
      } else {
        accepted = await this.alreadyVisible(pending.transactionHash, signal)
      }
    }
    if (rejected) {
      await this.applyStatus(pending, 'failed', undefined, {
        code: 'relay-failed',
        occurredAt: this.timestamp()
      })
      await this.releaseReservations(pending)
      await this.options.pendingStore.delete(pending.transactionId)
      throw new DashTransactionBuildError(
        'broadcast-rejected',
        'Dash network rejected the transaction'
      )
    }
    if (!accepted) {
      return Object.freeze({ status: 'signed-pending-broadcast', graph: signedGraph })
    }
    const graph = await this.applyStatus(pending, 'broadcast', {
      transactionHash: pending.transactionHash,
      confirmations: 0,
      requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS
    })
    await this.commitReservations(pending)
    await this.options.pendingStore.delete(pending.transactionId)
    return Object.freeze({ status: 'broadcast', graph })
  }

  private async alreadyVisible(transactionId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const seen = await this.options.rpc.getTransaction(transactionId, signal)
      return seen.transactionId === transactionId
    } catch (error) {
      if (
        error instanceof DashRpcError &&
        (error.code === 'not-found' || AMBIGUOUS_BROADCAST.has(error.code))
      ) {
        return false
      }
      return false
    }
  }

  private async requireAwaiting(input: ContinueDashTransferInput): Promise<AwaitingDashApproval> {
    const pending = await this.options.pendingStore.get(parseTransactionId(input.transactionId))
    if (
      !pending ||
      pending.phase !== 'awaiting-approval' ||
      !scopesMatch(pending.scope, input.scope)
    ) {
      throw new Error('Pending Dash transfer was not found')
    }
    return pending
  }

  private async requireReviewGraph(pending: PendingDashTransfer): Promise<TransactionGraph> {
    const graph = await this.options.pendingStore.getReviewGraph(pending.transactionId)
    if (!graph) throw new Error('Pending Dash review graph was not found')
    return graph
  }

  private async integrityMatches(
    pending: AwaitingDashApproval,
    graph: TransactionGraph
  ): Promise<boolean> {
    try {
      assertDashSigningSummaryMatchesPrepared(
        pending.prepared,
        pending.signingSummary,
        pending.signer
      )
      const fingerprint = await computeDashSigningPayloadFingerprint(pending.prepared.psbtBase64)
      const intent = graph.root.intent
      const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
      return (
        fingerprint === pending.payloadFingerprint &&
        graph.root.id === pending.transactionId &&
        scopesMatch(graph.root.scope, pending.scope) &&
        intent?.primaryAmount?.amountRaw === pending.prepared.amountDuffs &&
        intent.feeLimit?.amountRaw === pending.prepared.feeDuffs &&
        intent.recipient?.address === pending.prepared.recipient &&
        intent.recipient.chainId === pending.prepared.chainId &&
        intent.sender?.chainId === pending.prepared.chainId &&
        segment?.target.kind === 'onchain' &&
        segment.target.chainId === pending.prepared.chainId
      )
    } catch {
      return false
    }
  }

  private transition(
    pending: PendingBase,
    graph: TransactionGraph,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure']
  ): TransactionGraph {
    return transitionPendingTransactionGraph({
      reference: pending,
      graph,
      status,
      eventId: `event:dash:${this.createId()}`,
      observedAt: this.timestamp(),
      evidence,
      failure,
      label: 'Dash'
    })
  }

  private async persistSigned(
    pending: SignedDashTransfer,
    currentGraph?: TransactionGraph
  ): Promise<TransactionGraph> {
    return persistSignedTransactionGraph({
      repository: this.options.repository,
      reference: pending,
      currentGraph,
      loadReviewGraph: () => this.requireReviewGraph(pending),
      validateEvidence: segment =>
        segment.evidence?.transactionHash === pending.transactionHash &&
        segment.evidence.requiredConfirmations === DASH_REQUIRED_CONFIRMATIONS,
      label: 'Dash'
    })
  }

  private async applyStatus(
    pending: PendingBase,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure']
  ): Promise<TransactionGraph> {
    const event: TransactionSegmentEvent = Object.freeze({
      id: parseTransactionEventId(`event:dash:${this.createId()}`),
      status,
      cause: status === 'failed' ? 'failure' : 'progress',
      observedAt: this.timestamp(),
      ...(evidence === undefined ? {} : { evidence }),
      ...(failure === undefined ? {} : { failure })
    })
    const graph = await this.options.repository.get(pending.scope, pending.transactionId)
    if (!graph) throw new Error('Persisted Dash transaction graph was not found')
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    if (!segment) throw new Error('Persisted Dash transaction segment was not found')
    if (segment.status === 'final' || segment.status === 'failed') return graph
    if (status !== 'failed' && hasReachedTransactionStatus(segment.status, status)) {
      return graph
    }
    const next = applyTransactionGraphEvent(graph, pending.segmentId, event)
    const result = await this.options.repository.applySegmentEvent({
      scope: pending.scope,
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      event,
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    if (result.status === 'applied' || result.status === 'duplicate-event')
      return result.graph ?? next
    throw new Error(`Dash transaction lifecycle update failed: ${result.status}`)
  }

  private async commitReservations(pending: PendingBase): Promise<void> {
    const now = this.timestamp()
    await this.options.inputReservations.commit({
      chainAccount: pending.inputReservation.chainAccount,
      accountIndex: pending.inputReservation.accountIndex,
      network: pending.inputReservation.network,
      imported: pending.inputReservation.imported,
      transactionId: pending.inputReservation.transactionId,
      now
    })
    if (pending.changeReservation) {
      await this.options.changeReservations.transition({
        chainAccount: pending.changeReservation.chainAccount,
        accountIndex: pending.changeReservation.accountIndex,
        network: pending.changeReservation.network,
        imported: pending.changeReservation.imported,
        transactionId: pending.changeReservation.transactionId,
        state: 'committed',
        now
      })
    }
  }

  private async releaseReservations(pending: PendingBase): Promise<void> {
    await this.options.inputReservations.release(
      {
        chainAccount: pending.inputReservation.chainAccount,
        accountIndex: pending.inputReservation.accountIndex
      },
      pending.inputReservation.transactionId
    )
    if (pending.changeReservation) {
      await this.options.changeReservations.transition({
        chainAccount: pending.changeReservation.chainAccount,
        accountIndex: pending.changeReservation.accountIndex,
        network: pending.changeReservation.network,
        imported: pending.changeReservation.imported,
        transactionId: pending.changeReservation.transactionId,
        state: 'abandoned',
        now: this.timestamp()
      })
    }
  }

  private async failAwaiting(
    pending: AwaitingDashApproval,
    signal: AbortSignal | undefined,
    _reason: string
  ): Promise<void> {
    if (pending.signingMode !== 'ledger') {
      await this.cancelSigning(pending.scope, pending.signingCommandId, signal)
    }
    await this.releaseReservations(pending)
    await this.options.pendingStore.delete(pending.transactionId)
  }

  private async releaseAll(pending: AwaitingDashApproval, signal?: AbortSignal): Promise<void> {
    if (pending.signingMode !== 'ledger') {
      await this.cancelSigning(pending.scope, pending.signingCommandId, signal)
    }
    await this.releaseReservations(pending)
  }

  private async cancelSigning(
    scope: TransactionAccountScope,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<void> {
    await this.options.signer.cancel(scope.keyDomainId, commandId, signal).catch(() => undefined)
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid Dash transfer timestamp')
    return value
  }
}

function normalizeChange(
  value: DashChangeReservation | null,
  scope: DashDiscoveryScope,
  transactionId: TransactionId,
  prepared: PreparedDashPsbt
): DashChangeReservation | null {
  if (prepared.changeAddress === null) {
    if (value !== null)
      failInvalidDashTransaction('Dash transfer without change cannot retain a change reservation')
    return null
  }
  const reservation = parseDashChangeReservation(value, scope)
  if (
    reservation.transactionId !== transactionId ||
    reservation.state !== 'reserved' ||
    reservation.address?.address !== prepared.changeAddress ||
    reservation.address.derivationPath !== prepared.changeDerivationPath
  ) {
    failInvalidDashTransaction('Dash change reservation does not match the prepared transfer')
  }
  return reservation
}

function normalizeInputs(
  value: DashInputReservation,
  scope: DashDiscoveryScope,
  transactionId: TransactionId,
  prepared: PreparedDashPsbt
): DashInputReservation {
  const reservation = parseDashInputReservation(value, scope)
  const psbt = parsePreparedDashPsbt(prepared).psbt
  const expected = psbt.txInputs
    .map(input => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`)
    .sort()
  const actual = reservation.outpoints
    .map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
    .sort()
  if (
    reservation.transactionId !== transactionId ||
    reservation.state !== 'reserved' ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    failInvalidDashTransaction('Dash input reservation does not match the prepared transfer')
  }
  return reservation
}
