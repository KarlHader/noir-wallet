import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveSolanaRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseSigningCommandId, type SigningCommandId } from '@/core/keyring/ports'
import type {
  RheaSwapService,
  RheaSwapSignedOrderResult,
  RheaSwapSolanaTransactionPlan,
  RheaSwapSolanaTransactionReview
} from '@/core/services/rhea-swap'
import {
  createRheaSwapSignedSourceGraph,
  parseRheaSwapTransactionBinding,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type RheaSwapTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import {
  createConfiguredSolanaRpcClient,
  parseSolanaPublicKey
} from '@/infrastructure/chains/solana'
import {
  parseBase58Bytes,
  parseCanonicalBase64
} from '@/infrastructure/chains/solana/solana-rpc-codecs'
import type {
  SolanaBroadcastRpc,
  SolanaReadRpc
} from '@/infrastructure/chains/solana/solana-rpc-types'
import type { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import type { TransactionRepository } from '@/ports/repositories'
import { SolanaMultichainSigningClient as SolanaSigner } from '@/infrastructure/keyring/multichain/solana-signing-client'
import { credentialSession } from './credential-session'
import { solanaLedgerSigningBridge } from './ledger-signing-bridge'
import {
  loadActiveSolanaTransferContext,
  type ActiveSolanaTransferContext
} from './solana-transfer'
import { RHEA_SWAP_TRANSACTION_MONITOR_ALARM } from './rhea-swap-transaction-monitor'
import { SOLANA_TRANSACTION_MONITOR_ALARM } from './solana-transaction-monitor'

const STORAGE_PREFIX = 'rhea_swap_solana:'

type PendingSolanaExecution = Readonly<{
  schemaVersion: 1
  quoteHandle: string
  executionId: string
  chainId: string
  sender: string
  scope: TransactionAccountScope
  commandId: SigningCommandId
  payloadFingerprint: string
  expiresAt: number
  graphSuffix: string
  graphCreatedAt: number
  binding: RheaSwapTransactionBinding
  ledgerTransaction?: string
  signedTransaction?: string
  sourceHash?: string
}>

export interface RheaSwapSolanaPendingStore {
  readonly get: (quoteHandle: string) => Promise<PendingSolanaExecution | null>
  readonly list: () => Promise<readonly PendingSolanaExecution[]>
  readonly put: (value: PendingSolanaExecution) => Promise<void>
  readonly delete: (quoteHandle: string) => Promise<void>
}

function readString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function parsePending(value: unknown): PendingSolanaExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored RHEA Swap Solana execution is invalid')
  }
  const record = value as Record<string, unknown>
  const required = [
    'schemaVersion',
    'quoteHandle',
    'executionId',
    'chainId',
    'sender',
    'scope',
    'commandId',
    'payloadFingerprint',
    'expiresAt',
    'graphSuffix',
    'graphCreatedAt',
    'binding'
  ]
  const allowed = new Set([...required, 'ledgerTransaction', 'signedTransaction', 'sourceHash'])
  if (
    record.schemaVersion !== 1 ||
    required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !allowed.has(key)) ||
    !record.scope ||
    typeof record.scope !== 'object' ||
    Array.isArray(record.scope) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0 ||
    !Number.isSafeInteger(record.graphCreatedAt) ||
    (record.graphCreatedAt as number) < 0
  ) {
    throw new Error('Stored RHEA Swap Solana fields are invalid')
  }
  const scope = record.scope as Record<string, unknown>
  if (
    Object.keys(scope).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(scope, 'keyDomainId') ||
    !Object.prototype.hasOwnProperty.call(scope, 'accountId')
  ) {
    throw new Error('Stored RHEA Swap Solana scope is invalid')
  }
  const payloadFingerprint = readString(record.payloadFingerprint, 'Solana fingerprint', 64)
  if (!/^[0-9a-f]{64}$/.test(payloadFingerprint)) {
    throw new Error('Stored RHEA Swap Solana fingerprint is invalid')
  }
  const chainId = readString(record.chainId, 'Solana chain', 64)
  if (!chainId.startsWith('solana:')) throw new Error('Stored RHEA Swap Solana chain is invalid')
  const sender = parseSolanaPublicKey(readString(record.sender, 'Solana sender', 64))
  const ledgerTransaction =
    record.ledgerTransaction === undefined
      ? undefined
      : readString(record.ledgerTransaction, 'Ledger Solana transaction', 2_464)
  if (ledgerTransaction !== undefined)
    parseCanonicalBase64(ledgerTransaction, 1_232, 'Ledger Solana transaction')
  const signedTransaction =
    record.signedTransaction === undefined
      ? undefined
      : readString(record.signedTransaction, 'Signed Solana transaction', 2_464)
  if (signedTransaction !== undefined) {
    parseCanonicalBase64(signedTransaction, 1_232, 'Signed Solana transaction')
  }
  const sourceHash =
    record.sourceHash === undefined
      ? undefined
      : parseBase58Bytes(record.sourceHash, 64, 'Solana transaction signature')
  if ((signedTransaction === undefined) !== (sourceHash === undefined)) {
    throw new Error('Stored RHEA Swap Solana signed evidence is incomplete')
  }
  return Object.freeze({
    schemaVersion: 1,
    quoteHandle: readString(record.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(record.executionId, 'RHEA Swap execution ID', 160),
    chainId,
    sender,
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(scope.keyDomainId),
      accountId: parseAccountId(scope.accountId)
    }),
    commandId: parseSigningCommandId(
      readString(record.commandId, 'RHEA Swap Solana signing command', 128)
    ),
    payloadFingerprint,
    expiresAt: record.expiresAt as number,
    graphSuffix: readString(record.graphSuffix, 'RHEA Swap Solana graph suffix', 80),
    graphCreatedAt: record.graphCreatedAt as number,
    binding: parseRheaSwapTransactionBinding(record.binding),
    ...(ledgerTransaction === undefined ? {} : { ledgerTransaction }),
    ...(signedTransaction === undefined ? {} : { signedTransaction, sourceHash })
  })
}

export class ChromeSessionRheaSwapSolanaStore implements RheaSwapSolanaPendingStore {
  async get(quoteHandle: string): Promise<PendingSolanaExecution | null> {
    const key = this.key(quoteHandle)
    const value = (await chrome.storage.session.get(key))[key]
    return value === undefined ? null : parsePending(value)
  }

  async list(): Promise<readonly PendingSolanaExecution[]> {
    return Object.entries(await chrome.storage.session.get(null))
      .filter(([key]) => key.startsWith(STORAGE_PREFIX))
      .map(([, value]) => parsePending(value))
  }

  async put(value: PendingSolanaExecution): Promise<void> {
    const parsed = parsePending(value)
    await chrome.storage.session.set({ [this.key(parsed.quoteHandle)]: parsed })
  }

  async delete(quoteHandle: string): Promise<void> {
    await chrome.storage.session.remove(this.key(quoteHandle))
  }

  private key(quoteHandle: string): string {
    return `${STORAGE_PREFIX}${encodeURIComponent(readString(quoteHandle, 'RHEA Swap quote handle', 160))}`
  }
}

export interface RheaSwapSolanaCoordinatorOptions {
  readonly service: Pick<
    RheaSwapService,
    'readSolanaTransactionPlan' | 'recordTransactionSubmission' | 'reportSubmission' | 'discard'
  >
  readonly signer: Pick<SolanaMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly rpc: Pick<SolanaBroadcastRpc, 'broadcastSignedTransaction'> &
    Pick<SolanaReadRpc, 'getSignatureStatus'>
  readonly pending: RheaSwapSolanaPendingStore
  readonly repository: Pick<TransactionRepository, 'create' | 'get' | 'applySegmentEvent'>
  readonly loadContext: () => Promise<ActiveSolanaTransferContext | null>
  readonly scheduleMonitoring: () => Promise<void>
  readonly now?: () => number
  readonly createId?: () => string
}

export class RheaSwapSolanaCoordinator {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly confirming = new Set<string>()

  constructor(private readonly options: RheaSwapSolanaCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(
    quoteHandle: string,
    bindingValue: unknown
  ): Promise<RheaSwapSolanaTransactionReview> {
    const plan = await this.options.service.readSolanaTransactionPlan(quoteHandle)
    const binding = parseRheaSwapTransactionBinding(bindingValue)
    const { context, sender } = await this.loadSupportedContext()
    this.assertBinding(plan, binding, sender)
    if (plan.format.toLowerCase() !== 'base64') {
      throw new Error('RHEA Swap Solana transaction format is not supported')
    }
    const transactionBytes = parseCanonicalBase64(
      plan.transaction,
      1_232,
      'RHEA Swap Solana transaction'
    )
    if (
      plan.metadata.transactionSize !== null &&
      plan.metadata.transactionSize !== transactionBytes.byteLength
    ) {
      throw new Error('RHEA Swap Solana transaction size does not match its metadata')
    }
    const prepared = await this.options.signer.prepare(context.chainAccount.scope.keyDomainId, {
      kind: 'solana-transaction',
      chainId: context.chainAccount.scope.chainId,
      accountIndex: context.accountIndex,
      transaction: plan.transaction
    })
    if (
      (context.keyDomainSource.kind === 'hardware'
        ? context.keyDomainSource.vendor !== 'ledger' ||
          prepared.execution.kind !== 'external' ||
          prepared.execution.request.encoding !== 'base64' ||
          prepared.execution.request.value !== plan.transaction
        : prepared.execution.kind !== 'internal') ||
      prepared.summary.schema !== 'solana.transaction.v1' ||
      !prepared.summary.fields.requiredSigners.includes(sender) ||
      (plan.metadata.recentBlockhash !== null &&
        prepared.summary.fields.recentBlockhash !== plan.metadata.recentBlockhash) ||
      (plan.metadata.addressLookupTableAddresses.length > 0 &&
        JSON.stringify(prepared.summary.fields.addressTableLookups.map(item => item.accountKey)) !==
          JSON.stringify(plan.metadata.addressLookupTableAddresses))
    ) {
      await this.options.signer
        .cancel(context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new Error('RHEA Swap Solana transaction does not match the active Account or metadata')
    }
    const pending = parsePending({
      schemaVersion: 1,
      quoteHandle: plan.quoteHandle,
      executionId: plan.executionId,
      chainId: context.chainAccount.scope.chainId,
      sender,
      scope: {
        keyDomainId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      },
      commandId: prepared.commandId,
      payloadFingerprint: prepared.payloadFingerprint.digestHex,
      expiresAt: Math.min(prepared.expiresAt, binding.expiresAt),
      graphSuffix: this.createId(),
      graphCreatedAt: this.now(),
      binding,
      ...(context.keyDomainSource.kind === 'hardware'
        ? { ledgerTransaction: plan.transaction }
        : {})
    })
    try {
      await this.options.pending.put(pending)
    } catch (error) {
      await this.options.signer
        .cancel(context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw error
    }
    return Object.freeze({
      quoteHandle: plan.quoteHandle,
      executionId: plan.executionId,
      chainId: pending.chainId,
      sender,
      summary: prepared.summary,
      payloadFingerprint: prepared.payloadFingerprint.digestHex,
      expiresAt: pending.expiresAt
    })
  }

  async confirm(quoteHandle: string, fingerprint: string): Promise<RheaSwapSignedOrderResult> {
    if (this.confirming.has(quoteHandle))
      throw new Error('RHEA Swap Solana confirmation is already in progress')
    this.confirming.add(quoteHandle)
    try {
      return await this.confirmOnce(quoteHandle, fingerprint)
    } finally {
      this.confirming.delete(quoteHandle)
    }
  }

  private async confirmOnce(
    quoteHandle: string,
    fingerprint: string
  ): Promise<RheaSwapSignedOrderResult> {
    let pending = await this.requirePending(quoteHandle, fingerprint)
    const { context, sender } = await this.loadSupportedContext()
    if (
      sender !== pending.sender ||
      context.chainAccount.scope.chainId !== pending.chainId ||
      context.chainAccount.scope.keyDomainId !== pending.scope.keyDomainId ||
      context.chainAccount.scope.accountId !== pending.scope.accountId
    ) {
      throw new Error('The active Account changed before RHEA Swap signing')
    }
    if (!pending.signedTransaction || !pending.sourceHash) {
      const plan = await this.options.service.readSolanaTransactionPlan(quoteHandle)
      this.assertBinding(plan, pending.binding, sender)
      if (
        pending.ledgerTransaction !== undefined &&
        plan.transaction !== pending.ledgerTransaction
      ) {
        throw new Error('RHEA Swap Solana transaction changed after Ledger review')
      }
      const signed = await this.options.signer.confirm(pending.scope.keyDomainId, pending.commandId)
      if (
        signed.kind !== 'signed-payload' ||
        signed.payload.encoding !== 'base64' ||
        !signed.transactionId
      ) {
        throw new Error('RHEA Swap Solana signer returned an invalid transaction')
      }
      pending = parsePending({
        ...pending,
        signedTransaction: signed.payload.value,
        sourceHash: signed.transactionId
      })
      await this.options.pending.put(pending)
    }
    const signedTransaction = pending.signedTransaction
    const sourceHash = pending.sourceHash
    if (!signedTransaction || !sourceHash) {
      throw new Error('RHEA Swap Solana signed transaction was not persisted')
    }

    let graph = await this.persistSignedGraph(pending)
    const origin = graph.segments.find(segment => segment.role === 'origin')
    if (!origin) throw new Error('RHEA Swap Solana graph has no origin segment')
    if (
      origin.status !== 'broadcast' &&
      origin.status !== 'confirming' &&
      origin.status !== 'final'
    ) {
      let accepted = false
      try {
        accepted =
          (await this.options.rpc.broadcastSignedTransaction(signedTransaction)) === sourceHash
      } catch {
        const observed = await this.options.rpc.getSignatureStatus(sourceHash).catch(() => null)
        accepted = observed !== null && observed.status !== 'unknown'
      }
      if (!accepted) {
        await this.options.scheduleMonitoring().catch(() => {})
        throw new Error('RHEA Swap Solana transaction is signed and waiting to broadcast')
      }
      graph = await this.applyBroadcast(graph, sourceHash)
    }
    const submission = await this.options.service.recordTransactionSubmission(
      quoteHandle,
      sourceHash
    )
    await this.options.scheduleMonitoring()
    await this.options.service.reportSubmission(quoteHandle).catch(() => {})
    await this.options.pending.delete(quoteHandle)
    return Object.freeze({ submission, graph })
  }

  async cancel(quoteHandle: string): Promise<void> {
    const pending = await this.options.pending.get(quoteHandle)
    if (pending && !pending.signedTransaction) {
      await this.options.signer.cancel(pending.scope.keyDomainId, pending.commandId).catch(() => {})
      await this.options.pending.delete(quoteHandle)
      await this.options.service.discard(quoteHandle).catch(() => {})
    }
  }

  async recoverSigned(): Promise<number> {
    const pending = (await this.options.pending.list()).filter(value => value.signedTransaction)
    const results = await Promise.allSettled(
      pending.map(value => this.confirm(value.quoteHandle, value.payloadFingerprint))
    )
    return results.filter(result => result.status === 'fulfilled').length
  }

  private async requirePending(
    quoteHandle: string,
    fingerprint: string
  ): Promise<PendingSolanaExecution> {
    const pending = await this.options.pending.get(quoteHandle)
    if (
      !pending ||
      pending.payloadFingerprint !== fingerprint ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      (pending.expiresAt <= this.now() && !pending.signedTransaction)
    ) {
      throw new Error('RHEA Swap Solana review is unavailable or expired')
    }
    return pending
  }

  private assertBinding(
    plan: RheaSwapSolanaTransactionPlan,
    binding: RheaSwapTransactionBinding,
    sender: string
  ): void {
    if (
      plan.chain !== 'solana' ||
      binding.quoteHandle !== plan.quoteHandle ||
      binding.executionId !== plan.executionId ||
      binding.origin.protocolChainId !== plan.chain ||
      binding.sender !== sender ||
      binding.sourceTarget !== sender
    ) {
      throw new Error('RHEA Swap Solana binding does not match its build')
    }
  }

  private async loadSupportedContext(): Promise<{
    context: ActiveSolanaTransferContext
    sender: string
  }> {
    const context = await this.options.loadContext()
    if (
      !context ||
      (context.keyDomainSource.kind === 'hardware' &&
        context.keyDomainSource.vendor !== 'ledger') ||
      context.chainAccount.identity.kind !== 'account-identifier'
    ) {
      throw new Error('RHEA Swap Solana execution requires an active software or Ledger Account')
    }
    return Object.freeze({
      context,
      sender: parseSolanaPublicKey(context.chainAccount.identity.value)
    })
  }

  private async persistSignedGraph(pending: PendingSolanaExecution): Promise<TransactionGraph> {
    const sourceHash = pending.sourceHash
    if (!sourceHash) throw new Error('RHEA Swap Solana signed transaction hash is missing')
    const transactionId = parseTransactionId(`tx:rhea-solana:${pending.graphSuffix}`)
    const existing = await this.options.repository.get(pending.scope, transactionId)
    if (existing) {
      const binding = existing.root.intent?.protocol
      if (
        binding?.provider !== 'rhea-cross-chain-dex' ||
        binding.quoteHandle !== pending.quoteHandle
      ) {
        throw new Error('RHEA Swap Solana transaction ID conflicts with an existing record')
      }
      return existing
    }
    const suffix = pending.graphSuffix
    const graph = createRheaSwapSignedSourceGraph({
      transactionId,
      scope: pending.scope,
      binding: pending.binding,
      sourceHash,
      segmentIds: {
        origin: parseTransactionSegmentId(`segment:rhea-solana:origin:${suffix}`),
        relay: parseTransactionSegmentId(`segment:rhea-solana:relay:${suffix}`),
        destination: parseTransactionSegmentId(`segment:rhea-solana:destination:${suffix}`),
        refund: parseTransactionSegmentId(`segment:rhea-solana:refund:${suffix}`)
      },
      now: pending.graphCreatedAt
    })
    const created = await this.options.repository.create(graph)
    if (created.status === 'id-conflict') {
      throw new Error('RHEA Swap Solana transaction ID conflicts with an existing record')
    }
    return created.graph
  }

  private async applyBroadcast(
    graph: TransactionGraph,
    sourceHash: string
  ): Promise<TransactionGraph> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current =
        attempt === 0 ? graph : await this.options.repository.get(graph.root.scope, graph.root.id)
      const origin = current?.segments.find(segment => segment.role === 'origin')
      if (!current || !origin) throw new Error('RHEA Swap Solana graph was not found')
      if (
        origin.status === 'broadcast' ||
        origin.status === 'confirming' ||
        origin.status === 'final'
      ) {
        if (origin.evidence?.transactionHash !== sourceHash) {
          throw new Error('RHEA Swap Solana graph has conflicting broadcast evidence')
        }
        return current
      }
      const result = await this.options.repository.applySegmentEvent({
        scope: current.root.scope,
        transactionId: current.root.id,
        segmentId: origin.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:rhea-solana:broadcast:${this.createId()}`),
          status: 'broadcast',
          cause: 'progress',
          observedAt: this.now(),
          evidence: Object.freeze({ transactionHash: sourceHash, requiredConfirmations: 1 })
        }),
        expectedRootRevision: current.root.revision,
        expectedSegmentRevision: origin.revision
      })
      if (result.status === 'applied' && result.graph) return result.graph
      if (result.status !== 'revision-conflict') {
        throw new Error('RHEA Swap Solana broadcast evidence could not be persisted')
      }
    }
    throw new Error('RHEA Swap Solana broadcast evidence conflicted during persistence')
  }
}

export function createBackgroundRheaSwapSolanaCoordinator(
  service: RheaSwapService,
  settings?: ChainEndpointSettings
): RheaSwapSolanaCoordinator {
  const network = resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, settings)
  const storage = new IndexedDbStorageV2Repository()
  const rpc = createConfiguredSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  return new RheaSwapSolanaCoordinator({
    service,
    signer: new SolanaSigner({
      credentials: credentialSession,
      rpc,
      ledger: solanaLedgerSigningBridge
    }),
    rpc,
    pending: new ChromeSessionRheaSwapSolanaStore(),
    repository: new IndexedDbTransactionRepository(),
    loadContext: () => loadActiveSolanaTransferContext(storage, network.chainId),
    scheduleMonitoring: async () => {
      await Promise.all([
        chrome.alarms.create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
        chrome.alarms.create(SOLANA_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
      ])
    }
  })
}
