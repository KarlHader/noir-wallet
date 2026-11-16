import type {
  SigningReview,
  SigningReviewIssueCode,
  SigningSummary,
  TronContractSummary,
  TronSignMessageV2Summary,
  TronTransactionSummary
} from './signing-summary'
import {
  assertExactKeys,
  assertOpaqueContentReview,
  assertReviewIssuesAllowed,
  readArray,
  readBoolean,
  readCanonicalContent,
  readHex,
  readLiteral,
  readPayloadDigest,
  readSafeInteger,
  requireBlockedReview,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'
import {
  TRON_MAX_U256,
  readTronAddress,
  readTronContract,
  readTronUint
} from './signing-summary-validation-tron-contract'

const TRON_MAX_RAW_DATA_BYTES = 512 * 1024
const TRON_MAX_EXISTING_SIGNERS = 32
const TRON_MESSAGE_PREFIX = '\u0019TRON Signed Message:\n' as const
const TRON_REVIEW_ISSUES = [
  'unrecognized-call',
  'active-permission',
  'owner-signer-mismatch',
  'multisign',
  'token-approval',
  'unlimited-token-approval'
] as const satisfies readonly SigningReviewIssueCode[]

function hasIssue(review: SigningReview, code: SigningReviewIssueCode): boolean {
  return review.issues.some(issue => issue.code === code)
}

function requireIssue(review: SigningReview, code: SigningReviewIssueCode): void {
  if (!hasIssue(review, code)) throw new Error(`${code} must produce a review issue`)
}

function rejectIssue(review: SigningReview, code: SigningReviewIssueCode): void {
  if (hasIssue(review, code)) throw new Error(`Unexpected review issue: ${code}`)
}

function validateTransactionReview(
  review: SigningReview,
  permissionId: number,
  ownerMatchesSigner: boolean,
  existingSigners: readonly string[],
  contract: TronContractSummary
): void {
  assertReviewIssuesAllowed(review, TRON_REVIEW_ISSUES)
  if (review.issues.some(issue => issue.subjectIndex !== undefined)) {
    throw new Error('TRON review issues must not use a subject index')
  }

  if (permissionId > 0) requireIssue(review, 'active-permission')
  else rejectIssue(review, 'active-permission')

  if (ownerMatchesSigner) rejectIssue(review, 'owner-signer-mismatch')
  else requireIssue(review, 'owner-signer-mismatch')

  if (existingSigners.length > 0) requireIssue(review, 'multisign')
  else rejectIssue(review, 'multisign')

  const interpretation = contract.type === 'trigger-smart-contract' ? contract.interpretation : null
  if (interpretation?.kind === 'unrecognized') {
    requireBlockedReview(review, 'unrecognized-call')
  } else {
    rejectIssue(review, 'unrecognized-call')
  }

  const approval = interpretation?.kind === 'trc20-approve' ? interpretation : null
  if (approval) requireIssue(review, 'token-approval')
  else rejectIssue(review, 'token-approval')
  if (approval?.amountRaw === TRON_MAX_U256) requireIssue(review, 'unlimited-token-approval')
  else rejectIssue(review, 'unlimited-token-approval')
}

function parseTronTransaction(envelope: ParsedSigningSummaryEnvelope): TronTransactionSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'signer',
      'owner',
      'ownerMatchesSigner',
      'permissionId',
      'transactionId',
      'rawData',
      'refBlockBytes',
      'refBlockNum',
      'refBlockHash',
      'expirationMs',
      'timestampMs',
      'feeLimitSun',
      'memo',
      'existingSigners',
      'contract'
    ],
    [],
    'TronTransactionSummary.fields'
  )
  const signer = readTronAddress(fields.signer, 'TronTransactionSummary.fields.signer')
  const owner = readTronAddress(fields.owner, 'TronTransactionSummary.fields.owner')
  const ownerMatchesSigner = readBoolean(
    fields.ownerMatchesSigner,
    'TronTransactionSummary.fields.ownerMatchesSigner'
  )
  if (ownerMatchesSigner !== (owner === signer)) {
    throw new Error('TRON ownerMatchesSigner does not match signer and owner')
  }
  const permissionId = readSafeInteger(
    fields.permissionId,
    'TronTransactionSummary.fields.permissionId',
    0x7fffffff
  )
  const transactionId = readHex(
    fields.transactionId,
    'TronTransactionSummary.fields.transactionId',
    { bytes: 32, prefix: false }
  )
  const rawData = readPayloadDigest(fields.rawData, 'TronTransactionSummary.fields.rawData')
  if (rawData.byteLength === 0 || rawData.byteLength > TRON_MAX_RAW_DATA_BYTES) {
    throw new Error('TRON raw_data digest has an invalid byte length')
  }
  if (rawData.sha256 !== transactionId) {
    throw new Error('TRON transaction ID must equal the raw_data SHA-256')
  }
  const timestampMs = readTronUint(fields.timestampMs, 'TronTransactionSummary.fields.timestampMs')
  const expirationMs = readTronUint(
    fields.expirationMs,
    'TronTransactionSummary.fields.expirationMs'
  )
  if (timestampMs === '0' || expirationMs === '0') {
    throw new Error('TRON transaction timestamp and expiration must be positive')
  }
  if (BigInt(expirationMs) <= BigInt(timestampMs)) {
    throw new Error('TRON transaction expiration must be after its timestamp')
  }
  const memo = readCanonicalContent(fields.memo, 'TronTransactionSummary.fields.memo')
  if (memo.encoding === 'base64') throw new Error('TRON memo must use utf8 or hex content')
  const existingSigners = readArray(
    fields.existingSigners,
    'TronTransactionSummary.fields.existingSigners',
    (value, index) =>
      readTronAddress(value, `TronTransactionSummary.fields.existingSigners[${index}]`),
    { allowEmpty: true, maximum: TRON_MAX_EXISTING_SIGNERS }
  )
  if (new Set(existingSigners).size !== existingSigners.length) {
    throw new Error('TRON existing signers must be unique')
  }
  if (existingSigners.includes(signer)) {
    throw new Error('TRON selected signer must not already be present')
  }
  const contract = readTronContract(fields.contract)
  if (contract.owner !== owner) throw new Error('TRON contract owner does not match the summary')
  validateTransactionReview(
    envelope.review,
    permissionId,
    ownerMatchesSigner,
    existingSigners,
    contract
  )

  return Object.freeze({
    schema: 'tron.transaction.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      signer,
      owner,
      ownerMatchesSigner,
      permissionId,
      transactionId,
      rawData,
      refBlockBytes: readHex(fields.refBlockBytes, 'TronTransactionSummary.fields.refBlockBytes', {
        bytes: 2,
        prefix: false
      }),
      refBlockNum: readTronUint(fields.refBlockNum, 'TronTransactionSummary.fields.refBlockNum'),
      refBlockHash: readHex(fields.refBlockHash, 'TronTransactionSummary.fields.refBlockHash', {
        bytes: 8,
        prefix: false
      }),
      expirationMs,
      timestampMs,
      feeLimitSun: readTronUint(fields.feeLimitSun, 'TronTransactionSummary.fields.feeLimitSun'),
      memo,
      existingSigners,
      contract
    })
  })
}

function parseTronMessage(envelope: ParsedSigningSummaryEnvelope): TronSignMessageV2Summary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    ['signer', 'prefix', 'message', 'signingHash'],
    [],
    'TronSignMessageV2Summary.fields'
  )
  const message = readCanonicalContent(fields.message, 'TronSignMessageV2Summary.fields.message')
  if (message.byteLength === 0) throw new Error('TRON signMessageV2 message must not be empty')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'tron.sign-message-v2.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readTronAddress(fields.signer, 'TronSignMessageV2Summary.fields.signer'),
      prefix: readLiteral(fields.prefix, [TRON_MESSAGE_PREFIX], 'TRON signMessageV2 prefix'),
      message,
      signingHash: readHex(fields.signingHash, 'TronSignMessageV2Summary.fields.signingHash', {
        bytes: 32,
        prefix: false
      })
    })
  })
}

export function parseTronSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'tron.transaction.v1') return parseTronTransaction(envelope)
  if (envelope.schema === 'tron.sign-message-v2.v1') return parseTronMessage(envelope)
  throw new Error('Signing summary schema is not valid for TRON')
}
