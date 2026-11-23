import {
  normalizeBuild,
  normalizeQuote,
  parseStoredSwapBuildRequest,
  readRheaSwapReportRecordId,
  type QuoteRequest,
  type SwapBuildDataRaw,
  type SwapReportRequestRaw,
  type SwapQuoteDataRaw
} from '@/core/services/rhea-swap/rhea-swap-protocol'
import { RheaSwapCatalogClient } from '@/core/services/rhea-swap/rhea-swap-catalog-client'
import {
  RheaSwapService,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  getPrivateWithdrawAsset,
  parseRheaSwapQuoteRequest,
  toRheaSwapProtocolRequest,
  type RheaSwapQuoteSessionRecord,
  type RheaSwapQuoteSessionStore,
  type RheaSwapToken,
  type RheaSwapCatalogResult
} from '@/core/services/rhea-swap'
import type { TransactionGraph } from '@/core/transactions/domain'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { RHEA_SWAP_TRANSACTION_MONITOR_ALARM } from './rhea-swap-transaction-monitor'
import type { FundingSource, QuoteBinding } from '@/types/wallet'
import { safeBig } from '@/lib/big'
import { PersistentRheaSwapCatalogCache } from '@/infrastructure/persistence/rhea-swap-catalog-cache'

export async function readRheaZcashTransferDeadline(
  binding: QuoteBinding | undefined,
  to: string | undefined,
  amount: string | undefined,
  fundingSource: FundingSource | undefined
): Promise<number | undefined> {
  if (binding?.provider !== 'rhea-cross-chain-dex') return undefined
  const service = createBackgroundRheaSwapService()
  if (!service || !binding.quoteHandle || !binding.executionId || !to || !amount) {
    throw new Error('RHEA Swap quote is unavailable. Get a new quote and review it again.')
  }
  const amountZats = safeBig(amount).times(1e8)
  if (!amountZats.gt(0) || !amountZats.eq(amountZats.round(0, 0))) {
    throw new Error('Invalid RHEA Swap transfer amount')
  }
  return service.readZcashTransferDeadline(binding.quoteHandle, {
    executionId: binding.executionId,
    to,
    amountZats: amountZats.toFixed(0),
    fundingSource
  })
}

const RECORD_PREFIX = 'rhea_swap_quote:'
const MAXIMUM_RECORDS = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readStoredString(value: unknown, label: string, maximum = 512): string {
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

function parseStoredReportRequest(value: unknown): SwapReportRequestRaw {
  if (!isRecord(value)) throw new Error('Stored RHEA Swap report request is invalid')
  const required = [
    'sender',
    'recipient',
    'from_hash',
    'from_token',
    'to_token',
    'deposit_address',
    'from_chain',
    'to_chain',
    'is_cross_chain',
    'amount_in',
    'estimated_out',
    'router',
    'tx_type'
  ]
  const optional = ['confidentiality', 'multi_addr', 'swapId']
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key)) ||
    typeof value.is_cross_chain !== 'boolean'
  ) {
    throw new Error('Stored RHEA Swap report request fields are invalid')
  }
  const read = (key: string, maximum = 512) =>
    readStoredString(value[key], `Stored RHEA Swap report ${key}`, maximum)
  if (value.confidentiality !== undefined && value.confidentiality !== 'basic') {
    throw new Error('Stored RHEA Swap report confidentiality is invalid')
  }
  return Object.freeze({
    sender: read('sender'),
    recipient: read('recipient'),
    from_hash: read('from_hash', 256),
    from_token: read('from_token'),
    to_token: read('to_token'),
    deposit_address:
      value.deposit_address === ''
        ? ''
        : readStoredString(value.deposit_address, 'Stored RHEA Swap report deposit address'),
    from_chain: read('from_chain', 32),
    to_chain: read('to_chain', 32),
    is_cross_chain: value.is_cross_chain,
    amount_in: read('amount_in', 78),
    estimated_out: read('estimated_out', 78),
    router: read('router', 128),
    tx_type: read('tx_type', 64),
    ...(value.confidentiality === undefined ? {} : { confidentiality: value.confidentiality }),
    ...(value.multi_addr === undefined ? {} : { multi_addr: read('multi_addr') }),
    ...(value.swapId === undefined ? {} : { swapId: read('swapId', 256) })
  })
}

function readStoredQuoteTiming(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Stored RHEA Swap quote timing is invalid')
  }
  return value
}

function parseStoredRequest(value: unknown): QuoteRequest {
  if (!isRecord(value)) throw new Error('Stored RHEA Swap quote request is invalid')
  const parsed = parseRheaSwapQuoteRequest({
    fromChain: value.fromChain,
    toChain: value.toChain,
    tokenIn: value.tokenIn,
    tokenOut: value.tokenOut,
    amountIn: value.amountIn,
    slippageBps: value.slippageBps,
    sender: value.sender,
    recipient: value.recipient,
    confidentiality: value.confidentiality
  })
  // Existing quotes retain their timing budgets when defaults change.
  const normalized = Object.freeze({
    ...toRheaSwapProtocolRequest(parsed),
    quoteWaitingTimeMs: readStoredQuoteTiming(value.quoteWaitingTimeMs),
    sameChainTimeoutMs: readStoredQuoteTiming(value.sameChainTimeoutMs),
    crossChainTimeoutMs: readStoredQuoteTiming(value.crossChainTimeoutMs)
  })
  if (Object.keys(value).length !== Object.keys(normalized).length) {
    throw new Error('Stored RHEA Swap quote request fields are invalid')
  }
  return normalized
}

function parseStoredRecord(value: unknown): RheaSwapQuoteSessionRecord {
  if (!isRecord(value)) throw new Error('Stored RHEA Swap quote session is invalid')
  const allowed = new Set([
    'schemaVersion',
    'quoteHandle',
    'request',
    'quoteRaw',
    'receivedAt',
    'expiresAt',
    'privateSwapScope',
    'build',
    'submission'
  ])
  if (
    value.schemaVersion !== 1 ||
    typeof value.quoteHandle !== 'string' ||
    !/^rhea-quote:[0-9A-Za-z:_-]{1,128}$/.test(value.quoteHandle) ||
    Object.keys(value).some(key => !allowed.has(key)) ||
    !isRecord(value.quoteRaw) ||
    !Number.isSafeInteger(value.receivedAt) ||
    (value.receivedAt as number) < 0 ||
    (value.expiresAt !== null &&
      (!Number.isSafeInteger(value.expiresAt) ||
        (value.expiresAt as number) <= (value.receivedAt as number)))
  ) {
    throw new Error('Stored RHEA Swap quote session metadata is invalid')
  }
  const request = parseStoredRequest(value.request)
  const privateSwapScope = value.privateSwapScope
  if (
    privateSwapScope !== undefined &&
    (!isRecord(privateSwapScope) ||
      Object.keys(privateSwapScope).some(
        key => !['walletId', 'accountId', 'purpose', 'zcashFundingSource'].includes(key)
      ) ||
      typeof privateSwapScope.walletId !== 'string' ||
      typeof privateSwapScope.accountId !== 'string' ||
      (privateSwapScope.zcashFundingSource !== undefined &&
        ((privateSwapScope.purpose !== 'wallet-swap' &&
          privateSwapScope.purpose !== 'private-swap') ||
          request.fromChain !== 'zcash' ||
          (privateSwapScope.zcashFundingSource !== 'transparent' &&
            privateSwapScope.zcashFundingSource !== 'shielded'))) ||
      (privateSwapScope.purpose === 'private-swap' &&
        request.fromChain === 'zcash' &&
        privateSwapScope.zcashFundingSource !== 'shielded') ||
      (privateSwapScope.purpose === 'wallet-swap' &&
        request.fromChain === 'zcash' &&
        request.sender.startsWith('u1') &&
        privateSwapScope.zcashFundingSource !== 'shielded') ||
      (privateSwapScope.purpose !== undefined &&
        privateSwapScope.purpose !== 'wallet-swap' &&
        privateSwapScope.purpose !== 'public-cross-chain-send' &&
        privateSwapScope.purpose !== 'confidential-funding' &&
        privateSwapScope.purpose !== 'private-swap' &&
        privateSwapScope.purpose !== 'private-transfer' &&
        privateSwapScope.purpose !== 'private-cross-chain-send' &&
        privateSwapScope.purpose !== 'private-cross-chain-withdraw' &&
        privateSwapScope.purpose !== 'private-dapp-transfer' &&
        privateSwapScope.purpose !== 'public-private-send'))
  ) {
    throw new Error('Stored Private Swap scope is invalid')
  }
  const quoteRaw = value.quoteRaw as SwapQuoteDataRaw
  normalizeQuote(request, quoteRaw, value.receivedAt as number)
  let build: RheaSwapQuoteSessionRecord['build']
  if (value.build !== undefined) {
    if (!isRecord(value.build)) throw new Error('Stored RHEA Swap build is invalid')
    const keys = Object.keys(value.build)
    if (
      keys.length !== 3 ||
      !keys.includes('executionId') ||
      !keys.includes('request') ||
      !keys.includes('raw') ||
      typeof value.build.executionId !== 'string' ||
      value.build.executionId.length === 0 ||
      value.build.executionId.length > 160 ||
      !isRecord(value.build.request) ||
      !isRecord(value.build.raw)
    ) {
      throw new Error('Stored RHEA Swap build metadata is invalid')
    }
    const buildRequest = parseStoredSwapBuildRequest(value.build.request)
    const buildRaw = value.build.raw as SwapBuildDataRaw
    normalizeBuild(buildRaw, value.build.executionId, buildRequest)
    build = Object.freeze({
      executionId: value.build.executionId,
      request: buildRequest,
      raw: buildRaw
    })
  }
  let submission: RheaSwapQuoteSessionRecord['submission']
  if (value.submission !== undefined) {
    if (!build || !isRecord(value.submission)) {
      throw new Error('Stored RHEA Swap submission is invalid')
    }
    const keys = Object.keys(value.submission)
    const expected = [
      'sourceHash',
      'orderId',
      'router',
      'statusChainId',
      'reportRequest',
      'reportStatus'
    ]
    const recordId = readRheaSwapReportRecordId(value.submission.recordId)
    if (
      keys.some(
        key => !expected.includes(key) && key !== 'disposeAfterReport' && key !== 'recordId'
      ) ||
      expected.some(key => !keys.includes(key)) ||
      (value.submission.recordId !== undefined && recordId !== value.submission.recordId) ||
      (value.submission.disposeAfterReport !== undefined &&
        typeof value.submission.disposeAfterReport !== 'boolean') ||
      (value.submission.orderId !== null && typeof value.submission.orderId !== 'string') ||
      (value.submission.statusChainId !== null &&
        typeof value.submission.statusChainId !== 'string') ||
      (value.submission.reportStatus !== 'pending' &&
        value.submission.reportStatus !== 'reported' &&
        value.submission.reportStatus !== 'failed')
    ) {
      throw new Error('Stored RHEA Swap submission metadata is invalid')
    }
    submission = Object.freeze({
      sourceHash: readStoredString(
        value.submission.sourceHash,
        'Stored RHEA Swap source hash',
        256
      ),
      orderId:
        value.submission.orderId === null
          ? null
          : readStoredString(value.submission.orderId, 'Stored RHEA Swap order ID', 256),
      router: readStoredString(value.submission.router, 'Stored RHEA Swap router', 128),
      statusChainId:
        value.submission.statusChainId === null
          ? null
          : readStoredString(
              value.submission.statusChainId,
              'Stored RHEA Swap status chain ID',
              32
            ),
      reportRequest: parseStoredReportRequest(value.submission.reportRequest),
      reportStatus: value.submission.reportStatus,
      ...(recordId === undefined ? {} : { recordId }),
      ...(value.submission.disposeAfterReport === undefined
        ? {}
        : { disposeAfterReport: value.submission.disposeAfterReport })
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    quoteHandle: value.quoteHandle,
    request,
    ...(privateSwapScope === undefined
      ? {}
      : {
          privateSwapScope: Object.freeze({
            walletId: readStoredString(privateSwapScope.walletId, 'Private Swap wallet ID', 160),
            accountId: readStoredString(privateSwapScope.accountId, 'Private Swap Account ID', 160),
            ...(privateSwapScope.zcashFundingSource === undefined
              ? {}
              : {
                  zcashFundingSource: privateSwapScope.zcashFundingSource as
                    | 'transparent'
                    | 'shielded'
                }),
            ...(privateSwapScope.purpose === undefined
              ? {}
              : {
                  purpose: privateSwapScope.purpose as
                    | 'wallet-swap'
                    | 'public-cross-chain-send'
                    | 'confidential-funding'
                    | 'private-swap'
                    | 'private-transfer'
                    | 'private-cross-chain-send'
                    | 'private-cross-chain-withdraw'
                    | 'private-dapp-transfer'
                    | 'public-private-send'
                })
          })
        }),
    quoteRaw,
    receivedAt: value.receivedAt as number,
    expiresAt: value.expiresAt as number | null,
    ...(build === undefined ? {} : { build }),
    ...(submission === undefined ? {} : { submission })
  })
}

export class ChromeRheaSwapQuoteStore implements RheaSwapQuoteSessionStore {
  async get(quoteHandle: string): Promise<RheaSwapQuoteSessionRecord | null> {
    const key = this.key(quoteHandle)
    const stored = await chrome.storage.local.get(key)
    return stored[key] === undefined ? null : parseStoredRecord(stored[key])
  }

  async listUnreported(): Promise<readonly string[]> {
    const stored = await chrome.storage.local.get(null)
    const handles: string[] = []
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(RECORD_PREFIX)) continue
      try {
        const record = parseStoredRecord(value)
        if (record.submission && record.submission.reportStatus !== 'reported') {
          handles.push(record.quoteHandle)
        }
      } catch {
        console.warn('[RHEA Swap Monitor] Invalid persisted quote session', { key })
      }
    }
    return handles
  }

  async clear(): Promise<void> {
    const stored = await chrome.storage.local.get(null)
    const keys = Object.keys(stored).filter(key => key.startsWith(RECORD_PREFIX))
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async put(record: RheaSwapQuoteSessionRecord): Promise<void> {
    const parsed = parseStoredRecord(record)
    const stored = await chrome.storage.local.get(null)
    const existing: Array<{ key: string; record: RheaSwapQuoteSessionRecord }> = []
    const corruptKeys: string[] = []
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(RECORD_PREFIX) || key === this.key(parsed.quoteHandle)) continue
      try {
        existing.push({ key, record: parseStoredRecord(value) })
      } catch {
        corruptKeys.push(key)
      }
    }
    if (corruptKeys.length > 0) await chrome.storage.local.remove(corruptKeys)
    existing.sort((left, right) => left.record.receivedAt - right.record.receivedAt)
    const removeCount = Math.max(0, existing.length - MAXIMUM_RECORDS + 1)
    if (removeCount > 0) {
      const removable = existing.filter(item => item.record.submission === undefined)
      if (removable.length < removeCount) {
        throw new Error('RHEA Swap recovery storage is full')
      }
      await chrome.storage.local.remove(removable.slice(0, removeCount).map(item => item.key))
    }
    await chrome.storage.local.set({ [this.key(parsed.quoteHandle)]: parsed })
  }

  async delete(quoteHandle: string): Promise<void> {
    await chrome.storage.local.remove(this.key(quoteHandle))
  }

  private key(quoteHandle: string): string {
    if (!/^rhea-quote:[0-9A-Za-z:_-]{1,128}$/.test(quoteHandle)) {
      throw new Error('Invalid RHEA Swap quote handle')
    }
    return `${RECORD_PREFIX}${encodeURIComponent(quoteHandle)}`
  }
}

export async function recoverRheaWithdrawActivity(
  graph: TransactionGraph,
  quotes: Pick<RheaSwapQuoteSessionStore, 'get'> = new ChromeRheaSwapQuoteStore(),
  repository: Pick<
    IndexedDbTransactionRepository,
    'backfillRheaWithdrawActivity'
  > = new IndexedDbTransactionRepository()
): Promise<TransactionGraph> {
  const { scope, id, intent, kind } = graph.root
  const binding = intent?.protocol
  if (
    kind !== 'transfer' ||
    binding?.provider !== 'rhea-cross-chain-dex' ||
    binding.balanceTransfer !== undefined ||
    binding.userAction !== 'transfer' ||
    !binding.isCrossChain ||
    !binding.origin.chainId.startsWith('eip155:') ||
    !binding.destination.chainId.startsWith('eip155:') ||
    binding.origin.chainId === binding.destination.chainId
  ) {
    return graph
  }
  const sourceHash = graph.segments.find(
    segment =>
      segment.role === 'origin' &&
      segment.target.kind === 'onchain' &&
      segment.target.chainId === binding.origin.chainId
  )?.evidence?.transactionHash
  if (!sourceHash || !/^0x[0-9a-f]{64}$/i.test(sourceHash)) return graph
  const quote = await quotes.get(binding.quoteHandle)
  const quoteScope = quote?.privateSwapScope
  if (
    !quote ||
    quoteScope?.purpose !== 'private-cross-chain-withdraw' ||
    quoteScope.walletId !== scope.keyDomainId ||
    quoteScope.accountId !== scope.accountId ||
    quote.quoteHandle !== binding.quoteHandle ||
    quote.build?.executionId !== binding.executionId ||
    (quote.submission && quote.submission.sourceHash.toLowerCase() !== sourceHash.toLowerCase())
  ) {
    return graph
  }
  const { request } = quote
  if (
    request.confidentiality !== 'basic' ||
    request.fromChain !== binding.origin.protocolChainId ||
    request.toChain !== binding.destination.protocolChainId ||
    request.sender.toLowerCase() !== binding.sender.toLowerCase() ||
    request.sender.toLowerCase() !== intent?.sender?.address.toLowerCase() ||
    request.recipient?.toLowerCase() !== binding.destination.recipient.toLowerCase() ||
    request.amountIn !== binding.originAmountRaw ||
    getPrivateWithdrawAsset(request.fromChain, request.tokenIn)?.id !== binding.origin.assetId ||
    getPrivateWithdrawAsset(request.toChain, request.tokenOut)?.id !== binding.destination.assetId
  ) {
    return graph
  }
  return (
    (await repository.backfillRheaWithdrawActivity(
      scope,
      id,
      binding.quoteHandle,
      binding.executionId,
      sourceHash
    )) ?? graph
  )
}

let service: RheaSwapService | null | undefined

export function createBackgroundRheaSwapService(): RheaSwapService | null {
  if (service !== undefined) return service
  const accessToken = __RHEA_SWAP_ACCESS_TOKEN__.trim()
  if (!accessToken) {
    service = null
    return service
  }
  const client = new RheaSwapCatalogClient({
    baseUrl: 'https://api.rhea.finance',
    apiKey: accessToken,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    tokenListCacheTtlMs: RHEA_SWAP_TOKEN_CATALOG_TTL_MS
  })
  service = new RheaSwapService(client, new ChromeRheaSwapQuoteStore())
  return service
}

let publicCatalog: PersistentRheaSwapCatalogCache | undefined
let portfolioTokens: readonly RheaSwapToken[] = Object.freeze([])

function getPublicCatalog(): PersistentRheaSwapCatalogCache {
  return (publicCatalog ??= new PersistentRheaSwapCatalogCache(request => {
    const service = createBackgroundRheaSwapService()
    if (!service) throw new Error('RHEA Swap is unavailable')
    return service.listTokens(request)
  }))
}

function rememberPortfolioTokens(result: RheaSwapCatalogResult): void {
  const chains = new Set(result.tokens.map(token => token.tokenListChainId))
  portfolioTokens = Object.freeze([
    ...portfolioTokens.filter(token => !chains.has(token.tokenListChainId)),
    ...result.tokens.map(token =>
      token.isNative
        ? token
        : Object.freeze({
            ...token,
            contractAddress: token.contractAddress ?? token.rheaAddress
          })
    )
  ])
}

export function getCachedBackgroundRheaSwapTokens(): readonly RheaSwapToken[] {
  return portfolioTokens
}

export async function hydrateBackgroundRheaSwapCatalog(
  input: Parameters<RheaSwapService['listTokens']>[0]
): Promise<void> {
  if (input.direction !== 'from' || input.tokenListChainIds.length === 0) return
  rememberPortfolioTokens(await getPublicCatalog().readLastGood(input))
}

export async function readBackgroundRheaSwapCatalog(
  input: Parameters<RheaSwapService['listTokens']>[0]
) {
  const cache = getPublicCatalog()
  const result = await cache.read(input)
  if (input.direction === 'from') rememberPortfolioTokens(await cache.readLastGood(input))
  return result
}

export async function prewarmBackgroundRheaSwapCatalog(chainIds: readonly number[]): Promise<void> {
  const unique = [...new Set(chainIds)]
  for (let index = 0; index < unique.length; index += 2) {
    const tokenListChainIds = unique.slice(index, index + 2)
    await Promise.all([
      readBackgroundRheaSwapCatalog({ direction: 'from', tokenListChainIds }),
      readBackgroundRheaSwapCatalog({ direction: 'cross-chain-to', tokenListChainIds })
    ])
  }
}

export async function recordRheaSwapGraphBroadcast(graph: TransactionGraph): Promise<void> {
  const binding = graph.root.intent?.protocol
  if (!binding || binding.provider !== 'rhea-cross-chain-dex') return
  const origin = graph.segments.find(segment => segment.role === 'origin')
  const sourceHash = origin?.evidence?.transactionHash
  if (!origin || origin.status !== 'broadcast' || !sourceHash) {
    throw new Error('RHEA Swap source transaction evidence is incomplete')
  }
  const rheaSwapService = createBackgroundRheaSwapService()
  if (!rheaSwapService) throw new Error('RHEA Swap is unavailable')
  try {
    await rheaSwapService.recordTransactionSubmission(binding.quoteHandle, sourceHash)
    console.info('[RHEA Swap Monitor] Source submission recorded', {
      quoteHandle: binding.quoteHandle,
      transactionId: graph.root.id
    })
  } finally {
    await chrome.alarms.create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
  }
}
