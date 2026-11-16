import type {
  NearAccessKeyPermissionSummary,
  NearActionSummary,
  NearNep413MessageSummary,
  NearTransactionSummary,
  SigningSummary
} from './signing-summary'
import { parseNearAccountId, parseNearPublicKey } from '@/core/chains/near'
import {
  assertExactKeys,
  assertOpaqueContentReview,
  assertReviewIssuesAllowed,
  readArray,
  readBase58,
  readCanonicalContent,
  readLiteral,
  readNullableString,
  readPayloadDigest,
  readRecord,
  readSafeInteger,
  readString,
  readStringArray,
  readUnsignedDecimal,
  requireBlockedReview,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'

function readNearPermission(value: unknown, label: string): NearAccessKeyPermissionSummary {
  const record = readRecord(value, label)
  const kind = readLiteral(record.kind, ['full-access', 'function-call'], `${label}.kind`)
  if (kind === 'full-access') {
    assertExactKeys(record, ['kind'], [], label)
    return Object.freeze({ kind })
  }
  assertExactKeys(record, ['kind', 'allowanceYocto', 'receiverId', 'methodNames'], [], label)
  return Object.freeze({
    kind,
    allowanceYocto:
      record.allowanceYocto === null
        ? null
        : readUnsignedDecimal(record.allowanceYocto, `${label}.allowanceYocto`),
    receiverId: parseNearAccountId(record.receiverId, `${label}.receiverId`),
    methodNames: readStringArray(record.methodNames, `${label}.methodNames`, { allowEmpty: true })
  })
}

function readNearAction(value: unknown, index: number): NearActionSummary {
  const label = `NearTransactionSummary.fields.actions[${index}]`
  const record = readRecord(value, label)
  const kind = readLiteral(
    record.kind,
    [
      'create-account',
      'deploy-contract',
      'function-call',
      'transfer',
      'stake',
      'add-key',
      'delete-key',
      'delete-account',
      'unrecognized'
    ],
    `${label}.kind`
  )
  switch (kind) {
    case 'create-account':
      assertExactKeys(record, ['kind'], [], label)
      return Object.freeze({ kind })
    case 'deploy-contract':
      assertExactKeys(record, ['kind', 'code'], [], label)
      return Object.freeze({ kind, code: readPayloadDigest(record.code, `${label}.code`) })
    case 'function-call': {
      assertExactKeys(record, ['kind', 'methodName', 'args', 'gas', 'depositYocto'], [], label)
      const args = readCanonicalContent(record.args, `${label}.args`)
      if (args.encoding !== 'base64') throw new Error('NEAR function call args must use base64')
      return Object.freeze({
        kind,
        methodName: readString(record.methodName, `${label}.methodName`, 256),
        args,
        gas: readUnsignedDecimal(record.gas, `${label}.gas`),
        depositYocto: readUnsignedDecimal(record.depositYocto, `${label}.depositYocto`)
      })
    }
    case 'transfer':
      assertExactKeys(record, ['kind', 'depositYocto'], [], label)
      return Object.freeze({
        kind,
        depositYocto: readUnsignedDecimal(record.depositYocto, `${label}.depositYocto`)
      })
    case 'stake':
      assertExactKeys(record, ['kind', 'stakeYocto', 'publicKey'], [], label)
      return Object.freeze({
        kind,
        stakeYocto: readUnsignedDecimal(record.stakeYocto, `${label}.stakeYocto`),
        publicKey: parseNearPublicKey(record.publicKey, `${label}.publicKey`)
      })
    case 'add-key':
      assertExactKeys(record, ['kind', 'publicKey', 'nonce', 'permission'], [], label)
      return Object.freeze({
        kind,
        publicKey: parseNearPublicKey(record.publicKey, `${label}.publicKey`),
        nonce: readUnsignedDecimal(record.nonce, `${label}.nonce`),
        permission: readNearPermission(record.permission, `${label}.permission`)
      })
    case 'delete-key':
      assertExactKeys(record, ['kind', 'publicKey'], [], label)
      return Object.freeze({
        kind,
        publicKey: parseNearPublicKey(record.publicKey, `${label}.publicKey`)
      })
    case 'delete-account':
      assertExactKeys(record, ['kind', 'beneficiaryId'], [], label)
      return Object.freeze({
        kind,
        beneficiaryId: parseNearAccountId(record.beneficiaryId, `${label}.beneficiaryId`)
      })
    case 'unrecognized':
      assertExactKeys(record, ['kind', 'actionTag', 'payload'], [], label)
      return Object.freeze({
        kind,
        actionTag: readSafeInteger(record.actionTag, `${label}.actionTag`, 255),
        payload: readPayloadDigest(record.payload, `${label}.payload`)
      })
  }
}

function parseNearTransaction(envelope: ParsedSigningSummaryEnvelope): NearTransactionSummary {
  assertReviewIssuesAllowed(envelope.review, ['unrecognized-action'])
  const fields = envelope.fields
  assertExactKeys(
    fields,
    ['signerId', 'publicKey', 'nonce', 'receiverId', 'blockHash', 'actions'],
    [],
    'NearTransactionSummary.fields'
  )
  const actions = readArray(fields.actions, 'NearTransactionSummary.fields.actions', readNearAction)
  actions.forEach((action, index) => {
    if (action.kind === 'unrecognized') {
      requireBlockedReview(envelope.review, 'unrecognized-action', index)
    }
  })
  const unrecognizedIndexes = new Set(
    actions.map((action, index) => (action.kind === 'unrecognized' ? index : -1))
  )
  if (
    envelope.review.issues.some(
      issue =>
        issue.code === 'unrecognized-action' &&
        (issue.subjectIndex === undefined || !unrecognizedIndexes.has(issue.subjectIndex))
    )
  ) {
    throw new Error('Unrecognized NEAR Action review points to a readable Action')
  }
  return Object.freeze({
    schema: 'near.transaction.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      signerId: parseNearAccountId(fields.signerId, 'NearTransactionSummary.fields.signerId'),
      publicKey: parseNearPublicKey(fields.publicKey, 'NearTransactionSummary.fields.publicKey'),
      nonce: readUnsignedDecimal(fields.nonce, 'NearTransactionSummary.fields.nonce'),
      receiverId: parseNearAccountId(fields.receiverId, 'NearTransactionSummary.fields.receiverId'),
      blockHash: readBase58(fields.blockHash, 'NearTransactionSummary.fields.blockHash', 32),
      actions
    })
  })
}

function parseNearNep413Message(envelope: ParsedSigningSummaryEnvelope): NearNep413MessageSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    ['signerId', 'publicKey', 'message', 'nonceBase64', 'recipient', 'callbackUrl'],
    [],
    'NearNep413MessageSummary.fields'
  )
  const nonceBase64 = readString(
    fields.nonceBase64,
    'NearNep413MessageSummary.fields.nonceBase64',
    44
  )
  if (!/^[A-Za-z0-9+/]{43}=$/.test(nonceBase64)) {
    throw new Error('NEP-413 nonce must be canonical base64 for 32 bytes')
  }
  const callbackUrl = readNullableString(
    fields.callbackUrl,
    'NearNep413MessageSummary.fields.callbackUrl'
  )
  const message = readCanonicalContent(fields.message, 'NearNep413MessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'near.nep413-message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signerId: parseNearAccountId(fields.signerId, 'NearNep413MessageSummary.fields.signerId'),
      publicKey: parseNearPublicKey(fields.publicKey, 'NearNep413MessageSummary.fields.publicKey'),
      message,
      nonceBase64,
      recipient: readString(fields.recipient, 'NearNep413MessageSummary.fields.recipient'),
      callbackUrl
    })
  })
}

export function parseNearSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'near.transaction.v1') return parseNearTransaction(envelope)
  if (envelope.schema === 'near.nep413-message.v1') return parseNearNep413Message(envelope)
  throw new Error('Signing summary schema is not valid for NEAR')
}
