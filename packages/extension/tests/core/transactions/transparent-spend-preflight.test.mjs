import { test } from 'node:test'
import { expect } from '@playwright/test'
import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'
import {
  prepareTransparentSpend,
  TRANSPARENT_FUNDS_NOT_READY_MESSAGE,
  usesPendingTransparentFunds
} from '../../../src/core/wallet/transparent-spend-preflight.ts'

const balance = mapWasmAccountBalanceToZcashBalance({
  unshielded_balance: 3_000_000,
  unshielded_pending_balance: 2_000_000,
  unshielded_total_balance: 5_000_000
})

test('transparent preflight distinguishes confirmed, pending, and insufficient amounts', () => {
  expect(usesPendingTransparentFunds('0.03', balance)).toBe(false)
  expect(usesPendingTransparentFunds('0.04', balance)).toBe(true)
  expect(usesPendingTransparentFunds('0.06', balance)).toBe(false)
})

test('transparent preflight refreshes UTXOs before checking the current balance', async () => {
  const calls = []
  const core = {
    async syncSessionSetup() {
      calls.push('refresh')
    },
    async getBalance() {
      calls.push('balance')
      return balance
    }
  }

  await expect(prepareTransparentSpend(core, '0.04')).rejects.toThrow(
    TRANSPARENT_FUNDS_NOT_READY_MESSAGE
  )
  expect(calls).toEqual(['refresh', 'balance'])
  await expect(prepareTransparentSpend(core, '0.03')).resolves.toEqual(balance)
})
