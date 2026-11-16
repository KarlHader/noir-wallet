import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatWalletName, formatWalletNameAtIndex } from '../../../src/lib/format.ts'

test('formats timestamp-backed default wallet keys as stable ordinal names', () => {
  const wallets = [
    { id: 'wallet-1', name: 'Wallet 1787031492044' },
    { id: 'wallet-2', name: 'Savings' },
    { id: 'wallet-3', name: 'Wallet 1787579821255' }
  ]

  expect(formatWalletName(wallets[0], wallets)).toBe('Wallet 1')
  expect(formatWalletName(wallets[1], wallets)).toBe('Savings')
  expect(formatWalletName(wallets[2], wallets)).toBe('Wallet 3')
  expect(formatWalletNameAtIndex('Wallet 12', 3)).toBe('Wallet 12')
  expect(formatWalletNameAtIndex('Wallet 1787031492044', -1)).toBe('Wallet 1787031492044')
})
