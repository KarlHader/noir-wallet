import { getDashNetworkConfig } from '@/config/networks'
import type { ChainId } from '@/core/chains/domain'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type { Network as BitcoinJsNetwork } from 'bitcoinjs-lib'
import {
  DASH_MAX_LEGACY_TX_BYTES,
  DASH_MAX_MONEY_DUFFS,
  DASH_MAX_RELAY_FEE_DUFFS_PER_KB,
  DASH_MIN_RELAY_FEE_DUFFS_PER_KB,
  dashP2pkhDustDuffs,
  estimateDashLegacyFeeDuffs
} from './config'
import { parseDashP2pkhAddress } from './dash-discovery-model'

export const DASH_MAXIMUM_SELECTION_UTXOS = 1_000
export const DASH_FINAL_SEQUENCE = 0xffffffff
export const DASH_SIGHASH_ALL = 0x01
export const DASH_CLASSIC_TRANSACTION_TYPE = 0
export const DASH_CLASSIC_TRANSACTION_VERSION = 2
export const DASH_REQUIRED_CONFIRMATIONS = 6

export const DASH_TRANSACTION_BUILD_ERROR_CODES = Object.freeze([
  'invalid-intent',
  'invalid-signed-transaction',
  'insufficient-funds',
  'broadcast-rejected',
  'capacity-exceeded'
] as const)

export type DashTransactionBuildErrorCode = (typeof DASH_TRANSACTION_BUILD_ERROR_CODES)[number]

export class DashTransactionBuildError extends Error {
  readonly code: DashTransactionBuildErrorCode

  constructor(code: DashTransactionBuildErrorCode, message: string) {
    super(message)
    this.name = 'DashTransactionBuildError'
    this.code = code
  }
}

export interface DashSelectableUtxo {
  readonly chainId: string
  readonly accountIndex: number
  readonly imported: boolean
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly scriptHex: string
  readonly transactionId: string
  readonly outputIndex: number
  readonly valueDuffs: string
  readonly rawTransactionHex: string
}

export type DashTransferAmount =
  | Readonly<{ mode: 'exact'; valueDuffs: string }>
  | Readonly<{ mode: 'max' }>

export interface DashTransferIntent {
  readonly recipient: string
  readonly amount: DashTransferAmount
}

export interface SelectDashCoinsInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly imported: boolean
  readonly recipient: string
  readonly amount: DashTransferAmount
  readonly feeRateDuffsPerKb: bigint
  readonly utxos: readonly DashSelectableUtxo[]
}

export interface DashCoinSelection {
  readonly chainId: string
  readonly accountIndex: number
  readonly imported: boolean
  readonly recipient: string
  readonly selectedUtxos: readonly DashSelectableUtxo[]
  readonly selectedTotalDuffs: string
  readonly amountDuffs: string
  readonly feeDuffs: string
  readonly changeDuffs: string
  readonly legacyBytes: number
  readonly feeRateDuffsPerKb: string
}

export interface PreparedDashPsbt {
  readonly schemaVersion: 1
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly imported: boolean
  readonly psbtBase64: string
  readonly unsignedTransactionId: string
  readonly transactionVersion: typeof DASH_CLASSIC_TRANSACTION_VERSION
  readonly transactionType: typeof DASH_CLASSIC_TRANSACTION_TYPE
  readonly lockTime: number
  readonly sighash: 'SIGHASH_ALL'
  readonly inputCount: number
  readonly outputCount: number
  readonly recipient: string
  readonly recipientOutputIndex: number
  readonly changeAddress: string | null
  readonly changeDerivationPath: string | null
  readonly changeOutputIndex: number | null
  readonly selectedTotalDuffs: string
  readonly amountDuffs: string
  readonly feeDuffs: string
  readonly changeDuffs: string
  readonly legacyBytes: number
  readonly feeRateDuffsPerKb: string
}

export interface FinalizeDashPsbtInput {
  readonly prepared: PreparedDashPsbt
  readonly signedPsbtBase64: string
}

export interface FinalizedDashTransaction {
  readonly transactionId: string
  readonly rawTransactionHex: string
  readonly finalizedPsbtBase64: string
  readonly legacyBytes: number
  readonly feeDuffs: string
}

export function failInvalidDashTransaction(message: string): never {
  throw new DashTransactionBuildError('invalid-intent', message)
}

export function failInvalidSignedDashTransaction(message: string): never {
  throw new DashTransactionBuildError('invalid-signed-transaction', message)
}

export function parseDashChain(value: unknown): ChainId {
  if (value !== DASH_CHAIN_IDS.mainnet && value !== DASH_CHAIN_IDS.testnet) {
    failInvalidDashTransaction('Unsupported Dash chain')
  }
  return value as ChainId
}

export function dashBitcoinJsNetwork(chainId: string): BitcoinJsNetwork {
  const parsed = parseDashChain(chainId)
  const config = getDashNetworkConfig(parsed === DASH_CHAIN_IDS.mainnet ? 'mainnet' : 'testnet')
  return Object.freeze({
    messagePrefix: '\u0019Dash Signed Message:\n',
    // PSBT construction must not use bech32; Dash spends are P2PKH.
    bech32: 'dash',
    pubKeyHash: config.p2pkhVersion,
    scriptHash: config.p2shVersion,
    wif: config.wifVersion,
    bip32:
      parsed === DASH_CHAIN_IDS.mainnet
        ? Object.freeze({ public: 0x02fe52cc, private: 0x02fe52f8 })
        : Object.freeze({ public: 0x3a805837, private: 0x3a8061b0 })
  })
}

export function parseDashIndex(value: unknown, label: string, maximum = 0x7fffffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    failInvalidDashTransaction(`Invalid ${label}`)
  }
  return value as number
}

export function parseDashDuffs(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    failInvalidDashTransaction(`Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > DASH_MAX_MONEY_DUFFS) failInvalidDashTransaction(`Invalid ${label}`)
  return amount
}

export function parseDashFeeRate(value: unknown): bigint {
  if (typeof value !== 'bigint' && typeof value !== 'string') {
    failInvalidDashTransaction('Invalid Dash fee rate')
  }
  const rate = typeof value === 'bigint' ? value : parseDashDuffs(value, 'Dash fee rate')
  if (rate < DASH_MIN_RELAY_FEE_DUFFS_PER_KB || rate > DASH_MAX_RELAY_FEE_DUFFS_PER_KB) {
    failInvalidDashTransaction('Invalid Dash fee rate')
  }
  return rate
}

export function parseDashPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(value)) {
    failInvalidDashTransaction('Invalid Dash public key')
  }
  return value
}

export function parseDashMasterFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    failInvalidDashTransaction('Invalid Dash master fingerprint')
  }
  return value
}

export function parseDashRecipient(value: unknown, chainId: string): string {
  try {
    return parseDashP2pkhAddress(typeof value === 'string' ? value : '', chainId)
  } catch {
    return failInvalidDashTransaction('Invalid Dash address')
  }
}

export function dashVarIntBytes(count: number): number {
  if (count < 0xfd) return 1
  if (count <= 0xffff) return 3
  return 5
}

/** Signed classic P2PKH size: version, inputs, outputs, locktime. No witness discount. */
export function estimateDashSignedLegacyBytes(inputCount: number, outputCount: number): number {
  if (
    !Number.isSafeInteger(inputCount) ||
    !Number.isSafeInteger(outputCount) ||
    inputCount <= 0 ||
    outputCount <= 0 ||
    inputCount > DASH_MAXIMUM_SELECTION_UTXOS ||
    outputCount > 2
  ) {
    failInvalidDashTransaction('Invalid Dash transaction size')
  }
  const bytes =
    4 +
    dashVarIntBytes(inputCount) +
    inputCount * 148 +
    dashVarIntBytes(outputCount) +
    outputCount * 34 +
    4
  if (bytes > DASH_MAX_LEGACY_TX_BYTES) failInvalidDashTransaction('Invalid Dash transaction size')
  return bytes
}

export function dashFeeForSelection(
  inputCount: number,
  outputCount: number,
  feeRateDuffsPerKb: bigint
): { readonly legacyBytes: number; readonly feeDuffs: bigint } {
  const legacyBytes = estimateDashSignedLegacyBytes(inputCount, outputCount)
  return Object.freeze({
    legacyBytes,
    feeDuffs: estimateDashLegacyFeeDuffs(legacyBytes, feeRateDuffsPerKb)
  })
}

export function dashDustDuffs(feeRateDuffsPerKb: bigint): bigint {
  return dashP2pkhDustDuffs(parseDashFeeRate(feeRateDuffsPerKb))
}

export function expectedDashDerivationPath(
  chainId: string,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported: boolean
): string {
  if (imported) {
    if (accountIndex !== 0 || change || addressIndex !== 0) {
      failInvalidDashTransaction('Imported Dash key path is invalid')
    }
    return 'm'
  }
  const coinType = getDashNetworkConfig(
    chainId === DASH_CHAIN_IDS.mainnet ? 'mainnet' : 'testnet'
  ).coinType
  return `m/44'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
}

export function parseDashTransferAmount(value: unknown): DashTransferAmount {
  if (!isPlainRecord(value)) failInvalidDashTransaction('Invalid Dash transfer amount')
  const keys = Object.keys(value)
  if (value.mode === 'max' && keys.length === 1) return Object.freeze({ mode: 'max' })
  if (
    value.mode !== 'exact' ||
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'valueDuffs')
  ) {
    failInvalidDashTransaction('Invalid Dash transfer amount')
  }
  return Object.freeze({
    mode: 'exact',
    valueDuffs: parseDashDuffs(value.valueDuffs, 'Dash transfer amount').toString()
  })
}

export function parseDashTransferIntent(value: unknown, chainIdValue: unknown): DashTransferIntent {
  const chainId = parseDashChain(chainIdValue)
  if (!isPlainRecord(value) || Object.keys(value).length !== 2) {
    failInvalidDashTransaction('Invalid Dash transfer intent')
  }
  return Object.freeze({
    recipient: parseDashRecipient(value.recipient, chainId),
    amount: parseDashTransferAmount(value.amount)
  })
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
