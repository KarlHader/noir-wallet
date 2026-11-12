import { parseQuantusAddress } from '@/core/chains/quantus'

export const QUANTUS_DAPP_RUNTIME_METHODS = Object.freeze([
  'connect',
  'requestAccounts',
  'getAccounts',
  'getNetwork',
  'getChain',
  'getPublicKey',
  'getBalance',
  'sendQuantus',
  'signQuantusTransfer',
  'broadcastExtrinsic',
  'switchNetwork',
  'switchChain',
  'disconnect'
] as const)

export type QuantusDAppRuntimeMethod = (typeof QUANTUS_DAPP_RUNTIME_METHODS)[number]

export type QuantusProviderErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32602 | -32603

export interface QuantusProviderErrorShape {
  readonly code: QuantusProviderErrorCode
  readonly message: string
}

export class QuantusProviderError extends Error {
  readonly code: QuantusProviderErrorCode

  constructor(code: QuantusProviderErrorCode, message: string) {
    super(message)
    this.name = 'QuantusProviderError'
    this.code = code
  }
}

export function toQuantusProviderErrorShape(error: unknown): QuantusProviderErrorShape {
  if (error instanceof QuantusProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return Object.freeze({ code: -32603, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

function invalidParams(message: string): never {
  throw new QuantusProviderError(-32602, message)
}

export function parseQuantusNoParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    invalidParams('This method does not accept parameters.')
  }
}

export function parseQuantusNetworkRequest(
  params: readonly unknown[] | undefined
): 'mainnet' | 'testnet' {
  if (
    !Array.isArray(params) ||
    params.length !== 1 ||
    (params[0] !== 'mainnet' && params[0] !== 'testnet')
  ) {
    invalidParams('Quantus network must be mainnet or testnet.')
  }
  return params[0]
}

export function parseQuantusChainRequest(
  params: readonly unknown[] | undefined
): 'QUANTUS_MAINNET' | 'QUANTUS_PLANCK' {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('A Quantus chain object is required.')
  }
  const value = params[0]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidParams('A Quantus chain object is required.')
  }
  const keys = Object.keys(value)
  const enumValue = Reflect.get(value, 'enum')
  if (
    keys.length !== 1 ||
    keys[0] !== 'enum' ||
    (enumValue !== 'QUANTUS_MAINNET' && enumValue !== 'QUANTUS_PLANCK')
  ) {
    invalidParams('Quantus chain enum is invalid.')
  }
  return enumValue
}

export interface ParsedQuantusSendRequest {
  readonly recipient: string
  readonly amountRaw: string
}

const MAXIMUM_U128 = (1n << 128n) - 1n
const MAXIMUM_U128_DECIMAL_DIGITS = MAXIMUM_U128.toString().length

/**
 * Parses the reviewed native transfer a dApp can request, for both `sendQuantus`
 * and the sign-only `signQuantusTransfer`. Only the recipient and the 12-decimal
 * base-unit amount are accepted: nonce, fee, era, signer, RPC and chain selection
 * stay with the wallet, and keep-alive is fixed to the safe value.
 */
export function parseQuantusSendRequest(
  params: readonly unknown[] | undefined
): ParsedQuantusSendRequest {
  if (!Array.isArray(params) || params.length !== 2) {
    invalidParams('sendQuantus requires a recipient and a positive u128 amountRaw string.')
  }
  const [recipient, amountRaw] = params
  if (typeof recipient !== 'string') {
    invalidParams('Quantus recipient is invalid.')
  }
  if (
    typeof amountRaw !== 'string' ||
    amountRaw.length > MAXIMUM_U128_DECIMAL_DIGITS ||
    !/^[1-9][0-9]*$/.test(amountRaw) ||
    BigInt(amountRaw) > MAXIMUM_U128
  ) {
    invalidParams('Quantus amountRaw must be a canonical positive u128 decimal string.')
  }
  try {
    return Object.freeze({
      recipient: parseQuantusAddress(recipient, 'Quantus recipient'),
      amountRaw
    })
  } catch {
    invalidParams('Quantus recipient must be a valid SS58-189 address.')
  }
}

/** The dApp bridge accepts at most 256 KiB of string data per request. */
export const MAX_QUANTUS_DAPP_EXTRINSIC_HEX_CHARS = 256 * 1024

/**
 * Validates the signed Substrate extrinsic envelope, not its call or signature.
 * The RPC still decides whether the extrinsic is valid for the selected chain.
 */
export function parseQuantusBroadcastExtrinsicRequest(
  params: readonly unknown[] | undefined
): string {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== 'string') {
    invalidParams('broadcastExtrinsic requires one signed extrinsic hex string.')
  }
  const extrinsicHex = params[0]
  if (
    extrinsicHex.length < 6 ||
    extrinsicHex.length > MAX_QUANTUS_DAPP_EXTRINSIC_HEX_CHARS ||
    extrinsicHex.length % 2 !== 0 ||
    !/^0x[0-9a-fA-F]+$/.test(extrinsicHex)
  ) {
    invalidParams('Quantus extrinsic must be bounded 0x-prefixed hexadecimal data.')
  }
  const bytes = Uint8Array.from(extrinsicHex.slice(2).match(/../g) ?? [], byte =>
    Number.parseInt(byte, 16)
  )
  const first = bytes[0]
  let bodyLength: number
  let headerLength: number
  switch (first & 3) {
    case 0:
      bodyLength = first >>> 2
      headerLength = 1
      break
    case 1:
      if (bytes.length < 2) invalidParams('Quantus extrinsic length is invalid.')
      bodyLength = (first >>> 2) | (bytes[1] << 6)
      headerLength = 2
      if (bodyLength < 64) invalidParams('Quantus extrinsic length is not canonical.')
      break
    case 2:
      if (bytes.length < 4) invalidParams('Quantus extrinsic length is invalid.')
      bodyLength = ((first >>> 2) | (bytes[1] << 6) | (bytes[2] << 14) | (bytes[3] << 22)) >>> 0
      headerLength = 4
      if (bodyLength < 16_384) invalidParams('Quantus extrinsic length is not canonical.')
      break
    default:
      invalidParams('Quantus extrinsic length is unsupported.')
  }
  if (
    bodyLength !== bytes.length - headerLength ||
    bodyLength < 2 ||
    (bytes[headerLength] !== 0x84 && bytes[headerLength] !== 0x85)
  ) {
    invalidParams('Quantus extrinsic must have a signed, supported SCALE envelope.')
  }
  return extrinsicHex.toLowerCase()
}
