import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { EvmTransactionSummary, SigningSummary } from '@/core/keyring/domain'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  parseAssetId,
  parseChainId,
  type AssetRegistry,
  type AssetRegistryEntry
} from '@/core/chains/registry'
import { parseEvmAccountBinding } from './evm-account'
import { deriveEvmFeeTierQuote, type EvmFeeSelection } from './evm-fee-tier'
import {
  EvmRpcError,
  type EvmBroadcastRpc,
  type EvmRpcCall,
  type EvmTransactionRpc
} from './evm-rpc-client'

const ETHEREUM_MAINNET_PRIORITY_FEE_FLOOR_WEI = 10_000_000n
const EVM_SIMPLE_TRANSFER_GAS = 21_000n
const EVM_DYNAMIC_GAS_MARGIN_BPS = 2_000n
const BASIS_POINTS = 10_000n

export const EVM_TRANSACTION_ERROR_CODES = Object.freeze([
  'invalid-intent',
  'insufficient-funds',
  'simulation-failed',
  'stale-nonce',
  'nonce-recovery-required',
  'fee-overflow'
] as const)

export type EvmTransactionErrorCode = (typeof EVM_TRANSACTION_ERROR_CODES)[number]

export interface EvmInsufficientFundsDetails {
  readonly requiredNativeBalanceRaw: string
  readonly availableNativeBalanceRaw: string
  readonly shortfallRaw: string
  readonly maximumGasCostRaw: string
  readonly transactionValueRaw: string
}

export class EvmTransactionError extends Error {
  readonly code: EvmTransactionErrorCode
  readonly insufficientFunds?: EvmInsufficientFundsDetails
  readonly rpcFailure?: Readonly<{ code?: number; method?: string }>

  constructor(
    code: EvmTransactionErrorCode,
    message: string,
    insufficientFunds?: EvmInsufficientFundsDetails,
    rpcFailure?: Readonly<{ code?: number; method?: string }>
  ) {
    super(message)
    this.name = 'EvmTransactionError'
    this.code = code
    this.insufficientFunds = insufficientFunds
    this.rpcFailure = rpcFailure
  }
}

export interface EvmTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

export interface EvmContractCallIntent {
  readonly chainId: ChainId
  readonly contractAddress: string
  readonly valueRaw: string
  readonly calldata: string
}

export interface EvmEip1559Transaction {
  readonly type: 'eip1559'
  readonly chainId: string
  readonly nonce: string
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  readonly gasLimit: string
  readonly to: string
  readonly value: string
  readonly input: string
  readonly accessList: readonly never[]
}

export interface PreparedEvmTransfer {
  readonly kind:
    | 'native-transfer'
    | 'erc20-transfer'
    | 'contract-call'
    | 'cancel'
    | 'nonce-recovery'
  readonly chainId: ChainId
  readonly addressIndex: number
  readonly from: string
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly observedBlockNumber: string
  readonly transaction: EvmEip1559Transaction
  readonly createdAt: number
}

export interface EvmSigningPreparePayload {
  readonly kind: 'evm-transaction' | 'pea-evm-transaction'
  readonly chainId: ChainId
  readonly addressIndex: number
  readonly transaction: EvmEip1559Transaction
}

export interface PeaEvmExecutionAccount {
  readonly kind: 'pea'
  readonly address: string
  readonly addressIndex: number
}

export interface BuildEvmTransferInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly intent: EvmTransferIntent
  readonly rpc: EvmTransactionRpc
  readonly feeSelection?: EvmFeeSelection
  readonly feeTier?: NetworkFeeTier
  readonly nonceFloor?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmContractCallInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly intent: EvmContractCallIntent
  readonly rpc: EvmTransactionRpc
  readonly feeSelection?: EvmFeeSelection
  readonly feeTier?: NetworkFeeTier
  readonly nonceFloor?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmCancelInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly rpc: EvmTransactionRpc & Pick<EvmBroadcastRpc, 'getTransactionLocation'>
  readonly original: Readonly<{
    transactionHash: string
    nonce: string
    maxFeePerGasWei: string
    maxPriorityFeePerGasWei: string
  }>
  readonly allowUnknownAtNonce?: boolean
  readonly feeSelection?: EvmFeeSelection
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmNonceRecoveryInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly rpc: EvmTransactionRpc
  readonly nonce: string
  readonly feeSelection?: EvmFeeSelection
  readonly signal?: AbortSignal
  readonly now?: () => number
}

const MAXIMUM_UINT64 = (1n << 64n) - 1n
const MAXIMUM_UINT256 = (1n << 256n) - 1n
const ERC20_TRANSFER_SELECTOR = 'a9059cbb'
const ERC20_TRUE = `0x${'0'.repeat(63)}1`

function invalidIntent(message: string): never {
  throw new EvmTransactionError('invalid-intent', message)
}

function isInsufficientFundsRpcError(error: unknown): boolean {
  return (
    error instanceof EvmRpcError &&
    error.code === 'rpc-error' &&
    typeof error.rpcMessage === 'string' &&
    /insufficient funds|insufficient balance|funds for gas|exceeds (?:the )?account balance/i.test(
      error.rpcMessage
    )
  )
}

function insufficientFunds(details?: EvmInsufficientFundsDetails): never {
  throw new EvmTransactionError(
    'insufficient-funds',
    'The EVM balance does not cover the transfer and network fee',
    details
  )
}

function minimumFundingDetails(
  nativeBalance: bigint,
  transactionValue: bigint
): EvmInsufficientFundsDetails {
  const requiredNativeBalance =
    transactionValue > nativeBalance ? transactionValue : nativeBalance + 1n
  return Object.freeze({
    requiredNativeBalanceRaw: requiredNativeBalance.toString(),
    availableNativeBalanceRaw: nativeBalance.toString(),
    shortfallRaw: (requiredNativeBalance - nativeBalance).toString(),
    maximumGasCostRaw: '0',
    transactionValueRaw: transactionValue.toString()
  })
}

function parseRecipient(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    invalidIntent('Invalid EVM transfer recipient')
  }
  return value
}

function parseAmount(value: string, maximum: bigint, label: string): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(value)) invalidIntent(`Invalid ${label}`)
  const amount = BigInt(value)
  if (amount > maximum) invalidIntent(`Invalid ${label}`)
  return amount
}

function parseOptionalAmount(value: string, maximum: bigint, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) invalidIntent(`Invalid ${label}`)
  const amount = BigInt(value)
  if (amount > maximum) invalidIntent(`Invalid ${label}`)
  return amount
}

function parseCalldata(value: string): string {
  if (
    value.length < 4 ||
    value.length > 2 + 128 * 1024 * 2 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)
  ) {
    invalidIntent('Invalid EVM contract calldata')
  }
  return value.toLowerCase()
}

export function parseEvmTransferIntent(value: unknown): EvmTransferIntent {
  const record = readRecord(value, 'EVM transfer intent')
  assertExactKeys(record, ['assetId', 'recipient', 'amountRaw'], 'EVM transfer intent')
  if (
    typeof record.assetId !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.amountRaw !== 'string'
  ) {
    invalidIntent('Invalid EVM transfer intent')
  }
  return Object.freeze({
    assetId: parseAssetId(record.assetId).id,
    recipient: parseRecipient(record.recipient),
    amountRaw: parseAmount(record.amountRaw, MAXIMUM_UINT256, 'EVM transfer amount').toString()
  })
}

export function parseEvmContractCallIntent(value: unknown): EvmContractCallIntent {
  const record = readRecord(value, 'EVM contract call intent')
  assertExactKeys(
    record,
    ['chainId', 'contractAddress', 'valueRaw', 'calldata'],
    'EVM contract call intent'
  )
  if (
    typeof record.chainId !== 'string' ||
    typeof record.contractAddress !== 'string' ||
    typeof record.valueRaw !== 'string' ||
    typeof record.calldata !== 'string'
  ) {
    invalidIntent('Invalid EVM contract call intent')
  }
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'eip155') invalidIntent('EVM contract call requires an EVM chain')
  return Object.freeze({
    chainId: chain.id,
    contractAddress: parseRecipient(record.contractAddress),
    valueRaw: parseOptionalAmount(
      record.valueRaw,
      MAXIMUM_UINT256,
      'EVM contract call value'
    ).toString(),
    calldata: parseCalldata(record.calldata)
  })
}

function parseRpcUint64(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > MAXIMUM_UINT64) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return amount
}

function gasLimitWithMargin(estimate: bigint, kind: PreparedEvmTransfer['kind']): bigint {
  if (kind === 'native-transfer' && estimate === EVM_SIMPLE_TRANSFER_GAS) return estimate
  const limit =
    (estimate * (BASIS_POINTS + EVM_DYNAMIC_GAS_MARGIN_BPS) + BASIS_POINTS - 1n) / BASIS_POINTS
  if (limit > MAXIMUM_UINT64) {
    throw new EvmTransactionError('fee-overflow', 'EVM gas limit exceeds signer limits')
  }
  return limit
}

function parseRpcUint256(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > MAXIMUM_UINT256) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return amount
}

function parseTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid EVM transaction timestamp')
  return value
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== expected.length ||
    !expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readRawAmount(value: unknown, label: string, maximum: bigint): string {
  const amount = readString(value, label, 78)
  if (!/^(0|[1-9][0-9]{0,77})$/.test(amount) || BigInt(amount) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return amount
}

function readEvmAddress(value: unknown, label: string): string {
  const address = readString(value, label, 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Invalid ${label}`)
  return address
}

function parsePersistedTransaction(value: unknown, chainId: ChainId): EvmEip1559Transaction {
  const record = readRecord(value, 'Prepared EVM transaction')
  assertExactKeys(
    record,
    [
      'type',
      'chainId',
      'nonce',
      'maxFeePerGas',
      'maxPriorityFeePerGas',
      'gasLimit',
      'to',
      'value',
      'input',
      'accessList'
    ],
    'Prepared EVM transaction'
  )
  if (record.type !== 'eip1559' || record.chainId !== chainId.slice('eip155:'.length)) {
    throw new Error('Prepared EVM transaction chain does not match')
  }
  const nonce = readRawAmount(record.nonce, 'EVM nonce', MAXIMUM_UINT64)
  const maxFeePerGas = readRawAmount(record.maxFeePerGas, 'EVM maximum fee', MAXIMUM_UINT64)
  const maxPriorityFeePerGas = readRawAmount(
    record.maxPriorityFeePerGas,
    'EVM priority fee',
    MAXIMUM_UINT64
  )
  const gasLimit = readRawAmount(record.gasLimit, 'EVM gas limit', MAXIMUM_UINT64)
  if (gasLimit === '0' || BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new Error('Prepared EVM transaction fee fields are invalid')
  }
  const input = readString(record.input, 'EVM transaction input', 2 + 128 * 1024 * 2)
  if (!/^0x(?:[0-9a-f]{2})*$/.test(input)) {
    throw new Error('Invalid EVM transaction input')
  }
  if (!Array.isArray(record.accessList) || record.accessList.length !== 0) {
    throw new Error('Prepared EVM transfer access list must be empty')
  }
  return Object.freeze({
    type: 'eip1559',
    chainId: record.chainId,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    to: readEvmAddress(record.to, 'EVM transaction recipient'),
    value: readRawAmount(record.value, 'EVM transaction value', MAXIMUM_UINT256),
    input,
    accessList: Object.freeze([])
  })
}

export function parsePreparedEvmTransfer(value: unknown): PreparedEvmTransfer {
  const record = readRecord(value, 'Prepared EVM transfer')
  assertExactKeys(
    record,
    [
      'kind',
      'chainId',
      'addressIndex',
      'from',
      'assetId',
      'recipient',
      'amountRaw',
      'observedBlockNumber',
      'transaction',
      'createdAt'
    ],
    'Prepared EVM transfer'
  )
  if (
    record.kind !== 'native-transfer' &&
    record.kind !== 'erc20-transfer' &&
    record.kind !== 'contract-call' &&
    record.kind !== 'cancel' &&
    record.kind !== 'nonce-recovery'
  ) {
    throw new Error('Invalid prepared EVM transfer kind')
  }
  const chain = parseChainId(readString(record.chainId, 'EVM chain ID', 64))
  if (chain.namespace !== 'eip155') throw new Error('Prepared EVM transfer requires an EVM chain')
  const asset = parseAssetId(readString(record.assetId, 'EVM asset ID', 256))
  if (asset.chainId !== chain.id) throw new Error('Prepared EVM transfer asset chain mismatch')
  const recipient = readEvmAddress(record.recipient, 'EVM transfer recipient')
  const from = readEvmAddress(record.from, 'EVM transfer sender')
  if (/^0x0{40}$/i.test(recipient)) throw new Error('Invalid EVM transfer recipient')
  const amountRaw = readRawAmount(record.amountRaw, 'EVM transfer amount', MAXIMUM_UINT256)
  if (
    record.kind !== 'contract-call' &&
    record.kind !== 'cancel' &&
    record.kind !== 'nonce-recovery' &&
    amountRaw === '0'
  ) {
    throw new Error('Prepared EVM transfer amount must be positive')
  }
  const transaction = parsePersistedTransaction(record.transaction, chain.id)
  if (record.kind === 'native-transfer') {
    if (
      asset.namespace !== 'slip44' ||
      transaction.to.toLowerCase() !== recipient.toLowerCase() ||
      transaction.value !== amountRaw ||
      transaction.input !== '0x'
    ) {
      throw new Error('Prepared native EVM transfer binding mismatch')
    }
  } else if (record.kind === 'erc20-transfer') {
    const expectedInput = `0x${ERC20_TRANSFER_SELECTOR}${recipient
      .slice(2)
      .padStart(64, '0')}${BigInt(amountRaw).toString(16).padStart(64, '0')}`
    if (
      asset.namespace !== 'erc20' ||
      transaction.to.toLowerCase() !== asset.reference.toLowerCase() ||
      transaction.value !== '0' ||
      transaction.input.toLowerCase() !== expectedInput.toLowerCase()
    ) {
      throw new Error('Prepared ERC-20 transfer binding mismatch')
    }
  } else if (record.kind === 'cancel' || record.kind === 'nonce-recovery') {
    if (
      asset.namespace !== 'slip44' ||
      recipient.toLowerCase() !== from.toLowerCase() ||
      transaction.to.toLowerCase() !== recipient.toLowerCase() ||
      transaction.value !== '0' ||
      transaction.input !== '0x'
    ) {
      throw new Error('Prepared EVM cancellation binding mismatch')
    }
  } else if (
    asset.namespace !== 'slip44' ||
    transaction.to.toLowerCase() !== recipient.toLowerCase() ||
    transaction.value !== amountRaw ||
    transaction.input === '0x'
  ) {
    throw new Error('Prepared EVM contract call binding mismatch')
  }
  return Object.freeze({
    kind: record.kind,
    chainId: chain.id,
    addressIndex: readIndex(record.addressIndex, 'EVM address index'),
    from,
    assetId: asset.id,
    recipient,
    amountRaw,
    observedBlockNumber: readRawAmount(
      record.observedBlockNumber,
      'EVM observed block number',
      MAXIMUM_UINT64
    ),
    transaction,
    createdAt: parseTimestamp(record.createdAt as number)
  })
}

export async function computeEvmSigningPayloadFingerprint(
  value: EvmEip1559Transaction
): Promise<string> {
  const numericId = readRawAmount(value.chainId, 'EVM chain ID', MAXIMUM_UINT64)
  const transaction = parsePersistedTransaction(value, parseChainId(`eip155:${numericId}`).id)
  const canonical = Object.freeze({
    type: transaction.type,
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    gasLimit: transaction.gasLimit,
    to: transaction.to,
    value: transaction.value,
    input: transaction.input,
    maxFeePerGas: transaction.maxFeePerGas,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    accessList: transaction.accessList
  })
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical))
  )
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function computeHexContentSha256(value: string): Promise<string> {
  const bytes = new Uint8Array((value.length - 2) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16)
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createEvmSigningSummary(
  prepared: PreparedEvmTransfer
): Promise<EvmTransactionSummary> {
  const transaction = prepared.transaction
  const calldataByteLength = (transaction.input.length - 2) / 2
  const review = Object.freeze({
    level: calldataByteLength > 0 ? ('caution' as const) : ('standard' as const),
    issues: Object.freeze(
      calldataByteLength > 0 ? [Object.freeze({ code: 'unrecognized-call' as const })] : []
    )
  })
  return Object.freeze({
    schema: 'evm.transaction.v1' as const,
    chainId: prepared.chainId,
    operation: 'transaction' as const,
    review,
    fields: Object.freeze({
      transactionType: 'eip1559' as const,
      from: prepared.from,
      to: transaction.to,
      nonce: transaction.nonce,
      valueWei: transaction.value,
      gasLimit: transaction.gasLimit,
      maximumFeeWei: (BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas)).toString(),
      gasPriceWei: null,
      maxFeePerGasWei: transaction.maxFeePerGas,
      maxPriorityFeePerGasWei: transaction.maxPriorityFeePerGas,
      accessList: Object.freeze([]),
      calldata: Object.freeze({
        encoding: 'hex' as const,
        value: transaction.input,
        byteLength: calldataByteLength,
        sha256: await computeHexContentSha256(transaction.input)
      }),
      methodSelector: calldataByteLength >= 4 ? transaction.input.slice(0, 10).toLowerCase() : null
    })
  })
}

export async function assertEvmSigningSummaryMatchesPrepared(
  prepared: PreparedEvmTransfer,
  summary: SigningSummary
): Promise<void> {
  if (
    summary.schema !== 'evm.transaction.v1' ||
    summary.chainId !== prepared.chainId ||
    summary.operation !== 'transaction'
  ) {
    throw new Error('EVM signing summary does not match the prepared transaction')
  }
  const transaction = prepared.transaction
  const calldataByteLength = (transaction.input.length - 2) / 2
  const expectsCallWarning = calldataByteLength > 0
  const issue = summary.review.issues[0]
  const expectedMaximumFee = (
    BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas)
  ).toString()
  const fields = summary.fields
  const addressesMatch = (left: string | null, right: string | null): boolean =>
    left === null || right === null ? left === right : left.toLowerCase() === right.toLowerCase()
  if (
    summary.review.level !== (expectsCallWarning ? 'caution' : 'standard') ||
    summary.review.issues.length !== (expectsCallWarning ? 1 : 0) ||
    (expectsCallWarning &&
      (issue?.code !== 'unrecognized-call' || issue.subjectIndex !== undefined)) ||
    fields.transactionType !== 'eip1559' ||
    !addressesMatch(fields.from, prepared.from) ||
    !addressesMatch(fields.to, transaction.to) ||
    fields.nonce !== transaction.nonce ||
    fields.valueWei !== transaction.value ||
    fields.gasLimit !== transaction.gasLimit ||
    fields.maximumFeeWei !== expectedMaximumFee ||
    fields.gasPriceWei !== null ||
    fields.maxFeePerGasWei !== transaction.maxFeePerGas ||
    fields.maxPriorityFeePerGasWei !== transaction.maxPriorityFeePerGas ||
    fields.accessList.length !== 0 ||
    fields.calldata.encoding !== 'hex' ||
    fields.calldata.value !== transaction.input ||
    fields.calldata.byteLength !== calldataByteLength ||
    fields.calldata.sha256 !== (await computeHexContentSha256(transaction.input)) ||
    fields.methodSelector !==
      (calldataByteLength >= 4 ? transaction.input.slice(0, 10).toLowerCase() : null)
  ) {
    throw new Error('EVM signing summary does not match the prepared transaction')
  }
}

function numericChainId(chainId: ChainId): string {
  const match = /^eip155:(0|[1-9][0-9]*)$/.exec(chainId)
  if (match === null || BigInt(match[1]) > MAXIMUM_UINT64) {
    throw new EvmTransactionError('invalid-intent', 'Invalid EVM transaction chain')
  }
  return match[1]
}

function createTransferCall(
  input: BuildEvmTransferInput,
  from: string
): {
  readonly kind: PreparedEvmTransfer['kind']
  readonly assetId: string
  readonly call: EvmRpcCall
  readonly transactionTo: string
  readonly transactionValue: string
  readonly transactionInput: string
} {
  let asset: AssetRegistryEntry
  try {
    const listed = input.assets.get(input.intent.assetId)
    const inspected = listed ?? input.assets.inspect(input.intent.assetId)
    if (
      !inspected ||
      (inspected.verification === 'unverified' &&
        (inspected.asset.kind !== 'token' || inspected.asset.namespace !== 'erc20')) ||
      inspected.verification === 'blocked'
    ) {
      invalidIntent('EVM transfer asset is not listed')
    }
    asset = inspected
  } catch {
    invalidIntent('EVM transfer asset is not listed')
  }
  if (asset.asset.chainId !== input.chainId) invalidIntent('EVM transfer asset is on another chain')
  const recipient = parseRecipient(input.intent.recipient)
  const amount = parseAmount(input.intent.amountRaw, MAXIMUM_UINT256, 'EVM transfer amount')

  if (asset.asset.kind === 'native' && asset.asset.namespace === 'slip44') {
    return Object.freeze({
      kind: 'native-transfer',
      assetId: asset.asset.id,
      call: Object.freeze({ from, to: recipient, valueRaw: amount.toString(), data: '0x' }),
      transactionTo: recipient,
      transactionValue: amount.toString(),
      transactionInput: '0x'
    })
  }
  if (asset.asset.kind === 'token' && asset.asset.namespace === 'erc20') {
    const encodedRecipient = recipient.slice(2).toLowerCase().padStart(64, '0')
    const data = `0x${ERC20_TRANSFER_SELECTOR}${encodedRecipient}${amount
      .toString(16)
      .padStart(64, '0')}`
    return Object.freeze({
      kind: 'erc20-transfer',
      assetId: asset.asset.id,
      call: Object.freeze({ from, to: asset.asset.reference, valueRaw: '0', data }),
      transactionTo: asset.asset.reference,
      transactionValue: '0',
      transactionInput: data
    })
  }
  return invalidIntent('Unsupported EVM transfer asset')
}

function assertSimulationResult(kind: PreparedEvmTransfer['kind'], result: string): void {
  if (kind === 'erc20-transfer' && result !== '0x' && result !== ERC20_TRUE) {
    throw new EvmTransactionError('simulation-failed', 'ERC-20 transfer simulation failed')
  }
}

interface PreparedEvmCall {
  readonly kind: PreparedEvmTransfer['kind']
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly call: EvmRpcCall
  readonly transactionTo: string
  readonly transactionValue: string
  readonly transactionInput: string
}

function createContractCall(input: BuildEvmContractCallInput, from: string): PreparedEvmCall {
  const intent = parseEvmContractCallIntent(input.intent)
  if (intent.chainId !== input.chainId) invalidIntent('EVM contract call is on another chain')
  const nativeAsset = input.assets
    .list(input.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!nativeAsset) invalidIntent('EVM native fee asset is not listed')
  return Object.freeze({
    kind: 'contract-call',
    assetId: nativeAsset.asset.id,
    recipient: intent.contractAddress,
    amountRaw: intent.valueRaw,
    call: Object.freeze({
      from,
      to: intent.contractAddress,
      valueRaw: intent.valueRaw,
      data: intent.calldata
    }),
    transactionTo: intent.contractAddress,
    transactionValue: intent.valueRaw,
    transactionInput: intent.calldata
  })
}

async function buildPreparedEvmTransaction(
  input: Pick<
    BuildEvmTransferInput,
    | 'chainId'
    | 'chainAccount'
    | 'executionAccount'
    | 'rpc'
    | 'feeSelection'
    | 'feeTier'
    | 'nonceFloor'
    | 'signal'
    | 'now'
  >,
  preparedCall: (from: string) => PreparedEvmCall
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : (() => {
          if (
            !/^0x[0-9a-fA-F]{40}$/.test(input.executionAccount.address) ||
            !Number.isSafeInteger(input.executionAccount.addressIndex) ||
            input.executionAccount.addressIndex < 0 ||
            input.executionAccount.addressIndex > 0x7fffffff
          ) {
            throw new Error('Invalid PEA execution account')
          }
          return input.executionAccount
        })()
  const transactionCall = preparedCall(account.address)
  await input.rpc.assertExpectedChain(input.signal)

  const [pendingNonceRaw, nativeBalanceRaw] = await Promise.all([
    input.rpc.getPendingNonce(account.address, input.signal),
    input.rpc.getNativeBalance(account.address, input.signal)
  ])
  const rpcNonce = parseRpcUint64(pendingNonceRaw, 'EVM pending nonce')
  const nonceFloor =
    input.nonceFloor === undefined
      ? rpcNonce
      : parseRpcUint64(input.nonceFloor, 'EVM local nonce floor')
  const nonce = rpcNonce > nonceFloor ? rpcNonce : nonceFloor
  const nativeBalance = parseRpcUint256(nativeBalanceRaw, 'EVM native balance')
  const transactionValue = BigInt(transactionCall.transactionValue)
  if (
    nativeBalance < transactionValue ||
    (nativeBalance === 0n && transactionCall.kind !== 'native-transfer')
  ) {
    insufficientFunds(minimumFundingDetails(nativeBalance, transactionValue))
  }
  let simulationResult: string
  try {
    simulationResult = await input.rpc.simulateCall(transactionCall.call, input.signal)
  } catch (error) {
    if (isInsufficientFundsRpcError(error)) insufficientFunds()
    if (error instanceof EvmRpcError && error.code !== 'rpc-error') throw error
    throw new EvmTransactionError(
      'simulation-failed',
      'EVM transaction simulation failed',
      undefined,
      error instanceof EvmRpcError ? { code: error.rpcCode, method: error.rpcMethod } : undefined
    )
  }
  assertSimulationResult(transactionCall.kind, simulationResult)

  let gasEstimate: string
  try {
    gasEstimate = await input.rpc.estimateGas(transactionCall.call, input.signal)
  } catch (error) {
    if (isInsufficientFundsRpcError(error)) insufficientFunds()
    if (error instanceof EvmRpcError && error.code === 'rpc-error') {
      throw new EvmTransactionError(
        'simulation-failed',
        'EVM gas estimation rejected the call',
        undefined,
        {
          code: error.rpcCode,
          method: error.rpcMethod
        }
      )
    }
    throw error
  }
  const estimatedGas = parseRpcUint64(gasEstimate, 'EVM gas estimate')
  if (estimatedGas === 0n) {
    throw new EvmRpcError('invalid-response', 'EVM gas estimate must be positive')
  }
  const gasLimit = gasLimitWithMargin(estimatedGas, transactionCall.kind)
  const priorityFee = parseRpcUint64(
    await input.rpc.getMaximumPriorityFeePerGas(input.signal),
    'EVM maximum priority fee per gas'
  )
  const blockFee = await input.rpc.getLatestBlockFee(input.signal)
  const baseFee = parseRpcUint64(blockFee.baseFeePerGas, 'EVM base fee per gas')
  const blockNumber = parseRpcUint64(blockFee.blockNumber, 'EVM block number')
  const feeQuote = deriveEvmFeeTierQuote({
    ...(input.feeSelection === undefined ? {} : { selection: input.feeSelection }),
    ...(input.feeTier === undefined ? {} : { tier: input.feeTier }),
    baseFeePerGas: baseFee,
    suggestedPriorityFeePerGas: priorityFee,
    ...(input.chainId === 'eip155:1'
      ? { minimumPriorityFeePerGas: ETHEREUM_MAINNET_PRIORITY_FEE_FLOOR_WEI }
      : {})
  })
  const maximumFee = feeQuote.maxFeePerGas
  if (maximumFee > MAXIMUM_UINT64) {
    throw new EvmTransactionError('fee-overflow', 'EVM maximum fee exceeds signer limits')
  }
  const maximumGasCost = gasLimit * maximumFee
  const requiredNativeBalance = transactionValue + maximumGasCost
  if (nativeBalance < requiredNativeBalance) {
    const shortfall = requiredNativeBalance - nativeBalance
    throw new EvmTransactionError(
      'insufficient-funds',
      `${input.executionAccount ? 'Private Execution Address' : 'EVM account'} needs ${shortfall} more wei for transaction value and maximum Gas`,
      Object.freeze({
        requiredNativeBalanceRaw: requiredNativeBalance.toString(),
        availableNativeBalanceRaw: nativeBalance.toString(),
        shortfallRaw: shortfall.toString(),
        maximumGasCostRaw: maximumGasCost.toString(),
        transactionValueRaw: transactionCall.transactionValue
      })
    )
  }

  return Object.freeze({
    kind: transactionCall.kind,
    chainId: input.chainId,
    addressIndex: account.addressIndex,
    from: account.address,
    assetId: transactionCall.assetId,
    recipient: transactionCall.recipient,
    amountRaw: transactionCall.amountRaw,
    observedBlockNumber: blockNumber.toString(),
    transaction: Object.freeze({
      type: 'eip1559',
      chainId: numericChainId(input.chainId),
      nonce: nonce.toString(),
      maxFeePerGas: maximumFee.toString(),
      maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas.toString(),
      gasLimit: gasLimit.toString(),
      to: transactionCall.transactionTo,
      value: transactionCall.transactionValue,
      input: transactionCall.transactionInput,
      accessList: Object.freeze([])
    }),
    createdAt: parseTimestamp((input.now ?? Date.now)())
  })
}

export function buildEvmTransfer(input: BuildEvmTransferInput): Promise<PreparedEvmTransfer> {
  return buildPreparedEvmTransaction(input, from => {
    const transfer = createTransferCall(input, from)
    return Object.freeze({
      ...transfer,
      recipient: input.intent.recipient,
      amountRaw: input.intent.amountRaw
    })
  })
}

export function buildEvmContractCall(
  input: BuildEvmContractCallInput
): Promise<PreparedEvmTransfer> {
  return buildPreparedEvmTransaction(input, from => createContractCall(input, from))
}

function replacementMinimum(value: bigint): bigint {
  const increased = (value * 1125n + 999n) / 1000n
  return increased > value ? increased : value + 1n
}

export async function buildEvmCancelTransaction(
  input: BuildEvmCancelInput
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : input.executionAccount
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.original.transactionHash)) {
    throw new EvmTransactionError('invalid-intent', 'Invalid original EVM transaction hash')
  }
  const nonce = parseRpcUint64(input.original.nonce, 'original EVM nonce')
  const originalMaxFee = parseRpcUint64(input.original.maxFeePerGasWei, 'original EVM maximum fee')
  const originalPriorityFee = parseRpcUint64(
    input.original.maxPriorityFeePerGasWei,
    'original EVM priority fee'
  )
  await input.rpc.assertExpectedChain(input.signal)
  const location = await input.rpc.getTransactionLocation(
    input.original.transactionHash,
    input.signal
  )
  if (
    location.status !== 'pending' &&
    !(location.status === 'unknown' && input.allowUnknownAtNonce)
  ) {
    throw new EvmTransactionError(
      'stale-nonce',
      'The original EVM transaction is no longer pending'
    )
  }
  const pendingNonce = parseRpcUint64(
    await input.rpc.getPendingNonce(account.address, input.signal),
    'EVM pending nonce'
  )
  if (pendingNonce !== nonce) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
  return buildEvmSelfTransaction(input, account, nonce, 'cancel', {
    maxFeePerGas: originalMaxFee,
    maxPriorityFeePerGas: originalPriorityFee
  })
}

export async function buildEvmNonceRecoveryTransaction(
  input: BuildEvmNonceRecoveryInput
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : input.executionAccount
  const nonce = parseRpcUint64(input.nonce, 'EVM recovery nonce')
  await input.rpc.assertExpectedChain(input.signal)
  const pendingNonce = parseRpcUint64(
    await input.rpc.getPendingNonce(account.address, input.signal),
    'EVM pending nonce'
  )
  if (pendingNonce !== nonce) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
  return buildEvmSelfTransaction(input, account, nonce, 'nonce-recovery')
}

async function buildEvmSelfTransaction(
  input: BuildEvmNonceRecoveryInput | BuildEvmCancelInput,
  account: Pick<PeaEvmExecutionAccount, 'address' | 'addressIndex'>,
  nonce: bigint,
  kind: 'cancel' | 'nonce-recovery',
  originalFee?: Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
): Promise<PreparedEvmTransfer> {
  const call = Object.freeze({
    from: account.address,
    to: account.address,
    valueRaw: '0',
    data: '0x'
  })
  const [nativeBalanceRaw, gasEstimate, suggestedPriorityRaw, blockFee] = await Promise.all([
    input.rpc.getNativeBalance(account.address, input.signal),
    input.rpc.estimateGas(call, input.signal),
    input.rpc.getMaximumPriorityFeePerGas(input.signal),
    input.rpc.getLatestBlockFee(input.signal)
  ])
  const nativeBalance = parseRpcUint256(nativeBalanceRaw, 'EVM native balance')
  const gasLimit = parseRpcUint64(gasEstimate, 'EVM cancel gas estimate')
  if (gasLimit === 0n) {
    throw new EvmRpcError('invalid-response', 'EVM gas estimate must be positive')
  }
  const suggestedPriority = parseRpcUint64(suggestedPriorityRaw, 'EVM maximum priority fee per gas')
  const baseFee = parseRpcUint64(blockFee.baseFeePerGas, 'EVM base fee per gas')
  const blockNumber = parseRpcUint64(blockFee.blockNumber, 'EVM block number')
  const quote = deriveEvmFeeTierQuote({
    selection: input.feeSelection ?? { kind: 'tier', tier: 'fast' },
    baseFeePerGas: baseFee,
    suggestedPriorityFeePerGas: suggestedPriority,
    ...(input.chainId === 'eip155:1'
      ? { minimumPriorityFeePerGas: ETHEREUM_MAINNET_PRIORITY_FEE_FLOOR_WEI }
      : {})
  })
  const minimumPriority = originalFee ? replacementMinimum(originalFee.maxPriorityFeePerGas) : 0n
  const maxPriorityFeePerGas =
    quote.maxPriorityFeePerGas > minimumPriority ? quote.maxPriorityFeePerGas : minimumPriority
  const marketMaxFee = baseFee * 2n + maxPriorityFeePerGas
  const minimumMaxFee = originalFee ? replacementMinimum(originalFee.maxFeePerGas) : 0n
  const maxFeePerGas = [quote.maxFeePerGas, marketMaxFee, minimumMaxFee].reduce((a, b) =>
    a > b ? a : b
  )
  if (maxFeePerGas > MAXIMUM_UINT64 || maxPriorityFeePerGas > maxFeePerGas) {
    throw new EvmTransactionError('fee-overflow', 'EVM cancel fee exceeds signer limits')
  }
  const maximumGasCost = gasLimit * maxFeePerGas
  if (nativeBalance < maximumGasCost) {
    insufficientFunds({
      requiredNativeBalanceRaw: maximumGasCost.toString(),
      availableNativeBalanceRaw: nativeBalance.toString(),
      shortfallRaw: (maximumGasCost - nativeBalance).toString(),
      maximumGasCostRaw: maximumGasCost.toString(),
      transactionValueRaw: '0'
    })
  }
  const nativeAsset = input.assets
    .list(input.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!nativeAsset) invalidIntent('EVM native fee asset is not listed')
  return Object.freeze({
    kind,
    chainId: input.chainId,
    addressIndex: account.addressIndex,
    from: account.address,
    assetId: nativeAsset.asset.id,
    recipient: account.address,
    amountRaw: '0',
    observedBlockNumber: blockNumber.toString(),
    transaction: Object.freeze({
      type: 'eip1559' as const,
      chainId: numericChainId(input.chainId),
      nonce: nonce.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      gasLimit: gasLimit.toString(),
      to: account.address,
      value: '0',
      input: '0x',
      accessList: Object.freeze([])
    }),
    createdAt: parseTimestamp((input.now ?? Date.now)())
  })
}

export async function assertEvmTransferFresh(
  prepared: PreparedEvmTransfer,
  rpc: EvmTransactionRpc,
  signal?: AbortSignal
): Promise<void> {
  await rpc.assertExpectedChain(signal)
  const currentNonce = parseRpcUint64(
    await rpc.getPendingNonce(prepared.from, signal),
    'EVM pending nonce'
  )
  if (currentNonce > BigInt(prepared.transaction.nonce)) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
}

export function createEvmSigningPreparePayload(
  prepared: PreparedEvmTransfer,
  executionMode: 'main' | 'private' = 'main'
): EvmSigningPreparePayload {
  return Object.freeze({
    kind: executionMode === 'private' ? 'pea-evm-transaction' : 'evm-transaction',
    chainId: prepared.chainId,
    addressIndex: prepared.addressIndex,
    transaction: prepared.transaction
  })
}
