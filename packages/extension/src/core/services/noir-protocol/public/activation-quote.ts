import type { NoirPublicNetworkConfig } from './config'
import {
  EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID,
  getEvmNativeProtocolAssetId
} from '@/config/asset-market-assets'
import { createPublicMcaMessage, parsePublicSignerWallet, readPublicDecimal } from './protocol'

export interface NoirPublicActivationQuoteRequest {
  readonly originAsset: string
  readonly destinationAsset: string
  readonly amount: string
  readonly refundTo: string
  readonly recipient: string
  readonly customRecipientMsg: string
  readonly dry: false
  readonly swapType: 'EXACT_OUTPUT'
  readonly refundType: 'ORIGIN_CHAIN'
  readonly recipientType: 'DESTINATION_CHAIN'
  readonly depositType: 'ORIGIN_CHAIN'
  readonly deadline: string
  readonly quoteWaitingTimeMs: 3000
  readonly slippageTolerance: 50
}

export interface NoirPublicActivationQuote {
  readonly request: NoirPublicActivationQuoteRequest
  readonly depositAddress: string
  readonly amountInRaw: string
  readonly amountOutRaw: string
  readonly minAmountOutRaw: string
  readonly expiresAt: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function readQuoteAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 150 ||
    !/^[A-Za-z0-9:._-]+$/.test(value)
  ) {
    throw new Error('Invalid Public activation deposit address')
  }
  return value
}

function readRefundAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 150 ||
    !/^[A-Za-z0-9:._-]+$/.test(value)
  ) {
    throw new Error('Invalid Public activation refund address')
  }
  return value
}

export function createPublicActivationQuoteRequest(input: {
  config: NoirPublicNetworkConfig
  publicKey: string
  signature: string
  evmSource?: Readonly<{ chainId: string; protocolAssetId: string }>
  refundAddress: string
  amountOutRaw: string
  now?: number
}): NoirPublicActivationQuoteRequest {
  const amount = readPublicDecimal(input.amountOutRaw, 'Public activation target amount')
  if (amount === '0') throw new Error('Public activation target amount must be positive')
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid activation quote time')
  const source = input.evmSource
  if (source && source.protocolAssetId !== getEvmNativeProtocolAssetId(source.chainId)) {
    throw new Error('Public EVM activation asset is not registered for its chain')
  }
  return Object.freeze({
    originAsset: source?.protocolAssetId ?? input.config.zecOriginAsset,
    destinationAsset: input.config.zecDestinationAsset,
    amount,
    refundTo: readRefundAddress(input.refundAddress),
    recipient: input.config.parentContractId,
    customRecipientMsg: createPublicMcaMessage(
      input.publicKey,
      input.signature,
      source ? 'evm' : 'zcash'
    ),
    dry: false,
    swapType: 'EXACT_OUTPUT',
    refundType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    depositType: 'ORIGIN_CHAIN',
    deadline: new Date(now + 60 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
    slippageTolerance: 50
  })
}

export function parsePublicActivationQuote(
  value: unknown,
  request: NoirPublicActivationQuoteRequest,
  now = Date.now()
): NoirPublicActivationQuote {
  const response = record(value, 'Public activation quote response')
  const quote = record(response.quote, 'Public activation quote')
  const amountInRaw = readPublicDecimal(quote.amountIn, 'Public activation input amount')
  const amountOutRaw = readPublicDecimal(quote.amountOut, 'Public activation output amount')
  const minAmountOutRaw = readPublicDecimal(quote.minAmountOut, 'Public activation minimum output')
  if (
    amountInRaw === '0' ||
    BigInt(minAmountOutRaw) < BigInt(request.amount) ||
    BigInt(amountOutRaw) < BigInt(request.amount)
  ) {
    throw new Error('Public activation quote does not cover the required creation amount')
  }
  if (amountOutRaw !== request.amount || minAmountOutRaw !== request.amount) {
    throw new Error('Public activation quote differs from the requested output')
  }
  if (typeof quote.deadline !== 'string') throw new Error('Invalid Public activation quote expiry')
  const deadline = Date.parse(quote.deadline)
  const requestedDeadline = Date.parse(request.deadline)
  if (
    !Number.isFinite(deadline) ||
    !Number.isFinite(requestedDeadline) ||
    Math.min(deadline, requestedDeadline) <= now
  ) {
    throw new Error('Public activation quote is expired')
  }
  return Object.freeze({
    request,
    depositAddress: readQuoteAddress(quote.depositAddress),
    amountInRaw,
    amountOutRaw,
    minAmountOutRaw,
    // The bridge may retain the deposit beyond the requested deadline. That
    // cannot extend the wallet's authorization to initiate the payment.
    expiresAt: new Date(Math.min(deadline, requestedDeadline)).toISOString()
  })
}

export function parsePublicBridgeMinimum(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^Amount is too low for bridge, try at least ([1-9][0-9]{0,77})$/i.exec(
    value.trim()
  )
  return match ? readPublicDecimal(match[1], 'Public bridge minimum') : null
}

export function increasePublicActivationQuoteRequest(
  request: NoirPublicActivationQuoteRequest,
  minimumAmountRaw: string
): NoirPublicActivationQuoteRequest {
  const minimum = readPublicDecimal(minimumAmountRaw, 'Public bridge minimum')
  if (BigInt(minimum) <= BigInt(request.amount)) {
    throw new Error('Public bridge minimum did not increase')
  }
  return Object.freeze({ ...request, amount: minimum })
}

export function assertPublicActivationQuoteRequest(
  request: NoirPublicActivationQuoteRequest,
  config: NoirPublicNetworkConfig
): void {
  if (typeof request.customRecipientMsg !== 'string' || request.customRecipientMsg.length > 2048) {
    throw new Error('Invalid Public activation MCA message')
  }
  const message = record(JSON.parse(request.customRecipientMsg), 'Public activation MCA message')
  if (
    Object.keys(message).length !== 2 ||
    !Array.isArray(message.w) ||
    message.w.length !== 1 ||
    !Array.isArray(message.s) ||
    message.s.length !== 1
  )
    throw new Error('Invalid Public activation MCA message')
  const wallet = parsePublicSignerWallet(message.w[0])
  const isEvm = 'EVM' in wallet
  const expectedMessage = isEvm
    ? createPublicMcaMessage(`0x${wallet.EVM}`, message.s[0], 'evm')
    : createPublicMcaMessage(wallet.Zcash, message.s[0])
  const registeredEvmAssets = [
    ...Object.keys(EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID).map(getEvmNativeProtocolAssetId)
  ]
  if (
    request.recipient !== config.parentContractId ||
    request.customRecipientMsg !== expectedMessage ||
    (isEvm
      ? !registeredEvmAssets.includes(request.originAsset)
      : request.originAsset !== config.zecOriginAsset) ||
    request.destinationAsset !== config.zecDestinationAsset ||
    request.swapType !== 'EXACT_OUTPUT'
  ) {
    throw new Error('Public activation quote does not match the configured MCA contract')
  }
}

export function assertPublicActivationQuoteForPayment(
  quote: NoirPublicActivationQuote,
  config: NoirPublicNetworkConfig,
  creationFeeRaw: string,
  now = Date.now()
): void {
  assertPublicActivationQuoteRequest(quote.request, config)
  const fee = readPublicDecimal(creationFeeRaw, 'Public MCA creation fee')
  if (
    quote.amountOutRaw !== quote.request.amount ||
    quote.minAmountOutRaw !== quote.request.amount ||
    BigInt(quote.amountOutRaw) < BigInt(fee)
  ) {
    throw new Error('Activation quote no longer covers the reviewed output and creation fee')
  }
  if (
    !Number.isFinite(Date.parse(quote.expiresAt)) ||
    Date.parse(quote.expiresAt) <= now ||
    Date.parse(quote.expiresAt) > Date.parse(quote.request.deadline)
  ) {
    throw new Error('Activation quote expired. Request a new quote.')
  }
}

export function assertPublicDryActivationQuote(
  value: unknown,
  request: NoirPublicActivationQuoteRequest
): void {
  const dryQuote = record(value, 'Public dry quote response')
  const dry = record(dryQuote.quote, 'Public dry quote')
  if (
    readPublicDecimal(dry.amountOut, 'Public dry output') !== request.amount ||
    readPublicDecimal(dry.minAmountOut, 'Public dry minimum output') !== request.amount
  ) {
    throw new Error('Public dry quote differs from the requested output')
  }
}
