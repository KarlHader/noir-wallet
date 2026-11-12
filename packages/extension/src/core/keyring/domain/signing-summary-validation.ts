import type { ChainId } from '@/core/chains/domain'
import {
  SIGNING_SUMMARY_SCHEMAS,
  type CanonicalContent,
  type PayloadDigest,
  type SigningOperation,
  type SigningReview,
  type SigningReviewIssue,
  type SigningReviewIssueCode,
  type SigningSummary,
  type SigningSummaryExpectation,
  type SigningSummaryFamily,
  type SigningSummarySchema,
  type QuantusTransferSummary
} from './signing-summary'
import { parseBitcoinSummary } from './signing-summary-validation-bitcoin'
import { parseDashSummary } from './signing-summary-validation-dash'
import { parseNearSummary } from './signing-summary-validation-near'
import { parseStarknetSummary } from './signing-summary-validation-starknet'
import { parsePearlSummary } from './signing-summary-validation-pearl'
import { parseSolanaSummary } from './signing-summary-validation-solana'
import { parseTronSummary } from './signing-summary-validation-tron'
import { parseEvmSummary, parseZcashSummary } from './signing-summary-validation-zcash-evm'

export const SIGNING_SUMMARY_LIMITS = Object.freeze({
  maxContentBytes: 131_072,
  maxItems: 128,
  maxTextLength: 16_384,
  maxTypedDataDepth: 12
})

const SCHEMAS = new Set<string>(SIGNING_SUMMARY_SCHEMAS)
const FAMILY_NAMESPACES: Readonly<Record<SigningSummaryFamily, string>> = Object.freeze({
  zcash: 'bip122',
  evm: 'eip155',
  bitcoin: 'bip122',
  dash: 'bip122',
  pearl: 'bip122',
  solana: 'solana',
  tron: 'tron',
  near: 'near',
  quantus: 'quantus',
  starknet: 'starknet'
})
const ISSUE_CODES = new Set<SigningReviewIssueCode>([
  'contract-creation',
  'external-input',
  'missing-chain-binding',
  'non-default-sighash',
  'unknown-output',
  'unrecognized-call',
  'unrecognized-instruction',
  'simulation-failed',
  'unrecognized-action',
  'active-permission',
  'owner-signer-mismatch',
  'multisign',
  'token-approval',
  'unlimited-token-approval',
  'opaque-message'
])

export const SCHEMA_EXPECTATIONS: Readonly<
  Record<
    SigningSummarySchema,
    { readonly family: SigningSummaryFamily; readonly operation: SigningOperation }
  >
> = Object.freeze({
  'zcash.transaction.v1': Object.freeze({ family: 'zcash', operation: 'transaction' }),
  'zcash.message.v1': Object.freeze({ family: 'zcash', operation: 'message' }),
  'evm.transaction.v1': Object.freeze({ family: 'evm', operation: 'transaction' }),
  'evm.personal-message.v1': Object.freeze({ family: 'evm', operation: 'message' }),
  'evm.typed-data.v1': Object.freeze({ family: 'evm', operation: 'message' }),
  'bitcoin.psbt.v1': Object.freeze({ family: 'bitcoin', operation: 'transaction' }),
  'bitcoin.bip322-message.v1': Object.freeze({ family: 'bitcoin', operation: 'message' }),
  'dash.psbt.v1': Object.freeze({ family: 'dash', operation: 'transaction' }),
  'dash.message.v1': Object.freeze({ family: 'dash', operation: 'message' }),
  'pearl.psbt.v1': Object.freeze({ family: 'pearl', operation: 'transaction' }),
  'pearl.bip322-message.v1': Object.freeze({ family: 'pearl', operation: 'message' }),
  'solana.transaction.v1': Object.freeze({ family: 'solana', operation: 'transaction' }),
  'solana.message.v1': Object.freeze({ family: 'solana', operation: 'message' }),
  'tron.transaction.v1': Object.freeze({ family: 'tron', operation: 'transaction' }),
  'tron.sign-message-v2.v1': Object.freeze({ family: 'tron', operation: 'message' }),
  'near.transaction.v1': Object.freeze({ family: 'near', operation: 'transaction' }),
  'near.nep413-message.v1': Object.freeze({ family: 'near', operation: 'message' }),
  'quantus.transfer.v1': Object.freeze({ family: 'quantus', operation: 'transaction' }),
  'starknet.invoke.v1': Object.freeze({ family: 'starknet', operation: 'transaction' }),
  'starknet.deploy-account.v1': Object.freeze({ family: 'starknet', operation: 'transaction' }),
  'starknet.typed-data.v1': Object.freeze({ family: 'starknet', operation: 'message' })
})

export type UnknownRecord = Record<string, unknown>

export function readRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as UnknownRecord
}

export function assertExactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`)
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} is missing field: ${key}`)
    }
  }
}

export function readString(value: unknown, label: string, maxLength?: number): string {
  const limit = maxLength ?? SIGNING_SUMMARY_LIMITS.maxTextLength
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > limit
  ) {
    throw new Error(`${label} must be a bounded non-empty string without surrounding whitespace`)
  }
  return value
}

export function readBoundedString(value: unknown, label: string, maxLength?: number): string {
  const limit = maxLength ?? SIGNING_SUMMARY_LIMITS.maxTextLength
  if (typeof value !== 'string' || value.length > limit) {
    throw new Error(`${label} must be a bounded string`)
  }
  return value
}

export function readNullableString(value: unknown, label: string): string | null {
  return value === null ? null : readString(value, label)
}

export function readUnsignedDecimal(value: unknown, label: string): string {
  const parsed = readString(value, label)
  if (!/^(?:0|[1-9][0-9]*)$/.test(parsed)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`)
  }
  return parsed
}

export function readSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

export function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

export function readLiteral<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${label}`)
  return value as T
}

export function readArray<T>(
  value: unknown,
  label: string,
  parser: (item: unknown, index: number) => T,
  options?: { readonly allowEmpty?: boolean; readonly maximum?: number }
): readonly T[] {
  const maximum = options?.maximum ?? SIGNING_SUMMARY_LIMITS.maxItems
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    (!options?.allowEmpty && value.length === 0)
  ) {
    throw new Error(`${label} must be a bounded${options?.allowEmpty ? '' : ' non-empty'} array`)
  }
  return Object.freeze(value.map((item, index) => parser(item, index)))
}

export function readStringArray(
  value: unknown,
  label: string,
  options?: { readonly allowEmpty?: boolean }
): readonly string[] {
  const parsed = readArray(
    value,
    label,
    (item, index) => readString(item, `${label}[${index}]`),
    options
  )
  if (new Set(parsed).size !== parsed.length)
    throw new Error(`${label} must not contain duplicates`)
  return parsed
}

export function readHex(
  value: unknown,
  label: string,
  options?: { readonly bytes?: number; readonly prefix?: boolean }
): string {
  const parsed = readString(value, label, SIGNING_SUMMARY_LIMITS.maxContentBytes * 2 + 2)
  const prefix = options?.prefix ?? true
  const pattern = prefix ? /^0x(?:[0-9a-f]{2})*$/ : /^(?:[0-9a-f]{2})+$/
  if (!pattern.test(parsed)) throw new Error(`${label} must be canonical lowercase hex`)
  const digits = prefix ? parsed.length - 2 : parsed.length
  if (options?.bytes !== undefined && digits !== options.bytes * 2) {
    throw new Error(`${label} must contain ${options.bytes} bytes`)
  }
  return parsed
}

export function readBase58(value: unknown, label: string, expectedBytes: number): string {
  const parsed = readString(value, label, Math.max(128, expectedBytes * 2))
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const littleEndianBytes = [0]
  for (const character of parsed) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error(`${label} must be base58`)
    let carry = digit
    for (let index = 0; index < littleEndianBytes.length; index += 1) {
      carry += littleEndianBytes[index] * 58
      littleEndianBytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      littleEndianBytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeroBytes = 0
  while (parsed[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes =
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? 0 : littleEndianBytes.length
  if (leadingZeroBytes + significantBytes !== expectedBytes) {
    throw new Error(`${label} must encode ${expectedBytes} bytes`)
  }
  return parsed
}

function base64ByteLength(value: string): number {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid canonical base64')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export function readCanonicalContent(value: unknown, label: string): CanonicalContent {
  const record = readRecord(value, label)
  assertExactKeys(record, ['encoding', 'value', 'byteLength', 'sha256'], [], label)
  const encoding = readLiteral(record.encoding, ['utf8', 'hex', 'base64'], `${label}.encoding`)
  const content = readBoundedString(
    record.value,
    `${label}.value`,
    SIGNING_SUMMARY_LIMITS.maxContentBytes * 2 + 2
  )
  const byteLength = readSafeInteger(
    record.byteLength,
    `${label}.byteLength`,
    SIGNING_SUMMARY_LIMITS.maxContentBytes
  )
  const sha256 = readHex(record.sha256, `${label}.sha256`, { bytes: 32, prefix: false })
  let actualByteLength: number
  if (encoding === 'utf8') {
    actualByteLength = new TextEncoder().encode(content).byteLength
  } else if (encoding === 'hex') {
    actualByteLength = (readHex(content, `${label}.value`).length - 2) / 2
  } else {
    actualByteLength = base64ByteLength(content)
  }
  if (actualByteLength !== byteLength) throw new Error(`${label}.byteLength does not match value`)
  return Object.freeze({ encoding, value: content, byteLength, sha256 })
}

export function readPayloadDigest(value: unknown, label: string): PayloadDigest {
  const record = readRecord(value, label)
  assertExactKeys(record, ['byteLength', 'sha256'], [], label)
  return Object.freeze({
    byteLength: readSafeInteger(record.byteLength, `${label}.byteLength`),
    sha256: readHex(record.sha256, `${label}.sha256`, { bytes: 32, prefix: false })
  })
}

function readReview(value: unknown): SigningReview {
  const record = readRecord(value, 'SigningSummary.review')
  assertExactKeys(record, ['level', 'issues'], [], 'SigningSummary.review')
  const level = readLiteral(record.level, ['standard', 'caution', 'blocked'], 'review level')
  const issues = readArray(
    record.issues,
    'SigningSummary.review.issues',
    (item, index): SigningReviewIssue => {
      const issue = readRecord(item, `SigningSummary.review.issues[${index}]`)
      assertExactKeys(issue, ['code'], ['subjectIndex'], `SigningSummary.review.issues[${index}]`)
      const code = readLiteral(
        issue.code,
        [...ISSUE_CODES],
        `SigningSummary.review.issues[${index}].code`
      )
      const subjectIndex =
        issue.subjectIndex === undefined
          ? undefined
          : readSafeInteger(
              issue.subjectIndex,
              `SigningSummary.review.issues[${index}].subjectIndex`
            )
      return Object.freeze(subjectIndex === undefined ? { code } : { code, subjectIndex })
    },
    { allowEmpty: true, maximum: 64 }
  )
  if ((level === 'standard') !== (issues.length === 0)) {
    throw new Error('Standard review must have no issues and non-standard review must have issues')
  }
  const unique = new Set(issues.map(issue => `${issue.code}:${issue.subjectIndex ?? ''}`))
  if (unique.size !== issues.length)
    throw new Error('SigningSummary.review contains duplicate issues')
  return Object.freeze({ level, issues })
}

export interface ParsedSigningSummaryEnvelope {
  readonly schema: SigningSummarySchema
  readonly chainId: ChainId
  readonly operation: SigningOperation
  readonly review: SigningReview
  readonly fields: UnknownRecord
}

function parseEnvelope(
  value: unknown,
  expectation: SigningSummaryExpectation
): ParsedSigningSummaryEnvelope {
  const record = readRecord(value, 'SigningSummary')
  assertExactKeys(
    record,
    ['schema', 'chainId', 'operation', 'review', 'fields'],
    [],
    'SigningSummary'
  )
  if (typeof record.schema !== 'string' || !SCHEMAS.has(record.schema)) {
    throw new Error('Unsupported signing summary schema')
  }
  const schema = record.schema as SigningSummarySchema
  const schemaExpectation = SCHEMA_EXPECTATIONS[schema]
  if (
    schemaExpectation.family !== expectation.family ||
    schemaExpectation.operation !== expectation.operation
  ) {
    throw new Error('Signing summary schema does not match the expected chain family or operation')
  }
  if (record.chainId !== expectation.chainId) {
    throw new Error('Signing summary chainId does not match the prepared command')
  }
  if (!expectation.chainId.startsWith(`${FAMILY_NAMESPACES[expectation.family]}:`)) {
    throw new Error('Signing summary chainId namespace does not match the expected chain family')
  }
  if (record.operation !== expectation.operation) {
    throw new Error('Signing summary operation does not match the prepared command')
  }
  return {
    schema,
    chainId: expectation.chainId,
    operation: expectation.operation,
    review: readReview(record.review),
    fields: readRecord(record.fields, 'SigningSummary.fields')
  }
}

export function requireBlockedReview(
  review: SigningReview,
  code: SigningReviewIssueCode,
  subjectIndex?: number
): void {
  const hasIssue = review.issues.some(
    issue =>
      issue.code === code && (subjectIndex === undefined || issue.subjectIndex === subjectIndex)
  )
  if (review.level !== 'blocked' || !hasIssue) {
    throw new Error(`${code} must produce a blocked review issue`)
  }
}

export function assertReviewIssuesAllowed(
  review: SigningReview,
  allowed: readonly SigningReviewIssueCode[]
): void {
  const allowedCodes = new Set(allowed)
  const unexpected = review.issues.find(issue => !allowedCodes.has(issue.code))
  if (unexpected) throw new Error(`Unexpected review issue: ${unexpected.code}`)
}

export function assertOpaqueContentReview(review: SigningReview, content: CanonicalContent): void {
  const hasIssue = review.issues.some(issue => issue.code === 'opaque-message')
  if (content.encoding === 'utf8') {
    if (hasIssue) throw new Error('Unexpected review issue: opaque-message')
    return
  }
  if (review.level === 'standard' || !hasIssue) {
    throw new Error('Non-UTF-8 message must produce an opaque-message review issue')
  }
}

export function parseSigningSummary(
  value: unknown,
  expectation: SigningSummaryExpectation
): SigningSummary {
  const envelope = parseEnvelope(value, expectation)
  switch (expectation.family) {
    case 'zcash':
      return parseZcashSummary(envelope)
    case 'evm':
      return parseEvmSummary(envelope)
    case 'bitcoin':
      return parseBitcoinSummary(envelope)
    case 'dash':
      return parseDashSummary(envelope)
    case 'pearl':
      return parsePearlSummary(envelope)
    case 'solana':
      return parseSolanaSummary(envelope)
    case 'tron':
      return parseTronSummary(envelope)
    case 'near':
      return parseNearSummary(envelope)
    case 'quantus':
      return parseQuantusSummary(envelope)
    case 'starknet':
      return parseStarknetSummary(envelope)
  }
}

function parseQuantusSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'signerAddress',
      'signerAccountId',
      'scheme',
      'recipient',
      'amountRaw',
      'feeLimitRaw',
      'keepAlive',
      'nonce',
      'tipRaw',
      'eraPeriod',
      'blockNumber',
      'callHash',
      'callLength'
    ],
    [],
    'quantus.transfer.v1'
  )
  const signerAddress = readSs58Address(fields.signerAddress, 'quantus.transfer.v1.signerAddress')
  const recipient = readSs58Address(fields.recipient, 'quantus.transfer.v1.recipient')
  const signerAccountId = readHex(fields.signerAccountId, 'quantus.transfer.v1.signerAccountId', {
    bytes: 32
  })
  const scheme = readLiteral(
    fields.scheme,
    ['ml-dsa-87', 'ml-dsa-65'],
    'quantus.transfer.v1.scheme'
  )
  const keepAlive = readBoolean(fields.keepAlive, 'quantus.transfer.v1.keepAlive')
  const amountRaw = readUnsignedDecimal(fields.amountRaw, 'quantus.transfer.v1.amountRaw')
  const feeLimitRaw = readUnsignedDecimal(fields.feeLimitRaw, 'quantus.transfer.v1.feeLimitRaw')
  if (feeLimitRaw === '0') {
    throw new Error('quantus.transfer.v1.feeLimitRaw must be positive')
  }
  const tipRaw = readUnsignedDecimal(fields.tipRaw, 'quantus.transfer.v1.tipRaw')
  const eraPeriod = readSafeInteger(fields.eraPeriod, 'quantus.transfer.v1.eraPeriod')
  const callLength = readSafeInteger(fields.callLength, 'quantus.transfer.v1.callLength')
  const summary: QuantusTransferSummary = Object.freeze({
    schema: envelope.schema as 'quantus.transfer.v1',
    chainId: envelope.chainId,
    operation: 'transaction' as const,
    review: envelope.review,
    fields: Object.freeze({
      signerAddress,
      signerAccountId,
      scheme,
      recipient,
      amountRaw,
      feeLimitRaw,
      keepAlive,
      nonce: readUnsignedDecimal(fields.nonce, 'quantus.transfer.v1.nonce'),
      tipRaw,
      eraPeriod,
      blockNumber: readSafeInteger(fields.blockNumber, 'quantus.transfer.v1.blockNumber'),
      callHash: readHex(fields.callHash, 'quantus.transfer.v1.callHash', { bytes: 32 }),
      callLength
    })
  })
  if (envelope.schema !== 'quantus.transfer.v1') {
    throw new Error('Unsupported Quantus signing summary schema')
  }
  return summary
}

function readSs58Address(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^qz[1-9A-HJ-NP-Za-km-z]{46,52}$/.test(value)) {
    throw new Error(`${label} must be a Quantus SS58 address`)
  }
  return value
}
