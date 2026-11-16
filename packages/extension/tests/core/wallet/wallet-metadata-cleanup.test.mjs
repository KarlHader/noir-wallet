import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  removeAccountMetadata,
  removeWalletMetadata
} from '../../../src/core/wallet/wallet-metadata-cleanup.ts'

function account(id, derivationIndex) {
  return {
    id,
    name: id,
    addresses: {
      transparent: `t-${id}`,
      shielded: `u-${id}`,
      fullUnified: `u-full-${id}`
    },
    derivationIndex,
    birthdayHeight: 3_000_000,
    isPinned: false,
    isHidden: false
  }
}

function wallet(id, accounts) {
  return {
    id,
    name: id,
    seedPhraseKey: `seed_${id}`,
    accounts,
    createdAt: 1_700_000_000_000,
    isPinned: false
  }
}

test.describe('wallet metadata cleanup', () => {
  test('removes one account, its display name, and advances the active pointer', () => {
    const result = removeAccountMetadata(
      {
        wallets: [wallet('wallet-1', [account('account-1', 0), account('account-2', 1)])],
        currentWalletId: 'wallet-1',
        currentAccountId: 'account-1',
        accountDisplayNames: {
          'wallet-1_account-1': 'Primary',
          'wallet-1_account-2': 'Secondary'
        }
      },
      'wallet-1',
      'account-1'
    )

    expect(result.wallets[0].accounts.map(item => item.id)).toEqual(['account-2'])
    expect(result.currentWalletId).toBe('wallet-1')
    expect(result.currentAccountId).toBe('account-2')
    expect(result.accountDisplayNames).toEqual({
      'wallet-1_account-2': 'Secondary'
    })
  })

  test('removing a non-current account preserves active pointers', () => {
    const source = {
      wallets: [wallet('wallet-1', [account('account-1', 0), account('account-2', 1)])],
      currentWalletId: 'wallet-1',
      currentAccountId: 'account-1',
      accountDisplayNames: {}
    }
    const result = removeAccountMetadata(source, 'wallet-1', 'account-2')

    expect(result.currentWalletId).toBe('wallet-1')
    expect(result.currentAccountId).toBe('account-1')
    expect(source.wallets[0].accounts).toHaveLength(2)
  })

  test('removing the active wallet selects the first remaining account', () => {
    const result = removeWalletMetadata(
      {
        wallets: [
          wallet('wallet-1', [account('account-1', 0)]),
          wallet('wallet-2', [account('account-2', 0)])
        ],
        currentWalletId: 'wallet-1',
        currentAccountId: 'account-1',
        accountDisplayNames: {
          'wallet-1_account-1': 'Removed',
          'wallet-2_account-2': 'Kept'
        }
      },
      'wallet-1'
    )

    expect(result.wallets.map(item => item.id)).toEqual(['wallet-2'])
    expect(result.currentWalletId).toBe('wallet-2')
    expect(result.currentAccountId).toBe('account-2')
    expect(result.accountDisplayNames).toEqual({
      'wallet-2_account-2': 'Kept'
    })
  })
})
