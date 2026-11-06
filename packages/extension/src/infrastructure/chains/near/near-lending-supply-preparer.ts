import {
  nearPublicKeyFromImplicitAccountId,
  parseNearAccountId,
  parseNearBase58,
  parseNearPublicKey
} from '@/core/chains/near'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseNearLendingSupplyBinding } from '@/core/chains/near/near-burrow-supply-binding'
import { encodeNearFunctionArgs } from './near-rpc-codecs'
import type { NearTransferTransaction } from './near-transfer-preparer'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n
const STORAGE_DEPOSIT_GAS = 50_000_000_000_000n
const WRAP_NEAR_GAS = 50_000_000_000_000n
const LENDING_TRANSFER_GAS = 250_000_000_000_000n

export interface PreparedNearLendingSupply {
  readonly kind: 'lending-supply'
  readonly chainId: string
  readonly accountIndex: number
  readonly assetId: string
  readonly sourceKind: 'native' | 'token'
  readonly signerId: string
  readonly publicKey: string
  readonly recipientId: string
  readonly tokenContractId: string
  readonly amountRaw: string
  readonly customRecipientMsg: string
  readonly estimatedFeeYocto: string
  readonly maximumFeeYocto: string
  readonly storageReserveYocto: string
  readonly protocolDepositYocto: string
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

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertSigner(signerId: string, publicKey: string): void {
  if (
    /^[0-9a-f]{64}$/.test(signerId) &&
    nearPublicKeyFromImplicitAccountId(signerId) !== publicKey
  ) {
    throw new Error('NEAR signer does not match its public key')
  }
}

export function parsePreparedNearLendingSupply(value: unknown): PreparedNearLendingSupply {
  const record = readRecord(value, 'Prepared NEAR Lending Supply')
  const required = [
    'kind',
    'chainId',
    'accountIndex',
    'assetId',
    'sourceKind',
    'signerId',
    'publicKey',
    'recipientId',
    'tokenContractId',
    'amountRaw',
    'customRecipientMsg',
    'estimatedFeeYocto',
    'maximumFeeYocto',
    'storageReserveYocto',
    'protocolDepositYocto',
    'totalRequiredYocto',
    'transaction'
  ]
  if (
    Object.keys(record).length !== required.length ||
    !required.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    record.kind !== 'lending-supply' ||
    (record.sourceKind !== 'native' && record.sourceKind !== 'token') ||
    typeof record.chainId !== 'string' ||
    typeof record.assetId !== 'string'
  ) {
    throw new Error('Invalid prepared NEAR Lending Supply')
  }
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'near') {
    throw new Error('Prepared NEAR Lending Supply requires a NEAR chain')
  }
  const accountIndex = parseAccountIndex(record.accountIndex)
  const signerId = parseNearAccountId(record.signerId)
  const publicKey = parseNearPublicKey(record.publicKey)
  assertSigner(signerId, publicKey)
  const binding = parseNearLendingSupplyBinding(
    {
      tokenContractId: record.tokenContractId,
      recipientId: record.recipientId,
      customRecipientMsg: record.customRecipientMsg
    },
    signerId
  )
  const asset = parseAssetId(record.assetId)
  if (asset.chainId !== chain.id) throw new Error('Prepared NEAR Lending asset has the wrong chain')
  if (
    (record.sourceKind === 'native' &&
      !(asset.namespace === 'slip44' && asset.reference === '397')) ||
    (record.sourceKind === 'token' &&
      (asset.namespace !== 'nep141' ||
        asset.reference.replace(/%5F/gi, '_') !== binding.tokenContractId))
  ) {
    throw new Error('Prepared NEAR Lending asset does not match its source kind')
  }
  const amountRaw = parseUnsigned(record.amountRaw, MAXIMUM_U128, 'NEAR Supply amount').toString()
  if (amountRaw === '0') throw new Error('NEAR Supply amount must be greater than zero')
  const estimatedFeeYocto = parseUnsigned(
    record.estimatedFeeYocto,
    MAXIMUM_U128,
    'NEAR estimated fee'
  ).toString()
  const maximumFeeYocto = parseUnsigned(
    record.maximumFeeYocto,
    MAXIMUM_U128,
    'NEAR maximum fee'
  ).toString()
  const storageReserveYocto = parseUnsigned(
    record.storageReserveYocto,
    MAXIMUM_U128,
    'NEAR storage reserve'
  ).toString()
  const protocolDepositYocto = parseUnsigned(
    record.protocolDepositYocto,
    MAXIMUM_U128,
    'NEAR protocol deposit'
  ).toString()
  const totalRequiredYocto = parseUnsigned(
    record.totalRequiredYocto,
    MAXIMUM_U128,
    'NEAR total debit'
  ).toString()
  if (
    BigInt(estimatedFeeYocto) > BigInt(maximumFeeYocto) ||
    BigInt(totalRequiredYocto) !==
      BigInt(maximumFeeYocto) + BigInt(storageReserveYocto) + BigInt(protocolDepositYocto)
  ) {
    throw new Error('Invalid prepared NEAR Lending debit')
  }
  const transaction = readRecord(record.transaction, 'Prepared NEAR Lending transaction')
  if (
    transaction.chainId !== chain.id ||
    transaction.accountIndex !== accountIndex ||
    transaction.signerId !== signerId ||
    transaction.receiverId !== binding.tokenContractId ||
    typeof transaction.nonce !== 'string' ||
    typeof transaction.blockHash !== 'string' ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length === 0
  ) {
    throw new Error('Prepared NEAR Lending transaction does not match its binding')
  }
  if (parseUnsigned(transaction.nonce, MAXIMUM_U64, 'NEAR transaction nonce') === 0n) {
    throw new Error('NEAR transaction nonce must be greater than zero')
  }
  parseNearBase58(transaction.blockHash, 32, 'Prepared NEAR block hash')
  const actions = transaction.actions.map((value, index) => {
    const action = readRecord(value, `Prepared NEAR Lending action ${index + 1}`)
    if (
      action.type !== 'functionCall' ||
      typeof action.methodName !== 'string' ||
      typeof action.args !== 'string' ||
      typeof action.gas !== 'string' ||
      typeof action.depositYocto !== 'string'
    ) {
      throw new Error('Invalid prepared NEAR Lending action')
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
  const signerStorageArgs = encodeNearFunctionArgs({
    account_id: signerId,
    registration_only: true
  })
  const recipientStorageArgs = encodeNearFunctionArgs({
    account_id: binding.recipientId,
    registration_only: true
  })
  const isStorageAction = (action: (typeof actions)[number] | undefined, args: string) =>
    action?.methodName === 'storage_deposit' &&
    action.args === args &&
    action.gas === STORAGE_DEPOSIT_GAS.toString() &&
    action.depositYocto === STORAGE_DEPOSIT_YOCTO.toString()
  if (record.sourceKind === 'native' && isStorageAction(actions[cursor], signerStorageArgs)) {
    cursor += 1
  }
  if (record.sourceKind === 'native') {
    const wrapAction = actions[cursor]
    if (
      wrapAction?.methodName !== 'near_deposit' ||
      wrapAction.args !== encodeNearFunctionArgs({}) ||
      wrapAction.gas !== WRAP_NEAR_GAS.toString() ||
      wrapAction.depositYocto !== amountRaw
    ) {
      throw new Error('Prepared NEAR Lending wrap action does not match its amount')
    }
    cursor += 1
  }
  if (binding.recipientId !== signerId && isStorageAction(actions[cursor], recipientStorageArgs)) {
    cursor += 1
  }
  const finalAction = actions.at(-1)
  const expectedFinalArgs = encodeNearFunctionArgs({
    receiver_id: binding.recipientId,
    amount: amountRaw,
    msg: binding.customRecipientMsg
  })
  if (
    finalAction?.methodName !== 'ft_transfer_call' ||
    finalAction.args !== expectedFinalArgs ||
    finalAction.gas !== LENDING_TRANSFER_GAS.toString() ||
    finalAction.depositYocto !== '1'
  ) {
    throw new Error('Prepared NEAR Lending transfer call does not match its binding')
  }
  if (cursor !== actions.length - 1) {
    throw new Error('Prepared NEAR Lending action sequence is invalid')
  }
  const actualProtocolDeposit = actions.reduce(
    (total, action) => total + BigInt(action.depositYocto),
    0n
  )
  if (actualProtocolDeposit.toString() !== protocolDepositYocto) {
    throw new Error('Prepared NEAR Lending protocol deposit does not match its actions')
  }
  return Object.freeze({
    kind: 'lending-supply' as const,
    chainId: chain.id,
    accountIndex,
    assetId: asset.id,
    sourceKind: record.sourceKind,
    signerId,
    publicKey,
    recipientId: binding.recipientId,
    tokenContractId: binding.tokenContractId,
    amountRaw,
    customRecipientMsg: binding.customRecipientMsg,
    estimatedFeeYocto,
    maximumFeeYocto,
    storageReserveYocto,
    protocolDepositYocto,
    totalRequiredYocto,
    transaction: Object.freeze({
      chainId: chain.id,
      accountIndex,
      signerId,
      receiverId: binding.tokenContractId,
      nonce: transaction.nonce,
      blockHash: transaction.blockHash,
      actions: Object.freeze(actions)
    })
  })
}
