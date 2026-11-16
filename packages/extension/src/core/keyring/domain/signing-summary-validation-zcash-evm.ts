import type {
  EvmAccessListEntrySummary,
  EvmPersonalMessageSummary,
  EvmTransactionSummary,
  EvmTypedDataSummary,
  EvmTypedDataValue,
  SigningReview,
  SigningReviewIssueCode,
  SigningSummary,
  ZcashMessageSummary,
  ZcashRecipientSummary,
  ZcashTransactionSummary
} from './signing-summary'
import {
  SIGNING_SUMMARY_LIMITS,
  assertExactKeys,
  assertOpaqueContentReview,
  assertReviewIssuesAllowed,
  readArray,
  readBoundedString,
  readCanonicalContent,
  readHex,
  readLiteral,
  readNullableString,
  readRecord,
  readString,
  readUnsignedDecimal,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'

function hasReviewIssue(
  review: SigningReview,
  code: SigningReviewIssueCode,
  index?: number
): boolean {
  return review.issues.some(
    issue => issue.code === code && (index === undefined || issue.subjectIndex === index)
  )
}

function requireReviewIssue(
  review: SigningReview,
  code: SigningReviewIssueCode,
  index?: number
): void {
  if (review.level === 'standard' || !hasReviewIssue(review, code, index)) {
    throw new Error(`${code} must produce a review issue`)
  }
}

function assertNoUnexpectedIssue(review: SigningReview, code: SigningReviewIssueCode): void {
  if (hasReviewIssue(review, code)) throw new Error(`Unexpected review issue: ${code}`)
}

function readEvmAddress(value: unknown, label: string): string {
  const address = readString(value, label, 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${label} must be an EVM address`)
  return address
}

function readNullableEvmAddress(value: unknown, label: string): string | null {
  return value === null ? null : readEvmAddress(value, label)
}

function readZcashRecipient(value: unknown, index: number): ZcashRecipientSummary {
  const label = `ZcashSummary.fields.recipients[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(record, ['address', 'amountZats'], ['memo'], label)
  const recipient: ZcashRecipientSummary = {
    address: readString(record.address, `${label}.address`, 512),
    amountZats: readUnsignedDecimal(record.amountZats, `${label}.amountZats`)
  }
  return Object.freeze(
    record.memo === undefined
      ? recipient
      : { ...recipient, memo: readCanonicalContent(record.memo, `${label}.memo`) }
  )
}

function parseZcashTransaction(envelope: ParsedSigningSummaryEnvelope): ZcashTransactionSummary {
  assertReviewIssuesAllowed(envelope.review, [])
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'kind',
      'signer',
      'fundingSource',
      'recipients',
      'feeZats',
      'transparentInputZats',
      'shieldedInputZats',
      'transparentOutputZats',
      'shieldedOutputZats'
    ],
    [],
    'ZcashSummary.fields'
  )
  const kind = readLiteral(fields.kind, ['transfer', 'shield'], 'Zcash transaction kind')
  const recipients = readArray(
    fields.recipients,
    'ZcashSummary.fields.recipients',
    readZcashRecipient,
    {
      allowEmpty: kind === 'shield'
    }
  )
  if (kind === 'shield' && recipients.length !== 0) {
    throw new Error('Zcash shield summary cannot contain external recipients')
  }
  const parsedFields = Object.freeze({
    kind,
    signer: readString(fields.signer, 'ZcashSummary.fields.signer', 512),
    fundingSource: readLiteral(
      fields.fundingSource,
      ['transparent', 'shielded'],
      'Zcash funding source'
    ),
    recipients,
    feeZats: readUnsignedDecimal(fields.feeZats, 'ZcashSummary.fields.feeZats'),
    transparentInputZats: readUnsignedDecimal(
      fields.transparentInputZats,
      'ZcashSummary.fields.transparentInputZats'
    ),
    shieldedInputZats: readUnsignedDecimal(
      fields.shieldedInputZats,
      'ZcashSummary.fields.shieldedInputZats'
    ),
    transparentOutputZats: readUnsignedDecimal(
      fields.transparentOutputZats,
      'ZcashSummary.fields.transparentOutputZats'
    ),
    shieldedOutputZats: readUnsignedDecimal(
      fields.shieldedOutputZats,
      'ZcashSummary.fields.shieldedOutputZats'
    )
  })
  const inputs = BigInt(parsedFields.transparentInputZats) + BigInt(parsedFields.shieldedInputZats)
  const outputs =
    BigInt(parsedFields.transparentOutputZats) +
    BigInt(parsedFields.shieldedOutputZats) +
    BigInt(parsedFields.feeZats)
  if (inputs !== outputs) throw new Error('Zcash summary values do not balance')
  if (
    (parsedFields.fundingSource === 'transparent' && parsedFields.shieldedInputZats !== '0') ||
    (parsedFields.fundingSource === 'shielded' && parsedFields.transparentInputZats !== '0')
  ) {
    throw new Error('Zcash funding source does not match the selected input pool')
  }
  if (
    kind === 'shield' &&
    (parsedFields.fundingSource !== 'transparent' ||
      parsedFields.transparentInputZats === '0' ||
      parsedFields.shieldedOutputZats === '0')
  ) {
    throw new Error('Zcash shield summary must move transparent funds into the shielded pool')
  }
  const recipientTotal = recipients.reduce(
    (total, recipient) => total + BigInt(recipient.amountZats),
    0n
  )
  const onchainOutputs =
    BigInt(parsedFields.transparentOutputZats) + BigInt(parsedFields.shieldedOutputZats)
  if (recipientTotal > onchainOutputs) {
    throw new Error('Zcash recipient total exceeds transaction outputs')
  }
  return Object.freeze({
    schema: 'zcash.transaction.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: parsedFields
  })
}

function parseZcashMessage(envelope: ParsedSigningSummaryEnvelope): ZcashMessageSummary {
  const fields = envelope.fields
  assertExactKeys(fields, ['signer', 'message'], [], 'ZcashMessageSummary.fields')
  const message = readCanonicalContent(fields.message, 'ZcashMessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'zcash.message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readString(fields.signer, 'ZcashMessageSummary.fields.signer', 512),
      message
    })
  })
}

export function parseZcashSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'zcash.transaction.v1') return parseZcashTransaction(envelope)
  if (envelope.schema === 'zcash.message.v1') return parseZcashMessage(envelope)
  throw new Error('Signing summary schema is not valid for Zcash')
}

function readAccessListEntry(value: unknown, index: number): EvmAccessListEntrySummary {
  const label = `EvmSummary.fields.accessList[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(record, ['address', 'storageKeys'], [], label)
  return Object.freeze({
    address: readEvmAddress(record.address, `${label}.address`),
    storageKeys: readArray(
      record.storageKeys,
      `${label}.storageKeys`,
      (item, keyIndex) => readHex(item, `${label}.storageKeys[${keyIndex}]`, { bytes: 32 }),
      { allowEmpty: true }
    )
  })
}

function validateEvmFeeFields(fields: EvmTransactionSummary['fields']): void {
  if (fields.transactionType === 'eip1559') {
    if (
      fields.gasPriceWei !== null ||
      fields.maxFeePerGasWei === null ||
      fields.maxPriorityFeePerGasWei === null
    ) {
      throw new Error('EIP-1559 summary contains an invalid fee field combination')
    }
    if (BigInt(fields.maxPriorityFeePerGasWei) > BigInt(fields.maxFeePerGasWei)) {
      throw new Error('EIP-1559 priority fee exceeds max fee')
    }
    if (BigInt(fields.gasLimit) * BigInt(fields.maxFeePerGasWei) !== BigInt(fields.maximumFeeWei)) {
      throw new Error('EIP-1559 maximum fee does not match gas limit and max fee per gas')
    }
    return
  }
  if (
    fields.gasPriceWei === null ||
    fields.maxFeePerGasWei !== null ||
    fields.maxPriorityFeePerGasWei !== null
  ) {
    throw new Error('Legacy/EIP-2930 summary contains an invalid fee field combination')
  }
  if (BigInt(fields.gasLimit) * BigInt(fields.gasPriceWei) !== BigInt(fields.maximumFeeWei)) {
    throw new Error('EVM maximum fee does not match gas limit and gas price')
  }
  if (fields.transactionType === 'legacy' && fields.accessList.length !== 0) {
    throw new Error('Legacy EVM transaction cannot contain an access list')
  }
}

function parseEvmTransaction(envelope: ParsedSigningSummaryEnvelope): EvmTransactionSummary {
  assertReviewIssuesAllowed(envelope.review, ['contract-creation', 'unrecognized-call'])
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'transactionType',
      'from',
      'to',
      'nonce',
      'valueWei',
      'gasLimit',
      'maximumFeeWei',
      'gasPriceWei',
      'maxFeePerGasWei',
      'maxPriorityFeePerGasWei',
      'accessList',
      'calldata',
      'methodSelector'
    ],
    [],
    'EvmSummary.fields'
  )
  const calldata = readCanonicalContent(fields.calldata, 'EvmSummary.fields.calldata')
  if (calldata.encoding !== 'hex') throw new Error('EVM calldata must use hex encoding')
  const methodSelector = readNullableString(
    fields.methodSelector,
    'EvmSummary.fields.methodSelector'
  )
  if (
    (calldata.byteLength < 4 && methodSelector !== null) ||
    (methodSelector !== null && !/^0x[0-9a-f]{8}$/.test(methodSelector))
  ) {
    throw new Error('EVM method selector does not match calldata')
  }
  const parsedFields: EvmTransactionSummary['fields'] = Object.freeze({
    transactionType: readLiteral(
      fields.transactionType,
      ['legacy', 'eip2930', 'eip1559'],
      'EVM transaction type'
    ),
    from: readEvmAddress(fields.from, 'EvmSummary.fields.from'),
    to: readNullableEvmAddress(fields.to, 'EvmSummary.fields.to'),
    nonce: readUnsignedDecimal(fields.nonce, 'EvmSummary.fields.nonce'),
    valueWei: readUnsignedDecimal(fields.valueWei, 'EvmSummary.fields.valueWei'),
    gasLimit: readUnsignedDecimal(fields.gasLimit, 'EvmSummary.fields.gasLimit'),
    maximumFeeWei: readUnsignedDecimal(fields.maximumFeeWei, 'EvmSummary.fields.maximumFeeWei'),
    gasPriceWei:
      fields.gasPriceWei === null
        ? null
        : readUnsignedDecimal(fields.gasPriceWei, 'EvmSummary.fields.gasPriceWei'),
    maxFeePerGasWei:
      fields.maxFeePerGasWei === null
        ? null
        : readUnsignedDecimal(fields.maxFeePerGasWei, 'EvmSummary.fields.maxFeePerGasWei'),
    maxPriorityFeePerGasWei:
      fields.maxPriorityFeePerGasWei === null
        ? null
        : readUnsignedDecimal(
            fields.maxPriorityFeePerGasWei,
            'EvmSummary.fields.maxPriorityFeePerGasWei'
          ),
    accessList: readArray(fields.accessList, 'EvmSummary.fields.accessList', readAccessListEntry, {
      allowEmpty: true
    }),
    calldata,
    methodSelector
  })
  validateEvmFeeFields(parsedFields)
  if (parsedFields.to === null) requireReviewIssue(envelope.review, 'contract-creation')
  else assertNoUnexpectedIssue(envelope.review, 'contract-creation')
  if (calldata.byteLength > 0 && parsedFields.to !== null) {
    requireReviewIssue(envelope.review, 'unrecognized-call')
  } else {
    assertNoUnexpectedIssue(envelope.review, 'unrecognized-call')
  }
  return Object.freeze({
    schema: 'evm.transaction.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: parsedFields
  })
}

function parseEvmPersonalMessage(
  envelope: ParsedSigningSummaryEnvelope
): EvmPersonalMessageSummary {
  const fields = envelope.fields
  assertExactKeys(fields, ['signer', 'message'], [], 'EvmPersonalMessageSummary.fields')
  const message = readCanonicalContent(fields.message, 'EvmPersonalMessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'evm.personal-message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readEvmAddress(fields.signer, 'EvmPersonalMessageSummary.fields.signer'),
      message
    })
  })
}

function readTypedDataValue(value: unknown, label: string, depth = 0): EvmTypedDataValue {
  if (depth > SIGNING_SUMMARY_LIMITS.maxTypedDataDepth) {
    throw new Error('EVM typed data exceeds the maximum depth')
  }
  const record = readRecord(value, label)
  const kind = readLiteral(record.kind, ['scalar', 'struct', 'array'], `${label}.kind`)
  if (kind === 'scalar') {
    assertExactKeys(record, ['kind', 'solidityType', 'value'], [], label)
    return Object.freeze({
      kind,
      solidityType: readString(record.solidityType, `${label}.solidityType`, 256),
      value: readBoundedString(record.value, `${label}.value`)
    })
  }
  if (kind === 'struct') {
    assertExactKeys(record, ['kind', 'typeName', 'fields'], [], label)
    const fields = readArray(
      record.fields,
      `${label}.fields`,
      (item, index) => {
        const fieldLabel = `${label}.fields[${index}]`
        const field = readRecord(item, fieldLabel)
        assertExactKeys(field, ['name', 'value'], [], fieldLabel)
        return Object.freeze({
          name: readString(field.name, `${fieldLabel}.name`, 256),
          value: readTypedDataValue(field.value, `${fieldLabel}.value`, depth + 1)
        })
      },
      { allowEmpty: true }
    )
    if (new Set(fields.map(field => field.name)).size !== fields.length) {
      throw new Error(`${label}.fields must not contain duplicate names`)
    }
    return Object.freeze({
      kind,
      typeName: readString(record.typeName, `${label}.typeName`, 256),
      fields
    })
  }
  assertExactKeys(record, ['kind', 'itemType', 'items'], [], label)
  return Object.freeze({
    kind,
    itemType: readString(record.itemType, `${label}.itemType`, 256),
    items: readArray(
      record.items,
      `${label}.items`,
      (item, index) => readTypedDataValue(item, `${label}.items[${index}]`, depth + 1),
      { allowEmpty: true }
    )
  })
}

function parseEvmTypedData(envelope: ParsedSigningSummaryEnvelope): EvmTypedDataSummary {
  const fields = envelope.fields
  assertExactKeys(
    fields,
    ['signer', 'primaryType', 'domain', 'message', 'digestHex'],
    [],
    'EvmTypedDataSummary.fields'
  )
  const domain = readTypedDataValue(fields.domain, 'EvmTypedDataSummary.fields.domain')
  const message = readTypedDataValue(fields.message, 'EvmTypedDataSummary.fields.message')
  if (domain.kind !== 'struct' || message.kind !== 'struct') {
    throw new Error('EVM typed data domain and message must be typed structs')
  }
  if (domain.typeName !== 'EIP712Domain') {
    throw new Error('EVM typed data domain must use the EIP712Domain type')
  }
  const primaryType = readString(fields.primaryType, 'EvmTypedDataSummary.fields.primaryType', 256)
  if (message.typeName !== primaryType) {
    throw new Error('EVM typed data primaryType does not match the message struct')
  }
  assertReviewIssuesAllowed(envelope.review, ['missing-chain-binding'])
  const domainChainId = domain.fields.find(field => field.name === 'chainId')
  if (domainChainId === undefined) {
    requireReviewIssue(envelope.review, 'missing-chain-binding')
  } else {
    if (
      domainChainId.value.kind !== 'scalar' ||
      !/^uint(?:[0-9]+)?$/.test(domainChainId.value.solidityType) ||
      !/^(?:0|[1-9][0-9]*)$/.test(domainChainId.value.value)
    ) {
      throw new Error('EIP-712 domain chainId must be an unsigned integer scalar')
    }
    const expectedChainId = envelope.chainId.slice('eip155:'.length)
    if (domainChainId.value.value !== expectedChainId) {
      throw new Error('EIP-712 domain chainId does not match the prepared command')
    }
    assertNoUnexpectedIssue(envelope.review, 'missing-chain-binding')
  }
  return Object.freeze({
    schema: 'evm.typed-data.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readEvmAddress(fields.signer, 'EvmTypedDataSummary.fields.signer'),
      primaryType,
      domain,
      message,
      digestHex: readHex(fields.digestHex, 'EvmTypedDataSummary.fields.digestHex', {
        bytes: 32
      })
    })
  })
}

export function parseEvmSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'evm.transaction.v1') return parseEvmTransaction(envelope)
  if (envelope.schema === 'evm.personal-message.v1') return parseEvmPersonalMessage(envelope)
  if (envelope.schema === 'evm.typed-data.v1') return parseEvmTypedData(envelope)
  throw new Error('Signing summary schema is not valid for EVM')
}
