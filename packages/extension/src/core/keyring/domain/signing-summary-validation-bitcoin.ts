import type {
  BitcoinBip322MessageSummary,
  BitcoinInputSummary,
  BitcoinOutputSummary,
  BitcoinPsbtSummary,
  SigningReview,
  SigningReviewIssueCode,
  SigningSummary
} from './signing-summary'
import {
  assertExactKeys,
  assertOpaqueContentReview,
  assertReviewIssuesAllowed,
  readArray,
  readCanonicalContent,
  readHex,
  readLiteral,
  readNullableString,
  readRecord,
  readSafeInteger,
  readString,
  readUnsignedDecimal,
  requireBlockedReview,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'

function hasReviewIssue(review: SigningReview, code: SigningReviewIssueCode): boolean {
  return review.issues.some(issue => issue.code === code)
}

function requireReviewIssue(review: SigningReview, code: SigningReviewIssueCode): void {
  if (review.level === 'standard' || !hasReviewIssue(review, code)) {
    throw new Error(`${code} must produce a review issue`)
  }
}

function assertNoUnexpectedIssue(review: SigningReview, code: SigningReviewIssueCode): void {
  if (hasReviewIssue(review, code)) throw new Error(`Unexpected review issue: ${code}`)
}

function readBitcoinInput(value: unknown, index: number): BitcoinInputSummary {
  const label = `BitcoinPsbtSummary.fields.inputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    [
      'index',
      'transactionId',
      'outputIndex',
      'amountSats',
      'sequence',
      'scriptType',
      'sighashType',
      'ownership'
    ],
    [],
    label
  )
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    transactionId: readHex(record.transactionId, `${label}.transactionId`, {
      bytes: 32,
      prefix: false
    }),
    outputIndex: readSafeInteger(record.outputIndex, `${label}.outputIndex`, 0xffffffff),
    amountSats: readUnsignedDecimal(record.amountSats, `${label}.amountSats`),
    sequence: readSafeInteger(record.sequence, `${label}.sequence`, 0xffffffff),
    scriptType: readLiteral(
      record.scriptType,
      ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'],
      `${label}.scriptType`
    ),
    sighashType: readString(record.sighashType, `${label}.sighashType`, 64),
    ownership: readLiteral(record.ownership, ['signing-account', 'external'], `${label}.ownership`)
  })
}

function readBitcoinOutput(value: unknown, index: number): BitcoinOutputSummary {
  const label = `BitcoinPsbtSummary.fields.outputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['index', 'address', 'scriptPubKeyHex', 'amountSats', 'classification'],
    [],
    label
  )
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    address: readNullableString(record.address, `${label}.address`),
    scriptPubKeyHex: readHex(record.scriptPubKeyHex, `${label}.scriptPubKeyHex`),
    amountSats: readUnsignedDecimal(record.amountSats, `${label}.amountSats`),
    classification: readLiteral(
      record.classification,
      ['recipient', 'change', 'unknown'],
      `${label}.classification`
    )
  })
}

function assertSequentialIndexes(
  items: readonly { readonly index: number }[],
  label: string
): void {
  items.forEach((item, index) => {
    if (item.index !== index) throw new Error(`${label} indexes must be contiguous and ordered`)
  })
}

function parseBitcoinPsbt(envelope: ParsedSigningSummaryEnvelope): BitcoinPsbtSummary {
  assertReviewIssuesAllowed(envelope.review, [
    'external-input',
    'non-default-sighash',
    'unknown-output'
  ])
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'psbtVersion',
      'signer',
      'inputs',
      'outputs',
      'signingInputIndexes',
      'totalInputSats',
      'totalOutputSats',
      'feeSats'
    ],
    [],
    'BitcoinPsbtSummary.fields'
  )
  const inputs = readArray(fields.inputs, 'BitcoinPsbtSummary.fields.inputs', readBitcoinInput)
  const outputs = readArray(fields.outputs, 'BitcoinPsbtSummary.fields.outputs', readBitcoinOutput)
  assertSequentialIndexes(inputs, 'Bitcoin input')
  assertSequentialIndexes(outputs, 'Bitcoin output')
  const signingInputIndexes = readArray(
    fields.signingInputIndexes,
    'BitcoinPsbtSummary.fields.signingInputIndexes',
    (item, index) =>
      readSafeInteger(
        item,
        `BitcoinPsbtSummary.fields.signingInputIndexes[${index}]`,
        inputs.length - 1
      )
  )
  if (new Set(signingInputIndexes).size !== signingInputIndexes.length) {
    throw new Error('Bitcoin signing input indexes must not contain duplicates')
  }
  for (const index of signingInputIndexes) {
    if (inputs[index]?.ownership !== 'signing-account') {
      throw new Error('Bitcoin signing input must belong to the signing account')
    }
  }
  const totalInputSats = readUnsignedDecimal(
    fields.totalInputSats,
    'BitcoinPsbtSummary.fields.totalInputSats'
  )
  const totalOutputSats = readUnsignedDecimal(
    fields.totalOutputSats,
    'BitcoinPsbtSummary.fields.totalOutputSats'
  )
  const feeSats = readUnsignedDecimal(fields.feeSats, 'BitcoinPsbtSummary.fields.feeSats')
  if (
    inputs.reduce((sum, input) => sum + BigInt(input.amountSats), 0n) !== BigInt(totalInputSats) ||
    outputs.reduce((sum, output) => sum + BigInt(output.amountSats), 0n) !==
      BigInt(totalOutputSats) ||
    BigInt(totalInputSats) - BigInt(totalOutputSats) !== BigInt(feeSats)
  ) {
    throw new Error('Bitcoin PSBT summary amounts do not balance')
  }
  const externalInputs = inputs.filter(input => input.ownership === 'external')
  if (externalInputs.length > 0) requireReviewIssue(envelope.review, 'external-input')
  else assertNoUnexpectedIssue(envelope.review, 'external-input')
  const nonDefaultInputs = inputs.filter(
    input =>
      !(
        (input.scriptType !== 'p2tr' && input.sighashType === 'SIGHASH_ALL') ||
        (input.scriptType === 'p2tr' && input.sighashType === 'SIGHASH_DEFAULT')
      )
  )
  if (nonDefaultInputs.length > 0) requireReviewIssue(envelope.review, 'non-default-sighash')
  else assertNoUnexpectedIssue(envelope.review, 'non-default-sighash')
  outputs.forEach(output => {
    if (output.classification === 'unknown') {
      requireBlockedReview(envelope.review, 'unknown-output', output.index)
    }
  })
  const parsedFields: BitcoinPsbtSummary['fields'] = Object.freeze({
    psbtVersion: readLiteral(fields.psbtVersion, [0], 'PSBT version'),
    signer: readString(fields.signer, 'BitcoinPsbtSummary.fields.signer', 512),
    inputs,
    outputs,
    signingInputIndexes,
    totalInputSats,
    totalOutputSats,
    feeSats
  })
  return Object.freeze({
    schema: 'bitcoin.psbt.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: parsedFields
  })
}

function parseBitcoinMessage(envelope: ParsedSigningSummaryEnvelope): BitcoinBip322MessageSummary {
  const fields = envelope.fields
  assertExactKeys(fields, ['address', 'message'], [], 'BitcoinBip322MessageSummary.fields')
  const message = readCanonicalContent(fields.message, 'BitcoinBip322MessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'bitcoin.bip322-message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      address: readString(fields.address, 'BitcoinBip322MessageSummary.fields.address', 512),
      message
    })
  })
}

export function parseBitcoinSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'bitcoin.psbt.v1') return parseBitcoinPsbt(envelope)
  if (envelope.schema === 'bitcoin.bip322-message.v1') return parseBitcoinMessage(envelope)
  throw new Error('Signing summary schema is not valid for Bitcoin')
}
