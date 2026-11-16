import { test } from 'node:test'
import { expect } from '@playwright/test'

import { matchesAccountSearch } from '../../../src/lib/account-search.ts'

const account = {
  name: 'Savings',
  walletName: 'Cold Wallet',
  addresses: [{ address: 'u1ShieldedAddress' }, { address: 't1TransparentAddress' }]
}

test.describe('Account list search', () => {
  test('matches account name, wallet name, and either address', () => {
    expect(matchesAccountSearch(account, 'savings')).toBe(true)
    expect(matchesAccountSearch(account, ' COLD WALLET ')).toBe(true)
    expect(matchesAccountSearch(account, 'u1shielded')).toBe(true)
    expect(matchesAccountSearch(account, 'T1TRANSPARENT')).toBe(true)
    expect(matchesAccountSearch(account, 'missing')).toBe(false)
  })
})
