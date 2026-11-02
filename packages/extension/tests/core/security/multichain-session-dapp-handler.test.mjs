import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundMultichainSessionDAppHandler } from '../../../src/background/multichain-session-dapp-handler.ts'

const ethereum = 'eip155:1'
const reference = { walletId: 'wallet-1', accountId: 'account-1' }
const address = '0x1111111111111111111111111111111111111111'

function proposal(scope = { chainId: ethereum, chainName: 'Ethereum', iconChain: 'eth' }) {
  return {
    ...scope,
    accounts: [
      {
        id: 'account-1',
        label: 'Account 1',
        address,
        reference,
        required: true
      }
    ],
    preselectedIds: ['account-1'],
    activeReference: reference,
    activeAddress: address
  }
}

function selection(value) {
  return {
    authorization: {
      chainId: value.chainId,
      accounts: [reference],
      binding: reference
    },
    addresses: [address]
  }
}

test('creates one atomic CAIP-25 session and enforces scoped invocation methods', async () => {
  let stored = null
  const approvals = []
  const events = []
  const invocations = []
  const handler = new BackgroundMultichainSessionDAppHandler({
    network: 'mainnet',
    evmNetworks: [
      {
        networkMode: 'mainnet',
        chainId: ethereum,
        numericChainId: 1,
        networkName: 'mainnet',
        displayName: 'Ethereum',
        iconChain: 'eth',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
          slip44Reference: '60'
        },
        rpcUrl: 'https://rpc.example',
        explorerUrl: 'https://explorer.example'
      }
    ],
    manager: {
      getAllConnections: async () => [],
      getCaip25Session: async () => stored,
      setCaip25Session: async (_origin, _tab, authorizations, session) => {
        expect(authorizations).toEqual([
          { chainId: ethereum, accounts: [reference], binding: reference }
        ])
        stored = session
      }
    },
    approval: {
      requestExternalApproval: async (_origin, action, data) => {
        approvals.push({ action, data })
        return {
          approved: true,
          requestId: 'approval-1',
          selectedScopes: { [ethereum]: ['account-1'] }
        }
      },
      broadcastProviderEvent: async (...args) => {
        events.push(args)
      },
      cancelPendingApprovals: () => 0
    },
    zcash: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async value => selection(value),
      getSessionAccounts: async () => [],
      revokeAllPermissions: async () => {
        stored = null
      }
    },
    evm: {
      prepareSessionAccountSelection: async (_origin, scope) => proposal(scope),
      resolveSessionAccountSelection: async value => selection(value),
      getSessionAccounts: async () => [address],
      getCaip2ChainId: () => ethereum
    },
    bitcoin: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async value => selection(value),
      getSessionAccounts: async () => []
    },
    solana: null,
    near: null,
    dispatch: async (...args) => {
      invocations.push(args)
      return 'invoked'
    }
  })

  const session = await handler.request(
    {
      method: 'wallet_createSession',
      params: {
        scopes: {
          [ethereum]: {
            methods: ['eth_accounts'],
            notifications: ['wallet_sessionChanged']
          }
        }
      }
    },
    'https://dapp.example',
    {
      title: 'Example',
      favIconUrl: 'https://dapp.example/icon.png',
      pageUrl: 'https://dapp.example/swap'
    }
  )

  expect(approvals).toHaveLength(1)
  expect(approvals[0].data.favicon).toBe('https://dapp.example/icon.png')
  expect(approvals[0].data.faviconPageUrl).toBe('https://dapp.example/swap')
  expect(session.scopes[ethereum].accounts).toEqual([`${ethereum}:${address}`])
  expect(events.at(-1).slice(0, 3)).toEqual([
    'https://dapp.example',
    'multichain',
    'wallet_sessionChanged'
  ])

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: ethereum, request: { method: 'eth_accounts' } }
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('invoked')
  expect(invocations).toHaveLength(1)

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: ethereum, request: { method: 'eth_sendTransaction', params: [] } }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
})
