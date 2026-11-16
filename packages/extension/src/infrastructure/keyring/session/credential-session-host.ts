import {
  KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseKeyringSessionDescriptor,
  parseOffscreenInstanceId,
  parseSessionKeyDomainId,
  type KeyringSessionDescriptor
} from '@/core/keyring/ports'
import type { RawEncryptedVault } from '../multichain/raw-wallet-engine'
import {
  parseCredentialSessionUnlockInput,
  type CredentialSessionUnlockCredential,
  type CredentialSessionUnlockInput,
  type EncryptedCredentialCapsule
} from './credential-session-protocol'

export interface CredentialCapsulePort {
  seal(
    masterKey: CryptoKey,
    globalUnlockEpoch: string,
    password: string,
    credentials: readonly CredentialSessionUnlockCredential[]
  ): Promise<readonly EncryptedCredentialCapsule[]>
}

export interface ZcashCredentialSessionPort {
  bind(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
    readonly masterKey: CryptoKey
    readonly capsule: EncryptedCredentialCapsule
  }): Promise<void>
  getState(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
  }): Promise<'locked' | 'unlocked'>
  lockAll(globalUnlockEpoch: string): Promise<void>
  forceRestart(): void
}

export interface MultichainCredentialSessionPort {
  unlock(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
    readonly vault: RawEncryptedVault
    readonly password: string
  }): Promise<void>
  getState(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
  }): Promise<'locked' | 'unlocked'>
  lockAll(globalUnlockEpoch: string): Promise<void>
  forceRestart(): void
}

export interface CredentialSessionHostOptions {
  readonly capsules: CredentialCapsulePort
  readonly multichain: MultichainCredentialSessionPort
  readonly zcash: ZcashCredentialSessionPort
  readonly now?: () => number
  readonly createId?: () => string
}

interface ProvisioningPasswordCapsule {
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

const credentialSessionEncoder = new TextEncoder()
const credentialSessionDecoder = new TextDecoder('utf-8', { fatal: true })

function descriptorsMatch(
  expected: KeyringSessionDescriptor,
  actual: KeyringSessionDescriptor
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual)
}

function descriptorsHaveSameSessionIdentity(
  expected: KeyringSessionDescriptor,
  actual: KeyringSessionDescriptor
): boolean {
  return (
    expected.schemaVersion === actual.schemaVersion &&
    expected.globalUnlockEpoch === actual.globalUnlockEpoch &&
    expected.offscreenInstanceId === actual.offscreenInstanceId &&
    expected.startedAt === actual.startedAt &&
    JSON.stringify(expected.unlockedCredentials) === JSON.stringify(actual.unlockedCredentials)
  )
}

function isRecoverablePersistedDescriptor(
  expected: KeyringSessionDescriptor,
  actual: KeyringSessionDescriptor
): boolean {
  if (!descriptorsHaveSameSessionIdentity(expected, actual)) return false
  if (expected.lastUserActivityAt > actual.lastUserActivityAt) return false
  if (expected.expiresAt === undefined) return actual.expiresAt === undefined
  return actual.expiresAt !== undefined && expected.expiresAt <= actual.expiresAt
}

export class CredentialSessionHost {
  readonly offscreenInstanceId
  private readonly now: () => number
  private readonly createId: () => string
  private masterKey: CryptoKey | null = null
  private descriptor: KeyringSessionDescriptor | null = null
  private capsules = new Map<string, EncryptedCredentialCapsule>()
  private provisioningPasswordCapsule: ProvisioningPasswordCapsule | null = null
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly options: CredentialSessionHostOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.offscreenInstanceId = parseOffscreenInstanceId(`offscreen-instance:${this.createId()}`)
  }

  unlock(input: unknown): Promise<KeyringSessionDescriptor> {
    return this.enqueue(() => this.unlockInternal(parseCredentialSessionUnlockInput(input)))
  }

  attest(expected: unknown): Promise<KeyringSessionDescriptor> {
    return this.enqueue(async () => {
      const descriptor = parseKeyringSessionDescriptor(expected)
      const active = this.requireActiveSession()
      // A Service Worker may be terminated after Offscreen commits a `touch`
      // but before the refreshed descriptor reaches chrome.storage.session.
      // Reconcile only that monotonic activity advance for the exact same
      // session identity; all epoch, instance and credential changes fail shut.
      if (
        !descriptorsMatch(descriptor, active) &&
        !isRecoverablePersistedDescriptor(descriptor, active)
      ) {
        await this.lockInternal()
        throw new Error('Credential session attestation mismatch')
      }
      if (active.expiresAt !== undefined && active.expiresAt <= this.now()) {
        await this.lockInternal()
        throw new Error('Credential session expired')
      }
      for (const credential of active.unlockedCredentials) {
        const state = await this.options.multichain.getState({
          keyDomainId: credential.keyDomainId,
          credentialGenerationId: credential.credentialGenerationId,
          globalUnlockEpoch: active.globalUnlockEpoch
        })
        if (state !== 'unlocked') {
          await this.lockInternal()
          throw new Error('Credential session Worker attestation failed')
        }
      }
      return active
    })
  }

  touch(input: {
    readonly expected: unknown
    readonly lastUserActivityAt: unknown
    readonly expiresAt?: unknown
  }): Promise<KeyringSessionDescriptor> {
    return this.enqueue(async () => {
      const expected = parseKeyringSessionDescriptor(input.expected)
      const active = this.requireActiveSession()
      if (
        !descriptorsMatch(expected, active) &&
        !isRecoverablePersistedDescriptor(expected, active)
      ) {
        await this.lockInternal()
        throw new Error('Credential session attestation mismatch')
      }
      if (active.expiresAt !== undefined && active.expiresAt <= this.now()) {
        await this.lockInternal()
        throw new Error('Credential session expired')
      }
      if (
        !Number.isSafeInteger(input.lastUserActivityAt) ||
        (input.lastUserActivityAt as number) < 0
      ) {
        throw new Error('Invalid credential session activity')
      }
      const lastUserActivityAt = input.lastUserActivityAt as number
      if (lastUserActivityAt < active.startedAt || lastUserActivityAt < active.lastUserActivityAt) {
        throw new Error('Credential session activity regressed')
      }
      const expiresAt = input.expiresAt
      if (
        expiresAt !== undefined &&
        (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= lastUserActivityAt)
      ) {
        throw new Error('Invalid credential session expiry')
      }
      const { expiresAt: _previousExpiry, ...activeWithoutExpiry } = active
      this.descriptor = parseKeyringSessionDescriptor({
        ...activeWithoutExpiry,
        lastUserActivityAt,
        ...(expiresAt === undefined ? {} : { expiresAt })
      })
      return this.descriptor
    })
  }

  bindZcashCredential(expected: unknown, keyDomainId: unknown): Promise<void> {
    return this.enqueue(async () => {
      const descriptor = parseKeyringSessionDescriptor(expected)
      const active = this.requireActiveSession()
      if (!descriptorsMatch(descriptor, active)) {
        await this.lockInternal()
        throw new Error('Credential session attestation mismatch')
      }
      if (active.expiresAt !== undefined && active.expiresAt <= this.now()) {
        await this.lockInternal()
        throw new Error('Credential session expired')
      }
      try {
        const target = active.unlockedCredentials.find(
          item => item.keyDomainId === parseSessionKeyDomainId(keyDomainId)
        )
        if (!target) throw new Error('Credential is not part of the active session')
        const capsule = this.capsules.get(target.keyDomainId)
        if (!capsule || !this.masterKey) throw new Error('Credential session is locked')
        await this.options.zcash.bind({
          keyDomainId: target.keyDomainId,
          credentialGenerationId: target.credentialGenerationId,
          globalUnlockEpoch: active.globalUnlockEpoch,
          masterKey: this.masterKey,
          capsule
        })
        const state = await this.options.zcash.getState({
          keyDomainId: target.keyDomainId,
          credentialGenerationId: target.credentialGenerationId,
          globalUnlockEpoch: active.globalUnlockEpoch
        })
        if (state !== 'unlocked') {
          throw new Error('Zcash credential session attestation failed')
        }
      } catch (error) {
        await this.lockInternal()
        throw error
      }
    })
  }

  getProvisioningPassword(expected: unknown): Promise<string> {
    return this.enqueue(async () => {
      const descriptor = parseKeyringSessionDescriptor(expected)
      const active = this.requireActiveSession()
      if (!descriptorsMatch(descriptor, active)) {
        await this.lockInternal()
        throw new Error('Credential session attestation mismatch')
      }
      if (active.expiresAt !== undefined && active.expiresAt <= this.now()) {
        await this.lockInternal()
        throw new Error('Credential session expired')
      }
      if (!this.masterKey || !this.provisioningPasswordCapsule) {
        await this.lockInternal()
        throw new Error('Credential provisioning session is locked')
      }

      const capsule = this.provisioningPasswordCapsule
      const aad = this.provisioningPasswordAad(active.globalUnlockEpoch)
      let plaintext: Uint8Array | null = null
      try {
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: capsule.iv as BufferSource,
              additionalData: aad as BufferSource
            },
            this.masterKey,
            capsule.ciphertext as BufferSource
          )
        )
        return credentialSessionDecoder.decode(plaintext)
      } catch {
        await this.lockInternal()
        throw new Error('Credential provisioning session is invalid')
      } finally {
        plaintext?.fill(0)
        aad.fill(0)
      }
    })
  }

  lock(): Promise<void> {
    return this.enqueue(() => this.lockInternal())
  }

  invalidateForWorkerRestart(): Promise<void> {
    return this.enqueue(async () => {
      this.masterKey = null
      this.capsules.clear()
      this.clearProvisioningPasswordCapsule()
      this.descriptor = null
      this.options.multichain.forceRestart()
      this.options.zcash.forceRestart()
    })
  }

  private async unlockInternal(
    input: CredentialSessionUnlockInput
  ): Promise<KeyringSessionDescriptor> {
    await this.lockInternal()
    const masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ])
    const globalUnlockEpoch = parseGlobalUnlockEpoch(`global-unlock:${this.createId()}`)
    let provisioningPasswordCapsule: ProvisioningPasswordCapsule | null = null
    try {
      const capsules = await this.options.capsules.seal(
        masterKey,
        globalUnlockEpoch,
        input.password,
        input.credentials
      )
      provisioningPasswordCapsule = await this.sealProvisioningPassword(
        masterKey,
        globalUnlockEpoch,
        input.password
      )
      if (capsules.length !== input.credentials.filter(item => item.zcashEnvelope).length) {
        throw new Error('Credential capsule inventory is incomplete')
      }
      const capsuleMap = new Map(capsules.map(capsule => [capsule.keyDomainId, capsule]))
      for (const credential of input.credentials) {
        const capsule = capsuleMap.get(credential.keyDomainId)
        if (
          credential.zcashEnvelope &&
          (!capsule || capsule.credentialGenerationId !== credential.credentialGenerationId)
        ) {
          throw new Error('Credential capsule binding mismatch')
        }
        await this.options.multichain.unlock({
          keyDomainId: credential.keyDomainId,
          credentialGenerationId: credential.credentialGenerationId,
          globalUnlockEpoch,
          vault: credential.multichainVault,
          password: input.password
        })
      }
      const startedAt = this.now()
      const descriptor = parseKeyringSessionDescriptor({
        schemaVersion: KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION,
        globalUnlockEpoch,
        offscreenInstanceId: this.offscreenInstanceId,
        unlockedCredentials: input.credentials.map(credential => ({
          keyDomainId: parseSessionKeyDomainId(credential.keyDomainId),
          credentialGenerationId: parseCredentialGenerationId(credential.credentialGenerationId)
        })),
        startedAt,
        lastUserActivityAt: Math.max(startedAt, input.lastUserActivityAt),
        ...(input.expiresAt === undefined
          ? {}
          : {
              expiresAt:
                Math.max(startedAt, input.lastUserActivityAt) +
                (input.expiresAt - input.lastUserActivityAt)
            })
      })
      this.masterKey = masterKey
      this.capsules = capsuleMap
      this.provisioningPasswordCapsule = provisioningPasswordCapsule
      provisioningPasswordCapsule = null
      this.descriptor = descriptor
      return descriptor
    } catch (error) {
      this.masterKey = null
      this.capsules.clear()
      provisioningPasswordCapsule?.iv.fill(0)
      provisioningPasswordCapsule?.ciphertext.fill(0)
      this.clearProvisioningPasswordCapsule()
      this.descriptor = null
      this.options.multichain.forceRestart()
      this.options.zcash.forceRestart()
      throw error
    }
  }

  private requireActiveSession(): KeyringSessionDescriptor {
    if (!this.masterKey || !this.descriptor || !this.provisioningPasswordCapsule) {
      throw new Error('Credential session is locked')
    }
    return this.descriptor
  }

  private async lockInternal(): Promise<void> {
    const epoch = this.descriptor?.globalUnlockEpoch
    this.masterKey = null
    this.capsules.clear()
    this.clearProvisioningPasswordCapsule()
    this.descriptor = null
    if (epoch) {
      const [multichain, zcash] = await Promise.allSettled([
        this.options.multichain.lockAll(epoch),
        this.options.zcash.lockAll(epoch)
      ])
      if (multichain.status === 'rejected') this.options.multichain.forceRestart()
      if (zcash.status === 'rejected') this.options.zcash.forceRestart()
    }
  }

  private provisioningPasswordAad(globalUnlockEpoch: string): Uint8Array {
    return credentialSessionEncoder.encode(
      JSON.stringify({
        purpose: 'credential-provisioning-password-v1',
        offscreenInstanceId: this.offscreenInstanceId,
        globalUnlockEpoch
      })
    )
  }

  private async sealProvisioningPassword(
    masterKey: CryptoKey,
    globalUnlockEpoch: string,
    password: string
  ): Promise<ProvisioningPasswordCapsule> {
    const plaintext = credentialSessionEncoder.encode(password)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const aad = this.provisioningPasswordAad(globalUnlockEpoch)
    try {
      return Object.freeze({
        iv,
        ciphertext: new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: iv as BufferSource,
              additionalData: aad as BufferSource
            },
            masterKey,
            plaintext as BufferSource
          )
        )
      })
    } finally {
      plaintext.fill(0)
      aad.fill(0)
    }
  }

  private clearProvisioningPasswordCapsule(): void {
    this.provisioningPasswordCapsule?.iv.fill(0)
    this.provisioningPasswordCapsule?.ciphertext.fill(0)
    this.provisioningPasswordCapsule = null
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.catch(() => {}).then(operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
