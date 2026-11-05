import type {
  NoirPublicAccount,
  NoirPublicFunctionCallRequest
} from '@/core/services/noir-protocol/public/types'
import type { PublicConnectApprovalData } from '@/background/pending-requests'
import Big from '@/lib/big'
import {
  parsePublicFunctionCallRequests,
  assertPublicJsonMessage,
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

export interface NoirPublicMessageReview {
  readonly account: NoirPublicAccount
  readonly message: string
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
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function account(value: unknown): value is NoirPublicAccount {
  return (
    record(value) &&
    value.chain === 'zcash-l2' &&
    value.network === 'mainnet' &&
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0 &&
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

export function parsePublicConnectReview(value: unknown): PublicConnectApprovalData | null {
  if (
    !record(value) ||
    !account(value.account) ||
    typeof value.accountLabel !== 'string' ||
    value.accountLabel.trim().length === 0 ||
    value.accountLabel.length > 128 ||
    typeof value.linksIdentities !== 'boolean' ||
    (value.nativeAccount !== undefined &&
      (!record(value.nativeAccount) ||
        typeof value.nativeAccount.address !== 'string' ||
        value.nativeAccount.address.length === 0 ||
        value.nativeAccount.address.length > 256))
  )
    return null
  return {
    account: value.account,
    accountLabel: value.accountLabel,
    linksIdentities: value.linksIdentities,
    ...(value.nativeAccount === undefined
      ? {}
      : { nativeAccount: { address: (value.nativeAccount as { address: string }).address } })
  }
}

export function parsePublicMessageReview(value: unknown): NoirPublicMessageReview | null {
  if (
    !record(value) ||
    !account(value.account) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 100_000
  )
    return null

  try {
    assertPublicJsonMessage(value.message)
  } catch {
    return null
  }
  return { account: value.account, message: value.message }
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
  return {
    account: value.account,
    amount: value.amount,
    fee: value.fee,
    creationFee: value.creationFee,
    expectedCredit: value.expectedCredit,
    depositAddress: value.depositAddress,
    expiresAt: value.expiresAt,
    totalPayment: new Big(value.amount).plus(value.fee).toFixed()
  }
}
