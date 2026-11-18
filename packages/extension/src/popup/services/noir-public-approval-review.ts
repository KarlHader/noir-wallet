import type {
  NoirPublicAccount,
  NoirPublicFunctionCallRequest
} from '@/core/services/noir-protocol/public/types'
import Big from '@/lib/big'
import {
  parsePublicFunctionCallRequests,
  readPublicAccountId,
  readPublicTgas,
  readPublicDecimal
} from '@/core/services/noir-protocol/public/protocol'

export interface NoirPublicTransactionReview {
  readonly account: NoirPublicAccount
  readonly txRequests: readonly NoirPublicFunctionCallRequest[]
  readonly nonce: string
  readonly deadline: string
  readonly tgas: number
  readonly executionFee: Readonly<{
    tokenId: 'zec.omft.near'
    amountRaw: string
    recipient: string
  }>
}

export interface NoirPublicActivationReview {
  readonly account: NoirPublicAccount
  readonly amount: string
  readonly fee: string
  readonly creationFee: string
  readonly expectedCredit: string
  readonly depositAddress: string
  readonly expiresAt: number
  readonly totalPayment: string
  readonly sourceSymbol: string
  readonly chainId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function account(value: unknown): value is NoirPublicAccount {
  return (
    record(value) &&
    (value.chain === 'zcash-l2' || value.chain === 'evm') &&
    value.network === 'mainnet' &&
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0 &&
    (value.signingMode === 'derived' ||
      value.signingMode === 'legacy_index0' ||
      value.signingMode === 'evm') &&
    (value.chain === 'evm'
      ? value.signingMode === 'evm' &&
        /^0x[0-9a-f]{40}$/.test(value.publicKey) &&
        value.address === value.publicKey
      : value.signingMode !== 'evm') &&
    typeof value.address === 'string' &&
    value.address.length > 0 &&
    (value.mcaId === null || typeof value.mcaId === 'string') &&
    typeof value.parentContractId === 'string' &&
    value.parentContractId.length > 0 &&
    (value.status === 'inactive' || value.status === 'activating' || value.status === 'active')
  )
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value)
}

export function parsePublicTransactionReview(value: unknown): NoirPublicTransactionReview | null {
  if (
    !record(value) ||
    !account(value.account) ||
    value.account.status !== 'active' ||
    value.account.mcaId === null ||
    value.txRequests === undefined
  )
    return null

  try {
    if (!record(value.executionFee) || value.executionFee.tokenId !== 'zec.omft.near') return null
    const amountRaw = readPublicDecimal(value.executionFee.amountRaw, 'Public execution fee')
    if (BigInt(amountRaw) === 0n) return null
    const recipient = readPublicAccountId(value.executionFee.recipient, 'Public fee recipient')
    const txRequests = parsePublicFunctionCallRequests(value.txRequests)
    const payment = txRequests[0]?.FunctionCall
    const call = payment?.function_calls[0]
    if (
      payment?.receiver_id !== 'zec.omft.near' ||
      payment.function_calls.length !== 1 ||
      call.method_name !== 'ft_transfer' ||
      call.deposit !== '1' ||
      call.gas !== '30000000000000' ||
      call.args !== JSON.stringify({ receiver_id: recipient, amount: amountRaw })
    )
      return null
    return {
      account: value.account,
      txRequests,
      nonce: readPublicDecimal(value.nonce, 'Public nonce'),
      deadline: readPublicDecimal(value.deadline, 'Public deadline'),
      tgas: readPublicTgas(value.tgas),
      executionFee: { tokenId: 'zec.omft.near', amountRaw, recipient }
    }
  } catch {
    return null
  }
}

export function parsePublicActivationReview(value: unknown): NoirPublicActivationReview | null {
  if (
    !record(value) ||
    !account(value.account) ||
    value.account.status !== 'inactive' ||
    !decimal(value.amount) ||
    !decimal(value.fee) ||
    !decimal(value.creationFee) ||
    !decimal(value.expectedCredit) ||
    typeof value.depositAddress !== 'string' ||
    !value.depositAddress ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    return null
  if (
    value.account.chain === 'evm' &&
    (typeof value.chainId !== 'string' ||
      !/^eip155:[1-9][0-9]*$/.test(value.chainId) ||
      typeof value.sourceSymbol !== 'string' ||
      !/^[A-Za-z0-9]{1,16}$/.test(value.sourceSymbol))
  )
    return null
  return {
    account: value.account,
    amount: value.amount,
    fee: value.fee,
    creationFee: value.creationFee,
    expectedCredit: value.expectedCredit,
    depositAddress: value.depositAddress,
    expiresAt: value.expiresAt,
    totalPayment: new Big(value.amount).plus(value.fee).toFixed(),
    sourceSymbol: value.account.chain === 'evm' ? (value.sourceSymbol as string) : 'ZEC',
    ...(value.account.chain === 'evm' ? { chainId: value.chainId as string } : {})
  }
}
