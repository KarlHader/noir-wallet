import type { BitcoinTransferIntent } from '@/infrastructure/chains/bitcoin'

export const BITCOIN_DAPP_RUNTIME_METHODS = Object.freeze([
  'connect',
  'requestAccounts',
  'getAccounts',
  'getNetwork',
  'getChain',
  'getPublicKey',
  'getBalance',
  'sendBitcoin',
  'signMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'switchNetwork',
  'switchChain',
  'disconnect'
] as const)

export type BitcoinDAppRuntimeMethod = (typeof BITCOIN_DAPP_RUNTIME_METHODS)[number]

export type BitcoinProviderErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32602 | -32603

export interface BitcoinProviderErrorShape {
  readonly code: BitcoinProviderErrorCode
  readonly message: string
}

export class BitcoinProviderError extends Error {
  readonly code: BitcoinProviderErrorCode

  constructor(code: BitcoinProviderErrorCode, message: string) {
    super(message)
    this.name = 'BitcoinProviderError'
    this.code = code
  }
}

export function toBitcoinProviderErrorShape(error: unknown): BitcoinProviderErrorShape {
  if (error instanceof BitcoinProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

function invalidParams(message: string): never {
  throw new BitcoinProviderError(-32602, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertNoParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    invalidParams('This method does not accept parameters.')
  }
}

export function parseBitcoinNoParams(params: readonly unknown[] | undefined): void {
  assertNoParams(params)
}

export interface ParsedBitcoinSendRequest {
  readonly intent: BitcoinTransferIntent
  readonly feeRateSatsPerVbyte?: number
}

export function parseBitcoinSendRequest(
  params: readonly unknown[] | undefined
): ParsedBitcoinSendRequest {
  if (!Array.isArray(params) || params.length < 2 || params.length > 3) {
    invalidParams('sendBitcoin requires a recipient and an integer satoshi amount.')
  }
  const [recipient, amount, options] = params
  if (typeof recipient !== 'string' || recipient.length === 0 || recipient.length > 128) {
    invalidParams('Bitcoin recipient is invalid.')
  }
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
    invalidParams('Bitcoin amount must be a positive safe integer in satoshis.')
  }
  let feeRateSatsPerVbyte: number | undefined
  if (options !== undefined) {
    if (!isRecord(options)) invalidParams('Bitcoin send options are invalid.')
    if (Object.keys(options).some(key => key !== 'feeRate')) {
      invalidParams('Bitcoin send options contain unsupported fields.')
    }
    if (options.feeRate !== undefined) {
      if (
        !Number.isSafeInteger(options.feeRate) ||
        (options.feeRate as number) <= 0 ||
        (options.feeRate as number) > 10_000
      ) {
        invalidParams('Bitcoin feeRate must be an integer between 1 and 10000 sat/vB.')
      }
      feeRateSatsPerVbyte = options.feeRate as number
    }
  }
  return Object.freeze({
    intent: Object.freeze({
      recipient,
      amount: Object.freeze({ mode: 'exact' as const, valueSats: String(amount) })
    }),
    ...(feeRateSatsPerVbyte === undefined ? {} : { feeRateSatsPerVbyte })
  })
}

export interface ParsedBitcoinMessageRequest {
  readonly message: Uint8Array
  readonly displayMessage: string
}

export function parseBitcoinMessageRequest(
  params: readonly unknown[] | undefined
): ParsedBitcoinMessageRequest {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) {
    invalidParams('signMessage requires a message and optional signature type.')
  }
  const [message, signatureType = 'bip322-simple'] = params
  if (typeof message !== 'string') invalidParams('Bitcoin message must be text.')
  const bytes = new TextEncoder().encode(message)
  if (bytes.length === 0 || bytes.length > 4 * 1024) {
    invalidParams('Bitcoin message must contain between 1 and 4096 UTF-8 bytes.')
  }
  if (signatureType !== 'bip322-simple') {
    throw new BitcoinProviderError(
      4200,
      'Noir Wallet supports BIP-322 simple Bitcoin message signatures only.'
    )
  }
  return Object.freeze({ message: bytes, displayMessage: message })
}

export interface ParsedBitcoinPsbtRequest {
  readonly psbtHex: string
  readonly autoFinalized: boolean
}

export function parseBitcoinPsbtRequest(
  params: readonly unknown[] | undefined
): ParsedBitcoinPsbtRequest {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) {
    invalidParams('signPsbt requires one hexadecimal PSBT and optional signing options.')
  }
  const [psbtHexValue, options] = params
  if (
    typeof psbtHexValue !== 'string' ||
    psbtHexValue.length < 10 ||
    psbtHexValue.length > 512 * 1024 ||
    psbtHexValue.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(psbtHexValue) ||
    !psbtHexValue.toLowerCase().startsWith('70736274ff')
  ) {
    invalidParams('Bitcoin PSBT must be bounded canonical hexadecimal data.')
  }
  if (options !== undefined) {
    if (!isRecord(options)) invalidParams('Bitcoin PSBT signing options are invalid.')
    if (Object.keys(options).some(key => key !== 'autoFinalized')) {
      invalidParams('Bitcoin PSBT signing options contain unsupported fields.')
    }
    if (options.autoFinalized !== undefined && typeof options.autoFinalized !== 'boolean') {
      invalidParams('autoFinalized must be a boolean when provided.')
    }
  }
  return Object.freeze({
    psbtHex: psbtHexValue.toLowerCase(),
    autoFinalized: options === undefined || options.autoFinalized !== false
  })
}

export function parseBitcoinPsbtsRequest(
  params: readonly unknown[] | undefined
): readonly ParsedBitcoinPsbtRequest[] {
  if (
    !Array.isArray(params) ||
    params.length < 1 ||
    params.length > 2 ||
    !Array.isArray(params[0])
  ) {
    invalidParams('signPsbts requires an array of hexadecimal PSBTs and optional signing options.')
  }
  if (params[0].length === 0 || params[0].length > 16) {
    invalidParams('signPsbts accepts between 1 and 16 PSBTs.')
  }
  const options = params[1]
  if (options !== undefined && (!Array.isArray(options) || options.length !== params[0].length)) {
    invalidParams('signPsbts options must match the PSBT array length.')
  }
  return Object.freeze(
    params[0].map((psbtHex, index) =>
      parseBitcoinPsbtRequest([
        psbtHex,
        ...(options === undefined || options[index] === undefined ? [] : [options[index]])
      ])
    )
  )
}

export function parseBitcoinPushPsbtRequest(
  params: readonly unknown[] | undefined
): ParsedBitcoinPsbtRequest {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('pushPsbt requires one hexadecimal PSBT.')
  }
  return parseBitcoinPsbtRequest(params)
}

export function parseBitcoinPushTransactionRequest(params: readonly unknown[] | undefined): string {
  if (!Array.isArray(params) || params.length !== 1 || !isRecord(params[0])) {
    invalidParams('pushTx requires one raw transaction object.')
  }
  if (Object.keys(params[0]).length !== 1 || typeof params[0].rawtx !== 'string') {
    invalidParams('pushTx requires only a rawtx hexadecimal field.')
  }
  const rawTransactionHex = params[0].rawtx
  if (
    rawTransactionHex.length < 20 ||
    rawTransactionHex.length > 2 * 1024 * 1024 ||
    rawTransactionHex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(rawTransactionHex)
  ) {
    invalidParams('Bitcoin raw transaction must be bounded hexadecimal data.')
  }
  return rawTransactionHex.toLowerCase()
}

export function parseBitcoinNetworkRequest(
  params: readonly unknown[] | undefined
): 'livenet' | 'testnet' {
  if (
    !Array.isArray(params) ||
    params.length !== 1 ||
    (params[0] !== 'livenet' && params[0] !== 'testnet')
  ) {
    invalidParams('Bitcoin network must be livenet or testnet.')
  }
  return params[0]
}

export function parseBitcoinChainRequest(
  params: readonly unknown[] | undefined
): 'BITCOIN_MAINNET' | 'BITCOIN_TESTNET' {
  if (!Array.isArray(params) || params.length !== 1 || !isRecord(params[0])) {
    invalidParams('A Bitcoin chain object is required.')
  }
  const keys = Object.keys(params[0])
  if (
    keys.length !== 1 ||
    keys[0] !== 'enum' ||
    (params[0].enum !== 'BITCOIN_MAINNET' && params[0].enum !== 'BITCOIN_TESTNET')
  ) {
    invalidParams('Bitcoin chain enum is invalid.')
  }
  return params[0].enum
}
