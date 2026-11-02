import { test } from 'node:test'
import { expect } from '@playwright/test'
import { presentDAppPermissions } from '../../../src/popup/services/dapp-connection-presentation.ts'

function connection(overrides = {}) {
  return {
    id: 'dapp-1',
    name: 'Example',
    host: 'dapp.example',
    origin: 'https://dapp.example',
    favicon: '',
    connectedAt: 1,
    lastActiveAt: 1,
    ...overrides
  }
}

test.describe('connected dApp permission presentation', () => {
  test('presents legacy Zcash and exact EVM/Bitcoin authorizations independently', () => {
    expect(
      presentDAppPermissions(
        connection({
          authorizedAccounts: [
            { walletId: 'wallet-1', accountId: 'account-1' },
            { walletId: 'wallet-1', accountId: 'account-2' }
          ],
          chainAuthorizations: [
            {
              chainId: 'eip155:1',
              accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            },
            {
              chainId: 'bip122:000000000019d6689c085ae165831e93',
              accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            }
          ]
        })
      )
    ).toEqual([
      { chainId: 'zcash', label: 'Zcash', iconChain: 'zcash', accountCount: 2 },
      { chainId: 'eip155:1', label: 'Ethereum', iconChain: 'eth', accountCount: 1 },
      {
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        label: 'Bitcoin',
        iconChain: 'bitcoin',
        accountCount: 1
      }
    ])
  })

  test('does not invent a chain permission for an unbound metadata-only connection', () => {
    expect(presentDAppPermissions(connection())).toEqual([])
  })

  test('keeps an exact fallback label when a future authorized EVM chain is not in the catalog', () => {
    expect(
      presentDAppPermissions(
        connection({
          chainAuthorizations: [
            {
              chainId: 'eip155:999',
              accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            }
          ]
        })
      )
    ).toEqual([{ chainId: 'eip155:999', label: 'EVM 999', iconChain: 'evm', accountCount: 1 }])
  })
})
