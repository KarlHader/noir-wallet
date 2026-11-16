import {
  SOLANA_TOKEN_PROGRAMS,
  SolanaRpcError,
  type SolanaAddressLookupTable,
  type SolanaTokenAccountBalance,
  type SolanaTokenProgram
} from './solana-rpc-types'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_SOLANA_TRANSACTION_BYTES = 1_232
export const SOLANA_ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
export const SOLANA_LOOKUP_TABLE_META_BYTES = 56
export const SOLANA_LOOKUP_TABLE_MAX_ADDRESSES = 256
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

export function parseBase58Bytes(value: unknown, expectedBytes: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  const littleEndianBytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
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
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes =
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? 0 : littleEndianBytes.length
  if (leadingZeroBytes + significantBytes !== expectedBytes) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return value
}

export function parseSolanaPublicKey(value: unknown): string {
  return parseBase58Bytes(value, 32, 'Solana public key')
}

export function encodeSolanaBase58(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new Error('Cannot encode an empty base58 value')
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let leadingZeroBytes = 0
  while (leadingZeroBytes < bytes.byteLength && bytes[leadingZeroBytes] === 0) {
    leadingZeroBytes += 1
  }
  const significantDigits =
    digits.length === 1 && digits[0] === 0
      ? ''
      : [...digits]
          .reverse()
          .map(value => BASE58_ALPHABET[value])
          .join('')
  return '1'.repeat(leadingZeroBytes) + significantDigits
}

export function parseCanonicalBase64(
  value: unknown,
  maximumBytes: number,
  label: string
): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  if (binary.length > maximumBytes || btoa(binary) !== value) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function readLittleEndianU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index])
  }
  return value
}

export function parseAddressLookupTableData(
  data: Uint8Array,
  address: string,
  contextSlot: number
): SolanaAddressLookupTable {
  const addressBytes = data.byteLength - SOLANA_LOOKUP_TABLE_META_BYTES
  if (
    addressBytes < 0 ||
    addressBytes % 32 !== 0 ||
    addressBytes / 32 > SOLANA_LOOKUP_TABLE_MAX_ADDRESSES ||
    data[0] !== 1 ||
    data[1] !== 0 ||
    data[2] !== 0 ||
    data[3] !== 0
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana address lookup table data')
  }
  const authorityOption = data[21]
  if (authorityOption !== 0 && authorityOption !== 1) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana address lookup table authority')
  }
  const lastExtendedSlot = readLittleEndianU64(data, 12)
  const lastExtendedStartIndex = data[20]
  const numberOfAddresses = addressBytes / 32
  if (lastExtendedStartIndex > numberOfAddresses) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana address lookup table extension')
  }
  const addresses: string[] = []
  for (let index = 0; index < numberOfAddresses; index += 1) {
    const offset = SOLANA_LOOKUP_TABLE_META_BYTES + index * 32
    addresses.push(encodeSolanaBase58(data.subarray(offset, offset + 32)))
  }
  return Object.freeze({
    address,
    contextSlot,
    deactivationSlot: readLittleEndianU64(data, 4).toString(),
    lastExtendedSlot: lastExtendedSlot.toString(),
    lastExtendedStartIndex,
    authority: authorityOption === 0 ? null : encodeSolanaBase58(data.subarray(22, 54)),
    addresses: Object.freeze(addresses)
  })
}

export function parseSafeUnsignedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return value as number
}

function parseUnsignedU64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 20 ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > MAXIMUM_U64
  ) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return value
}

export function stringifyBoundedJson(value: unknown, label: string): string {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  if (serialized === undefined || serialized.length > 4_096) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return serialized
}

export function parseTokenAccount(
  value: unknown,
  owner: string,
  program: SolanaTokenProgram
): SolanaTokenAccountBalance {
  const expectedProgram = SOLANA_TOKEN_PROGRAMS[program]
  if (!isRecord(value) || !hasExactKeys(value, ['pubkey', 'account'])) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana token account')
  }
  const accountAddress = parseBase58Bytes(value.pubkey, 32, 'Solana token account address')
  const account = value.account
  if (
    !isRecord(account) ||
    !hasExactKeys(account, ['data', 'executable', 'lamports', 'owner', 'rentEpoch'], ['space']) ||
    account.executable !== false ||
    account.owner !== expectedProgram.programId
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana token account owner')
  }
  const data = account.data
  if (
    !isRecord(data) ||
    !hasExactKeys(data, ['program', 'parsed', 'space']) ||
    data.program !== expectedProgram.name ||
    !Number.isSafeInteger(data.space) ||
    (data.space as number) <= 0
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana parsed token account data')
  }
  const parsed = data.parsed
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['info', 'type']) || parsed.type !== 'account') {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana parsed token account')
  }
  const info = parsed.info
  if (
    !isRecord(info) ||
    !hasExactKeys(
      info,
      ['isNative', 'mint', 'owner', 'state', 'tokenAmount'],
      ['closeAuthority', 'delegate', 'delegatedAmount', 'extensions', 'rentExemptReserve']
    ) ||
    typeof info.isNative !== 'boolean' ||
    info.owner !== owner ||
    (info.state !== 'uninitialized' && info.state !== 'initialized' && info.state !== 'frozen')
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana token account information')
  }
  const tokenAmount = info.tokenAmount
  if (
    !isRecord(tokenAmount) ||
    !hasExactKeys(tokenAmount, ['amount', 'decimals', 'uiAmount', 'uiAmountString']) ||
    !Number.isSafeInteger(tokenAmount.decimals) ||
    (tokenAmount.decimals as number) < 0 ||
    (tokenAmount.decimals as number) > 255 ||
    (tokenAmount.uiAmount !== null &&
      (typeof tokenAmount.uiAmount !== 'number' || !Number.isFinite(tokenAmount.uiAmount))) ||
    typeof tokenAmount.uiAmountString !== 'string' ||
    tokenAmount.uiAmountString.length > 128
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana token amount')
  }
  return Object.freeze({
    accountAddress,
    program,
    mint: parseBase58Bytes(info.mint, 32, 'Solana token mint'),
    owner,
    state: info.state,
    isNative: info.isNative,
    amountRaw: parseUnsignedU64(tokenAmount.amount, 'Solana token amount'),
    decimals: tokenAmount.decimals as number
  })
}

export function parseContext(value: unknown): number {
  if (!isRecord(value) || !hasExactKeys(value, ['slot'], ['apiVersion'])) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana RPC context')
  }
  if (
    value.apiVersion !== undefined &&
    (typeof value.apiVersion !== 'string' || value.apiVersion.length > 64)
  ) {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana RPC context version')
  }
  return parseSafeUnsignedInteger(value.slot, 'Solana context slot')
}

export function parseSignedTransactionBase64(value: string): string {
  try {
    parseCanonicalBase64(value, MAXIMUM_SOLANA_TRANSACTION_BYTES, 'Solana signed transaction')
  } catch {
    throw new Error('Invalid Solana signed transaction')
  }
  return value
}
