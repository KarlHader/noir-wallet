import type { PearlTransferIntent } from '@/infrastructure/chains/pearl'

export const PEARL_DAPP_RUNTIME_METHODS = Object.freeze([
  'connect',
  'requestAccounts',
  'getAccounts',
  'getNetwork',
  'getChain',
  'getPublicKey',
  'getBalance',
  'sendPearl',
  'signMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'switchNetwork',
  'switchChain',
  'disconnect'
] as const)

export type PearlDAppRuntimeMethod = (typeof PEARL_DAPP_RUNTIME_METHODS)[number]

export type PearlProviderErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32602 | -32603

export interface PearlProviderErrorShape {
  readonly code: PearlProviderErrorCode
  readonly message: string
}

export class PearlProviderError extends Error {
  readonly code: PearlProviderErrorCode

  constructor(code: PearlProviderErrorCode, message: string) {
    super(message)
    this.name = 'PearlProviderError'
    this.code = code
  }
}

export function toPearlProviderErrorShape(error: unknown): PearlProviderErrorShape {
  if (error instanceof PearlProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return Object.freeze({ code: -32603, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

function invalidParams(message: string): never {
  throw new PearlProviderError(-32602, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parsePearlNoParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    invalidParams('This method does not accept parameters.')
  }
}

export interface ParsedPearlSendRequest {
  readonly intent: PearlTransferIntent
  readonly feeRateSatsPerVbyte?: number
}

export function parsePearlSendRequest(
  params: readonly unknown[] | undefined
): ParsedPearlSendRequest {
  if (!Array.isArray(params) || params.length < 2 || params.length > 3) {
    invalidParams('sendPearl requires a recipient and an integer satoshi amount.')
  }
  const [recipient, amount, options] = params
  if (typeof recipient !== 'string' || recipient.length === 0 || recipient.length > 128) {
    invalidParams('Pearl recipient is invalid.')
  }
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
    invalidParams('Pearl amount must be a positive safe integer in satoshis.')
  }
  // P2TR dust threshold; amounts below this never produce a valid Pearl transfer.
  if ((amount as number) < 330) {
    invalidParams('Pearl amount must be at least 330 satoshis.')
  }
  let feeRateSatsPerVbyte: number | undefined
  if (options !== undefined) {
    if (!isRecord(options)) invalidParams('Pearl send options are invalid.')
    if (Object.keys(options).some(key => key !== 'feeRate')) {
      invalidParams('Pearl send options contain unsupported fields.')
    }
    if (options.feeRate !== undefined) {
      if (
        !Number.isSafeInteger(options.feeRate) ||
        (options.feeRate as number) <= 0 ||
        (options.feeRate as number) > 10_000
      ) {
        invalidParams('Pearl feeRate must be an integer between 1 and 10000 sat/vB.')
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

export interface ParsedPearlMessageRequest {
  readonly message: Uint8Array
  readonly displayMessage: string
}

export function parsePearlMessageRequest(
  params: readonly unknown[] | undefined
): ParsedPearlMessageRequest {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) {
    invalidParams('signMessage requires a message and optional signature type.')
  }
  const [message, signatureType = 'bip322-simple'] = params
  if (typeof message !== 'string') invalidParams('Pearl message must be text.')
  const bytes = new TextEncoder().encode(message)
  if (bytes.length === 0 || bytes.length > 4 * 1024) {
    invalidParams('Pearl message must contain between 1 and 4096 UTF-8 bytes.')
  }
  if (signatureType !== 'bip322-simple') {
    throw new PearlProviderError(
      4200,
      'Noir Wallet supports BIP-322 simple Pearl message signatures only.'
    )
  }
  return Object.freeze({ message: bytes, displayMessage: message })
}

export interface ParsedPearlPsbtRequest {
  readonly psbtHex: string
  readonly autoFinalized: boolean
}

export function parsePearlPsbtRequest(
  params: readonly unknown[] | undefined
): ParsedPearlPsbtRequest {
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
    invalidParams('Pearl PSBT must be bounded canonical hexadecimal data.')
  }
  if (options !== undefined) {
    if (!isRecord(options)) invalidParams('Pearl PSBT signing options are invalid.')
    if (Object.keys(options).some(key => key !== 'autoFinalized')) {
      invalidParams('Pearl PSBT signing options contain unsupported fields.')
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

export function parsePearlPsbtsRequest(
  params: readonly unknown[] | undefined
): readonly ParsedPearlPsbtRequest[] {
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
      parsePearlPsbtRequest([
        psbtHex,
        ...(options === undefined || options[index] === undefined ? [] : [options[index]])
      ])
    )
  )
}

export function parsePearlPushPsbtRequest(
  params: readonly unknown[] | undefined
): ParsedPearlPsbtRequest {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('pushPsbt requires one hexadecimal PSBT.')
  }
  return parsePearlPsbtRequest(params)
}

export function parsePearlPushTransactionRequest(params: readonly unknown[] | undefined): string {
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
    invalidParams('Pearl raw transaction must be bounded hexadecimal data.')
  }
  return rawTransactionHex.toLowerCase()
}

export function parsePearlNetworkRequest(
  params: readonly unknown[] | undefined
): 'mainnet' | 'testnet' {
  if (
    !Array.isArray(params) ||
    params.length !== 1 ||
    (params[0] !== 'mainnet' && params[0] !== 'testnet')
  ) {
    invalidParams('Pearl network must be mainnet or testnet.')
  }
  return params[0]
}

export function parsePearlChainRequest(
  params: readonly unknown[] | undefined
): 'PEARL_MAINNET' | 'PEARL_TESTNET' {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('A Pearl chain object is required.')
  }
  const value = params[0]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidParams('A Pearl chain object is required.')
  }
  const keys = Object.keys(value)
  const enumValue = Reflect.get(value, 'enum')
  if (
    keys.length !== 1 ||
    keys[0] !== 'enum' ||
    (enumValue !== 'PEARL_MAINNET' && enumValue !== 'PEARL_TESTNET')
  ) {
    invalidParams('Pearl chain enum is invalid.')
  }
  return enumValue
}
