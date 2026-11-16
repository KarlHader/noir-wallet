import {
  KEYRING_MAX_UNLOCKED_CREDENTIALS,
  parseCredentialGenerationId,
  parseKeyringSessionDescriptor,
  parseSessionKeyDomainId,
  type KeyringSessionDescriptor
} from '@/core/keyring/ports'
import { parseRawEncryptedVault, readRecord } from '../multichain/raw-wallet-engine'
import {
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from '../migration/v1-credential-envelope'

export const CREDENTIAL_CAPSULE_SCHEMA_VERSION = 1 as const
const MAX_PASSWORD_BYTES = 1024 * 1024

export interface CredentialSessionUnlockCredential {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly zcashEnvelope?: V1EncryptedCredentialEnvelope
  readonly multichainVault: ReturnType<typeof parseRawEncryptedVault>
}

export interface CredentialSessionUnlockInput {
  readonly password: string
  readonly credentials: readonly CredentialSessionUnlockCredential[]
  readonly lastUserActivityAt: number
  readonly expiresAt?: number
}

export interface EncryptedCredentialCapsule {
  readonly schemaVersion: typeof CREDENTIAL_CAPSULE_SCHEMA_VERSION
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

export interface CredentialSessionAttestation {
  readonly descriptor: KeyringSessionDescriptor
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error('Invalid credential session payload')
  }
}

function parseTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parsePassword(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_PASSWORD_BYTES
  ) {
    throw new Error('Invalid credential session password')
  }
  return value
}

function parseBytes(
  value: unknown,
  label: string,
  options: { readonly exact?: number; readonly maximum?: number }
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    (options.exact !== undefined && value.byteLength !== options.exact) ||
    (options.maximum !== undefined && value.byteLength > options.maximum)
  ) {
    throw new Error(`Invalid credential capsule ${label}`)
  }
  return new Uint8Array(value)
}

export function parseCredentialSessionUnlockInput(value: unknown): CredentialSessionUnlockInput {
  const record = readRecord(value, 'Credential session unlock input')
  assertExactKeys(
    record,
    ['password', 'credentials', 'lastUserActivityAt'],
    record.expiresAt === undefined ? [] : ['expiresAt']
  )
  if (
    !Array.isArray(record.credentials) ||
    record.credentials.length > KEYRING_MAX_UNLOCKED_CREDENTIALS
  ) {
    throw new Error('Invalid credential session inventory')
  }
  const seen = new Set<string>()
  const credentials = record.credentials.map((value, index) => {
    const credential = readRecord(value, `Credential session item ${index}`)
    assertExactKeys(
      credential,
      ['keyDomainId', 'credentialGenerationId', 'multichainVault'],
      credential.zcashEnvelope === undefined ? [] : ['zcashEnvelope']
    )
    const keyDomainId = parseSessionKeyDomainId(credential.keyDomainId)
    if (seen.has(keyDomainId)) throw new Error('Duplicate credential session KeyDomain')
    seen.add(keyDomainId)
    return Object.freeze({
      keyDomainId,
      credentialGenerationId: parseCredentialGenerationId(credential.credentialGenerationId),
      ...(credential.zcashEnvelope === undefined
        ? {}
        : { zcashEnvelope: parseV1EncryptedCredentialEnvelope(credential.zcashEnvelope) }),
      multichainVault: parseRawEncryptedVault(credential.multichainVault)
    })
  })
  const lastUserActivityAt = parseTimestamp(
    record.lastUserActivityAt,
    'credential session activity timestamp'
  )
  const expiresAt =
    record.expiresAt === undefined
      ? undefined
      : parseTimestamp(record.expiresAt, 'credential session expiry timestamp')
  if (expiresAt !== undefined && expiresAt <= lastUserActivityAt) {
    throw new Error('Credential session expiry must follow activity')
  }
  return Object.freeze({
    password: parsePassword(record.password),
    credentials: Object.freeze(credentials),
    lastUserActivityAt,
    ...(expiresAt === undefined ? {} : { expiresAt })
  })
}

export function parseEncryptedCredentialCapsule(value: unknown): EncryptedCredentialCapsule {
  const record = readRecord(value, 'Encrypted credential capsule')
  assertExactKeys(record, [
    'schemaVersion',
    'keyDomainId',
    'credentialGenerationId',
    'iv',
    'ciphertext'
  ])
  if (record.schemaVersion !== CREDENTIAL_CAPSULE_SCHEMA_VERSION) {
    throw new Error('Invalid credential capsule schema')
  }
  return Object.freeze({
    schemaVersion: CREDENTIAL_CAPSULE_SCHEMA_VERSION,
    keyDomainId: parseSessionKeyDomainId(record.keyDomainId),
    credentialGenerationId: parseCredentialGenerationId(record.credentialGenerationId),
    iv: parseBytes(record.iv, 'IV', { exact: 12 }),
    ciphertext: parseBytes(record.ciphertext, 'ciphertext', { maximum: 1_100_000 })
  })
}

export function parseCredentialSessionAttestation(value: unknown): CredentialSessionAttestation {
  const record = readRecord(value, 'Credential session attestation')
  assertExactKeys(record, ['descriptor'])
  return Object.freeze({ descriptor: parseKeyringSessionDescriptor(record.descriptor) })
}
