const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const NEAR_ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

function decodeBase58(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length > 128) {
    throw new Error(`${label} must be bounded base58`)
  }
  const littleEndianBytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
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
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes =
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? 0 : littleEndianBytes.length
  const decoded = new Uint8Array(leadingZeroBytes + significantBytes)
  for (let index = 0; index < significantBytes; index += 1) {
    decoded[leadingZeroBytes + index] = littleEndianBytes[significantBytes - index - 1]
  }
  return decoded
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new Error('NEAR public key bytes must not be empty')
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
  while (bytes[leadingZeroBytes] === 0) leadingZeroBytes += 1
  const significantDigits = digits.length === 1 && digits[0] === 0 ? 0 : digits.length
  let encoded = '1'.repeat(leadingZeroBytes)
  for (let index = significantDigits - 1; index >= 0; index -= 1) {
    encoded += BASE58_ALPHABET[digits[index]]
  }
  return encoded
}

export function parseNearBase58(value: unknown, expectedBytes: number, label: string): string {
  if (typeof value !== 'string' || decodeBase58(value, label).byteLength !== expectedBytes) {
    throw new Error(`${label} must encode ${expectedBytes} bytes`)
  }
  return value
}

export function parseNearAccountId(value: unknown, label = 'NEAR account ID'): string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 64 ||
    !NEAR_ACCOUNT_ID_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a canonical NEAR account ID`)
  }
  return value
}

export function parseNearPublicKey(value: unknown, label = 'NEAR public key'): string {
  if (typeof value !== 'string' || !value.startsWith('ed25519:')) {
    throw new Error(`${label} must be an ed25519 NEAR public key`)
  }
  parseNearBase58(value.slice('ed25519:'.length), 32, `${label} key bytes`)
  return value
}

export function nearImplicitAccountIdFromPublicKey(publicKeyValue: unknown): string {
  const publicKey = parseNearPublicKey(publicKeyValue)
  return [...decodeBase58(publicKey.slice('ed25519:'.length), 'NEAR public key')]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function nearPublicKeyFromImplicitAccountId(accountIdValue: unknown): string {
  const accountId = parseNearAccountId(accountIdValue)
  if (!/^[0-9a-f]{64}$/.test(accountId)) {
    throw new Error('NEAR account ID must be a lowercase implicit account ID')
  }
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(accountId.slice(index * 2, index * 2 + 2), 16)
  }
  return parseNearPublicKey(`ed25519:${encodeBase58(bytes)}`)
}
