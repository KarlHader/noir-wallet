import {
  hardwareCredentialMetadataEquals,
  parseHardwareCredentialMetadata,
  type HardwareCredentialMetadata
} from '@/core/keyring/domain'
import {
  parseStoredHardwareCredential,
  type StoredHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import { SecureStorage } from '@/core/wallet/secure-storage'
import type { V1EncryptedCredentialEnvelope } from './v1-credential-envelope'
import { parseV1EncryptedCredentialEnvelope } from './v1-credential-envelope'

export interface RewrappedHardwareCredential {
  readonly sourceEnvelope: V1EncryptedCredentialEnvelope
  readonly targetEnvelope: V1EncryptedCredentialEnvelope
  readonly credential: StoredHardwareCredential
}

function credentialMetadata(credential: StoredHardwareCredential): HardwareCredentialMetadata {
  return parseHardwareCredentialMetadata({
    vendor: credential.vendor,
    firmwareProfile: credential.firmwareProfile,
    capabilities: credential.capabilities
  })
}

export function hardwareCredentialMatchesMetadata(
  credential: StoredHardwareCredential,
  metadata: HardwareCredentialMetadata
): boolean {
  return hardwareCredentialMetadataEquals(credentialMetadata(credential), metadata)
}

export function hardwareCredentialEnvelopeEquals(
  left: V1EncryptedCredentialEnvelope,
  right: V1EncryptedCredentialEnvelope
): boolean {
  return (
    left.encryptedData === right.encryptedData && left.salt === right.salt && left.iv === right.iv
  )
}

export function ledgerMultichainCredentialEquals(
  left: StoredHardwareCredential,
  right: StoredHardwareCredential
): boolean {
  return (
    left.vendor === 'ledger' &&
    left.schemaVersion === 3 &&
    right.vendor === 'ledger' &&
    right.schemaVersion === 3 &&
    JSON.stringify(left) === JSON.stringify(right)
  )
}

export async function readHardwareCredentialEnvelope(
  envelopeValue: V1EncryptedCredentialEnvelope,
  password: string
): Promise<StoredHardwareCredential> {
  const envelope = parseV1EncryptedCredentialEnvelope(envelopeValue)
  let plaintext: string
  try {
    plaintext = await SecureStorage.decrypt(envelope, password)
  } catch {
    throw new Error('Hardware credential password is invalid')
  }
  try {
    return parseStoredHardwareCredential(JSON.parse(plaintext))
  } catch {
    throw new Error('Invalid hardware credential payload')
  }
}

export async function rewrapHardwareCredentialEnvelope(
  envelopeValue: V1EncryptedCredentialEnvelope,
  currentPassword: string,
  newPassword: string
): Promise<RewrappedHardwareCredential> {
  const sourceEnvelope = parseV1EncryptedCredentialEnvelope(envelopeValue)
  const credential = await readHardwareCredentialEnvelope(sourceEnvelope, currentPassword)
  const targetEnvelope = parseV1EncryptedCredentialEnvelope(
    await SecureStorage.encrypt(JSON.stringify(credential), newPassword)
  )
  const verified = await readHardwareCredentialEnvelope(targetEnvelope, newPassword)
  if (JSON.stringify(verified) !== JSON.stringify(credential)) {
    throw new Error('Hardware credential rewrap verification failed')
  }
  return Object.freeze({ sourceEnvelope, targetEnvelope, credential })
}
