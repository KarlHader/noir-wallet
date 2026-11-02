import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveEffectiveActiveAccountIdentity } from '../../../src/popup/lib/effective-active-account'

test('prefers the persisted wallet pointer while a native account catalog is stale', () => {
  assert.deepEqual(
    resolveEffectiveActiveAccountIdentity({
      currentWalletId: 'wallet-current',
      currentAccountId: 'account-current',
      nativeAccount: {
        walletId: 'wallet-stale',
        accountId: 'account-stale'
      }
    }),
    { walletId: 'wallet-current', accountId: 'account-current' }
  )
})

test('falls back to the native account for Storage V2-only wallets', () => {
  assert.deepEqual(
    resolveEffectiveActiveAccountIdentity({
      currentWalletId: null,
      currentAccountId: null,
      nativeAccount: {
        walletId: 'wallet-native',
        accountId: 'account-native'
      }
    }),
    { walletId: 'wallet-native', accountId: 'account-native' }
  )
})
