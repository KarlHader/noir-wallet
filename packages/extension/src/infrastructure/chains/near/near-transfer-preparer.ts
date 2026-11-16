import {
  nearPublicKeyFromImplicitAccountId,
  parseNearAccountId,
  parseNearBase58,
  parseNearPublicKey
} from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import type { PreparedSigningCommand } from '@/core/keyring/ports'
import { buildLedgerNearTransaction } from '@/infrastructure/keyring/multichain/ledger-near-summary'

import type { NearReadRpc } from './near-rpc-types'
import { encodeNearFunctionArgs } from './near-rpc-codecs'
import {
  parsePreparedNearLendingSupply,
  type PreparedNearLendingSupply
} from './near-lending-supply-preparer'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

export type NearTransferErrorCode =
  | 'sender-not-found'
  | 'recipient-not-found'
  | 'access-key-not-found'
  | 'access-key-not-full-access'
  | 'recipient-token-account-not-registered'
  | 'insufficient-funds'

export class NearTransferError extends Error {
  readonly code: NearTransferErrorCode

  constructor(code: NearTransferErrorCode, message: string) {
    super(message)
    this.name = 'NearTransferError'
    this.code = code
  }
}

export interface PrepareNearNativeTransferInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly signerId: string
  readonly publicKey: string
  readonly receiverId: string
  readonly depositYocto: string
  readonly rpc: Pick<
    NearReadRpc,
    | 'assertExpectedChain'
    | 'getAccount'
    | 'getAccessKey'
    | 'getGasPrice'
    | 'getNativeTransferCostConfig'
  >
  readonly signal?: AbortSignal
}

export interface NearTransferTransaction {
  readonly chainId: string
  readonly accountIndex: number
  readonly signerId: string
  readonly receiverId: string
  readonly nonce: string
  readonly blockHash: string
  readonly actions: readonly NearTransferAction[]
}

export type NearTransferAction =
  | Readonly<{ type: 'transfer'; depositYocto: string }>
  | Readonly<{
      type: 'functionCall'
      methodName: string
      args: string
      gas: string
      depositYocto: string
    }>

export interface PreparedNearNativeTransfer {
  readonly chainId: string
  readonly accountIndex: number
  readonly signerId: string
  readonly publicKey: string
  readonly receiverId: string
  readonly depositYocto: string
  readonly estimatedFeeYocto: string
  readonly maximumFeeYocto: string
  readonly storageReserveYocto: string
  readonly totalRequiredYocto: string
  readonly transaction: NearTransferTransaction
}

export interface PrepareNearTokenTransferInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly signerId: string
  readonly publicKey: string
  readonly recipientId: string
  readonly contractId: string
  readonly amountRaw: string
  readonly rpc: Pick<
    NearReadRpc,
    | 'assertExpectedChain'
    | 'getAccount'
    | 'getAccessKey'
    | 'getGasPrice'
    | 'getNativeTransferCostConfig'
    | 'getFungibleTokenBalance'
    | 'isFungibleTokenAccountRegistered'
  >
  readonly signal?: AbortSignal
}

export interface PreparedNearTokenTransfer {
  readonly kind: 'token'
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly signerId: string
  readonly publicKey: string
  readonly recipientId: string
  readonly contractId: string
  readonly amountRaw: string
  readonly estimatedFeeYocto: string
  readonly maximumFeeYocto: string
  readonly storageReserveYocto: string
  readonly totalRequiredYocto: string
  readonly transaction: NearTransferTransaction
}

export type PreparedNearTransfer =
  | PreparedNearNativeTransfer
  | PreparedNearTokenTransfer
  | PreparedNearLendingSupply

const FUNGIBLE_TOKEN_TRANSFER_GAS = 30_000_000_000_000n

function parseUnsigned(value: unknown, maximum: bigint, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be unsigned decimal`)
  }
  const parsed = BigInt(value)
  if (parsed > maximum) throw new Error(`${label} exceeds its protocol limit`)
  return parsed
}

function parseAccountIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error('Invalid NEAR account index')
  }
  return value as number
}

function checkedU128(value: bigint, label: string): bigint {
  if (value > MAXIMUM_U128) throw new Error(`${label} exceeds u128`)
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

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

export function parsePreparedNearNativeTransfer(value: unknown): PreparedNearNativeTransfer {
  const record = readRecord(value, 'Prepared NEAR transfer')
  assertExactKeys(
    record,
    [
      'chainId',
      'accountIndex',
      'signerId',
      'publicKey',
      'receiverId',
      'depositYocto',
      'estimatedFeeYocto',
      'maximumFeeYocto',
      'storageReserveYocto',
      'totalRequiredYocto',
      'transaction'
    ],
    'Prepared NEAR transfer'
  )
  if (typeof record.chainId !== 'string') throw new Error('Prepared NEAR transfer has no chain')
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'near') throw new Error('Prepared NEAR transfer has the wrong chain')
  const accountIndex = parseAccountIndex(record.accountIndex)
  const signerId = parseNearAccountId(record.signerId, 'Prepared NEAR signer account ID')
  const publicKey = parseNearPublicKey(record.publicKey, 'Prepared NEAR public key')
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('Prepared NEAR signer does not match its public key')
  }
  const receiverId = parseNearAccountId(record.receiverId, 'Prepared NEAR receiver account ID')
  const deposit = parseUnsigned(record.depositYocto, MAXIMUM_U128, 'NEAR transfer amount')
  const estimatedFee = parseUnsigned(record.estimatedFeeYocto, MAXIMUM_U128, 'NEAR estimated fee')
  const maximumFee = parseUnsigned(record.maximumFeeYocto, MAXIMUM_U128, 'NEAR maximum fee')
  const storageReserve = parseUnsigned(
    record.storageReserveYocto,
    MAXIMUM_U128,
    'NEAR storage reserve'
  )
  const totalRequired = parseUnsigned(record.totalRequiredYocto, MAXIMUM_U128, 'NEAR total debit')
  if (
    deposit === 0n ||
    estimatedFee > maximumFee ||
    totalRequired !== deposit + maximumFee + storageReserve
  ) {
    throw new Error('Prepared NEAR transfer has invalid debit fields')
  }
  const transaction = readRecord(record.transaction, 'Prepared NEAR transaction')
  assertExactKeys(
    transaction,
    ['chainId', 'accountIndex', 'signerId', 'receiverId', 'nonce', 'blockHash', 'actions'],
    'Prepared NEAR transaction'
  )
  if (
    transaction.chainId !== chain.id ||
    transaction.accountIndex !== accountIndex ||
    transaction.signerId !== signerId ||
    transaction.receiverId !== receiverId ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length !== 1
  ) {
    throw new Error('Prepared NEAR transaction does not match its approval fields')
  }
  const nonce = parseUnsigned(transaction.nonce, MAXIMUM_U64, 'NEAR transaction nonce')
  if (nonce === 0n) throw new Error('Prepared NEAR transaction nonce must be positive')
  const blockHash = parseNearBase58(transaction.blockHash, 32, 'Prepared NEAR block hash')
  const action = readRecord(transaction.actions[0], 'Prepared NEAR transfer action')
  assertExactKeys(action, ['type', 'depositYocto'], 'Prepared NEAR transfer action')
  if (action.type !== 'transfer' || action.depositYocto !== deposit.toString()) {
    throw new Error('Prepared NEAR transfer action does not match its amount')
  }
  const parsedTransaction: NearTransferTransaction = Object.freeze({
    chainId: chain.id,
    accountIndex,
    signerId,
    receiverId,
    nonce: nonce.toString(),
    blockHash,
    actions: Object.freeze([
      Object.freeze({ type: 'transfer' as const, depositYocto: deposit.toString() })
    ]) as NearTransferTransaction['actions']
  })
  return Object.freeze({
    chainId: chain.id,
    accountIndex,
    signerId,
    publicKey,
    receiverId,
    depositYocto: deposit.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: parsedTransaction
  })
}

export function parsePreparedNearTokenTransfer(value: unknown): PreparedNearTokenTransfer {
  const record = readRecord(value, 'Prepared NEAR token transfer')
  assertExactKeys(
    record,
    [
      'kind',
      'chainId',
      'accountIndex',
      'assetId',
      'signerId',
      'publicKey',
      'recipientId',
      'contractId',
      'amountRaw',
      'estimatedFeeYocto',
      'maximumFeeYocto',
      'storageReserveYocto',
      'totalRequiredYocto',
      'transaction'
    ],
    'Prepared NEAR token transfer'
  )
  if (
    record.kind !== 'token' ||
    typeof record.chainId !== 'string' ||
    typeof record.assetId !== 'string'
  ) {
    throw new Error('Invalid prepared NEAR token transfer')
  }
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'near')
    throw new Error('Prepared NEAR token transfer has the wrong chain')
  const accountIndex = parseAccountIndex(record.accountIndex)
  const signerId = parseNearAccountId(record.signerId, 'Prepared NEAR token signer account ID')
  const publicKey = parseNearPublicKey(record.publicKey, 'Prepared NEAR token public key')
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('Prepared NEAR token signer does not match its public key')
  }
  const recipientId = parseNearAccountId(record.recipientId, 'Prepared NEAR token recipient')
  const contractId = parseNearAccountId(record.contractId, 'Prepared NEAR token contract')
  if (record.assetId !== `${chain.id}/nep141:${contractId.replace(/_/g, '%5F')}`) {
    throw new Error('Prepared NEAR token asset does not match its contract')
  }
  const amount = parseUnsigned(record.amountRaw, MAXIMUM_U128, 'NEAR token transfer amount')
  const estimatedFee = parseUnsigned(record.estimatedFeeYocto, MAXIMUM_U128, 'NEAR estimated fee')
  const maximumFee = parseUnsigned(record.maximumFeeYocto, MAXIMUM_U128, 'NEAR maximum fee')
  const storageReserve = parseUnsigned(
    record.storageReserveYocto,
    MAXIMUM_U128,
    'NEAR storage reserve'
  )
  const totalRequired = parseUnsigned(record.totalRequiredYocto, MAXIMUM_U128, 'NEAR total debit')
  if (
    amount === 0n ||
    estimatedFee > maximumFee ||
    totalRequired !== maximumFee + storageReserve + 1n
  ) {
    throw new Error('Prepared NEAR token transfer has invalid debit fields')
  }
  const transaction = readRecord(record.transaction, 'Prepared NEAR token transaction')
  assertExactKeys(
    transaction,
    ['chainId', 'accountIndex', 'signerId', 'receiverId', 'nonce', 'blockHash', 'actions'],
    'Prepared NEAR token transaction'
  )
  if (
    transaction.chainId !== chain.id ||
    transaction.accountIndex !== accountIndex ||
    transaction.signerId !== signerId ||
    transaction.receiverId !== contractId ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length !== 1
  ) {
    throw new Error('Prepared NEAR token transaction does not match its approval fields')
  }
  const nonce = parseUnsigned(transaction.nonce, MAXIMUM_U64, 'NEAR transaction nonce')
  if (nonce === 0n) throw new Error('Prepared NEAR transaction nonce must be positive')
  const blockHash = parseNearBase58(transaction.blockHash, 32, 'Prepared NEAR block hash')
  const action = readRecord(transaction.actions[0], 'Prepared NEAR token transfer action')
  assertExactKeys(
    action,
    ['type', 'methodName', 'args', 'gas', 'depositYocto'],
    'Prepared NEAR token transfer action'
  )
  const expectedArgs = encodeNearFunctionArgs(
    Object.freeze({ receiver_id: recipientId, amount: amount.toString() })
  )
  if (
    action.type !== 'functionCall' ||
    action.methodName !== 'ft_transfer' ||
    action.args !== expectedArgs ||
    action.gas !== FUNGIBLE_TOKEN_TRANSFER_GAS.toString() ||
    action.depositYocto !== '1'
  ) {
    throw new Error('Prepared NEAR token transfer action does not match its intent')
  }
  return Object.freeze({
    kind: 'token',
    chainId: chain.id,
    accountIndex,
    assetId: record.assetId,
    signerId,
    publicKey,
    recipientId,
    contractId,
    amountRaw: amount.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: Object.freeze({
      chainId: chain.id,
      accountIndex,
      signerId,
      receiverId: contractId,
      nonce: nonce.toString(),
      blockHash,
      actions: Object.freeze([
        Object.freeze({
          type: 'functionCall' as const,
          methodName: 'ft_transfer' as const,
          args: expectedArgs,
          gas: FUNGIBLE_TOKEN_TRANSFER_GAS.toString(),
          depositYocto: '1' as const
        })
      ]) as NearTransferTransaction['actions']
    })
  })
}

export function parsePreparedNearTransfer(value: unknown): PreparedNearTransfer {
  const record = readRecord(value, 'Prepared NEAR transfer')
  if (record.kind === 'token') return parsePreparedNearTokenTransfer(record)
  if (record.kind === 'lending-supply') return parsePreparedNearLendingSupply(record)
  return parsePreparedNearNativeTransfer(record)
}

function nativeTransferGas(
  selfTransfer: boolean,
  costs: Awaited<ReturnType<NearReadRpc['getNativeTransferCostConfig']>>
): bigint {
  const sendField = selfTransfer ? 'sendSirGas' : 'sendNotSirGas'
  return (
    parseUnsigned(costs.actionReceiptCreation[sendField], MAXIMUM_U64, 'NEAR receipt send gas') +
    parseUnsigned(
      costs.actionReceiptCreation.executionGas,
      MAXIMUM_U64,
      'NEAR receipt execution gas'
    ) +
    parseUnsigned(costs.transfer[sendField], MAXIMUM_U64, 'NEAR transfer send gas') +
    parseUnsigned(costs.transfer.executionGas, MAXIMUM_U64, 'NEAR transfer execution gas')
  )
}

export async function prepareNearNativeTransfer(
  input: PrepareNearNativeTransferInput
): Promise<PreparedNearNativeTransfer> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'near') throw new Error('NEAR transfer requires a NEAR chain')
  const accountIndex = parseAccountIndex(input.accountIndex)
  const signerId = parseNearAccountId(input.signerId, 'NEAR signer account ID')
  const receiverId = parseNearAccountId(input.receiverId, 'NEAR receiver account ID')
  const publicKey = parseNearPublicKey(input.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const deposit = parseUnsigned(input.depositYocto, MAXIMUM_U128, 'NEAR transfer amount')
  if (deposit === 0n) throw new Error('NEAR transfer amount must be greater than zero')

  await input.rpc.assertExpectedChain(input.signal)
  const [sender, receiver, accessKey, gasPriceRaw, costs] = await Promise.all([
    input.rpc.getAccount(signerId, input.signal),
    signerId === receiverId
      ? input.rpc.getAccount(signerId, input.signal)
      : input.rpc.getAccount(receiverId, input.signal),
    input.rpc.getAccessKey(signerId, publicKey, input.signal),
    input.rpc.getGasPrice(input.signal),
    input.rpc.getNativeTransferCostConfig(input.signal)
  ])
  if (sender === null) {
    throw new NearTransferError('sender-not-found', 'NEAR sender account was not found')
  }
  if (receiver === null) {
    throw new NearTransferError(
      'recipient-not-found',
      'NEAR recipient account must exist before this transfer can be prepared'
    )
  }
  if (accessKey === null) {
    throw new NearTransferError(
      'access-key-not-found',
      'The derived NEAR access key is not registered on the sender account'
    )
  }
  if (accessKey.permission.kind !== 'full-access') {
    throw new NearTransferError(
      'access-key-not-full-access',
      'NEAR native transfers require a full-access key'
    )
  }

  const nonce = parseUnsigned(accessKey.nonce, MAXIMUM_U64, 'NEAR access key nonce')
  if (nonce === MAXIMUM_U64) throw new Error('NEAR access key nonce is exhausted')
  const gasUnits = nativeTransferGas(signerId === receiverId, costs)
  const gasPrice = parseUnsigned(gasPriceRaw, MAXIMUM_U128, 'NEAR gas price')
  const minimumPurchasePrice = parseUnsigned(
    costs.minGasPurchasePriceRaw,
    MAXIMUM_U128,
    'NEAR minimum gas purchase price'
  )
  const estimatedFee = checkedU128(gasUnits * gasPrice, 'NEAR estimated fee')
  const maximumFee = checkedU128(
    gasUnits * (gasPrice > minimumPurchasePrice ? gasPrice : minimumPurchasePrice),
    'NEAR maximum fee'
  )
  const storageAmountPerByte = parseUnsigned(
    costs.storageAmountPerByteRaw,
    MAXIMUM_U128,
    'NEAR storage amount per byte'
  )
  const storageReserve = checkedU128(
    BigInt(sender.storageUsage) * storageAmountPerByte,
    'NEAR storage reserve'
  )
  const totalRequired = checkedU128(deposit + maximumFee + storageReserve, 'NEAR total debit')
  const balance = parseUnsigned(sender.amountRaw, MAXIMUM_U128, 'NEAR sender balance')
  if (totalRequired > balance) {
    throw new NearTransferError(
      'insufficient-funds',
      'NEAR balance cannot cover the transfer, maximum fee, and storage reserve'
    )
  }

  const transaction: NearTransferTransaction = Object.freeze({
    chainId: chainId.id,
    accountIndex,
    signerId,
    receiverId,
    nonce: (nonce + 1n).toString(),
    blockHash: accessKey.blockHash,
    actions: Object.freeze([
      Object.freeze({ type: 'transfer' as const, depositYocto: deposit.toString() })
    ]) as NearTransferTransaction['actions']
  })
  return Object.freeze({
    chainId: chainId.id,
    accountIndex,
    signerId,
    publicKey,
    receiverId,
    depositYocto: deposit.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction
  })
}

export async function prepareNearTokenTransfer(
  input: PrepareNearTokenTransferInput
): Promise<PreparedNearTokenTransfer> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'near') throw new Error('NEAR transfer requires a NEAR chain')
  const accountIndex = parseAccountIndex(input.accountIndex)
  const signerId = parseNearAccountId(input.signerId, 'NEAR signer account ID')
  const recipientId = parseNearAccountId(input.recipientId, 'NEAR token recipient account ID')
  const contractId = parseNearAccountId(input.contractId, 'NEAR fungible token contract ID')
  const expectedAssetId = `${chainId.id}/nep141:${contractId.replace(/_/g, '%5F')}`
  if (input.assetId !== expectedAssetId)
    throw new Error('NEAR token asset does not match its contract')
  const publicKey = parseNearPublicKey(input.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const amount = parseUnsigned(input.amountRaw, MAXIMUM_U128, 'NEAR token transfer amount')
  if (amount === 0n) throw new Error('NEAR token transfer amount must be greater than zero')

  await input.rpc.assertExpectedChain(input.signal)
  const [sender, accessKey, gasPriceRaw, costs, tokenBalance, recipientRegistered] =
    await Promise.all([
      input.rpc.getAccount(signerId, input.signal),
      input.rpc.getAccessKey(signerId, publicKey, input.signal),
      input.rpc.getGasPrice(input.signal),
      input.rpc.getNativeTransferCostConfig(input.signal),
      input.rpc.getFungibleTokenBalance(contractId, signerId, input.signal),
      input.rpc.isFungibleTokenAccountRegistered(contractId, recipientId, input.signal)
    ])
  if (sender === null)
    throw new NearTransferError('sender-not-found', 'NEAR sender account was not found')
  if (accessKey === null) {
    throw new NearTransferError(
      'access-key-not-found',
      'The derived NEAR access key is not registered'
    )
  }
  if (accessKey.permission.kind !== 'full-access') {
    throw new NearTransferError(
      'access-key-not-full-access',
      'NEAR token transfers require a full-access key'
    )
  }
  if (!recipientRegistered) {
    throw new NearTransferError(
      'recipient-token-account-not-registered',
      'The NEAR recipient is not registered with this token contract'
    )
  }
  if (BigInt(tokenBalance.amountRaw) < amount) {
    throw new NearTransferError('insufficient-funds', 'NEAR token balance is insufficient')
  }
  const nonce = parseUnsigned(accessKey.nonce, MAXIMUM_U64, 'NEAR access key nonce')
  if (nonce === MAXIMUM_U64) throw new Error('NEAR access key nonce is exhausted')
  const gasPrice = parseUnsigned(gasPriceRaw, MAXIMUM_U128, 'NEAR gas price')
  const minimumPurchasePrice = parseUnsigned(
    costs.minGasPurchasePriceRaw,
    MAXIMUM_U128,
    'NEAR minimum gas purchase price'
  )
  const estimatedFee = checkedU128(FUNGIBLE_TOKEN_TRANSFER_GAS * gasPrice, 'NEAR estimated fee')
  const maximumFee = checkedU128(
    FUNGIBLE_TOKEN_TRANSFER_GAS *
      (gasPrice > minimumPurchasePrice ? gasPrice : minimumPurchasePrice),
    'NEAR maximum fee'
  )
  const storageAmountPerByte = parseUnsigned(
    costs.storageAmountPerByteRaw,
    MAXIMUM_U128,
    'NEAR storage amount per byte'
  )
  const storageReserve = checkedU128(
    BigInt(sender.storageUsage) * storageAmountPerByte,
    'NEAR storage reserve'
  )
  const totalRequired = checkedU128(maximumFee + storageReserve + 1n, 'NEAR total debit')
  if (totalRequired > parseUnsigned(sender.amountRaw, MAXIMUM_U128, 'NEAR sender balance')) {
    throw new NearTransferError(
      'insufficient-funds',
      'NEAR balance cannot cover the token transfer fee and storage reserve'
    )
  }
  const transaction: NearTransferTransaction = Object.freeze({
    chainId: chainId.id,
    accountIndex,
    signerId,
    receiverId: contractId,
    nonce: (nonce + 1n).toString(),
    blockHash: accessKey.blockHash,
    actions: Object.freeze([
      Object.freeze({
        type: 'functionCall' as const,
        methodName: 'ft_transfer' as const,
        args: encodeNearFunctionArgs(
          Object.freeze({ receiver_id: recipientId, amount: amount.toString() })
        ),
        gas: FUNGIBLE_TOKEN_TRANSFER_GAS.toString(),
        depositYocto: '1' as const
      })
    ]) as NearTransferTransaction['actions']
  })
  return Object.freeze({
    kind: 'token',
    chainId: chainId.id,
    accountIndex,
    assetId: expectedAssetId,
    signerId,
    publicKey,
    recipientId,
    contractId,
    amountRaw: amount.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction
  })
}

export async function computeNearTransactionFingerprint(
  transaction: NearTransferTransaction
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(transaction))
  )
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function assertNearTransferSigningMatchesPrepared(
  prepared: PreparedNearTransfer,
  signing: PreparedSigningCommand
): Promise<void> {
  if (
    signing.chainId !== prepared.chainId ||
    signing.operation !== 'transaction' ||
    (signing.execution.kind === 'external' &&
      (signing.execution.request.encoding !== 'base64' ||
        typeof signing.execution.request.value !== 'string')) ||
    signing.summary.schema !== 'near.transaction.v1' ||
    signing.summary.review.level !== 'standard' ||
    signing.summary.review.issues.length !== 0 ||
    signing.payloadFingerprint.digestHex !==
      (await computeNearTransactionFingerprint(prepared.transaction))
  ) {
    throw new Error('NEAR signing command does not match the prepared transfer')
  }
  const fields = signing.summary.fields
  if (signing.execution.kind === 'external') {
    const rebuilt = await buildLedgerNearTransaction(
      {
        kind: 'near-transaction',
        chainId: signing.chainId,
        accountIndex: prepared.accountIndex,
        transaction: prepared.transaction as unknown as Record<string, unknown>
      },
      prepared.publicKey,
      prepared.signerId
    )
    if (signing.execution.request.value !== rebuilt.payloadBase64) {
      throw new Error('NEAR Ledger request does not match the prepared transfer')
    }
  }
  if (
    fields.signerId !== prepared.signerId ||
    fields.publicKey !== prepared.publicKey ||
    fields.nonce !== prepared.transaction.nonce ||
    fields.receiverId !== prepared.transaction.receiverId ||
    fields.blockHash !== prepared.transaction.blockHash ||
    fields.actions.length !== prepared.transaction.actions.length
  ) {
    throw new Error('NEAR signing summary does not match the prepared transfer')
  }
  for (let index = 0; index < prepared.transaction.actions.length; index += 1) {
    const preparedAction = prepared.transaction.actions[index]
    const action = fields.actions[index]
    const matches =
      preparedAction.type === 'transfer'
        ? action?.kind === 'transfer' && action.depositYocto === preparedAction.depositYocto
        : action?.kind === 'function-call' &&
          action.methodName === preparedAction.methodName &&
          action.args.encoding === 'base64' &&
          action.args.value === preparedAction.args &&
          action.gas === preparedAction.gas &&
          action.depositYocto === preparedAction.depositYocto
    if (!matches) throw new Error('NEAR signing summary does not match the prepared transfer')
  }
  if ('kind' in prepared && prepared.kind === 'token') {
    const preparedAction = prepared.transaction.actions[0]
    if (
      fields.receiverId !== prepared.contractId ||
      preparedAction.type !== 'functionCall' ||
      preparedAction.methodName !== 'ft_transfer' ||
      preparedAction.gas !== FUNGIBLE_TOKEN_TRANSFER_GAS.toString() ||
      preparedAction.depositYocto !== '1'
    ) {
      throw new Error('NEAR signing summary does not match the prepared token transfer')
    }
    return
  }
  if ('kind' in prepared && prepared.kind === 'lending-supply') {
    if (fields.receiverId !== prepared.tokenContractId) {
      throw new Error('NEAR signing summary does not match the prepared Lending Supply')
    }
    return
  }
  const action = fields.actions[0]
  if (action?.kind !== 'transfer' || action.depositYocto !== prepared.depositYocto) {
    throw new Error('NEAR signing summary does not match the prepared native transfer')
  }
}
