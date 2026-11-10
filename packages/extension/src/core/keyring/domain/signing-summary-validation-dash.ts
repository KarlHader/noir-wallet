import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type {
  DashInputSummary,
  DashMessageSummary,
  DashOutputSummary,
  DashPsbtSummary,
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

function dashCoinType(chainId: string): 5 | 1 {
  if (chainId === DASH_CHAIN_IDS.mainnet) return 5
  if (chainId === DASH_CHAIN_IDS.testnet) return 1
  throw new Error('Dash summary chain is not a Dash chain')
}

function accountPath(path: string, coinType: 5 | 1, accountIndex: number): boolean {
  if (path === 'm') return accountIndex === 0
  return new RegExp(`^m/44'/${coinType}'/${accountIndex}'/[01]/\\d+$`).test(path)
}

function changePath(path: string, coinType: 5 | 1, accountIndex: number): boolean {
  return new RegExp(`^m/44'/${coinType}'/${accountIndex}'/1/\\d+$`).test(path)
}

function assertSequentialIndexes(
  items: readonly { readonly index: number }[],
  label: string
): void {
  items.forEach((item, index) => {
    if (item.index !== index) throw new Error(`${label} indexes must be contiguous and ordered`)
  })
}

function readDashInput(value: unknown, index: number): DashInputSummary {
  const label = `DashPsbtSummary.fields.inputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    [
      'index',
      'transactionId',
      'outputIndex',
      'amountDuffs',
      'sequence',
      'scriptType',
      'sighashType',
      'ownership',
      'derivationPath'
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
    amountDuffs: readUnsignedDecimal(record.amountDuffs, `${label}.amountDuffs`),
    sequence: readSafeInteger(record.sequence, `${label}.sequence`, 0xffffffff),
    scriptType: readLiteral(record.scriptType, ['p2pkh'], `${label}.scriptType`),
    sighashType: readString(record.sighashType, `${label}.sighashType`, 64),
    ownership: readLiteral(record.ownership, ['signing-account', 'external'], `${label}.ownership`),
    derivationPath:
      record.derivationPath === null
        ? null
        : readString(record.derivationPath, `${label}.derivationPath`, 128)
  })
}

function readDashOutput(value: unknown, index: number): DashOutputSummary {
  const label = `DashPsbtSummary.fields.outputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['index', 'address', 'scriptPubKeyHex', 'amountDuffs', 'classification', 'derivationPath'],
    [],
    label
  )
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    address: readNullableString(record.address, `${label}.address`),
    scriptPubKeyHex: readHex(record.scriptPubKeyHex, `${label}.scriptPubKeyHex`),
    amountDuffs: readUnsignedDecimal(record.amountDuffs, `${label}.amountDuffs`),
    classification: readLiteral(
      record.classification,
      ['recipient', 'change', 'unknown'],
      `${label}.classification`
    ),
    derivationPath:
      record.derivationPath === null
        ? null
        : readString(record.derivationPath, `${label}.derivationPath`, 128)
  })
}

function parseDashPsbt(envelope: ParsedSigningSummaryEnvelope): DashPsbtSummary {
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
      'accountIndex',
      'inputs',
      'outputs',
      'signingInputIndexes',
      'totalInputDuffs',
      'totalOutputDuffs',
      'feeDuffs'
    ],
    [],
    'DashPsbtSummary.fields'
  )
  const accountIndex = readSafeInteger(fields.accountIndex, 'DashPsbtSummary.fields.accountIndex')
  const coinType = dashCoinType(envelope.chainId)
  const inputs = readArray(fields.inputs, 'DashPsbtSummary.fields.inputs', readDashInput)
  const outputs = readArray(fields.outputs, 'DashPsbtSummary.fields.outputs', readDashOutput)
  assertSequentialIndexes(inputs, 'Dash input')
  assertSequentialIndexes(outputs, 'Dash output')
  const signingInputIndexes = readArray(
    fields.signingInputIndexes,
    'DashPsbtSummary.fields.signingInputIndexes',
    (item, index) =>
      readSafeInteger(
        item,
        `DashPsbtSummary.fields.signingInputIndexes[${index}]`,
        inputs.length - 1
      )
  )
  if (new Set(signingInputIndexes).size !== signingInputIndexes.length) {
    throw new Error('Dash signing input indexes must not contain duplicates')
  }
  for (const index of signingInputIndexes) {
    const input = inputs[index]
    if (!input || input.ownership !== 'signing-account') {
      throw new Error('Dash signing input must belong to the signing account')
    }
  }
  const imported = inputs.some(
    input => input.ownership === 'signing-account' && input.derivationPath === 'm'
  )
  for (const input of inputs) {
    if (input.ownership !== 'signing-account') continue
    if (
      input.derivationPath === null ||
      !accountPath(input.derivationPath, coinType, accountIndex)
    ) {
      throw new Error('Dash signing input does not belong to the selected account')
    }
    if (imported && input.derivationPath !== 'm') {
      throw new Error('Imported Dash key cannot claim an HD input')
    }
  }
  for (const output of outputs) {
    if (output.classification === 'recipient' && output.address === null) {
      throw new Error('Dash recipient output requires an address')
    }
    if (output.classification === 'change') {
      if (
        output.derivationPath === null ||
        !changePath(output.derivationPath, coinType, accountIndex) ||
        imported
      ) {
        throw new Error('Dash change output does not belong to the selected account')
      }
    }
    if (output.classification === 'unknown') {
      requireBlockedReview(envelope.review, 'unknown-output', output.index)
    }
  }
  const totalInputDuffs = readUnsignedDecimal(
    fields.totalInputDuffs,
    'DashPsbtSummary.fields.totalInputDuffs'
  )
  const totalOutputDuffs = readUnsignedDecimal(
    fields.totalOutputDuffs,
    'DashPsbtSummary.fields.totalOutputDuffs'
  )
  const feeDuffs = readUnsignedDecimal(fields.feeDuffs, 'DashPsbtSummary.fields.feeDuffs')
  const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.amountDuffs), 0n)
  const outputTotal = outputs.reduce((sum, output) => sum + BigInt(output.amountDuffs), 0n)
  if (
    inputTotal !== BigInt(totalInputDuffs) ||
    outputTotal !== BigInt(totalOutputDuffs) ||
    inputTotal - outputTotal !== BigInt(feeDuffs)
  ) {
    throw new Error('Dash PSBT summary amounts do not balance')
  }
  if (inputs.some(input => input.ownership === 'external')) {
    requireReviewIssue(envelope.review, 'external-input')
  } else assertNoUnexpectedIssue(envelope.review, 'external-input')
  if (inputs.some(input => input.sighashType !== 'SIGHASH_ALL')) {
    requireReviewIssue(envelope.review, 'non-default-sighash')
  } else assertNoUnexpectedIssue(envelope.review, 'non-default-sighash')
  return Object.freeze({
    schema: 'dash.psbt.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      psbtVersion: readLiteral(fields.psbtVersion, [0], 'PSBT version'),
      signer: readString(fields.signer, 'DashPsbtSummary.fields.signer', 512),
      accountIndex,
      inputs,
      outputs,
      signingInputIndexes,
      totalInputDuffs,
      totalOutputDuffs,
      feeDuffs
    })
  })
}

function parseDashMessage(envelope: ParsedSigningSummaryEnvelope): DashMessageSummary {
  const fields = envelope.fields
  assertExactKeys(fields, ['signer', 'message', 'messageHash'], [], 'DashMessageSummary.fields')
  const message = readCanonicalContent(fields.message, 'DashMessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  dashCoinType(envelope.chainId)
  return Object.freeze({
    schema: 'dash.message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readString(fields.signer, 'DashMessageSummary.fields.signer', 512),
      message,
      messageHash: readHex(fields.messageHash, 'DashMessageSummary.fields.messageHash', {
        bytes: 32
      })
    })
  })
}

export function parseDashSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'dash.psbt.v1') return parseDashPsbt(envelope)
  if (envelope.schema === 'dash.message.v1') return parseDashMessage(envelope)
  throw new Error('Signing summary schema is not valid for Dash')
}
