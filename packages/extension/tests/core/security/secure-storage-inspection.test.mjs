import { test } from 'node:test'
import { expect } from '@playwright/test'
import { SecureStorage } from '../../../src/core/wallet/secure-storage.ts'

test('classifies missing, malformed, and failed authentication without hiding key derivation errors', async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const originalDeriveKey = SecureStorage.deriveKey
  const stored = await SecureStorage.encrypt(
    JSON.stringify({ seedPhrase: 'public test phrase' }),
    'correct'
  )
  let value = stored
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { storage: { local: { get: async () => ({ credential: value }) } } }
  })
  try {
    await expect(
      SecureStorage.inspectEncryptedCredential('credential', 'correct')
    ).resolves.toEqual({
      status: 'valid',
      data: { seedPhrase: 'public test phrase' }
    })
    await expect(
      SecureStorage.inspectEncryptedCredential('credential', 'incorrect')
    ).resolves.toEqual({
      status: 'wrong_password'
    })
    value = null
    await expect(
      SecureStorage.inspectEncryptedCredential('credential', 'correct')
    ).resolves.toEqual({
      status: 'missing'
    })
    value = { ...stored, iv: 'bad' }
    await expect(
      SecureStorage.inspectEncryptedCredential('credential', 'correct')
    ).resolves.toEqual({
      status: 'invalid'
    })
    value = stored
    SecureStorage.deriveKey = async () => {
      throw new Error('KDF unavailable')
    }
    await expect(SecureStorage.inspectEncryptedCredential('credential', 'correct')).rejects.toThrow(
      'KDF unavailable'
    )
  } finally {
    SecureStorage.deriveKey = originalDeriveKey
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  }
})
