import { blake2b } from '@noble/hashes/blake2b'

const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const F4_MIN_LENGTH = 38
const F4_MAX_LENGTH = 4_194_368
const MAX_COMPACT_SIZE = 0x02000000
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const textEncoder = new TextEncoder()

function invalid(): never {
  throw new Error('Invalid or unsupported multisig recipient')
}

function polymodStep(check: number, value: number): number {
  const top = check >>> 25
  let next = ((check & 0x1ffffff) << 5) ^ value
  for (let i = 0; i < 5; i++) if ((top >>> i) & 1) next ^= BECH32_GENERATORS[i]
  return next >>> 0
}

function decodeBech32m(address: string): { hrp: string; bytes: Uint8Array } {
  if (
    typeof address !== 'string' ||
    address.length < 8 ||
    address.length > 6_711_010 ||
    /[^\x21-\x7e]/.test(address) ||
    (address !== address.toLowerCase() && address !== address.toUpperCase())
  )
    invalid()
  const lower = address.toLowerCase()
  const separator = lower.lastIndexOf('1')
  if (separator < 1 || lower.length - separator < 7) invalid()
  const hrp = lower.slice(0, separator)
  let check = 1
  for (const char of hrp) check = polymodStep(check, char.charCodeAt(0) >>> 5)
  check = polymodStep(check, 0)
  for (const char of hrp) check = polymodStep(check, char.charCodeAt(0) & 31)
  const values: number[] = []
  for (const char of lower.slice(separator + 1)) {
    const value = BECH32_CHARS.indexOf(char)
    if (value < 0) invalid()
    check = polymodStep(check, value)
    values.push(value)
  }
  if (check !== 0x2bc830a3) invalid()

  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (const value of values.slice(0, -6)) {
    accumulator = ((accumulator << 5) | value) & 0xfff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 0xff)
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) invalid()
  return { hrp, bytes: Uint8Array.from(bytes) }
}

function xorHash(
  target: Uint8Array,
  input: Uint8Array,
  length: number,
  personal: Uint8Array
): void {
  const hash = blake2b(input, { dkLen: length, personalization: personal })
  for (let i = 0; i < target.length; i++) target[i] ^= hash[i]
}

function unjumble(message: Uint8Array): void {
  const leftLength = Math.min(64, Math.floor(message.length / 2))
  const left = message.subarray(0, leftLength)
  const right = message.subarray(leftLength)
  const prefix = textEncoder.encode('UA_F4Jumble_')
  const personal = new Uint8Array(16)
  personal.set(prefix)
  const h = (round: number) => {
    personal[12] = 0x48
    personal[13] = round
    personal[14] = 0
    personal[15] = 0
    xorHash(left, right, leftLength, personal)
  }
  const g = (round: number) => {
    personal[12] = 0x47
    personal[13] = round
    for (let block = 0; block * 64 < right.length; block++) {
      personal[14] = block & 0xff
      personal[15] = (block >>> 8) & 0xff
      xorHash(right.subarray(block * 64, (block + 1) * 64), left, 64, personal)
    }
  }
  h(1)
  g(1)
  h(0)
  g(0)
}

function compactSize(bytes: Uint8Array, cursor: { offset: number }): number {
  if (cursor.offset >= bytes.length) invalid()
  const flag = bytes[cursor.offset++]
  if (flag < 253) return flag
  const count = flag === 253 ? 2 : flag === 254 ? 4 : 8
  if (cursor.offset + count > bytes.length) invalid()
  let value = 0
  for (let i = 0; i < count; i++) value += bytes[cursor.offset + i] * 2 ** (8 * i)
  cursor.offset += count
  if (
    !Number.isSafeInteger(value) ||
    value > MAX_COMPACT_SIZE ||
    (flag === 253 && value < 253) ||
    (flag === 254 && value < 0x10000) ||
    (flag === 255 && value < 0x100000000)
  )
    invalid()
  return value
}

/** Returns the exact Orchard raw receiver for a supported ZIP 316 Unified Address. */
export function decodeMultisigRecipient(
  address: string,
  network: 'mainnet' | 'testnet'
): Uint8Array {
  const { hrp, bytes } = decodeBech32m(address)
  const permitted =
    network === 'mainnet'
      ? ['u', 'zu', 'tu']
      : network === 'testnet'
        ? ['utest', 'zutest', 'tutest']
        : []
  if (!permitted.includes(hrp) || bytes.length < F4_MIN_LENGTH || bytes.length > F4_MAX_LENGTH)
    invalid()
  unjumble(bytes)
  const padding = new Uint8Array(16)
  padding.set(textEncoder.encode(hrp))
  for (let i = 0; i < 16; i++) if (bytes[bytes.length - 16 + i] !== padding[i]) invalid()

  const raw = bytes.subarray(0, bytes.length - 16)
  const cursor = { offset: 0 }
  let previous = -1
  let orchard: Uint8Array | undefined
  let transparent = false
  while (cursor.offset < raw.length) {
    const typecode = compactSize(raw, cursor)
    const length = compactSize(raw, cursor)
    if (typecode <= previous || length > raw.length - cursor.offset) invalid()
    previous = typecode
    const receiver = raw.subarray(cursor.offset, cursor.offset + length)
    cursor.offset += length
    if (typecode === 0) {
      if (length !== 20) invalid()
      transparent = true
    } else if (typecode === 2) {
      if (length !== 43) invalid()
    } else if (typecode === 3) {
      if (length !== 43) invalid()
      orchard = receiver
    } else invalid()
  }
  if (!orchard || (hrp.startsWith('zu') && transparent) || (hrp.startsWith('tu') && !transparent))
    invalid()
  return new Uint8Array(orchard)
}
