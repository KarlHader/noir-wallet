import { test } from 'node:test'
import { expect } from '@playwright/test'

import { inspectZcashTransparentAccountHistory } from '../../../../src/core/wallet/zcash-account-history.ts'

const input = {
  nodeRpcUrl: 'https://zcash.example',
  transparentAddress: 't1example',
  network: 'mainnet'
}

test.describe('Zcash account history inspection', () => {
  test('detects transparent usage and resolves a safe birthday', async () => {
    const inspection = await inspectZcashTransparentAccountHistory(input, {
      getAddressTxids: async () => ['first-tx', 'second-tx'],
      getVerboseTransaction: async (_url, txid) => ({ txid, height: 500_000 })
    })

    expect(inspection).toEqual({ status: 'used', birthdayHeight: 499_900 })
  })

  test('keeps detected usage when the transaction height is unavailable', async () => {
    const inspection = await inspectZcashTransparentAccountHistory(input, {
      getAddressTxids: async () => ['mempool-tx'],
      getVerboseTransaction: async (_url, txid) => ({ txid })
    })

    expect(inspection).toEqual({ status: 'used', birthdayHeight: null })
  })

  test('does not treat missing transparent history as proof that the account is unused', async () => {
    const inspection = await inspectZcashTransparentAccountHistory(input, {
      getAddressTxids: async () => [],
      getVerboseTransaction: async () => {
        throw new Error('must not be called')
      }
    })

    expect(inspection).toEqual({ status: 'unknown' })
  })

  test('returns unknown when the history service is unavailable', async () => {
    const inspection = await inspectZcashTransparentAccountHistory(input, {
      getAddressTxids: async () => {
        throw new Error('offline')
      },
      getVerboseTransaction: async () => {
        throw new Error('must not be called')
      }
    })

    expect(inspection).toEqual({ status: 'unknown' })
  })

  test('rejects malformed transaction identifiers from the RPC boundary', async () => {
    const inspection = await inspectZcashTransparentAccountHistory(input, {
      getAddressTxids: async () => [null],
      getVerboseTransaction: async () => {
        throw new Error('must not be called')
      }
    })

    expect(inspection).toEqual({ status: 'unknown' })
  })
})
