import {
  normalizeBuild,
  normalizeQuote,
  type QuoteRequest,
  type SwapBuildDataRaw,
  type SwapBuildRequestRaw,
  type SwapReportRequestRaw,
  type SwapQuoteDataRaw
} from '@rhea-finance/cross-chain-aggregation-dex'
import { RheaSwapCatalogClient } from '@/core/services/rhea-swap/rhea-swap-catalog-client'
import {
  RheaSwapService,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  parseRheaSwapQuoteRequest,
  toSdkQuoteRequest,
  type RheaSwapQuoteSessionRecord,
  type RheaSwapQuoteSessionStore
} from '@/core/services/rhea-swap'
import type { TransactionGraph } from '@/core/transactions/domain'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { RHEA_SWAP_TRANSACTION_MONITOR_ALARM } from './rhea-swap-transaction-monitor'
import type { QuoteBinding } from '@/types/wallet'
import { safeBig } from '@/lib/big'

export async function readRheaZcashTransferDeadline(
  binding: QuoteBinding | undefined,
  to: string | undefined,
  amount: string | undefined
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
    amountZats: amountZats.toFixed(0)
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
    ...toSdkQuoteRequest(parsed),
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
    const buildRequest = value.build.request as SwapBuildRequestRaw
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
    if (
      (keys.length !== expected.length &&
        !(keys.length === expected.length + 1 && keys.includes('disposeAfterReport'))) ||
      expected.some(key => !keys.includes(key)) ||
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
      ...(value.submission.disposeAfterReport === undefined
        ? {}
        : { disposeAfterReport: value.submission.disposeAfterReport })
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    quoteHandle: value.quoteHandle,
    request,
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
    reportMode: 'manual',
    tokenListCacheTtlMs: RHEA_SWAP_TOKEN_CATALOG_TTL_MS
  })
  service = new RheaSwapService(client, new ChromeRheaSwapQuoteStore())
  return service
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
