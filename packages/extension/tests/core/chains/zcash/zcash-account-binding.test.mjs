import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ZcashWalletCore } from '../../../../src/core/zcash/wallet-core.ts'

test('restores the selected WASM account before estimating a spend', async () => {
  const previousLocation = globalThis.location
  globalThis.location = { href: 'chrome-extension://test/index.html' }
  try {
    const core = new ZcashWalletCore({
      walletId: 'synthetic-account-binding',
      network: 'mainnet',
      lightwalletdUrl: 'https://example.invalid'
    })
    const estimatedAccountIds = []
    const quotedAccountIds = []
    const submittedAccountIndices = []
    core.client = {
      getAccountIds: async () => [0, 1],
      getAccountHdIndex: async id => id,
      markAccountReady: () => {},
      getFeeQuote: async id => {
        quotedAccountIds.push(id)
        return { id: 'synthetic-quote', standardMarginalFeeZats: 5000, expiresAt: 1 }
      },
      estimateMaxTransfer: async input => {
        estimatedAccountIds.push(input.accountId)
        return { maxAmountZats: '1', feeZats: '1' }
      },
      estimateTransferFee: async input => {
        estimatedAccountIds.push(input.accountId)
        return { feeZats: '1', marginalFeeZats: '5000', feeQuote: {} }
      },
      sendTransaction: async input => {
        submittedAccountIndices.push(input.accountIndex)
        return { txId: 'synthetic-transaction' }
      }
    }

    const assertSelectedSpend = async () => {
      await core.getFeeQuote()
      await core.estimateMaxTransfer('synthetic-recipient', undefined, undefined, 'transparent')
      await core.estimateTransferFee(
        'synthetic-recipient',
        '0.0001',
        undefined,
        undefined,
        'transparent'
      )
      await core.sendTransaction({
        to: 'synthetic-recipient',
        amount: '0.0001',
        fundingSource: 'transparent',
        marginalFeeZats: 5000
      })
    }

    core.accountId = 1
    core.accountIndex = 0
    core.setSessionCredential(0)
    expect(await core.hasAccountForDerivation(0)).toBe(false)
    expect(await core.restoreFromDB(0)).toBe(true)
    expect(await core.hasAccountForDerivation(0)).toBe(true)
    await assertSelectedSpend()

    core.setSessionCredential(1)
    expect(await core.hasAccountForDerivation(1)).toBe(false)
    expect(await core.restoreFromDB(1)).toBe(true)
    await assertSelectedSpend()
    expect(quotedAccountIds).toEqual([0, 1])
    expect(estimatedAccountIds).toEqual([0, 0, 1, 1])
    expect(submittedAccountIndices).toEqual([0, 1])
  } finally {
    globalThis.location = previousLocation
  }
})
