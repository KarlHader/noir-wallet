import { blake2b } from '@noble/hashes/blake2b'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const QUANTUS_SS58_PREFIX = 189 as const
const ACCOUNT_ID_BYTES = 32
const CHECKSUM_BYTES = 2
const SS58_CHECKSUM_PREFIX = new TextEncoder().encode('SS58PRE')

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

function encodeSs58Prefix(prefix: number): Uint8Array {
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > 16_383) {
    throw new Error('Invalid SS58 prefix')
  }
  if (prefix < 64) return Uint8Array.of(prefix)
  return Uint8Array.of(((prefix & 0x00fc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6))
}

function decodeSs58Prefix(bytes: Uint8Array): { readonly prefix: number; readonly length: number } {
  if (bytes.byteLength === 0) throw new Error('Invalid SS58 address')
  if ((bytes[0] & 0x40) === 0) {
    return { prefix: bytes[0], length: 1 }
  }
  if (bytes.byteLength < 2 || (bytes[0] & 0x80) !== 0) {
    throw new Error('Invalid SS58 address')
  }
  const prefix = ((bytes[0] & 0x3f) << 2) | (bytes[1] >> 6) | ((bytes[1] & 0x3f) << 8)
  return { prefix, length: 2 }
}

function assertChecksum(payloadWithoutChecksum: Uint8Array, checksum: Uint8Array): void {
  const digestInput = new Uint8Array(
    SS58_CHECKSUM_PREFIX.byteLength + payloadWithoutChecksum.byteLength
  )
  digestInput.set(SS58_CHECKSUM_PREFIX, 0)
  digestInput.set(payloadWithoutChecksum, SS58_CHECKSUM_PREFIX.byteLength)
  const digest = blake2b(digestInput, { dkLen: 64 })
  if (checksum[0] !== digest[0] || checksum[1] !== digest[1]) {
    throw new Error('Quantus address checksum is invalid')
  }
}

function readQuantusAddress(
  value: unknown,
  label: string
): {
  readonly address: string
  readonly accountId: Uint8Array
} {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 128
  ) {
    throw new Error(`${label} must be a bounded SS58 string`)
  }
  const decoded = decodeBase58(value, label)
  const prefixBytes = encodeSs58Prefix(QUANTUS_SS58_PREFIX)
  const expectedLength = prefixBytes.byteLength + ACCOUNT_ID_BYTES + CHECKSUM_BYTES
  // Reject wrong-width payloads before interpreting a garbled prefix value.
  if (decoded.byteLength !== expectedLength) {
    throw new Error(`${label} encoding is invalid`)
  }
  const { prefix, length: prefixLength } = decodeSs58Prefix(decoded)
  if (prefixLength !== prefixBytes.byteLength || prefix !== QUANTUS_SS58_PREFIX) {
    throw new Error(`${label} must use SS58 prefix ${QUANTUS_SS58_PREFIX}`)
  }
  const payload = decoded.subarray(0, prefixLength + ACCOUNT_ID_BYTES)
  const checksum = decoded.subarray(prefixLength + ACCOUNT_ID_BYTES)
  assertChecksum(payload, checksum)
  return { address: value, accountId: payload.subarray(prefixLength) }
}

export function parseQuantusAddress(value: unknown, label = 'Quantus address'): string {
  return readQuantusAddress(value, label).address
}

/** Returns the 32-byte account ID used by account-storage keys. */
export function decodeQuantusAccountId(value: unknown, label = 'Quantus address'): Uint8Array {
  return readQuantusAddress(value, label).accountId
}

export function encodeQuantusSs58PrefixBytes(): Uint8Array {
  return encodeSs58Prefix(QUANTUS_SS58_PREFIX)
}
