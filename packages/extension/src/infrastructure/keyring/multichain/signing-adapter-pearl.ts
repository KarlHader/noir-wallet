import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type { SigningReviewIssue } from '@/core/keyring/domain/signing-summary'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import {
  assertExactKeys,
  assertRawPearlAccountMatches,
  MAX_UINT64,
  parseRawPearlAccount,
  parseRawPreparedValue,
  parseRawSignedPearlMessage,
  parseRawSignedPearlPsbt,
  readArray,
  readBoolean,
  readHex,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  readUnsignedDecimal,
  type RawDerivedPearlAccount,
  type UnknownRecord
} from './raw-wallet-engine'
import {
  canonicalContent,
  decodeBase64,
  MAX_SIGNING_ACCOUNT_INDEX,
  preparedCommand,
  sha256
} from './signing-adapter-common'

const PEARL_MAINNET = 'bip122:a18d3093b7ff618f0cdd073fa3d10374'
const PEARL_TESTNET = 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
const PEARL_MESSAGE_MAX_BYTES = 80

export type PearlSigningPreparePayload =
  | Readonly<{
      kind: 'pearl-psbt'
      chainId: ChainId
      accountIndex: number
      psbt: string
    }>
  | Readonly<{
      kind: 'pearl-bip322-message'
      chainId: ChainId
      accountIndex: number
      change: boolean
      addressIndex: number
      message: Uint8Array
    }>

export type PearlPendingSigningKind = PearlSigningPreparePayload['kind']

export interface AdaptedPearlPreparedSigning {
  readonly rawRequestId: number
  readonly kind: PearlPendingSigningKind
  readonly account: RawDerivedPearlAccount
  readonly prepared: PreparedSigningCommand
}

function readPearlChainId(value: unknown): ChainId {
  const chainId = readString(value, 'chainId', 64)
  if (chainId !== PEARL_MAINNET && chainId !== PEARL_TESTNET) {
    throw new Error('Unsupported Pearl chain ID')
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

function readMessage(value: unknown, label: string, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be bytes`)
  if (value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error(`${label} exceeds its size limit`)
  }
  return value
}

function review(issues: readonly SigningReviewIssue[], blocked = false) {
  return Object.freeze({
    level:
      issues.length === 0
        ? ('standard' as const)
        : blocked
          ? ('blocked' as const)
          : ('caution' as const),
    issues: Object.freeze([...issues])
  })
}

function parsePearlInput(value: unknown, index: number) {
  const label = `PearlPsbtSummary.inputs[${index}]`
  const record = readRecord(value, label)
  // derivationPath is Option<String> in WASM and may be omitted when null.
  assertExactKeys(
    record,
    [
      'index',
      'txid',
      'vout',
      'sequence',
      'valueSats',
      'address',
      'scriptPubKey',
      'walletOwned',
      'sighashType'
    ],
    ['derivationPath'],
    label
  )
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    transactionId: readString(record.txid, `${label}.txid`, 64),
    outputIndex: readSafeInteger(record.vout, `${label}.vout`),
    amountSats: readUnsignedDecimal(record.valueSats, `${label}.valueSats`, MAX_UINT64),
    sequence: readSafeInteger(record.sequence, `${label}.sequence`),
    scriptType: 'p2tr' as const,
    sighashType: readString(record.sighashType, `${label}.sighashType`, 64),
    ownership: readBoolean(record.walletOwned, `${label}.walletOwned`)
      ? ('signing-account' as const)
      : ('external' as const)
  })
}

function parsePearlOutput(value: unknown, index: number) {
  const label = `PearlPsbtSummary.outputs[${index}]`
  const record = readRecord(value, label)
  // derivationPath is Option<String> in WASM and may be omitted when null.
  assertExactKeys(
    record,
    ['index', 'valueSats', 'address', 'scriptPubKey', 'walletOwned', 'isChange'],
    ['derivationPath'],
    label
  )
  const address = readString(record.address, `${label}.address`, 128)
  const isChange = readBoolean(record.isChange, `${label}.isChange`)
  const walletOwned = readBoolean(record.walletOwned, `${label}.walletOwned`)
  if (isChange && !walletOwned) throw new Error('Pearl change output must be wallet owned')
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    address,
    scriptPubKeyHex: readHex(record.scriptPubKey, `${label}.scriptPubKey`),
    amountSats: readUnsignedDecimal(record.valueSats, `${label}.valueSats`, MAX_UINT64),
    classification: isChange ? ('change' as const) : ('recipient' as const)
  })
}

function requireRawSummary(
  value: unknown,
  required: readonly string[],
  label: string
): UnknownRecord {
  const record = readRecord(value, label)
  assertExactKeys(record, required, [], label)
  return record
}

export function parsePearlSigningPreparePayload(value: unknown): PearlSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  const kind = readLiteral(
    record.kind,
    ['pearl-psbt', 'pearl-bip322-message'],
    'signing.prepare kind'
  )
  if (kind === 'pearl-psbt') {
    assertExactKeys(record, ['kind', 'chainId', 'accountIndex', 'psbt'], [], 'payload')
    return Object.freeze({
      kind,
      chainId: readPearlChainId(record.chainId),
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_SIGNING_ACCOUNT_INDEX),
      psbt: readCanonicalBase64(record.psbt, 'psbt', 2 * 1024 * 1024)
    })
  }
  assertExactKeys(
    record,
    ['kind', 'chainId', 'accountIndex', 'change', 'addressIndex', 'message'],
    [],
    'payload'
  )
  return Object.freeze({
    kind,
    chainId: readPearlChainId(record.chainId),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_SIGNING_ACCOUNT_INDEX),
    change: readBoolean(record.change, 'change'),
    addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_SIGNING_ACCOUNT_INDEX),
    message: readMessage(record.message, 'message', PEARL_MESSAGE_MAX_BYTES)
  })
}

async function adaptPearlPsbt(
  raw: unknown,
  payload: Extract<PearlSigningPreparePayload, { kind: 'pearl-psbt' }>,
  account: RawDerivedPearlAccount,
  signingCommandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedPearlPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedPearlPsbt')
  assertExactKeys(prepared.value, ['requestId', 'summary'], [], 'PreparedPearlPsbt')
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    [
      'chainId',
      'network',
      'accountIndex',
      'psbtVersion',
      'unsignedTxid',
      'transactionVersion',
      'lockTime',
      'inputCount',
      'outputCount',
      'signableInputCount',
      'totalInputSats',
      'totalOutputSats',
      'feeSats',
      'inputs',
      'outputs'
    ],
    'PreparedPearlPsbt.summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.accountIndex !== payload.accountIndex ||
    rawSummary.psbtVersion !== 0
  ) {
    throw new Error('Prepared Pearl PSBT summary does not match its input')
  }
  const inputs = readArray(rawSummary.inputs, 'PearlPsbtSummary.inputs', parsePearlInput)
  const outputs = readArray(rawSummary.outputs, 'PearlPsbtSummary.outputs', parsePearlOutput)
  if (rawSummary.inputCount !== inputs.length || rawSummary.outputCount !== outputs.length) {
    throw new Error('Prepared Pearl PSBT counts do not match')
  }
  const signingInputIndexes = inputs
    .filter(input => input.ownership === 'signing-account')
    .map(input => input.index)
  if (rawSummary.signableInputCount !== signingInputIndexes.length) {
    throw new Error('Prepared Pearl PSBT signable input count does not match')
  }
  const issues: SigningReviewIssue[] = []
  if (inputs.some(input => input.ownership === 'external')) {
    issues.push(Object.freeze({ code: 'external-input' }))
  }
  if (inputs.some(input => input.sighashType !== 'SIGHASH_DEFAULT')) {
    issues.push(Object.freeze({ code: 'non-default-sighash' }))
  }
  const summary = parseSigningSummary(
    {
      schema: 'pearl.psbt.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: review(issues),
      fields: {
        psbtVersion: 0,
        signer: account.address,
        inputs,
        outputs,
        signingInputIndexes,
        totalInputSats: readUnsignedDecimal(
          rawSummary.totalInputSats,
          'totalInputSats',
          MAX_UINT64
        ),
        totalOutputSats: readUnsignedDecimal(
          rawSummary.totalOutputSats,
          'totalOutputSats',
          MAX_UINT64
        ),
        feeSats: readUnsignedDecimal(rawSummary.feeSats, 'feeSats', MAX_UINT64)
      }
    },
    { family: 'pearl', chainId: payload.chainId, operation: 'transaction' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      signingCommandId,
      payload.chainId,
      'transaction',
      summary,
      await sha256(decodeBase64(payload.psbt)),
      expiresAt
    )
  })
}

async function adaptPearlMessage(
  raw: unknown,
  payload: Extract<PearlSigningPreparePayload, { kind: 'pearl-bip322-message' }>,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedPearlPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedPearlMessage')
  assertExactKeys(prepared.value, ['requestId', 'account', 'summary'], [], 'PreparedPearlMessage')
  const account = parseRawPearlAccount(prepared.value.account)
  assertRawPearlAccountMatches(
    account,
    payload.chainId,
    payload.accountIndex,
    payload.change,
    payload.addressIndex,
    imported
  )
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    [
      'chainId',
      'network',
      'address',
      'accountIndex',
      'change',
      'addressIndex',
      'derivationPath',
      'messageHash',
      'byteLength',
      'utf8Preview',
      'previewTruncated',
      'signatureFormat'
    ],
    'PreparedPearlMessage.summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.address !== account.address ||
    rawSummary.accountIndex !== payload.accountIndex ||
    rawSummary.change !== payload.change ||
    rawSummary.addressIndex !== payload.addressIndex ||
    rawSummary.byteLength !== payload.message.byteLength ||
    rawSummary.signatureFormat !== 'bip322_simple'
  ) {
    throw new Error('Prepared Pearl message summary does not match its input')
  }
  const message = await canonicalContent(payload.message, 'utf8')
  const issues =
    message.encoding === 'utf8' ? [] : [Object.freeze({ code: 'opaque-message' as const })]
  const summary = parseSigningSummary(
    {
      schema: 'pearl.bip322-message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: review(issues),
      fields: { address: account.address, message }
    },
    { family: 'pearl', chainId: payload.chainId, operation: 'message' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      signingCommandId,
      payload.chainId,
      'message',
      summary,
      await sha256(payload.message),
      expiresAt
    )
  })
}

export async function adaptPearlPreparedSigning(
  raw: unknown,
  payload: PearlSigningPreparePayload,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  pearlAccount?: RawDerivedPearlAccount,
  imported = false
): Promise<AdaptedPearlPreparedSigning> {
  if (payload.kind === 'pearl-psbt') {
    if (!pearlAccount) throw new Error('Pearl PSBT signer account is missing')
    return adaptPearlPsbt(raw, payload, pearlAccount, signingCommandId, expiresAt)
  }
  return adaptPearlMessage(raw, payload, signingCommandId, expiresAt, imported)
}

export function adaptPearlSignedResult(
  kind: PearlPendingSigningKind,
  raw: unknown,
  account: RawDerivedPearlAccount
): SigningResult {
  if (kind === 'pearl-psbt') {
    const signed = parseRawSignedPearlPsbt(raw)
    return Object.freeze({
      kind: 'signed-payload',
      payload: Object.freeze({ encoding: 'base64', value: signed.psbt }),
      transactionId: signed.unsignedTxid
    })
  }
  const signed = parseRawSignedPearlMessage(raw)
  if (signed.address !== account.address) {
    throw new Error('Signed Pearl message address does not match the prepared account')
  }
  return Object.freeze({
    kind: 'signature',
    signature: Object.freeze({ encoding: 'base64', value: signed.signature }),
    publicKey: account.publicKey,
    address: account.address
  })
}
