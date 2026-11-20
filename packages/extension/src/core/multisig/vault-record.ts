/**
 * Sealed vault records: the FROST key share and its public header, encrypted under a key derived
 * from the wallet mnemonic so the record can only be opened while the wallet is unlocked.
 */
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { isBase64Text, isDkgShape } from './dkg-protocol'
import {
  buildRoster,
  parseRosterManifest,
  QR_TRANSPORT_PUBLIC_KEY,
  type RosterManifest
} from './roster'
import { parseIdentityPublicKey } from './identity'

export type VaultNetwork = 'mainnet' | 'testnet'

export type VaultRecordHeaderV1 = {
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

export type VaultRecordBinding = {
  accountId: string
  birthdayHeight: number
  rosterVersion: 1
  roster: RosterManifest
}
export type VaultRecordHeaderV2 = Omit<VaultRecordHeaderV1, 'version'> &
  VaultRecordBinding & {
    version: 2
    ownerWalletId: string
    recoveredPhoneIdentityPublicKey?: string
  }
export type VaultRecordHeader = VaultRecordHeaderV1 | VaultRecordHeaderV2
export type VaultRecordScope = {
  accountId: string
  ownerWalletId: string
  groupId: string
  network: VaultNetwork
}

export type SealedVaultRecordV1 = {
  version: 1
  network: VaultNetwork
  groupId: string
  salt: string // base64 of 32 bytes
  iv: string // base64 of 12 bytes
  ciphertext: string // base64
}
export type SealedVaultRecordV2 = Omit<SealedVaultRecordV1, 'version'> & {
  version: 2
  accountId: string
  ownerWalletId: string
}
export type SealedVaultRecord = SealedVaultRecordV1 | SealedVaultRecordV2

export type OpenedVaultRecord = { header: VaultRecordHeader; share: Uint8Array }
export type VaultRecordSummary = {
  fingerprint: string
  address: string
  participants: 2 | 3
  threshold: 2 | 3
  authenticated?: {
    accountId: string
    ownerWalletId: string
    birthdayHeight: number
    rosterVersion: 1
    rosterHash: string
    creationConfirmed?: true
  }
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
  if (!isRecord(value)) return null
  if (value.version === 2) {
    if (
      !hasExactKeys(value, [...ENTRY_KEYS, 'accountId', 'ownerWalletId']) ||
      !isVaultWalletId(value.accountId) ||
      !isVaultWalletId(value.ownerWalletId)
    )
      return null
    const { accountId, ownerWalletId, ...legacy } = value
    const base = parseSealedVaultRecord({ ...legacy, version: 1 })
    return base ? { ...base, version: 2, accountId, ownerWalletId } : null
  }
  if (!hasExactKeys(value, ENTRY_KEYS)) return null
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

export function parseVaultRecordBinding(value: unknown): VaultRecordBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'birthdayHeight', 'rosterVersion', 'roster']) ||
    !isVaultWalletId(value.accountId) ||
    value.rosterVersion !== 1 ||
    typeof value.birthdayHeight !== 'number' ||
    !Number.isSafeInteger(value.birthdayHeight) ||
    value.birthdayHeight < 0 ||
    value.birthdayHeight > 0xffffffff
  )
    return null
  const roster = parseRosterManifest(value.roster)
  if (
    !roster ||
    new Set(roster.participants.map(p => p.identityPublicKey)).size !== roster.participants.length
  )
    return null
  for (const participant of roster.participants) Object.freeze(participant)
  Object.freeze(roster.participants)
  Object.freeze(roster)
  return Object.freeze({
    accountId: value.accountId,
    birthdayHeight: value.birthdayHeight,
    rosterVersion: 1,
    roster
  })
}

export function isVaultRecordHeaderV2(header: VaultRecordHeader): header is VaultRecordHeaderV2 {
  return header.version === 2
}

function parseHeader(value: unknown): VaultRecordHeader | null {
  if (isRecord(value) && value.version === 2) {
    const recoveredPhoneIdentityPublicKey = value.recoveredPhoneIdentityPublicKey
    if (
      !hasExactKeys(value, [
        ...HEADER_KEYS,
        'accountId',
        'ownerWalletId',
        'birthdayHeight',
        'rosterVersion',
        'roster',
        ...(recoveredPhoneIdentityPublicKey === undefined
          ? []
          : ['recoveredPhoneIdentityPublicKey'])
      ]) ||
      !isVaultWalletId(value.ownerWalletId)
    )
      return null
    const {
      accountId,
      ownerWalletId,
      birthdayHeight,
      rosterVersion,
      roster,
      recoveredPhoneIdentityPublicKey: _recovered,
      ...legacy
    } = value
    const base = parseHeader({ ...legacy, version: 1 })
    const binding = parseVaultRecordBinding({ accountId, birthdayHeight, rosterVersion, roster })
    if (
      !base ||
      !binding ||
      binding.roster.groupId !== base.groupId ||
      binding.roster.threshold !== base.threshold ||
      binding.roster.participants.length !== base.participants
    )
      return null
    if (recoveredPhoneIdentityPublicKey !== undefined) {
      if (typeof recoveredPhoneIdentityPublicKey !== 'string') return null
      const parsedIdentity = parseIdentityPublicKey(recoveredPhoneIdentityPublicKey)
      if (
        base.participants !== 2 ||
        base.threshold !== 2 ||
        !parsedIdentity ||
        bytesToBase64(parsedIdentity.bytes) !== recoveredPhoneIdentityPublicKey ||
        recoveredPhoneIdentityPublicKey === binding.roster.participants[0].identityPublicKey
      )
        return null
    }
    return {
      ...base,
      version: 2,
      ownerWalletId,
      ...binding,
      ...(recoveredPhoneIdentityPublicKey === undefined ? {} : { recoveredPhoneIdentityPublicKey })
    }
  }
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

/** Keep the DKG roster intact for creation evidence; only signing adopts a restored phone. */
export function effectiveSigningRoster(header: VaultRecordHeaderV2): RosterManifest {
  if (!header.recoveredPhoneIdentityPublicKey) return header.roster
  if (header.participants !== 2 || header.threshold !== 2) throw new Error('Invalid vault record')
  return buildRoster({
    groupId: header.groupId,
    threshold: header.threshold,
    identities: new Map([
      [0, header.roster.participants[0].identityPublicKey],
      [1, header.recoveredPhoneIdentityPublicKey]
    ]),
    transportPublicKeys: new Map([
      [0, header.roster.participants[0].transportPublicKey],
      [1, QR_TRANSPORT_PUBLIC_KEY]
    ])
  })
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
    (left.version !== 2 ||
      (right.version === 2 &&
        left.accountId === right.accountId &&
        left.ownerWalletId === right.ownerWalletId)) &&
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
async function deriveRecordKey(
  mnemonic: string,
  salt: Uint8Array,
  version: 1 | 2 = 1
): Promise<CryptoKey> {
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
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: own(salt),
        info: own(
          encoder.encode(version === 1 ? HKDF_INFO : 'noir-wallet/frost-vault/record-key/v2')
        )
      },
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

function recordAdditionalData(
  record: VaultRecordHeader | SealedVaultRecord
): Uint8Array<ArrayBuffer> {
  return record.version === 1
    ? additionalData(record.network, record.groupId)
    : own(
        encoder.encode(
          JSON.stringify([
            2,
            record.network,
            record.groupId,
            record.accountId,
            record.ownerWalletId
          ])
        )
      )
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
    const key = await deriveRecordKey(mnemonic, salt, checked.version)
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: recordAdditionalData(checked) },
        key,
        plaintext
      )
    )
    return {
      ...(checked.version === 1
        ? { version: 1 as const }
        : {
            version: 2 as const,
            accountId: checked.accountId,
            ownerWalletId: checked.ownerWalletId
          }),
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
  mnemonic: string,
  expectedScope?: VaultRecordScope
): Promise<OpenedVaultRecord> {
  let plaintext: Uint8Array | null = null
  try {
    const entry = parseSealedVaultRecord(record)
    if (!entry) throw new Error('invalid entry')
    if (
      expectedScope &&
      (entry.version !== 2 ||
        entry.accountId !== expectedScope.accountId ||
        entry.ownerWalletId !== expectedScope.ownerWalletId ||
        entry.groupId !== expectedScope.groupId ||
        entry.network !== expectedScope.network)
    )
      throw new Error('scope mismatch')
    const salt = base64ToBytes(entry.salt)
    const key = await deriveRecordKey(mnemonic, salt, entry.version)
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: own(base64ToBytes(entry.iv)),
          additionalData: recordAdditionalData(entry)
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
    if (
      !header ||
      header.version !== entry.version ||
      header.groupId !== entry.groupId ||
      header.network !== entry.network ||
      (entry.version === 2 &&
        (header.version !== 2 ||
          header.accountId !== entry.accountId ||
          header.ownerWalletId !== entry.ownerWalletId))
    ) {
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
