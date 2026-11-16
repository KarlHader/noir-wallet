/**
 * Keystone BC-UR codec for the Zcash protocol.
 *
 * Connection:  device shows `ur:zcash-accounts` (seed fingerprint + UFVK list)
 * Signing:     wallet shows `ur:zcash-pczt` (unsigned PCZT), device returns
 *              `ur:zcash-pczt` with signatures added
 */

// Must come first: installs the global Buffer required by the UR libraries
import '../buffer-polyfill'
import { Buffer } from 'buffer'
import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur'
import { ZcashAccounts, ZcashPCZT } from '@keystonehq/bc-ur-registry-zcash'

export const UR_TYPE = {
  ZCASH_ACCOUNTS: 'zcash-accounts',
  ZCASH_PCZT: 'zcash-pczt'
} as const

/**
 * UR fragment size. A working Zodl/Zashi signing session (captured from a real
 * Keystone scan) uses ~200-byte fragments, matching the Keystone firmware
 * default (`FRAGMENT_MAX_LENGTH_DEFAULT`). Larger fragments pack each QR denser
 * and the device fails to scan them reliably.
 */
export const DEFAULT_PCZT_FRAGMENT_LENGTH = 200
const MAX_ZCASH_ACCOUNT_CBOR_BYTES = 256 * 1024
const MAX_ZCASH_ACCOUNTS = 64
const MAX_ZCASH_UFVK_LENGTH = 4096
const MAX_ZCASH_ACCOUNT_NAME_LENGTH = 256
const MAX_ZCASH_ACCOUNT_INDEX = 0x7fffffff

export interface KeystoneAccount {
  ufvk: string
  index: number
  name?: string
}

export interface KeystoneAccountsPayload {
  readonly seedFingerprintHex: string
  readonly accounts: readonly KeystoneAccount[]
}

function decodeZcashAccounts(ur: UR): ZcashAccounts {
  try {
    return ZcashAccounts.fromCBOR(ur.cbor)
  } catch {
    throw new Error('Keystone Zcash account QR could not be decoded')
  }
}

function readZcashAccount(
  value: ReturnType<ZcashAccounts['getAccounts']>[number]
): KeystoneAccount {
  const ufvk = value.getUfvk()
  const index = value.getIndex()
  const name = value.getName()
  if (
    typeof ufvk !== 'string' ||
    ufvk.length === 0 ||
    ufvk.length > MAX_ZCASH_UFVK_LENGTH ||
    ufvk.trim() !== ufvk
  ) {
    throw new Error('Keystone Zcash account QR contains an invalid UFVK')
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ZCASH_ACCOUNT_INDEX) {
    throw new Error('Keystone Zcash account QR contains an invalid Account index')
  }
  if (
    name !== undefined &&
    name !== '' &&
    (typeof name !== 'string' ||
      name.length > MAX_ZCASH_ACCOUNT_NAME_LENGTH ||
      name.trim() !== name)
  ) {
    throw new Error('Keystone Zcash account QR contains an invalid Account name')
  }
  return Object.freeze({
    ufvk,
    index,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {})
  })
}

/**
 * Parse a complete `ur:zcash-accounts` UR (Keystone "Connect Software Wallet" QR).
 */
export function parseZcashAccounts(ur: UR): KeystoneAccountsPayload {
  if (ur.type !== UR_TYPE.ZCASH_ACCOUNTS) {
    throw new Error(`Unexpected QR content: ${ur.type} (expected ${UR_TYPE.ZCASH_ACCOUNTS})`)
  }
  if (ur.cbor.byteLength === 0 || ur.cbor.byteLength > MAX_ZCASH_ACCOUNT_CBOR_BYTES) {
    throw new Error('Keystone Zcash account QR payload has an invalid size')
  }

  const decoded = decodeZcashAccounts(ur)
  const seedFingerprint = decoded.getSeedFingerprint()
  if (!(seedFingerprint instanceof Uint8Array) || seedFingerprint.byteLength !== 32) {
    throw new Error('Keystone Zcash seed fingerprint has an invalid length')
  }
  const decodedAccounts = decoded.getAccounts()
  if (
    !Array.isArray(decodedAccounts) ||
    decodedAccounts.length === 0 ||
    decodedAccounts.length > MAX_ZCASH_ACCOUNTS
  ) {
    throw new Error('Keystone Zcash account QR contains an invalid number of Accounts')
  }
  const accounts = Object.freeze(decodedAccounts.map(readZcashAccount))
  const indexes = new Set(accounts.map(account => account.index))
  const ufvks = new Set(accounts.map(account => account.ufvk))
  if (indexes.size !== accounts.length || ufvks.size !== accounts.length) {
    throw new Error('Keystone Zcash account QR contains duplicate Accounts')
  }

  return Object.freeze({
    seedFingerprintHex: Buffer.from(seedFingerprint).toString('hex'),
    accounts
  })
}

/**
 * Build an animated-QR encoder for an unsigned PCZT (`ur:zcash-pczt`).
 */
export function createPcztUREncoder(
  pcztBytes: Uint8Array,
  maxFragmentLength: number = DEFAULT_PCZT_FRAGMENT_LENGTH
): UREncoder {
  const cbor = encodeZcashPcztCbor(pcztBytes)
  assertPcztBytestring(cbor)
  return new UREncoder(new UR(cbor, UR_TYPE.ZCASH_PCZT), maxFragmentLength)
}

/**
 * CBOR-encode the PCZT as the registry map `{1: h'<bytes>'}` directly.
 *
 * `ZcashPCZT.toUR()` routes through the registry's bundled cbor encoder, which
 * emits a byte string only when the payload is `instanceof` *its* copy of
 * `Buffer`. Under Vite the registry and the app resolve different `buffer`
 * modules, so that check fails and the value silently degrades to
 * `{1: {type:'Buffer', data:[...]}}` — the QR still scans but the Keystone
 * rejects it as an invalid PCZT. Emitting the bytes by hand is
 * bundler-independent (verified byte-identical to the correct library output).
 */
function encodeZcashPcztCbor(pcztBytes: Uint8Array): Buffer {
  const len = pcztBytes.length
  let header: number[]
  if (len < 0x18) {
    header = [0xa1, 0x01, 0x40 | len]
  } else if (len < 0x100) {
    header = [0xa1, 0x01, 0x58, len]
  } else if (len < 0x10000) {
    header = [0xa1, 0x01, 0x59, (len >> 8) & 0xff, len & 0xff]
  } else {
    header = [
      0xa1,
      0x01,
      0x5a,
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff
    ]
  }
  return Buffer.concat([Buffer.from(header), Buffer.from(pcztBytes)])
}

/**
 * Guard the hardware-signing path: the PCZT must be a CBOR byte string (major
 * type 2) under key 1 before frames reach the signer. Catches any regression in
 * the length encoding above.
 */
function assertPcztBytestring(cbor: Buffer): void {
  const isMapWithByteString = cbor[0] === 0xa1 && cbor[1] === 0x01 && (cbor[2] & 0xe0) === 0x40
  if (!isMapWithByteString) {
    throw new Error(`PCZT CBOR corrupted; header=${cbor.slice(0, 3).toString('hex')}`)
  }
}

/**
 * Parse the signed `ur:zcash-pczt` UR returned by the device into PCZT bytes.
 */
export function parseSignedPczt(ur: UR): Uint8Array {
  if (ur.type !== UR_TYPE.ZCASH_PCZT) {
    throw new Error(`Unexpected QR content: ${ur.type} (expected ${UR_TYPE.ZCASH_PCZT})`)
  }
  return new Uint8Array(ZcashPCZT.fromCBOR(ur.cbor).getData())
}

export { UR, UREncoder, URDecoder }
