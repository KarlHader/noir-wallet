import type { ChainId } from '@/core/chains/domain'
import { parseSolanaTransactionEnvelope } from '@/infrastructure/chains/solana/solana-transaction-codec'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  SolanaInstructionInterpretation,
  SolanaInstructionAccountSummary,
  SigningReviewIssue
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
  parseRawSignedSolanaMessage,
  parseRawSignedSolanaTransaction,
  readArray,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  readUnsignedDecimal,
  type RawDerivedEd25519Account
} from './raw-wallet-engine'
import {
  canonicalContent,
  decodeBase64,
  MAX_SIGNING_ACCOUNT_INDEX,
  preparedCommand,
  sha256
} from './signing-adapter-common'

const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111'
const SOLANA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SOLANA_COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const SOLANA_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
])

export interface SolanaResolvedAddressLookupTable {
  readonly accountKey: string
  readonly contextSlot: number
  readonly addresses: readonly string[]
}

export interface SolanaTransactionReviewContext {
  readonly messageBase64: string
  readonly feeLamports: string
  readonly feeContextSlot: number
  readonly simulationStatus: 'succeeded' | 'failed'
  readonly simulationUnitsConsumed: string | null
  readonly simulationContextSlot: number
  readonly lookupTables: readonly SolanaResolvedAddressLookupTable[]
}

export type SolanaSigningPreparePayload =
  | Readonly<{
      kind: 'solana-transaction'
      chainId: ChainId
      accountIndex: number
      transaction: string
      reviewContext?: SolanaTransactionReviewContext
    }>
  | Readonly<{
      kind: 'solana-message'
      chainId: ChainId
      accountIndex: number
      message: Uint8Array
    }>

export type SolanaPendingSigningKind = SolanaSigningPreparePayload['kind']

export interface AdaptedSolanaPreparedSigning {
  readonly rawRequestId: number
  readonly kind: SolanaPendingSigningKind
  readonly account: RawDerivedEd25519Account
  readonly prepared: PreparedSigningCommand
}

function readChainId(value: unknown): ChainId {
  const chainId = readString(value, 'chainId', 64)
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(chainId)) {
    throw new Error('Unsupported solana chain ID')
  }
  return chainId as ChainId
}

function readMessage(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error('Message must be bounded bytes')
  }
  return new Uint8Array(value)
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

function parseSolanaTransactionReviewContext(value: unknown): SolanaTransactionReviewContext {
  const record = readRecord(value, 'Solana transaction review context')
  assertExactKeys(
    record,
    [
      'messageBase64',
      'feeLamports',
      'feeContextSlot',
      'simulationStatus',
      'simulationUnitsConsumed',
      'simulationContextSlot',
      'lookupTables'
    ],
    [],
    'Solana transaction review context'
  )
  return Object.freeze({
    messageBase64: readCanonicalBase64(record.messageBase64, 'messageBase64', 1_644),
    feeLamports: readUnsignedDecimal(record.feeLamports, 'feeLamports'),
    feeContextSlot: readSafeInteger(record.feeContextSlot, 'feeContextSlot'),
    simulationStatus: readLiteral(
      record.simulationStatus,
      ['succeeded', 'failed'],
      'simulationStatus'
    ),
    simulationUnitsConsumed:
      record.simulationUnitsConsumed === null
        ? null
        : readUnsignedDecimal(record.simulationUnitsConsumed, 'simulationUnitsConsumed'),
    simulationContextSlot: readSafeInteger(record.simulationContextSlot, 'simulationContextSlot'),
    lookupTables: readArray(
      record.lookupTables,
      'lookupTables',
      (item, index) => {
        const table = readRecord(item, `lookupTables[${index}]`)
        assertExactKeys(
          table,
          ['accountKey', 'contextSlot', 'addresses'],
          [],
          `lookupTables[${index}]`
        )
        return Object.freeze({
          accountKey: readString(table.accountKey, `lookupTables[${index}].accountKey`, 64),
          contextSlot: readSafeInteger(table.contextSlot, `lookupTables[${index}].contextSlot`),
          addresses: Object.freeze(
            readArray(
              table.addresses,
              `lookupTables[${index}].addresses`,
              (address, addressIndex) =>
                readString(address, `lookupTables[${index}].addresses[${addressIndex}]`, 64),
              256
            )
          )
        })
      },
      32
    )
  })
}

export function parseSolanaSigningPreparePayload(value: unknown): SolanaSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  const kind = readLiteral(
    record.kind,
    ['solana-transaction', 'solana-message'],
    'signing.prepare kind'
  )
  if (kind === 'solana-transaction') {
    assertExactKeys(
      record,
      ['kind', 'chainId', 'accountIndex', 'transaction'],
      ['reviewContext'],
      'payload'
    )
    return Object.freeze({
      kind,
      chainId: readChainId(record.chainId),
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_SIGNING_ACCOUNT_INDEX),
      transaction: readCanonicalBase64(record.transaction, 'transaction', 2_464),
      ...(record.reviewContext === undefined
        ? {}
        : { reviewContext: parseSolanaTransactionReviewContext(record.reviewContext) })
    })
  }
  assertExactKeys(record, ['kind', 'chainId', 'accountIndex', 'message'], [], 'payload')
  return Object.freeze({
    kind,
    chainId: readChainId(record.chainId),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_SIGNING_ACCOUNT_INDEX),
    message: readMessage(record.message, 256 * 1024)
  })
}

function parseSolanaInstruction(
  value: unknown,
  index: number,
  staticKeys: readonly string[],
  resolvedKeys: readonly string[],
  lookupWritableCount: number,
  requiredSignatures: number,
  readonlySigned: number,
  readonlyUnsigned: number
) {
  const record = readRecord(value, `Solana instruction ${index}`)
  assertExactKeys(
    record,
    ['programIdIndex', 'programId', 'accountIndexes', 'data'],
    [],
    'instruction'
  )
  const programIndex = readSafeInteger(record.programIdIndex, 'programIdIndex', 255)
  const programId = readString(record.programId, 'programId', 64)
  if (resolvedKeys[programIndex] !== programId)
    throw new Error('Solana instruction program is unresolved')
  const accountIndexes = readArray(
    record.accountIndexes,
    'accountIndexes',
    item => readSafeInteger(item, 'accountIndex', 255),
    256
  )
  const accounts = accountIndexes.map(accountIndex => {
    const address = resolvedKeys[accountIndex]
    if (!address) throw new Error('Solana instruction account is unresolved')
    const source = accountIndex < staticKeys.length ? ('static' as const) : ('lookup' as const)
    const signer = source === 'static' && accountIndex < requiredSignatures
    const writable =
      source === 'lookup'
        ? accountIndex < staticKeys.length + lookupWritableCount
        : signer
          ? accountIndex < requiredSignatures - readonlySigned
          : accountIndex < staticKeys.length - readonlyUnsigned
    return Object.freeze({ address, signer, writable, source })
  })
  const dataBase64 = readCanonicalBase64(record.data, 'instruction.data', 4_096)
  return { programId, accounts, dataBase64 }
}

export function interpretSolanaInstruction(
  programId: string,
  accounts: readonly SolanaInstructionAccountSummary[],
  data: Uint8Array
): SolanaInstructionInterpretation {
  if (programId === SOLANA_COMPUTE_BUDGET_PROGRAM && accounts.length === 0) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (data.byteLength === 9 && data[0] === 0) {
      return Object.freeze({
        kind: 'compute-request-units-deprecated',
        units: view.getUint32(1, true).toString(),
        additionalFeeLamports: view.getUint32(5, true).toString()
      })
    }
    if (data.byteLength === 5 && data[0] === 1) {
      return Object.freeze({
        kind: 'compute-request-heap-frame',
        bytes: view.getUint32(1, true).toString()
      })
    }
    if (data.byteLength === 5 && data[0] === 2) {
      return Object.freeze({
        kind: 'compute-unit-limit',
        units: view.getUint32(1, true).toString()
      })
    }
    if (data.byteLength === 9 && data[0] === 3) {
      return Object.freeze({
        kind: 'compute-unit-price',
        microLamports: view.getBigUint64(1, true).toString()
      })
    }
    if (data.byteLength === 5 && data[0] === 4) {
      return Object.freeze({
        kind: 'compute-loaded-accounts-data-size-limit',
        bytes: view.getUint32(1, true).toString()
      })
    }
  }
  if (
    programId === SOLANA_SYSTEM_PROGRAM &&
    accounts.length === 2 &&
    accounts[0].signer &&
    accounts[0].writable &&
    !accounts[1].signer &&
    accounts[1].writable &&
    data.byteLength === 12
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (view.getUint32(0, true) === 2) {
      return Object.freeze({
        kind: 'system-transfer',
        from: accounts[0].address,
        to: accounts[1].address,
        lamports: view.getBigUint64(4, true).toString()
      })
    }
  }
  if (
    SOLANA_TOKEN_PROGRAMS.has(programId) &&
    accounts.length === 4 &&
    accounts[0].writable &&
    !accounts[1].writable &&
    accounts[2].writable &&
    accounts[3].signer &&
    data.byteLength === 10 &&
    data[0] === 12
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    return Object.freeze({
      kind: 'spl-token-transfer',
      source: accounts[0].address,
      mint: accounts[1].address,
      destination: accounts[2].address,
      authority: accounts[3].address,
      amountRaw: view.getBigUint64(1, true).toString(),
      decimals: view.getUint8(9)
    })
  }
  if (
    programId === SOLANA_ASSOCIATED_TOKEN_PROGRAM &&
    accounts.length === 6 &&
    accounts[0].signer &&
    accounts[0].writable &&
    accounts[1].writable &&
    !accounts[2].writable &&
    !accounts[3].writable &&
    accounts[4].address === SOLANA_SYSTEM_PROGRAM &&
    SOLANA_TOKEN_PROGRAMS.has(accounts[5].address) &&
    data.byteLength === 1 &&
    data[0] === 1
  ) {
    return Object.freeze({
      kind: 'associated-token-create-idempotent',
      payer: accounts[0].address,
      associatedAccount: accounts[1].address,
      owner: accounts[2].address,
      mint: accounts[3].address,
      tokenProgram: accounts[5].address
    })
  }
  return Object.freeze({ kind: 'unrecognized' })
}

async function adaptSolanaTransaction(
  raw: unknown,
  payload: Extract<SolanaSigningPreparePayload, { kind: 'solana-transaction' }>,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedSolanaPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedSolanaTransaction')
  assertExactKeys(
    prepared.value,
    ['requestId', 'account', 'messageHash', 'summary'],
    [],
    'prepared'
  )
  const account = parseRawEd25519Account(prepared.value.account, 'solana')
  assertRawEd25519AccountMatches(account, 'solana', payload.chainId, payload.accountIndex, imported)
  const rawSummary = readRecord(prepared.value.summary, 'PreparedSolanaTransaction.summary')
  assertExactKeys(
    rawSummary,
    [
      'chainId',
      'version',
      'signer',
      'signerIndex',
      'feePayer',
      'recentBlockhash',
      'requiredSignatures',
      'readonlySignedAccounts',
      'readonlyUnsignedAccounts',
      'existingSignatureIndexes',
      'staticAccountKeys',
      'instructions',
      'addressTableLookups'
    ],
    [],
    'Solana summary'
  )
  if (rawSummary.chainId !== payload.chainId || rawSummary.signer !== account.address) {
    throw new Error('Prepared Solana transaction signer does not match')
  }
  const transactionEnvelope = parseSolanaTransactionEnvelope(payload.transaction)
  const messageVersion = readLiteral(rawSummary.version, ['legacy', 'v0'], 'version')
  if (messageVersion !== transactionEnvelope.messageVersion) {
    throw new Error('Solana message version does not match the transaction bytes')
  }
  const context = payload.reviewContext
  if (context && context.messageBase64 !== transactionEnvelope.messageBase64) {
    throw new Error('Solana fee quote is bound to a different transaction message')
  }
  const lookups = readArray(
    rawSummary.addressTableLookups,
    'addressTableLookups',
    (item, index) => {
      const lookup = readRecord(item, `addressTableLookups[${index}]`)
      assertExactKeys(
        lookup,
        ['accountKey', 'writableIndexes', 'readonlyIndexes'],
        [],
        `addressTableLookups[${index}]`
      )
      return Object.freeze({
        accountKey: readString(lookup.accountKey, `addressTableLookups[${index}].accountKey`, 64),
        writableIndexes: Object.freeze(
          readArray(
            lookup.writableIndexes,
            `addressTableLookups[${index}].writableIndexes`,
            item => readSafeInteger(item, 'writable lookup index', 255),
            256
          )
        ),
        readonlyIndexes: Object.freeze(
          readArray(
            lookup.readonlyIndexes,
            `addressTableLookups[${index}].readonlyIndexes`,
            item => readSafeInteger(item, 'readonly lookup index', 255),
            256
          )
        )
      })
    },
    32
  )
  if (lookups.length !== transactionEnvelope.addressTableLookups.length) {
    throw new Error('Solana address lookup table summary does not match the transaction')
  }
  const staticKeys = readArray(
    rawSummary.staticAccountKeys,
    'staticAccountKeys',
    item => readString(item, 'static account', 64),
    256
  )
  const requiredSignatures = readSafeInteger(
    rawSummary.requiredSignatures,
    'requiredSignatures',
    256
  )
  const readonlySigned = readSafeInteger(
    rawSummary.readonlySignedAccounts,
    'readonlySignedAccounts',
    256
  )
  const readonlyUnsigned = readSafeInteger(
    rawSummary.readonlyUnsignedAccounts,
    'readonlyUnsignedAccounts',
    256
  )
  const resolvedLookups = lookups.map((lookup, index) => {
    const envelopeLookup = transactionEnvelope.addressTableLookups[index]
    if (
      !envelopeLookup ||
      lookup.accountKey !== envelopeLookup.accountKey ||
      lookup.writableIndexes.join(',') !== envelopeLookup.writableIndexes.join(',') ||
      lookup.readonlyIndexes.join(',') !== envelopeLookup.readonlyIndexes.join(',')
    ) {
      throw new Error('Solana address lookup table indexes do not match the transaction')
    }
    const table = context?.lookupTables[index]
    if (!table || table.accountKey !== lookup.accountKey) {
      throw new Error('Solana address lookup table is unresolved')
    }
    const resolve = (lookupIndex: number) => {
      const address = table.addresses[lookupIndex]
      if (!address) throw new Error('Solana address lookup table index is unresolved')
      return address
    }
    return Object.freeze({
      accountKey: lookup.accountKey,
      writableAddresses: Object.freeze(lookup.writableIndexes.map(resolve)),
      readonlyAddresses: Object.freeze(lookup.readonlyIndexes.map(resolve))
    })
  })
  if (context && context.lookupTables.length !== resolvedLookups.length) {
    throw new Error('Solana review context contains unrelated address lookup tables')
  }
  const loadedWritable = resolvedLookups.flatMap(lookup => lookup.writableAddresses)
  const loadedReadonly = resolvedLookups.flatMap(lookup => lookup.readonlyAddresses)
  const resolvedKeys = Object.freeze([...staticKeys, ...loadedWritable, ...loadedReadonly])
  const parsedInstructions = await Promise.all(
    readArray(rawSummary.instructions, 'instructions', (item, index) => ({ item, index }), 256).map(
      async ({ item, index }) => {
        const parsed = parseSolanaInstruction(
          item,
          index,
          staticKeys,
          resolvedKeys,
          loadedWritable.length,
          requiredSignatures,
          readonlySigned,
          readonlyUnsigned
        )
        const data = decodeBase64(parsed.dataBase64)
        return Object.freeze({
          index,
          programId: parsed.programId,
          accounts: Object.freeze(parsed.accounts),
          data: await canonicalContent(data, 'base64'),
          interpretation: interpretSolanaInstruction(parsed.programId, parsed.accounts, data)
        })
      }
    )
  )
  if (
    context &&
    (context.simulationStatus === 'succeeded') !== (context.simulationUnitsConsumed !== null)
  ) {
    throw new Error('Solana simulation context is inconsistent')
  }
  const issues: readonly SigningReviewIssue[] = Object.freeze([
    ...parsedInstructions.flatMap(instruction =>
      instruction.interpretation.kind === 'unrecognized'
        ? [
            Object.freeze({
              code: 'unrecognized-instruction' as const,
              subjectIndex: instruction.index
            })
          ]
        : []
    ),
    ...(context?.simulationStatus === 'failed'
      ? [Object.freeze({ code: 'simulation-failed' as const })]
      : [])
  ])
  const unitLimits = parsedInstructions.flatMap(instruction =>
    instruction.interpretation.kind === 'compute-unit-limit' ||
    instruction.interpretation.kind === 'compute-request-units-deprecated'
      ? [instruction.interpretation]
      : []
  )
  const unitPrices = parsedInstructions.flatMap(instruction =>
    instruction.interpretation.kind === 'compute-unit-price' ? [instruction.interpretation] : []
  )
  if (unitLimits.length > 1 || unitPrices.length > 1) {
    throw new Error('Solana transaction has duplicate compute budget fee instructions')
  }
  const unitLimit = unitLimits[0]
  const unitPrice = unitPrices[0]
  const computeUnitLimit = unitLimit?.units ?? null
  const computeUnitPriceMicroLamports = unitPrice?.microLamports ?? null
  const maximumPriorityFeeLamports =
    unitLimit?.kind === 'compute-request-units-deprecated'
      ? unitLimit.additionalFeeLamports
      : computeUnitLimit !== null && computeUnitPriceMicroLamports !== null
        ? (
            (BigInt(computeUnitLimit) * BigInt(computeUnitPriceMicroLamports) + 999_999n) /
            1_000_000n
          ).toString()
        : null
  const summary = parseSigningSummary(
    {
      schema: 'solana.transaction.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: { level: issues.length === 0 ? 'standard' : 'caution', issues },
      fields: {
        messageVersion,
        feePayer: readString(rawSummary.feePayer, 'feePayer', 64),
        recentBlockhash: readString(rawSummary.recentBlockhash, 'recentBlockhash', 64),
        requiredSigners: staticKeys.slice(0, requiredSignatures),
        staticAccountKeys: staticKeys,
        addressTableLookups: resolvedLookups,
        feeLamports: context?.feeLamports ?? null,
        computeUnitLimit,
        computeUnitPriceMicroLamports,
        maximumPriorityFeeLamports,
        simulationStatus: context?.simulationStatus ?? 'not-run',
        simulationUnitsConsumed: context?.simulationUnitsConsumed ?? null,
        instructions: parsedInstructions
      }
    },
    { family: 'solana', chainId: payload.chainId, operation: 'transaction' }
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
      await sha256(decodeBase64(payload.transaction)),
      expiresAt
    )
  })
}

async function adaptSolanaMessage(
  raw: unknown,
  payload: Extract<SolanaSigningPreparePayload, { kind: 'solana-message' }>,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedSolanaPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedSolanaMessage')
  assertExactKeys(prepared.value, ['requestId', 'account', 'summary'], [], 'prepared')
  const account = parseRawEd25519Account(prepared.value.account, 'solana')
  assertRawEd25519AccountMatches(account, 'solana', payload.chainId, payload.accountIndex, imported)
  const rawSummary = readRecord(prepared.value.summary, 'PreparedSolanaMessage.summary')
  assertExactKeys(
    rawSummary,
    ['chainId', 'signer', 'messageHash', 'byteLength', 'utf8Preview', 'previewTruncated'],
    [],
    'Solana message summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.signer !== account.address ||
    rawSummary.byteLength !== payload.message.byteLength
  ) {
    throw new Error('Prepared Solana message does not match its input')
  }
  const message = await canonicalContent(payload.message, 'utf8')
  const issues = message.encoding === 'utf8' ? [] : [{ code: 'opaque-message' as const }]
  const summary = parseSigningSummary(
    {
      schema: 'solana.message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: { level: issues.length === 0 ? 'standard' : 'caution', issues },
      fields: { signer: account.address, domain: 'solana:raw-message', message }
    },
    { family: 'solana', chainId: payload.chainId, operation: 'message' }
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
      await sha256(payload.message),
      expiresAt
    )
  })
}

export async function adaptSolanaPreparedSigning(
  raw: unknown,
  payload: SolanaSigningPreparePayload,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedSolanaPreparedSigning> {
  switch (payload.kind) {
    case 'solana-transaction':
      return adaptSolanaTransaction(raw, payload, commandId, expiresAt, imported)
    case 'solana-message':
      return adaptSolanaMessage(raw, payload, commandId, expiresAt, imported)
  }
}

export function adaptSolanaSignedResult(
  kind: SolanaPendingSigningKind,
  raw: unknown,
  account: RawDerivedEd25519Account
): SigningResult {
  switch (kind) {
    case 'solana-transaction': {
      const signed = parseRawSignedSolanaTransaction(raw)
      return Object.freeze({
        kind: 'signed-payload',
        payload: Object.freeze({ encoding: 'base64', value: signed.transaction }),
        transactionId: signed.signature
      })
    }
    case 'solana-message': {
      const signed = parseRawSignedSolanaMessage(raw)
      if (signed.publicKey !== account.publicKey)
        throw new Error('Solana signed message public key mismatch')
      return Object.freeze({
        kind: 'signature',
        signature: Object.freeze({ encoding: 'utf8', value: signed.signature }),
        publicKey: account.publicKey,
        address: account.address
      })
    }
  }
}
