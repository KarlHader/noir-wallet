import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  parseCredentialEnvelopeAad
} from '@/core/keyring/domain'
import type { EncryptedCredentialEnvelopeRecord } from '@/ports/repositories'
import {
  decodeV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './migration/v1-credential-envelope'

const AUTHENTICATION_TAG_BYTES = 32
const PBKDF2_ITERATIONS = 100_000
const WRAPPER_MAGIC = new TextEncoder().encode('NOIRCEV2')
const KEY_DERIVATION_DOMAIN = new TextEncoder().encode(
  'NoirWallet credential envelope authentication key v1\0'
)
const MESSAGE_DOMAIN = 'NoirWallet credential envelope authentication message v1'
const TEXT_ENCODER = new TextEncoder()

export class CredentialAuthenticationError extends Error {
  constructor() {
    super('Credential envelope authentication failed')
    this.name = 'CredentialAuthenticationError'
  }
}

type SoftwareCredentialEnvelopePair = Readonly<{
  zcash: EncryptedCredentialEnvelopeRecord
  multichain: EncryptedCredentialEnvelopeRecord
}>

function assertHardwareEnvelope(record: EncryptedCredentialEnvelopeRecord): void {
  if (record.aad.schemaVersion !== CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION) {
    throw new Error('Unsupported hardware credential envelope format')
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function canonicalAadBytes(record: EncryptedCredentialEnvelopeRecord): Uint8Array {
  const aad = parseCredentialEnvelopeAad(record.aad)
  return TEXT_ENCODER.encode(
    JSON.stringify([
      MESSAGE_DOMAIN,
      record.schemaVersion,
      record.transactionId,
      aad.schemaVersion,
      aad.engine,
      aad.keyDomainId,
      aad.credentialGenerationId,
      aad.credentialRef,
      aad.formatVersion,
      record.createdAt
    ])
  )
}

function authenticationMessage(
  record: EncryptedCredentialEnvelopeRecord,
  payload: Uint8Array
): Uint8Array {
  const aad = canonicalAadBytes(record)
  const message = new Uint8Array(8 + aad.byteLength + payload.byteLength)
  const view = new DataView(message.buffer)
  view.setUint32(0, aad.byteLength)
  message.set(aad, 4)
  view.setUint32(4 + aad.byteLength, payload.byteLength)
  message.set(payload, 8 + aad.byteLength)
  return message
}

async function deriveAuthenticationKey(
  password: string,
  zcashEnvelope: V1EncryptedCredentialEnvelope
): Promise<CryptoKey> {
  const passwordBytes = TEXT_ENCODER.encode(password)
  const salt = concatBytes(KEY_DERIVATION_DOMAIN, decodeBase64(zcashEnvelope.salt))
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, [
      'deriveKey'
    ])
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    )
  } finally {
    passwordBytes.fill(0)
  }
}

async function deriveStandaloneAuthenticationKey(
  password: string,
  record: EncryptedCredentialEnvelopeRecord
): Promise<CryptoKey> {
  if (
    record.aad.schemaVersion !== CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION ||
    record.aad.engine !== 'multichain'
  ) {
    throw new Error('Unsupported private-key credential envelope format')
  }
  const passwordBytes = TEXT_ENCODER.encode(password)
  const salt = concatBytes(
    KEY_DERIVATION_DOMAIN,
    TEXT_ENCODER.encode(
      JSON.stringify([
        'private-key-envelope-v1',
        record.aad.keyDomainId,
        record.aad.credentialGenerationId,
        record.aad.credentialRef
      ])
    )
  )
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, [
      'deriveKey'
    ])
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    )
  } finally {
    passwordBytes.fill(0)
    salt.fill(0)
  }
}

function readWrappedPayload(value: Uint8Array): {
  readonly tag: Uint8Array
  readonly payload: Uint8Array
} {
  const payloadOffset = WRAPPER_MAGIC.byteLength + AUTHENTICATION_TAG_BYTES
  if (
    value.byteLength <= payloadOffset ||
    !WRAPPER_MAGIC.every((byte, index) => value[index] === byte)
  ) {
    throw new Error('Invalid authenticated credential envelope')
  }
  return Object.freeze({
    tag: value.slice(WRAPPER_MAGIC.byteLength, payloadOffset),
    payload: value.slice(payloadOffset)
  })
}

async function wrapPayload(
  key: CryptoKey,
  record: EncryptedCredentialEnvelopeRecord
): Promise<Uint8Array> {
  const payload = new Uint8Array(record.encryptedPayload)
  const tag = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, authenticationMessage(record, payload) as BufferSource)
  )
  return concatBytes(WRAPPER_MAGIC, tag, payload)
}

async function verifyAndUnwrapPayload(
  key: CryptoKey,
  record: EncryptedCredentialEnvelopeRecord
): Promise<Uint8Array> {
  const wrapped = readWrappedPayload(record.encryptedPayload)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    wrapped.tag as BufferSource,
    authenticationMessage(record, wrapped.payload) as BufferSource
  )
  if (!valid) throw new CredentialAuthenticationError()
  return wrapped.payload
}

function assertSoftwarePair(
  pair: SoftwareCredentialEnvelopePair,
  expectedAadSchemaVersion:
    | typeof LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
    | typeof CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
): void {
  if (
    pair.zcash.aad.engine !== 'zcash' ||
    pair.multichain.aad.engine !== 'multichain' ||
    pair.zcash.aad.keyDomainId !== pair.multichain.aad.keyDomainId ||
    pair.zcash.aad.credentialGenerationId !== pair.multichain.aad.credentialGenerationId ||
    pair.zcash.transactionId !== pair.multichain.transactionId ||
    pair.zcash.createdAt !== pair.multichain.createdAt ||
    pair.zcash.aad.credentialRef === pair.multichain.aad.credentialRef ||
    pair.zcash.aad.schemaVersion !== expectedAadSchemaVersion ||
    pair.multichain.aad.schemaVersion !== expectedAadSchemaVersion
  ) {
    throw new Error('Credential envelope pair binding mismatch')
  }
}

export function credentialEnvelopePairFormat(
  pair: SoftwareCredentialEnvelopePair
): 'legacy' | 'authenticated' {
  if (
    pair.zcash.aad.schemaVersion === LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION &&
    pair.multichain.aad.schemaVersion === LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
  ) {
    assertSoftwarePair(pair, LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION)
    return 'legacy'
  }
  assertSoftwarePair(pair, CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION)
  return 'authenticated'
}

export async function authenticateSoftwareCredentialEnvelopePair(
  pair: SoftwareCredentialEnvelopePair,
  password: string
): Promise<SoftwareCredentialEnvelopePair> {
  assertSoftwarePair(pair, CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION)
  const zcashEnvelope = decodeV1EncryptedCredentialEnvelope(pair.zcash.encryptedPayload)
  const key = await deriveAuthenticationKey(password, zcashEnvelope)
  const [zcashPayload, multichainPayload] = await Promise.all([
    wrapPayload(key, pair.zcash),
    wrapPayload(key, pair.multichain)
  ])
  return Object.freeze({
    zcash: Object.freeze({ ...pair.zcash, encryptedPayload: zcashPayload }),
    multichain: Object.freeze({ ...pair.multichain, encryptedPayload: multichainPayload })
  })
}

export async function unwrapSoftwareCredentialEnvelopePair(
  pair: SoftwareCredentialEnvelopePair,
  password: string
): Promise<Readonly<{ zcash: Uint8Array; multichain: Uint8Array }>> {
  assertSoftwarePair(pair, CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION)
  const untrustedZcashPayload = readWrappedPayload(pair.zcash.encryptedPayload).payload
  const zcashEnvelope = decodeV1EncryptedCredentialEnvelope(untrustedZcashPayload)
  const key = await deriveAuthenticationKey(password, zcashEnvelope)
  const [zcash, multichain] = await Promise.all([
    verifyAndUnwrapPayload(key, pair.zcash),
    verifyAndUnwrapPayload(key, pair.multichain)
  ])
  return Object.freeze({ zcash, multichain })
}

export async function readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
  pair: SoftwareCredentialEnvelopePair,
  password: string
): Promise<Readonly<{ zcash: Uint8Array; multichain: Uint8Array }>> {
  if (credentialEnvelopePairFormat(pair) === 'legacy') {
    return Object.freeze({
      zcash: new Uint8Array(pair.zcash.encryptedPayload),
      multichain: new Uint8Array(pair.multichain.encryptedPayload)
    })
  }
  return unwrapSoftwareCredentialEnvelopePair(pair, password)
}

export async function unwrapZcashCredentialEnvelope(
  record: EncryptedCredentialEnvelopeRecord,
  password: string
): Promise<Uint8Array> {
  if (record.aad.engine !== 'zcash') throw new Error('Expected a Zcash credential envelope')
  if (record.aad.schemaVersion === LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION) {
    return new Uint8Array(record.encryptedPayload)
  }
  if (record.aad.schemaVersion !== CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION) {
    throw new Error('Unsupported credential envelope format')
  }
  const untrustedPayload = readWrappedPayload(record.encryptedPayload).payload
  const zcashEnvelope = decodeV1EncryptedCredentialEnvelope(untrustedPayload)
  const key = await deriveAuthenticationKey(password, zcashEnvelope)
  return verifyAndUnwrapPayload(key, record)
}

export async function authenticateHardwareCredentialEnvelope(
  record: EncryptedCredentialEnvelopeRecord,
  password: string
): Promise<EncryptedCredentialEnvelopeRecord> {
  assertHardwareEnvelope(record)
  const legacyEnvelope = decodeV1EncryptedCredentialEnvelope(record.encryptedPayload)
  const key = await deriveAuthenticationKey(password, legacyEnvelope)
  return Object.freeze({
    ...record,
    encryptedPayload: await wrapPayload(key, record)
  })
}

export async function unwrapHardwareCredentialEnvelope(
  record: EncryptedCredentialEnvelopeRecord,
  password: string
): Promise<Uint8Array> {
  assertHardwareEnvelope(record)
  const untrustedPayload = readWrappedPayload(record.encryptedPayload).payload
  const legacyEnvelope = decodeV1EncryptedCredentialEnvelope(untrustedPayload)
  const key = await deriveAuthenticationKey(password, legacyEnvelope)
  return verifyAndUnwrapPayload(key, record)
}

export async function authenticatePrivateKeyCredentialEnvelope(
  record: EncryptedCredentialEnvelopeRecord,
  password: string
): Promise<EncryptedCredentialEnvelopeRecord> {
  const key = await deriveStandaloneAuthenticationKey(password, record)
  return Object.freeze({ ...record, encryptedPayload: await wrapPayload(key, record) })
}

export async function unwrapPrivateKeyCredentialEnvelope(
  record: EncryptedCredentialEnvelopeRecord,
  password: string
): Promise<Uint8Array> {
  const key = await deriveStandaloneAuthenticationKey(password, record)
  return verifyAndUnwrapPayload(key, record)
}
