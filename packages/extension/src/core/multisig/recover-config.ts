/**
 * The group config a restored phone needs besides its 32 words: the FROST public key package, the
 * unified full viewing key, the keyset fingerprint and the roster. Byte-for-byte the iOS
 * `KGVaultGroupConfig` (version 2):
 *
 *   version(1) ‖ pkpLen(2, LE) ‖ pkp ‖ ufvkLen(2, LE) ‖ ufvk(UTF-8) ‖ fingerprint(32)
 *     ‖ count(1) ‖ per member: slot(1) ‖ identityPublicKey(65) ‖ nameLen(1) ‖ name(UTF-8)
 *
 * The layout is an iOS proposal that is not yet agreed with the contract side (manual section 4.6), so
 * nothing outside the pair should depend on it. `slot` is the roster slot, device slot minus one.
 */
import { base64ToBytes, bytesToBase64, hexToBytes } from '@/lib/bytes'
import { IDENTITY_PUBLIC_KEY_BYTES, IDENTITY_VERSION_BYTE } from './identity'

export const GROUP_CONFIG_VERSION = 2
export const GROUP_CONFIG_FINGERPRINT_BYTES = 32

export type GroupConfigMember = {
  /** Roster slot: 0 is the extension, 1 and 2 are the phones. */
  slot: number
  identityPublicKey: Uint8Array // 65 bytes
  name: string
}

export type GroupConfig = {
  publicKeyPackage: Uint8Array
  ufvk: string
  fingerprint: Uint8Array // 32 bytes
  roster: readonly GroupConfigMember[]
}

const encoder = new TextEncoder()
const NAME_MAX_BYTES = 255
const LENGTH_MAX = 0xffff

/** Cuts at a character boundary so a multi-byte name is never split in the middle. */
function truncateUtf8(text: string, limit: number): Uint8Array {
  let out = ''
  let bytes = 0
  for (const character of text) {
    const size = encoder.encode(character).length
    if (bytes + size > limit) break
    out += character
    bytes += size
  }
  return encoder.encode(out)
}

function lengthLe(length: number): number[] {
  return [length & 0xff, (length >> 8) & 0xff]
}

export function encodeGroupConfig(config: GroupConfig): Uint8Array {
  const ufvk = encoder.encode(config.ufvk)
  if (config.publicKeyPackage.length === 0 || config.publicKeyPackage.length > LENGTH_MAX) {
    throw new Error('Invalid public key package')
  }
  if (ufvk.length === 0 || ufvk.length > LENGTH_MAX) throw new Error('Invalid viewing key')
  if (config.fingerprint.length !== GROUP_CONFIG_FINGERPRINT_BYTES) {
    throw new Error('Invalid fingerprint')
  }
  const count = config.roster.length
  if (count < 2 || count > 3) throw new Error('Invalid roster size')
  const slots = new Set(config.roster.map(member => member.slot))
  const identities = new Set(config.roster.map(member => bytesToBase64(member.identityPublicKey)))
  if (slots.size !== count || [...slots].some(slot => slot < 0 || slot >= count)) {
    throw new Error('Invalid roster slots')
  }
  if (identities.size !== count) throw new Error('Duplicate identity in roster')

  const parts: number[][] = [
    [GROUP_CONFIG_VERSION],
    lengthLe(config.publicKeyPackage.length),
    [...config.publicKeyPackage],
    lengthLe(ufvk.length),
    [...ufvk],
    [...config.fingerprint],
    [count]
  ]
  for (const member of config.roster) {
    if (
      member.identityPublicKey.length !== IDENTITY_PUBLIC_KEY_BYTES ||
      member.identityPublicKey[0] !== IDENTITY_VERSION_BYTE
    ) {
      throw new Error('Invalid roster identity')
    }
    const name = truncateUtf8(member.name, NAME_MAX_BYTES)
    parts.push([member.slot], [...member.identityPublicKey], [name.length], [...name])
  }
  return Uint8Array.from(parts.flat())
}

/** Strict, like the phone: extra bytes, missing bytes and unknown versions are all refused. */
export function parseGroupConfig(bytes: Uint8Array): GroupConfig | null {
  let position = 0
  const take = (length: number): Uint8Array | null => {
    if (length < 0 || bytes.length - position < length) return null
    const out = bytes.subarray(position, position + length)
    position += length
    return out
  }
  const takeLength = (): number | null => {
    const raw = take(2)
    return raw ? raw[0] | (raw[1] << 8) : null
  }

  const version = take(1)
  if (!version || version[0] !== GROUP_CONFIG_VERSION) return null
  const pkpLength = takeLength()
  const pkp = pkpLength === null ? null : take(pkpLength)
  const ufvkLength = takeLength()
  const ufvkBytes = ufvkLength === null ? null : take(ufvkLength)
  const fingerprint = take(GROUP_CONFIG_FINGERPRINT_BYTES)
  const count = take(1)
  if (!pkp || !ufvkBytes || !fingerprint || !count || count[0] < 2 || count[0] > 3) return null

  let ufvk: string
  try {
    ufvk = new TextDecoder('utf-8', { fatal: true }).decode(ufvkBytes)
  } catch {
    return null
  }
  const roster: GroupConfigMember[] = []
  for (let index = 0; index < count[0]; index += 1) {
    const slot = take(1)
    const identity = take(IDENTITY_PUBLIC_KEY_BYTES)
    const nameLength = take(1)
    const nameBytes = nameLength ? take(nameLength[0]) : null
    if (!slot || !identity || !nameBytes || identity[0] !== IDENTITY_VERSION_BYTE) return null
    let name: string
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    } catch {
      return null
    }
    roster.push({ slot: slot[0], identityPublicKey: identity.slice(), name })
  }
  if (position !== bytes.length || pkp.length === 0 || ufvk.length === 0) return null
  const slots = new Set(roster.map(member => member.slot))
  const identities = new Set(roster.map(member => bytesToBase64(member.identityPublicKey)))
  if (slots.size !== count[0] || [...slots].some(slot => slot >= count[0])) return null
  if (identities.size !== count[0]) return null
  return { publicKeyPackage: pkp.slice(), ufvk, fingerprint: fingerprint.slice(), roster }
}

/** The restore flow only knows how to build a roster for two devices; see `buildRestoreConfig`. */
export class RestoreUnsupportedError extends Error {}

/**
 * The group config for a phone being restored, with the identity from its recovery request.
 *
 * Only 2-of-2 groups are supported: the roster needs every member's identity, and the extension
 * does not keep the other phone's identity, so a 3-device roster would have to be guessed.
 *
 * @param input.publicKeyPackage base64, from the sealed vault header
 * @param input.fingerprint 64 lowercase hex, from the sealed vault header
 */
export function buildRestoreConfig(input: {
  publicKeyPackage: string
  ufvk: string
  fingerprint: string
  participants: number
  owner: { identityPublicKey: Uint8Array; name: string }
  phoneName: string
  /** The phone's fresh identity, from its recovery request. */
  phoneIdentityPublicKey: Uint8Array
}): Uint8Array {
  if (input.participants !== 2) throw new RestoreUnsupportedError('Only 2-of-2 groups')
  if (!/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new Error('Invalid fingerprint')
  return encodeGroupConfig({
    publicKeyPackage: base64ToBytes(input.publicKeyPackage),
    ufvk: input.ufvk,
    fingerprint: hexToBytes(input.fingerprint),
    roster: [
      { slot: 0, identityPublicKey: input.owner.identityPublicKey, name: input.owner.name },
      { slot: 1, identityPublicKey: input.phoneIdentityPublicKey, name: input.phoneName }
    ]
  })
}
