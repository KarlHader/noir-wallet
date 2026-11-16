import type { ChainId } from '@/core/chains/domain'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  CanonicalContent,
  EvmTypedDataValue,
  SigningReview,
  SigningReviewIssue,
  SigningSummary
} from '@/core/keyring/domain/signing-summary'
import {
  assertExactKeys,
  assertRawBitcoinAccountMatches,
  assertRawEvmAccountMatches,
  MAX_BIP32_INDEX,
  MAX_UINT64,
  parseRawBitcoinAccount,
  parseRawEvmAccount,
  parseRawPeaExecutionAccount,
  parseRawGlobalPeaAccount,
  parseRawPreparedValue,
  parseRawSignedBitcoinMessage,
  parseRawSignedBitcoinPsbt,
  parseRawSignedEvmMessage,
  parseRawSignedEvmTransaction,
  RAW_BITCOIN_ADDRESS_TYPES,
  readArray,
  readBoolean,
  readBoundedString,
  readHex,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  readUnsignedDecimal,
  type RawBitcoinAddressType,
  type RawDerivedAccount,
  type RawDerivedBitcoinAccount,
  type RawDerivedEd25519Account,
  type RawDerivedPeaAccount,
  type RawPeaExecutionAccount,
  type UnknownRecord
} from './raw-wallet-engine'
import {
  adaptNearPreparedSigning,
  adaptNearSignedResult,
  parseNearSigningPreparePayload,
  type NearSigningPreparePayload
} from './signing-adapter-near'
import {
  adaptSolanaPreparedSigning,
  adaptSolanaSignedResult,
  parseSolanaSigningPreparePayload,
  type SolanaSigningPreparePayload
} from './signing-adapter-solana'

const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const textEncoder = new TextEncoder()
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })

interface EvmAccessListItem {
  readonly address: string
  readonly storageKeys: readonly string[]
}

type EvmTransaction =
  | {
      readonly type: 'legacy'
      readonly chainId: string
      readonly nonce: string
      readonly gasPrice: string
      readonly gasLimit: string
      readonly to: string | null
      readonly value: string
      readonly input: string
    }
  | {
      readonly type: 'eip2930'
      readonly chainId: string
      readonly nonce: string
      readonly gasPrice: string
      readonly gasLimit: string
      readonly to: string | null
      readonly value: string
      readonly input: string
      readonly accessList: readonly EvmAccessListItem[]
    }
  | {
      readonly type: 'eip1559'
      readonly chainId: string
      readonly nonce: string
      readonly maxFeePerGas: string
      readonly maxPriorityFeePerGas: string
      readonly gasLimit: string
      readonly to: string | null
      readonly value: string
      readonly input: string
      readonly accessList: readonly EvmAccessListItem[]
    }

export type ParsedSigningPreparePayload =
  | SolanaSigningPreparePayload
  | NearSigningPreparePayload
  | {
      readonly kind: 'pea-evm-transaction'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly transaction: EvmTransaction
    }
  | {
      readonly kind: 'evm-transaction'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly transaction: EvmTransaction
    }
  | {
      readonly kind: 'pea-evm-personal-message'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly message: Uint8Array
    }
  | {
      readonly kind: 'evm-personal-message'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly message: Uint8Array
    }
  | {
      readonly kind: 'pea-evm-typed-data'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly typedDataJson: string
    }
  | {
      readonly kind: 'evm-typed-data'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly typedDataJson: string
    }
  | {
      readonly kind: 'bitcoin-psbt'
      readonly chainId: ChainId
      readonly addressType: RawBitcoinAddressType
      readonly accountIndex: number
      readonly psbt: string
    }
  | {
      readonly kind: 'bitcoin-bip322-message'
      readonly chainId: ChainId
      readonly addressType: RawBitcoinAddressType
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
      readonly message: Uint8Array
    }

export type PendingSigningKind = ParsedSigningPreparePayload['kind']

export interface AdaptedPreparedSigning {
  readonly rawRequestId: number
  readonly kind: PendingSigningKind
  readonly account:
    | RawDerivedAccount
    | RawDerivedBitcoinAccount
    | RawDerivedEd25519Account
    | RawDerivedPeaAccount
    | RawPeaExecutionAccount
  readonly prepared: PreparedSigningCommand
}

function parseChainId(value: unknown, namespace: 'eip155' | 'bip122'): ChainId {
  const chainId = readString(value, 'chainId', 64)
  if (namespace === 'eip155') {
    if (!/^eip155:(?:0|[1-9][0-9]*)$/.test(chainId)) throw new Error('Unsupported EVM chain ID')
    if (BigInt(chainId.slice('eip155:'.length)) > MAX_UINT64) {
      throw new Error('Unsupported EVM chain ID')
    }
  } else if (chainId !== BITCOIN_MAINNET && chainId !== BITCOIN_TESTNET) {
    throw new Error('Unsupported Bitcoin chain ID')
  }
  return chainId as ChainId
}

function readEvmAddress(value: unknown, label: string): string {
  const address = readString(value, label, 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${label} is invalid`)
  return address
}

function readNullableEvmAddress(value: unknown, label: string): string | null {
  return value === null ? null : readEvmAddress(value, label)
}

function evmAddressesMatch(left: unknown, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return (
    typeof left === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(left) &&
    left.toLowerCase() === right.toLowerCase()
  )
}

function parseAccessList(value: unknown): readonly EvmAccessListItem[] {
  return readArray(value, 'transaction.accessList', (item, index) => {
    const label = `transaction.accessList[${index}]`
    const record = readRecord(item, label)
    assertExactKeys(record, ['address', 'storageKeys'], [], label)
    return Object.freeze({
      address: readEvmAddress(record.address, `${label}.address`),
      storageKeys: readArray(record.storageKeys, `${label}.storageKeys`, (key, keyIndex) =>
        readHex(key, `${label}.storageKeys[${keyIndex}]`, { bytes: 32 })
      )
    })
  })
}

function parseEvmTransaction(value: unknown): EvmTransaction {
  const record = readRecord(value, 'transaction')
  const type = readLiteral(record.type, ['legacy', 'eip2930', 'eip1559'], 'transaction.type')
  const commonKeys = ['type', 'chainId', 'nonce', 'gasLimit', 'to', 'value', 'input']
  const common = {
    type,
    chainId: readUnsignedDecimal(record.chainId, 'transaction.chainId', MAX_UINT64),
    nonce: readUnsignedDecimal(record.nonce, 'transaction.nonce', MAX_UINT64),
    gasLimit: readUnsignedDecimal(record.gasLimit, 'transaction.gasLimit', MAX_UINT64),
    to: readNullableEvmAddress(record.to, 'transaction.to'),
    value: readUnsignedDecimal(record.value, 'transaction.value'),
    input: readHex(record.input, 'transaction.input', { maximumBytes: 128 * 1024 })
  }
  if (type === 'legacy') {
    assertExactKeys(record, [...commonKeys, 'gasPrice'], [], 'transaction')
    return Object.freeze({
      ...common,
      type,
      gasPrice: readUnsignedDecimal(record.gasPrice, 'transaction.gasPrice')
    })
  }
  if (type === 'eip2930') {
    assertExactKeys(record, [...commonKeys, 'gasPrice', 'accessList'], [], 'transaction')
    return Object.freeze({
      ...common,
      type,
      gasPrice: readUnsignedDecimal(record.gasPrice, 'transaction.gasPrice'),
      accessList: parseAccessList(record.accessList)
    })
  }
  assertExactKeys(
    record,
    [...commonKeys, 'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList'],
    [],
    'transaction'
  )
  const maxFeePerGas = readUnsignedDecimal(record.maxFeePerGas, 'transaction.maxFeePerGas')
  const maxPriorityFeePerGas = readUnsignedDecimal(
    record.maxPriorityFeePerGas,
    'transaction.maxPriorityFeePerGas'
  )
  if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new Error('transaction max priority fee exceeds max fee')
  }
  return Object.freeze({
    ...common,
    type,
    maxFeePerGas,
    maxPriorityFeePerGas,
    accessList: parseAccessList(record.accessList)
  })
}

function readMessage(value: unknown, label: string, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error(`${label} must be bounded bytes`)
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

export function parseSigningPreparePayload(value: unknown): ParsedSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  if (record.kind === 'solana-transaction' || record.kind === 'solana-message') {
    return parseSolanaSigningPreparePayload(record)
  }
  if (record.kind === 'near-transaction' || record.kind === 'near-nep413-message') {
    return parseNearSigningPreparePayload(record)
  }
  const kind = readLiteral(
    record.kind,
    [
      'evm-transaction',
      'pea-evm-transaction',
      'evm-personal-message',
      'pea-evm-personal-message',
      'evm-typed-data',
      'pea-evm-typed-data',
      'bitcoin-psbt',
      'bitcoin-bip322-message'
    ],
    'signing.prepare kind'
  )
  if (kind === 'evm-transaction' || kind === 'pea-evm-transaction') {
    assertExactKeys(record, ['kind', 'chainId', 'addressIndex', 'transaction'], [], 'payload')
    const chainId = parseChainId(record.chainId, 'eip155')
    const transaction = parseEvmTransaction(record.transaction)
    if (transaction.chainId !== chainId.slice('eip155:'.length)) {
      throw new Error('EVM transaction chain ID does not match the selected chain')
    }
    return Object.freeze({
      kind,
      chainId,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
      transaction
    })
  }
  if (kind === 'evm-personal-message' || kind === 'pea-evm-personal-message') {
    assertExactKeys(record, ['kind', 'chainId', 'addressIndex', 'message'], [], 'payload')
    return Object.freeze({
      kind,
      chainId: parseChainId(record.chainId, 'eip155'),
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
      message: readMessage(record.message, 'message', 256 * 1024)
    })
  }
  if (kind === 'evm-typed-data' || kind === 'pea-evm-typed-data') {
    assertExactKeys(record, ['kind', 'chainId', 'addressIndex', 'typedDataJson'], [], 'payload')
    return Object.freeze({
      kind,
      chainId: parseChainId(record.chainId, 'eip155'),
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
      typedDataJson: readString(record.typedDataJson, 'typedDataJson', 256 * 1024)
    })
  }
  if (kind === 'bitcoin-psbt') {
    assertExactKeys(
      record,
      ['kind', 'chainId', 'addressType', 'accountIndex', 'psbt'],
      [],
      'payload'
    )
    return Object.freeze({
      kind,
      chainId: parseChainId(record.chainId, 'bip122'),
      addressType: readLiteral(record.addressType, RAW_BITCOIN_ADDRESS_TYPES, 'addressType'),
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
      psbt: readCanonicalBase64(record.psbt, 'psbt', 2 * 1024 * 1024)
    })
  }
  assertExactKeys(
    record,
    ['kind', 'chainId', 'addressType', 'accountIndex', 'change', 'addressIndex', 'message'],
    [],
    'payload'
  )
  return Object.freeze({
    kind,
    chainId: parseChainId(record.chainId, 'bip122'),
    addressType: readLiteral(record.addressType, RAW_BITCOIN_ADDRESS_TYPES, 'addressType'),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
    change: readBoolean(record.change, 'change'),
    addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
    message: readMessage(record.message, 'message', 4 * 1024)
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length - 2) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16)
  }
  return bytes
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

async function canonicalContent(bytes: Uint8Array, preferred: 'hex' | 'base64' | 'utf8') {
  let encoding = preferred
  let value: string
  if (preferred === 'utf8') {
    try {
      const decoded = strictTextDecoder.decode(bytes)
      const encoded = textEncoder.encode(decoded)
      if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
        throw new Error('non-canonical UTF-8')
      }
      value = decoded
    } catch {
      encoding = 'hex'
      value = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
    }
  } else if (preferred === 'hex') {
    value = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  } else {
    value = btoa(String.fromCharCode(...bytes))
  }
  return Object.freeze({
    encoding,
    value,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes)
  }) as CanonicalContent
}

function review(issues: readonly SigningReviewIssue[], blocked = false): SigningReview {
  return Object.freeze({
    level: issues.length === 0 ? 'standard' : blocked ? 'blocked' : 'caution',
    issues: Object.freeze(issues)
  })
}

function preparedCommand(
  signingCommandId: SigningCommandId,
  chainId: ChainId,
  operation: 'transaction' | 'message',
  summary: SigningSummary,
  fingerprint: string,
  expiresAt: number
): PreparedSigningCommand {
  return Object.freeze({
    commandId: signingCommandId,
    chainId,
    operation,
    summary,
    payloadFingerprint: Object.freeze({ algorithm: 'sha256', digestHex: fingerprint }),
    execution: Object.freeze({ kind: 'internal' }),
    expiresAt
  })
}

function requireRawSummary(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  const summary = readRecord(value, label)
  assertExactKeys(summary, keys, [], label)
  return summary
}

async function adaptEvmTransaction(
  raw: unknown,
  payload: Extract<
    ParsedSigningPreparePayload,
    { kind: 'evm-transaction' | 'pea-evm-transaction' }
  >,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedEvmTransaction')
  assertExactKeys(
    prepared.value,
    ['requestId', 'account', 'signingHash', 'summary'],
    [],
    'PreparedEvmTransaction'
  )
  const account =
    payload.kind === 'pea-evm-transaction'
      ? parseRawPeaExecutionAccount(prepared.value.account, payload.chainId, payload.addressIndex)
      : parseRawEvmAccount(prepared.value.account)
  if (payload.kind === 'evm-transaction') {
    assertRawEvmAccountMatches(
      account as RawDerivedAccount,
      payload.chainId,
      payload.addressIndex,
      imported
    )
  }
  readHex(prepared.value.signingHash, 'PreparedEvmTransaction.signingHash', {
    bytes: 32
  })
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    [
      'transactionType',
      'chainId',
      'from',
      'to',
      'valueWei',
      'gasLimit',
      'maximumFeeWei',
      'calldataBytes',
      'methodSelector'
    ],
    'PreparedEvmTransaction.summary'
  )
  const transaction = payload.transaction
  const calldataBytes = decodeHex(transaction.input)
  const maximumFeeWei =
    transaction.type === 'eip1559'
      ? (BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas)).toString()
      : (BigInt(transaction.gasLimit) * BigInt(transaction.gasPrice)).toString()
  if (
    rawSummary.transactionType !== transaction.type ||
    rawSummary.chainId !== payload.chainId ||
    rawSummary.from !== account.address ||
    !evmAddressesMatch(rawSummary.to, transaction.to) ||
    rawSummary.valueWei !== transaction.value ||
    rawSummary.gasLimit !== transaction.gasLimit ||
    rawSummary.maximumFeeWei !== maximumFeeWei ||
    rawSummary.calldataBytes !== calldataBytes.byteLength
  ) {
    throw new Error('Prepared EVM transaction summary does not match its input')
  }
  const methodSelector =
    calldataBytes.byteLength >= 4 ? transaction.input.slice(0, 10).toLowerCase() : null
  if (rawSummary.methodSelector !== methodSelector) {
    throw new Error('Prepared EVM transaction method selector does not match its input')
  }
  const issues: SigningReviewIssue[] = []
  if (transaction.to === null) issues.push(Object.freeze({ code: 'contract-creation' }))
  if (transaction.to !== null && calldataBytes.byteLength > 0) {
    issues.push(Object.freeze({ code: 'unrecognized-call' }))
  }
  const summary = parseSigningSummary(
    {
      schema: 'evm.transaction.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: review(issues),
      fields: {
        transactionType: transaction.type,
        from: account.address,
        to: transaction.to,
        nonce: transaction.nonce,
        valueWei: transaction.value,
        gasLimit: transaction.gasLimit,
        maximumFeeWei,
        gasPriceWei: transaction.type === 'eip1559' ? null : transaction.gasPrice,
        maxFeePerGasWei: transaction.type === 'eip1559' ? transaction.maxFeePerGas : null,
        maxPriorityFeePerGasWei:
          transaction.type === 'eip1559' ? transaction.maxPriorityFeePerGas : null,
        accessList: transaction.type === 'legacy' ? [] : transaction.accessList,
        calldata: await canonicalContent(calldataBytes, 'hex'),
        methodSelector
      }
    },
    { family: 'evm', chainId: payload.chainId, operation: 'transaction' }
  )
  const fingerprint = await sha256(textEncoder.encode(JSON.stringify(transaction)))
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      signingCommandId,
      payload.chainId,
      'transaction',
      summary,
      fingerprint,
      expiresAt
    )
  })
}

async function adaptEvmPersonalMessage(
  raw: unknown,
  payload: Extract<
    ParsedSigningPreparePayload,
    { kind: 'evm-personal-message' | 'pea-evm-personal-message' }
  >,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedEvmPersonalMessage')
  assertExactKeys(
    prepared.value,
    ['requestId', 'account', 'summary'],
    [],
    'PreparedEvmPersonalMessage'
  )
  const account =
    payload.kind === 'pea-evm-personal-message'
      ? parseRawGlobalPeaAccount(prepared.value.account, payload.addressIndex)
      : parseRawEvmAccount(prepared.value.account)
  if (payload.kind === 'evm-personal-message') {
    assertRawEvmAccountMatches(
      account as RawDerivedAccount,
      payload.chainId,
      payload.addressIndex,
      imported
    )
  }
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    payload.kind === 'pea-evm-personal-message'
      ? ['from', 'byteLength', 'utf8Preview', 'previewTruncated']
      : ['chainId', 'from', 'byteLength', 'utf8Preview', 'previewTruncated'],
    'PreparedEvmPersonalMessage.summary'
  )
  if (
    (payload.kind === 'pea-evm-personal-message'
      ? Object.prototype.hasOwnProperty.call(rawSummary, 'chainId')
      : rawSummary.chainId !== payload.chainId) ||
    rawSummary.from !== account.address ||
    rawSummary.byteLength !== payload.message.byteLength
  ) {
    throw new Error('Prepared EVM message summary does not match its input')
  }
  const message = await canonicalContent(payload.message, 'utf8')
  const issues =
    message.encoding === 'utf8' ? [] : [Object.freeze({ code: 'opaque-message' as const })]
  const summary = parseSigningSummary(
    {
      schema: 'evm.personal-message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: review(issues),
      fields: { signer: account.address, message }
    },
    { family: 'evm', chainId: payload.chainId, operation: 'message' }
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

interface TypedDataProperty {
  readonly name: string
  readonly type: string
}

interface ParsedTypedData {
  readonly types: Readonly<Record<string, readonly TypedDataProperty[]>>
  readonly primaryType: string
  readonly domain: UnknownRecord
  readonly message: UnknownRecord
}

function parseTypedDataJson(value: string): ParsedTypedData {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('typedDataJson must be valid JSON')
  }
  const record = readRecord(parsed, 'typed data')
  assertExactKeys(record, ['types', 'primaryType', 'domain', 'message'], [], 'typed data')
  const typeRecord = readRecord(record.types, 'typed data.types')
  const types = Object.freeze(
    Object.fromEntries(
      Object.entries(typeRecord).map(([typeName, properties]) => {
        readString(typeName, 'typed data type name', 256)
        const fields = readArray(properties, `typed data.types.${typeName}`, (property, index) => {
          const label = `typed data.types.${typeName}[${index}]`
          const field = readRecord(property, label)
          assertExactKeys(field, ['name', 'type'], [], label)
          return Object.freeze({
            name: readString(field.name, `${label}.name`, 256),
            type: readString(field.type, `${label}.type`, 256)
          })
        })
        if (new Set(fields.map(field => field.name)).size !== fields.length) {
          throw new Error(`typed data type ${typeName} contains duplicate fields`)
        }
        return [typeName, fields]
      })
    )
  )
  const primaryType = readString(record.primaryType, 'typed data.primaryType', 256)
  if (!types.EIP712Domain || !types[primaryType]) throw new Error('typed data types are incomplete')
  return Object.freeze({
    types,
    primaryType,
    domain: readRecord(record.domain, 'typed data.domain'),
    message: readRecord(record.message, 'typed data.message')
  })
}

function scalarValue(value: unknown, label: string): string {
  if (typeof value === 'string') return readBoundedString(value, label)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error(`${label} must be a string, boolean, or safe integer`)
}

function typedValue(
  solidityType: string,
  value: unknown,
  types: ParsedTypedData['types'],
  label: string,
  depth = 0
): EvmTypedDataValue {
  if (depth > 12) throw new Error('typed data exceeds the maximum depth')
  const arrayMatch = solidityType.match(/^(.*)\[([0-9]*)\]$/)
  if (arrayMatch) {
    if (!Array.isArray(value) || value.length > 128) throw new Error(`${label} must be an array`)
    const itemType = arrayMatch[1]
    const fixedLength = arrayMatch[2] === '' ? null : Number.parseInt(arrayMatch[2], 10)
    if (fixedLength !== null && value.length !== fixedLength) {
      throw new Error(`${label} has the wrong fixed array length`)
    }
    return Object.freeze({
      kind: 'array',
      itemType,
      items: Object.freeze(
        value.map((item, index) =>
          typedValue(itemType, item, types, `${label}[${index}]`, depth + 1)
        )
      )
    })
  }
  const struct = types[solidityType]
  if (struct) {
    const record = readRecord(value, label)
    const expectedKeys = struct.map(field => field.name)
    assertExactKeys(record, expectedKeys, [], label)
    return Object.freeze({
      kind: 'struct',
      typeName: solidityType,
      fields: Object.freeze(
        struct.map(field =>
          Object.freeze({
            name: field.name,
            value: typedValue(
              field.type,
              record[field.name],
              types,
              `${label}.${field.name}`,
              depth + 1
            )
          })
        )
      )
    })
  }
  return Object.freeze({
    kind: 'scalar',
    solidityType,
    value: scalarValue(value, label)
  })
}

async function adaptEvmTypedData(
  raw: unknown,
  payload: Extract<ParsedSigningPreparePayload, { kind: 'evm-typed-data' | 'pea-evm-typed-data' }>,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedEvmTypedData')
  assertExactKeys(
    prepared.value,
    ['requestId', 'account', 'signingHash', 'summary'],
    [],
    'PreparedEvmTypedData'
  )
  const account =
    payload.kind === 'pea-evm-typed-data'
      ? parseRawPeaExecutionAccount(prepared.value.account, payload.chainId, payload.addressIndex)
      : parseRawEvmAccount(prepared.value.account)
  if (payload.kind === 'evm-typed-data') {
    assertRawEvmAccountMatches(
      account as RawDerivedAccount,
      payload.chainId,
      payload.addressIndex,
      imported
    )
  }
  const signingHash = readHex(prepared.value.signingHash, 'PreparedEvmTypedData.signingHash', {
    bytes: 32
  })
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    [
      'selectedChainId',
      'from',
      'primaryType',
      'domain',
      'domainSeparator',
      'types',
      'message',
      'typeCount',
      'fieldCount'
    ],
    'PreparedEvmTypedData.summary'
  )
  const typedData = parseTypedDataJson(payload.typedDataJson)
  if (
    rawSummary.selectedChainId !== payload.chainId ||
    rawSummary.from !== account.address ||
    rawSummary.primaryType !== typedData.primaryType
  ) {
    throw new Error('Prepared EVM typed data summary does not match its input')
  }
  const domain = typedValue('EIP712Domain', typedData.domain, typedData.types, 'typed data.domain')
  const message = typedValue(
    typedData.primaryType,
    typedData.message,
    typedData.types,
    'typed data.message'
  )
  const hasChainId =
    domain.kind === 'struct' && domain.fields.some(field => field.name === 'chainId')
  const issues = hasChainId ? [] : [Object.freeze({ code: 'missing-chain-binding' as const })]
  const summary = parseSigningSummary(
    {
      schema: 'evm.typed-data.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: review(issues),
      fields: {
        signer: account.address,
        primaryType: typedData.primaryType,
        domain,
        message,
        digestHex: signingHash
      }
    },
    { family: 'evm', chainId: payload.chainId, operation: 'message' }
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
      await sha256(textEncoder.encode(payload.typedDataJson)),
      expiresAt
    )
  })
}

function parseBitcoinInput(value: unknown, index: number, scriptType: RawBitcoinAddressType) {
  const label = `BitcoinPsbtSummary.inputs[${index}]`
  const record = readRecord(value, label)
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
      'derivationPath',
      'sighashType'
    ],
    [],
    label
  )
  const summaryScriptType = scriptType === 'p2sh_p2wpkh' ? ('p2sh-p2wpkh' as const) : scriptType
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    transactionId: readString(record.txid, `${label}.txid`, 64),
    outputIndex: readSafeInteger(record.vout, `${label}.vout`),
    amountSats: readUnsignedDecimal(record.valueSats, `${label}.valueSats`, MAX_UINT64),
    sequence: readSafeInteger(record.sequence, `${label}.sequence`),
    scriptType: summaryScriptType,
    sighashType: readString(record.sighashType, `${label}.sighashType`, 64),
    ownership: readBoolean(record.walletOwned, `${label}.walletOwned`)
      ? ('signing-account' as const)
      : ('external' as const)
  })
}

function parseBitcoinOutput(value: unknown, index: number) {
  const label = `BitcoinPsbtSummary.outputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['index', 'valueSats', 'address', 'scriptPubKey', 'walletOwned', 'isChange', 'derivationPath'],
    [],
    label
  )
  const address =
    record.address === null ? null : readString(record.address, `${label}.address`, 128)
  const isChange = readBoolean(record.isChange, `${label}.isChange`)
  const walletOwned = readBoolean(record.walletOwned, `${label}.walletOwned`)
  if (isChange && !walletOwned) throw new Error('Bitcoin change output must be wallet owned')
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    address,
    scriptPubKeyHex: readHex(record.scriptPubKey, `${label}.scriptPubKey`),
    amountSats: readUnsignedDecimal(record.valueSats, `${label}.valueSats`, MAX_UINT64),
    classification: isChange
      ? ('change' as const)
      : address
        ? ('recipient' as const)
        : ('unknown' as const)
  })
}

async function adaptBitcoinPsbt(
  raw: unknown,
  payload: Extract<ParsedSigningPreparePayload, { kind: 'bitcoin-psbt' }>,
  account: RawDerivedBitcoinAccount,
  signingCommandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedBitcoinPsbt')
  assertExactKeys(prepared.value, ['requestId', 'summary'], [], 'PreparedBitcoinPsbt')
  const rawSummary = requireRawSummary(
    prepared.value.summary,
    [
      'chainId',
      'network',
      'addressType',
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
    'PreparedBitcoinPsbt.summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.addressType !== payload.addressType ||
    rawSummary.accountIndex !== payload.accountIndex ||
    rawSummary.psbtVersion !== 0
  ) {
    throw new Error('Prepared Bitcoin PSBT summary does not match its input')
  }
  const inputs = readArray(rawSummary.inputs, 'BitcoinPsbtSummary.inputs', (item, index) =>
    parseBitcoinInput(item, index, payload.addressType)
  )
  const outputs = readArray(rawSummary.outputs, 'BitcoinPsbtSummary.outputs', parseBitcoinOutput)
  if (rawSummary.inputCount !== inputs.length || rawSummary.outputCount !== outputs.length) {
    throw new Error('Prepared Bitcoin PSBT counts do not match')
  }
  const signingInputIndexes = inputs
    .filter(input => input.ownership === 'signing-account')
    .map(input => input.index)
  if (rawSummary.signableInputCount !== signingInputIndexes.length) {
    throw new Error('Prepared Bitcoin PSBT signable input count does not match')
  }
  const issues: SigningReviewIssue[] = []
  if (inputs.some(input => input.ownership === 'external')) {
    issues.push(Object.freeze({ code: 'external-input' }))
  }
  const defaultSighash = payload.addressType === 'p2tr' ? 'SIGHASH_DEFAULT' : 'SIGHASH_ALL'
  if (inputs.some(input => input.sighashType !== defaultSighash)) {
    issues.push(Object.freeze({ code: 'non-default-sighash' }))
  }
  outputs.forEach(output => {
    if (output.classification === 'unknown') {
      issues.push(Object.freeze({ code: 'unknown-output', subjectIndex: output.index }))
    }
  })
  const hasBlockedOutput = outputs.some(output => output.classification === 'unknown')
  const summary = parseSigningSummary(
    {
      schema: 'bitcoin.psbt.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: review(issues, hasBlockedOutput),
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
    { family: 'bitcoin', chainId: payload.chainId, operation: 'transaction' }
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

async function adaptBitcoinMessage(
  raw: unknown,
  payload: Extract<ParsedSigningPreparePayload, { kind: 'bitcoin-bip322-message' }>,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedPreparedSigning> {
  const prepared = parseRawPreparedValue(raw, 'PreparedBitcoinMessage')
  assertExactKeys(prepared.value, ['requestId', 'account', 'summary'], [], 'PreparedBitcoinMessage')
  const account = parseRawBitcoinAccount(prepared.value.account)
  assertRawBitcoinAccountMatches(
    account,
    payload.chainId,
    payload.addressType,
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
      'addressType',
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
    'PreparedBitcoinMessage.summary'
  )
  if (
    rawSummary.chainId !== payload.chainId ||
    rawSummary.address !== account.address ||
    rawSummary.addressType !== payload.addressType ||
    rawSummary.accountIndex !== payload.accountIndex ||
    rawSummary.change !== payload.change ||
    rawSummary.addressIndex !== payload.addressIndex ||
    rawSummary.byteLength !== payload.message.byteLength ||
    rawSummary.signatureFormat !==
      (payload.addressType === 'p2pkh' || payload.addressType === 'p2sh_p2wpkh'
        ? 'bip322_full'
        : 'bip322_simple')
  ) {
    throw new Error('Prepared Bitcoin message summary does not match its input')
  }
  const message = await canonicalContent(payload.message, 'utf8')
  const issues =
    message.encoding === 'utf8' ? [] : [Object.freeze({ code: 'opaque-message' as const })]
  const summary = parseSigningSummary(
    {
      schema: 'bitcoin.bip322-message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: review(issues),
      fields: { address: account.address, message }
    },
    { family: 'bitcoin', chainId: payload.chainId, operation: 'message' }
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

export async function adaptPreparedSigning(
  raw: unknown,
  payload: ParsedSigningPreparePayload,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  bitcoinAccount?: RawDerivedBitcoinAccount,
  imported = false
): Promise<AdaptedPreparedSigning> {
  switch (payload.kind) {
    case 'evm-transaction':
    case 'pea-evm-transaction':
      return adaptEvmTransaction(raw, payload, signingCommandId, expiresAt, imported)
    case 'evm-personal-message':
    case 'pea-evm-personal-message':
      return adaptEvmPersonalMessage(raw, payload, signingCommandId, expiresAt, imported)
    case 'evm-typed-data':
    case 'pea-evm-typed-data':
      return adaptEvmTypedData(raw, payload, signingCommandId, expiresAt, imported)
    case 'bitcoin-psbt':
      if (!bitcoinAccount) throw new Error('Bitcoin PSBT signer account is missing')
      return adaptBitcoinPsbt(raw, payload, bitcoinAccount, signingCommandId, expiresAt)
    case 'bitcoin-bip322-message':
      return adaptBitcoinMessage(raw, payload, signingCommandId, expiresAt, imported)
    case 'solana-transaction':
    case 'solana-message':
      return adaptSolanaPreparedSigning(raw, payload, signingCommandId, expiresAt, imported)
    case 'near-transaction':
    case 'near-nep413-message':
      return adaptNearPreparedSigning(raw, payload, signingCommandId, expiresAt, imported)
  }
}

export function adaptSignedResult(
  kind: PendingSigningKind,
  raw: unknown,
  account:
    | RawDerivedAccount
    | RawDerivedBitcoinAccount
    | RawDerivedEd25519Account
    | RawDerivedPeaAccount
    | RawPeaExecutionAccount
): SigningResult {
  switch (kind) {
    case 'evm-transaction':
    case 'pea-evm-transaction': {
      const signed = parseRawSignedEvmTransaction(raw)
      return Object.freeze({
        kind: 'signed-payload',
        payload: Object.freeze({ encoding: 'hex', value: signed.rawTransaction }),
        transactionId: signed.transactionHash
      })
    }
    case 'evm-personal-message':
    case 'pea-evm-personal-message':
    case 'evm-typed-data':
    case 'pea-evm-typed-data': {
      const signed = parseRawSignedEvmMessage(raw)
      return Object.freeze({
        kind: 'signature',
        signature: Object.freeze({ encoding: 'hex', value: signed.signature }),
        publicKey: account.publicKey,
        address: account.address
      })
    }
    case 'bitcoin-psbt': {
      const signed = parseRawSignedBitcoinPsbt(raw)
      return Object.freeze({
        kind: 'signed-payload',
        payload: Object.freeze({ encoding: 'base64', value: signed.psbt }),
        transactionId: signed.unsignedTxid
      })
    }
    case 'bitcoin-bip322-message': {
      const signed = parseRawSignedBitcoinMessage(raw)
      if (signed.address !== account.address) {
        throw new Error('Signed Bitcoin message address does not match the prepared account')
      }
      return Object.freeze({
        kind: 'signature',
        signature: Object.freeze({ encoding: 'utf8', value: signed.signature }),
        publicKey: account.publicKey,
        address: account.address
      })
    }
    case 'solana-transaction':
    case 'solana-message':
      if (account.curve !== 'ed25519') throw new Error('Ed25519 signing account is missing')
      return adaptSolanaSignedResult(kind, raw, account)
    case 'near-transaction':
    case 'near-nep413-message':
      if (account.curve !== 'ed25519') throw new Error('Ed25519 signing account is missing')
      return adaptNearSignedResult(kind, raw, account)
  }
}
