import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundMultichainSessionDAppHandler } from '../../../src/background/multichain-session-dapp-handler.ts'
import { selectDAppSessionAccounts } from '../../../src/background/dapp-session-accounts.ts'

const ethereum = 'eip155:1'
const custom = 'eip155:4663'
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

function createHandler({
  selectedIds = ['account-1'],
  prepareProposal = proposal,
  activeChainIds
} = {}) {
  let stored = null
  const approvals = []
  const events = []
  const invocations = []
  const handler = new BackgroundMultichainSessionDAppHandler({
    network: 'mainnet',
    ...(activeChainIds === undefined ? {} : { activeChainIds }),
    evmNetworks: [ethereum, custom].map(chainId => ({
      networkMode: 'mainnet',
      chainId,
      numericChainId: Number(chainId.split(':')[1]),
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
    })),
    manager: {
      getAllConnections: async () => [],
      getAuthorizationRevision: async () => 4,
      getCaip25Session: async () => stored,
      setCaip25Session: async (_origin, _tab, authorizations, session, _zcash, revision) => {
        expect(revision).toBe(4)
        expect(authorizations).toEqual(
          session.scopes.map(scope => ({
            chainId: scope.chainId,
            accounts: [reference],
            binding: reference
          }))
        )
        stored = session
      }
    },
    approval: {
      requestExternalApproval: async (_origin, action, data) => {
        approvals.push({ action, data })
        return {
          approved: true,
          requestId: 'approval-1',
          selectedScopes: { evm: selectedIds }
        }
      },
      broadcastProviderEvent: async (...args) => {
        events.push(args)
      },
      cancelPendingApprovals: () => 0
    },
    zcash: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => [],
      revokeAllPermissions: async () => {
        stored = null
      }
    },
    evm: {
      prepareSessionAccountSelection: async (_origin, scope) => prepareProposal(scope),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => [address],
      getCaip2ChainId: () => ethereum
    },
    bitcoin: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => []
    },
    solana: null,
    near: null,
    dispatch: async (...args) => {
      invocations.push(args)
      return 'invoked'
    }
  })
  return { handler, approvals, events, invocations, getStored: () => stored }
}

test('creates one shared EVM approval while preserving atomic chain scopes and methods', async () => {
  const { handler, approvals, events, invocations, getStored } = createHandler()

  const session = await handler.request(
    {
      method: 'wallet_createSession',
      params: {
        scopes: {
          [ethereum]: {
            methods: ['eth_accounts'],
            notifications: ['wallet_sessionChanged']
          },
          [custom]: {
            methods: ['eth_accounts'],
            notifications: []
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
  expect(approvals[0].data.scopes).toHaveLength(1)
  expect(approvals[0].data.scopes[0]).toMatchObject({ chainId: 'evm', chainName: 'EVM' })
  expect(session.scopes[ethereum].accounts).toEqual([`${ethereum}:${address}`])
  expect(session.scopes[custom].accounts).toEqual([`${custom}:${address}`])
  expect(getStored().scopes.map(scope => scope.accounts)).toEqual([[reference], [reference]])
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

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: 'eip155:999', request: { method: 'eth_accounts' } }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
})

test('multichain Connect grants only networks supported by the active account', async () => {
  const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const bitcoin = 'bip122:000000000019d6689c085ae165831e93'
  const { handler, approvals, getStored } = createHandler({
    activeChainIds: async () => [ethereum]
  })
  const origin = 'https://dapp.example'
  const request = scopes =>
    handler.request({ method: 'wallet_createSession', params: { scopes } }, origin, {})
  const session = await request({
    [zcash]: { methods: ['zcash_getAccounts'], notifications: [] },
    [ethereum]: { methods: ['eth_accounts'], notifications: [] },
    [custom]: { methods: ['eth_accounts'], notifications: [] },
    [bitcoin]: { methods: ['getAccounts'], notifications: [] },
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { methods: ['getAccounts'], notifications: [] },
    'near:mainnet': { methods: ['getAccounts'], notifications: [] }
  })
  expect(Object.keys(session.scopes)).toEqual([ethereum])
  expect(getStored().scopes.map(scope => scope.chainId)).toEqual([ethereum])
  expect(approvals).toHaveLength(1)
  expect(approvals[0].data.scopes.map(scope => scope.chainId)).toEqual(['evm'])
  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: zcash, request: { method: 'zcash_getAccounts' } }
      },
      origin,
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
  await expect(
    request({ [zcash]: { methods: ['zcash_getAccounts'], notifications: [] } })
  ).rejects.toMatchObject({ code: 5100 })
  await expect(
    request({ [ethereum]: { methods: ['zcash_getAccounts'], notifications: [] } })
  ).rejects.toMatchObject({ code: 5101 })
  expect(approvals).toHaveLength(1)
  expect(getStored().scopes.map(scope => scope.chainId)).toEqual([ethereum])
})

test('shared EVM selection cannot widen a scope with a narrower account request', async () => {
  const otherAddress = '0x2222222222222222222222222222222222222222'
  const { handler, approvals, getStored } = createHandler({
    selectedIds: ['account-1', 'account-2'],
    prepareProposal: scope => ({
      ...proposal(scope),
      accounts: [
        ...proposal(scope).accounts,
        {
          id: 'account-2',
          label: 'Account 2',
          address: otherAddress,
          reference: { walletId: 'wallet-2', accountId: 'account-2' },
          required: false
        }
      ]
    })
  })
  await expect(
    handler.request(
      {
        method: 'wallet_createSession',
        params: {
          scopes: {
            [ethereum]: { methods: ['eth_accounts'], notifications: [] },
            [custom]: {
              accounts: [`${custom}:${address}`],
              methods: ['eth_accounts'],
              notifications: []
            }
          }
        }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
  expect(approvals[0].data.scopes[0].accounts.map(account => account.id)).toEqual(['account-1'])
  expect(getStored()).toBeNull()
})
