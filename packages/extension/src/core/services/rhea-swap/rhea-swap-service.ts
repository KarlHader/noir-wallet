import {
  normalizeBuild,
  normalizeOrderStatus,
  normalizeQuote,
  type Quote,
  type QuoteRequest,
  type SwapBuild,
  type EvmApproval,
  type EvmTx,
  type SwapBuildDataRaw,
  type SwapBuildRequestRaw,
  type SwapClient,
  type SwapOrderSubmitDataRaw,
  type SwapReportRequestRaw,
  type SwapQuoteDataRaw,
  type SwapTokenListItem
} from '@rhea-finance/cross-chain-aggregation-dex'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  parseRheaSwapQuoteRequest,
  toRheaSwapExecutionView,
  toRheaSwapToken,
  toSdkQuoteRequest,
  type RheaSwapQuoteView,
  type RheaSwapReviewView,
  type RheaSwapOrderStatusView,
  type RheaSwapEvmTransactionPlan,
  type RheaSwapEvmSignaturePlan,
  type RheaSwapSolanaTransactionPlan,
  type RheaSwapNearTransactionBatchPlan,
  type RheaSwapSubmissionView,
  type RheaSwapToken
} from './rhea-swap-model'
import { readRheaDestinationHash } from './rhea-order-status'
import { getRheaSwapQuoteDeadline, isRheaSwapQuoteFresh } from './rhea-swap-quote-validity'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'

const MAXIMUM_SESSION_RECORDS = 16

function toEvmCallView(tx: EvmTx): RheaSwapEvmTransactionPlan['transaction'] {
  return Object.freeze({
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    from: tx.from ?? null
  })
}

function readExactEvmApproval(input: {
  readonly approval?: EvmApproval
  readonly chainId: number
  readonly sender: string
  readonly tokenIn: string
  readonly amountIn: string
}): RheaSwapEvmTransactionPlan['approval'] {
  if (!input.approval) return null
  const data = input.approval.tx.data.toLowerCase()
  const tokenContract = input.tokenIn.toLowerCase()
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(input.sender) ||
    !/^0x[0-9a-f]{40}$/.test(tokenContract) ||
    !/^0x095ea7b3[0-9a-f]{128}$/.test(data) ||
    input.approval.tx.value !== '0'
  ) {
    throw new Error('RHEA Swap EVM approval is invalid')
  }
  const spender = `0x${data.slice(34, 74)}`
  const amountRaw = BigInt(`0x${data.slice(74, 138)}`).toString()
  if (
    input.approval.tx.to.toLowerCase() !== tokenContract ||
    spender !== input.approval.spender.toLowerCase() ||
    amountRaw !== input.amountIn ||
    input.approval.tx.chainId !== input.chainId ||
    (input.approval.tx.from && input.approval.tx.from.toLowerCase() !== input.sender.toLowerCase())
  ) {
    throw new Error('RHEA Swap EVM approval does not match the quoted source asset')
  }
  return Object.freeze({
    transaction: toEvmCallView(input.approval.tx),
    spender,
    amountRaw
  })
}

export interface RheaSwapQuoteSessionRecord {
  readonly schemaVersion: 1
  readonly quoteHandle: string
  readonly request: QuoteRequest
  readonly quoteRaw: SwapQuoteDataRaw
  readonly receivedAt: number
  readonly expiresAt: number | null
  readonly build?: Readonly<{
    executionId: string
    request: SwapBuildRequestRaw
    raw: SwapBuildDataRaw
  }>
  readonly submission?: Readonly<{
    sourceHash: string
    orderId: string | null
    router: string
    statusChainId: string | null
    reportRequest: SwapReportRequestRaw
    reportStatus: 'pending' | 'reported' | 'failed'
    disposeAfterReport?: boolean
  }>
}

export interface RheaSwapQuoteSessionStore {
  readonly get: (quoteHandle: string) => Promise<RheaSwapQuoteSessionRecord | null>
  readonly put: (record: RheaSwapQuoteSessionRecord) => Promise<void>
  readonly delete: (quoteHandle: string) => Promise<void>
  readonly listUnreported: () => Promise<readonly string[]>
  readonly clear: () => Promise<void>
}

export interface RheaSwapProtocolClient extends Pick<
  SwapClient,
  | 'getFromTokens'
  | 'getCrossChainToTokens'
  | 'quote'
  | 'buildSwap'
  | 'submitOrderRaw'
  | 'reportRaw'
  | 'getOrderStatusRaw'
> {}

export interface RheaSwapCatalogResult {
  readonly tokens: readonly RheaSwapToken[]
  readonly failedChainIds: readonly number[]
}

export class RheaSwapService {
  private readonly now: () => number
  private readonly createHandle: () => string
  private readonly reportDedup = new Map<string, DedupPromise<RheaSwapSubmissionView>>()
  private readonly sessionQueues = new Map<string, { queue: SerialTaskQueue; active: number }>()
  private clearingSessions = false
  private sessionEpoch = 0

  constructor(
    private readonly client: RheaSwapProtocolClient,
    private readonly sessions: RheaSwapQuoteSessionStore,
    options: { readonly now?: () => number; readonly createHandle?: () => string } = {}
  ) {
    this.now = options.now ?? Date.now
    this.createHandle = options.createHandle ?? (() => crypto.randomUUID())
  }

  async listTokens(input: {
    readonly direction: 'from' | 'cross-chain-to'
    readonly tokenListChainIds: readonly number[]
    readonly signal?: AbortSignal
  }): Promise<RheaSwapCatalogResult> {
    const chainIds = this.parseTokenListChainIds(input.tokenListChainIds)
    const tokens: RheaSwapToken[] = []
    const failedChainIds: number[] = []
    let cursor = 0
    const worker = async () => {
      while (cursor < chainIds.length) {
        const chainId = chainIds[cursor++]
        try {
          const result = await this.readTokens(input.direction, chainId, input.signal)
          for (const item of result) {
            try {
              tokens.push(toRheaSwapToken(item))
            } catch {
              // A malformed catalog entry must not take every asset on its chain offline.
              // Retain usable rows, but do not treat an omitted asset as unsupported.
              if (!failedChainIds.includes(chainId)) failedChainIds.push(chainId)
            }
          }
        } catch {
          failedChainIds.push(chainId)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, chainIds.length) }, worker))
    const unique = new Map<string, RheaSwapToken>()
    for (const token of tokens) {
      const key = token.isNative
        ? `${token.rheaChainId}:native:${token.assetId}`
        : `${token.rheaChainId}:${token.rheaAddress}`
      const previous = unique.get(key)
      unique.set(
        key,
        previous
          ? Object.freeze({
              ...previous,
              sources: Object.freeze([...new Set([...previous.sources, ...token.sources])])
            })
          : token
      )
    }
    return Object.freeze({
      tokens: Object.freeze([...unique.values()]),
      failedChainIds: Object.freeze(failedChainIds.sort((left, right) => left - right))
    })
  }

  async quote(value: unknown, signal?: AbortSignal): Promise<RheaSwapQuoteView> {
    if (this.clearingSessions) throw new Error('RHEA Swap sessions are being cleared')
    const epoch = this.sessionEpoch
    const request = toSdkQuoteRequest(parseRheaSwapQuoteRequest(value))
    const quote = await this.client.quote(request, { signal })
    this.assertQuoteMatchesRequest(quote, request)
    const quoteHandle = `rhea-quote:${this.createHandle()}`
    const record: RheaSwapQuoteSessionRecord = Object.freeze({
      schemaVersion: 1,
      quoteHandle,
      request,
      quoteRaw: quote.raw,
      receivedAt: quote.receivedAt,
      expiresAt: quote.expiresAt ?? null
    })
    return this.runSessionOperation(quoteHandle, async () => {
      if (epoch !== this.sessionEpoch) throw new Error('RHEA Swap session was cleared')
      await this.sessions.put(record)
      return this.toQuoteView(record, quote)
    })
  }

  async prepare(quoteHandle: string, signal?: AbortSignal): Promise<RheaSwapReviewView> {
    const handle = this.parseQuoteHandle(quoteHandle)
    return this.runSessionOperation(handle, () => this.prepareOnce(handle, signal))
  }

  private async prepareOnce(
    quoteHandle: string,
    signal?: AbortSignal
  ): Promise<RheaSwapReviewView> {
    const record = await this.requireSession(quoteHandle)
    const quote = normalizeQuote(record.request, record.quoteRaw, record.receivedAt)
    this.assertQuoteFresh(record, quote)
    const build = await this.client.buildSwap({ quote, signal })
    this.assertBuildMatchesQuote(build, quote)
    if (!build.request) throw new Error('RHEA Swap build is missing its normalized request')
    const updated = Object.freeze({
      ...record,
      build: Object.freeze({
        executionId: build.executionId,
        request: build.request,
        raw: build.raw
      })
    })
    await this.sessions.put(updated)
    return Object.freeze({
      ...this.toQuoteView(updated, quote),
      executionId: build.executionId,
      isCrossChain: build.isCrossChain,
      fromChain: build.fromChain,
      toChain: build.toChain,
      tokenIn: build.tokenIn,
      tokenOut: build.tokenOut,
      amountIn: build.amountIn,
      execution: toRheaSwapExecutionView(build)
    })
  }

  async readPreparedBuild(quoteHandle: string): Promise<SwapBuild> {
    const record = await this.requireSession(quoteHandle)
    if (!record.build) throw new Error('RHEA Swap has not been prepared')
    const quote = normalizeQuote(record.request, record.quoteRaw, record.receivedAt)
    this.assertQuoteFresh(record, quote)
    const build = normalizeBuild(record.build.raw, record.build.executionId, record.build.request)
    this.assertBuildMatchesQuote(build, quote)
    return build
  }

  async readZcashTransferDeadline(
    quoteHandle: string,
    transfer: { readonly executionId: string; readonly to: string; readonly amountZats: string }
  ): Promise<number> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record)
    if (
      build.execution.kind !== 'zcash-transfer' ||
      build.fromChain !== 'zcash' ||
      build.executionId !== transfer.executionId ||
      build.execution.depositAddress !== transfer.to ||
      build.execution.amount !== transfer.amountZats
    ) {
      throw new Error('RHEA Swap transfer does not match its prepared quote')
    }
    return getRheaSwapQuoteDeadline(record)
  }

  async readEvmTransactionPlan(quoteHandle: string): Promise<RheaSwapEvmTransactionPlan> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record)
    if (build.execution.kind !== 'evm-transaction') {
      throw new Error('RHEA Swap build is not an EVM transaction')
    }
    if (!build.request) throw new Error('RHEA Swap build is missing its normalized request')
    const expectedSender = build.request.sender.toLowerCase()
    if (
      (build.execution.tx.from && build.execution.tx.from.toLowerCase() !== expectedSender) ||
      String(build.execution.tx.chainId) !== String(build.fromChain)
    ) {
      throw new Error('RHEA Swap EVM transaction does not match its source account')
    }
    const approvalView = readExactEvmApproval({
      approval: build.execution.approval,
      chainId: build.execution.tx.chainId,
      sender: build.request.sender,
      tokenIn: build.request.tokenIn,
      amountIn: build.amountIn
    })
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      executionId: build.executionId,
      transaction: toEvmCallView(build.execution.tx),
      approval: approvalView
    })
  }

  async readEvmSignaturePlan(
    quoteHandle: string,
    allowExpired = false
  ): Promise<RheaSwapEvmSignaturePlan> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record, allowExpired)
    if (build.execution.kind !== 'evm-signature') {
      throw new Error('RHEA Swap build is not an EVM signature order')
    }
    if (!build.request) throw new Error('RHEA Swap build is missing its normalized request')
    const request = build.execution.request
    const sender = record.request.sender
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(sender) ||
      request.chainId !== Number(build.fromChain) ||
      String(request.router) !== build.router ||
      request.quoteId !== build.quoteId
    ) {
      throw new Error('RHEA Swap signature order does not match its quote')
    }
    const typedDataJson = JSON.stringify(request.typedData)
    if (typedDataJson.length === 0 || typedDataJson.length > 256 * 1024) {
      throw new Error('RHEA Swap typed data is invalid')
    }
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      executionId: build.executionId,
      chainId: request.chainId,
      sender,
      signingScheme: request.signingScheme ?? null,
      typedDataJson,
      approval: readExactEvmApproval({
        approval: build.execution.approval,
        chainId: request.chainId,
        sender,
        tokenIn: build.request.tokenIn,
        amountIn: build.amountIn
      })
    })
  }

  async readSolanaTransactionPlan(quoteHandle: string): Promise<RheaSwapSolanaTransactionPlan> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record)
    if (build.execution.kind !== 'solana-transaction') {
      throw new Error('RHEA Swap build is not a Solana transaction')
    }
    const metadata = build.execution.metadata
    const lookupTables = metadata?.addressLookupTableAddresses ?? []
    if (
      lookupTables.length > 32 ||
      (metadata?.txValidUntil !== undefined &&
        (!Number.isSafeInteger(metadata.txValidUntil) || metadata.txValidUntil < 0)) ||
      (metadata?.transactionSize !== undefined &&
        (!Number.isSafeInteger(metadata.transactionSize) ||
          metadata.transactionSize <= 0 ||
          metadata.transactionSize > 1_232))
    ) {
      throw new Error('RHEA Swap Solana metadata is invalid')
    }
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      executionId: build.executionId,
      chain: build.execution.chain,
      transaction: this.parseBoundedString(
        build.execution.transaction,
        'RHEA Swap Solana transaction',
        2_464
      ),
      format: this.parseBoundedString(build.execution.format, 'RHEA Swap Solana format', 32),
      metadata: Object.freeze({
        addressLookupTableAddresses: Object.freeze(
          lookupTables.map((address, index) =>
            this.parseBoundedString(address, `RHEA Swap Solana lookup table ${index}`, 64)
          )
        ),
        recentBlockhash:
          metadata?.recentBlockhash === undefined
            ? null
            : this.parseBoundedString(
                metadata.recentBlockhash,
                'RHEA Swap Solana recent blockhash',
                64
              ),
        txValidUntil: metadata?.txValidUntil ?? null,
        transactionSize: metadata?.transactionSize ?? null
      })
    })
  }

  async readNearTransactionBatchPlan(
    quoteHandle: string
  ): Promise<RheaSwapNearTransactionBatchPlan> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record)
    if (build.execution.kind !== 'near-transaction-batch') {
      throw new Error('RHEA Swap build is not a NEAR transaction batch')
    }
    if (build.execution.transactions.length === 0 || build.execution.transactions.length > 16) {
      throw new Error('RHEA Swap NEAR transaction batch size is invalid')
    }
    const transactions = build.execution.transactions.map((transaction, index) => {
      if (transaction.actions.length === 0 || transaction.actions.length > 100) {
        throw new Error(`RHEA Swap NEAR transaction ${index} actions are invalid`)
      }
      const actionsJson = JSON.stringify(transaction.actions)
      if (actionsJson.length === 0 || actionsJson.length > 256 * 1024) {
        throw new Error(`RHEA Swap NEAR transaction ${index} is too large`)
      }
      const actions: unknown = JSON.parse(actionsJson)
      if (!Array.isArray(actions)) {
        throw new Error(`RHEA Swap NEAR transaction ${index} actions are invalid`)
      }
      return Object.freeze({
        signerId:
          transaction.signerId === undefined
            ? null
            : this.parseBoundedString(transaction.signerId, `RHEA Swap NEAR signer ${index}`, 64),
        receiverId: this.parseBoundedString(
          transaction.receiverId,
          `RHEA Swap NEAR receiver ${index}`,
          64
        ),
        actions: Object.freeze(actions)
      })
    })
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      executionId: build.executionId,
      chain: build.execution.chain,
      transactions: Object.freeze(transactions)
    })
  }

  async recordTransactionSubmission(
    quoteHandle: string,
    sourceHashValue: string
  ): Promise<RheaSwapSubmissionView> {
    const sourceHash = this.parseSourceHash(sourceHashValue)
    const handle = this.parseQuoteHandle(quoteHandle)
    return this.runSessionOperation(handle, () =>
      this.recordTransactionSubmissionOnce(handle, sourceHash)
    )
  }

  private async recordTransactionSubmissionOnce(
    quoteHandle: string,
    sourceHash: string
  ): Promise<RheaSwapSubmissionView> {
    const record = await this.requireSession(quoteHandle)
    const build = this.readBuild(record, true)
    if (build.execution.kind === 'evm-signature') {
      throw new Error('RHEA Swap signature execution requires order submission')
    }
    return this.saveSubmission(record, build, {
      sourceHash,
      orderId:
        build.order?.orderId ?? build.deposit?.orderId ?? build.deposit?.depositAddress ?? null,
      router: build.order?.router ?? build.router,
      statusChainId: build.order?.chainId ?? null
    })
  }

  async submitSignedOrder(
    quoteHandle: string,
    signatureValue: string,
    signingSchemeValue?: string,
    signal?: AbortSignal
  ): Promise<RheaSwapSubmissionView> {
    const signature = this.parseSignature(signatureValue)
    const signingScheme =
      signingSchemeValue === undefined
        ? undefined
        : this.parseBoundedString(signingSchemeValue, 'RHEA Swap signing scheme', 64)
    const handle = this.parseQuoteHandle(quoteHandle)
    return this.runSessionOperation(handle, () =>
      this.submitSignedOrderOnce(handle, signature, signingScheme, signal)
    )
  }

  private async submitSignedOrderOnce(
    quoteHandle: string,
    signature: string,
    signingScheme: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<RheaSwapSubmissionView> {
    const record = await this.requireSession(quoteHandle)
    if (record.submission) return this.toSubmissionView(record)
    const build = this.readBuild(record, true)
    if (build.execution.kind !== 'evm-signature' || !build.quoteId) {
      throw new Error('RHEA Swap build does not accept a signature order')
    }
    const submitted: SwapOrderSubmitDataRaw = await this.client.submitOrderRaw(
      {
        router: build.execution.request.router,
        quoteId: build.execution.request.quoteId,
        signature,
        ...(signingScheme === undefined ? {} : { signingScheme })
      },
      { signal }
    )
    const orderId = this.parseOrderId(submitted.orderId)
    const router = this.parseBoundedString(submitted.router, 'RHEA Swap order router', 128)
    const statusChainId =
      submitted.chainId === undefined
        ? String(build.execution.request.chainId)
        : String(submitted.chainId)
    return this.saveSubmission(record, build, {
      sourceHash: orderId,
      orderId,
      router,
      statusChainId
    })
  }

  async reportSubmission(
    quoteHandle: string,
    signal?: AbortSignal
  ): Promise<RheaSwapSubmissionView> {
    const handle = this.parseQuoteHandle(quoteHandle)
    let dedup = this.reportDedup.get(handle)
    if (!dedup) {
      dedup = new DedupPromise<RheaSwapSubmissionView>()
      this.reportDedup.set(handle, dedup)
    }
    try {
      return await dedup.run(() =>
        this.runSessionOperation(handle, () => this.reportSubmissionOnce(handle, signal))
      )
    } finally {
      if (!dedup.isPending) this.reportDedup.delete(handle)
    }
  }

  async canRecoverTransactionSubmission(quoteHandle: string): Promise<boolean> {
    const record = await this.sessions.get(this.parseQuoteHandle(quoteHandle))
    if (!record?.build) return false
    try {
      this.readBuild(record, true)
      return true
    } catch {
      return false
    }
  }

  async retryPendingReports(): Promise<boolean> {
    const handles = await this.sessions.listUnreported()
    const outcomes = await Promise.allSettled(handles.map(handle => this.reportSubmission(handle)))
    return outcomes.some(outcome => outcome.status === 'rejected')
  }

  async retireReportedSubmission(quoteHandle: string): Promise<void> {
    const handle = this.parseQuoteHandle(quoteHandle)
    await this.runSessionOperation(handle, async () => {
      const record = await this.requireSession(handle)
      if (!record.submission) return
      if (record.submission.reportStatus === 'reported') {
        await this.sessions.delete(handle)
        return
      }
      await this.sessions.put(
        Object.freeze({
          ...record,
          submission: Object.freeze({ ...record.submission, disposeAfterReport: true })
        })
      )
    })
  }

  private async reportSubmissionOnce(
    quoteHandle: string,
    signal?: AbortSignal
  ): Promise<RheaSwapSubmissionView> {
    const record = await this.requireSession(quoteHandle)
    if (!record.submission) throw new Error('RHEA Swap has not been submitted')
    if (record.submission.reportStatus === 'reported') return this.toSubmissionView(record)
    try {
      await this.client.reportRaw(record.submission.reportRequest, { signal })
      const updated = Object.freeze({
        ...record,
        submission: Object.freeze({ ...record.submission, reportStatus: 'reported' as const })
      })
      if (updated.submission.disposeAfterReport) await this.sessions.delete(quoteHandle)
      else await this.sessions.put(updated)
      return this.toSubmissionView(updated)
    } catch (error) {
      await this.sessions
        .put(
          Object.freeze({
            ...record,
            submission: Object.freeze({ ...record.submission, reportStatus: 'failed' as const })
          })
        )
        .catch(() => {})
      throw error
    }
  }

  async getOrderStatus(
    quoteHandle: string,
    signal?: AbortSignal
  ): Promise<RheaSwapOrderStatusView> {
    const record = await this.requireSession(quoteHandle)
    if (!record.submission?.orderId) throw new Error('RHEA Swap has no order status key')
    const status = await this.client.getOrderStatusRaw(
      {
        orderId: record.submission.orderId,
        router: record.submission.router,
        ...(record.submission.statusChainId === null
          ? {}
          : { chainId: record.submission.statusChainId })
      },
      { signal }
    )
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      orderId: record.submission.orderId,
      router: record.submission.router,
      status: normalizeOrderStatus(status),
      destinationHash: readRheaDestinationHash(status) ?? null
    })
  }

  discard(quoteHandle: string): Promise<void> {
    const handle = this.parseQuoteHandle(quoteHandle)
    return this.runSessionOperation(handle, () => this.sessions.delete(handle))
  }

  async clearSessions(): Promise<void> {
    this.clearingSessions = true
    this.sessionEpoch += 1
    try {
      await Promise.all(
        [...this.sessionQueues.values()].map(state => state.queue.run(async () => {}))
      )
      await this.sessions.clear()
    } finally {
      this.clearingSessions = false
    }
  }

  private async runSessionOperation<T>(handle: string, operation: () => Promise<T>): Promise<T> {
    if (this.clearingSessions) throw new Error('RHEA Swap sessions are being cleared')
    let state = this.sessionQueues.get(handle)
    if (!state) {
      state = { queue: new SerialTaskQueue(), active: 0 }
      this.sessionQueues.set(handle, state)
    }
    state.active += 1
    try {
      return await state.queue.run(operation)
    } finally {
      state.active -= 1
      if (state.active === 0) this.sessionQueues.delete(handle)
    }
  }

  private readTokens(
    direction: 'from' | 'cross-chain-to',
    chainId: number,
    signal?: AbortSignal
  ): Promise<SwapTokenListItem[]> {
    return direction === 'from'
      ? this.client.getFromTokens({ chainId }, { signal })
      : this.client.getCrossChainToTokens({ chainId }, { signal })
  }

  private parseTokenListChainIds(value: readonly number[]): readonly number[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > RHEA_SWAP_CHAIN_CATALOG.length
    ) {
      throw new Error('Invalid RHEA Swap chain list')
    }
    const supported = new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId))
    if (
      value.some(chainId => !Number.isSafeInteger(chainId) || !supported.has(chainId)) ||
      new Set(value).size !== value.length
    ) {
      throw new Error('Invalid RHEA Swap chain list')
    }
    return Object.freeze([...value])
  }

  private async requireSession(quoteHandle: string): Promise<RheaSwapQuoteSessionRecord> {
    const parsed = this.parseQuoteHandle(quoteHandle)
    const record = await this.sessions.get(parsed)
    if (!record || record.quoteHandle !== parsed || record.schemaVersion !== 1) {
      throw new Error('RHEA Swap quote session was not found')
    }
    return record
  }

  private readBuild(record: RheaSwapQuoteSessionRecord, allowExpired = false): SwapBuild {
    if (!record.build) throw new Error('RHEA Swap has not been prepared')
    const quote = normalizeQuote(record.request, record.quoteRaw, record.receivedAt)
    if (!allowExpired) this.assertQuoteFresh(record, quote)
    const build = normalizeBuild(record.build.raw, record.build.executionId, record.build.request)
    this.assertBuildMatchesQuote(build, quote)
    return build
  }

  private async saveSubmission(
    record: RheaSwapQuoteSessionRecord,
    build: SwapBuild,
    reference: {
      readonly sourceHash: string
      readonly orderId: string | null
      readonly router: string
      readonly statusChainId: string | null
    }
  ): Promise<RheaSwapSubmissionView> {
    if (record.submission) {
      const canRestoreMissingOrderId =
        record.submission.orderId === null && reference.orderId !== null
      if (
        record.submission.sourceHash !== reference.sourceHash ||
        (!canRestoreMissingOrderId && record.submission.orderId !== reference.orderId) ||
        record.submission.router !== reference.router ||
        record.submission.statusChainId !== reference.statusChainId
      ) {
        throw new Error('RHEA Swap submission is already bound to different evidence')
      }
      if (canRestoreMissingOrderId) {
        const updated: RheaSwapQuoteSessionRecord = Object.freeze({
          ...record,
          submission: Object.freeze({
            ...record.submission,
            orderId: reference.orderId,
            reportRequest: this.createReportRequest(build, reference)
          })
        })
        await this.sessions.put(updated)
        return this.toSubmissionView(updated)
      }
      return this.toSubmissionView(record)
    }
    const reportRequest = this.createReportRequest(build, reference)
    const updated: RheaSwapQuoteSessionRecord = Object.freeze({
      ...record,
      submission: Object.freeze({
        ...reference,
        reportRequest,
        reportStatus: 'pending' as const
      })
    })
    await this.sessions.put(updated)
    return this.toSubmissionView(updated)
  }

  private createReportRequest(
    build: SwapBuild,
    reference: { readonly sourceHash: string; readonly orderId: string | null }
  ): SwapReportRequestRaw {
    if (!build.request) throw new Error('RHEA Swap build is missing its normalized request')
    const context = build.reportContext
    const executionDepositAddress =
      'depositAddress' in build.execution ? build.execution.depositAddress : undefined
    const depositAddress =
      context?.depositAddress ?? build.deposit?.depositAddress ?? executionDepositAddress ?? ''
    if ('depositAddress' in build.execution && !depositAddress.trim()) {
      throw new Error('RHEA Swap deposit execution is missing its deposit address')
    }
    return Object.freeze({
      sender: context?.sender ?? build.request.sender,
      recipient: context?.recipient ?? build.request.recipient ?? build.request.sender,
      from_hash: context?.fromHash ?? reference.sourceHash,
      from_token: build.request.tokenIn,
      to_token: build.request.tokenOut,
      deposit_address: depositAddress,
      from_chain: build.request.fromChain,
      to_chain: build.request.toChain,
      is_cross_chain: context?.isCrossChain ?? build.isCrossChain,
      amount_in: build.request.amountIn,
      estimated_out: build.estimatedOut,
      router: build.router,
      tx_type: context?.txType ?? (build.isCrossChain ? 'cross-chain' : 'same-chain'),
      ...(build.request.confidentiality === undefined
        ? {}
        : { confidentiality: build.request.confidentiality }),
      ...(context?.multiAddr === undefined ? {} : { multi_addr: context.multiAddr }),
      ...((context?.swapId ?? reference.orderId)
        ? { swapId: context?.swapId ?? reference.orderId ?? undefined }
        : {})
    })
  }

  private toSubmissionView(record: RheaSwapQuoteSessionRecord): RheaSwapSubmissionView {
    if (!record.build || !record.submission) throw new Error('RHEA Swap has not been submitted')
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      executionId: record.build.executionId,
      router: record.submission.router,
      sourceHash: record.submission.sourceHash,
      orderId: record.submission.orderId,
      statusChainId: record.submission.statusChainId,
      reportStatus: record.submission.reportStatus
    })
  }

  private parseSourceHash(value: string): string {
    return this.parseBoundedString(value, 'RHEA Swap source hash', 256)
  }

  private parseOrderId(value: unknown): string {
    return this.parseBoundedString(value, 'RHEA Swap order ID', 256)
  }

  private parseSignature(value: string): string {
    const signature = this.parseBoundedString(value, 'RHEA Swap signature', 1_024)
    if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length % 2 !== 0) {
      throw new Error('RHEA Swap signature is invalid')
    }
    return signature
  }

  private parseBoundedString(value: unknown, label: string, maximum: number): string {
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

  private parseQuoteHandle(value: string): string {
    if (!/^rhea-quote:[0-9A-Za-z:_-]{1,128}$/.test(value)) {
      throw new Error('Invalid RHEA Swap quote handle')
    }
    return value
  }

  private assertQuoteFresh(record: RheaSwapQuoteSessionRecord, quote: Quote): void {
    if (
      !isRheaSwapQuoteFresh(
        { receivedAt: record.receivedAt, expiresAt: record.expiresAt ?? quote.expiresAt ?? null },
        this.now()
      )
    ) {
      throw new Error('RHEA Swap quote expired')
    }
  }

  private assertQuoteMatchesRequest(quote: Quote, request: QuoteRequest): void {
    if (BigInt(quote.estimatedOut) <= 0n || BigInt(quote.minAmountOut) <= 0n) {
      throw new Error('Amount is below the minimum for this Swap route')
    }
    if (
      quote.fromChain !== request.fromChain ||
      quote.toChain !== request.toChain ||
      quote.tokenIn.address !== request.tokenIn.address ||
      quote.tokenOut.address !== request.tokenOut.address ||
      quote.amountIn !== request.amountIn ||
      quote.buildContext.request.sender !== request.sender ||
      quote.buildContext.request.recipient !== request.recipient ||
      quote.buildContext.request.confidentiality !== request.confidentiality
    ) {
      throw new Error('RHEA Swap quote does not match its request')
    }
    if (
      request.confidentiality === 'basic' &&
      !quote.route.router.toLowerCase().includes('nearintents')
    ) {
      throw new Error('RHEA Swap confidential quote did not use the Near Intents route')
    }
  }

  private assertBuildMatchesQuote(build: SwapBuild, quote: Quote): void {
    if (
      build.fromChain !== quote.fromChain ||
      build.toChain !== quote.toChain ||
      build.tokenIn.address !== quote.tokenIn.address ||
      build.tokenOut.address !== quote.tokenOut.address ||
      build.amountIn !== quote.amountIn ||
      build.router !== quote.route.router ||
      build.request?.sender !== quote.buildContext.request.sender ||
      build.request?.recipient !== quote.buildContext.request.recipient ||
      build.request?.confidentiality !== quote.buildContext.request.confidentiality
    ) {
      throw new Error('RHEA Swap build does not match its quote')
    }
  }

  private toQuoteView(record: RheaSwapQuoteSessionRecord, quote: Quote): RheaSwapQuoteView {
    if (!record.request.recipient) throw new Error('RHEA Swap quote is missing its recipient')
    return Object.freeze({
      quoteHandle: record.quoteHandle,
      recipient: record.request.recipient,
      estimatedOut: quote.estimatedOut,
      minAmountOut: quote.minAmountOut,
      router: quote.route.router,
      receivedAt: quote.receivedAt,
      expiresAt: quote.expiresAt ?? null
    })
  }
}

export class MemoryRheaSwapQuoteSessionStore implements RheaSwapQuoteSessionStore {
  private readonly records = new Map<string, RheaSwapQuoteSessionRecord>()

  async get(quoteHandle: string): Promise<RheaSwapQuoteSessionRecord | null> {
    return this.records.get(quoteHandle) ?? null
  }

  async listUnreported(): Promise<readonly string[]> {
    return [...this.records.values()]
      .filter(record => record.submission && record.submission.reportStatus !== 'reported')
      .map(record => record.quoteHandle)
  }

  async clear(): Promise<void> {
    this.records.clear()
  }

  async put(record: RheaSwapQuoteSessionRecord): Promise<void> {
    this.records.delete(record.quoteHandle)
    this.records.set(record.quoteHandle, record)
    while (this.records.size > MAXIMUM_SESSION_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
  }

  async delete(quoteHandle: string): Promise<void> {
    this.records.delete(quoteHandle)
  }
}
