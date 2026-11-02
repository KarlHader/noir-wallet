import type { RheaSwapService } from '@/core/services/rhea-swap'
import type { SwapStatus } from '@/core/services/intents-api'
import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionLifecycleStatus,
  type TransactionSegment,
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { loadTransactions } from '@/lib/indexed-db'
import { transactionRecorder } from './transaction-recorder'
import { getZcashChainId, parseAssetId } from '@/core/chains/registry'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap'
import { isAccountScopeForNetwork, type AccountScope } from '@/core/wallet/account-scope'
import type { Transaction } from '@/types'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { getRheaSwapProgressStatus } from '@/lib/swap-progress'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import { ANALYTICS_EVENTS, trackEvent } from '@/background/analytics/reporter'
import { transactionAnalyticsFamily } from '@/core/transactions/transaction-analytics'

export const RHEA_SWAP_TRANSACTION_MONITOR_ALARM = 'rhea-swap-transaction-monitor-alarm'

const STORAGE_KEY = 'rhea_swap_pending_transactions'
const POLL_DELAY_MINUTES = 0.5

export interface PendingRheaSwapTransaction {
  readonly quoteHandle: string
  readonly accountKey: string
  readonly walletId: TransactionAccountScope['keyDomainId']
  readonly accountId: TransactionAccountScope['accountId']
  readonly transactionId: string
  readonly isCrossChain: boolean
  readonly destinationAsset?: string
  readonly destinationChain?: string
  readonly settled?: boolean
}

export interface RheaSwapPortfolioRefreshRequest {
  readonly scope: TransactionAccountScope
  readonly chainIds: readonly string[]
}

export interface RheaSwapTransactionMonitorOptions {
  readonly refreshPortfolio?: (request: RheaSwapPortfolioRefreshRequest) => Promise<void>
  readonly prepareZcashDestinationCatchUp?: (scope: TransactionAccountScope) => Promise<void>
  readonly notifyStatus?: (quoteHandle: string, status: SwapStatus) => void
  readonly loadZcashAccountScopes?: () => readonly AccountScope[]
  readonly loadZcashTransactions?: (accountKey: string) => Promise<readonly Transaction[]>
  readonly updateZcashTransaction?: (
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction>
  ) => Promise<void>
}

function parsePending(value: unknown, allowLegacyAsset = false): PendingRheaSwapTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid pending RHEA Swap transaction')
  }
  const record = value as Record<string, unknown>
  const required = [
    'quoteHandle',
    'accountKey',
    'walletId',
    'accountId',
    'transactionId',
    'isCrossChain'
  ]
  const optional = ['destinationAsset', 'destinationChain', 'settled']
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !allowed.has(key)) ||
    typeof record.isCrossChain !== 'boolean' ||
    (record.settled !== undefined && typeof record.settled !== 'boolean')
  ) {
    throw new Error('Invalid pending RHEA Swap transaction fields')
  }
  const read = (key: string, maximum = 512): string => {
    const candidate = record[key]
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > maximum ||
      candidate.trim() !== candidate ||
      /[\u0000-\u001f\u007f-\u009f]/.test(candidate)
    ) {
      throw new Error(`Invalid pending RHEA Swap ${key}`)
    }
    return candidate
  }
  const accountKey = read('accountKey')
  const walletId = parseKeyDomainId(read('walletId'))
  const accountId = parseAccountId(read('accountId'))
  if (!isAccountScopeForNetwork({ accountKey, walletId, accountId }, 'mainnet')) {
    throw new Error('RHEA Swap monitor account scope does not match Mainnet')
  }
  const destinationAsset =
    record.destinationAsset === undefined
      ? null
      : resolveMonitorDestinationAsset(read('destinationAsset'))
  if (record.destinationAsset !== undefined && !destinationAsset && !allowLegacyAsset) {
    throw new Error('Invalid pending RHEA Swap destination asset')
  }
  return Object.freeze({
    quoteHandle: read('quoteHandle', 160),
    accountKey,
    walletId,
    accountId,
    transactionId: read('transactionId'),
    isCrossChain: record.isCrossChain,
    ...(destinationAsset ? { destinationAsset } : {}),
    ...(record.destinationChain === undefined
      ? {}
      : { destinationChain: read('destinationChain', 64) }),
    ...(record.settled === undefined ? {} : { settled: record.settled })
  })
}

function resolveMonitorDestinationAsset(value: string) {
  const mapped = resolveRheaSwapCanonicalAssetId(value, 'mainnet')
  if (mapped) return mapped
  try {
    const parsed = parseAssetId(value)
    return /^rhea:[1-9][0-9]*$/.test(parsed.chainId) && parsed.namespace === 'rhea'
      ? parsed.id
      : null
  } catch {
    return null
  }
}

export class RheaSwapTransactionMonitor {
  private readonly pending = new Map<string, PendingRheaSwapTransaction>()
  private readonly pendingQueue = new SerialTaskQueue()
  private readonly checkDedup = new Map<string, DedupPromise<void>>()
  private loaded = false
  private readonly repository = new IndexedDbTransactionRepository()
  private readonly storageRepository = new IndexedDbStorageV2Repository()

  constructor(
    private readonly service: RheaSwapService,
    private readonly options: RheaSwapTransactionMonitorOptions = {}
  ) {}

  async init(): Promise<void> {
    let graphPending = false
    let reportPending = false
    let failed = true
    try {
      await this.pendingQueue.run(async () => {
        await this.load()
        await this.restorePendingZcashSwapsLoaded()
      })
      graphPending = await this.pollGraphs()
      reportPending = await this.retryReports()
      failed = false
    } finally {
      await this.schedule(failed || graphPending || reportPending)
    }
  }

  async add(value: unknown): Promise<void> {
    const transaction = parsePending(value)
    await this.pendingQueue.run(async () => {
      await this.load()
      const existing = this.pending.get(transaction.quoteHandle)
      if (
        existing &&
        (existing.accountKey !== transaction.accountKey ||
          existing.transactionId !== transaction.transactionId)
      ) {
        throw new Error('RHEA Swap quote is already monitored for another transaction')
      }
      this.pending.set(transaction.quoteHandle, existing?.settled ? existing : transaction)
      try {
        await this.save()
      } catch (error) {
        if (existing) this.pending.set(transaction.quoteHandle, existing)
        else this.pending.delete(transaction.quoteHandle)
        throw error
      }
      await this.schedule(false)
    })
  }

  async handleAlarm(): Promise<void> {
    let graphPending = false
    let reportPending = false
    let failed = true
    try {
      const pending = await this.pendingQueue.run(async () => {
        await this.load()
        await this.restorePendingZcashSwapsLoaded()
        return [...this.pending.values()]
      })
      await Promise.allSettled(pending.map(value => this.check(value)))
      graphPending = await this.pollGraphs()
      reportPending = await this.retryReports()
      failed = false
    } finally {
      await this.schedule(failed || graphPending || reportPending)
    }
  }

  async recheckNow(): Promise<boolean> {
    const pending = await this.pendingQueue.run(async () => {
      await this.load()
      await this.restorePendingZcashSwapsLoaded()
      return [...this.pending.values()]
    })
    await Promise.allSettled(pending.map(value => this.check(value)))
    const graphPending = await this.pollGraphs()
    const reportPending = await this.retryReports()
    await this.schedule(graphPending || reportPending)
    return this.pending.size > 0 || graphPending || reportPending
  }

  async removeAccounts(walletId: string, accountIds: readonly string[]): Promise<void> {
    const keyDomainId = parseKeyDomainId(walletId)
    const accounts = [...new Set(accountIds.map(parseAccountId))]
    if (accounts.length === 0) throw new Error('No RHEA Swap Accounts to remove')
    const graphHandles = new Set<string>()
    for (const accountId of accounts) {
      const handles = await this.repository.listRheaSwapQuoteHandlesByAccountScope({
        keyDomainId,
        accountId
      })
      for (const handle of handles) graphHandles.add(handle)
    }
    await this.pendingQueue.run(async () => {
      await this.load()
      const quoteHandles = new Set(graphHandles)
      const removedEntries = new Map<string, PendingRheaSwapTransaction>()
      for (const [quoteHandle, value] of this.pending) {
        if (value.walletId === walletId && accounts.includes(value.accountId)) {
          quoteHandles.add(quoteHandle)
          removedEntries.set(quoteHandle, value)
        }
      }
      await Promise.all([...quoteHandles].map(quoteHandle => this.service.discard(quoteHandle)))
      for (const quoteHandle of removedEntries.keys()) this.pending.delete(quoteHandle)
      try {
        await this.save()
      } catch (error) {
        for (const [quoteHandle, value] of removedEntries) this.pending.set(quoteHandle, value)
        throw error
      }
      await this.schedule(false)
    })
  }

  async clear(): Promise<void> {
    await this.pendingQueue.run(async () => {
      await this.service.clearSessions()
      const previous = new Map(this.pending)
      this.pending.clear()
      try {
        await this.save()
      } catch (error) {
        for (const [handle, value] of previous) this.pending.set(handle, value)
        throw error
      }
      this.loaded = true
      await this.schedule(false)
    })
  }

  async restorePendingZcashSwaps(
    scopes = this.options.loadZcashAccountScopes?.() ?? []
  ): Promise<number> {
    return this.pendingQueue.run(async () => {
      await this.load()
      return this.restorePendingZcashSwapsLoaded(scopes)
    })
  }

  private async restorePendingZcashSwapsLoaded(
    scopes = this.options.loadZcashAccountScopes?.() ?? []
  ): Promise<number> {
    let restored = 0
    const restoredHandles: string[] = []
    for (const scope of scopes) {
      if (!isAccountScopeForNetwork(scope, 'mainnet')) continue
      let transactions: readonly Transaction[]
      try {
        transactions = await this.readZcashTransactions(scope.accountKey)
      } catch {
        continue
      }
      for (const transaction of transactions) {
        const binding = transaction.quoteBinding
        if (
          transaction.type !== 'swap' ||
          (transaction.status !== 'pending' && transaction.status !== 'confirming') ||
          !transaction.txHash ||
          binding?.provider !== 'rhea-cross-chain-dex' ||
          !binding.quoteHandle ||
          typeof binding.isCrossChain !== 'boolean' ||
          this.pending.has(binding.quoteHandle)
        ) {
          continue
        }
        if (!(await this.service.canRecoverTransactionSubmission(binding.quoteHandle))) continue
        try {
          const destinationAsset = binding.destinationAsset
            ? resolveMonitorDestinationAsset(binding.destinationAsset)
            : null
          const pending = parsePending({
            quoteHandle: binding.quoteHandle,
            accountKey: scope.accountKey,
            walletId: scope.walletId,
            accountId: scope.accountId,
            transactionId: transaction.id,
            isCrossChain: binding.isCrossChain,
            ...(destinationAsset ? { destinationAsset } : {}),
            ...(binding.destinationChain ? { destinationChain: binding.destinationChain } : {})
          })
          this.pending.set(pending.quoteHandle, pending)
          restored += 1
          restoredHandles.push(pending.quoteHandle)
        } catch {
          // An incomplete legacy binding cannot be assigned to an order safely.
        }
      }
    }
    if (restored > 0) {
      try {
        await this.save()
      } catch (error) {
        for (const handle of restoredHandles) this.pending.delete(handle)
        throw error
      }
      await this.schedule(false)
    }
    return restored
  }

  private readZcashTransactions(accountKey: string): Promise<readonly Transaction[]> {
    return this.options.loadZcashTransactions?.(accountKey) ?? loadTransactions(accountKey)
  }

  private async check(value: PendingRheaSwapTransaction): Promise<void> {
    let dedup = this.checkDedup.get(value.quoteHandle)
    if (!dedup) {
      dedup = new DedupPromise<void>()
      this.checkDedup.set(value.quoteHandle, dedup)
    }
    try {
      await dedup.run(() => this.checkPending(value))
    } finally {
      if (!dedup.isPending) this.checkDedup.delete(value.quoteHandle)
    }
  }

  private async checkPending(value: PendingRheaSwapTransaction): Promise<void> {
    const transactions = await this.readZcashTransactions(value.accountKey)
    const transaction = transactions.find(candidate => candidate.id === value.transactionId)
    if (
      !transaction?.txHash ||
      transaction.type !== 'swap' ||
      transaction.quoteBinding?.provider !== 'rhea-cross-chain-dex' ||
      transaction.quoteBinding.quoteHandle !== value.quoteHandle
    ) {
      await this.finish(value)
      return
    }
    if (!(await this.service.canRecoverTransactionSubmission(value.quoteHandle))) {
      console.warn('[RHEA Swap Monitor] Recovery session is unavailable', {
        transactionId: value.transactionId
      })
      await this.finish(value)
      return
    }
    await this.service.recordTransactionSubmission(value.quoteHandle, transaction.txHash)
    let reported = false
    try {
      await this.service.reportSubmission(value.quoteHandle)
      reported = true
    } catch {
      // Order observation and local finality do not depend on report delivery.
    }
    if (!this.pending.has(value.quoteHandle)) return
    if (value.settled || transaction.status === 'success' || transaction.status === 'failed') {
      if (reported) await this.finish(value)
      return
    }

    let status:
      | 'pending'
      | 'processing'
      | 'completed'
      | 'failed'
      | 'refunded'
      | 'expired'
      | 'unknown'
    let destinationHash: string | null = null
    try {
      const observation = await this.service.getOrderStatus(value.quoteHandle)
      status = observation.status
      destinationHash = observation.destinationHash
    } catch (error) {
      if (value.isCrossChain) return
      if (!transaction?.confirmations || transaction.confirmations <= 0) return
      status = 'completed'
    }

    if (status === 'pending' || status === 'processing' || status === 'unknown') {
      if (!this.pending.has(value.quoteHandle)) return
      if (destinationHash) {
        await this.updateZcashTransaction(value.accountKey, value.transactionId, {
          destinationTxHash: destinationHash
        })
      }
      return
    }
    if (!this.pending.has(value.quoteHandle)) return
    if (status === 'completed') {
      if (
        value.destinationAsset &&
        parseAssetId(value.destinationAsset).chainId === getZcashChainId('mainnet')
      ) {
        await this.options.prepareZcashDestinationCatchUp?.({
          keyDomainId: value.walletId,
          accountId: value.accountId
        })
      }
      await this.updateZcashTransaction(value.accountKey, value.transactionId, {
        status: 'success',
        ...(destinationHash ? { destinationTxHash: destinationHash } : {}),
        notified: true
      })
      await this.refreshPortfolio(
        { keyDomainId: value.walletId, accountId: value.accountId },
        value.destinationAsset ? [parseAssetId(value.destinationAsset).chainId] : []
      )
    } else {
      await this.updateZcashTransaction(value.accountKey, value.transactionId, {
        status: 'failed',
        ...(destinationHash ? { destinationTxHash: destinationHash } : {}),
        memo: status === 'refunded' ? 'Refunded' : undefined,
        notified: true
      })
    }
    trackEvent(ANALYTICS_EVENTS.SWAP_COMPLETED, {
      chain: 'zcash',
      hasTransaction: 1,
      idempotencyKey: `rhea-completed:${value.quoteHandle}`,
      extra: {
        status: status === 'completed' ? 'SUCCESS' : status === 'refunded' ? 'REFUNDED' : 'FAILED',
        action: 'Swap'
      }
    })
    if (reported) {
      await this.finish(value)
    } else {
      await this.pendingQueue.run(async () => {
        if (!this.pending.has(value.quoteHandle)) return
        const previous = this.pending.get(value.quoteHandle)!
        this.pending.set(value.quoteHandle, Object.freeze({ ...value, settled: true }))
        try {
          await this.save()
        } catch (error) {
          this.pending.set(value.quoteHandle, previous)
          throw error
        }
      })
    }
  }

  private async finish(value: PendingRheaSwapTransaction): Promise<void> {
    const removed = await this.pendingQueue.run(async () => {
      if (!this.pending.has(value.quoteHandle)) return false
      const previous = this.pending.get(value.quoteHandle)!
      this.pending.delete(value.quoteHandle)
      try {
        await this.save()
      } catch (error) {
        this.pending.set(value.quoteHandle, previous)
        throw error
      }
      return true
    })
    if (removed) await this.service.discard(value.quoteHandle).catch(() => {})
  }

  private updateZcashTransaction(
    accountKey: string,
    transactionId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    return (
      this.options.updateZcashTransaction?.(accountKey, transactionId, updates) ??
      transactionRecorder.updateTransaction(accountKey, transactionId, updates)
    )
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
    if (stored === undefined) {
      this.loaded = true
      return
    }
    if (!Array.isArray(stored) || stored.length > 128) {
      throw new Error('Invalid persisted RHEA Swap monitor state')
    }
    this.pending.clear()
    for (const value of stored) {
      const parsed = parsePending(value, true)
      this.pending.set(parsed.quoteHandle, parsed)
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: [...this.pending.values()] })
  }

  private async pollGraphs(): Promise<boolean> {
    const scopes = await this.loadPersistedScopes()
    const graphs = (
      await Promise.all(
        scopes.map(scope =>
          this.repository.list({ scope, statuses: ['broadcast', 'confirming'], limit: 200 })
        )
      )
    ).flat()
    const work = graphs.filter(
      graph => graph.root.intent?.protocol?.provider === 'rhea-cross-chain-dex'
    )
    if (work.length === 0) return false
    const results = await Promise.allSettled(work.map(graph => this.checkGraph(graph)))
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return
      const binding = work[index]?.root.intent?.protocol
      console.warn('[RHEA Swap Monitor] Graph poll failed', {
        quoteHandle: binding?.provider === 'rhea-cross-chain-dex' ? binding.quoteHandle : 'unknown',
        errorName: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        errorMessage:
          result.reason instanceof Error ? result.reason.message : 'RHEA Swap graph poll failed'
      })
    })
    return results.some(
      result => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value)
    )
  }

  private async loadPersistedScopes(): Promise<readonly TransactionAccountScope[]> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation is invalid')
    }
    const scopes = new Map<string, TransactionAccountScope>()
    for (const chainAccount of snapshot.chainAccounts) {
      const scope = Object.freeze({
        keyDomainId: chainAccount.scope.keyDomainId,
        accountId: chainAccount.scope.accountId
      })
      scopes.set(JSON.stringify([scope.keyDomainId, scope.accountId]), scope)
    }
    return Object.freeze([...scopes.values()])
  }

  private async checkGraph(graph: TransactionGraph): Promise<boolean> {
    const binding = graph.root.intent?.protocol
    if (!binding || binding.provider !== 'rhea-cross-chain-dex') return true
    const origins = graph.segments.filter(segment => segment.role === 'origin')
    if (origins.length === 0) return false
    const pendingOnchainOrigin = origins.some(
      origin =>
        origin.target.kind === 'onchain' &&
        origin.status !== 'broadcast' &&
        origin.status !== 'confirming' &&
        origin.status !== 'final'
    )
    if (pendingOnchainOrigin) return false
    const sourceHashes = origins
      .map(origin => origin.evidence?.transactionHash)
      .filter((value): value is string => value !== undefined)
    const sourceHash = sourceHashes.at(-1)
    const orderReference = origins.at(-1)?.evidence?.externalReference
    if (!sourceHash && !orderReference) return false
    if (sourceHash) {
      await this.service.recordTransactionSubmission(binding.quoteHandle, sourceHash)
    }
    try {
      await this.service.reportSubmission(binding.quoteHandle)
    } catch {
      // A persisted submission retries independently of graph finality.
    }

    if (!binding.isCrossChain) {
      if (origins.some(origin => origin.target.kind === 'onchain' && origin.status !== 'final')) {
        return false
      }
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'relay', 'final', {
        externalReference: binding.quoteHandle
      })
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'destination', 'final', {
        ...(sourceHash === undefined
          ? { externalReference: orderReference }
          : { transactionHash: sourceHash })
      })
      await this.refreshPortfolio(graph.root.scope, [
        binding.origin.chainId,
        binding.destination.chainId
      ])
      await this.notifyStatus(graph, 'SUCCESS')
      await this.service.retireReportedSubmission(binding.quoteHandle)
      return true
    }

    console.info('[RHEA Swap Monitor] Polling order status', {
      quoteHandle: binding.quoteHandle,
      transactionId: graph.root.id
    })
    const orderStatus = await this.service.getOrderStatus(binding.quoteHandle)
    const status = orderStatus.status
    console.info('[RHEA Swap Monitor] Order status received', {
      quoteHandle: binding.quoteHandle,
      status
    })
    if (orderStatus.destinationHash) {
      const destination = graph.segments.find(segment => segment.role === 'destination')
      if (destination && !destination.evidence?.transactionHash) {
        await this.applyGraphSegment(
          graph.root.scope,
          graph.root.id,
          'destination',
          destination.status === 'confirming' ? 'confirming' : 'broadcast',
          { transactionHash: orderStatus.destinationHash }
        )
      }
    }
    if (status === 'pending' || status === 'unknown') return false
    if (status === 'processing') {
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'relay', 'confirming', {
        externalReference: binding.quoteHandle
      })
      await this.notifyStatus(graph, 'PROCESSING')
      return false
    }
    if (status === 'completed') {
      if (binding.destination.chainId === getZcashChainId('mainnet')) {
        await this.options.prepareZcashDestinationCatchUp?.(graph.root.scope)
      }
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'relay', 'final', {
        externalReference: binding.quoteHandle
      })
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'destination', 'final', {
        externalReference: binding.executionId,
        ...(orderStatus.destinationHash ? { transactionHash: orderStatus.destinationHash } : {})
      })
      await this.refreshPortfolio(graph.root.scope, [
        binding.origin.chainId,
        binding.destination.chainId
      ])
      await this.notifyStatus(graph, 'SUCCESS')
      await this.service.retireReportedSubmission(binding.quoteHandle)
      return true
    }
    if (status === 'refunded') {
      await this.applyGraphSegment(graph.root.scope, graph.root.id, 'refund', 'final', {
        externalReference: binding.quoteHandle
      })
    }
    await this.applyGraphSegment(graph.root.scope, graph.root.id, 'relay', 'failed', undefined, {
      code: status === 'refunded' ? 'refunded' : status === 'expired' ? 'expired' : 'relay-failed',
      occurredAt: Date.now()
    })
    await this.notifyStatus(graph, status === 'refunded' ? 'REFUNDED' : 'FAILED')
    await this.service.retireReportedSubmission(binding.quoteHandle)
    return true
  }

  private async notifyStatus(graph: TransactionGraph, status: SwapStatus['status']): Promise<void> {
    const latest = await this.repository.get(graph.root.scope, graph.root.id)
    const binding = latest?.root.intent?.protocol
    if (!latest || binding?.provider !== 'rhea-cross-chain-dex') return
    if (
      (status === 'SUCCESS' || status === 'FAILED' || status === 'REFUNDED') &&
      graph.root.status !== 'final' &&
      graph.root.status !== 'failed'
    ) {
      const chain = transactionAnalyticsFamily(binding.origin.chainId)
      if (chain) {
        const transfer = binding.userAction === 'transfer'
        trackEvent(
          transfer
            ? status === 'SUCCESS'
              ? ANALYTICS_EVENTS.SEND_SUCCEEDED
              : ANALYTICS_EVENTS.SEND_FAILED
            : ANALYTICS_EVENTS.SWAP_COMPLETED,
          {
            chain,
            hasTransaction: 1,
            idempotencyKey: `rhea-terminal:${binding.quoteHandle}`,
            extra: transfer ? { kind: 'transfer' } : { status, action: 'Swap', sourceFamily: chain }
          }
        )
      }
    }
    const value = getRheaSwapProgressStatus(latest.segments, {
      status,
      originAsset: binding.origin.assetId,
      destinationAsset: binding.destination.assetId
    })
    if (this.options.notifyStatus) {
      this.options.notifyStatus(binding.quoteHandle, value)
      return
    }
    void chrome.runtime
      .sendMessage({
        type: 'CROSS_CHAIN_STATUS_UPDATED',
        quoteHandle: binding.quoteHandle,
        status: value
      })
      .catch(() => {})
  }

  private async applyGraphSegment(
    scope: TransactionAccountScope,
    transactionId: TransactionGraph['root']['id'],
    role: TransactionSegment['role'],
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure']
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.repository.get(scope, transactionId)
      const segment = graph?.segments.find(candidate => candidate.role === role)
      if (!graph || !segment || segment.status === 'final' || segment.status === 'failed') {
        return false
      }
      const observedAt = Date.now()
      const result = await this.repository.applySegmentEvent({
        scope,
        transactionId,
        segmentId: segment.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:rhea-swap:${crypto.randomUUID()}`),
          status,
          cause: status === 'failed' ? 'failure' : 'progress',
          observedAt,
          ...(evidence === undefined ? {} : { evidence }),
          ...(failure === undefined ? {} : { failure })
        }),
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status === 'applied') return true
      if (
        result.status === 'duplicate-event' ||
        result.status === 'ignored-stale' ||
        result.status === 'not-found'
      ) {
        return false
      }
      if (result.status !== 'revision-conflict') {
        throw new Error('RHEA Swap monitor could not persist its observation')
      }
    }
    return false
  }

  private async refreshPortfolio(
    scope: TransactionAccountScope,
    chainIds: readonly string[]
  ): Promise<void> {
    if (!this.options.refreshPortfolio || chainIds.length === 0) return
    try {
      await this.options.refreshPortfolio({
        scope,
        chainIds: Object.freeze([...new Set(chainIds)])
      })
    } catch (error) {
      console.warn('[RHEA Swap Monitor] Portfolio refresh after completion failed:', error)
    }
  }

  private async retryReports(): Promise<boolean> {
    try {
      return await this.service.retryPendingReports()
    } catch (error) {
      console.warn('[RHEA Swap Monitor] Could not inspect pending reports:', error)
      return true
    }
  }

  private async schedule(graphPending: boolean): Promise<void> {
    if (this.pending.size === 0 && !graphPending) {
      await chrome.alarms.clear(RHEA_SWAP_TRANSACTION_MONITOR_ALARM)
      return
    }
    await scheduleRheaSwapTransactionMonitorRetry()
  }
}

export async function scheduleRheaSwapTransactionMonitorRetry(): Promise<void> {
  await chrome.alarms.create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, {
    delayInMinutes: POLL_DELAY_MINUTES
  })
}

export async function recoverSignedRheaSwaps(
  recoveries: readonly { name: string; recover: () => Promise<unknown> }[]
): Promise<boolean> {
  const results = await Promise.allSettled(
    recoveries.map(({ recover }) => Promise.resolve().then(recover))
  )
  let failed = false
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed = true
      console.warn(
        `[RHEA Swap Monitor] ${recoveries[index].name} signed recovery failed:`,
        result.reason
      )
    }
  })
  return failed
}

export async function recoverSignedRheaSwapsAndPoll(
  recoveries: readonly { name: string; recover: () => Promise<unknown> }[],
  monitor: Pick<RheaSwapTransactionMonitor, 'handleAlarm'> | null | undefined
): Promise<void> {
  const recoveryFailed = await recoverSignedRheaSwaps(recoveries)
  try {
    await monitor?.handleAlarm()
  } finally {
    if (recoveryFailed) await scheduleRheaSwapTransactionMonitorRetry()
  }
}
