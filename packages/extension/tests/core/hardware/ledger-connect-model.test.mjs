import { test } from 'node:test'
import { expect } from '@playwright/test'
import { parseLedgerAccountIndex } from '../../../src/popup/pages/hardware/ledger-connect-model.ts'
import { nextHardwareWalletName } from '../../../src/lib/hardware-connect-options.ts'

test('accepts only canonical nonnegative ZIP-32 account indexes', () => {
  expect(parseLedgerAccountIndex('0')).toBe(0)
  expect(parseLedgerAccountIndex('2147483647')).toBe(2147483647)
  for (const value of ['-1', '01', '1.5', '2147483648', '', ' 1']) {
    expect(parseLedgerAccountIndex(value)).toBeNull()
  }
})

test('new hardware wallet names advance per vendor and avoid existing names', () => {
  const account = (walletId, walletDisplayName, vendor) => ({
    walletId,
    walletDisplayName,
    walletSource: vendor ? { kind: 'hardware', hardware: { vendor } } : { kind: 'software' }
  })
  const accounts = [
    account('ledger-a', 'Ledger Wallet 1', 'ledger'),
    account('ledger-a', 'Ledger Wallet 1', 'ledger'),
    account('ledger-b', 'Ledger Wallet 3', 'ledger'),
    account('keystone-a', 'Keystone Wallet 2', 'keystone'),
    account('software-a', 'Keystone Wallet 3')
  ]
  expect(nextHardwareWalletName('ledger', accounts)).toBe('Ledger Wallet 4')
  expect(nextHardwareWalletName('keystone', accounts)).toBe('Keystone Wallet 4')
  expect(nextHardwareWalletName('ledger', [])).toBe('Ledger Wallet 1')
})
