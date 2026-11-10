import { isDashChainId } from '@/core/chains/registry/chain-ids'

export const DASH_DAPP_RUNTIME_METHODS = Object.freeze([
  'connect',
  'requestAccounts',
  'getAccounts',
  'getNetwork',
  'getChain',
  'getPublicKey',
  'getBalance',
  'sendDash',
  'signMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'disconnect'
] as const)

export type DashDAppRuntimeMethod = (typeof DASH_DAPP_RUNTIME_METHODS)[number]

/**
 * A closed `chain.dash` flag uses the same 4200 code as the other chain providers.
 * Keystone `signMessage` uses 4200. Ledger mainnet returns a base64 signature.
 * 4901 is reserved for a bip122 id that is not Dash.
 */
export const DASH_HARDWARE_SIGN_MESSAGE_CODE = 4200 as const
export const DASH_CHAIN_DISABLED_CODE = 4200 as const
export const DASH_CHAIN_MISMATCH_CODE = 4901 as const

export type DashProviderErrorCode =
  | 4001
  | 4100
  | typeof DASH_HARDWARE_SIGN_MESSAGE_CODE
  | 4900
  | typeof DASH_CHAIN_DISABLED_CODE
  | typeof DASH_CHAIN_MISMATCH_CODE
  | -32602
  | -32603

export interface DashProviderErrorShape {
  readonly code: DashProviderErrorCode
  readonly message: string
}

export class DashProviderError extends Error {
  readonly code: DashProviderErrorCode

  constructor(code: DashProviderErrorCode, message: string) {
    super(message)
    this.name = 'DashProviderError'
    this.code = code
  }
}

export function toDashProviderErrorShape(error: unknown): DashProviderErrorShape {
  if (error instanceof DashProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

export const DASH_INSUFFICIENT_TRANSFER_MESSAGE =
  'The active Dash account does not have enough spendable Dash for this transfer.'

const INSUFFICIENT_DASH_TRANSFER_MESSAGES = new Set([
  'No spendable Dash UTXOs',
  'Insufficient Dash funds'
])

/** Maps a pre-approval coin-selection failure. Other transfer errors stay with the caller. */
export function mapDashInsufficientTransferError(error: unknown): DashProviderError | null {
  if (!isInsufficientDashTransfer(error)) return null
  return new DashProviderError(-32603, DASH_INSUFFICIENT_TRANSFER_MESSAGE)
}

function isInsufficientDashTransfer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (Reflect.get(error, 'code') === 'insufficient-funds') return true
  return error instanceof Error && INSUFFICIENT_DASH_TRANSFER_MESSAGES.has(error.message)
}

export type DashDAppSigner = 'software' | 'private-key' | 'ledger' | 'keystone'

export interface DashReviewedPayment {
  readonly recipient: string
  readonly amountDuffs: string
  readonly payloadFingerprint: string
}

const CANONICAL_DUFF_STRING = /^(?:0|[1-9][0-9]*)$/
const MAX_DASH_DUFFS = 21_000_000n * 100_000_000n

function invalidParams(message: string): never {
  throw new DashProviderError(-32602, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertDashDAppEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new DashProviderError(
      DASH_CHAIN_DISABLED_CODE,
      'The Dash chain is not enabled in this wallet build.'
    )
  }
}

export function assertDashDAppChain(chainId: string): void {
  if (!isDashChainId(chainId)) {
    throw new DashProviderError(DASH_CHAIN_MISMATCH_CODE, 'This chain is not Dash.')
  }
}

export function parseDashDAppDuffs(value: unknown, label = 'Dash amount'): bigint {
  if (typeof value !== 'string' || value.includes('.') || !CANONICAL_DUFF_STRING.test(value)) {
    invalidParams(`${label} must be an integer number of duffs.`)
  }
  const amount = BigInt(value)
  if (amount > MAX_DASH_DUFFS) invalidParams(`${label} exceeds Dash max money.`)
  return amount
}

export function assertDashMessageSigningAllowed(signer: DashDAppSigner): void {
  if (signer === 'software' || signer === 'private-key') return
  throw new DashProviderError(
    DASH_HARDWARE_SIGN_MESSAGE_CODE,
    'Dash hardware message signing is unsupported'
  )
}

export function assertDashTransactionSigningAllowed(
  signer: DashDAppSigner,
  network: 'mainnet' | 'testnet'
): void {
  if (signer === 'keystone') {
    throw new DashProviderError(4200, 'Dash signing is unsupported for Keystone Wallets.')
  }
  if (signer !== 'software' && signer !== 'private-key' && network !== 'mainnet') {
    throw new DashProviderError(4200, 'Dash hardware wallets support mainnet only.')
  }
}

export function assertDashReviewedPaymentUnchanged(
  reviewed: DashReviewedPayment,
  current: DashReviewedPayment
): void {
  if (
    reviewed.recipient !== current.recipient ||
    reviewed.amountDuffs !== current.amountDuffs ||
    reviewed.payloadFingerprint !== current.payloadFingerprint
  ) {
    throw new DashProviderError(
      4100,
      'The reviewed Dash recipient or amount changed before signing.'
    )
  }
}

function assertNoParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    invalidParams('This method does not accept parameters.')
  }
}

export function parseDashNoParams(params: readonly unknown[] | undefined): void {
  assertNoParams(params)
}

export interface ParsedDashSendRequest {
  readonly recipient: string
  readonly amountDuffs: string
}

export function parseDashSendRequest(
  params: readonly unknown[] | undefined
): ParsedDashSendRequest {
  if (!Array.isArray(params) || params.length < 2 || params.length > 3) {
    invalidParams('sendDash requires a recipient and an integer duff amount.')
  }
  const [recipient, amount, options] = params
  if (typeof recipient !== 'string' || recipient.length === 0 || recipient.length > 128) {
    invalidParams('Dash recipient is invalid.')
  }
  const duffs = parseDashDAppDuffs(amount, 'Dash amount')
  if (duffs <= 0n) invalidParams('Dash amount must be a positive integer number of duffs.')
  if (options !== undefined) {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'feeRate')) {
      invalidParams('Dash send options contain unsupported fields.')
    }
    if (options.feeRate !== undefined) {
      invalidParams('Dash feeRate is estimated by the wallet. Omit feeRate.')
    }
  }
  return Object.freeze({ recipient, amountDuffs: duffs.toString() })
}

export interface ParsedDashMessageRequest {
  readonly message: Uint8Array
  readonly displayMessage: string
}

export function parseDashMessageRequest(
  params: readonly unknown[] | undefined
): ParsedDashMessageRequest {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== 'string') {
    invalidParams('signMessage requires one text message.')
  }
  const bytes = new TextEncoder().encode(params[0])
  if (bytes.length === 0 || bytes.length > 4 * 1024) {
    invalidParams('Dash message must contain between 1 and 4096 UTF-8 bytes.')
  }
  return Object.freeze({ message: bytes, displayMessage: params[0] })
}

export interface ParsedDashPsbtRequest {
  readonly psbtHex: string
  readonly autoFinalized: boolean
}

export function parseDashPsbtRequest(
  params: readonly unknown[] | undefined
): ParsedDashPsbtRequest {
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
    invalidParams('Dash PSBT must be bounded canonical hexadecimal data.')
  }
  if (options !== undefined) {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'autoFinalized')) {
      invalidParams('Dash PSBT signing options contain unsupported fields.')
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

export function parseDashPsbtsRequest(
  params: readonly unknown[] | undefined
): readonly ParsedDashPsbtRequest[] {
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
      parseDashPsbtRequest([
        psbtHex,
        ...(options === undefined || options[index] === undefined ? [] : [options[index]])
      ])
    )
  )
}

export function parseDashPushPsbtRequest(params: readonly unknown[] | undefined): string {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('pushPsbt requires one hexadecimal PSBT.')
  }
  return parseDashPsbtRequest(params).psbtHex
}

export function parseDashPushTransactionRequest(params: readonly unknown[] | undefined): string {
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
    invalidParams('Dash raw transaction must be bounded hexadecimal data.')
  }
  return rawTransactionHex.toLowerCase()
}
