import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { parseAccountId } from '@/core/accounts/domain'
import { parseNearAccountId, parseNearBase58 } from '@/core/chains/near'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseSigningCommandId, type SigningCommandId } from '@/core/keyring/ports'
import type {
  RheaSwapNearTransactionBatchPlan,
  RheaSwapNearTransactionBatchReview,
  RheaSwapService,
  RheaSwapSignedOrderResult
} from '@/core/services/rhea-swap'
import {
  createRheaSwapSignedBatchGraph,
  parseRheaSwapTransactionBinding,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type RheaSwapTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import {
  createConfiguredNearRpcClient,
  type NearBroadcastRpc,
  type NearReadRpc
} from '@/infrastructure/chains/near'
import type { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import { NearMultichainSigningClient as NearSigner } from '@/infrastructure/keyring/multichain/near-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import type { TransactionRepository } from '@/ports/repositories'
import { credentialSession } from './credential-session'
import { nearLedgerSigningBridge } from './ledger-signing-bridge'
import { encodeNearDAppFunctionArgs, parseNearDAppTransactionBatch } from './near-dapp-codecs'
import { loadActiveNearTransferContext, type ActiveNearTransferContext } from './near-transfer'
import { NEAR_TRANSACTION_MONITOR_ALARM } from './near-transaction-monitor'
import { RHEA_SWAP_TRANSACTION_MONITOR_ALARM } from './rhea-swap-transaction-monitor'

const STORAGE_PREFIX = 'rhea_swap_near:'
const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_SIGNED_TRANSACTION_BYTES = 256 * 1024

type PendingNearCommand = Readonly<{
  commandId: SigningCommandId
  payloadFingerprint: string
}>

type PendingNearSignedTransaction = Readonly<{
  transaction: string
  sourceHash: string
}>

type PendingNearExecution = Readonly<{
  schemaVersion: 1
  quoteHandle: string
  executionId: string
  chainId: string
  sender: string
  scope: TransactionAccountScope
  commands: readonly PendingNearCommand[]
  signedTransactions: readonly PendingNearSignedTransaction[]
  payloadFingerprint: string
  expiresAt: number
  graphSuffix: string
  graphCreatedAt: number
  binding: RheaSwapTransactionBinding
  planFingerprint?: string
}>

export interface RheaSwapNearPendingStore {
  readonly get: (quoteHandle: string) => Promise<PendingNearExecution | null>
  readonly list: () => Promise<readonly PendingNearExecution[]>
  readonly put: (value: PendingNearExecution) => Promise<void>
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

function parseCanonicalBase64(value: unknown, label: string): string {
  const parsed = readString(value, label, Math.ceil((MAXIMUM_SIGNED_TRANSACTION_BYTES * 4) / 3) + 4)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  let binary: string
  try {
    binary = atob(parsed)
  } catch {
    throw new Error(`${label} must be canonical base64`)
  }
  if (
    binary.length === 0 ||
    binary.length > MAXIMUM_SIGNED_TRANSACTION_BYTES ||
    btoa(binary) !== parsed
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  return parsed
}

function parsePending(value: unknown): PendingNearExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored RHEA Swap NEAR execution is invalid')
  }
  const record = value as Record<string, unknown>
  const required = [
    'schemaVersion',
    'quoteHandle',
    'executionId',
    'chainId',
    'sender',
    'scope',
    'commands',
    'signedTransactions',
    'payloadFingerprint',
    'expiresAt',
    'graphSuffix',
    'graphCreatedAt',
    'binding'
  ]
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).length !==
      required.length + (Object.prototype.hasOwnProperty.call(record, 'planFingerprint') ? 1 : 0) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => ![...required, 'planFingerprint'].includes(key)) ||
    !record.scope ||
    typeof record.scope !== 'object' ||
    Array.isArray(record.scope) ||
    !Array.isArray(record.commands) ||
    record.commands.length === 0 ||
    record.commands.length > 16 ||
    !Array.isArray(record.signedTransactions) ||
    record.signedTransactions.length > record.commands.length ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0 ||
    !Number.isSafeInteger(record.graphCreatedAt) ||
    (record.graphCreatedAt as number) < 0
  ) {
    throw new Error('Stored RHEA Swap NEAR fields are invalid')
  }
  const scope = record.scope as Record<string, unknown>
  if (
    Object.keys(scope).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(scope, 'keyDomainId') ||
    !Object.prototype.hasOwnProperty.call(scope, 'accountId')
  ) {
    throw new Error('Stored RHEA Swap NEAR scope is invalid')
  }
  const parseFingerprint = (candidate: unknown, label: string) => {
    const fingerprint = readString(candidate, label, 64)
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(`${label} is invalid`)
    return fingerprint
  }
  const commands = record.commands.map((value, index): PendingNearCommand => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Stored RHEA Swap NEAR command ${index} is invalid`)
    }
    const command = value as Record<string, unknown>
    if (
      Object.keys(command).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(command, 'commandId') ||
      !Object.prototype.hasOwnProperty.call(command, 'payloadFingerprint')
    ) {
      throw new Error(`Stored RHEA Swap NEAR command ${index} is invalid`)
    }
    return Object.freeze({
      commandId: parseSigningCommandId(
        readString(command.commandId, `Stored RHEA Swap NEAR command ${index}`, 128)
      ),
      payloadFingerprint: parseFingerprint(
        command.payloadFingerprint,
        `Stored RHEA Swap NEAR command fingerprint ${index}`
      )
    })
  })
  const signedTransactions = record.signedTransactions.map(
    (value, index): PendingNearSignedTransaction => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Stored RHEA Swap NEAR signed transaction ${index} is invalid`)
      }
      const signed = value as Record<string, unknown>
      if (
        Object.keys(signed).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(signed, 'transaction') ||
        !Object.prototype.hasOwnProperty.call(signed, 'sourceHash')
      ) {
        throw new Error(`Stored RHEA Swap NEAR signed transaction ${index} is invalid`)
      }
      return Object.freeze({
        transaction: parseCanonicalBase64(
          signed.transaction,
          `Stored RHEA Swap NEAR transaction ${index}`
        ),
        sourceHash: parseNearBase58(
          signed.sourceHash,
          32,
          `Stored RHEA Swap NEAR transaction hash ${index}`
        )
      })
    }
  )
  const chainId = readString(record.chainId, 'Stored RHEA Swap NEAR chain', 64)
  if (!chainId.startsWith('near:')) throw new Error('Stored RHEA Swap NEAR chain is invalid')
  const planFingerprint =
    record.planFingerprint === undefined
      ? undefined
      : parseFingerprint(record.planFingerprint, 'Stored RHEA Swap NEAR plan fingerprint')
  return Object.freeze({
    schemaVersion: 1,
    quoteHandle: readString(record.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(record.executionId, 'RHEA Swap execution ID', 160),
    chainId,
    sender: parseNearAccountId(record.sender, 'Stored RHEA Swap NEAR sender'),
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(scope.keyDomainId),
      accountId: parseAccountId(scope.accountId)
    }),
    commands: Object.freeze(commands),
    signedTransactions: Object.freeze(signedTransactions),
    payloadFingerprint: parseFingerprint(
      record.payloadFingerprint,
      'Stored RHEA Swap NEAR batch fingerprint'
    ),
    expiresAt: record.expiresAt as number,
    graphSuffix: readString(record.graphSuffix, 'RHEA Swap NEAR graph suffix', 80),
    graphCreatedAt: record.graphCreatedAt as number,
    binding: parseRheaSwapTransactionBinding(record.binding),
    ...(planFingerprint === undefined ? {} : { planFingerprint })
  })
}

async function fingerprintBatch(fingerprints: readonly string[]): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(fingerprints))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export class ChromeSessionRheaSwapNearStore implements RheaSwapNearPendingStore {
  async get(quoteHandle: string): Promise<PendingNearExecution | null> {
    const key = this.key(quoteHandle)
    const value = (await chrome.storage.session.get(key))[key]
    return value === undefined ? null : parsePending(value)
  }

  async list(): Promise<readonly PendingNearExecution[]> {
    return Object.entries(await chrome.storage.session.get(null))
      .filter(([key]) => key.startsWith(STORAGE_PREFIX))
      .map(([, value]) => parsePending(value))
  }

  async put(value: PendingNearExecution): Promise<void> {
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

export interface RheaSwapNearCoordinatorOptions {
  readonly service: Pick<
    RheaSwapService,
    'readNearTransactionBatchPlan' | 'recordTransactionSubmission' | 'reportSubmission' | 'discard'
  >
  readonly signer: Pick<NearMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly rpc: Pick<NearReadRpc, 'assertExpectedChain' | 'getAccessKey' | 'getTransactionStatus'> &
    Pick<NearBroadcastRpc, 'broadcastSignedTransaction'>
  readonly pending: RheaSwapNearPendingStore
  readonly repository: Pick<TransactionRepository, 'create' | 'get' | 'applySegmentEvent'>
  readonly loadContext: () => Promise<ActiveNearTransferContext | null>
  readonly scheduleMonitoring: () => Promise<void>
  readonly now?: () => number
  readonly createId?: () => string
}

export class RheaSwapNearCoordinator {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly confirming = new Set<string>()

  constructor(private readonly options: RheaSwapNearCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(
    quoteHandle: string,
    bindingValue: unknown
  ): Promise<RheaSwapNearTransactionBatchReview> {
    const plan = await this.options.service.readNearTransactionBatchPlan(quoteHandle)
    const binding = parseRheaSwapTransactionBinding(bindingValue)
    const { context, sender } = await this.loadSupportedContext()
    this.assertBinding(plan, binding, sender)
    const requests = parseNearDAppTransactionBatch([
      {
        transactions: plan.transactions.map(transaction => ({
          receiverId: transaction.receiverId,
          actions: transaction.actions
        }))
      }
    ])
    await this.options.rpc.assertExpectedChain()
    const accessKey = await this.options.rpc.getAccessKey(sender, context.publicKey)
    if (!accessKey || accessKey.permission.kind !== 'full-access') {
      throw new Error('RHEA Swap NEAR execution requires an active full-access key')
    }
    const baseNonce = BigInt(accessKey.nonce)
    if (baseNonce + BigInt(requests.length) > MAXIMUM_U64) {
      throw new Error('RHEA Swap NEAR access-key nonce is exhausted')
    }
    const prepared: Awaited<ReturnType<NearMultichainSigningClient['prepare']>>[] = []
    try {
      for (const [index, request] of requests.entries()) {
        const command = await this.options.signer.prepare(context.chainAccount.scope.keyDomainId, {
          kind: 'near-transaction',
          chainId: context.chainAccount.scope.chainId,
          accountIndex: context.accountIndex,
          transaction: Object.freeze({
            chainId: context.chainAccount.scope.chainId,
            accountIndex: context.accountIndex,
            signerId: sender,
            receiverId: request.receiverId,
            nonce: (baseNonce + BigInt(index) + 1n).toString(),
            blockHash: accessKey.blockHash,
            actions: Object.freeze(
              request.actions.map(action =>
                action.type === 'transfer'
                  ? Object.freeze({ type: 'transfer' as const, depositYocto: action.deposit })
                  : Object.freeze({
                      type: 'functionCall' as const,
                      methodName: action.methodName,
                      args: encodeNearDAppFunctionArgs(action.args),
                      gas: action.gas,
                      depositYocto: action.deposit
                    })
              )
            )
          })
        })
        if (
          (context.keyDomainSource.kind === 'hardware'
            ? context.keyDomainSource.vendor !== 'ledger' ||
              command.execution.kind !== 'external' ||
              command.execution.request.encoding !== 'base64'
            : command.execution.kind !== 'internal') ||
          command.summary.schema !== 'near.transaction.v1' ||
          command.summary.fields.signerId !== sender ||
          command.summary.fields.receiverId !== request.receiverId
        ) {
          await this.options.signer
            .cancel(context.chainAccount.scope.keyDomainId, command.commandId)
            .catch(() => {})
          throw new Error('RHEA Swap NEAR transaction does not match its signer or receiver')
        }
        prepared.push(command)
      }
    } catch (error) {
      await Promise.all(
        prepared.map(command =>
          this.options.signer
            .cancel(context.chainAccount.scope.keyDomainId, command.commandId)
            .catch(() => {})
        )
      )
      throw error
    }
    const fingerprints = prepared.map(command => command.payloadFingerprint.digestHex)
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
      commands: prepared.map(command => ({
        commandId: command.commandId,
        payloadFingerprint: command.payloadFingerprint.digestHex
      })),
      signedTransactions: [],
      payloadFingerprint: await fingerprintBatch(fingerprints),
      expiresAt: Math.min(binding.expiresAt, ...prepared.map(command => command.expiresAt)),
      graphSuffix: this.createId(),
      graphCreatedAt: this.now(),
      binding,
      ...(context.keyDomainSource.kind === 'hardware'
        ? { planFingerprint: await fingerprintBatch([JSON.stringify(plan.transactions)]) }
        : {})
    })
    try {
      await this.options.pending.put(pending)
    } catch (error) {
      await Promise.all(
        prepared.map(command =>
          this.options.signer
            .cancel(context.chainAccount.scope.keyDomainId, command.commandId)
            .catch(() => {})
        )
      )
      throw error
    }
    return Object.freeze({
      quoteHandle: plan.quoteHandle,
      executionId: plan.executionId,
      chainId: pending.chainId,
      sender,
      summaries: Object.freeze(prepared.map(command => command.summary)),
      payloadFingerprint: pending.payloadFingerprint,
      expiresAt: pending.expiresAt
    })
  }

  async confirm(quoteHandle: string, fingerprint: string): Promise<RheaSwapSignedOrderResult> {
    if (this.confirming.has(quoteHandle))
      throw new Error('RHEA Swap NEAR confirmation is already in progress')
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
    if (pending.signedTransactions.length < pending.commands.length) {
      const plan = await this.options.service.readNearTransactionBatchPlan(quoteHandle)
      this.assertBinding(plan, pending.binding, sender)
      if (
        pending.planFingerprint !== undefined &&
        (await fingerprintBatch([JSON.stringify(plan.transactions)])) !== pending.planFingerprint
      ) {
        throw new Error('RHEA Swap NEAR batch changed after Ledger review')
      }
      for (
        let index = pending.signedTransactions.length;
        index < pending.commands.length;
        index += 1
      ) {
        const command = pending.commands[index]
        const signed = await this.options.signer.confirm(
          pending.scope.keyDomainId,
          command.commandId
        )
        if (
          signed.kind !== 'signed-payload' ||
          signed.payload.encoding !== 'base64' ||
          !signed.transactionId
        ) {
          throw new Error(`RHEA Swap NEAR signer returned an invalid transaction at index ${index}`)
        }
        pending = parsePending({
          ...pending,
          signedTransactions: [
            ...pending.signedTransactions,
            { transaction: signed.payload.value, sourceHash: signed.transactionId }
          ]
        })
        await this.options.pending.put(pending)
      }
    }
    if (pending.signedTransactions.length !== pending.commands.length) {
      throw new Error('RHEA Swap NEAR signed transaction batch is incomplete')
    }
    let graph = await this.persistSignedGraph(pending)
    for (const [index, signed] of pending.signedTransactions.entries()) {
      const originId = parseTransactionSegmentId(
        `segment:rhea-near:origin:${index}:${pending.graphSuffix}`
      )
      const current = await this.options.repository.get(graph.root.scope, graph.root.id)
      const origin = current?.segments.find(segment => segment.id === originId)
      if (!current || !origin) throw new Error('RHEA Swap NEAR graph origin was not found')
      graph = current
      if (
        origin.status === 'broadcast' ||
        origin.status === 'confirming' ||
        origin.status === 'final'
      ) {
        if (origin.evidence?.transactionHash !== signed.sourceHash) {
          throw new Error('RHEA Swap NEAR graph has conflicting broadcast evidence')
        }
        continue
      }
      let accepted = false
      try {
        accepted =
          (await this.options.rpc.broadcastSignedTransaction(signed.transaction)) ===
          signed.sourceHash
      } catch {
        const observed = await this.options.rpc
          .getTransactionStatus(signed.sourceHash, sender)
          .catch(() => null)
        accepted = observed !== null && observed.status !== 'unknown'
      }
      if (!accepted) {
        await this.options.scheduleMonitoring().catch(() => {})
        throw new Error(
          `RHEA Swap NEAR transaction ${index + 1} is signed and waiting to broadcast`
        )
      }
      graph = await this.applyBroadcast(graph, originId, signed.sourceHash)
    }
    const sourceHash = pending.signedTransactions[pending.signedTransactions.length - 1].sourceHash
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
    if (!pending || pending.signedTransactions.length > 0) return
    await Promise.all(
      pending.commands.map(command =>
        this.options.signer.cancel(pending.scope.keyDomainId, command.commandId).catch(() => {})
      )
    )
    await this.options.pending.delete(quoteHandle)
    await this.options.service.discard(quoteHandle).catch(() => {})
  }

  async recoverSigned(): Promise<number> {
    const pending = (await this.options.pending.list()).filter(
      value => value.signedTransactions.length > 0
    )
    const results = await Promise.allSettled(
      pending.map(value => this.confirm(value.quoteHandle, value.payloadFingerprint))
    )
    return results.filter(result => result.status === 'fulfilled').length
  }

  private async requirePending(
    quoteHandle: string,
    fingerprint: string
  ): Promise<PendingNearExecution> {
    const pending = await this.options.pending.get(quoteHandle)
    if (
      !pending ||
      pending.payloadFingerprint !== fingerprint ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      (pending.expiresAt <= this.now() && pending.signedTransactions.length === 0)
    ) {
      throw new Error('RHEA Swap NEAR review is unavailable or expired')
    }
    return pending
  }

  private assertBinding(
    plan: RheaSwapNearTransactionBatchPlan,
    binding: RheaSwapTransactionBinding,
    sender: string
  ): void {
    if (
      plan.chain !== 'near' ||
      binding.quoteHandle !== plan.quoteHandle ||
      binding.executionId !== plan.executionId ||
      binding.origin.protocolChainId !== plan.chain ||
      binding.sender !== sender ||
      plan.transactions.some(transaction =>
        transaction.signerId === null ? false : transaction.signerId !== sender
      )
    ) {
      throw new Error('RHEA Swap NEAR binding does not match its build')
    }
  }

  private async loadSupportedContext(): Promise<{
    context: ActiveNearTransferContext
    sender: string
  }> {
    const context = await this.options.loadContext()
    if (
      !context ||
      (context.keyDomainSource.kind === 'hardware' &&
        context.keyDomainSource.vendor !== 'ledger') ||
      context.chainAccount.identity.kind !== 'account-identifier'
    ) {
      throw new Error('RHEA Swap NEAR execution requires an active software or Ledger Account')
    }
    return Object.freeze({
      context,
      sender: parseNearAccountId(context.chainAccount.identity.value, 'RHEA Swap NEAR sender')
    })
  }

  private async persistSignedGraph(pending: PendingNearExecution): Promise<TransactionGraph> {
    const transactionId = parseTransactionId(`tx:rhea-near:${pending.graphSuffix}`)
    const existing = await this.options.repository.get(pending.scope, transactionId)
    if (existing) {
      const binding = existing.root.intent?.protocol
      if (
        binding?.provider !== 'rhea-cross-chain-dex' ||
        binding.quoteHandle !== pending.quoteHandle
      ) {
        throw new Error('RHEA Swap NEAR transaction ID conflicts with an existing record')
      }
      return existing
    }
    const suffix = pending.graphSuffix
    const origins = pending.commands.map((_, index) =>
      parseTransactionSegmentId(`segment:rhea-near:origin:${index}:${suffix}`)
    )
    const graph = createRheaSwapSignedBatchGraph({
      transactionId,
      scope: pending.scope,
      binding: pending.binding,
      sourceHashes: pending.signedTransactions.map(transaction => transaction.sourceHash),
      segmentIds: {
        origins,
        relay: parseTransactionSegmentId(`segment:rhea-near:relay:${suffix}`),
        destination: parseTransactionSegmentId(`segment:rhea-near:destination:${suffix}`),
        refund: parseTransactionSegmentId(`segment:rhea-near:refund:${suffix}`)
      },
      now: pending.graphCreatedAt
    })
    const created = await this.options.repository.create(graph)
    if (created.status === 'id-conflict') {
      throw new Error('RHEA Swap NEAR transaction ID conflicts with an existing record')
    }
    return created.graph
  }

  private async applyBroadcast(
    graph: TransactionGraph,
    originId: TransactionSegmentId,
    sourceHash: string
  ): Promise<TransactionGraph> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current =
        attempt === 0 ? graph : await this.options.repository.get(graph.root.scope, graph.root.id)
      const origin = current?.segments.find(segment => segment.id === originId)
      if (!current || !origin) throw new Error('RHEA Swap NEAR graph was not found')
      if (
        origin.status === 'broadcast' ||
        origin.status === 'confirming' ||
        origin.status === 'final'
      ) {
        if (origin.evidence?.transactionHash !== sourceHash) {
          throw new Error('RHEA Swap NEAR graph has conflicting broadcast evidence')
        }
        return current
      }
      const result = await this.options.repository.applySegmentEvent({
        scope: current.root.scope,
        transactionId: current.root.id,
        segmentId: origin.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:rhea-near:broadcast:${this.createId()}`),
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
        throw new Error('RHEA Swap NEAR broadcast evidence could not be persisted')
      }
    }
    throw new Error('RHEA Swap NEAR broadcast evidence conflicted during persistence')
  }
}

export function createBackgroundRheaSwapNearCoordinator(
  service: RheaSwapService,
  settings?: ChainEndpointSettings
): RheaSwapNearCoordinator {
  const network = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, settings)
  const storage = new IndexedDbStorageV2Repository()
  const rpc = createConfiguredNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  return new RheaSwapNearCoordinator({
    service,
    signer: new NearSigner({ credentials: credentialSession, ledger: nearLedgerSigningBridge }),
    rpc,
    pending: new ChromeSessionRheaSwapNearStore(),
    repository: new IndexedDbTransactionRepository(),
    loadContext: () => loadActiveNearTransferContext(storage, network.chainId),
    scheduleMonitoring: async () => {
      await Promise.all([
        chrome.alarms.create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
        chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
      ])
    }
  })
}
