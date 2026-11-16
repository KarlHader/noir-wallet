import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  NearAccessKeyPermissionSummary,
  NearActionSummary
} from '@/core/keyring/domain/signing-summary'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import {
  assertExactKeys,
  assertRawEd25519AccountMatches,
  parseRawEd25519Account,
  parseRawPreparedValue,
  parseRawSignedNearMessage,
  parseRawSignedNearTransaction,
  readArray,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  readUnsignedDecimal,
  type RawDerivedEd25519Account,
  type UnknownRecord
} from './raw-wallet-engine'
import {
  canonicalContent,
  decodeBase64,
  MAX_SIGNING_ACCOUNT_INDEX,
  preparedCommand,
  sha256,
  utf8Bytes
} from './signing-adapter-common'

export type NearSigningPreparePayload =
  | Readonly<{
      kind: 'near-transaction'
      chainId: ChainId
      accountIndex: number
      transaction: UnknownRecord
    }>
  | Readonly<{
      kind: 'near-nep413-message'
      chainId: ChainId
      accountIndex: number
      request: UnknownRecord
    }>

export type NearPendingSigningKind = NearSigningPreparePayload['kind']

export interface AdaptedNearPreparedSigning {
  readonly rawRequestId: number
  readonly kind: NearPendingSigningKind
  readonly account: RawDerivedEd25519Account
  readonly prepared: PreparedSigningCommand
}

function readChainId(value: unknown): ChainId {
  const chainId = readString(value, 'chainId', 64)
  if (chainId !== 'near:mainnet' && chainId !== 'near:testnet') {
    throw new Error('Unsupported near chain ID')
  }
  return chainId as ChainId
}

function readCanonicalBase64(value: unknown, label: string, maximum: number): string {
  const parsed = readString(value, label, maximum)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  return parsed
}

export function parseNearSigningPreparePayload(value: unknown): NearSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  const kind = readLiteral(
    record.kind,
    ['near-transaction', 'near-nep413-message'],
    'signing.prepare kind'
  )
  if (kind === 'near-transaction') {
    assertExactKeys(record, ['kind', 'chainId', 'accountIndex', 'transaction'], [], 'payload')
    const chainId = readChainId(record.chainId)
    const transaction = readRecord(record.transaction, 'transaction')
    assertExactKeys(
      transaction,
      ['chainId', 'accountIndex', 'signerId', 'receiverId', 'nonce', 'blockHash', 'actions'],
      [],
      'transaction'
    )
    const accountIndex = readSafeInteger(
      record.accountIndex,
      'accountIndex',
      MAX_SIGNING_ACCOUNT_INDEX
    )
    if (transaction.chainId !== chainId || transaction.accountIndex !== accountIndex) {
      throw new Error('NEAR transaction account binding does not match the command')
    }
    readArray(
      transaction.actions,
      'transaction.actions',
      item => readRecord(item, 'NEAR action'),
      100
    )
    return Object.freeze({ kind, chainId, accountIndex, transaction: Object.freeze(transaction) })
  }
  assertExactKeys(record, ['kind', 'chainId', 'accountIndex', 'request'], [], 'payload')
  const chainId = readChainId(record.chainId)
  const request = readRecord(record.request, 'request')
  assertExactKeys(
    request,
    [
      'chainId',
      'accountIndex',
      'accountId',
      'message',
      'recipient',
      'nonce',
      'callbackUrl',
      'state'
    ],
    [],
    'request'
  )
  const accountIndex = readSafeInteger(
    record.accountIndex,
    'accountIndex',
    MAX_SIGNING_ACCOUNT_INDEX
  )
  if (request.chainId !== chainId || request.accountIndex !== accountIndex) {
    throw new Error('NEAR message account binding does not match the command')
  }
  return Object.freeze({ kind, chainId, accountIndex, request: Object.freeze(request) })
}

function nearPermission(value: unknown): NearAccessKeyPermissionSummary {
  const record = readRecord(value, 'NEAR permission')
  const type = readLiteral(record.type, ['fullAccess', 'functionCall'], 'permission.type')
  if (type === 'fullAccess') {
    assertExactKeys(record, ['type'], [], 'permission')
    return Object.freeze({ kind: 'full-access' })
  }
  assertExactKeys(record, ['type', 'allowanceYocto', 'receiverId', 'methodNames'], [], 'permission')
  return Object.freeze({
    kind: 'function-call',
    allowanceYocto:
      record.allowanceYocto === null
        ? null
        : readUnsignedDecimal(record.allowanceYocto, 'allowanceYocto'),
    receiverId: readString(record.receiverId, 'receiverId', 128),
    methodNames: readArray(
      record.methodNames,
      'methodNames',
      item => readString(item, 'methodName', 256),
      100
    )
  })
}

async function nearAction(value: unknown): Promise<NearActionSummary> {
  const record = readRecord(value, 'NEAR action')
  const type = readLiteral(
    record.type,
    [
      'createAccount',
      'deployContract',
      'functionCall',
      'transfer',
      'stake',
      'addKey',
      'deleteKey',
      'deleteAccount'
    ],
    'action.type'
  )
  switch (type) {
    case 'createAccount':
      assertExactKeys(record, ['type'], [], 'action')
      return Object.freeze({ kind: 'create-account' })
    case 'deployContract':
      assertExactKeys(record, ['type', 'codeSha256', 'codeByteLength'], [], 'action')
      return Object.freeze({
        kind: 'deploy-contract',
        code: {
          sha256: readString(record.codeSha256, 'codeSha256', 66).replace(/^0x/, ''),
          byteLength: readSafeInteger(record.codeByteLength, 'codeByteLength', 4 * 1024 * 1024)
        }
      })
    case 'functionCall': {
      assertExactKeys(
        record,
        [
          'type',
          'methodName',
          'args',
          'argsSha256',
          'argsByteLength',
          'argsUtf8Preview',
          'argsPreviewTruncated',
          'gas',
          'depositYocto'
        ],
        [],
        'action'
      )
      const args = readCanonicalBase64(record.args, 'args', 2 * 1024 * 1024)
      return Object.freeze({
        kind: 'function-call',
        methodName: readString(record.methodName, 'methodName', 256),
        args: await canonicalContent(decodeBase64(args), 'base64'),
        gas: readUnsignedDecimal(record.gas, 'gas'),
        depositYocto: readUnsignedDecimal(record.depositYocto, 'depositYocto')
      })
    }
    case 'transfer':
      assertExactKeys(record, ['type', 'depositYocto'], [], 'action')
      return Object.freeze({
        kind: 'transfer',
        depositYocto: readUnsignedDecimal(record.depositYocto, 'depositYocto')
      })
    case 'stake':
      assertExactKeys(record, ['type', 'stakeYocto', 'publicKey'], [], 'action')
      return Object.freeze({
        kind: 'stake',
        stakeYocto: readUnsignedDecimal(record.stakeYocto, 'stakeYocto'),
        publicKey: readString(record.publicKey, 'publicKey', 128)
      })
    case 'addKey':
      assertExactKeys(record, ['type', 'publicKey', 'nonce', 'permission'], [], 'action')
      return Object.freeze({
        kind: 'add-key',
        publicKey: readString(record.publicKey, 'publicKey', 128),
        nonce: readUnsignedDecimal(record.nonce, 'nonce'),
        permission: nearPermission(record.permission)
      })
    case 'deleteKey':
      assertExactKeys(record, ['type', 'publicKey'], [], 'action')
      return Object.freeze({
        kind: 'delete-key',
        publicKey: readString(record.publicKey, 'publicKey', 128)
      })
    case 'deleteAccount':
      assertExactKeys(record, ['type', 'beneficiaryId'], [], 'action')
      return Object.freeze({
        kind: 'delete-account',
        beneficiaryId: readString(record.beneficiaryId, 'beneficiaryId', 128)
      })
  }
}

async function adaptNearTransaction(
  raw: unknown,
  payload: Extract<NearSigningPreparePayload, { kind: 'near-transaction' }>,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedNearPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedNearTransaction')
  assertExactKeys(
    prepared.value,
    ['requestId', 'account', 'transactionHash', 'summary'],
    [],
    'prepared'
  )
  const account = parseRawEd25519Account(prepared.value.account, 'near')
  assertRawEd25519AccountMatches(account, 'near', payload.chainId, payload.accountIndex, imported)
  const rawSummary = readRecord(prepared.value.summary, 'PreparedNearTransaction.summary')
  assertExactKeys(
    rawSummary,
    [
      'chainId',
      'signerId',
      'receiverId',
      'signingPublicKey',
      'signingImplicitAccountId',
      'accountKeyBinding',
      'nonce',
      'blockHash',
      'transactionHash',
      'totalDepositYocto',
      'actions'
    ],
    [],
    'NEAR summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.signingPublicKey !== account.publicKey ||
    rawSummary.signingImplicitAccountId !== account.address
  ) {
    throw new Error('Prepared NEAR transaction signer does not match')
  }
  const actions = await Promise.all(
    readArray(rawSummary.actions, 'actions', item => item, 100).map(nearAction)
  )
  const summary = parseSigningSummary(
    {
      schema: 'near.transaction.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        signerId: rawSummary.signerId,
        publicKey: account.publicKey,
        nonce: rawSummary.nonce,
        receiverId: rawSummary.receiverId,
        blockHash: rawSummary.blockHash,
        actions
      }
    },
    { family: 'near', chainId: payload.chainId, operation: 'transaction' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'transaction',
      summary,
      await sha256(utf8Bytes(JSON.stringify(payload.transaction))),
      expiresAt
    )
  })
}

async function adaptNearMessage(
  raw: unknown,
  payload: Extract<NearSigningPreparePayload, { kind: 'near-nep413-message' }>,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedNearPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedNearMessage')
  assertExactKeys(prepared.value, ['requestId', 'account', 'summary'], [], 'prepared')
  const account = parseRawEd25519Account(prepared.value.account, 'near')
  assertRawEd25519AccountMatches(account, 'near', payload.chainId, payload.accountIndex, imported)
  const rawSummary = readRecord(prepared.value.summary, 'PreparedNearMessage.summary')
  assertExactKeys(
    rawSummary,
    [
      'chainId',
      'accountId',
      'publicKey',
      'signingImplicitAccountId',
      'accountKeyBinding',
      'message',
      'recipient',
      'nonce',
      'callbackUrl',
      'state',
      'signingHash',
      'requiresFullAccessKey'
    ],
    [],
    'NEAR message summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.publicKey !== account.publicKey ||
    rawSummary.signingImplicitAccountId !== account.address
  )
    throw new Error('Prepared NEAR message signer does not match')
  const messageBytes = utf8Bytes(readString(rawSummary.message, 'message', 256 * 1024))
  const message = await canonicalContent(messageBytes, 'utf8')
  const summary = parseSigningSummary(
    {
      schema: 'near.nep413-message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: { level: 'standard', issues: [] },
      fields: {
        signerId: rawSummary.accountId,
        publicKey: account.publicKey,
        message,
        nonceBase64: rawSummary.nonce,
        recipient: rawSummary.recipient,
        callbackUrl: rawSummary.callbackUrl
      }
    },
    { family: 'near', chainId: payload.chainId, operation: 'message' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'message',
      summary,
      await sha256(utf8Bytes(JSON.stringify(payload.request))),
      expiresAt
    )
  })
}

export async function adaptNearPreparedSigning(
  raw: unknown,
  payload: NearSigningPreparePayload,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedNearPreparedSigning> {
  switch (payload.kind) {
    case 'near-transaction':
      return adaptNearTransaction(raw, payload, commandId, expiresAt, imported)
    case 'near-nep413-message':
      return adaptNearMessage(raw, payload, commandId, expiresAt, imported)
  }
}

export function adaptNearSignedResult(
  kind: NearPendingSigningKind,
  raw: unknown,
  account: RawDerivedEd25519Account
): SigningResult {
  switch (kind) {
    case 'near-transaction': {
      const signed = parseRawSignedNearTransaction(raw)
      return Object.freeze({
        kind: 'signed-payload',
        payload: Object.freeze({ encoding: 'base64', value: signed.signedTransaction }),
        transactionId: signed.transactionHash
      })
    }
    case 'near-nep413-message': {
      const signed = parseRawSignedNearMessage(raw)
      if (signed.publicKey !== account.publicKey)
        throw new Error('NEAR signed message public key mismatch')
      return Object.freeze({
        kind: 'signature',
        signature: Object.freeze({ encoding: 'base64', value: signed.signature }),
        publicKey: signed.publicKey,
        address: signed.accountId
      })
    }
  }
}
