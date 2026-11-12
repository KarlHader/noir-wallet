import type {
  CanonicalContent,
  SigningReview,
  StarknetCallSummary,
  StarknetDeployAccountSummary,
  StarknetInvokeSummary,
  StarknetResourceBoundsSummary,
  StarknetTypedDataSummary
} from './signing-summary'
import {
  assertExactKeys,
  readArray,
  readCanonicalContent,
  readLiteral,
  readRecord,
  readString,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'

const FELT = /^0x[0-9a-f]{1,64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

function readFelt(value: unknown, label: string): string {
  const parsed = readString(value, label, 66)
  if (!FELT.test(parsed)) throw new Error(`${label} must be a Starknet felt`)
  return parsed
}

function readDecimal(value: unknown, label: string): string {
  const parsed = readString(value, label, 64)
  if (!DECIMAL.test(parsed)) throw new Error(`${label} must be a decimal amount`)
  return parsed
}

function readBounds(value: unknown): StarknetResourceBoundsSummary {
  const record = readRecord(value, 'Starknet resource bounds')
  assertExactKeys(record, ['l1Gas', 'l2Gas', 'l1DataGas'], [], 'Starknet resource bounds')
  const readBound = (name: 'l1Gas' | 'l2Gas' | 'l1DataGas') => {
    const bound = readRecord(record[name], name)
    assertExactKeys(bound, ['maxAmount', 'maxPricePerUnit'], [], name)
    return Object.freeze({
      maxAmount: readDecimal(bound.maxAmount, `${name}.maxAmount`),
      maxPricePerUnit: readDecimal(bound.maxPricePerUnit, `${name}.maxPricePerUnit`)
    })
  }
  return Object.freeze({
    l1Gas: readBound('l1Gas'),
    l2Gas: readBound('l2Gas'),
    l1DataGas: readBound('l1DataGas')
  })
}

function readMode(value: unknown, label: string): 'l1' | 'l2' {
  return readLiteral(value, ['l1', 'l2'], label)
}

function assertCautionIssues(
  review: SigningReview,
  code: StarknetInvokeSummary['review']['issues'][number]['code'],
  count: number
): void {
  if (review.level !== 'caution' || review.issues.length !== count) {
    throw new Error(`Starknet review must list ${code} for each reviewed item`)
  }
  review.issues.forEach((issue, index) => {
    if (issue.code !== code || issue.subjectIndex !== index) {
      throw new Error(`Starknet review issue ${index} must be ${code}`)
    }
  })
}

function parseInvoke(envelope: ParsedSigningSummaryEnvelope): StarknetInvokeSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'senderAddress',
      'nonce',
      'tip',
      'resourceBounds',
      'calls',
      'nonceDataAvailabilityMode',
      'feeDataAvailabilityMode'
    ],
    [],
    'StarknetInvokeSummary.fields'
  )
  const calls = readArray(
    fields.calls,
    'StarknetInvokeSummary.fields.calls',
    (item): StarknetCallSummary => {
      const call = readRecord(item, 'Starknet call')
      assertExactKeys(call, ['to', 'selector', 'entrypoint', 'calldata'], [], 'Starknet call')
      if (call.entrypoint !== null) {
        throw new Error('Starknet invoke summary entrypoint must be null')
      }
      return Object.freeze({
        to: readFelt(call.to, 'call.to'),
        selector: readFelt(call.selector, 'call.selector'),
        entrypoint: null,
        calldata: readArray(call.calldata, 'call.calldata', felt => readFelt(felt, 'calldata'), {
          allowEmpty: true,
          maximum: 1024
        })
      })
    },
    { maximum: 128 }
  )
  if (calls.length === 0) throw new Error('Starknet invoke summary requires a call')
  assertCautionIssues(envelope.review, 'unrecognized-call', calls.length)
  return Object.freeze({
    schema: 'starknet.invoke.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      senderAddress: readFelt(fields.senderAddress, 'senderAddress'),
      nonce: readFelt(fields.nonce, 'nonce'),
      tip: readDecimal(fields.tip, 'tip'),
      resourceBounds: readBounds(fields.resourceBounds),
      calls,
      nonceDataAvailabilityMode: readMode(fields.nonceDataAvailabilityMode, 'nonce mode'),
      feeDataAvailabilityMode: readMode(fields.feeDataAvailabilityMode, 'fee mode')
    })
  })
}

function parseDeploy(envelope: ParsedSigningSummaryEnvelope): StarknetDeployAccountSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'contractAddress',
      'classHash',
      'salt',
      'constructorCalldata',
      'nonce',
      'tip',
      'resourceBounds',
      'nonceDataAvailabilityMode',
      'feeDataAvailabilityMode'
    ],
    [],
    'StarknetDeployAccountSummary.fields'
  )
  assertCautionIssues(envelope.review, 'contract-creation', 1)
  const constructorCalldata = readArray(
    fields.constructorCalldata,
    'constructorCalldata',
    felt => readFelt(felt, 'constructorCalldata'),
    { maximum: 16 }
  )
  if (constructorCalldata.length !== 1 && constructorCalldata.length !== 3) {
    throw new Error('Starknet deploy constructor must be the public key or Argent v0.4 calldata')
  }
  return Object.freeze({
    schema: 'starknet.deploy-account.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      contractAddress: readFelt(fields.contractAddress, 'contractAddress'),
      classHash: readFelt(fields.classHash, 'classHash'),
      salt: readFelt(fields.salt, 'salt'),
      constructorCalldata,
      nonce: readFelt(fields.nonce, 'nonce'),
      tip: readDecimal(fields.tip, 'tip'),
      resourceBounds: readBounds(fields.resourceBounds),
      nonceDataAvailabilityMode: readMode(fields.nonceDataAvailabilityMode, 'nonce mode'),
      feeDataAvailabilityMode: readMode(fields.feeDataAvailabilityMode, 'fee mode')
    })
  })
}

function parseTypedData(envelope: ParsedSigningSummaryEnvelope): StarknetTypedDataSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    ['accountAddress', 'publicKey', 'typedData'],
    [],
    'StarknetTypedDataSummary.fields'
  )
  assertCautionIssues(envelope.review, 'opaque-message', 1)
  const typedData: CanonicalContent = readCanonicalContent(
    fields.typedData,
    'StarknetTypedDataSummary.fields.typedData'
  )
  if (typedData.encoding !== 'utf8') {
    throw new Error('Starknet typed data must be utf8')
  }
  return Object.freeze({
    schema: 'starknet.typed-data.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      accountAddress: readFelt(fields.accountAddress, 'accountAddress'),
      publicKey: readFelt(fields.publicKey, 'publicKey'),
      typedData
    })
  })
}

export function parseStarknetSummary(envelope: ParsedSigningSummaryEnvelope) {
  if (envelope.schema === 'starknet.invoke.v1') return parseInvoke(envelope)
  if (envelope.schema === 'starknet.deploy-account.v1') return parseDeploy(envelope)
  if (envelope.schema === 'starknet.typed-data.v1') return parseTypedData(envelope)
  throw new Error('Signing summary schema is not valid for Starknet')
}
