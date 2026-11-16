import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import {
  CREDENTIAL_CAPSULE_SCHEMA_VERSION,
  type CredentialSessionUnlockCredential,
  type EncryptedCredentialCapsule
} from './credential-session-protocol'

type SealRequest = Readonly<{
  id: string
  operation: 'seal'
  masterKey: CryptoKey
  globalUnlockEpoch: string
  password: string
  credentials: readonly CredentialSessionUnlockCredential[]
}>

type CapsuleWorkerRequest = SealRequest
type CapsuleWorkerResponse =
  | Readonly<{ id: string; result: readonly EncryptedCredentialCapsule[] }>
  | Readonly<{ id: string; error: 'INVALID_CREDENTIAL' | 'CAPSULE_FAILURE' }>

interface DedicatedWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message: CapsuleWorkerResponse): void
  close(): void
}

const encoder = new TextEncoder()

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function capsuleAad(
  globalUnlockEpoch: string,
  keyDomainId: string,
  credentialGenerationId: string
): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: CREDENTIAL_CAPSULE_SCHEMA_VERSION,
      globalUnlockEpoch,
      keyDomainId,
      credentialGenerationId
    })
  )
}

async function decryptMnemonic(
  envelope: NonNullable<CredentialSessionUnlockCredential['zcashEnvelope']>,
  password: string
): Promise<string> {
  const salt = base64ToBytes(envelope.salt)
  const iv = base64ToBytes(envelope.iv)
  const encrypted = base64ToBytes(envelope.encryptedData)
  let plaintext: ArrayBuffer
  try {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: 100_000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encrypted as BufferSource
    )
  } catch {
    throw new Error('INVALID_CREDENTIAL')
  } finally {
    salt.fill(0)
    iv.fill(0)
    encrypted.fill(0)
  }

  const bytes = new Uint8Array(plaintext)
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 1 ||
      typeof (decoded as { seedPhrase?: unknown }).seedPhrase !== 'string'
    ) {
      throw new Error('INVALID_CREDENTIAL')
    }
    const mnemonic = (decoded as { seedPhrase: string }).seedPhrase
    const wordCount = mnemonic.split(' ').length
    if ((wordCount !== 12 && wordCount !== 24) || !validateMnemonic(mnemonic, wordlist)) {
      throw new Error('INVALID_CREDENTIAL')
    }
    return mnemonic
  } finally {
    bytes.fill(0)
  }
}

async function seal(request: SealRequest): Promise<readonly EncryptedCredentialCapsule[]> {
  const capsules: EncryptedCredentialCapsule[] = []
  for (const credential of request.credentials) {
    if (!credential.zcashEnvelope) continue
    const mnemonic = await decryptMnemonic(credential.zcashEnvelope, request.password)
    const plaintext = encoder.encode(JSON.stringify({ mnemonic }))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const aad = capsuleAad(
      request.globalUnlockEpoch,
      credential.keyDomainId,
      credential.credentialGenerationId
    )
    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: aad as BufferSource
        },
        request.masterKey,
        plaintext
      )
      capsules.push(
        Object.freeze({
          schemaVersion: CREDENTIAL_CAPSULE_SCHEMA_VERSION,
          keyDomainId: credential.keyDomainId,
          credentialGenerationId: credential.credentialGenerationId,
          iv,
          ciphertext: new Uint8Array(ciphertext)
        })
      )
    } finally {
      plaintext.fill(0)
      aad.fill(0)
    }
  }
  return Object.freeze(capsules)
}

const scope = globalThis as unknown as DedicatedWorkerScope
let handled = false
scope.addEventListener('message', event => {
  if (handled) return
  handled = true
  const request = event.data as CapsuleWorkerRequest
  void seal(request)
    .then(result => scope.postMessage({ id: request.id, result }))
    .catch(error =>
      scope.postMessage({
        id: typeof request?.id === 'string' ? request.id : '',
        error:
          error instanceof Error && error.message === 'INVALID_CREDENTIAL'
            ? 'INVALID_CREDENTIAL'
            : 'CAPSULE_FAILURE'
      })
    )
    .finally(() => scope.close())
})
