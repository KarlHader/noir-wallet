import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getMultichainConnectionAccountSelection,
  groupMultichainConnectionAccounts,
  presentDAppPermissions,
  toggleMultichainConnectionAccount
} from '../../../src/popup/services/dapp-connection-presentation.ts'
import { parseChainEndpointSettings } from '../../../src/core/chains/chain-endpoint-settings.ts'

const context = {
  network: 'mainnet',
  endpointSettings: parseChainEndpointSettings({
    schemaVersion: 1,
    overrides: [],
    customEvmNetworks: [
      {
        chainId: 'eip155:4663',
        numericChainId: 4663,
        displayName: 'Robinhood',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: { protocol: 'evm-json-rpc', label: 'Robinhood RPC', url: 'https://rpc.example.com' }
      }
    ]
  })
}

test('account-level connection selection joins chain-specific IDs without joining same-name wallets', () => {
  const first = JSON.stringify(['wallet-1', 'account-1'])
  const second = JSON.stringify(['wallet-2', 'account-1'])
  const option = (accountKey, id) => ({
    accountKey,
    id,
    label: 'Account 1',
    address: 'public-fixture'
  })
  const scopes = [
    {
      chainId: 'zcash',
      chainName: 'Zcash',
      iconChain: 'zec',
      accounts: [option(first, 'wallet-1:account-1'), option(second, 'wallet-2:account-1')]
    },
    {
      chainId: 'evm',
      chainName: 'EVM',
      iconChain: 'evm',
      accounts: [option(first, first), option(second, second)]
    }
  ]
  const groups = groupMultichainConnectionAccounts(scopes)
  expect(groups).toHaveLength(2)
  const selected = toggleMultichainConnectionAccount(groups[0], { evm: [second] })
  expect(selected).toEqual({ zcash: ['wallet-1:account-1'], evm: [second, first] })
  expect(getMultichainConnectionAccountSelection(groups[0], selected)).toBe('all')
  expect(getMultichainConnectionAccountSelection(groups[1], selected)).toBe('some')
  expect(toggleMultichainConnectionAccount(groups[0], selected)).toEqual({
    zcash: [],
    evm: [second]
  })
  expect(
    groupMultichainConnectionAccounts(
      scopes.map(scope => ({
        ...scope,
        accounts: scope.accounts.map(({ accountKey, ...account }) => account)
      }))
    )
  ).toHaveLength(4)
})

test('account-level connection selection preserves required scope accounts and completes partial grants', () => {
  const accountKey = JSON.stringify(['wallet-1', 'account-1'])
  const groups = groupMultichainConnectionAccounts([
    {
      chainId: 'zcash',
      chainName: 'Zcash',
      iconChain: 'zec',
      accounts: [
        {
          accountKey,
          id: 'zcash-account',
          label: 'Account 1',
          address: 'u1fixture',
          required: true
        }
      ]
    },
    {
      chainId: 'evm',
      chainName: 'EVM',
      iconChain: 'evm',
      accounts: [{ accountKey, id: 'evm-account', label: 'Account 1', address: '0xfixture' }]
    }
  ])
  const partial = { zcash: ['zcash-account'], evm: [] }
  expect(getMultichainConnectionAccountSelection(groups[0], partial)).toBe('some')
  const all = toggleMultichainConnectionAccount(groups[0], partial)
  expect(all).toEqual({ zcash: ['zcash-account'], evm: ['evm-account'] })
  expect(toggleMultichainConnectionAccount(groups[0], all)).toEqual(partial)
})

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
  test('merges Zcash accounts and shows one shared EVM permission', () => {
    expect(
      presentDAppPermissions(
        connection({
          authorizedAccounts: [
            { walletId: 'wallet-1', accountId: 'account-1' },
            { walletId: 'wallet-1', accountId: 'account-2' }
          ],
          evmAuthorization: {
            accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
            binding: { walletId: 'wallet-1', accountId: 'account-1' }
          },
          chainAuthorizations: [
            {
              chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
              accounts: [
                { walletId: 'wallet-1', accountId: 'account-1' },
                { walletId: 'wallet-1', accountId: 'account-3' }
              ],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            },
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
        }),
        context
      )
    ).toEqual([
      {
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        label: 'Zcash',
        iconChain: 'zcash',
        accountCount: 3
      },
      {
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        label: 'Bitcoin',
        iconChain: 'bitcoin',
        accountCount: 1
      },
      { chainId: 'evm', label: 'EVM', iconChain: 'evm', accountCount: 1 }
    ])
  })

  test('does not invent a chain permission for an unbound metadata-only connection', () => {
    expect(presentDAppPermissions(connection(), context)).toEqual([])
  })

  test('uses configured custom network metadata and an exact fallback for unknown EVM chains', () => {
    expect(
      presentDAppPermissions(
        connection({
          chainAuthorizations: [
            {
              chainId: 'eip155:4663',
              accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            },
            {
              chainId: 'eip155:999',
              accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
              binding: { walletId: 'wallet-1', accountId: 'account-1' }
            }
          ]
        }),
        context
      )
    ).toEqual([
      { chainId: 'eip155:4663', label: 'Robinhood', iconChain: 'eip155:4663', accountCount: 1 },
      { chainId: 'eip155:999', label: 'EVM 999', iconChain: 'eip155:999', accountCount: 1 }
    ])
  })
})
