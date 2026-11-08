import {
  parseKeyringSessionDescriptor,
  parseSessionKeyDomainId,
  type KeyringCommandBinding,
  type KeyringSessionDescriptor
} from '@/core/keyring/ports'
import { WALLET_CONFIG } from '@/config/wallet'
import { forwardKeyringRpcToOffscreen } from '@/core/worker/client'
import { SETTINGS_STORAGE_KEY, resolvePersistedAutoLockMs } from '@/lib/wallet-settings-storage'
import { credentialLifecycle } from './credential-lifecycle'
import { CREDENTIAL_SESSION_DESCRIPTOR_KEY } from '@/core/wallet/credential-session-state'

const MAX_PROVISIONING_PASSWORD_BYTES = 1024 * 1024

function inventoryMatchesDescriptor(
  inventory: readonly Readonly<{ keyDomainId: string; credentialGenerationId: string }>[],
  descriptor: KeyringSessionDescriptor
): boolean {
  return (
    inventory.length === descriptor.unlockedCredentials.length &&
    inventory.every((credential, index) => {
      const unlocked = descriptor.unlockedCredentials[index]
      return (
        unlocked?.keyDomainId === credential.keyDomainId &&
        unlocked.credentialGenerationId === credential.credentialGenerationId
      )
    })
  )
}

function isForwardSessionDescriptor(
  persisted: KeyringSessionDescriptor,
  attested: KeyringSessionDescriptor
): boolean {
  if (
    persisted.schemaVersion !== attested.schemaVersion ||
    persisted.globalUnlockEpoch !== attested.globalUnlockEpoch ||
    persisted.offscreenInstanceId !== attested.offscreenInstanceId ||
    persisted.startedAt !== attested.startedAt ||
    JSON.stringify(persisted.unlockedCredentials) !==
      JSON.stringify(attested.unlockedCredentials) ||
    persisted.lastUserActivityAt > attested.lastUserActivityAt
  ) {
    return false
  }
  if (persisted.expiresAt === undefined) return attested.expiresAt === undefined
  return attested.expiresAt !== undefined && persisted.expiresAt <= attested.expiresAt
}

async function readAutoLockMs(): Promise<number> {
  const settings = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  return resolvePersistedAutoLockMs(
    settings[SETTINGS_STORAGE_KEY],
    WALLET_CONFIG.SECURITY.AUTO_LOCK.DEFAULT_MS,
    WALLET_CONFIG.SECURITY.AUTO_LOCK.OPTIONS.map(option => option.value)
  )
}

export class CredentialSessionCoordinator {
  private operation: Promise<void> = Promise.resolve()

  unlock(
    password: string,
    lastUserActivityAt = Date.now()
  ): Promise<KeyringSessionDescriptor | null> {
    return this.enqueue(async () => {
      const { softwareCredentials: inventory, hardwareCredentialCount } =
        await credentialLifecycle.getActiveCredentialSessionInventory(password)
      if (inventory.length === 0 && hardwareCredentialCount === 0) {
        await chrome.storage.session.remove(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
        await forwardKeyringRpcToOffscreen<boolean>('session.lock', {}).catch(() => {})
        return null
      }
      const autoLockMs = await readAutoLockMs()
      let descriptor: KeyringSessionDescriptor
      try {
        descriptor = parseKeyringSessionDescriptor(
          await forwardKeyringRpcToOffscreen<unknown>('session.unlock', {
            input: {
              password,
              credentials: inventory,
              lastUserActivityAt,
              ...(autoLockMs === 0 ? {} : { expiresAt: lastUserActivityAt + autoLockMs })
            }
          })
        )
        if (!inventoryMatchesDescriptor(inventory, descriptor)) {
          throw new Error('Credential session inventory mismatch')
        }
        // Removing a descriptor signals a lock to every open extension page.
        // Publish a successful renewal by replacing it in one storage operation.
        await chrome.storage.session.set({ [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: descriptor })
        return descriptor
      } catch (error) {
        await forwardKeyringRpcToOffscreen<boolean>('session.lock', {}).catch(() => {})
        await chrome.storage.session.remove(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
        throw error
      }
    })
  }

  bindZcashCredential(keyDomainId: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        const descriptor = await this.attestDescriptor()
        if (!descriptor) return false
        const parsedKeyDomainId = parseSessionKeyDomainId(keyDomainId)
        if (
          !descriptor.unlockedCredentials.some(
            credential => credential.keyDomainId === parsedKeyDomainId
          )
        ) {
          throw new Error('Credential is not unlocked')
        }
        return await forwardKeyringRpcToOffscreen<boolean>('session.bind-zcash', {
          descriptor,
          keyDomainId: parsedKeyDomainId
        })
      } catch {
        await forwardKeyringRpcToOffscreen<boolean>('session.lock', {}).catch(() => {})
        await this.clearPersistedDescriptor()
        return false
      }
    })
  }

  hasUnlockSession(): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        return (await this.attestDescriptor()) !== null
      } catch {
        await this.clearPersistedDescriptor()
        return false
      }
    })
  }

  getUnlockEpoch(): Promise<string | null> {
    return this.enqueue(async () => (await this.attestDescriptor())?.globalUnlockEpoch ?? null)
  }

  getCredentialBinding(
    keyDomainId: string
  ): Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>> {
    return this.enqueue(async () => {
      let descriptor: KeyringSessionDescriptor | null
      try {
        descriptor = await this.attestDescriptor()
      } catch (error) {
        await this.clearPersistedDescriptor()
        throw error
      }
      if (!descriptor) throw new Error('Wallet is locked')
      const parsedKeyDomainId = parseSessionKeyDomainId(keyDomainId)
      const credential = descriptor.unlockedCredentials.find(
        candidate => candidate.keyDomainId === parsedKeyDomainId
      )
      if (!credential) throw new Error('Credential is not unlocked')
      return Object.freeze({
        kind: 'credential' as const,
        keyDomainId: credential.keyDomainId,
        credentialGenerationId: credential.credentialGenerationId,
        globalUnlockEpoch: descriptor.globalUnlockEpoch
      })
    })
  }

  getProvisioningPassword(): Promise<string> {
    return this.enqueue(async () => {
      let descriptor: KeyringSessionDescriptor | null
      try {
        descriptor = await this.attestDescriptor()
      } catch (error) {
        await this.clearPersistedDescriptor()
        throw error
      }
      if (!descriptor) throw new Error('Wallet is locked')

      try {
        const password = await forwardKeyringRpcToOffscreen<unknown>(
          'session.get-provisioning-password',
          { descriptor }
        )
        if (
          typeof password !== 'string' ||
          password.length === 0 ||
          new TextEncoder().encode(password).byteLength > MAX_PROVISIONING_PASSWORD_BYTES
        ) {
          throw new Error('Invalid credential provisioning session response')
        }
        return password
      } catch (error) {
        await this.clearPersistedDescriptor()
        throw error
      }
    })
  }

  touch(lastUserActivityAt: number): Promise<void> {
    return this.enqueue(async () => {
      const descriptor = await this.readDescriptor()
      if (!descriptor || lastUserActivityAt < descriptor.lastUserActivityAt) return
      const autoLockMs = await readAutoLockMs()
      try {
        const updated = parseKeyringSessionDescriptor(
          await forwardKeyringRpcToOffscreen<unknown>('session.touch', {
            descriptor,
            lastUserActivityAt,
            ...(autoLockMs === 0 ? {} : { expiresAt: lastUserActivityAt + autoLockMs })
          })
        )
        await chrome.storage.session.set({ [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: updated })
      } catch {
        await this.clearPersistedDescriptor()
      }
    })
  }

  lock(): Promise<void> {
    return this.enqueue(async () => {
      await chrome.storage.session.remove(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
      await forwardKeyringRpcToOffscreen<boolean>('session.lock', {})
    })
  }

  private async readDescriptor(): Promise<KeyringSessionDescriptor | null> {
    const stored = await chrome.storage.session.get(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
    const value = stored[CREDENTIAL_SESSION_DESCRIPTOR_KEY]
    if (value === undefined) return null
    try {
      return parseKeyringSessionDescriptor(value)
    } catch {
      await chrome.storage.session.remove(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
      return null
    }
  }

  private async attestDescriptor(): Promise<KeyringSessionDescriptor | null> {
    const descriptor = await this.readDescriptor()
    if (!descriptor) return null
    const { softwareCredentials: inventory, hardwareCredentialCount } =
      await credentialLifecycle.getActiveCredentialSessionDescriptorInventory()
    if (
      (inventory.length === 0 && hardwareCredentialCount === 0) ||
      !inventoryMatchesDescriptor(inventory, descriptor)
    ) {
      throw new Error('Credential session inventory mismatch')
    }
    const attested = parseKeyringSessionDescriptor(
      await forwardKeyringRpcToOffscreen<unknown>('session.attest', { descriptor })
    )
    if (
      JSON.stringify(attested) !== JSON.stringify(descriptor) &&
      !isForwardSessionDescriptor(descriptor, attested)
    ) {
      throw new Error('Credential session attestation mismatch')
    }
    if (JSON.stringify(attested) !== JSON.stringify(descriptor)) {
      await chrome.storage.session.set({ [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: attested })
    }
    return attested
  }

  private async clearPersistedDescriptor(): Promise<void> {
    await chrome.storage.session.remove(CREDENTIAL_SESSION_DESCRIPTOR_KEY)
    await forwardKeyringRpcToOffscreen<boolean>('session.lock', {}).catch(() => {})
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

export const credentialSession = new CredentialSessionCoordinator()
