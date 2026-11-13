import type { ChainAccount } from '@/core/accounts/domain'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import type { KeyDomainSource } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'

import { readStarknetAccountDeployment } from './starknet-account-state'
import {
  ChromeSessionStarknetPendingTransferStore,
  type StarknetPendingTransfer
} from './starknet-pending-transfer-store'
import {
  assertStarknetExecutionTransaction,
  assertStarknetFelt,
  feltFromBigint,
  feltToBigint,
  mapStarknetReceiptStatus,
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_ARGENT_V05_CLASS_HASH,
  STARKNET_EXECUTION_VERSION
} from './starknet-primitives'
import {
  StarknetRpcError,
  type StarknetBroadcastRpc,
  type StarknetReadRpc
} from './starknet-rpc-types'
import {
  assertStarknetGraphMatches,
  createStarknetTransferGraph
} from './starknet-transaction-graph'
import {
  parseStarknetExternalPreparation,
  starknetDeployExternalRequest,
  starknetInvokeExternalRequest
} from './starknet-external-transaction'
import {
  prepareStarknetTransfer,
  quoteStarknetDAppInvoke,
  quoteStarknetInvoke,
  quoteStarknetMaximum,
  type StarknetAccountRef,
  type StarknetCall,
  type StarknetExternalBuilder,
  type StarknetPreparedTransfer
} from './starknet-transfer-preparer'

const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000
const textEncoder = new TextEncoder()

export interface StarknetTransferSigner {
  prepare(
    keyDomainId: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<{ readonly commandId: string }>
  confirm(
    keyDomainId: string,
    signingCommandId: string
  ): Promise<{
    readonly transactionHash: string
    readonly transaction: Readonly<Record<string, unknown>>
  }>
  signLedger?(input: {
    readonly account: StarknetTransferAccount
    readonly kind: 'starknet-invoke' | 'starknet-deploy-account'
    readonly transactionHash: string
    readonly transaction: Readonly<Record<string, unknown>>
    readonly resourceBounds: StarknetPreparedTransfer['invoke']['resourceBounds']
    readonly request: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<Readonly<Record<string, unknown>>>
}

export interface StarknetTransferAccount {
  readonly chainAccount: ChainAccount
  readonly accountIndex: number
  readonly addressIndex: number
  readonly keyDomainSource: KeyDomainSource
  readonly publicKey: string
  readonly classHash: string
}

export interface StarknetTransferReview {
  readonly graph: TransactionGraph
  readonly maxFeeRaw: string
  readonly deployMaxFeeRaw: string | null
  readonly invokeMaxFeeRaw: string
  readonly payloadFingerprint: string
  readonly deploysAccount: boolean
}

export interface StarknetTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

export class StarknetTransferOrchestrator {
  constructor(
    private readonly options: {
      readonly rpc: StarknetReadRpc & StarknetBroadcastRpc
      readonly builder: StarknetExternalBuilder
      readonly signer: StarknetTransferSigner
      readonly pending: ChromeSessionStarknetPendingTransferStore
      readonly repository: TransactionRepository
      readonly assets: AssetRegistry
      readonly chainId: string
      readonly feeTokenReference: string
      readonly now?: () => number
      readonly createId?: () => string
    }
  ) {}

  async quoteInvoke(input: {
    readonly account: StarknetAccountRef
    readonly calls: readonly StarknetCall[]
    readonly signal?: AbortSignal
  }): Promise<{
    readonly nonce: string
    readonly resourceBounds: StarknetPreparedTransfer['invoke']['resourceBounds']
  }> {
    this.assertChain(input.account.chainId)
    const quoted = await quoteStarknetInvoke({
      rpc: this.options.rpc,
      builder: this.options.builder,
      account: input.account,
      calls: input.calls,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    return { nonce: quoted.nonce, resourceBounds: quoted.resourceBounds }
  }

  async quoteLedgerInvoke(input: {
    readonly account: StarknetAccountRef
    readonly calls: readonly StarknetCall[]
    readonly signal?: AbortSignal
  }): Promise<{
    readonly nonce: string
    readonly resourceBounds: StarknetPreparedTransfer['invoke']['resourceBounds']
    readonly deploy: {
      readonly nonce: string
      readonly resourceBounds: StarknetPreparedTransfer['invoke']['resourceBounds']
    } | null
  }> {
    this.assertChain(input.account.chainId)
    const quoted = await quoteStarknetDAppInvoke({
      rpc: this.options.rpc,
      builder: this.options.builder,
      account: input.account,
      calls: input.calls,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    return {
      nonce: quoted.invoke.nonce,
      resourceBounds: quoted.invoke.resourceBounds,
      ...(quoted.deploy
        ? {
            deploy: {
              nonce: quoted.deploy.nonce,
              resourceBounds: quoted.deploy.resourceBounds
            }
          }
        : { deploy: null })
    }
  }

  async quoteMaximum(input: {
    readonly account: StarknetTransferAccount
    readonly tokenReference: string
    readonly signal?: AbortSignal
  }): Promise<string | null> {
    this.assertCanSend(input.account)
    const amount = await quoteStarknetMaximum({
      rpc: this.options.rpc,
      builder: this.options.builder,
      account: this.accountRef(input.account),
      tokenReference: input.tokenReference,
      feeTokenReference: this.options.feeTokenReference,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    return amount === null ? null : amount.toString()
  }

  async prepare(input: {
    readonly account: StarknetTransferAccount
    readonly assetId: string
    readonly tokenReference: string
    readonly recipient: string
    readonly amountRaw: string
    readonly signal?: AbortSignal
  }): Promise<StarknetTransferReview> {
    this.assertCanSend(input.account)
    this.assertChain(input.account.chainAccount.scope.chainId)
    if (!/^(?:0|[1-9][0-9]*)$/.test(input.amountRaw) || BigInt(input.amountRaw) <= 0n) {
      throw new Error('Starknet transfer amount is invalid')
    }
    const recipient = normalizeStarknetFelt(input.recipient)
    const sender = normalizeStarknetFelt(input.account.chainAccount.identity.value)
    if (input.account.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Starknet account is invalid')
    }
    await this.assertNoInFlight(sender)
    const prepared = await prepareStarknetTransfer({
      rpc: this.options.rpc,
      builder: this.options.builder,
      account: this.accountRef(input.account),
      tokenReference: input.tokenReference,
      feeTokenReference: this.options.feeTokenReference,
      recipient,
      amount: BigInt(input.amountRaw),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    if (prepared.account.address !== sender) throw new Error('Starknet account changed')
    const createdAt = this.now()
    const id = this.createId()
    const transactionId = parseTransactionId(`transaction:starknet:${id}`)
    const invokeSegmentId = parseTransactionSegmentId(`segment:starknet:${id}:invoke`)
    const deploySegmentId = prepared.deploy
      ? parseTransactionSegmentId(`segment:starknet:${id}:deploy`)
      : undefined
    const reviewedHash = await reviewHash(prepared)
    const graph = createStarknetTransferGraph({
      chainId: this.options.chainId,
      scope: {
        keyDomainId: parseKeyDomainId(input.account.chainAccount.scope.keyDomainId),
        accountId: parseAccountId(input.account.chainAccount.scope.accountId)
      },
      transactionId,
      invokeSegmentId,
      ...(deploySegmentId === undefined ? {} : { deploySegmentId }),
      assetId: input.assetId,
      feeAssetId: this.feeAssetId(),
      amountRaw: input.amountRaw,
      maxFeeRaw: prepared.maxFee.toString(),
      sender,
      recipient,
      chainAccountId: input.account.chainAccount.id,
      createdAt
    })
    assertStarknetGraphMatches(graph, this.options.assets, {
      assetId: input.assetId,
      amountRaw: input.amountRaw,
      recipient,
      maxFeeRaw: prepared.maxFee.toString()
    })
    const record = this.recordFromPrepared({
      prepared,
      transactionId,
      account: input.account,
      assetId: input.assetId,
      feeAssetId: this.feeAssetId(),
      reviewedHash,
      createdAt
    })
    await this.options.pending.put(record, graph)
    return {
      graph,
      maxFeeRaw: prepared.maxFee.toString(),
      deployMaxFeeRaw: prepared.deploy ? prepared.deploy.maxFee.toString() : null,
      invokeMaxFeeRaw: prepared.invoke.maxFee.toString(),
      payloadFingerprint: reviewedHash,
      deploysAccount: prepared.deploy !== null
    }
  }

  async approve(input: {
    readonly account: StarknetTransferAccount
    readonly transactionId: string
    readonly payloadFingerprint: string
    readonly signal?: AbortSignal
  }): Promise<StarknetTransferSubmission> {
    const pending = await this.requirePending(input.transactionId, input.account)
    if (pending.phase !== 'awaiting-approval' || pending.status !== 'pending') {
      throw new Error('Starknet transfer is not awaiting approval')
    }
    if (input.payloadFingerprint !== pending.reviewedHash) {
      throw new Error('Starknet review does not match the requested transfer')
    }
    const refreshed = await this.recheck(pending, input.signal)
    if (refreshed !== pending.reviewedHash) {
      throw new Error('Starknet review does not match the requested transfer')
    }
    const graph = await this.options.pending.getReviewGraph(pending.transactionId)
    if (!graph) throw new Error('Starknet review is missing')
    let signedDeploy = pending.signedDeploy
    let signedInvoke = pending.signedInvoke
    if (pending.deployExecutionHash && !signedDeploy) {
      signedDeploy = await this.sign(
        input.account,
        deployPayload(pending),
        pending.deployExecutionHash,
        input.signal
      )
    }
    if (!signedInvoke) {
      signedInvoke = await this.sign(
        input.account,
        invokePayload(pending),
        pending.invokeExecutionHash,
        input.signal
      )
    }
    const attempted: StarknetPendingTransfer = {
      ...pending,
      signedDeploy,
      signedInvoke,
      broadcastAttempted: false
    }
    await this.options.pending.put(attempted, graph)
    if (signedDeploy) {
      const deployed = await this.broadcastDeploy(attempted, graph)
      const saved = await this.options.pending.get(attempted.transactionId)
      if (!saved?.signedInvoke || saved.invokeHash) return deployed
      try {
        return await this.broadcastInvoke(
          { ...saved, phase: 'invoke-ready', broadcastAttempted: false },
          deployed.graph
        )
      } catch (error) {
        if (isDeployNotVisible(error)) return deployed
        throw error
      }
    }
    return this.broadcastInvoke({ ...attempted, phase: 'invoke-ready' }, graph)
  }

  async reject(transactionId: string, account: StarknetTransferAccount): Promise<TransactionGraph> {
    const pending = await this.requirePending(transactionId, account)
    if (pending.phase !== 'awaiting-approval')
      throw new Error('Starknet transfer can no longer be rejected')
    const graph = await this.options.pending.getReviewGraph(pending.transactionId)
    await this.options.pending.delete(pending.transactionId)
    if (!graph) throw new Error('Starknet review is missing')
    return graph
  }

  async resume(
    account: StarknetTransferAccount,
    transactionId: string
  ): Promise<StarknetTransferSubmission> {
    const pending = await this.requirePending(transactionId, account)
    const graph = await this.options.pending.getReviewGraph(pending.transactionId)
    if (!graph || pending.status !== 'pending' || pending.phase === 'awaiting-approval') {
      throw new Error('Starknet transfer cannot be resumed')
    }
    if (pending.signedInvoke && !pending.invokeHash) {
      return this.broadcastInvoke(
        { ...pending, phase: 'invoke-ready', broadcastAttempted: false },
        graph
      )
    }
    if (pending.signedDeploy && !pending.deployHash) {
      const deployed = await this.broadcastDeploy({ ...pending, broadcastAttempted: false }, graph)
      const saved = await this.options.pending.get(pending.transactionId)
      if (!saved?.signedInvoke || saved.invokeHash) return deployed
      try {
        return await this.broadcastInvoke(
          { ...saved, phase: 'invoke-ready', broadcastAttempted: false },
          deployed.graph
        )
      } catch (error) {
        if (isDeployNotVisible(error)) return deployed
        throw error
      }
    }
    if (pending.invokeHash || pending.deployHash) {
      const broadcasted = this.broadcastGraph(pending, graph)
      if (pending.invokeHash) await this.persistInvokeBroadcast(broadcasted)
      return {
        status: pending.invokeHash ? 'broadcast' : 'signed-pending-broadcast',
        graph: broadcasted
      }
    }
    throw new Error('Starknet transfer cannot be resumed')
  }

  async monitor(signal?: AbortSignal): Promise<void> {
    const records = await this.options.pending.list()
    for (const record of records) {
      if (record.status !== 'pending' || record.phase === 'awaiting-approval') continue
      await this.advance(record, signal)
    }
  }

  async listPending(): Promise<readonly StarknetPendingTransfer[]> {
    return this.options.pending.list()
  }

  getReview(transactionId: string): Promise<TransactionGraph | null> {
    return this.options.pending.getReviewGraph(parseTransactionId(transactionId))
  }

  async cancelAwaitingApprovals(): Promise<void> {
    const records = await this.options.pending.list()
    await Promise.all(
      records
        .filter(record => record.phase === 'awaiting-approval')
        .map(record => this.options.pending.delete(record.transactionId))
    )
  }

  private async advance(record: StarknetPendingTransfer, signal?: AbortSignal): Promise<void> {
    if (record.status !== 'pending') return
    const graph = await this.options.pending.getReviewGraph(record.transactionId)
    if (!graph) return
    if (record.deployHash && record.signedInvoke && !record.invokeHash) {
      const deployReceipt = await this.observe(record, record.deployHash, signal)
      if (deployReceipt === 'failed' || deployReceipt === 'dropped') {
        await this.finish(
          record,
          graph,
          'failed',
          deployReceipt === 'dropped' ? 'dropped' : 'reverted'
        )
        return
      }
      if (deployReceipt !== 'success') return
      try {
        await this.broadcastInvoke(
          { ...record, phase: 'invoke-ready', broadcastAttempted: false },
          graph
        )
      } catch (error) {
        if (isDeployNotVisible(error)) return
        throw error
      }
      const saved = await this.options.pending.get(record.transactionId)
      if (!saved?.invokeHash) return
      const invokeReceipt = await this.observe(saved, saved.invokeHash, signal)
      if (invokeReceipt === 'pending') return
      await this.finish(
        saved,
        (await this.options.pending.getReviewGraph(record.transactionId)) ?? graph,
        invokeReceipt === 'success' ? 'final' : 'failed',
        invokeReceipt === 'dropped' ? 'dropped' : invokeReceipt === 'failed' ? 'reverted' : null
      )
      return
    }
    if (record.phase === 'deploy-broadcast') {
      if (!record.deployHash) return
      const next = await this.observe(record, record.deployHash, signal)
      if (next === 'pending') return
      if (next === 'failed' || next === 'dropped') {
        await this.finish(record, graph, 'failed', next === 'dropped' ? 'dropped' : 'reverted')
      }
      return
    }
    if (record.phase === 'invoke-broadcast' && record.invokeHash) {
      const next = await this.observe(record, record.invokeHash, signal)
      if (next === 'pending') return
      await this.finish(
        record,
        graph,
        next === 'success' ? 'final' : 'failed',
        next === 'dropped' ? 'dropped' : next === 'failed' ? 'reverted' : null
      )
    }
  }

  private async observe(
    record: StarknetPendingTransfer,
    hash: string,
    signal?: AbortSignal
  ): Promise<'success' | 'failed' | 'dropped' | 'pending'> {
    const timedOut =
      record.broadcastAt !== null && this.now() - record.broadcastAt >= RECEIPT_TIMEOUT_MS
    const receipt = await this.options.rpc.getTransactionReceipt(hash, signal)
    return mapStarknetReceiptStatus(receipt.found ? receipt : { found: false, timedOut })
  }

  private async broadcastDeploy(
    record: StarknetPendingTransfer,
    graph: TransactionGraph
  ): Promise<StarknetTransferSubmission> {
    if (record.deployHash) {
      return { status: 'signed-pending-broadcast', graph: this.broadcastGraph(record, graph) }
    }
    if (record.broadcastAttempted || !record.signedDeploy) {
      throw new Error('Starknet deploy cannot be broadcast again')
    }
    const locked: StarknetPendingTransfer = {
      ...record,
      broadcastAttempted: true,
      phase: 'deploy-broadcast'
    }
    await this.options.pending.put(locked, graph)
    assertStarknetExecutionTransaction(record.signedDeploy)
    const hash = await this.options.rpc.addDeployAccountTransaction(record.signedDeploy)
    if (hash !== record.deployExecutionHash)
      throw new Error('Starknet deploy hash does not match the review')
    const broadcast: StarknetPendingTransfer = {
      ...locked,
      deployHash: hash,
      broadcastAt: this.now()
    }
    const nextGraph = this.broadcastGraph(broadcast, graph)
    await this.options.pending.put(broadcast, nextGraph)
    return { status: 'signed-pending-broadcast', graph: nextGraph }
  }

  private async broadcastInvoke(
    record: StarknetPendingTransfer,
    graph: TransactionGraph
  ): Promise<StarknetTransferSubmission> {
    if (record.invokeHash) {
      const broadcasted = this.broadcastGraph(record, graph)
      await this.persistInvokeBroadcast(broadcasted)
      return { status: 'broadcast', graph: broadcasted }
    }
    if (!record.signedInvoke) throw new Error('Starknet invoke is not signed')
    if (
      record.deployExecutionHash &&
      record.phase !== 'invoke-ready' &&
      record.phase !== 'invoke-broadcast'
    ) {
      throw new Error('Starknet invoke waits for account deployment')
    }
    const locked: StarknetPendingTransfer = {
      ...record,
      broadcastAttempted: true,
      phase: 'invoke-broadcast'
    }
    await this.options.pending.put(locked, graph)
    assertStarknetExecutionTransaction(record.signedInvoke)
    let hash: string
    try {
      hash = await this.options.rpc.addInvokeTransaction(record.signedInvoke)
    } catch (error) {
      if (isDeployNotVisible(error)) {
        await this.options.pending.put(
          { ...record, phase: 'invoke-ready', broadcastAttempted: false },
          graph
        )
      }
      throw error
    }
    if (hash !== record.invokeExecutionHash)
      throw new Error('Starknet invoke hash does not match the review')
    const broadcast: StarknetPendingTransfer = {
      ...locked,
      invokeHash: hash,
      broadcastAt: this.now(),
      phase: 'invoke-broadcast'
    }
    const nextGraph = this.broadcastGraph(broadcast, graph)
    await this.options.pending.put(broadcast, nextGraph)
    await this.persistInvokeBroadcast(nextGraph)
    return { status: 'broadcast', graph: nextGraph }
  }

  private async finish(
    record: StarknetPendingTransfer,
    graph: TransactionGraph,
    status: 'final' | 'failed',
    failureCode: StarknetPendingTransfer['failureCode']
  ): Promise<void> {
    if (record.status !== 'pending') return
    const finished: StarknetPendingTransfer = {
      ...record,
      status,
      phase: status === 'final' ? 'final' : 'failed',
      failureCode
    }
    const nextGraph =
      status === 'final'
        ? this.broadcastGraph({ ...finished, invokeHash: record.invokeHash }, graph)
        : graph
    await this.options.pending.put(finished, nextGraph)
    await this.syncPersistedStatus(finished, status, failureCode)
  }

  private async persistInvokeBroadcast(graph: TransactionGraph): Promise<void> {
    if (graph.root.status !== 'broadcast') return
    const created = await this.options.repository.create(graph)
    if (created.status === 'id-conflict') {
      throw new Error('Starknet transaction ID conflict')
    }
  }

  private async syncPersistedStatus(
    record: StarknetPendingTransfer,
    status: 'final' | 'failed',
    failureCode: StarknetPendingTransfer['failureCode']
  ): Promise<void> {
    const scope = {
      keyDomainId: parseKeyDomainId(record.scope.keyDomainId),
      accountId: parseAccountId(record.scope.accountId)
    }
    let graph = await this.options.repository.get(scope, record.transactionId)
    if (!graph) return
    for (const segmentId of graph.root.segmentIds) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = graph.segments.find(segment => segment.id === segmentId)
        if (!current || current.status === 'final' || current.status === 'failed') break
        const observedAt = Math.max(this.now(), current.updatedAt)
        const failed = status === 'failed'
        const result = await this.options.repository.applySegmentEvent({
          scope,
          transactionId: record.transactionId,
          segmentId,
          expectedRootRevision: graph.root.revision,
          expectedSegmentRevision: current.revision,
          event: {
            id: parseTransactionEventId(`event:starknet:${segmentId}:${status}`),
            status,
            cause: failed ? 'failure' : 'progress',
            observedAt,
            ...(failed
              ? { failure: { code: failureCode ?? 'unknown', occurredAt: observedAt } }
              : {})
          }
        })
        if (result.graph) graph = result.graph
        if (
          result.status === 'applied' ||
          result.status === 'duplicate-event' ||
          result.status === 'ignored-stale'
        ) {
          break
        }
        if (result.status === 'revision-conflict') {
          const refreshed = await this.options.repository.get(scope, record.transactionId)
          if (!refreshed) return
          graph = refreshed
          continue
        }
        throw new Error(`Starknet transaction lifecycle update failed: ${result.status}`)
      }
    }
  }

  private broadcastGraph(
    record: StarknetPendingTransfer,
    graph: TransactionGraph
  ): TransactionGraph {
    return createStarknetTransferGraph({
      chainId: record.chainId,
      scope: graph.root.scope,
      transactionId: record.transactionId,
      invokeSegmentId: lastSegmentId(graph),
      ...(graph.root.segmentIds.length > 1 ? { deploySegmentId: graph.root.segmentIds[0] } : {}),
      assetId: record.assetId,
      feeAssetId: record.feeAssetId,
      amountRaw: record.amountRaw,
      maxFeeRaw: record.maxFeeRaw,
      sender: record.sender,
      recipient: record.recipient,
      createdAt: record.createdAt,
      status: record.status === 'final' ? 'final' : record.invokeHash ? 'broadcast' : 'signed',
      ...(record.invokeHash ? { invokeHash: record.invokeHash } : {}),
      ...(record.deployHash ? { deployHash: record.deployHash } : {})
    })
  }

  private async recheck(record: StarknetPendingTransfer, signal?: AbortSignal): Promise<string> {
    const deployment = await readStarknetAccountDeployment(this.options.rpc, record.sender, signal)
    const expectedInvokeNonce = record.deployNonce === null ? feltToBigint(record.invokeNonce) : 1n
    const actualInvokeNonce = deployment.deployed ? deployment.nonce : 1n
    if (actualInvokeNonce !== expectedInvokeNonce) throw new Error('Starknet nonce changed')
    if (record.deployNonce !== null && deployment.deployed) {
      throw new Error('Starknet account deployment changed')
    }
    if (deployment.deployed && deployment.classHash !== normalizeStarknetFelt(record.classHash)) {
      throw new Error('Starknet account changed')
    }
    if (record.chainId !== this.options.chainId) throw new Error('Starknet network changed')
    const prepared = await prepareStarknetTransfer({
      rpc: this.options.rpc,
      builder: this.options.builder,
      account: {
        chainId: record.chainId,
        address: record.sender,
        publicKey: record.publicKey,
        classHash: record.classHash
      },
      tokenReference: record.assetReference,
      feeTokenReference: this.options.feeTokenReference,
      recipient: record.recipient,
      amount: BigInt(record.amountRaw),
      ...(signal === undefined ? {} : { signal })
    })
    if (
      prepared.invoke.unsigned.transactionHash !== record.invokeExecutionHash ||
      (prepared.deploy?.unsigned.transactionHash ?? null) !== record.deployExecutionHash
    ) {
      throw new Error('Starknet review does not match the requested transfer')
    }
    return reviewHash(prepared)
  }

  private async sign(
    account: StarknetTransferAccount,
    payload: Readonly<Record<string, unknown>>,
    expectedHash: string,
    signal?: AbortSignal
  ): Promise<Readonly<Record<string, unknown>>> {
    if (isLedgerStarknetAccount(account)) {
      return this.signWithLedger(account, payload, expectedHash, signal)
    }
    const prepared = await this.options.signer.prepare(
      account.chainAccount.scope.keyDomainId,
      payload
    )
    const signed = await this.options.signer.confirm(
      account.chainAccount.scope.keyDomainId,
      prepared.commandId
    )
    if (signal?.aborted) throw new Error('Starknet signing was cancelled')
    if (
      signed.transactionHash !== expectedHash ||
      signed.transaction.version !== STARKNET_EXECUTION_VERSION
    ) {
      throw new Error('Starknet signature does not match the review')
    }
    assertStarknetExecutionTransaction(signed.transaction)
    return signed.transaction
  }

  private async signWithLedger(
    account: StarknetTransferAccount,
    payload: Readonly<Record<string, unknown>>,
    expectedHash: string,
    signal?: AbortSignal
  ): Promise<Readonly<Record<string, unknown>>> {
    const signLedger = this.options.signer.signLedger
    if (!signLedger) throw new Error('Starknet Ledger signing is not connected')
    const kind =
      payload.kind === 'starknet-deploy-account' ? 'starknet-deploy-account' : 'starknet-invoke'
    const ref = this.accountRef(account)
    if (typeof payload.nonce !== 'string') throw new Error('Starknet nonce is invalid')
    const resourceBounds = payload.resourceBounds
    if (!isResourceBounds(resourceBounds)) throw new Error('Starknet fee bounds are invalid')
    const request =
      kind === 'starknet-deploy-account'
        ? starknetDeployExternalRequest({
            chainId: ref.chainId,
            publicKey: ref.publicKey,
            accountAddress: ref.address,
            classHash: ref.classHash,
            nonce: payload.nonce,
            resourceBounds
          })
        : starknetInvokeExternalRequest({
            chainId: ref.chainId,
            publicKey: ref.publicKey,
            accountAddress: ref.address,
            classHash: ref.classHash,
            calls: payload.calls,
            nonce: payload.nonce,
            resourceBounds
          })
    const prepared = parseStarknetExternalPreparation(
      kind === 'starknet-deploy-account'
        ? await this.options.builder.prepareDeploy(request)
        : await this.options.builder.prepareInvoke(request)
    )
    if (prepared.signingHash !== expectedHash) {
      throw new Error('Starknet signature does not match the review')
    }
    const signed = await signLedger({
      account,
      kind,
      transactionHash: prepared.signingHash,
      transaction: prepared.summary,
      resourceBounds,
      request,
      ...(signal === undefined ? {} : { signal })
    })
    if (signal?.aborted) throw new Error('Starknet signing was cancelled')
    assertStarknetExecutionTransaction(signed)
    if (signed.version !== STARKNET_EXECUTION_VERSION) {
      throw new Error('Starknet signature does not match the review')
    }
    return signed
  }

  private async assertNoInFlight(sender: string): Promise<void> {
    const records = await this.options.pending.list()
    if (
      records.some(
        record =>
          record.sender === sender &&
          record.status === 'pending' &&
          record.phase !== 'awaiting-approval'
      )
    ) {
      throw new Error('A Starknet transfer is already pending for this account')
    }
  }

  private async requirePending(
    transactionId: string,
    account: StarknetTransferAccount
  ): Promise<StarknetPendingTransfer> {
    this.assertCanSend(account)
    const parsed = parseTransactionId(transactionId)
    const pending = await this.options.pending.get(parsed)
    if (
      !pending ||
      pending.scope.keyDomainId !== account.chainAccount.scope.keyDomainId ||
      pending.scope.accountId !== account.chainAccount.scope.accountId
    ) {
      throw new Error('Pending Starknet transfer was not found')
    }
    return pending
  }

  private recordFromPrepared(input: {
    readonly prepared: StarknetPreparedTransfer
    readonly transactionId: TransactionId
    readonly account: StarknetTransferAccount
    readonly assetId: string
    readonly feeAssetId: string
    readonly reviewedHash: string
    readonly createdAt: number
  }): StarknetPendingTransfer {
    const prepared = input.prepared
    return {
      schemaVersion: 1,
      transactionId: input.transactionId,
      phase: 'awaiting-approval',
      status: 'pending',
      scope: {
        keyDomainId: input.account.chainAccount.scope.keyDomainId,
        accountId: input.account.chainAccount.scope.accountId
      },
      chainId: this.options.chainId,
      sender: prepared.account.address,
      publicKey: prepared.account.publicKey,
      classHash: prepared.account.classHash,
      accountIndex: input.account.accountIndex,
      addressIndex: input.account.addressIndex,
      recipient: prepared.recipient,
      assetId: input.assetId,
      assetReference: prepared.assetReference,
      feeAssetId: input.feeAssetId,
      amountRaw: prepared.amount.toString(),
      maxFeeRaw: prepared.maxFee.toString(),
      invokeMaxFeeRaw: prepared.invoke.maxFee.toString(),
      deployMaxFeeRaw: prepared.deploy ? prepared.deploy.maxFee.toString() : null,
      reviewedHash: input.reviewedHash,
      invokeNonce: prepared.invoke.nonce,
      deployNonce: prepared.deploy ? prepared.deploy.nonce : null,
      invokeExecutionHash: prepared.invoke.unsigned.transactionHash,
      deployExecutionHash: prepared.deploy ? prepared.deploy.unsigned.transactionHash : null,
      calls: [
        {
          to: prepared.assetReference,
          selector: '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e',
          calldata: encodeAmount(prepared.amount.toString()).length
            ? [prepared.recipient, ...encodeAmount(prepared.amount.toString())]
            : []
        }
      ],
      invokeBounds: prepared.invoke.resourceBounds,
      deployBounds: prepared.deploy ? prepared.deploy.resourceBounds : null,
      signedInvoke: null,
      signedDeploy: null,
      invokeHash: null,
      deployHash: null,
      broadcastAttempted: false,
      broadcastAt: null,
      failureCode: null,
      createdAt: input.createdAt
    }
  }

  private accountRef(account: StarknetTransferAccount): StarknetAccountRef {
    if (account.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Starknet account is invalid')
    }
    return {
      chainId: this.options.chainId,
      address: normalizeStarknetFelt(account.chainAccount.identity.value),
      publicKey: assertStarknetFelt(account.publicKey, 'public key'),
      classHash: assertStarknetFelt(account.classHash, 'class hash')
    }
  }

  private feeAssetId(): string {
    const reference = normalizeStarknetFelt(this.options.feeTokenReference)
    const asset = this.options.assets
      .list(parseChainId(this.options.chainId).id)
      .find(entry => entry.asset.kind === 'token' && entry.asset.reference === reference)
    if (!asset) throw new Error('Starknet fee token is not registered')
    return asset.asset.id
  }

  private assertCanSend(account: StarknetTransferAccount): void {
    if (account.keyDomainSource.kind === 'software') return
    if (!isLedgerStarknetAccount(account) || !ledgerClassCanSend(account.classHash)) {
      throw new Error('Starknet hardware send is not enabled')
    }
  }

  private assertChain(chainId: string): void {
    if (chainId !== this.options.chainId) throw new Error('Starknet network changed')
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private createId(): string {
    return (this.options.createId ?? (() => crypto.randomUUID()))()
  }
}

function invokePayload(record: StarknetPendingTransfer): Readonly<Record<string, unknown>> {
  return {
    kind: 'starknet-invoke',
    chainId: record.chainId,
    accountIndex: record.accountIndex,
    addressIndex: record.addressIndex,
    classHash: record.classHash,
    calls: [
      {
        to: record.assetReference,
        selector: '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e',
        calldata: transferCalldata(record)
      }
    ],
    nonce: record.invokeNonce,
    resourceBounds: record.invokeBounds
  }
}

function deployPayload(record: StarknetPendingTransfer): Readonly<Record<string, unknown>> {
  return {
    kind: 'starknet-deploy-account',
    chainId: record.chainId,
    accountIndex: record.accountIndex,
    addressIndex: record.addressIndex,
    classHash: record.classHash,
    nonce: record.deployNonce,
    resourceBounds: record.deployBounds
  }
}

function isDeployNotVisible(error: unknown): boolean {
  if (!(error instanceof StarknetRpcError)) return false
  if (error.code === 'contract-not-found') return true
  return /not deployed|CONTRACT_NOT_FOUND/i.test(`${error.message} ${error.detail ?? ''}`)
}

function isLedgerStarknetAccount(account: StarknetTransferAccount): boolean {
  return account.keyDomainSource.kind === 'hardware' && account.keyDomainSource.vendor === 'ledger'
}

function ledgerClassCanSend(classHash: string): boolean {
  const normalized = normalizeStarknetFelt(classHash)
  return (
    normalized === normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH) ||
    normalized === normalizeStarknetFelt(STARKNET_ARGENT_V05_CLASS_HASH)
  )
}

function isResourceBounds(
  value: unknown
): value is StarknetPreparedTransfer['invoke']['resourceBounds'] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Boolean(record.l1Gas && record.l2Gas && record.l1DataGas)
}

function transferCalldata(record: StarknetPendingTransfer): readonly string[] {
  const [low, high] = encodeAmount(record.amountRaw)
  return [record.recipient, low, high]
}

function lastSegmentId(graph: TransactionGraph) {
  const segmentId = graph.root.segmentIds[graph.root.segmentIds.length - 1]
  if (!segmentId) throw new Error('Starknet review is missing')
  return segmentId
}

function encodeAmount(amountRaw: string): readonly [string, string] {
  const amount = BigInt(amountRaw)
  const low = amount & ((1n << 128n) - 1n)
  const high = amount >> 128n
  return [feltFromBigint(low), feltFromBigint(high)]
}

async function reviewHash(prepared: StarknetPreparedTransfer): Promise<string> {
  const canonical = [
    prepared.account.chainId,
    prepared.account.address,
    prepared.assetReference,
    prepared.recipient,
    prepared.amount.toString(),
    prepared.invoke.nonce,
    prepared.invoke.unsigned.transactionHash,
    prepared.invoke.maxFee.toString(),
    prepared.deploy?.nonce ?? '',
    prepared.deploy?.unsigned.transactionHash ?? '',
    prepared.deploy?.maxFee.toString() ?? ''
  ].join('|')
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonical))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
