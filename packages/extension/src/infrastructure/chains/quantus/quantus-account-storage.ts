import { blake2b } from '@noble/hashes/blake2b'

import { decodeQuantusAccountId } from '@/core/chains/quantus'

import { QuantusRpcError, type QuantusAccountInfo } from './quantus-rpc-types'

const MASK_64 = (1n << 64n) - 1n
const XXH_PRIME_1 = 0x9e3779b185ebca87n
const XXH_PRIME_2 = 0xc2b2ae3d27d4eb4fn
const XXH_PRIME_3 = 0x165667b19e3779f9n
const XXH_PRIME_4 = 0x85ebca77c2b2ae63n
const XXH_PRIME_5 = 0x27d4eb2f165667c5n

// frame_system::AccountInfo<Nonce, AccountData> on the packaged runtime:
// nonce u32, consumers u32, providers u32, sufficients u32, then
// free u128, reserved u128, frozen u128, flags u128.
const ACCOUNT_INFO_BYTES = 80
const ACCOUNT_DATA_OFFSET = 16
const SYSTEM_PALLET = 'System'
const SYSTEM_ACCOUNT_STORAGE = 'Account'

function rotateLeft(value: bigint, bits: number): bigint {
  const shift = BigInt(bits)
  return ((value << shift) | (value >> (64n - shift))) & MASK_64
}

function readUint64Le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index])
  }
  return value
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function rotateMultiply(value: bigint, prime: bigint): bigint {
  return (rotateLeft(value, 31) * prime) & MASK_64
}

function xxhRound(accumulator: bigint, input: bigint): bigint {
  return rotateMultiply((accumulator + ((input * XXH_PRIME_2) & MASK_64)) & MASK_64, XXH_PRIME_1)
}

function xxhMerge(accumulator: bigint, value: bigint): bigint {
  const merged = ((accumulator ^ xxhRound(0n, value)) * XXH_PRIME_1) & MASK_64
  return (merged + XXH_PRIME_4) & MASK_64
}

/** xxHash64 as used by Substrate's `twox` storage hashers. */
function xxh64(bytes: Uint8Array, seed: bigint): bigint {
  let offset = 0
  let hash: bigint
  if (bytes.byteLength >= 32) {
    let lane1 = (seed + XXH_PRIME_1 + XXH_PRIME_2) & MASK_64
    let lane2 = (seed + XXH_PRIME_2) & MASK_64
    let lane3 = seed & MASK_64
    let lane4 = (seed - XXH_PRIME_1) & MASK_64
    for (; offset + 32 <= bytes.byteLength; offset += 32) {
      lane1 = xxhRound(lane1, readUint64Le(bytes, offset))
      lane2 = xxhRound(lane2, readUint64Le(bytes, offset + 8))
      lane3 = xxhRound(lane3, readUint64Le(bytes, offset + 16))
      lane4 = xxhRound(lane4, readUint64Le(bytes, offset + 24))
    }
    hash =
      (rotateLeft(lane1, 1) +
        rotateLeft(lane2, 7) +
        rotateLeft(lane3, 12) +
        rotateLeft(lane4, 18)) &
      MASK_64
    hash = xxhMerge(hash, lane1)
    hash = xxhMerge(hash, lane2)
    hash = xxhMerge(hash, lane3)
    hash = xxhMerge(hash, lane4)
  } else {
    hash = (seed + XXH_PRIME_5) & MASK_64
  }
  hash = (hash + BigInt(bytes.byteLength)) & MASK_64
  for (; offset + 8 <= bytes.byteLength; offset += 8) {
    const lane = xxhRound(0n, readUint64Le(bytes, offset))
    hash = (((rotateLeft(hash ^ lane, 27) * XXH_PRIME_1) & MASK_64) + XXH_PRIME_4) & MASK_64
  }
  if (offset + 4 <= bytes.byteLength) {
    const lane = (BigInt(readUint32Le(bytes, offset)) * XXH_PRIME_1) & MASK_64
    hash = (((rotateLeft(hash ^ lane, 23) * XXH_PRIME_2) & MASK_64) + XXH_PRIME_3) & MASK_64
    offset += 4
  }
  for (; offset < bytes.byteLength; offset += 1) {
    const lane = (BigInt(bytes[offset]) * XXH_PRIME_5) & MASK_64
    hash = (rotateLeft(hash ^ lane, 11) * XXH_PRIME_1) & MASK_64
  }
  hash ^= hash >> 33n
  hash = (hash * XXH_PRIME_2) & MASK_64
  hash ^= hash >> 29n
  hash = (hash * XXH_PRIME_3) & MASK_64
  hash ^= hash >> 32n
  return hash
}

function twox128(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const digest = new Uint8Array(16)
  const view = new DataView(digest.buffer)
  view.setBigUint64(0, xxh64(bytes, 0n), true)
  view.setBigUint64(8, xxh64(bytes, 1n), true)
  return digest
}

function toHex(bytes: Uint8Array): string {
  let value = '0x'
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

function parseStorageHex(value: unknown): string {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new QuantusRpcError('invalid-response', 'Quantus account storage is not hex data')
  }
  return value.slice(2)
}

function readUint128Le(bytes: Uint8Array, offset: number): bigint {
  return readUint64Le(bytes, offset) | (readUint64Le(bytes, offset + 8) << 64n)
}

/**
 * Builds the `System.Account` storage key for an SS58 address.
 *
 * Key layout: twox128("System") ++ twox128("Account") ++
 * blake2_128_concat(accountId) ++ accountId.
 */
export function quantusSystemAccountStorageKey(address: string): string {
  const accountId = decodeQuantusAccountId(address)
  const prefix = new Uint8Array(32)
  prefix.set(twox128(SYSTEM_PALLET), 0)
  prefix.set(twox128(SYSTEM_ACCOUNT_STORAGE), 16)
  const hashedAccountId = blake2b(accountId, { dkLen: 16 })
  const key = new Uint8Array(prefix.byteLength + hashedAccountId.byteLength + accountId.byteLength)
  key.set(prefix, 0)
  key.set(hashedAccountId, prefix.byteLength)
  key.set(accountId, prefix.byteLength + hashedAccountId.byteLength)
  return toHex(key)
}

/**
 * Decodes a `System.Account` storage value.
 *
 * The packaged runtime stores a fixed 80-byte AccountInfo; balances sit at the
 * account-data offset, so the layout must be rejected rather than guessed when
 * an upgraded runtime changes it. `null` means the account has no state yet.
 */
export function decodeQuantusAccountInfo(value: unknown): QuantusAccountInfo {
  if (value === null || value === undefined) {
    return Object.freeze({ free: 0n, reserved: 0n, nonce: 0 })
  }
  const data = parseStorageHex(value)
  if (data.length !== ACCOUNT_INFO_BYTES * 2) {
    throw new QuantusRpcError(
      'invalid-response',
      'Quantus account storage does not match the supported AccountInfo layout'
    )
  }
  const bytes = new Uint8Array(ACCOUNT_INFO_BYTES)
  for (let index = 0; index < ACCOUNT_INFO_BYTES; index += 1) {
    bytes[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16)
  }
  return Object.freeze({
    free: readUint128Le(bytes, ACCOUNT_DATA_OFFSET),
    reserved: readUint128Le(bytes, ACCOUNT_DATA_OFFSET + 16),
    nonce: readUint32Le(bytes, 0)
  })
}
