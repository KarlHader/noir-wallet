import * as transactions from 'near-api-js/lib/transaction.js'
import * as utils from 'near-api-js/lib/utils/index.js'
import {
  parseSigningSummary,
  type NearNep413MessageSummary,
  type NearTransactionSummary
} from '@/core/keyring/domain'
import { parseNearAccountId, parseNearBase58, parseNearPublicKey } from '@/core/chains/near'
import { bytesToBase64, base64ToBytes } from '@/lib/bytes'
import { canonicalContent } from './signing-adapter-common'
import type {
  NearMessageSigningPreparePayload,
  NearTransactionSigningPreparePayload
} from './near-signing-client'

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
  return value
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export interface LedgerNearPreparedPayload {
  readonly payloadBase64: string
  readonly summary: NearTransactionSummary | NearNep413MessageSummary
}

export async function buildLedgerNearTransaction(
  payload: NearTransactionSigningPreparePayload,
  registeredPublicKey: string,
  registeredAccountId: string
): Promise<LedgerNearPreparedPayload> {
  const transaction = record(payload.transaction, 'NEAR transaction')
  const signerId = parseNearAccountId(transaction.signerId)
  if (
    signerId !== registeredAccountId ||
    transaction.chainId !== payload.chainId ||
    transaction.accountIndex !== payload.accountIndex
  ) {
    throw new Error('NEAR transaction does not match the registered Ledger account')
  }
  const receiverId = parseNearAccountId(transaction.receiverId)
  const nonce = decimal(transaction.nonce, 'NEAR nonce')
  const blockHash = parseNearBase58(transaction.blockHash, 32, 'NEAR block hash')
  const publicKey = parseNearPublicKey(registeredPublicKey)
  if (
    !Array.isArray(transaction.actions) ||
    transaction.actions.length === 0 ||
    transaction.actions.length > 100
  ) {
    throw new Error('Invalid NEAR actions')
  }
  const actions: transactions.Action[] = []
  const actionSummaries: NearTransactionSummary['fields']['actions'][number][] = []
  for (const value of transaction.actions) {
    const action = record(value, 'NEAR action')
    if (action.type === 'transfer') {
      const depositYocto = decimal(action.depositYocto, 'NEAR transfer deposit')
      actions.push(transactions.transfer(BigInt(depositYocto)))
      actionSummaries.push(Object.freeze({ kind: 'transfer', depositYocto }))
    } else if (action.type === 'functionCall') {
      const methodName = text(action.methodName, 'NEAR method')
      const args = base64ToBytes(text(action.args, 'NEAR function args'))
      const gas = decimal(action.gas, 'NEAR gas')
      const depositYocto = decimal(action.depositYocto, 'NEAR function deposit')
      actions.push(transactions.functionCall(methodName, args, BigInt(gas), BigInt(depositYocto)))
      actionSummaries.push(
        Object.freeze({
          kind: 'function-call',
          methodName,
          args: await canonicalContent(args, 'base64'),
          gas,
          depositYocto
        })
      )
    } else {
      throw new Error('Ledger NEAR does not support this action')
    }
  }
  const unsigned = transactions.createTransaction(
    signerId,
    utils.PublicKey.from(publicKey),
    receiverId,
    BigInt(nonce),
    actions,
    utils.serialize.base_decode(blockHash)
  )
  const encoded = transactions.encodeTransaction(unsigned)
  const summary = parseSigningSummary(
    {
      schema: 'near.transaction.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        signerId,
        publicKey,
        nonce,
        receiverId,
        blockHash,
        actions: actionSummaries
      }
    },
    { family: 'near', chainId: payload.chainId, operation: 'transaction' }
  ) as NearTransactionSummary
  return Object.freeze({ payloadBase64: bytesToBase64(encoded), summary })
}

const NEP413_SCHEMA = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' }
  }
} as const

export async function buildLedgerNearMessage(
  payload: NearMessageSigningPreparePayload,
  registeredPublicKey: string,
  registeredAccountId: string
): Promise<LedgerNearPreparedPayload> {
  const request = record(payload.request, 'NEAR message')
  const accountId = parseNearAccountId(request.accountId)
  if (
    accountId !== registeredAccountId ||
    request.chainId !== payload.chainId ||
    request.accountIndex !== payload.accountIndex
  ) {
    throw new Error('NEAR message does not match the registered Ledger account')
  }
  const message = text(request.message, 'NEAR message')
  const recipient = text(request.recipient, 'NEAR recipient')
  const nonceBase64 = text(request.nonce, 'NEAR nonce')
  const nonce = base64ToBytes(nonceBase64)
  if (nonce.byteLength !== 32 || bytesToBase64(nonce) !== nonceBase64) {
    throw new Error('NEAR message nonce must be 32 canonical bytes')
  }
  const callbackUrl =
    request.callbackUrl === null ? null : text(request.callbackUrl, 'NEAR callback URL')
  const encoded = utils.serialize.serialize(NEP413_SCHEMA, {
    message,
    nonce: [...nonce],
    recipient,
    callbackUrl
  })
  const prefix = new Uint8Array([0x9d, 0x01, 0x00, 0x80])
  const signedPayload = new Uint8Array(prefix.byteLength + encoded.byteLength)
  signedPayload.set(prefix)
  signedPayload.set(encoded, prefix.byteLength)
  const summary = parseSigningSummary(
    {
      schema: 'near.nep413-message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: { level: 'standard', issues: [] },
      fields: {
        signerId: accountId,
        publicKey: parseNearPublicKey(registeredPublicKey),
        message: await canonicalContent(new TextEncoder().encode(message), 'utf8'),
        nonceBase64,
        recipient,
        callbackUrl
      }
    },
    { family: 'near', chainId: payload.chainId, operation: 'message' }
  ) as NearNep413MessageSummary
  return Object.freeze({ payloadBase64: bytesToBase64(signedPayload), summary })
}

export async function ledgerNearSignedTransaction(
  payloadBase64: string,
  signatureBase64: string
): Promise<{ readonly signedTransactionBase64: string; readonly transactionHash: string }> {
  const unsignedBytes = base64ToBytes(payloadBase64)
  const signatureBytes = base64ToBytes(signatureBase64)
  const unsigned = transactions.Transaction.decode(unsignedBytes)
  if (signatureBytes.byteLength !== 64 || !unsigned.publicKey.ed25519Key) {
    throw new Error('Invalid Ledger NEAR signed transaction')
  }
  const signed = new transactions.SignedTransaction({
    transaction: unsigned,
    signature: new transactions.Signature({
      keyType: utils.key_pair.KeyType.ED25519,
      data: signatureBytes
    })
  })
  const transactionHashBytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(unsignedBytes))
  )
  return Object.freeze({
    signedTransactionBase64: bytesToBase64(transactions.encodeTransaction(signed)),
    transactionHash: utils.serialize.base_encode(transactionHashBytes)
  })
}
