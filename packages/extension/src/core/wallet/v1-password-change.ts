import { SecureStorage } from './secure-storage'

interface V1EncryptedValue {
  readonly encryptedData: string
  readonly salt: string
  readonly iv: string
}

export interface V1PlaintextCredential {
  readonly storageKey: string
  readonly plaintext: string
}

export interface V1PasswordChangeStorage {
  readonly read: (keys: readonly string[]) => Promise<Readonly<Record<string, unknown>>>
  readonly encrypt: (plaintext: string, password: string) => Promise<V1EncryptedValue>
  readonly decrypt: (value: V1EncryptedValue, password: string) => Promise<string>
  readonly write: (values: Readonly<Record<string, unknown>>) => Promise<void>
}

const chromeV1PasswordChangeStorage: V1PasswordChangeStorage = Object.freeze({
  read: (keys: readonly string[]) => chrome.storage.local.get([...keys]),
  encrypt: (plaintext: string, password: string) => SecureStorage.encrypt(plaintext, password),
  decrypt: (value: V1EncryptedValue, password: string) => SecureStorage.decrypt(value, password),
  write: (values: Readonly<Record<string, unknown>>) => chrome.storage.local.set(values)
})

function assertCredentials(credentials: readonly V1PlaintextCredential[]): void {
  if (credentials.length === 0) throw new Error('No V1 credentials to replace')
  const keys = new Set<string>()
  for (const credential of credentials) {
    if (
      credential.storageKey.length === 0 ||
      credential.storageKey.trim() !== credential.storageKey ||
      credential.plaintext.length === 0 ||
      keys.has(credential.storageKey)
    ) {
      throw new Error('Invalid V1 password change credential inventory')
    }
    keys.add(credential.storageKey)
  }
}

async function verifyCredentials(
  credentials: readonly V1PlaintextCredential[],
  values: Readonly<Record<string, unknown>>,
  password: string,
  storage: V1PasswordChangeStorage
): Promise<void> {
  for (const credential of credentials) {
    const value = values[credential.storageKey] as V1EncryptedValue | undefined
    if (!value || (await storage.decrypt(value, password)) !== credential.plaintext) {
      throw new Error('V1 credential verification failed')
    }
  }
}

export async function replaceV1CredentialPassword(
  credentials: readonly V1PlaintextCredential[],
  currentPassword: string,
  newPassword: string,
  storage: V1PasswordChangeStorage = chromeV1PasswordChangeStorage
): Promise<void> {
  assertCredentials(credentials)
  const keys = credentials.map(credential => credential.storageKey)
  const previous = await storage.read(keys)
  await verifyCredentials(credentials, previous, currentPassword, storage)

  const replacement = Object.fromEntries(
    await Promise.all(
      credentials.map(async credential => [
        credential.storageKey,
        await storage.encrypt(credential.plaintext, newPassword)
      ])
    )
  )

  try {
    await storage.write(replacement)
    const persisted = await storage.read(keys)
    await verifyCredentials(credentials, persisted, newPassword, storage)
  } catch {
    try {
      await storage.write(previous)
      const restored = await storage.read(keys)
      await verifyCredentials(credentials, restored, currentPassword, storage)
    } catch {
      throw new Error('V1 password change rollback verification failed')
    }
    throw new Error('V1 password change failed')
  }
}
