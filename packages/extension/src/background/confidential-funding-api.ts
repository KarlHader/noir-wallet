import { NOIR_SWAP_REFERRAL, type ConfidentialFundingNetworkConfig } from '@/config/intents'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import { readRheaDestinationHash } from '@/core/services/rhea-swap/rhea-order-status'
import { DedupPromise } from '@/lib/async-utils'
import { parseSiweMessage } from 'viem/siwe'
import { isAddress } from 'viem'
import type {
  ConfidentialQuote,
  ConfidentialSignedPayload,
  ConfidentialWithdrawRequest
} from '@/core/services/confidential-funding'
import { assertConfidentialQuoteBinding } from '@/core/services/confidential-funding'

const REQUEST_TIMEOUT_MS = 30_000
const APP_FEE_CACHE_MS = 5 * 60_000
const MAX_CONFIDENTIAL_PROVIDER_FEE_BPS = 20
const INTENTS_CONTRACT = 'intents.near'
const VERSIONED_NONCE_PREFIX = new Uint8Array([86, 40, 246, 198])
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export interface ConfidentialSession {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly refreshExpiresAt: number
}

export interface ConfidentialBalance {
  readonly tokenId: string
  readonly available: string
  readonly source: string
}

export interface ConfidentialStatus {
  readonly status: string
  readonly transactionHash?: string
  readonly errorStatus?: string
  readonly amountOutRaw?: string
  readonly settledAmountOutRaw?: string
  readonly depositedAmountRaw?: string
}

export interface ConfidentialPrivateWithdraw {
  readonly sequence?: number
  readonly transactionType: string
  readonly executionType?: string
  readonly amount: string
  readonly depositAddress: string
  readonly destinationAddress: string
  readonly destinationChain: string
  readonly token: string
  readonly status: string
  readonly scheduledAt?: number
  readonly deadline?: number
  readonly errorStatus?: string
  readonly intentHash?: string
  readonly transactionHash?: string
}

export interface ConfidentialPrivateOrder {
  readonly orderId: string
  readonly signerId: string
  readonly status: string
  readonly mode?: string
  readonly fromAmount?: string
  readonly fromChain?: string
  readonly fromToken?: string
  readonly transactions: readonly ConfidentialPrivateWithdraw[]
}

export interface ConfidentialOrderAuthChallenge {
  readonly challengeId: string
  readonly expiresAt: string
  readonly chainFamily: 'evm'
  readonly chainId: string
  readonly walletAddress: string
  readonly identityKey: string
  readonly principalType: 'wallet' | 'mca'
  readonly queryAddress: string
  readonly mcaAccountId: string | null
  readonly signingMethod: 'personal_sign'
  readonly message: string
}

export interface ConfidentialOrderAuthToken {
  readonly token: string
  readonly expiresAt: string
  readonly queryAddress: string
  readonly principalType: 'wallet' | 'mca'
  readonly mcaAccountId: string | null
}

interface ConfidentialAppFee {
  readonly recipient: string
  readonly fee: number
}

export class ConfidentialFundingApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly ambiguous: boolean,
    readonly businessCode: number | null = null
  ) {
    super(message)
    this.name = 'ConfidentialFundingApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`)
  return value.trim()
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalDepositMemo(record: Record<string, unknown>): string | undefined {
  const value = record.depositMemo ?? record.memo
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error('Confidential deposit memo is invalid')
  }
  if (
    record.depositMemo !== undefined &&
    record.memo !== undefined &&
    record.depositMemo !== record.memo
  ) {
    throw new Error('Confidential deposit memo is ambiguous')
  }
  return value
}

function positiveRaw(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function optionalRaw(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined
}

function parseConfidentialAppFees(value: unknown): readonly ConfidentialAppFee[] {
  if (!isRecord(value)) throw new Error('Confidential app fee config is invalid')
  requiredString(value, 'appId', 'Confidential app ID')
  const fees: ConfidentialAppFee[] = []
  for (const [rateKey, recipientKey] of [
    ['confidentialAppFeeBps', 'confidentialAppFeeRecipient'],
    ['confidentialPlatformFeeBps', 'confidentialPlatformFeeRecipient']
  ] as const) {
    const rate = value[rateKey]
    if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > 10_000) {
      throw new Error('Confidential app fee rate is invalid')
    }
    if (rate === 0) continue
    const recipient = parseNearAccountId(
      requiredString(value, recipientKey, 'Confidential app fee recipient'),
      'Confidential app fee recipient'
    )
    fees.push(Object.freeze({ recipient, fee: rate as number }))
  }
  if (fees.reduce((sum, fee) => sum + fee.fee, 0) > 10_000) {
    throw new Error('Confidential app fee total is invalid')
  }
  return Object.freeze(fees)
}

export function readConfidentialQuoteAppFees(
  quote: ConfidentialQuote | undefined
): readonly ConfidentialAppFee[] {
  const value = quote?.quoteRequest.appFees
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Confidential quote app fees are invalid')
  return value.map(entry => {
    if (
      !isRecord(entry) ||
      typeof entry.fee !== 'number' ||
      !Number.isInteger(entry.fee) ||
      entry.fee < 0 ||
      entry.fee > 10_000
    ) {
      throw new Error('Confidential quote app fees are invalid')
    }
    return {
      recipient: parseNearAccountId(entry.recipient, 'Confidential quote app fee recipient'),
      fee: entry.fee as number
    }
  })
}

function assertQuoteAppFees(
  quote: ConfidentialQuote,
  expected: readonly ConfidentialAppFee[] | undefined,
  providerFees: readonly ConfidentialAppFee[] = []
): void {
  const actual = readConfidentialQuoteAppFees(quote)
  const allExpected = [...(expected ?? []), ...providerFees]
  if (
    allExpected.reduce((sum, fee) => sum + fee.fee, 0) > 10_000 ||
    actual.length !== allExpected.length ||
    actual.some(
      (entry, index) =>
        entry.recipient !== allExpected[index]?.recipient || entry.fee !== allExpected[index]?.fee
    )
  ) {
    throw new Error('Confidential quote app fees do not match the request')
  }
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function parsePrivateOrder(value: unknown): ConfidentialPrivateOrder {
  if (!isRecord(value)) throw new Error('Private order response is invalid')
  const order = isRecord(value.order) ? value.order : value
  const transactions = value.transactions ?? order.transactions
  if (!Array.isArray(transactions)) throw new Error('Private order transactions are invalid')
  const rows = transactions.map(item => {
    if (!isRecord(item)) throw new Error('Private withdrawal row is invalid')
    const transactionType = requiredString(
      item,
      'transaction_type',
      'Private transaction type'
    ).toUpperCase()
    if (transactionType !== 'WITHDRAW' && transactionType !== 'DEPOSIT') {
      throw new Error('Private transaction type is invalid')
    }
    const withdraw = transactionType === 'WITHDRAW'
    const sequence = item.sequence
    if (
      (withdraw || (sequence !== undefined && sequence !== null)) &&
      (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
    ) {
      throw new Error('Private withdrawal sequence is invalid')
    }
    return Object.freeze({
      ...(sequence !== undefined && sequence !== null ? { sequence: sequence as number } : {}),
      transactionType,
      ...(optionalString(item, 'execution_type')
        ? { executionType: optionalString(item, 'execution_type') }
        : {}),
      amount: withdraw
        ? positiveRaw(item.amount, 'Private withdrawal amount')
        : (optionalRaw(item.amount) ?? ''),
      depositAddress: withdraw
        ? requiredString(item, 'deposit_address', 'Private withdrawal deposit address')
        : (optionalString(item, 'deposit_address') ?? ''),
      destinationAddress: withdraw
        ? requiredString(item, 'destination_address', 'Private withdrawal destination')
        : (optionalString(item, 'destination_address') ?? ''),
      destinationChain: withdraw
        ? requiredString(item, 'destination_chain', 'Private withdrawal chain')
        : (optionalString(item, 'destination_chain') ?? ''),
      token: withdraw
        ? requiredString(item, 'token', 'Private withdrawal token')
        : (optionalString(item, 'token') ?? ''),
      status: withdraw
        ? requiredString(item, 'status', 'Private withdrawal status')
        : (optionalString(item, 'status') ?? ''),
      ...(optionalTimestamp(item.scheduled_at, 'Private withdrawal schedule') !== undefined
        ? { scheduledAt: optionalTimestamp(item.scheduled_at, 'Private withdrawal schedule') }
        : {}),
      ...(optionalTimestamp(item.payload_deadline, 'Private withdrawal deadline') !== undefined
        ? { deadline: optionalTimestamp(item.payload_deadline, 'Private withdrawal deadline') }
        : {}),
      ...(optionalString(item, 'error_status')
        ? { errorStatus: optionalString(item, 'error_status') }
        : {}),
      ...(optionalString(item, 'intent_hash')
        ? { intentHash: optionalString(item, 'intent_hash') }
        : {}),
      ...(optionalString(item, 'chain_tx_hash')
        ? { transactionHash: optionalString(item, 'chain_tx_hash') }
        : {})
    })
  })
  const sequenced = rows.filter(row => row.sequence !== undefined)
  if (
    new Set(sequenced.map(row => `${row.transactionType}:${row.sequence}`)).size !==
    sequenced.length
  ) {
    throw new Error('Private withdrawal sequences are duplicated')
  }
  return Object.freeze({
    orderId: requiredString(order, 'order_id', 'Private order ID'),
    signerId: requiredString(order, 'signer_id', 'Private order signer'),
    status: requiredString(order, 'status', 'Private order status'),
    ...(optionalString(order, 'mode') ? { mode: optionalString(order, 'mode') } : {}),
    ...(optionalRaw(order.from_amount) ? { fromAmount: optionalRaw(order.from_amount) } : {}),
    ...(optionalString(order, 'from_chain')
      ? { fromChain: optionalString(order, 'from_chain') }
      : {}),
    ...(optionalString(order, 'from_token')
      ? { fromToken: optionalString(order, 'from_token') }
      : {}),
    transactions: Object.freeze(
      rows.sort(
        (left, right) =>
          (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
      )
    )
  })
}

function parsePrivateOrders(value: unknown): readonly ConfidentialPrivateOrder[] {
  if (!Array.isArray(value)) throw new Error('Private order list is invalid')
  return Object.freeze(value.map(parsePrivateOrder))
}

function erc191ProofSignature(value: string): string {
  if (!value.startsWith('secp256k1:')) throw new Error('Wallet history signature is invalid')
  const encoded = value.slice('secp256k1:'.length)
  let number = 0n
  for (const character of encoded) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('Wallet history signature is invalid')
    number = number * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (number > 0n) {
    bytes.unshift(Number(number & 255n))
    number >>= 8n
  }
  for (const character of encoded) {
    if (character !== '1') break
    bytes.unshift(0)
  }
  if (bytes.length !== 65 || (bytes[64] !== 0 && bytes[64] !== 1)) {
    throw new Error('Wallet history signature is invalid')
  }
  bytes[64] += 27
  return `0x${bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function assertReadonlyHistoryMessage(
  message: string,
  input: {
    readonly walletAddress: string
    readonly chainId: string
    readonly challengeId: string
    readonly expiresAt: string
  },
  requestOrigin: string | undefined
): void {
  if (!requestOrigin) throw new Error('Wallet history request origin is unavailable')
  const origin = new URL(requestOrigin)
  const parsed = parseSiweMessage(message)
  const resources = parsed.resources ?? []
  const walletResource = `urn:rhea:wallet:evm:${input.walletAddress.toLowerCase()}`
  if (
    parsed.domain !== origin.host ||
    parsed.uri !== requestOrigin ||
    (parsed.scheme !== undefined && parsed.scheme !== origin.protocol.slice(0, -1)) ||
    parsed.version !== '1' ||
    parsed.address?.toLowerCase() !== input.walletAddress.toLowerCase() ||
    parsed.chainId !== Number(input.chainId) ||
    parsed.requestId !== input.challengeId ||
    parsed.statement !== 'Authorize read-only access to confidential Unified Swap history.' ||
    parsed.expirationTime?.getTime() !== Date.parse(input.expiresAt) ||
    !parsed.issuedAt ||
    parsed.issuedAt.getTime() > Date.now() + 60_000 ||
    !parsed.nonce ||
    resources.length !== 3 ||
    !resources.includes('urn:rhea:swap:history:confidential:read') ||
    !resources.some(resource => resource.toLowerCase() === walletResource) ||
    !resources.some(resource => /^urn:rhea:app:ak_[a-zA-Z0-9]+$/.test(resource))
  ) {
    throw new Error('Wallet history signing request is not read-only or does not match account')
  }
}

function base64Encode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parseQuote(value: unknown): ConfidentialQuote {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.quoteRequest)) {
    throw new Error('Confidential quote response is invalid')
  }
  const quote = value.quote
  const deadline =
    optionalString(quote, 'deadline') ??
    optionalString(quote, 'timeWhenInactive') ??
    optionalString(value.quoteRequest, 'deadline')
  if (!deadline || !Number.isFinite(Date.parse(deadline))) {
    throw new Error('Confidential quote deadline is invalid')
  }
  return Object.freeze({
    correlationId: requiredString(value, 'correlationId', 'Confidential correlation ID'),
    quoteRequest: Object.freeze({ ...value.quoteRequest }),
    quote: Object.freeze({
      amountIn: positiveRaw(quote.amountIn, 'Confidential input amount'),
      amountOut: positiveRaw(quote.amountOut, 'Confidential output amount'),
      minAmountOut: positiveRaw(
        quote.minAmountOut ?? quote.amountOut,
        'Confidential minimum output'
      ),
      depositAddress: optionalString(quote, 'depositAddress') ?? '',
      ...(optionalDepositMemo(quote) ? { depositMemo: optionalDepositMemo(quote) } : {}),
      deadline,
      ...(optionalRaw(quote.withdrawFee) ? { withdrawFee: optionalRaw(quote.withdrawFee) } : {}),
      ...(optionalRaw(quote.refundFee) ? { refundFee: optionalRaw(quote.refundFee) } : {}),
      ...(typeof quote.timeEstimate === 'number' &&
      Number.isFinite(quote.timeEstimate) &&
      quote.timeEstimate >= 0
        ? { timeEstimate: quote.timeEstimate }
        : {})
    })
  })
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new ConfidentialFundingApiError(
      response.ok
        ? 'Confidential service returned invalid data'
        : `Confidential request failed (${response.status})`,
      response.status,
      false
    )
  }
  if (!response.ok) {
    const message = isRecord(body)
      ? (optionalString(body, 'message') ??
        optionalString(body, 'msg') ??
        optionalString(body, 'error'))
      : undefined
    throw new ConfidentialFundingApiError(
      message ?? `Confidential request failed (${response.status})`,
      response.status,
      false
    )
  }
  if (isRecord(body) && typeof body.code === 'number') {
    if (body.code !== 0) {
      throw new ConfidentialFundingApiError(
        optionalString(body, 'msg') ??
          optionalString(body, 'message') ??
          'Confidential request failed',
        response.status,
        false,
        body.code
      )
    }
    return body.data
  }
  return body
}

async function requestJson(
  url: string,
  init: RequestInit = {},
  accessToken?: string
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const signal = init.signal
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers
      }
    })
    return await readJson(response)
  } catch (error) {
    if (error instanceof ConfidentialFundingApiError) throw error
    throw new ConfidentialFundingApiError(
      'Confidential service is temporarily unavailable',
      null,
      true
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function parseSession(value: unknown, previous?: ConfidentialSession): ConfidentialSession {
  if (!isRecord(value)) throw new Error('Confidential session response is invalid')
  const expiresIn = Number(value.expiresIn)
  const refreshExpiresIn = Number(value.refreshExpiresIn)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Confidential access token expiry is invalid')
  }
  const now = Date.now()
  return Object.freeze({
    accessToken: requiredString(value, 'accessToken', 'Confidential access token'),
    refreshToken: optionalString(value, 'refreshToken') ?? previous?.refreshToken ?? '',
    expiresAt: now + expiresIn * 1_000,
    refreshExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? now + refreshExpiresIn * 1_000
        : (previous?.refreshExpiresAt ?? 0)
  })
}

export class ConfidentialFundingApi {
  private readonly appFeeLookup = new DedupPromise<readonly ConfidentialAppFee[]>()
  private appFeeCache?: Readonly<{ fees: readonly ConfidentialAppFee[]; expiresAt: number }>

  constructor(
    private readonly config: ConfidentialFundingNetworkConfig,
    private readonly nearRpcUrl: string,
    private readonly rheaAccessToken: string,
    private readonly historyRequestOrigin: string | undefined = globalThis.location?.origin
  ) {}

  private oneClickUrl(path: string): string {
    return `${this.config.oneClickApiUrl}${path}`
  }

  private swapUrl(path: string): string {
    return `${this.config.rheaSwapApiUrl}${path}`
  }

  private requireSwapToken(): string {
    if (!this.rheaAccessToken.trim()) throw new Error('RHEA Swap is unavailable')
    return this.rheaAccessToken
  }

  private async getConfidentialAppFees(): Promise<readonly ConfidentialAppFee[]> {
    if (this.appFeeCache && this.appFeeCache.expiresAt > Date.now()) {
      return this.appFeeCache.fees
    }
    return this.appFeeLookup.run(async () => {
      const fees = parseConfidentialAppFees(
        await requestJson(
          this.swapUrl('/api/swap/confidential-app-fee'),
          {},
          this.requireSwapToken()
        )
      )
      this.appFeeCache = Object.freeze({ fees, expiresAt: Date.now() + APP_FEE_CACHE_MS })
      return fees
    })
  }

  async submitWithdraws(
    request: ConfidentialWithdrawRequest
  ): Promise<Readonly<{ orderId: string }>> {
    if (request.withdraws.length < 1 || request.withdraws.length > 5) {
      throw new Error('Confidential withdrawal count is invalid')
    }
    const value = await requestJson(
      this.swapUrl('/v3/private/withdraws'),
      {
        method: 'POST',
        body: JSON.stringify({ ...request, signer_chain_family: 'evm' })
      },
      this.requireSwapToken()
    )
    if (!isRecord(value)) throw new Error('Submitted private order response is invalid')
    return Object.freeze({ orderId: requiredString(value, 'order_id', 'Private order ID') })
  }

  async getPrivateOrders(input: {
    readonly walletToken: string
    readonly signerId: string
    readonly limit?: number
    readonly offset?: number
  }): Promise<Readonly<{ orders: readonly ConfidentialPrivateOrder[]; hasNextPage: boolean }>> {
    const limit = input.limit ?? 50
    const offset = input.offset ?? 0
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new Error('Private order pagination is invalid')
    }
    if (!input.walletToken.trim()) throw new Error('Wallet history authorization is missing')
    const query = new URLSearchParams({
      signer_id: input.signerId.trim(),
      limit: String(limit),
      offset: String(offset)
    })
    if (!query.get('signer_id')) throw new Error('Private order signer is missing')
    const value = await requestJson(this.swapUrl(`/v3/private/orders?${query}`), {
      headers: { Authentication: input.walletToken.trim() }
    })
    if (!isRecord(value) || typeof value.has_next_page !== 'boolean') {
      throw new Error('Private order page is invalid')
    }
    const orders = parsePrivateOrders(value.list)
    if (
      orders.some(order => order.signerId.toLowerCase() !== input.signerId.trim().toLowerCase())
    ) {
      throw new Error('Private order signer does not match request')
    }
    return Object.freeze({ orders, hasNextPage: value.has_next_page })
  }

  async getPrivateOrderDetails(input: {
    readonly walletToken: string
    readonly orderIds: readonly string[]
  }): Promise<readonly ConfidentialPrivateOrder[]> {
    if (
      input.orderIds.length < 1 ||
      input.orderIds.length > 10 ||
      input.orderIds.some(id => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('Private order IDs are invalid')
    }
    if (!input.walletToken.trim()) throw new Error('Wallet history authorization is missing')
    const value = await requestJson(this.swapUrl('/v3/private/orders/details'), {
      method: 'POST',
      headers: { Authentication: input.walletToken.trim() },
      body: JSON.stringify({ order_ids: input.orderIds })
    })
    if (!isRecord(value)) throw new Error('Private order details are invalid')
    const orders = parsePrivateOrders(value.list)
    const requested = new Set(input.orderIds)
    if (orders.some(order => !requested.has(order.orderId))) {
      throw new Error('Private order details do not match request')
    }
    return orders
  }

  async createOrderAuthChallenge(input: {
    readonly walletAddress: string
    readonly chainId: string
    readonly identityKey?: string
    readonly mcaAccountId?: string
  }): Promise<ConfidentialOrderAuthChallenge> {
    const walletAddress = input.walletAddress.trim()
    const chainId = input.chainId.trim()
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(walletAddress) ||
      !/^[1-9][0-9]*$/.test(chainId) ||
      !Number.isSafeInteger(Number(chainId))
    ) {
      throw new Error('Wallet history identity is invalid')
    }
    const value = await requestJson(
      this.swapUrl('/api/swap/history/auth/challenge'),
      {
        method: 'POST',
        body: JSON.stringify({
          chainFamily: 'evm',
          chainId,
          walletAddress,
          ...(input.identityKey ? { identityKey: input.identityKey } : {}),
          ...(input.mcaAccountId ? { mcaAccountId: input.mcaAccountId } : {})
        })
      },
      this.requireSwapToken()
    )
    if (!isRecord(value) || !isRecord(value.signingInput)) {
      throw new Error('Wallet history challenge is invalid')
    }
    const principalType = input.mcaAccountId ? 'mca' : 'wallet'
    const mcaAccountId = value.mcaAccountId
    const queryAddress = requiredString(value, 'queryAddress', 'Wallet history query address')
    const expectedQueryAddress = input.mcaAccountId?.trim() || walletAddress
    const expiry = requiredString(value, 'expiresAt', 'Wallet history challenge expiry')
    if (
      value.chainFamily !== 'evm' ||
      value.chainId !== chainId ||
      optionalString(value, 'address')?.toLowerCase() !== walletAddress.toLowerCase() ||
      optionalString(value, 'walletAddress')?.toLowerCase() !== walletAddress.toLowerCase() ||
      value.signingMethod !== 'personal_sign' ||
      value.principalType !== principalType ||
      (principalType === 'mca'
        ? typeof mcaAccountId !== 'string' ||
          mcaAccountId.toLowerCase() !== input.mcaAccountId?.toLowerCase()
        : mcaAccountId !== null) ||
      queryAddress.toLowerCase() !== expectedQueryAddress.toLowerCase() ||
      optionalString(value, 'identityKey')?.toLowerCase() !== walletAddress.toLowerCase() ||
      (input.identityKey &&
        optionalString(value, 'identityKey')?.toLowerCase() !== input.identityKey.toLowerCase()) ||
      !Number.isFinite(Date.parse(expiry)) ||
      Date.parse(expiry) <= Date.now()
    ) {
      throw new Error('Wallet history challenge does not match account or network')
    }
    const challengeId = requiredString(value, 'challengeId', 'Wallet history challenge ID')
    const message = requiredString(value.signingInput, 'message', 'Wallet history message')
    assertReadonlyHistoryMessage(
      message,
      { walletAddress, chainId, challengeId, expiresAt: expiry },
      this.historyRequestOrigin
    )
    return Object.freeze({
      challengeId,
      expiresAt: expiry,
      chainFamily: 'evm' as const,
      chainId,
      walletAddress,
      identityKey: requiredString(value, 'identityKey', 'Wallet history identity'),
      principalType,
      queryAddress,
      mcaAccountId: principalType === 'mca' ? input.mcaAccountId!.trim() : null,
      signingMethod: 'personal_sign' as const,
      message
    })
  }

  async authenticateOrderChallenge(
    challenge: ConfidentialOrderAuthChallenge,
    signed: ConfidentialSignedPayload
  ): Promise<ConfidentialOrderAuthToken> {
    if (
      signed.standard !== 'erc191' ||
      signed.payload !== challenge.message ||
      Date.parse(challenge.expiresAt) <= Date.now()
    ) {
      throw new Error('Wallet history signature does not match challenge')
    }
    assertReadonlyHistoryMessage(challenge.message, challenge, this.historyRequestOrigin)
    const value = await requestJson(
      this.swapUrl('/api/swap/history/auth/verify'),
      {
        method: 'POST',
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          proof: { signature: erc191ProofSignature(signed.signature) }
        })
      },
      this.requireSwapToken()
    )
    if (
      !isRecord(value) ||
      value.tokenType !== 'Bearer' ||
      value.scope !== 'swap:history:confidential:read' ||
      value.principalType !== challenge.principalType ||
      value.queryAddress !== challenge.queryAddress ||
      value.mcaAccountId !== challenge.mcaAccountId
    ) {
      throw new Error('Wallet history authorization does not match challenge')
    }
    const expiry = requiredString(value, 'expiresAt', 'Wallet history token expiry')
    if (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) {
      throw new Error('Wallet history token expiry is invalid')
    }
    return Object.freeze({
      token: requiredString(value, 'token', 'Wallet history token'),
      expiresAt: expiry,
      queryAddress: challenge.queryAddress,
      principalType: challenge.principalType,
      mcaAccountId: challenge.mcaAccountId
    })
  }

  async createAuthPayload(
    signerId: string
  ): Promise<Readonly<{ standard: 'erc191'; payload: string }>> {
    const response = await requestJson(this.nearRpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'confidential-auth-salt',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: INTENTS_CONTRACT,
          method_name: 'current_salt',
          args_base64: 'e30='
        }
      })
    })
    if (
      !isRecord(response) ||
      !isRecord(response.result) ||
      !Array.isArray(response.result.result)
    ) {
      throw new Error('NEAR Intents nonce salt response is invalid')
    }
    const encoded = String.fromCharCode(...response.result.result.map(Number))
    const saltHex = JSON.parse(encoded) as unknown
    if (typeof saltHex !== 'string' || !/^[0-9a-fA-F]{8}$/.test(saltHex)) {
      throw new Error('NEAR Intents nonce salt is invalid')
    }
    const now = new Date()
    const deadline = new Date(now.getTime() + 5 * 60_000)
    const nonce = new Uint8Array(32)
    nonce.set(VERSIONED_NONCE_PREFIX, 0)
    nonce[4] = 0
    nonce.set(
      Uint8Array.from(saltHex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16)),
      5
    )
    new DataView(nonce.buffer).setBigUint64(9, BigInt(deadline.getTime()) * 1_000_000n, true)
    const random = new Uint8Array(15)
    crypto.getRandomValues(random)
    new DataView(random.buffer).setBigInt64(0, BigInt(now.getTime()) * 1_000_000n, true)
    nonce.set(random, 17)
    return Object.freeze({
      standard: 'erc191' as const,
      payload: JSON.stringify({
        signer_id: signerId,
        verifying_contract: INTENTS_CONTRACT,
        deadline: deadline.toISOString(),
        nonce: base64Encode(nonce),
        intents: []
      })
    })
  }

  async authenticate(signedData: ConfidentialSignedPayload): Promise<ConfidentialSession> {
    return parseSession(
      await requestJson(this.oneClickUrl('/auth/authenticate'), {
        method: 'POST',
        body: JSON.stringify({ signedData })
      })
    )
  }

  async refresh(session: ConfidentialSession): Promise<ConfidentialSession> {
    return parseSession(
      await requestJson(this.oneClickUrl('/auth/refresh'), {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken })
      }),
      session
    )
  }

  async getBalances(accessToken: string): Promise<readonly ConfidentialBalance[]> {
    const value = await requestJson(
      `${this.config.oneClickDirectApiUrl}/account/balances`,
      {},
      accessToken
    )
    if (!isRecord(value) || !Array.isArray(value.balances)) {
      throw new Error('Confidential balances response is invalid')
    }
    return Object.freeze(
      value.balances.map(item => {
        if (!isRecord(item)) throw new Error('Confidential balance row is invalid')
        const tokenId = optionalString(item, 'tokenId')
        const available = optionalString(item, 'available')
        if (!tokenId || !available || !/^\d+$/.test(available)) {
          throw new Error('Confidential balance row is invalid')
        }
        return Object.freeze({ tokenId, available, source: optionalString(item, 'source') ?? '' })
      })
    )
  }

  async quote(input: {
    readonly originAsset: string
    readonly destinationAsset: string
    readonly amountRaw: string
    readonly signerId: string
    readonly refundTo?: string
    readonly recipient: string
    readonly depositType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    readonly refundType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    readonly recipientType: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
    readonly slippageBps: number
    readonly dry: boolean
  }): Promise<ConfidentialQuote> {
    const isWithdrawal =
      input.depositType === 'CONFIDENTIAL_INTENTS' && input.recipientType === 'DESTINATION_CHAIN'
    const isDeposit =
      input.depositType === 'ORIGIN_CHAIN' && input.recipientType === 'CONFIDENTIAL_INTENTS'
    const isInternalSwap =
      input.depositType === 'CONFIDENTIAL_INTENTS' &&
      input.refundType === 'CONFIDENTIAL_INTENTS' &&
      input.recipientType === 'CONFIDENTIAL_INTENTS' &&
      input.recipient.toLowerCase() === input.signerId.toLowerCase() &&
      input.refundTo === undefined &&
      input.originAsset !== input.destinationAsset
    if (!isWithdrawal && !isDeposit && !isInternalSwap) {
      throw new Error('Confidential quote route is invalid')
    }
    const appFees = isWithdrawal || isInternalSwap ? await this.getConfidentialAppFees() : undefined
    const request = {
      dry: input.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: input.slippageBps,
      originAsset: input.originAsset,
      depositType: input.depositType,
      destinationAsset: input.destinationAsset,
      amount: input.amountRaw,
      refundTo: input.refundTo ?? input.signerId,
      refundType: input.refundType,
      recipient: input.recipient,
      recipientType: input.recipientType,
      deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
      referral: NOIR_SWAP_REFERRAL,
      quoteWaitingTimeMs: 0,
      ...(appFees ? { appFees } : {}),
      confidentiality: 'basic'
    }
    let providerFees: readonly ConfidentialAppFee[] = []
    if (appFees) {
      const baseline = parseQuote(
        await requestJson(this.oneClickUrl('/quote'), {
          method: 'POST',
          body: JSON.stringify({ ...request, dry: true, appFees: undefined })
        })
      )
      assertConfidentialQuoteBinding(baseline, input)
      if (
        Object.entries(request).some(
          ([key, value]) =>
            key !== 'appFees' && baseline.quoteRequest[key] !== (key === 'dry' ? true : value)
        )
      ) {
        throw new Error('Confidential provider fee quote is invalid')
      }
      providerFees = readConfidentialQuoteAppFees(baseline)
      if (
        providerFees.length > 1 ||
        providerFees.some(fee => fee.fee > MAX_CONFIDENTIAL_PROVIDER_FEE_BPS)
      ) {
        throw new Error('Confidential provider fee quote is invalid')
      }
    }
    const value = await requestJson(this.oneClickUrl('/quote'), {
      method: 'POST',
      body: JSON.stringify(request)
    })
    const quote = parseQuote(value)
    if (
      appFees &&
      Object.entries(request).some(
        ([key, value]) => key !== 'appFees' && quote.quoteRequest[key] !== value
      )
    ) {
      throw new Error('Confidential quote does not match the requested funding route')
    }
    assertQuoteAppFees(quote, appFees, providerFees)
    return quote
  }

  async generateIntent(input: {
    readonly signerId: string
    readonly depositAddress: string
  }): Promise<Readonly<{ intent: unknown; correlationId: string }>> {
    const value = await requestJson(this.oneClickUrl('/generate-intent'), {
      method: 'POST',
      body: JSON.stringify({
        type: 'swap_transfer',
        standard: 'erc191',
        signerId: input.signerId,
        depositAddress: input.depositAddress
      })
    })
    if (!isRecord(value) || !value.intent)
      throw new Error('Generated confidential intent is invalid')
    return Object.freeze({
      intent: value.intent,
      correlationId: requiredString(value, 'correlationId', 'Confidential correlation ID')
    })
  }

  async submitIntent(
    signedData: ConfidentialSignedPayload,
    accessToken: string
  ): Promise<Readonly<{ intentHash: string; correlationId: string }>> {
    const value = await requestJson(
      this.oneClickUrl('/submit-intent'),
      {
        method: 'POST',
        body: JSON.stringify({ type: 'swap_transfer', signedData })
      },
      accessToken
    )
    if (!isRecord(value)) throw new Error('Submitted confidential intent response is invalid')
    return Object.freeze({
      intentHash: requiredString(value, 'intentHash', 'Confidential intent hash'),
      correlationId: requiredString(value, 'correlationId', 'Confidential correlation ID')
    })
  }

  async getStatus(depositAddress: string, chainId: string): Promise<ConfidentialStatus> {
    if (!this.rheaAccessToken) {
      throw new Error('RHEA Swap is unavailable')
    }
    const query = new URLSearchParams({
      orderId: depositAddress,
      router: 'nearintents',
      chainId
    })
    const value = await requestJson(
      `${this.config.rheaSwapApiUrl}/api/swap/order-status?${query.toString()}`,
      {},
      this.rheaAccessToken
    )
    if (!isRecord(value)) throw new Error('RHEA confidential status response is invalid')
    const details = isRecord(value.swapDetails) ? value.swapDetails : {}
    const transactionHash = readRheaDestinationHash(value)
    const quoteResponse = isRecord(value.quoteResponse) ? value.quoteResponse : {}
    const statusQuote = isRecord(quoteResponse.quote) ? quoteResponse.quote : {}
    const amountOutRaw =
      optionalRaw(details.amountOut) ??
      optionalRaw(details.depositedAmount) ??
      optionalRaw(statusQuote.amountOut)
    return Object.freeze({
      status: requiredString(value, 'status', 'Confidential status'),
      ...(transactionHash ? { transactionHash } : {}),
      ...(amountOutRaw ? { amountOutRaw } : {}),
      ...(optionalRaw(details.amountOut)
        ? { settledAmountOutRaw: optionalRaw(details.amountOut) }
        : {}),
      ...(optionalString(details, 'refundReason')
        ? { errorStatus: optionalString(details, 'refundReason') }
        : {})
    })
  }

  async getOneClickStatus(
    depositAddress: string,
    depositMemo?: string
  ): Promise<ConfidentialStatus> {
    const query = new URLSearchParams({ depositAddress })
    if (depositMemo) query.set('depositMemo', depositMemo)
    const value = await requestJson(`${this.oneClickUrl('/status')}?${query.toString()}`)
    if (!isRecord(value)) throw new Error('Shield swap status response is invalid')
    const quoteResponse = isRecord(value.quoteResponse) ? value.quoteResponse : {}
    const statusQuote = isRecord(quoteResponse.quote) ? quoteResponse.quote : {}
    const echoedAddress = optionalString(statusQuote, 'depositAddress')
    if (
      echoedAddress &&
      (isAddress(depositAddress)
        ? echoedAddress.toLowerCase() !== depositAddress.toLowerCase()
        : echoedAddress !== depositAddress)
    ) {
      throw new Error('Shield swap status does not match its quote')
    }
    const echoedMemo = optionalDepositMemo(statusQuote)
    if (depositMemo !== undefined && echoedMemo !== undefined && echoedMemo !== depositMemo) {
      throw new Error('Shield swap status memo does not match its quote')
    }
    const details = isRecord(value.swapDetails) ? value.swapDetails : {}
    const settledAmountOutRaw = optionalRaw(details.amountOut)
    const depositedAmountRaw = optionalRaw(details.depositedAmount)
    return Object.freeze({
      status: requiredString(value, 'status', 'Shield swap status'),
      ...(settledAmountOutRaw ? { amountOutRaw: settledAmountOutRaw, settledAmountOutRaw } : {}),
      ...(depositedAmountRaw ? { depositedAmountRaw } : {}),
      ...(optionalString(details, 'refundReason')
        ? { errorStatus: optionalString(details, 'refundReason') }
        : {})
    })
  }
}
