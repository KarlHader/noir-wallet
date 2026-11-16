import { test } from 'node:test'
import { expect } from '@playwright/test'

import { zcashWalletRuntimeClient } from '../../../../src/popup/services/zcash-wallet-runtime-client.ts'

test.describe('Zcash wallet Background client', () => {
  test('uses the authoritative Background unlock result without a page-local unlock', async () => {
    const messages = []
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async message => {
          messages.push(message)
          return { success: true, remainingAttempts: 5 }
        }
      }
    }

    try {
      await expect(zcashWalletRuntimeClient.unlock('test-password')).resolves.toEqual({
        success: true,
        remainingAttempts: 5
      })
      expect(messages).toEqual([{ type: 'WALLET_UNLOCK', password: 'test-password' }])
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('passes exact transfer parameters and validates the estimate response', async () => {
    const messages = []
    const feeQuote = {
      id: 'quote-1',
      standardMarginalFeeZats: 5000,
      expiresAt: Date.now() + 60_000
    }
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async message => {
          messages.push(message)
          return {
            success: true,
            maxAmountZats: '1000',
            feeZats: '500',
            marginalFeeZats: '5000',
            feeQuote
          }
        }
      }
    }

    try {
      await expect(
        zcashWalletRuntimeClient.estimateMaxTransfer({
          to: 'u1destination',
          memo: 'Swap ZEC → ETH',
          marginalFeeZats: 5000,
          feeQuoteId: feeQuote.id,
          fundingSource: 'transparent'
        })
      ).resolves.toEqual({
        maxAmountZats: '1000',
        feeZats: '500',
        marginalFeeZats: '5000',
        feeQuote
      })
      expect(messages).toEqual([
        {
          type: 'ESTIMATE_ZCASH_MAX_TRANSFER',
          to: 'u1destination',
          memo: 'Swap ZEC → ETH',
          marginalFeeZats: 5000,
          feeQuoteId: feeQuote.id,
          fundingSource: 'transparent'
        }
      ])
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('provisions primary imports through one bounded Background request', async () => {
    const messages = []
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async message => {
          messages.push(message)
          return { success: true }
        }
      }
    }

    try {
      await zcashWalletRuntimeClient.provisionPrimarySoftwareWallet({
        mode: 'import',
        mnemonic: 'abandon '.repeat(11) + 'about',
        password: 'test-password',
        accountName: 'Trading',
        birthdayHeight: 2_000_000
      })
      expect(messages).toEqual([
        {
          type: 'PROVISION_PRIMARY_SOFTWARE_WALLET',
          mode: 'import',
          mnemonic: 'abandon '.repeat(11) + 'about',
          password: 'test-password',
          accountName: 'Trading',
          birthdayHeight: 2_000_000
        }
      ])
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('rejects an address preview that omits a requested network', async () => {
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => ({
          success: true,
          addresses: [
            { family: 'evm', chainId: 'eip155:1', address: '0x123' },
            { family: 'evm', chainId: 'eip155:1', address: '0x123' }
          ]
        })
      }
    }
    try {
      await expect(
        zcashWalletRuntimeClient.previewSoftwareWalletAddresses({
          mnemonic: `${'abandon '.repeat(11)}about`,
          selectedNetworkFamilies: ['zcash', 'evm']
        })
      ).rejects.toThrow(/invalid address previews/)
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('rejects malformed or failed Background responses', async () => {
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => ({ success: true, maxAmountZats: 1, feeZats: '500' })
      }
    }

    try {
      await expect(
        zcashWalletRuntimeClient.estimateMaxTransfer({
          to: 'u1destination',
          marginalFeeZats: 5000
        })
      ).rejects.toThrow(/invalid maximum amount/i)

      globalThis.chrome.runtime.sendMessage = async () => ({ error: 'Wallet is locked' })
      await expect(zcashWalletRuntimeClient.getSeedPhrase('wrong-password')).rejects.toThrow(
        'Wallet is locked'
      )
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('distinguishes invalid passwords and startup failures from a blocking upgrade failure', async () => {
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => ({
          success: false,
          error: 'Invalid password',
          remainingAttempts: 4
        })
      }
    }

    try {
      await expect(zcashWalletRuntimeClient.unlock('wrong-password')).resolves.toEqual({
        success: false,
        remainingAttempts: 4
      })

      globalThis.chrome.runtime.sendMessage = async () => ({
        error: 'Wallet network initialization failed',
        failure: 'network_initialization_failed'
      })
      await expect(zcashWalletRuntimeClient.unlock('correct-password')).resolves.toEqual({
        success: false,
        failure: 'operation_failed'
      })

      globalThis.chrome.runtime.sendMessage = async () => ({
        error: 'Credential compatibility migration failed'
      })
      await expect(zcashWalletRuntimeClient.unlock('correct-password')).resolves.toEqual({
        success: false,
        upgradeFailed: true
      })
    } finally {
      globalThis.chrome = originalChrome
    }
  })
})
