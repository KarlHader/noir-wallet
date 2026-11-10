import type { DerivedPearlAddress } from '@/core/chains/pearl'
import type { ChainId } from '@/core/chains/domain'
import { parseSupportedPearlAddress } from '@/core/chains/pearl'
import { getPearlChainId } from '@/core/chains/registry'

export const PEARL_DEFAULT_FEE_TARGET_BLOCKS = 6
export const PEARL_MAXIMUM_FEE_TARGET_BLOCKS = 1_008
export const PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE = 10_000
export const PEARL_MAXIMUM_SELECTION_UTXOS = 1_000
export const PEARL_MAXIMUM_MONEY_SATS = 2_100_000_000_000_000n

export const PEARL_MAINNET_CHAIN_ID = getPearlChainId('mainnet')
export const PEARL_TESTNET_CHAIN_ID = getPearlChainId('testnet')

export type PearlAddressScheme = 'pearl_p2tr'

export const PEARL_TRANSACTION_BUILD_ERROR_CODES = Object.freeze([
  'invalid-intent',
  'invalid-signed-transaction',
  'fee-estimate-unavailable',
  'insufficient-funds',
  'capacity-exceeded'
] as const)

export type PearlTransactionBuildErrorCode = (typeof PEARL_TRANSACTION_BUILD_ERROR_CODES)[number]

export class PearlTransactionBuildError extends Error {
  readonly code: PearlTransactionBuildErrorCode

  constructor(code: PearlTransactionBuildErrorCode, message: string) {
    super(message)
    this.name = 'PearlTransactionBuildError'
    this.code = code
  }
}

export interface PearlFeeRateQuote {
  readonly requestedTargetBlocks: number
  readonly sourceTargetBlocks: number
  readonly satsPerVbyte: number
}

export interface PearlSpendableUtxo {
  readonly chainId: ChainId
  readonly addressScheme: PearlAddressScheme
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

export type PearlTransferAmount =
  | Readonly<{ mode: 'exact'; valueSats: string }>
  | Readonly<{ mode: 'max' }>

export interface PearlTransferIntent {
  readonly recipient: string
  readonly amount: PearlTransferAmount
}

export interface SelectPearlCoinsInput {
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly recipient: string
  readonly amount: PearlTransferAmount
  readonly feeRateSatsPerVbyte: number
  readonly utxos: readonly PearlSpendableUtxo[]
}

export interface PearlCoinSelection {
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly recipient: string
  readonly selectedUtxos: readonly PearlSpendableUtxo[]
  readonly selectedTotalSats: string
  readonly amountSats: string
  readonly feeSats: string
  readonly changeSats: string
  readonly estimatedVbytes: number
  readonly feeRateSatsPerVbyte: number
}

export type PearlChangeOutputPosition = 'first' | 'last'

type BuildPearlPsbtCommon = Readonly<{
  selection: PearlCoinSelection
  masterFingerprint: string
  lockTime: number
}>

export type BuildPearlPsbtInput = BuildPearlPsbtCommon &
  (
    | Readonly<{
        change?: never
      }>
    | Readonly<{
        change: Readonly<{
          address: DerivedPearlAddress
          outputPosition: PearlChangeOutputPosition
        }>
      }>
  )

export interface PreparedPearlPsbt {
  readonly schemaVersion: 1
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly addressScheme: PearlAddressScheme
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

export interface FinalizePearlPsbtInput {
  readonly prepared: PreparedPearlPsbt
  readonly signedPsbtBase64: string
}

export interface FinalizedPearlTransaction {
  readonly transactionId: string
  readonly rawTransactionHex: string
  readonly finalizedPsbtBase64: string
  readonly vbytes: number
  readonly feeSats: string
  readonly feeRateSatsPerVbyte: number
}

export function failInvalidPearlTransaction(message: string): never {
  throw new PearlTransactionBuildError('invalid-intent', message)
}

export function failInvalidSignedPearlTransaction(message: string): never {
  throw new PearlTransactionBuildError('invalid-signed-transaction', message)
}

export function parsePearlIndex(value: unknown, label: string, maximum = 0x7fffffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    failInvalidPearlTransaction(`Invalid ${label}`)
  }
  return value as number
}

export function parsePearlChain(value: unknown): ChainId {
  if (value !== PEARL_MAINNET_CHAIN_ID && value !== PEARL_TESTNET_CHAIN_ID) {
    failInvalidPearlTransaction('Unsupported Pearl chain')
  }
  return value as ChainId
}

export function parsePearlAddress(value: unknown, chainId: ChainId): string {
  try {
    return parseSupportedPearlAddress(String(value), chainId)
  } catch {
    return failInvalidPearlTransaction('Invalid Pearl address')
  }
}

export function parsePearlAmount(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) {
    failInvalidPearlTransaction(`Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > PEARL_MAXIMUM_MONEY_SATS) {
    failInvalidPearlTransaction(`Invalid ${label}`)
  }
  return amount
}

export function parsePearlFeeRate(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE
  ) {
    failInvalidPearlTransaction('Invalid Pearl fee rate')
  }
  return value as number
}

export function parsePearlPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(value)) {
    failInvalidPearlTransaction('Invalid Pearl public key')
  }
  return value
}

export function parsePearlMasterFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    failInvalidPearlTransaction('Invalid Pearl master fingerprint')
  }
  return value
}

export function expectedPearlDerivationPath(
  chainId: ChainId,
  accountIndex: number,
  change: boolean,
  addressIndex: number
): string {
  const coinType = chainId === PEARL_MAINNET_CHAIN_ID ? 808276 : 1
  return `m/86'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
}

export function pearlAccountRootFromPath(
  path: string,
  chainId: ChainId,
  change: boolean,
  addressIndex: number
): string {
  const expected = expectedPearlDerivationPath(chainId, 0, change, addressIndex)
  const prefix = expected.split('/').slice(0, 3).join('/')
  const match = new RegExp(`^${prefix}/(0|[1-9][0-9]*)'/${change ? 1 : 0}/${addressIndex}$`).exec(
    path
  )
  if (!match || Number(match[1]) > 0x7fffffff) {
    failInvalidPearlTransaction('Invalid Pearl derivation path')
  }
  return path.split('/').slice(0, 4).join('/')
}

/** P2TR dust threshold (same class as Bitcoin BIP-86). */
export function pearlDustSats(): bigint {
  return 330n
}

/** Key-path P2TR input ~57.5 vB → 58; output 43; overhead 11. */
export function estimatePearlVbytes(inputCount: number, includeChange: boolean): bigint {
  return 11n + BigInt(inputCount) * 58n + 43n + (includeChange ? 43n : 0n)
}

export function parsePearlTransferAmount(value: unknown): PearlTransferAmount {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    failInvalidPearlTransaction('Invalid Pearl transfer amount')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.mode === 'max' && keys.length === 1) return Object.freeze({ mode: 'max' })
  if (
    record.mode !== 'exact' ||
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, 'valueSats')
  ) {
    failInvalidPearlTransaction('Invalid Pearl transfer amount')
  }
  return Object.freeze({
    mode: 'exact',
    valueSats: parsePearlAmount(record.valueSats, 'Pearl transfer amount').toString()
  })
}

export function parsePearlTransferIntent(
  value: unknown,
  chainIdValue: unknown
): PearlTransferIntent {
  const chainId = parsePearlChain(chainIdValue)
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    failInvalidPearlTransaction('Invalid Pearl transfer intent')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, 'recipient') ||
    !Object.prototype.hasOwnProperty.call(record, 'amount')
  ) {
    failInvalidPearlTransaction('Invalid Pearl transfer intent')
  }
  return Object.freeze({
    recipient: parsePearlAddress(record.recipient, chainId),
    amount: parsePearlTransferAmount(record.amount)
  })
}
