import type { DerivedBitcoinAddress } from '@/core/chains/bitcoin'
import type { ChainId } from '@/core/chains/domain'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'

export const BITCOIN_DEFAULT_FEE_TARGET_BLOCKS = 6
export const BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS = 1_008
export const BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE = 10_000
export const BITCOIN_MAXIMUM_SELECTION_UTXOS = 1_000
export const BITCOIN_MAXIMUM_MONEY_SATS = 2_100_000_000_000_000n

export const BITCOIN_MAINNET_CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93'
export const BITCOIN_TESTNET_CHAIN_ID = 'bip122:000000000933ea01ad0ee984209779ba'

export const BITCOIN_TRANSACTION_BUILD_ERROR_CODES = Object.freeze([
  'invalid-intent',
  'invalid-signed-transaction',
  'fee-estimate-unavailable',
  'insufficient-funds',
  'capacity-exceeded'
] as const)

export type BitcoinTransactionBuildErrorCode =
  (typeof BITCOIN_TRANSACTION_BUILD_ERROR_CODES)[number]

export class BitcoinTransactionBuildError extends Error {
  readonly code: BitcoinTransactionBuildErrorCode

  constructor(code: BitcoinTransactionBuildErrorCode, message: string) {
    super(message)
    this.name = 'BitcoinTransactionBuildError'
    this.code = code
  }
}

export interface BitcoinFeeRateQuote {
  readonly requestedTargetBlocks: number
  readonly sourceTargetBlocks: number
  readonly satsPerVbyte: number
}

export interface BitcoinSpendableUtxo {
  readonly chainId: ChainId
  readonly addressType: BitcoinSupportedAddressType
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly transactionId: string
  readonly outputIndex: number
  readonly valueSats: string
  readonly blockHeight: number
}

export interface BitcoinPreviousTransaction {
  readonly transactionId: string
  readonly rawTransactionHex: string
}

export type BitcoinTransferAmount =
  | Readonly<{ mode: 'exact'; valueSats: string }>
  | Readonly<{ mode: 'max' }>

export interface BitcoinTransferIntent {
  readonly recipient: string
  readonly amount: BitcoinTransferAmount
}

export interface SelectBitcoinCoinsInput {
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly addressType: BitcoinSupportedAddressType
  readonly recipient: string
  readonly amount: BitcoinTransferAmount
  readonly feeRateSatsPerVbyte: number
  readonly utxos: readonly BitcoinSpendableUtxo[]
}

export interface BitcoinCoinSelection {
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly addressType: BitcoinSupportedAddressType
  readonly recipient: string
  readonly recipientAddressType: BitcoinSupportedAddressType
  readonly selectedUtxos: readonly BitcoinSpendableUtxo[]
  readonly selectedTotalSats: string
  readonly amountSats: string
  readonly feeSats: string
  readonly changeSats: string
  readonly estimatedVbytes: number
  readonly feeRateSatsPerVbyte: number
}

export type BitcoinChangeOutputPosition = 'first' | 'last'

type BuildBitcoinPsbtCommon = Readonly<{
  selection: BitcoinCoinSelection
  masterFingerprint: string
  lockTime: number
  previousTransactions?: readonly BitcoinPreviousTransaction[]
}>

export type BuildBitcoinPsbtInput = BuildBitcoinPsbtCommon &
  (
    | Readonly<{
        change?: never
      }>
    | Readonly<{
        change: Readonly<{
          address: DerivedBitcoinAddress
          outputPosition: BitcoinChangeOutputPosition
        }>
      }>
  )

export interface PreparedBitcoinPsbt {
  readonly schemaVersion: 1
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly addressType: BitcoinSupportedAddressType
  readonly psbtBase64: string
  readonly unsignedTransactionId: string
  readonly transactionVersion: 2
  readonly lockTime: number
  readonly rbf: true
  readonly inputCount: number
  readonly outputCount: number
  readonly recipient: string
  readonly recipientOutputIndex: number
  readonly changeAddress: string | null
  readonly changeOutputIndex: number | null
  readonly selectedTotalSats: string
  readonly amountSats: string
  readonly feeSats: string
  readonly changeSats: string
  readonly estimatedVbytes: number
  readonly feeRateSatsPerVbyte: number
}

export interface FinalizeBitcoinPsbtInput {
  readonly prepared: PreparedBitcoinPsbt
  readonly signedPsbtBase64: string
}

export interface FinalizedBitcoinTransaction {
  readonly transactionId: string
  readonly rawTransactionHex: string
  readonly finalizedPsbtBase64: string
  readonly vbytes: number
  readonly feeSats: string
  readonly feeRateSatsPerVbyte: number
}

export function failInvalidBitcoinTransaction(message: string): never {
  throw new BitcoinTransactionBuildError('invalid-intent', message)
}

export function failInvalidSignedBitcoinTransaction(message: string): never {
  throw new BitcoinTransactionBuildError('invalid-signed-transaction', message)
}

export function parseBitcoinIndex(value: unknown, label: string, maximum = 0x7fffffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    failInvalidBitcoinTransaction(`Invalid ${label}`)
  }
  return value as number
}

export function parseBitcoinChain(value: unknown): ChainId {
  if (value !== BITCOIN_MAINNET_CHAIN_ID && value !== BITCOIN_TESTNET_CHAIN_ID) {
    failInvalidBitcoinTransaction('Unsupported Bitcoin chain')
  }
  return value as ChainId
}

export function parseBitcoinAddressType(value: unknown): BitcoinSupportedAddressType {
  if (value !== 'p2pkh' && value !== 'p2sh-p2wpkh' && value !== 'p2wpkh' && value !== 'p2tr') {
    failInvalidBitcoinTransaction('Unsupported Bitcoin address type')
  }
  return value
}

export function detectBitcoinAddressType(
  value: unknown,
  chainId: ChainId
): BitcoinSupportedAddressType {
  for (const addressType of ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'] as const) {
    try {
      parseSupportedBitcoinAddress(value, chainId, addressType)
      return addressType
    } catch {
      // Continue through the four mutually exclusive address encodings.
    }
  }
  return failInvalidBitcoinTransaction('Invalid Bitcoin address')
}

export function parseBitcoinAddress(
  value: unknown,
  chainId: ChainId,
  addressType?: BitcoinSupportedAddressType
): string {
  try {
    return parseSupportedBitcoinAddress(value, chainId, addressType)
  } catch {
    return failInvalidBitcoinTransaction('Invalid Bitcoin address')
  }
}

export function parseBitcoinAmount(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) {
    failInvalidBitcoinTransaction(`Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > BITCOIN_MAXIMUM_MONEY_SATS) {
    failInvalidBitcoinTransaction(`Invalid ${label}`)
  }
  return amount
}

export function parseBitcoinFeeRate(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin fee rate')
  }
  return value as number
}

export function parseBitcoinPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(value)) {
    failInvalidBitcoinTransaction('Invalid Bitcoin public key')
  }
  return value
}

export function parseBitcoinMasterFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    failInvalidBitcoinTransaction('Invalid Bitcoin master fingerprint')
  }
  return value
}

export function expectedBitcoinDerivationPath(
  chainId: ChainId,
  addressType: BitcoinSupportedAddressType,
  accountIndex: number,
  change: boolean,
  addressIndex: number
): string {
  const purpose =
    addressType === 'p2pkh'
      ? 44
      : addressType === 'p2sh-p2wpkh'
        ? 49
        : addressType === 'p2wpkh'
          ? 84
          : 86
  const coinType = chainId === BITCOIN_MAINNET_CHAIN_ID ? 0 : 1
  return `m/${purpose}'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
}

export function bitcoinAccountRootFromPath(
  path: string,
  chainId: ChainId,
  addressType: BitcoinSupportedAddressType,
  change: boolean,
  addressIndex: number
): string {
  const expected = expectedBitcoinDerivationPath(chainId, addressType, 0, change, addressIndex)
  const prefix = expected.split('/').slice(0, 3).join('/')
  const match = new RegExp(`^${prefix}/(0|[1-9][0-9]*)'/${change ? 1 : 0}/${addressIndex}$`).exec(
    path
  )
  if (!match || Number(match[1]) > 0x7fffffff) {
    failInvalidBitcoinTransaction('Invalid Bitcoin derivation path')
  }
  return path.split('/').slice(0, 4).join('/')
}

export function bitcoinDustSats(addressType: BitcoinSupportedAddressType): bigint {
  switch (addressType) {
    case 'p2pkh':
      return 546n
    case 'p2sh-p2wpkh':
      return 540n
    case 'p2wpkh':
      return 294n
    case 'p2tr':
      return 330n
  }
}

export function estimateBitcoinVbytes(
  inputCount: number,
  inputType: BitcoinSupportedAddressType,
  recipientType: BitcoinSupportedAddressType,
  includeChange: boolean
): bigint {
  const inputVbytes =
    inputType === 'p2pkh'
      ? 150n
      : inputType === 'p2sh-p2wpkh'
        ? 92n
        : inputType === 'p2wpkh'
          ? 69n
          : 59n
  const outputVbytes = (addressType: BitcoinSupportedAddressType) =>
    addressType === 'p2pkh'
      ? 34n
      : addressType === 'p2sh-p2wpkh'
        ? 32n
        : addressType === 'p2wpkh'
          ? 31n
          : 43n
  const recipientVbytes = outputVbytes(recipientType)
  const changeVbytes = outputVbytes(inputType)
  return (
    11n + BigInt(inputCount) * inputVbytes + recipientVbytes + (includeChange ? changeVbytes : 0n)
  )
}

export function parseBitcoinTransferAmount(value: unknown): BitcoinTransferAmount {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin transfer amount')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.mode === 'max' && keys.length === 1) return Object.freeze({ mode: 'max' })
  if (
    record.mode !== 'exact' ||
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, 'valueSats')
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin transfer amount')
  }
  return Object.freeze({
    mode: 'exact',
    valueSats: parseBitcoinAmount(record.valueSats, 'Bitcoin transfer amount').toString()
  })
}

export function parseBitcoinTransferIntent(
  value: unknown,
  chainIdValue: unknown
): BitcoinTransferIntent {
  const chainId = parseBitcoinChain(chainIdValue)
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin transfer intent')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, 'recipient') ||
    !Object.prototype.hasOwnProperty.call(record, 'amount')
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin transfer intent')
  }
  return Object.freeze({
    recipient: parseBitcoinAddress(record.recipient, chainId),
    amount: parseBitcoinTransferAmount(record.amount)
  })
}
