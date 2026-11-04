/**
 * Hardware wallet flows run in a full browser tab instead of the popup:
 * camera access prompts close popups, and long signing flows must survive
 * focus changes. Sign requests are handed off via chrome.storage.session
 * so the tab can rebuild state after an unlock redirect.
 */

import type { QuoteBinding } from '@/types'
import type { FeeTier } from '@/config/fee'
import type { TransactionId } from '@/core/transactions/domain'
import { launchHardwareSignSurface, type HardwareSignPresentation } from './hardware-sign-launcher'
import { waitForHardwareSignResult, type HardwareSignResult } from './hardware-sign-result'
import { hardwareConnectRoute, type HardwareConnectVendor } from './hardware-connect-options'

export type HardwareSignKind = 'send' | 'shield' | 'unshield' | 'swap'

export interface SwapMonitorParams {
  depositAddress: string
  tokenInSymbol: string
  tokenOutSymbol: string
  amountOut: string
  actionName: string
  originChain?: string
  destinationChain?: string
}

export interface HardwareSignRequest {
  kind: HardwareSignKind
  walletId: string
  accountId: string
  /** Recipient address (send: target, swap: deposit address) */
  to?: string
  /** Display amount in ZEC */
  amount: string
  /** Recalculate a selected send maximum before building the PCZT. */
  maxTransfer?: boolean
  /** Private memo attached to the shielded recipient output. */
  memo?: string
  /** Address shown in the transaction record instead of `to` (swap recipient) */
  displayTo?: string
  /** Cross-chain quote binding recorded with the transaction (swap) */
  quoteBinding?: QuoteBinding
  /** Cross-chain monitor params (swap) */
  monitorParams?: SwapMonitorParams
  /** When set, the sign tab reports the outcome via a HW_SIGN_RESULT message */
  dappRequestId?: string
  /** Return a correlated transaction result to the side panel that opened this request. */
  reportToOrigin?: boolean
  /** dApp origin, shown in the sign tab for context */
  origin?: string
  /** ZIP-317 marginal fee (zatoshis) for the selected fee tier; defaults to Standard. */
  marginalFeeZats?: number
  feeQuoteId?: string
  feeTier?: FeeTier
  fundingSource?: 'shielded' | 'transparent'
  createdAt: number
}

export interface PreparedHardwareSignRequest {
  readonly request: HardwareSignRequest
  readonly fullPcztBase64: string
  readonly vendor?: 'keystone' | 'ledger'
  readonly redactedPcztBase64?: string
}

export const HARDWARE_SIGN_REQUEST_TTL_MS = 10 * 60 * 1000

const SIGN_REQUEST_PREFIX = 'hw_sign_'
const PREPARED_SIGN_REQUEST_PREFIX = 'hw_sign_prepared_'
const MAX_PCZT_BASE64_LENGTH = 3 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseAmount(value: unknown, label: string, maximumDecimals: number): string {
  const amount = parseString(value, label, 256)
  const pattern = new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${maximumDecimals}})?$`)
  if (!pattern.test(amount) || /^0(?:\.0+)?$/.test(amount)) throw new Error(`Invalid ${label}`)
  return amount
}

function parseOptionalString(
  value: unknown,
  label: string,
  maximumLength: number
): string | undefined {
  return value === undefined ? undefined : parseString(value, label, maximumLength)
}

function parseOptionalText(
  value: unknown,
  label: string,
  maximumLength: number
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximumLength) throw new Error(`Invalid ${label}`)
  return value
}

function parseQuoteBinding(value: unknown): QuoteBinding | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      [
        'provider',
        'quoteHandle',
        'executionId',
        'router',
        'orderId',
        'statusChainId',
        'isCrossChain',
        'destinationChain',
        'depositAddress',
        'originAsset',
        'destinationAsset',
        'expectedAmountOut',
        'minAmountOut',
        'recipient',
        'refundTo',
        'deadline'
      ]
    )
  ) {
    throw new Error('Invalid hardware quote binding')
  }
  const deadline = value.deadline
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || (deadline as number) <= 0)) {
    throw new Error('Invalid hardware quote deadline')
  }
  if (
    value.provider !== undefined &&
    value.provider !== 'near-intents' &&
    value.provider !== 'rhea-cross-chain-dex'
  ) {
    throw new Error('Invalid hardware quote provider')
  }
  if (value.isCrossChain !== undefined && typeof value.isCrossChain !== 'boolean') {
    throw new Error('Invalid hardware quote route kind')
  }
  return {
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.quoteHandle === undefined
      ? {}
      : { quoteHandle: parseString(value.quoteHandle, 'hardware quote handle', 160) }),
    ...(value.executionId === undefined
      ? {}
      : { executionId: parseString(value.executionId, 'hardware execution ID', 160) }),
    ...(value.router === undefined
      ? {}
      : { router: parseString(value.router, 'hardware quote router', 128) }),
    ...(value.orderId === undefined
      ? {}
      : { orderId: parseString(value.orderId, 'hardware order ID', 256) }),
    ...(value.statusChainId === undefined
      ? {}
      : { statusChainId: parseString(value.statusChainId, 'hardware status chain ID', 32) }),
    ...(value.isCrossChain === undefined ? {} : { isCrossChain: value.isCrossChain }),
    ...(value.destinationChain === undefined
      ? {}
      : {
          destinationChain: parseString(value.destinationChain, 'hardware destination chain', 64)
        }),
    ...(value.depositAddress === undefined
      ? {}
      : { depositAddress: parseString(value.depositAddress, 'hardware deposit address', 1_024) }),
    ...(value.originAsset === undefined
      ? {}
      : { originAsset: parseString(value.originAsset, 'hardware origin asset', 512) }),
    ...(value.destinationAsset === undefined
      ? {}
      : {
          destinationAsset: parseString(value.destinationAsset, 'hardware destination asset', 512)
        }),
    ...(value.expectedAmountOut === undefined
      ? {}
      : {
          expectedAmountOut: parseAmount(value.expectedAmountOut, 'hardware expected amount', 78)
        }),
    ...(value.minAmountOut === undefined
      ? {}
      : { minAmountOut: parseAmount(value.minAmountOut, 'hardware minimum amount', 36) }),
    ...(value.recipient === undefined
      ? {}
      : { recipient: parseString(value.recipient, 'hardware recipient', 1_024) }),
    ...(value.refundTo === undefined
      ? {}
      : { refundTo: parseString(value.refundTo, 'hardware refund address', 1_024) }),
    ...(deadline === undefined ? {} : { deadline: deadline as number })
  }
}

function parseMonitorParams(value: unknown): SwapMonitorParams | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['depositAddress', 'tokenInSymbol', 'tokenOutSymbol', 'amountOut', 'actionName'],
      ['originChain', 'destinationChain']
    )
  ) {
    throw new Error('Invalid hardware monitor parameters')
  }
  return {
    depositAddress: parseString(value.depositAddress, 'hardware monitor deposit address', 1_024),
    tokenInSymbol: parseString(value.tokenInSymbol, 'hardware input symbol', 64),
    tokenOutSymbol: parseString(value.tokenOutSymbol, 'hardware output symbol', 64),
    amountOut: parseAmount(value.amountOut, 'hardware output amount', 36),
    actionName: parseString(value.actionName, 'hardware action name', 128),
    ...(value.originChain === undefined
      ? {}
      : { originChain: parseString(value.originChain, 'hardware origin chain', 128) }),
    ...(value.destinationChain === undefined
      ? {}
      : {
          destinationChain: parseString(value.destinationChain, 'hardware destination chain', 128)
        })
  }
}

function parseDappOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const origin = parseString(value, 'hardware dApp origin', 2_048)
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('Invalid hardware dApp origin')
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
    throw new Error('Invalid hardware dApp origin')
  }
  return origin
}

export function parseHardwareSignRequest(value: unknown): HardwareSignRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['kind', 'walletId', 'accountId', 'amount', 'createdAt'],
      [
        'to',
        'memo',
        'displayTo',
        'quoteBinding',
        'monitorParams',
        'dappRequestId',
        'reportToOrigin',
        'origin',
        'marginalFeeZats',
        'feeQuoteId',
        'feeTier',
        'fundingSource',
        'maxTransfer'
      ]
    ) ||
    (value.kind !== 'send' &&
      value.kind !== 'shield' &&
      value.kind !== 'unshield' &&
      value.kind !== 'swap') ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) <= 0
  ) {
    throw new Error('Invalid hardware signing request')
  }
  const kind = value.kind
  const to = parseOptionalString(value.to, 'hardware recipient', 1_024)
  const memo = parseOptionalText(value.memo, 'hardware memo', 4_096)
  const displayTo = parseOptionalString(value.displayTo, 'hardware display recipient', 1_024)
  const quoteBinding = parseQuoteBinding(value.quoteBinding)
  const monitorParams = parseMonitorParams(value.monitorParams)
  const dappRequestId = parseOptionalString(value.dappRequestId, 'hardware dApp request ID', 128)
  const reportToOrigin = value.reportToOrigin
  const origin = parseDappOrigin(value.origin)
  const marginalFeeZats = value.marginalFeeZats
  const feeQuoteId = parseOptionalString(value.feeQuoteId, 'hardware fee quote ID', 256)
  const feeTier = value.feeTier
  const fundingSource = value.fundingSource
  const maxTransfer = value.maxTransfer
  if (maxTransfer !== undefined && (kind !== 'send' || typeof maxTransfer !== 'boolean')) {
    throw new Error('Invalid hardware maximum transfer')
  }
  if (
    fundingSource !== undefined &&
    ((kind !== 'send' && kind !== 'swap') ||
      (fundingSource !== 'shielded' && fundingSource !== 'transparent'))
  ) {
    throw new Error('Invalid hardware funding source')
  }
  if (
    marginalFeeZats !== undefined &&
    (!Number.isSafeInteger(marginalFeeZats) || (marginalFeeZats as number) < 0)
  ) {
    throw new Error('Invalid hardware marginal fee')
  }
  if (feeTier !== undefined && feeTier !== 'standard' && feeTier !== 'fast') {
    throw new Error('Invalid hardware network fee tier')
  }
  if (
    (dappRequestId === undefined) !== (origin === undefined) ||
    (dappRequestId && kind !== 'send') ||
    (reportToOrigin !== undefined && typeof reportToOrigin !== 'boolean') ||
    (reportToOrigin === true && dappRequestId !== undefined)
  ) {
    throw new Error('Invalid hardware dApp request binding')
  }
  if (
    (kind === 'shield' &&
      (to !== undefined ||
        memo !== undefined ||
        displayTo !== undefined ||
        quoteBinding !== undefined ||
        monitorParams !== undefined)) ||
    ((kind === 'send' || kind === 'unshield') &&
      (to === undefined ||
        displayTo !== undefined ||
        quoteBinding !== undefined ||
        monitorParams !== undefined)) ||
    (kind === 'swap' && (to === undefined || dappRequestId !== undefined))
  ) {
    throw new Error('Invalid hardware signing request fields')
  }
  return {
    kind,
    walletId: parseString(value.walletId, 'hardware wallet ID', 512),
    accountId: parseString(value.accountId, 'hardware account ID', 512),
    amount: parseAmount(value.amount, 'hardware amount', 18),
    createdAt: value.createdAt as number,
    ...(to === undefined ? {} : { to }),
    ...(memo === undefined ? {} : { memo }),
    ...(displayTo === undefined ? {} : { displayTo }),
    ...(quoteBinding === undefined ? {} : { quoteBinding }),
    ...(monitorParams === undefined ? {} : { monitorParams }),
    ...(dappRequestId === undefined ? {} : { dappRequestId }),
    ...(reportToOrigin === undefined ? {} : { reportToOrigin }),
    ...(origin === undefined ? {} : { origin }),
    ...(marginalFeeZats === undefined ? {} : { marginalFeeZats: marginalFeeZats as number }),
    ...(feeQuoteId === undefined ? {} : { feeQuoteId }),
    ...(feeTier === undefined ? {} : { feeTier: feeTier as FeeTier }),
    ...(fundingSource === undefined
      ? {}
      : { fundingSource: fundingSource as 'shielded' | 'transparent' }),
    ...(maxTransfer === undefined ? {} : { maxTransfer: maxTransfer as boolean })
  }
}

export function parsePreparedHardwareSignRequest(value: unknown): PreparedHardwareSignRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['request', 'fullPcztBase64'], ['vendor', 'redactedPcztBase64']) ||
    (value.vendor !== undefined && value.vendor !== 'keystone' && value.vendor !== 'ledger')
  ) {
    throw new Error('Invalid prepared hardware signing request')
  }
  const fullPcztBase64 = parseString(
    value.fullPcztBase64,
    'prepared hardware PCZT',
    MAX_PCZT_BASE64_LENGTH
  )
  if (
    fullPcztBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fullPcztBase64)
  ) {
    throw new Error('Invalid prepared hardware PCZT')
  }
  const redactedPcztBase64 =
    value.redactedPcztBase64 === undefined
      ? undefined
      : parseString(value.redactedPcztBase64, 'redacted hardware PCZT', MAX_PCZT_BASE64_LENGTH)
  if (
    (value.vendor === 'ledger' && redactedPcztBase64 === undefined) ||
    (redactedPcztBase64 !== undefined &&
      (redactedPcztBase64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          redactedPcztBase64
        )))
  ) {
    throw new Error('Invalid redacted hardware PCZT')
  }
  return {
    request: parseHardwareSignRequest(value.request),
    fullPcztBase64,
    ...(value.vendor === undefined ? {} : { vendor: value.vendor as 'keystone' | 'ledger' }),
    ...(redactedPcztBase64 === undefined ? {} : { redactedPcztBase64 })
  }
}

export function isHardwareSignRequestFresh(
  request: HardwareSignRequest,
  now = Date.now()
): boolean {
  return request.createdAt <= now && now - request.createdAt <= HARDWARE_SIGN_REQUEST_TTL_MS
}

export function openHardwareConnectTab(vendor?: HardwareConnectVendor): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(`index.html#${hardwareConnectRoute(vendor)}`) })
    .catch(console.error)
}

interface HardwareSignSession {
  requestId: string
  tab: chrome.tabs.Tab & { id: number }
}

async function openHardwareSignSession(
  request: Omit<HardwareSignRequest, 'createdAt'>,
  presentation: HardwareSignPresentation = 'tab'
): Promise<HardwareSignSession> {
  const id = crypto.randomUUID()
  const storedRequest = parseHardwareSignRequest({ ...request, createdAt: Date.now() })
  await chrome.storage.session.set({
    [SIGN_REQUEST_PREFIX + id]: storedRequest
  })
  try {
    const tab = await launchHardwareSignSurface(
      chrome.runtime.getURL(`index.html#/hardware/sign?req=${id}`),
      presentation
    )
    return { requestId: id, tab }
  } catch (error) {
    await clearHardwareSignRequest(id).catch(() => {})
    throw error
  }
}

export async function openHardwareSignTab(
  request: Omit<HardwareSignRequest, 'createdAt'>
): Promise<chrome.tabs.Tab> {
  return (await openHardwareSignSession(request)).tab
}

export async function openHardwareSignAndWait(
  request: Omit<HardwareSignRequest, 'createdAt' | 'reportToOrigin'>,
  options: { presentation?: HardwareSignPresentation } = {}
): Promise<HardwareSignResult> {
  const session = await openHardwareSignSession(
    { ...request, reportToOrigin: true },
    options.presentation
  )
  try {
    return await waitForHardwareSignResult({ requestId: session.requestId, tabId: session.tab.id })
  } finally {
    await clearHardwareSignRequest(session.requestId).catch(() => {})
  }
}

/**
 * Read a pending sign request. Kept in storage until explicitly cleared so
 * the flow survives unlock redirects within the tab.
 */
export async function readHardwareSignRequest(id: string): Promise<HardwareSignRequest | null> {
  const key = SIGN_REQUEST_PREFIX + id
  const data = await chrome.storage.session.get(key)
  if (data[key] === undefined) return null
  try {
    const request = parseHardwareSignRequest(data[key])
    if (!isHardwareSignRequestFresh(request)) throw new Error('Hardware signing request expired')
    return request
  } catch {
    await clearHardwareSignRequest(id).catch(() => {})
    return null
  }
}

export async function clearHardwareSignRequest(id: string): Promise<void> {
  await chrome.storage.session.remove([SIGN_REQUEST_PREFIX + id, PREPARED_SIGN_REQUEST_PREFIX + id])
}

export async function clearPreparedHardwareSignRequest(id: string): Promise<void> {
  await chrome.storage.session.remove(PREPARED_SIGN_REQUEST_PREFIX + id)
}

export async function writePreparedHardwareSignRequest(
  id: string,
  prepared: PreparedHardwareSignRequest
): Promise<void> {
  const parsed = parsePreparedHardwareSignRequest(prepared)
  if (!isHardwareSignRequestFresh(parsed.request)) {
    throw new Error('Hardware signing request expired')
  }
  await chrome.storage.session.set({
    [PREPARED_SIGN_REQUEST_PREFIX + id]: parsed
  })
}

export async function consumePreparedHardwareSignRequest(
  id: string
): Promise<PreparedHardwareSignRequest | null> {
  const requestKey = SIGN_REQUEST_PREFIX + id
  const key = PREPARED_SIGN_REQUEST_PREFIX + id
  const data = await chrome.storage.session.get([requestKey, key])
  if (data[requestKey] === undefined && data[key] === undefined) return null
  let prepared: PreparedHardwareSignRequest
  try {
    const request = parseHardwareSignRequest(data[requestKey])
    prepared = parsePreparedHardwareSignRequest(data[key])
    if (
      !isHardwareSignRequestFresh(request) ||
      JSON.stringify(request) !== JSON.stringify(prepared.request)
    ) {
      throw new Error('Hardware signing request binding mismatch')
    }
  } catch {
    await clearHardwareSignRequest(id)
    return null
  }
  await chrome.storage.session.remove([requestKey, key])
  return prepared
}

export function openKeystoneBitcoinSignTab(transactionId: TransactionId): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(
      `index.html#/hardware/bitcoin-sign?tx=${encodeURIComponent(transactionId)}`
    )
  })
}

async function openMultichainHardwareSignTab(
  transactionId: TransactionId,
  family: 'evm' | 'bitcoin'
): Promise<chrome.tabs.Tab> {
  const response = await chrome.runtime.sendMessage({
    type: 'GET_HARDWARE_TRANSFER_VENDOR',
    transactionId,
    family
  })
  if (typeof response?.error === 'string') throw new Error(response.error)
  if (response?.result === 'ledger')
    return chrome.tabs.create({
      url: chrome.runtime.getURL(
        `index.html#/hardware/ledger-sign?family=${family}&tx=${encodeURIComponent(transactionId)}`
      )
    })
  if (response?.result !== 'keystone') throw new Error('Unsupported hardware signing device')
  return family === 'evm'
    ? openKeystoneEvmSignTab(transactionId)
    : openKeystoneBitcoinSignTab(transactionId)
}
export function openHardwareEvmSignTab(transactionId: TransactionId): Promise<chrome.tabs.Tab> {
  return openMultichainHardwareSignTab(transactionId, 'evm')
}
export function openHardwareBitcoinSignTab(transactionId: TransactionId): Promise<chrome.tabs.Tab> {
  return openMultichainHardwareSignTab(transactionId, 'bitcoin')
}

export function openKeystoneEvmSignTab(transactionId: TransactionId): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(
      `index.html#/hardware/evm-sign?tx=${encodeURIComponent(transactionId)}`
    )
  })
}
