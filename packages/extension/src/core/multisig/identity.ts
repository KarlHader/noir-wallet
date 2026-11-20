import { sha256 } from '@noble/hashes/sha2'
import { base64ToBytes, bytesToHex } from '@/lib/bytes'

export const IDENTITY_PUBLIC_KEY_BYTES = 65
export const IDENTITY_VERSION_BYTE = 0x01

export type DeviceIdentity = {
  // version byte || Ed25519 public key (32) || X25519 public key (32)
  publicKey: Uint8Array
  signingKeys: CryptoKeyPair
  agreementKeys: CryptoKeyPair
}

export interface IdentityStore {
  load(): Promise<DeviceIdentity | null>
  save(identity: DeviceIdentity): Promise<void>
  clear(): Promise<void>
}

async function exportRaw(subtle: SubtleCrypto, key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey('raw', key))
}

export async function generateDeviceIdentity(
  subtle: SubtleCrypto = crypto.subtle
): Promise<DeviceIdentity> {
  // Private keys are non-extractable so a leaked storage dump cannot reveal them.
  const signingKeys = (await subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const agreementKeys = (await subtle.generateKey({ name: 'X25519' }, false, [
    'deriveBits'
  ])) as CryptoKeyPair
  const publicKey = new Uint8Array(IDENTITY_PUBLIC_KEY_BYTES)
  publicKey[0] = IDENTITY_VERSION_BYTE
  publicKey.set(await exportRaw(subtle, signingKeys.publicKey), 1)
  publicKey.set(await exportRaw(subtle, agreementKeys.publicKey), 33)
  return { publicKey, signingKeys, agreementKeys }
}

export function parseIdentityPublicKey(
  value: string | Uint8Array
): { bytes: Uint8Array; ed25519: Uint8Array; x25519: Uint8Array } | null {
  let bytes: Uint8Array
  if (typeof value === 'string') {
    try {
      bytes = base64ToBytes(value)
    } catch {
      return null
    }
  } else {
    bytes = value
  }
  if (bytes.length !== IDENTITY_PUBLIC_KEY_BYTES || bytes[0] !== IDENTITY_VERSION_BYTE) return null
  return { bytes, ed25519: bytes.slice(1, 33), x25519: bytes.slice(33, 65) }
}

// First 20 bytes of SHA-256 over the full 65-byte encoding, as 10 groups of 4 uppercase hex chars.
export function identityFingerprint(publicKey: Uint8Array): string {
  const hex = bytesToHex(sha256(publicKey).subarray(0, 20)).toUpperCase()
  return hex.match(/.{4}/g)!.join(' ')
}

// No separate capability probe: a runtime without Ed25519/X25519 fails the load, which the
// caller reports as unsupported.
export async function loadOrCreateDeviceIdentity(
  store: IdentityStore,
  subtle: SubtleCrypto = crypto.subtle,
  onCreated?: () => void
): Promise<DeviceIdentity> {
  const existing = await store.load()
  if (existing) return existing
  const created = await generateDeviceIdentity(subtle)
  await store.save(created)
  onCreated?.()
  return created
}
