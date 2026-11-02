import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createNativeHardwareWalletClient,
  NativeHardwareWalletClientError
} from '../../../src/popup/services/native-hardware-wallet-client.ts'

test.describe('Native hardware Wallet Popup client', () => {
  test('renames and removes through exact trusted runtime messages', async () => {
    const messages = []
    const client = createNativeHardwareWalletClient(async message => {
      messages.push(message)
      return message.type === 'RENAME_WALLET'
        ? {
            success: true,
            result: {
              status: 'renamed',
              generationId: `storage-v2:wallet-metadata:${'a'.repeat(64)}`
            }
          }
        : { success: true }
    })

    await expect(client.renameWallet('wallet:one', 'Daily Hardware')).resolves.toEqual({
      status: 'renamed',
      generationId: `storage-v2:wallet-metadata:${'a'.repeat(64)}`
    })
    await expect(client.removeWallet('wallet:one')).resolves.toBeUndefined()
    expect(messages).toEqual([
      { type: 'RENAME_WALLET', walletId: 'wallet:one', displayName: 'Daily Hardware' },
      { type: 'REMOVE_WALLET', walletId: 'wallet:one' }
    ])
  })

  test('rejects malformed, failed, and over-broad responses', async () => {
    for (const response of [
      null,
      { success: true, result: { status: 'renamed', generationId: 'invalid' } },
      {
        success: true,
        result: {
          status: 'renamed',
          generationId: `storage-v2:wallet-metadata:${'a'.repeat(64)}`,
          password: 'must-not-cross-runtime'
        }
      },
      { error: 'Wallet is locked' }
    ]) {
      const client = createNativeHardwareWalletClient(async () => response)
      await expect(client.renameWallet('wallet:one', 'Daily Hardware')).rejects.toBeInstanceOf(
        NativeHardwareWalletClientError
      )
    }

    await expect(
      createNativeHardwareWalletClient(async () => ({ success: true, removed: true })).removeWallet(
        'wallet:one'
      )
    ).rejects.toBeInstanceOf(NativeHardwareWalletClientError)
  })
})
