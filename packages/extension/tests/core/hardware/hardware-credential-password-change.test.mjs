import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createZcashHardwareCredential } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { SecureStorage } from '../../../src/core/wallet/secure-storage.ts'
import {
  hardwareCredentialEnvelopeEquals,
  hardwareCredentialMatchesMetadata,
  readHardwareCredentialEnvelope,
  rewrapHardwareCredentialEnvelope
} from '../../../src/infrastructure/keyring/migration/hardware-credential-password-change.ts'

const CURRENT_PASSWORD = 'hardware-current-password'
const NEW_PASSWORD = 'hardware-new-password'
const CREDENTIAL = createZcashHardwareCredential({
  ufvk: 'uview1hardwarepasswordfixture',
  seedFingerprintHex: 'ab'.repeat(32),
  accountHdIndex: 0
})

test.describe('hardware credential password change', () => {
  test('rewraps the exact public hardware export and invalidates the old password', async () => {
    const source = await SecureStorage.encrypt(JSON.stringify(CREDENTIAL), CURRENT_PASSWORD)
    const result = await rewrapHardwareCredentialEnvelope(source, CURRENT_PASSWORD, NEW_PASSWORD)

    expect(result.credential).toEqual(CREDENTIAL)
    expect(hardwareCredentialEnvelopeEquals(result.sourceEnvelope, source)).toBe(true)
    expect(hardwareCredentialEnvelopeEquals(result.sourceEnvelope, result.targetEnvelope)).toBe(
      false
    )
    await expect(
      readHardwareCredentialEnvelope(result.targetEnvelope, NEW_PASSWORD)
    ).resolves.toEqual(CREDENTIAL)
    await expect(
      readHardwareCredentialEnvelope(result.targetEnvelope, CURRENT_PASSWORD)
    ).rejects.toThrow('Hardware credential password is invalid')
  })

  test('rejects wrong current passwords and exact metadata mismatches', async () => {
    const source = await SecureStorage.encrypt(JSON.stringify(CREDENTIAL), CURRENT_PASSWORD)

    await expect(
      rewrapHardwareCredentialEnvelope(source, 'wrong-password', NEW_PASSWORD)
    ).rejects.toThrow('Hardware credential password is invalid')
    expect(
      hardwareCredentialMatchesMetadata(CREDENTIAL, {
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['bitcoin']
      })
    ).toBe(false)
  })
})
