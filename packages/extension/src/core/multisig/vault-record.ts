/**
 * Sealed vault records: the FROST key share and its public header, encrypted under a key derived
 * from the wallet mnemonic so the record can only be opened while the wallet is unlocked.
 */
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { isBase64Text, isDkgShape } from './dkg-protocol'

export type VaultNetwork = 'mainnet' | 'testnet'

export type VaultRecordHeader = {
  version: 1
  groupId: string
  network: VaultNetwork
  participants: 2 | 3
  threshold: 2 | 3
  rosterSlot: 0
  groupVerifyingKey: string // 64 lowercase hex
  publicKeyPackage: string // base64
  fvk: string // base64 of 96 bytes
  ufvk: string
  address: string
  fingerprint: string // 64 lowercase hex
}

export type SealedVaultRecord = {
  version: 1
  network: VaultNetwork
  groupId: string
  salt: string // base64 of 32 bytes
  iv: string // base64 of 12 bytes
  ciphertext: string // base64
}

export type OpenedVaultRecord = { header: VaultRecordHeader; share: Uint8Array }
export type VaultRecordSummary = {
  fingerprint: string
  address: string
  participants: 2 | 3
  threshold: 2 | 3
}

const HKDF_INFO = 'noir-wallet/frost-vault/record-key/v1'
const PBKDF2_ROUNDS = 2048
const SALT_BYTES = 32
const IV_BYTES = 12
const GCM_TAG_BYTES = 16
const FVK_BYTES = 96
const PUBLIC_KEY_PACKAGE_MAX_BYTES = 1024
const SHARE_MAX_BYTES = 4096
const TEXT_MAX_LENGTH = 512
const LENGTH_PREFIX_BYTES = 4

const GROUP_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/
const WALLET_ID_PATTERN = /^[\x21-\x7e]{1,128}$/
const HEX_32_PATTERN = /^[0-9a-f]{64}$/

const ENTRY_KEYS = ['version', 'network', 'groupId', 'salt', 'iv', 'ciphertext']
const HEADER_KEYS = [
  'version',
  'groupId',
  'network',
  'participants',
  'threshold',
  'rosterSlot',
  'groupVerifyingKey',
  'publicKeyPackage',
  'fvk',
  'ufvk',
  'address',
  'fingerprint'
]

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** WebCrypto's typings want a plain ArrayBuffer-backed view, which our byte helpers do not promise. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isNetwork(value: unknown): value is VaultNetwork {
  return value === 'mainnet' || value === 'testnet'
}

/** Decoded bytes of base64 text, or null when it is not valid base64. */
function decodedBytes(value: unknown): Uint8Array | null {
  if (!isBase64Text(value)) return null
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= TEXT_MAX_LENGTH
}

/** The record header's fingerprint rule; Background applies it to the Worker's summary too. */
export function isVaultFingerprint(value: unknown): value is string {
  return typeof value === 'string' && HEX_32_PATTERN.test(value)
}

/** The record header's address rule; Background applies it to the Worker's summary too. */
export function isVaultAddress(value: unknown): value is string {
  return isBoundedText(value)
}

export function isVaultGroupId(value: unknown): value is string {
  return typeof value === 'string' && GROUP_ID_PATTERN.test(value)
}

export function isVaultWalletId(value: unknown): value is string {
  return typeof value === 'string' && WALLET_ID_PATTERN.test(value)
}

export function parseSealedVaultRecord(value: unknown): SealedVaultRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return null
  const { version, network, groupId, salt, iv, ciphertext } = value
  if (version !== 1 || !isNetwork(network) || !isVaultGroupId(groupId)) return null
  if (decodedBytes(salt)?.length !== SALT_BYTES) return null
  if (decodedBytes(iv)?.length !== IV_BYTES) return null
  const cipherBytes = decodedBytes(ciphertext)
  if (!cipherBytes || cipherBytes.length < GCM_TAG_BYTES + 1) return null
  return {
    version: 1,
    network,
    groupId,
    salt: salt as string,
    iv: iv as string,
    ciphertext: ciphertext as string
  }
}

function parseHeader(value: unknown): VaultRecordHeader | null {
  if (!isRecord(value) || !hasExactKeys(value, HEADER_KEYS)) return null
  const {
    version,
    groupId,
    network,
    participants,
    threshold,
    rosterSlot,
    groupVerifyingKey,
    publicKeyPackage,
    fvk,
    ufvk,
    address,
    fingerprint
  } = value
  if (version !== 1 || !isVaultGroupId(groupId) || !isNetwork(network)) return null
  if (!isDkgShape({ participants, threshold })) return null
  if (rosterSlot !== 0) return null
  if (typeof groupVerifyingKey !== 'string' || !HEX_32_PATTERN.test(groupVerifyingKey)) return null
  if (!isVaultFingerprint(fingerprint)) return null
  const packageLength = decodedBytes(publicKeyPackage)?.length
  if (!packageLength || packageLength > PUBLIC_KEY_PACKAGE_MAX_BYTES) return null
  if (decodedBytes(fvk)?.length !== FVK_BYTES) return null
  if (!isBoundedText(ufvk) || !isVaultAddress(address)) return null
  return {
    version: 1,
    groupId,
    network,
    participants: participants as 2 | 3,
    threshold: threshold as 2 | 3,
    rosterSlot: 0,
    groupVerifyingKey,
    publicKeyPackage: publicKeyPackage as string,
    fvk: fvk as string,
    ufvk,
    address,
    fingerprint
  }
}

function isShareLength(share: Uint8Array): boolean {
  return share.length >= 1 && share.length <= SHARE_MAX_BYTES
}

export function sealedVaultRecordEquals(
  left: SealedVaultRecord,
  right: SealedVaultRecord
): boolean {
  return (
    left.version === right.version &&
    left.network === right.network &&
    left.groupId === right.groupId &&
    left.salt === right.salt &&
    left.iv === right.iv &&
    left.ciphertext === right.ciphertext
  )
}

/**
 * The BIP-39 phrase in its canonical spelling: NFKD, trimmed, words joined by one U+0020. A stored
 * phrase with stray whitespace must derive the same key as the phrase a user types elsewhere.
 */
function canonicalMnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().replace(/\s+/g, ' ')
}

/** The seed is the BIP-39 PBKDF2 output; it is wiped as soon as the AES key exists. */
async function deriveRecordKey(mnemonic: string, salt: Uint8Array): Promise<CryptoKey> {
  const phrase = encoder.encode(canonicalMnemonic(mnemonic))
  let passphrase: CryptoKey
  try {
    passphrase = await crypto.subtle.importKey('raw', phrase, 'PBKDF2', false, ['deriveBits'])
  } finally {
    // WebCrypto holds its own copy once imported; ours must not linger, success or not.
    phrase.fill(0)
  }
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-512',
        salt: encoder.encode('mnemonic'),
        iterations: PBKDF2_ROUNDS
      },
      passphrase,
      512
    )
  )
  try {
    const hkdfKey = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: own(encoder.encode(HKDF_INFO)) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  } finally {
    seed.fill(0)
  }
}

/** Binding network and group id into the tag stops an entry from being re-labelled. */
function additionalData(network: VaultNetwork, groupId: string): Uint8Array<ArrayBuffer> {
  return own(encoder.encode(JSON.stringify([1, network, groupId])))
}

export async function sealVaultRecord(
  header: VaultRecordHeader,
  share: Uint8Array,
  mnemonic: string
): Promise<SealedVaultRecord> {
  const checked = parseHeader(header)
  if (!checked || !isShareLength(share)) throw new Error('Invalid vault record')

  const headerBytes = encoder.encode(JSON.stringify(checked))
  const plaintext = new Uint8Array(LENGTH_PREFIX_BYTES + headerBytes.length + share.length)
  try {
    new DataView(plaintext.buffer).setUint32(0, headerBytes.length, false)
    plaintext.set(headerBytes, LENGTH_PREFIX_BYTES)
    plaintext.set(share, LENGTH_PREFIX_BYTES + headerBytes.length)

    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = await deriveRecordKey(mnemonic, salt)
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: additionalData(checked.network, checked.groupId) },
        key,
        plaintext
      )
    )
    return {
      version: 1,
      network: checked.network,
      groupId: checked.groupId,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    }
  } finally {
    plaintext.fill(0)
    headerBytes.fill(0)
  }
}

export async function openVaultRecord(
  record: SealedVaultRecord,
  mnemonic: string
): Promise<OpenedVaultRecord> {
  let plaintext: Uint8Array | null = null
  try {
    const entry = parseSealedVaultRecord(record)
    if (!entry) throw new Error('invalid entry')
    const salt = base64ToBytes(entry.salt)
    const key = await deriveRecordKey(mnemonic, salt)
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: own(base64ToBytes(entry.iv)),
          additionalData: additionalData(entry.network, entry.groupId)
        },
        key,
        own(base64ToBytes(entry.ciphertext))
      )
    )
    if (plaintext.length < LENGTH_PREFIX_BYTES) throw new Error('short plaintext')
    const headerLength = new DataView(plaintext.buffer).getUint32(0, false)
    const shareStart = LENGTH_PREFIX_BYTES + headerLength
    if (shareStart > plaintext.length) throw new Error('length out of range')
    const header = parseHeader(
      JSON.parse(decoder.decode(plaintext.subarray(LENGTH_PREFIX_BYTES, shareStart)))
    )
    if (!header || header.groupId !== entry.groupId || header.network !== entry.network) {
      throw new Error('header mismatch')
    }
    const share = plaintext.slice(shareStart)
    if (!isShareLength(share)) {
      share.fill(0)
      throw new Error('bad share length')
    }
    return { header, share }
  } catch {
    throw new Error('Vault record cannot be opened')
  } finally {
    plaintext?.fill(0)
  }
}
