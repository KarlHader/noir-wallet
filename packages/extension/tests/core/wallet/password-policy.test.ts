import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  assertNewPassword,
  getNewPasswordValidationError,
  getPasswordCharacterCount,
  isNewPasswordValid
} from '../../../src/core/wallet/password-policy'
import { SecureStorage } from '../../../src/core/wallet/secure-storage'

test.describe('Password policy', () => {
  test('requires 8–64 Unicode characters only for new passwords', () => {
    expect(isNewPasswordValid('1234567')).toBe(false)
    expect(getNewPasswordValidationError('1234567')).toBe('Password must be at least 8 characters')
    expect(isNewPasswordValid('12345678')).toBe(true)
    expect(isNewPasswordValid('a'.repeat(64))).toBe(true)
    expect(getNewPasswordValidationError('a'.repeat(65))).toBe(
      'Password must be no more than 64 characters'
    )
  })

  test('counts Unicode code points without trimming, normalization, or composition rules', () => {
    expect(getPasswordCharacterCount('🔐'.repeat(8))).toBe(8)
    expect(isNewPasswordValid('🔐'.repeat(8))).toBe(true)
    expect(isNewPasswordValid(' '.repeat(8))).toBe(false)
    expect(isNewPasswordValid('  pass  ')).toBe(true)
    expect(() => assertNewPassword('short')).toThrow('Password must be at least 8 characters')
  })

  test('keeps existing V1 password bytes outside the new-password range compatible', async () => {
    const legacyPassword = `  ${'\u65e7🔐'.repeat(100)}  `
    expect(getPasswordCharacterCount(legacyPassword)).toBeGreaterThan(64)

    const encrypted = await SecureStorage.encrypt('legacy-wallet-secret', legacyPassword)
    await expect(SecureStorage.decrypt(encrypted, legacyPassword)).resolves.toBe(
      'legacy-wallet-secret'
    )
    await expect(SecureStorage.decrypt(encrypted, legacyPassword.trim())).rejects.toThrow()
  })
})
