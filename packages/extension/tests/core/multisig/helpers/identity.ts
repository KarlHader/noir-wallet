import { signEnvelope, type EnvelopeHead } from '../../../../src/core/multisig/envelope-signing'
import type { MultisigEnvelope } from '../../../../src/core/multisig/messages'
import { base64ToBytes } from '../../../../src/lib/bytes'
import {
  IDENTITY_PUBLIC_KEY_BYTES,
  IDENTITY_VERSION_BYTE,
  type DeviceIdentity,
  type IdentityStore
} from '../../../../src/core/multisig/identity'

const PKCS8_ED25519_PREFIX = Uint8Array.from(
  '302e020100300506032b657004220420'.match(/../g)!.map(h => parseInt(h, 16))
)

export const SPEC_SEED = Uint8Array.from({ length: 32 }, (_, i) => i)

export function createMemoryIdentityStore(): IdentityStore & { saves: number } {
  let current: DeviceIdentity | null = null
  const store = {
    saves: 0,
    async load() {
      return current
    },
    async save(identity: DeviceIdentity) {
      current = identity
      store.saves += 1
    },
    async clear() {
      current = null
    }
  }
  return store
}

export async function importEd25519Seed(seed: Uint8Array): Promise<CryptoKeyPair> {
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length)
  der.set(PKCS8_ED25519_PREFIX)
  der.set(seed, PKCS8_ED25519_PREFIX.length)
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, [
    'sign'
  ])
  // A non-extractable key cannot export its public half, so derive it from an extractable twin.
  const extractable = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, [
    'sign'
  ])
  const jwk = await crypto.subtle.exportKey('jwk', extractable)
  const raw = base64ToBytes(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'))
  const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
  return { privateKey, publicKey }
}

export async function identityFromSeed(seed: Uint8Array): Promise<DeviceIdentity> {
  const signingKeys = await importEd25519Seed(seed)
  const agreementKeys = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
    'deriveBits'
  ])) as CryptoKeyPair
  const publicKey = new Uint8Array(IDENTITY_PUBLIC_KEY_BYTES)
  publicKey[0] = IDENTITY_VERSION_BYTE
  publicKey.set(new Uint8Array(await crypto.subtle.exportKey('raw', signingKeys.publicKey)), 1)
  publicKey.set(new Uint8Array(await crypto.subtle.exportKey('raw', agreementKeys.publicKey)), 33)
  return { publicKey, signingKeys, agreementKeys }
}

export async function signedPhoneEnvelope(
  identity: DeviceIdentity,
  head: Omit<EnvelopeHead, 'payload_hash'>
): Promise<MultisigEnvelope> {
  return signEnvelope(identity.signingKeys.privateKey, head)
}
