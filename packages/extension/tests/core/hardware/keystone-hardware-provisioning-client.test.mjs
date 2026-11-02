import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createMultiAccountsHardwareCredential } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { createKeystoneHardwareProvisioningClient } from '../../../src/popup/services/hardware-provisioning-client.ts'

const credential = createMultiAccountsHardwareCredential({
  type: 'multi-accounts',
  masterFingerprintHex: '12345678',
  keys: [
    {
      publicKeyHex: `02${'11'.repeat(32)}`,
      chainCodeHex: '22'.repeat(32),
      derivationPath: "m/44'/60'/0'",
      sourceFingerprintHex: '12345678'
    }
  ],
  device: 'Keystone 3 Pro'
})

test.describe('Keystone hardware provisioning client', () => {
  test('sends the exact parsed credential and accepts a bounded result', async () => {
    const messages = []
    const client = createKeystoneHardwareProvisioningClient(async message => {
      messages.push(message)
      return {
        success: true,
        result: {
          status: 'committed',
          generationId: 'generation-1',
          transactionId: 'transaction-1',
          keyDomainId: 'wallet-1',
          accountIds: ['account-1']
        }
      }
    })

    await expect(
      client.provision({
        credential,
        displayName: 'Keystone',
        password: 'password',
        birthdayHeight: 2_000_000
      })
    ).resolves.toMatchObject({ status: 'committed', keyDomainId: 'wallet-1' })
    expect(messages).toEqual([
      {
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential,
        displayName: 'Keystone',
        password: 'password',
        birthdayHeight: 2_000_000
      }
    ])
  })

  test('omits an existing session password and rejects malformed or error responses', async () => {
    const messages = []
    const client = createKeystoneHardwareProvisioningClient(async message => {
      messages.push(message)
      return { error: 'Wallet is locked. Please unlock and try again.' }
    })
    await expect(client.provision({ credential, displayName: 'Keystone' })).rejects.toThrow(
      'Wallet is locked'
    )
    expect(messages[0]).not.toHaveProperty('password')

    const malformed = createKeystoneHardwareProvisioningClient(async () => ({
      success: true,
      result: { status: 'committed', accountIds: [] }
    }))
    await expect(malformed.provision({ credential, displayName: 'Keystone' })).rejects.toThrow(
      'invalid result'
    )
  })
})
