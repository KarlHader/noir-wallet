import type {
  SigningSummary,
  SolanaAddressTableLookupSummary,
  SolanaInstructionAccountSummary,
  SolanaInstructionInterpretation,
  SolanaInstructionSummary,
  SolanaMessageSummary,
  SolanaTransactionSummary
} from './signing-summary'
import {
  assertExactKeys,
  assertOpaqueContentReview,
  assertReviewIssuesAllowed,
  readArray,
  readBase58,
  readBoolean,
  readCanonicalContent,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  readStringArray,
  readUnsignedDecimal,
  type ParsedSigningSummaryEnvelope
} from './signing-summary-validation'

const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111'
const SOLANA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SOLANA_COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const SOLANA_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
])

function readSolanaAddress(value: unknown, label: string): string {
  return readBase58(value, label, 32)
}

function readSolanaInstructionAccount(
  value: unknown,
  label: string
): SolanaInstructionAccountSummary {
  const record = readRecord(value, label)
  assertExactKeys(record, ['address', 'signer', 'writable', 'source'], [], label)
  return Object.freeze({
    address: readSolanaAddress(record.address, `${label}.address`),
    signer: readBoolean(record.signer, `${label}.signer`),
    writable: readBoolean(record.writable, `${label}.writable`),
    source: readLiteral(record.source, ['static', 'lookup'], `${label}.source`)
  })
}

function readSolanaInterpretation(
  value: unknown,
  label: string,
  programId: string,
  accountAddresses: ReadonlySet<string>
): SolanaInstructionInterpretation {
  const record = readRecord(value, label)
  const kind = readLiteral(
    record.kind,
    [
      'system-transfer',
      'spl-token-transfer',
      'associated-token-create-idempotent',
      'compute-unit-limit',
      'compute-unit-price',
      'compute-request-heap-frame',
      'compute-loaded-accounts-data-size-limit',
      'compute-request-units-deprecated',
      'unrecognized'
    ],
    `${label}.kind`
  )
  if (kind === 'unrecognized') {
    assertExactKeys(record, ['kind'], [], label)
    return Object.freeze({ kind })
  }
  if (kind === 'system-transfer') {
    assertExactKeys(record, ['kind', 'from', 'to', 'lamports'], [], label)
    if (programId !== SOLANA_SYSTEM_PROGRAM) {
      throw new Error('Solana system transfer interpretation has the wrong program ID')
    }
    const from = readSolanaAddress(record.from, `${label}.from`)
    const to = readSolanaAddress(record.to, `${label}.to`)
    if (!accountAddresses.has(from) || !accountAddresses.has(to)) {
      throw new Error('Solana system transfer references an account outside the instruction')
    }
    return Object.freeze({
      kind,
      from,
      to,
      lamports: readUnsignedDecimal(record.lamports, `${label}.lamports`)
    })
  }
  if (kind === 'compute-unit-limit') {
    assertExactKeys(record, ['kind', 'units'], [], label)
    if (programId !== SOLANA_COMPUTE_BUDGET_PROGRAM || accountAddresses.size !== 0) {
      throw new Error('Solana compute unit limit has invalid program or accounts')
    }
    return Object.freeze({ kind, units: readUnsignedDecimal(record.units, `${label}.units`) })
  }
  if (kind === 'compute-unit-price') {
    assertExactKeys(record, ['kind', 'microLamports'], [], label)
    if (programId !== SOLANA_COMPUTE_BUDGET_PROGRAM || accountAddresses.size !== 0) {
      throw new Error('Solana compute unit price has invalid program or accounts')
    }
    return Object.freeze({
      kind,
      microLamports: readUnsignedDecimal(record.microLamports, `${label}.microLamports`)
    })
  }
  if (kind === 'compute-request-heap-frame' || kind === 'compute-loaded-accounts-data-size-limit') {
    assertExactKeys(record, ['kind', 'bytes'], [], label)
    if (programId !== SOLANA_COMPUTE_BUDGET_PROGRAM || accountAddresses.size !== 0) {
      throw new Error('Solana compute budget memory request has invalid program or accounts')
    }
    return Object.freeze({ kind, bytes: readUnsignedDecimal(record.bytes, `${label}.bytes`) })
  }
  if (kind === 'compute-request-units-deprecated') {
    assertExactKeys(record, ['kind', 'units', 'additionalFeeLamports'], [], label)
    if (programId !== SOLANA_COMPUTE_BUDGET_PROGRAM || accountAddresses.size !== 0) {
      throw new Error('Solana deprecated compute request has invalid program or accounts')
    }
    return Object.freeze({
      kind,
      units: readUnsignedDecimal(record.units, `${label}.units`),
      additionalFeeLamports: readUnsignedDecimal(
        record.additionalFeeLamports,
        `${label}.additionalFeeLamports`
      )
    })
  }
  if (kind === 'associated-token-create-idempotent') {
    assertExactKeys(
      record,
      ['kind', 'payer', 'associatedAccount', 'owner', 'mint', 'tokenProgram'],
      [],
      label
    )
    if (programId !== SOLANA_ASSOCIATED_TOKEN_PROGRAM) {
      throw new Error('Solana associated token interpretation has the wrong program ID')
    }
    const payer = readSolanaAddress(record.payer, `${label}.payer`)
    const associatedAccount = readSolanaAddress(
      record.associatedAccount,
      `${label}.associatedAccount`
    )
    const owner = readSolanaAddress(record.owner, `${label}.owner`)
    const mint = readSolanaAddress(record.mint, `${label}.mint`)
    const tokenProgram = readSolanaAddress(record.tokenProgram, `${label}.tokenProgram`)
    if (
      !accountAddresses.has(payer) ||
      !accountAddresses.has(associatedAccount) ||
      !accountAddresses.has(owner) ||
      !accountAddresses.has(mint) ||
      !accountAddresses.has(tokenProgram) ||
      !SOLANA_TOKEN_PROGRAMS.has(tokenProgram)
    ) {
      throw new Error('Solana associated token creation references invalid accounts')
    }
    return Object.freeze({ kind, payer, associatedAccount, owner, mint, tokenProgram })
  }
  assertExactKeys(
    record,
    ['kind', 'source', 'destination', 'authority', 'amountRaw', 'mint', 'decimals'],
    [],
    label
  )
  if (!SOLANA_TOKEN_PROGRAMS.has(programId)) {
    throw new Error('Solana token transfer interpretation has the wrong program ID')
  }
  const source = readSolanaAddress(record.source, `${label}.source`)
  const destination = readSolanaAddress(record.destination, `${label}.destination`)
  const authority = readSolanaAddress(record.authority, `${label}.authority`)
  if (
    !accountAddresses.has(source) ||
    !accountAddresses.has(destination) ||
    !accountAddresses.has(authority)
  ) {
    throw new Error('Solana token transfer references an account outside the instruction')
  }
  const mint = record.mint === null ? null : readSolanaAddress(record.mint, `${label}.mint`)
  if (mint !== null && !accountAddresses.has(mint)) {
    throw new Error('Solana token transfer mint is outside the instruction')
  }
  const decimals =
    record.decimals === null ? null : readSafeInteger(record.decimals, `${label}.decimals`, 255)
  if ((mint === null) !== (decimals === null)) {
    throw new Error('Solana checked token transfer must bind both mint and decimals')
  }
  return Object.freeze({
    kind,
    source,
    destination,
    authority,
    amountRaw: readUnsignedDecimal(record.amountRaw, `${label}.amountRaw`),
    mint,
    decimals
  })
}

function readSolanaInstruction(value: unknown, index: number): SolanaInstructionSummary {
  const label = `SolanaTransactionSummary.fields.instructions[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(record, ['index', 'programId', 'accounts', 'data', 'interpretation'], [], label)
  const parsedIndex = readSafeInteger(record.index, `${label}.index`)
  if (parsedIndex !== index)
    throw new Error('Solana instruction indexes must be contiguous and ordered')
  const programId = readSolanaAddress(record.programId, `${label}.programId`)
  const accounts = readArray(
    record.accounts,
    `${label}.accounts`,
    (item, accountIndex) =>
      readSolanaInstructionAccount(item, `${label}.accounts[${accountIndex}]`),
    { allowEmpty: true }
  )
  const accountAddresses = new Set(accounts.map(account => account.address))
  const data = readCanonicalContent(record.data, `${label}.data`)
  if (data.encoding !== 'base64') throw new Error('Solana instruction data must use base64')
  return Object.freeze({
    index: parsedIndex,
    programId,
    accounts,
    data,
    interpretation: readSolanaInterpretation(
      record.interpretation,
      `${label}.interpretation`,
      programId,
      accountAddresses
    )
  })
}

function readSolanaLookup(value: unknown, index: number): SolanaAddressTableLookupSummary {
  const label = `SolanaTransactionSummary.fields.addressTableLookups[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(record, ['accountKey', 'writableAddresses', 'readonlyAddresses'], [], label)
  const writableAddresses = readStringArray(
    record.writableAddresses,
    `${label}.writableAddresses`,
    { allowEmpty: true }
  ).map((address, addressIndex) =>
    readSolanaAddress(address, `${label}.writableAddresses[${addressIndex}]`)
  )
  const readonlyAddresses = readStringArray(
    record.readonlyAddresses,
    `${label}.readonlyAddresses`,
    { allowEmpty: true }
  ).map((address, addressIndex) =>
    readSolanaAddress(address, `${label}.readonlyAddresses[${addressIndex}]`)
  )
  return Object.freeze({
    accountKey: readSolanaAddress(record.accountKey, `${label}.accountKey`),
    writableAddresses: Object.freeze(writableAddresses),
    readonlyAddresses: Object.freeze(readonlyAddresses)
  })
}

function parseSolanaTransaction(envelope: ParsedSigningSummaryEnvelope): SolanaTransactionSummary {
  assertReviewIssuesAllowed(envelope.review, ['unrecognized-instruction', 'simulation-failed'])
  const fields = envelope.fields
  assertExactKeys(
    fields,
    [
      'messageVersion',
      'feePayer',
      'recentBlockhash',
      'requiredSigners',
      'staticAccountKeys',
      'addressTableLookups',
      'feeLamports',
      'computeUnitLimit',
      'computeUnitPriceMicroLamports',
      'maximumPriorityFeeLamports',
      'simulationStatus',
      'simulationUnitsConsumed',
      'instructions'
    ],
    [],
    'SolanaTransactionSummary.fields'
  )
  const messageVersion = readLiteral(
    fields.messageVersion,
    ['legacy', 'v0'],
    'Solana message version'
  )
  const feePayer = readSolanaAddress(fields.feePayer, 'SolanaTransactionSummary.fields.feePayer')
  const requiredSigners = readStringArray(
    fields.requiredSigners,
    'SolanaTransactionSummary.fields.requiredSigners'
  ).map((signer, index) =>
    readSolanaAddress(signer, `SolanaTransactionSummary.fields.requiredSigners[${index}]`)
  )
  const staticAccountKeys = readStringArray(
    fields.staticAccountKeys,
    'SolanaTransactionSummary.fields.staticAccountKeys'
  ).map((account, index) =>
    readSolanaAddress(account, `SolanaTransactionSummary.fields.staticAccountKeys[${index}]`)
  )
  if (staticAccountKeys[0] !== feePayer || requiredSigners[0] !== feePayer) {
    throw new Error('Solana fee payer must be the first static account and required signer')
  }
  const staticAccounts = new Set(staticAccountKeys)
  if (requiredSigners.some(signer => !staticAccounts.has(signer))) {
    throw new Error('Solana required signers must be static accounts')
  }
  const addressTableLookups = readArray(
    fields.addressTableLookups,
    'SolanaTransactionSummary.fields.addressTableLookups',
    readSolanaLookup,
    { allowEmpty: true }
  )
  if (messageVersion === 'legacy' && addressTableLookups.length !== 0) {
    throw new Error('Legacy Solana messages cannot contain address table lookups')
  }
  const resolvedAccounts = new Set(staticAccountKeys)
  for (const lookup of addressTableLookups) {
    for (const address of [...lookup.writableAddresses, ...lookup.readonlyAddresses]) {
      if (resolvedAccounts.has(address)) throw new Error('Solana resolved accounts must be unique')
      resolvedAccounts.add(address)
    }
  }
  const instructions = readArray(
    fields.instructions,
    'SolanaTransactionSummary.fields.instructions',
    readSolanaInstruction
  )
  const readNullableUnsigned = (value: unknown, label: string) =>
    value === null ? null : readUnsignedDecimal(value, label)
  const feeLamports = readNullableUnsigned(
    fields.feeLamports,
    'SolanaTransactionSummary.fields.feeLamports'
  )
  const computeUnitLimit = readNullableUnsigned(
    fields.computeUnitLimit,
    'SolanaTransactionSummary.fields.computeUnitLimit'
  )
  const computeUnitPriceMicroLamports = readNullableUnsigned(
    fields.computeUnitPriceMicroLamports,
    'SolanaTransactionSummary.fields.computeUnitPriceMicroLamports'
  )
  const maximumPriorityFeeLamports = readNullableUnsigned(
    fields.maximumPriorityFeeLamports,
    'SolanaTransactionSummary.fields.maximumPriorityFeeLamports'
  )
  const simulationUnitsConsumed = readNullableUnsigned(
    fields.simulationUnitsConsumed,
    'SolanaTransactionSummary.fields.simulationUnitsConsumed'
  )
  const simulationStatus = readLiteral(
    fields.simulationStatus,
    ['not-run', 'succeeded', 'failed'],
    'SolanaTransactionSummary.fields.simulationStatus'
  )
  const hasSimulationIssue = envelope.review.issues.some(
    issue => issue.code === 'simulation-failed'
  )
  if (
    (simulationStatus === 'succeeded') !== (simulationUnitsConsumed !== null) ||
    (simulationStatus === 'failed') !== hasSimulationIssue
  ) {
    throw new Error('Solana simulation review does not match its status')
  }
  const limits = instructions.filter(
    instruction =>
      instruction.interpretation.kind === 'compute-unit-limit' ||
      instruction.interpretation.kind === 'compute-request-units-deprecated'
  )
  const prices = instructions.filter(
    instruction => instruction.interpretation.kind === 'compute-unit-price'
  )
  if (limits.length > 1 || prices.length > 1) {
    throw new Error('Solana transaction has duplicate compute budget fee instructions')
  }
  const limitInterpretation = limits[0]?.interpretation
  const priceInterpretation = prices[0]?.interpretation
  const expectedLimit =
    limitInterpretation?.kind === 'compute-unit-limit' ||
    limitInterpretation?.kind === 'compute-request-units-deprecated'
      ? limitInterpretation.units
      : null
  const expectedPrice =
    priceInterpretation?.kind === 'compute-unit-price' ? priceInterpretation.microLamports : null
  const expectedPriority =
    limitInterpretation?.kind === 'compute-request-units-deprecated'
      ? limitInterpretation.additionalFeeLamports
      : expectedLimit !== null && expectedPrice !== null
        ? ((BigInt(expectedLimit) * BigInt(expectedPrice) + 999_999n) / 1_000_000n).toString()
        : null
  if (
    computeUnitLimit !== expectedLimit ||
    computeUnitPriceMicroLamports !== expectedPrice ||
    maximumPriorityFeeLamports !== expectedPriority
  ) {
    throw new Error('Solana compute budget fee summary does not match its instructions')
  }
  if (
    feeLamports !== null &&
    maximumPriorityFeeLamports !== null &&
    BigInt(maximumPriorityFeeLamports) > BigInt(feeLamports)
  ) {
    throw new Error('Solana priority fee exceeds the quoted total fee')
  }
  instructions.forEach(instruction => {
    if (!resolvedAccounts.has(instruction.programId)) {
      throw new Error('Solana instruction program is not in the resolved account keys')
    }
    for (const account of instruction.accounts) {
      if (!resolvedAccounts.has(account.address)) {
        throw new Error('Solana instruction account is not in the resolved account keys')
      }
      if ((account.source === 'static') !== staticAccounts.has(account.address)) {
        throw new Error('Solana instruction account source does not match resolved keys')
      }
    }
    if (instruction.interpretation.kind === 'unrecognized') {
      const hasIssue = envelope.review.issues.some(
        issue =>
          issue.code === 'unrecognized-instruction' && issue.subjectIndex === instruction.index
      )
      if (envelope.review.level === 'standard' || !hasIssue) {
        throw new Error('Unrecognized Solana instruction must produce a review warning')
      }
    }
  })
  const unrecognizedIndexes = new Set(
    instructions
      .filter(instruction => instruction.interpretation.kind === 'unrecognized')
      .map(instruction => instruction.index)
  )
  if (
    envelope.review.issues.some(
      issue =>
        issue.code === 'unrecognized-instruction' &&
        (issue.subjectIndex === undefined || !unrecognizedIndexes.has(issue.subjectIndex))
    )
  ) {
    throw new Error('Unrecognized Solana instruction review points to a readable instruction')
  }
  return Object.freeze({
    schema: 'solana.transaction.v1',
    chainId: envelope.chainId,
    operation: 'transaction',
    review: envelope.review,
    fields: Object.freeze({
      messageVersion,
      feePayer,
      recentBlockhash: readBase58(
        fields.recentBlockhash,
        'SolanaTransactionSummary.fields.recentBlockhash',
        32
      ),
      requiredSigners: Object.freeze(requiredSigners),
      staticAccountKeys: Object.freeze(staticAccountKeys),
      addressTableLookups,
      feeLamports,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      maximumPriorityFeeLamports,
      simulationStatus,
      simulationUnitsConsumed,
      instructions
    })
  })
}

function parseSolanaMessage(envelope: ParsedSigningSummaryEnvelope): SolanaMessageSummary {
  const fields = envelope.fields
  assertExactKeys(fields, ['signer', 'domain', 'message'], [], 'SolanaMessageSummary.fields')
  const message = readCanonicalContent(fields.message, 'SolanaMessageSummary.fields.message')
  assertReviewIssuesAllowed(envelope.review, ['opaque-message'])
  assertOpaqueContentReview(envelope.review, message)
  return Object.freeze({
    schema: 'solana.message.v1',
    chainId: envelope.chainId,
    operation: 'message',
    review: envelope.review,
    fields: Object.freeze({
      signer: readSolanaAddress(fields.signer, 'SolanaMessageSummary.fields.signer'),
      domain: readString(fields.domain, 'SolanaMessageSummary.fields.domain', 256),
      message
    })
  })
}

export function parseSolanaSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'solana.transaction.v1') return parseSolanaTransaction(envelope)
  if (envelope.schema === 'solana.message.v1') return parseSolanaMessage(envelope)
  throw new Error('Signing summary schema is not valid for Solana')
}
