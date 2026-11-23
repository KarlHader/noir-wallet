import {
  nearPublicKeyFromImplicitAccountId,
  parseNearAccountId,
  parseNearBase58,
  parseNearPublicKey
} from '@/core/chains/near'
import {
  isNearFungibleContractId,
  nearFungibleAssetId
} from '@/core/chains/near/near-portfolio-assets'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import {
  buildNearConfidentialFungibleDepositActions,
  buildNearIntentsDepositActions,
  nearIntentsDepositMaximumYocto,
  NEAR_FT_TRANSFER_DEPOSIT_YOCTO,
  NEAR_FT_TRANSFER_GAS,
  NEAR_STORAGE_DEPOSIT_GAS,
  NEAR_STORAGE_DEPOSIT_YOCTO,
  NEAR_WRAP_DEPOSIT_GAS,
  WRAP_NEAR_CONTRACT_ID,
  type NearIntentsDepositAction
} from '@/core/chains/near/near-intents-deposit-actions'
import {
  nearAccountStorageReserveYocto,
  nearSpendableNativeYocto
} from '@/core/chains/near/near-native-reserve'

import { encodeNearFunctionArgs } from './near-rpc-codecs'
import { formatNearBalanceShortage } from './near-rpc-client'
import type { NearReadRpc } from './near-rpc-types'
import {
  NearTransferError,
  type NearTransferAction,
  type NearTransferTransaction
} from './near-transfer-preparer'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const MAINNET_CHAIN_ID = 'near:mainnet'

export interface PrepareNearConfidentialFungibleDepositInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly signerId: string
  readonly publicKey: string
  readonly depositAddress: string
  readonly amountRaw: string
  readonly rpc: PrepareNearIntentsDepositInput['rpc']
  readonly signal?: AbortSignal
}

export interface PreparedNearConfidentialFungibleDeposit {
  readonly kind: 'confidential-ft-deposit'
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly signerId: string
  readonly publicKey: string
  readonly recipientId: string
  readonly tokenContractId: string
  readonly amountRaw: string
  readonly storageFeeYocto: string
  readonly estimatedFeeYocto: string
  readonly maximumFeeYocto: string
  readonly storageReserveYocto: string
  readonly totalRequiredYocto: string
  readonly transaction: NearTransferTransaction
}

export type PreparedNearConfidentialDeposit =
  | PreparedNearIntentsDeposit
  | PreparedNearConfidentialFungibleDeposit

export interface PrepareNearIntentsDepositInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly signerId: string
  readonly publicKey: string
  readonly depositAddress: string
  readonly amountRaw: string
  readonly memo?: string
  /** Omitted means wrap the shortfall. False spends only existing wNEAR. */
  readonly wrapShortfall?: boolean
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

export interface PreparedNearIntentsDeposit {
  readonly kind: 'intents-deposit'
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly signerId: string
  readonly publicKey: string
  readonly recipientId: string
  readonly tokenContractId: typeof WRAP_NEAR_CONTRACT_ID
  readonly amountRaw: string
  readonly memo?: string
  readonly wrapAmountYocto: string
  readonly storageFeeYocto: string
  readonly estimatedFeeYocto: string
  readonly maximumFeeYocto: string
  readonly storageReserveYocto: string
  readonly totalRequiredYocto: string
  readonly transaction: NearTransferTransaction
}

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
  if (value < 0n || value > MAXIMUM_U128) throw new Error(`${label} exceeds u128`)
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

function encodeAction(action: NearIntentsDepositAction): NearTransferAction {
  return Object.freeze({
    type: 'functionCall' as const,
    methodName: action.methodName,
    args: encodeNearFunctionArgs(action.args),
    gas: action.gas,
    depositYocto: action.depositYocto
  })
}

export async function prepareNearIntentsDeposit(
  input: PrepareNearIntentsDepositInput
): Promise<PreparedNearIntentsDeposit> {
  const chainId = parseChainId(input.chainId)
  if (chainId.id !== MAINNET_CHAIN_ID) {
    throw new Error('NEAR Intents deposit requires NEAR mainnet')
  }
  const accountIndex = parseAccountIndex(input.accountIndex)
  const signerId = parseNearAccountId(input.signerId, 'NEAR signer account ID')
  const depositAddress = parseNearAccountId(input.depositAddress, 'NEAR Intents deposit address')
  const publicKey = parseNearPublicKey(input.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const amount = parseUnsigned(input.amountRaw, MAXIMUM_U128, 'NEAR Intents deposit amount')
  if (amount === 0n) throw new Error('NEAR Intents deposit amount must be greater than zero')
  const assetId = `${chainId.id}/nep141:${WRAP_NEAR_CONTRACT_ID}`

  await input.rpc.assertExpectedChain(input.signal)
  const [
    sender,
    accessKey,
    gasPriceRaw,
    costs,
    wrappedBalance,
    signerRegistered,
    recipientRegistered
  ] = await Promise.all([
    input.rpc.getAccount(signerId, input.signal),
    input.rpc.getAccessKey(signerId, publicKey, input.signal),
    input.rpc.getGasPrice(input.signal),
    input.rpc.getNativeTransferCostConfig(input.signal),
    input.rpc.getFungibleTokenBalance(WRAP_NEAR_CONTRACT_ID, signerId, input.signal),
    input.rpc.isFungibleTokenAccountRegistered(WRAP_NEAR_CONTRACT_ID, signerId, input.signal),
    input.rpc.isFungibleTokenAccountRegistered(WRAP_NEAR_CONTRACT_ID, depositAddress, input.signal)
  ])
  if (sender === null) {
    throw new NearTransferError('sender-not-found', 'NEAR sender account was not found')
  }
  if (accessKey === null) {
    throw new NearTransferError(
      'access-key-not-found',
      'The derived NEAR access key is not registered'
    )
  }
  if (accessKey.permission.kind !== 'full-access') {
    throw new NearTransferError(
      'access-key-not-full-access',
      'NEAR Intents deposits require a full-access key'
    )
  }
  if (
    wrappedBalance.contractId !== WRAP_NEAR_CONTRACT_ID ||
    wrappedBalance.accountId !== signerId
  ) {
    throw new Error('wNEAR balance does not match the signer')
  }
  const wrapped = parseUnsigned(wrappedBalance.amountRaw, MAXIMUM_U128, 'wNEAR balance')
  const plan = buildNearIntentsDepositActions({
    signerId,
    depositAddress,
    amountYocto: amount,
    wrappedBalanceYocto: wrapped,
    signerRegistered,
    recipientRegistered,
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(input.wrapShortfall === undefined ? {} : { wrapShortfall: input.wrapShortfall })
  })
  const nonce = parseUnsigned(accessKey.nonce, MAXIMUM_U64, 'NEAR access key nonce')
  if (nonce === MAXIMUM_U64) throw new Error('NEAR access key nonce is exhausted')
  const gasUnits = plan.actions.reduce(
    (total, action) => checkedU128(total + BigInt(action.gas), 'NEAR action gas'),
    0n
  )
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
  const storageReserve = nearAccountStorageReserveYocto(
    BigInt(sender.storageUsage),
    storageAmountPerByte
  )
  const balance = parseUnsigned(sender.amountRaw, MAXIMUM_U128, 'NEAR sender balance')
  const spendable = nearSpendableNativeYocto({
    balanceYocto: balance,
    maximumFeeYocto: maximumFee,
    storageReserveYocto: storageReserve
  })
  const maximum = nearIntentsDepositMaximumYocto({
    spendableNativeYocto: spendable,
    wrappedBalanceYocto: wrapped,
    storageDepositFeeYocto: plan.storageFeeYocto
  })
  const totalRequired = checkedU128(
    maximumFee + storageReserve + plan.nativeAttachedYocto,
    'NEAR total debit'
  )
  if (amount > maximum || totalRequired > balance) {
    throw new NearTransferError(
      'insufficient-funds',
      formatNearBalanceShortage(balance.toString(), totalRequired.toString())
    )
  }
  const actions = Object.freeze(plan.actions.map(encodeAction))
  const transferMemo = plan.actions.at(-1)?.args.memo
  return Object.freeze({
    kind: 'intents-deposit' as const,
    chainId: chainId.id,
    accountIndex,
    assetId,
    signerId,
    publicKey,
    recipientId: depositAddress,
    tokenContractId: WRAP_NEAR_CONTRACT_ID,
    amountRaw: amount.toString(),
    ...(typeof transferMemo === 'string' ? { memo: transferMemo } : {}),
    wrapAmountYocto: plan.wrapAmountYocto.toString(),
    storageFeeYocto: plan.storageFeeYocto.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: Object.freeze({
      chainId: chainId.id,
      accountIndex,
      signerId,
      receiverId: plan.receiverId,
      nonce: (nonce + 1n).toString(),
      blockHash: accessKey.blockHash,
      actions
    })
  })
}

export function parsePreparedNearIntentsDeposit(value: unknown): PreparedNearIntentsDeposit {
  const record = readRecord(value, 'Prepared NEAR Intents deposit')
  const required = [
    'kind',
    'chainId',
    'accountIndex',
    'assetId',
    'signerId',
    'publicKey',
    'recipientId',
    'tokenContractId',
    'amountRaw',
    'wrapAmountYocto',
    'storageFeeYocto',
    'estimatedFeeYocto',
    'maximumFeeYocto',
    'storageReserveYocto',
    'totalRequiredYocto',
    'transaction'
  ]
  const hasMemo = Object.prototype.hasOwnProperty.call(record, 'memo')
  assertExactKeys(
    record,
    hasMemo ? [...required.slice(0, 9), 'memo', ...required.slice(9)] : required,
    'Prepared NEAR Intents deposit'
  )
  if (
    record.kind !== 'intents-deposit' ||
    typeof record.chainId !== 'string' ||
    typeof record.assetId !== 'string' ||
    (hasMemo && (typeof record.memo !== 'string' || record.memo.length === 0)) ||
    record.tokenContractId !== WRAP_NEAR_CONTRACT_ID
  ) {
    throw new Error('Invalid prepared NEAR Intents deposit')
  }
  const chain = parseChainId(record.chainId)
  if (chain.id !== MAINNET_CHAIN_ID) {
    throw new Error('Prepared NEAR Intents deposit requires NEAR mainnet')
  }
  const accountIndex = parseAccountIndex(record.accountIndex)
  const signerId = parseNearAccountId(record.signerId, 'NEAR signer account ID')
  const publicKey = parseNearPublicKey(record.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const recipientId = parseNearAccountId(record.recipientId, 'NEAR Intents deposit address')
  const asset = parseAssetId(record.assetId)
  if (
    asset.chainId !== chain.id ||
    asset.namespace !== 'nep141' ||
    asset.reference !== WRAP_NEAR_CONTRACT_ID
  ) {
    throw new Error('Prepared NEAR Intents deposit asset must be wNEAR')
  }
  const amount = parseUnsigned(record.amountRaw, MAXIMUM_U128, 'NEAR Intents deposit amount')
  if (amount === 0n) throw new Error('NEAR Intents deposit amount must be greater than zero')
  const wrapAmount = parseUnsigned(record.wrapAmountYocto, MAXIMUM_U128, 'NEAR wrap amount')
  const storageFee = parseUnsigned(record.storageFeeYocto, MAXIMUM_U128, 'NEAR storage deposit fee')
  const estimatedFee = parseUnsigned(record.estimatedFeeYocto, MAXIMUM_U128, 'NEAR estimated fee')
  const maximumFee = parseUnsigned(record.maximumFeeYocto, MAXIMUM_U128, 'NEAR maximum fee')
  const storageReserve = parseUnsigned(
    record.storageReserveYocto,
    MAXIMUM_U128,
    'NEAR storage reserve'
  )
  const totalRequired = parseUnsigned(record.totalRequiredYocto, MAXIMUM_U128, 'NEAR total debit')
  if (
    estimatedFee > maximumFee ||
    totalRequired !==
      maximumFee + storageReserve + wrapAmount + storageFee + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  ) {
    throw new Error('Invalid prepared NEAR Intents deposit debit')
  }
  const transaction = readRecord(record.transaction, 'Prepared NEAR Intents deposit transaction')
  if (
    transaction.chainId !== chain.id ||
    transaction.accountIndex !== accountIndex ||
    transaction.signerId !== signerId ||
    transaction.receiverId !== WRAP_NEAR_CONTRACT_ID ||
    typeof transaction.nonce !== 'string' ||
    typeof transaction.blockHash !== 'string' ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length === 0
  ) {
    throw new Error('Prepared NEAR Intents deposit transaction does not match its binding')
  }
  if (parseUnsigned(transaction.nonce, MAXIMUM_U64, 'NEAR transaction nonce') === 0n) {
    throw new Error('NEAR transaction nonce must be greater than zero')
  }
  parseNearBase58(transaction.blockHash, 32, 'Prepared NEAR block hash')
  const actions = transaction.actions.map((item, index) => {
    const action = readRecord(item, `Prepared NEAR Intents deposit action ${index + 1}`)
    if (
      action.type !== 'functionCall' ||
      typeof action.methodName !== 'string' ||
      typeof action.args !== 'string' ||
      typeof action.gas !== 'string' ||
      typeof action.depositYocto !== 'string'
    ) {
      throw new Error('Invalid prepared NEAR Intents deposit action')
    }
    parseUnsigned(action.gas, MAXIMUM_U64, 'NEAR action gas')
    parseUnsigned(action.depositYocto, MAXIMUM_U128, 'NEAR action deposit')
    return Object.freeze({
      type: 'functionCall' as const,
      methodName: action.methodName,
      args: action.args,
      gas: action.gas,
      depositYocto: action.depositYocto
    })
  })
  let cursor = 0
  const isStorageAction = (action: (typeof actions)[number] | undefined, accountId: string) =>
    action?.methodName === 'storage_deposit' &&
    action.args === encodeNearFunctionArgs({ account_id: accountId, registration_only: true }) &&
    action.gas === NEAR_STORAGE_DEPOSIT_GAS.toString() &&
    action.depositYocto === NEAR_STORAGE_DEPOSIT_YOCTO.toString()
  if (isStorageAction(actions[cursor], signerId)) cursor += 1
  if (wrapAmount > 0n) {
    const wrapAction = actions[cursor]
    if (
      wrapAction?.methodName !== 'near_deposit' ||
      wrapAction.args !== encodeNearFunctionArgs({}) ||
      wrapAction.gas !== NEAR_WRAP_DEPOSIT_GAS.toString() ||
      wrapAction.depositYocto !== wrapAmount.toString()
    ) {
      throw new Error('Prepared NEAR Intents wrap action does not match its amount')
    }
    cursor += 1
  }
  if (recipientId !== signerId && isStorageAction(actions[cursor], recipientId)) cursor += 1
  const finalAction = actions.at(-1)
  if (
    finalAction?.methodName !== 'ft_transfer' ||
    finalAction.args !==
      encodeNearFunctionArgs(
        hasMemo
          ? {
              receiver_id: recipientId,
              amount: amount.toString(),
              memo: record.memo
            }
          : {
              receiver_id: recipientId,
              amount: amount.toString()
            }
      ) ||
    finalAction.gas !== NEAR_FT_TRANSFER_GAS.toString() ||
    finalAction.depositYocto !== NEAR_FT_TRANSFER_DEPOSIT_YOCTO.toString()
  ) {
    throw new Error('Prepared NEAR Intents transfer does not match its deposit')
  }
  if (cursor !== actions.length - 1) {
    throw new Error('Prepared NEAR Intents deposit action sequence is invalid')
  }
  const actualStorage = actions.reduce(
    (total, action) =>
      action.methodName === 'storage_deposit' ? total + BigInt(action.depositYocto) : total,
    0n
  )
  const actualWrap = actions.reduce(
    (total, action) =>
      action.methodName === 'near_deposit' ? total + BigInt(action.depositYocto) : total,
    0n
  )
  if (actualStorage !== storageFee || actualWrap !== wrapAmount) {
    throw new Error('Prepared NEAR Intents deposit fees do not match its actions')
  }
  return Object.freeze({
    kind: 'intents-deposit' as const,
    chainId: chain.id,
    accountIndex,
    assetId: asset.id,
    signerId,
    publicKey,
    recipientId,
    tokenContractId: WRAP_NEAR_CONTRACT_ID,
    amountRaw: amount.toString(),
    ...(hasMemo ? { memo: record.memo as string } : {}),
    wrapAmountYocto: wrapAmount.toString(),
    storageFeeYocto: storageFee.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: Object.freeze({
      chainId: chain.id,
      accountIndex,
      signerId,
      receiverId: WRAP_NEAR_CONTRACT_ID,
      nonce: transaction.nonce,
      blockHash: transaction.blockHash,
      actions: Object.freeze(actions)
    })
  })
}

function fungibleContractId(assetId: string, chainId: string): string {
  const asset = parseAssetId(assetId)
  if (asset.chainId !== chainId || asset.namespace !== 'nep141') {
    throw new Error('NEAR confidential fungible deposit asset must be a NEP-141 token')
  }
  const contractId = parseNearAccountId(
    asset.reference.replace(/%5F/gi, '_'),
    'NEAR fungible token contract ID'
  )
  if (
    contractId === WRAP_NEAR_CONTRACT_ID ||
    !isNearFungibleContractId(contractId) ||
    asset.id !== nearFungibleAssetId(chainId, contractId)
  ) {
    throw new Error('NEAR confidential fungible deposit requires a NEAR fungible token')
  }
  return contractId
}

export async function prepareNearConfidentialFungibleDeposit(
  input: PrepareNearConfidentialFungibleDepositInput
): Promise<PreparedNearConfidentialFungibleDeposit> {
  const chainId = parseChainId(input.chainId)
  if (chainId.id !== MAINNET_CHAIN_ID) {
    throw new Error('NEAR confidential fungible deposit requires NEAR mainnet')
  }
  const accountIndex = parseAccountIndex(input.accountIndex)
  const contractId = fungibleContractId(input.assetId, chainId.id)
  const assetId = nearFungibleAssetId(chainId.id, contractId)
  const signerId = parseNearAccountId(input.signerId, 'NEAR signer account ID')
  const depositAddress = parseNearAccountId(input.depositAddress, 'NEAR fungible deposit address')
  const publicKey = parseNearPublicKey(input.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const amount = parseUnsigned(input.amountRaw, MAXIMUM_U128, 'NEAR fungible deposit amount')
  if (amount === 0n) throw new Error('NEAR fungible deposit amount must be greater than zero')

  await input.rpc.assertExpectedChain(input.signal)
  const [sender, accessKey, gasPriceRaw, costs, tokenBalance, recipientRegistered] =
    await Promise.all([
      input.rpc.getAccount(signerId, input.signal),
      input.rpc.getAccessKey(signerId, publicKey, input.signal),
      input.rpc.getGasPrice(input.signal),
      input.rpc.getNativeTransferCostConfig(input.signal),
      input.rpc.getFungibleTokenBalance(contractId, signerId, input.signal),
      input.rpc.isFungibleTokenAccountRegistered(contractId, depositAddress, input.signal)
    ])
  if (sender === null) {
    throw new NearTransferError('sender-not-found', 'NEAR sender account was not found')
  }
  if (accessKey === null) {
    throw new NearTransferError(
      'access-key-not-found',
      'The derived NEAR access key is not registered'
    )
  }
  if (accessKey.permission.kind !== 'full-access') {
    throw new NearTransferError(
      'access-key-not-full-access',
      'NEAR fungible deposits require a full-access key'
    )
  }
  if (tokenBalance.contractId !== contractId || tokenBalance.accountId !== signerId) {
    throw new Error('NEAR token balance does not match the signer')
  }
  const balanceRaw = parseUnsigned(tokenBalance.amountRaw, MAXIMUM_U128, 'NEAR token balance')
  if (balanceRaw < amount) {
    throw new NearTransferError('insufficient-funds', 'NEAR token balance is insufficient')
  }
  const plan = buildNearConfidentialFungibleDepositActions({
    contractId,
    depositAddress,
    amountRaw: amount,
    recipientRegistered
  })
  const nonce = parseUnsigned(accessKey.nonce, MAXIMUM_U64, 'NEAR access key nonce')
  if (nonce === MAXIMUM_U64) throw new Error('NEAR access key nonce is exhausted')
  const gasUnits = plan.actions.reduce(
    (total, action) => checkedU128(total + BigInt(action.gas), 'NEAR action gas'),
    0n
  )
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
  const storageReserve = nearAccountStorageReserveYocto(
    BigInt(sender.storageUsage),
    storageAmountPerByte
  )
  const totalRequired = checkedU128(
    maximumFee + storageReserve + plan.nativeAttachedYocto,
    'NEAR total debit'
  )
  if (totalRequired > parseUnsigned(sender.amountRaw, MAXIMUM_U128, 'NEAR sender balance')) {
    throw new NearTransferError(
      'insufficient-funds',
      'NEAR balance cannot cover the fungible deposit fee and storage reserve'
    )
  }
  return Object.freeze({
    kind: 'confidential-ft-deposit' as const,
    chainId: chainId.id,
    accountIndex,
    assetId,
    signerId,
    publicKey,
    recipientId: depositAddress,
    tokenContractId: contractId,
    amountRaw: amount.toString(),
    storageFeeYocto: plan.storageFeeYocto.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: Object.freeze({
      chainId: chainId.id,
      accountIndex,
      signerId,
      receiverId: plan.receiverId,
      nonce: (nonce + 1n).toString(),
      blockHash: accessKey.blockHash,
      actions: Object.freeze(plan.actions.map(encodeAction))
    })
  })
}

export function parsePreparedNearConfidentialFungibleDeposit(
  value: unknown
): PreparedNearConfidentialFungibleDeposit {
  const record = readRecord(value, 'Prepared NEAR fungible deposit')
  const required = [
    'kind',
    'chainId',
    'accountIndex',
    'assetId',
    'signerId',
    'publicKey',
    'recipientId',
    'tokenContractId',
    'amountRaw',
    'storageFeeYocto',
    'estimatedFeeYocto',
    'maximumFeeYocto',
    'storageReserveYocto',
    'totalRequiredYocto',
    'transaction'
  ]
  assertExactKeys(record, required, 'Prepared NEAR fungible deposit')
  if (
    record.kind !== 'confidential-ft-deposit' ||
    typeof record.chainId !== 'string' ||
    typeof record.assetId !== 'string' ||
    typeof record.tokenContractId !== 'string'
  ) {
    throw new Error('Invalid prepared NEAR fungible deposit')
  }
  const chain = parseChainId(record.chainId)
  if (chain.id !== MAINNET_CHAIN_ID) {
    throw new Error('Prepared NEAR fungible deposit requires NEAR mainnet')
  }
  const contractId = fungibleContractId(record.assetId, chain.id)
  if (record.tokenContractId !== contractId) {
    throw new Error('Prepared NEAR fungible deposit asset does not match its contract')
  }
  const accountIndex = parseAccountIndex(record.accountIndex)
  const signerId = parseNearAccountId(record.signerId, 'NEAR signer account ID')
  const publicKey = parseNearPublicKey(record.publicKey)
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
  const recipientId = parseNearAccountId(record.recipientId, 'NEAR fungible deposit address')
  const amount = parseUnsigned(record.amountRaw, MAXIMUM_U128, 'NEAR fungible deposit amount')
  if (amount === 0n) throw new Error('NEAR fungible deposit amount must be greater than zero')
  const storageFee = parseUnsigned(record.storageFeeYocto, MAXIMUM_U128, 'NEAR storage deposit fee')
  const estimatedFee = parseUnsigned(record.estimatedFeeYocto, MAXIMUM_U128, 'NEAR estimated fee')
  const maximumFee = parseUnsigned(record.maximumFeeYocto, MAXIMUM_U128, 'NEAR maximum fee')
  const storageReserve = parseUnsigned(
    record.storageReserveYocto,
    MAXIMUM_U128,
    'NEAR storage reserve'
  )
  const totalRequired = parseUnsigned(record.totalRequiredYocto, MAXIMUM_U128, 'NEAR total debit')
  if (
    (storageFee !== 0n && storageFee !== NEAR_STORAGE_DEPOSIT_YOCTO) ||
    estimatedFee > maximumFee ||
    totalRequired !== maximumFee + storageReserve + storageFee + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  ) {
    throw new Error('Invalid prepared NEAR fungible deposit debit')
  }
  const transaction = readRecord(record.transaction, 'Prepared NEAR fungible deposit transaction')
  if (
    transaction.chainId !== chain.id ||
    transaction.accountIndex !== accountIndex ||
    transaction.signerId !== signerId ||
    transaction.receiverId !== contractId ||
    typeof transaction.nonce !== 'string' ||
    typeof transaction.blockHash !== 'string' ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length === 0
  ) {
    throw new Error('Prepared NEAR fungible deposit transaction does not match its binding')
  }
  if (parseUnsigned(transaction.nonce, MAXIMUM_U64, 'NEAR transaction nonce') === 0n) {
    throw new Error('NEAR transaction nonce must be greater than zero')
  }
  parseNearBase58(transaction.blockHash, 32, 'Prepared NEAR block hash')
  const actions = transaction.actions.map((item, index) => {
    const action = readRecord(item, `Prepared NEAR fungible deposit action ${index + 1}`)
    if (
      action.type !== 'functionCall' ||
      typeof action.methodName !== 'string' ||
      typeof action.args !== 'string' ||
      typeof action.gas !== 'string' ||
      typeof action.depositYocto !== 'string' ||
      action.methodName === 'near_deposit'
    ) {
      throw new Error('Invalid prepared NEAR fungible deposit action')
    }
    parseUnsigned(action.gas, MAXIMUM_U64, 'NEAR action gas')
    parseUnsigned(action.depositYocto, MAXIMUM_U128, 'NEAR action deposit')
    return Object.freeze({
      type: 'functionCall' as const,
      methodName: action.methodName,
      args: action.args,
      gas: action.gas,
      depositYocto: action.depositYocto
    })
  })
  let cursor = 0
  const isRecipientStorage = (action: (typeof actions)[number] | undefined) =>
    action?.methodName === 'storage_deposit' &&
    action.args === encodeNearFunctionArgs({ account_id: recipientId, registration_only: true }) &&
    action.gas === NEAR_STORAGE_DEPOSIT_GAS.toString() &&
    action.depositYocto === NEAR_STORAGE_DEPOSIT_YOCTO.toString()
  if (storageFee === NEAR_STORAGE_DEPOSIT_YOCTO) {
    if (!isRecipientStorage(actions[cursor])) {
      throw new Error('Prepared NEAR fungible deposit storage action does not match its recipient')
    }
    cursor += 1
  }
  const finalAction = actions[cursor]
  if (
    finalAction?.methodName !== 'ft_transfer' ||
    finalAction.args !==
      encodeNearFunctionArgs({
        receiver_id: recipientId,
        amount: amount.toString()
      }) ||
    finalAction.gas !== NEAR_FT_TRANSFER_GAS.toString() ||
    finalAction.depositYocto !== NEAR_FT_TRANSFER_DEPOSIT_YOCTO.toString()
  ) {
    throw new Error('Prepared NEAR fungible transfer does not match its deposit')
  }
  if (cursor !== actions.length - 1) {
    throw new Error('Prepared NEAR fungible deposit action sequence is invalid')
  }
  const actualStorage = actions.reduce(
    (total, action) =>
      action.methodName === 'storage_deposit' ? total + BigInt(action.depositYocto) : total,
    0n
  )
  if (actualStorage !== storageFee) {
    throw new Error('Prepared NEAR fungible deposit fees do not match its actions')
  }
  return Object.freeze({
    kind: 'confidential-ft-deposit' as const,
    chainId: chain.id,
    accountIndex,
    assetId: nearFungibleAssetId(chain.id, contractId),
    signerId,
    publicKey,
    recipientId,
    tokenContractId: contractId,
    amountRaw: amount.toString(),
    storageFeeYocto: storageFee.toString(),
    estimatedFeeYocto: estimatedFee.toString(),
    maximumFeeYocto: maximumFee.toString(),
    storageReserveYocto: storageReserve.toString(),
    totalRequiredYocto: totalRequired.toString(),
    transaction: Object.freeze({
      chainId: chain.id,
      accountIndex,
      signerId,
      receiverId: contractId,
      nonce: transaction.nonce,
      blockHash: transaction.blockHash,
      actions: Object.freeze(actions)
    })
  })
}

export function parsePreparedNearConfidentialDeposit(
  value: unknown
): PreparedNearConfidentialDeposit {
  const record = readRecord(value, 'Prepared NEAR confidential deposit')
  if (record.kind === 'confidential-ft-deposit') {
    return parsePreparedNearConfidentialFungibleDeposit(record)
  }
  return parsePreparedNearIntentsDeposit(value)
}
