import { parseNearAccountId, parseNearBase58, parseNearPublicKey } from '@/core/chains/near'

import {
  NearRpcError,
  type NearAccessKeyPermission,
  type NearAccountSnapshot,
  type NearAccessKeySnapshot,
  type NearFinalBlockSnapshot,
  type NearFungibleTokenBalanceSnapshot,
  type NearGasCostComponents,
  type NearNativeTransferCostConfig
} from './near-rpc-types'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const MAXIMUM_METHOD_NAMES = 128
const MAXIMUM_VIEW_RESULT_BYTES = 1_024

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
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

function invalid(label: string): NearRpcError {
  return new NearRpcError('invalid-response', `Invalid ${label}`)
}

export function readNearAccountId(value: unknown, label: string): string {
  try {
    return parseNearAccountId(value, label)
  } catch {
    throw invalid(label)
  }
}

export function readNearPublicKey(value: unknown, label: string): string {
  try {
    return parseNearPublicKey(value, label)
  } catch {
    throw invalid(label)
  }
}

export function readNearHash(value: unknown, label: string): string {
  try {
    return parseNearBase58(value, 32, label)
  } catch {
    throw invalid(label)
  }
}

export function readSafeUnsignedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(label)
  return value as number
}

export function readUnsignedDecimal(value: unknown, maximum: bigint, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum.toString().length ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > maximum
  ) {
    throw invalid(label)
  }
  return value
}

export function readU128(value: unknown, label: string): string {
  return readUnsignedDecimal(value, MAXIMUM_U128, label)
}

export function readU64String(value: unknown, label: string): string {
  if (typeof value === 'number') return readSafeUnsignedInteger(value, label).toString()
  return readUnsignedDecimal(value, MAXIMUM_U64, label)
}

function readLogs(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw invalid(label)
  return Object.freeze(
    value.map(entry => {
      if (typeof entry !== 'string' || entry.length > 4_096) throw invalid(label)
      return entry
    })
  )
}

export function isNearAccessKeyMissingResult(value: unknown, publicKey: string): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['block_hash', 'block_height', 'error', 'logs']) ||
    value.error !== `access key ${publicKey} does not exist while viewing`
  ) {
    return false
  }
  readNearHash(value.block_hash, 'NEAR query block hash')
  readSafeUnsignedInteger(value.block_height, 'NEAR query block height')
  readLogs(value.logs, 'NEAR query logs')
  return true
}

export function parseNearAccountSnapshot(value: unknown, accountId: string): NearAccountSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['amount', 'block_hash', 'block_height', 'code_hash', 'locked', 'storage_usage'],
      ['global_contract_account_id', 'global_contract_hash', 'storage_paid_at']
    )
  ) {
    throw invalid('NEAR account response')
  }
  if (
    value.storage_paid_at !== undefined &&
    value.storage_paid_at !== null &&
    !Number.isSafeInteger(value.storage_paid_at)
  ) {
    throw invalid('NEAR account storage paid at')
  }
  if (value.global_contract_account_id !== undefined && value.global_contract_account_id !== null) {
    readNearAccountId(value.global_contract_account_id, 'NEAR global contract account ID')
  }
  if (value.global_contract_hash !== undefined && value.global_contract_hash !== null) {
    readNearHash(value.global_contract_hash, 'NEAR global contract hash')
  }
  return Object.freeze({
    accountId,
    amountRaw: readU128(value.amount, 'NEAR account amount'),
    lockedRaw: readU128(value.locked, 'NEAR account locked amount'),
    storageUsage: readSafeUnsignedInteger(value.storage_usage, 'NEAR account storage usage'),
    codeHash: readNearHash(value.code_hash, 'NEAR account code hash'),
    blockHash: readNearHash(value.block_hash, 'NEAR account block hash'),
    blockHeight: readSafeUnsignedInteger(value.block_height, 'NEAR account block height')
  })
}

function parseNearAccessKeyPermission(value: unknown): NearAccessKeyPermission {
  if (value === 'FullAccess') return Object.freeze({ kind: 'full-access' })
  if (!isRecord(value) || !hasExactKeys(value, ['FunctionCall'])) {
    throw invalid('NEAR access key permission')
  }
  const functionCall = value.FunctionCall
  if (
    !isRecord(functionCall) ||
    !hasExactKeys(functionCall, ['allowance', 'method_names', 'receiver_id']) ||
    (functionCall.allowance !== null && typeof functionCall.allowance !== 'string') ||
    !Array.isArray(functionCall.method_names) ||
    functionCall.method_names.length > MAXIMUM_METHOD_NAMES
  ) {
    throw invalid('NEAR function-call access key permission')
  }
  const methodNames = functionCall.method_names.map(methodName => {
    if (typeof methodName !== 'string' || methodName.length === 0 || methodName.length > 256) {
      throw invalid('NEAR access key method name')
    }
    return methodName
  })
  if (new Set(methodNames).size !== methodNames.length) {
    throw invalid('NEAR access key method names')
  }
  return Object.freeze({
    kind: 'function-call',
    allowanceRaw:
      functionCall.allowance === null
        ? null
        : readU128(functionCall.allowance, 'NEAR access key allowance'),
    receiverId: readNearAccountId(functionCall.receiver_id, 'NEAR access key receiver ID'),
    methodNames: Object.freeze(methodNames)
  })
}

export function parseNearAccessKeySnapshot(
  value: unknown,
  accountId: string,
  publicKey: string
): NearAccessKeySnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['block_hash', 'block_height', 'nonce', 'permission'])
  ) {
    throw invalid('NEAR access key response')
  }
  return Object.freeze({
    accountId,
    publicKey,
    nonce: readU64String(value.nonce, 'NEAR access key nonce'),
    permission: parseNearAccessKeyPermission(value.permission),
    blockHash: readNearHash(value.block_hash, 'NEAR access key block hash'),
    blockHeight: readSafeUnsignedInteger(value.block_height, 'NEAR access key block height')
  })
}

export function parseNearFinalBlock(value: unknown): NearFinalBlockSnapshot {
  if (!isRecord(value) || !isRecord(value.header)) throw invalid('NEAR final block response')
  const header = value.header
  return Object.freeze({
    hash: readNearHash(header.hash, 'NEAR final block hash'),
    height: readSafeUnsignedInteger(header.height, 'NEAR final block height'),
    timestampNanosec: readU64String(
      header.timestamp_nanosec,
      'NEAR final block timestamp nanoseconds'
    ),
    gasPriceRaw: readU128(header.gas_price, 'NEAR final block gas price')
  })
}

function parseGasCostComponents(value: unknown, label: string): NearGasCostComponents {
  if (!isRecord(value) || !hasExactKeys(value, ['execution', 'send_not_sir', 'send_sir'])) {
    throw invalid(label)
  }
  return Object.freeze({
    executionGas: readU64String(value.execution, `${label} execution gas`),
    sendNotSirGas: readU64String(value.send_not_sir, `${label} non-self send gas`),
    sendSirGas: readU64String(value.send_sir, `${label} self send gas`)
  })
}

export function parseNearNativeTransferCostConfig(
  value: unknown,
  expectedChainId: string
): NearNativeTransferCostConfig {
  if (
    !isRecord(value) ||
    typeof value.chain_id !== 'string' ||
    !isRecord(value.runtime_config) ||
    !isRecord(value.runtime_config.transaction_costs) ||
    !isRecord(value.runtime_config.transaction_costs.action_creation_config)
  ) {
    throw invalid('NEAR protocol configuration response')
  }
  if (value.chain_id !== expectedChainId) {
    throw new NearRpcError('chain-mismatch', 'NEAR RPC endpoint returned the wrong chain')
  }
  const transactionCosts = value.runtime_config.transaction_costs
  const actionCreationConfig = transactionCosts.action_creation_config
  if (!isRecord(actionCreationConfig)) {
    throw invalid('NEAR action creation configuration')
  }
  return Object.freeze({
    chainId: expectedChainId,
    minGasPurchasePriceRaw: readU128(
      value.runtime_config.min_gas_purchase_price,
      'NEAR minimum gas purchase price'
    ),
    storageAmountPerByteRaw: readU128(
      value.runtime_config.storage_amount_per_byte,
      'NEAR storage amount per byte'
    ),
    actionReceiptCreation: parseGasCostComponents(
      transactionCosts.action_receipt_creation_config,
      'NEAR action receipt creation cost'
    ),
    transfer: parseGasCostComponents(
      actionCreationConfig.transfer_cost,
      'NEAR transfer action cost'
    )
  })
}

function decodeViewResult(value: unknown): string {
  if (!Array.isArray(value) || value.length > MAXIMUM_VIEW_RESULT_BYTES) {
    throw invalid('NEAR contract view result')
  }
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index]
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw invalid('NEAR contract view result byte')
    }
    bytes[index] = byte
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid('NEAR contract view result UTF-8')
  }
}

export function parseNearFungibleTokenBalance(
  value: unknown,
  contractId: string,
  accountId: string
): NearFungibleTokenBalanceSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['block_hash', 'block_height', 'logs', 'result'])) {
    throw invalid('NEAR fungible token balance response')
  }
  readLogs(value.logs, 'NEAR fungible token balance logs')
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeViewResult(value.result))
  } catch (error) {
    if (error instanceof NearRpcError) throw error
    throw invalid('NEAR fungible token balance value')
  }
  return Object.freeze({
    contractId,
    accountId,
    amountRaw: readU128(decoded, 'NEAR fungible token balance'),
    blockHash: readNearHash(value.block_hash, 'NEAR fungible token block hash'),
    blockHeight: readSafeUnsignedInteger(value.block_height, 'NEAR fungible token block height')
  })
}

export function parseNearFungibleTokenRegistration(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['block_hash', 'block_height', 'logs', 'result'])) {
    throw invalid('NEAR fungible token registration response')
  }
  readNearHash(value.block_hash, 'NEAR fungible token registration block hash')
  readSafeUnsignedInteger(value.block_height, 'NEAR fungible token registration block height')
  readLogs(value.logs, 'NEAR fungible token registration logs')
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeViewResult(value.result))
  } catch (error) {
    if (error instanceof NearRpcError) throw error
    throw invalid('NEAR fungible token registration value')
  }
  if (decoded === null) return false
  if (!isRecord(decoded)) throw invalid('NEAR fungible token registration value')
  return true
}

export function encodeNearFunctionArgs(value: Readonly<Record<string, unknown>>): string {
  const serialized = JSON.stringify(value)
  const bytes = new TextEncoder().encode(serialized)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
