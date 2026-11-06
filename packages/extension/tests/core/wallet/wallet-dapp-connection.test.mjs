import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WalletDAppConnectionCoordinator } from '../../../src/background/wallet-dapp-connection.ts'
import { AccountContextTransitionCoordinator } from '../../../src/background/account-context-transition.ts'

const evmChainId = 'eip155:1'
const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const bitcoinChainId = 'bip122:000000000019d6689c085ae165831e93'
const solanaChainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const nearChainId = 'near:mainnet'
const previous = { walletId: 'wallet:previous', accountId: 'account:previous' }
const current = { walletId: 'wallet:current', accountId: 'account:current' }

function fixture({
  chains = [evmChainId],
  currentEvmChainId = evmChainId,
  evm = true,
  sharedEvm = false,
  zcash = false,
  caip25 = false
} = {}) {
  const transition = new AccountContextTransitionCoordinator()
  let active = { reference: current, chainIds: chains }
  let failZcash = false
  const calls = []
  const dapp = {
    id: 'connection:test',
    origin: 'https://wallet-connect.example',
    name: 'Wallet Connect',
    host: 'wallet-connect.example',
    favicon: '',
    connectedAt: 1,
    lastActiveAt: 1,
    ...(evm && (sharedEvm || caip25)
      ? { evmAuthorization: { accounts: [previous], binding: previous } }
      : {}),
    ...(evm && !sharedEvm && !caip25
      ? { chainAuthorizations: [{ chainId: evmChainId, accounts: [previous], binding: previous }] }
      : {}),
    ...(zcash
      ? {
          authorizedAccounts: [previous],
          boundWalletId: previous.walletId,
          boundAccountId: previous.accountId
        }
      : {}),
    ...(caip25
      ? {
          caip25Session: {
            scopes: [
              {
                chainId: evmChainId,
                accounts: [previous],
                methods: ['eth_accounts'],
                notifications: ['wallet_sessionChanged']
              },
              ...(zcash
                ? [{ chainId: zcashChainId, methods: ['zcash_getBalance'], notifications: [] }]
                : [])
            ]
          },
          ...(zcash
            ? {
                chainAuthorizations: [
                  { chainId: zcashChainId, accounts: [previous], binding: previous }
                ]
              }
            : {})
        }
      : {})
  }
  const coordinator = new WalletDAppConnectionCoordinator({
    getCurrentTabDApp: async () => dapp,
    getConnection: async origin => (origin === dapp.origin ? dapp : null),
    loadActiveAccount: async () => active,
    getEvmChainId: () => currentEvmChainId,
    getZcashChainId: () => zcashChainId,
    connectEvm: async () => {
      calls.push('evm')
      const grant = sharedEvm || caip25 ? dapp.evmAuthorization : dapp.chainAuthorizations[0]
      grant.accounts = [previous, active.reference]
      grant.binding = active.reference
    },
    connectZcash: async () => {
      calls.push('zcash')
      if (failZcash) throw new Error('Zcash authorization failed')
      dapp.authorizedAccounts = [previous, active.reference]
      dapp.boundWalletId = active.reference.walletId
      dapp.boundAccountId = active.reference.accountId
    },
    connectSession: async (origin, chainIds, account) => {
      calls.push(['session', chainIds, account])
      for (const chainId of chainIds) {
        const scope = dapp.caip25Session.scopes.find(item => item.chainId === chainId)
        if (chainId === evmChainId) {
          dapp.evmAuthorization.accounts.push(account)
          dapp.evmAuthorization.binding = account
          scope.accounts = [...scope.accounts, account]
        } else if (chainId === zcashChainId) {
          dapp.chainAuthorizations[0].accounts.push(account)
          dapp.chainAuthorizations[0].binding = account
        } else {
          const grant = dapp.chainAuthorizations.find(item => item.chainId === chainId)
          grant.accounts.push(account)
          grant.binding = account
        }
      }
    },
    notifyChainAccountsChanged: async (origin, chainIds) => {
      calls.push(['chains-notified', origin, chainIds])
    },
    notifySessionChanged: async () => {
      calls.push('session-notified')
    },
    runActiveOperation: operation => transition.runActiveOperation(operation)
  })
  return {
    coordinator,
    dapp,
    calls,
    transition,
    select: selection => {
      active = selection
    },
    failZcash: value => {
      failZcash = value
    }
  }
}

test('native EVM connection status uses the authoritative account without legacy wallet pointers', async () => {
  const state = fixture()
  const disconnected = await state.coordinator.getCurrentTabDAppStatus()
  assert.equal(disconnected.currentAccountAuthorized, false)
  assert.equal(disconnected.canConnectCurrentAccount, true)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['evm'])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
  state.select({ reference: { ...current, accountId: 'account:another' }, chainIds: [evmChainId] })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
})

test('shared EVM grant remains connectable after the active EVM chain changes', async () => {
  const state = fixture({ chains: ['eip155:56'], currentEvmChainId: 'eip155:56', sharedEvm: true })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['evm'])
  assert.deepEqual(state.dapp.evmAuthorization.binding, current)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('mixed EVM and Zcash Connect updates both grants and requires both for connected status', async () => {
  const state = fixture({ chains: [evmChainId, zcashChainId], zcash: true })
  state.dapp.chainAuthorizations[0].accounts.push(current)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['evm', 'zcash'])
  assert.equal(state.dapp.boundAccountId, current.accountId)
  assert.deepEqual(state.dapp.chainAuthorizations[0].binding, current)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('a Zcash-only account is not routed into a sites existing EVM grant', async () => {
  const state = fixture({ chains: [zcashChainId], zcash: true })
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['zcash'])
  assert.deepEqual(state.dapp.chainAuthorizations[0].accounts, [previous])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('a native EVM account does not acquire a sites legacy Zcash grant', async () => {
  const state = fixture({ zcash: true })
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['evm'])
  assert.deepEqual(state.dapp.authorizedAccounts, [previous])
})

test('partial authorization failure remains visible and can be completed by retry', async () => {
  const state = fixture({ chains: [evmChainId, zcashChainId], zcash: true })
  state.failZcash(true)
  await assert.rejects(
    state.coordinator.connectCurrentAccount(state.dapp.origin),
    /Zcash authorization failed/
  )
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  state.failZcash(false)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('wallet Connect adds only the current account to an existing CAIP-25 scope', async () => {
  const state = fixture({ caip25: true })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).canConnectCurrentAccount, true)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, [
    ['session', [evmChainId], current],
    ['chains-notified', state.dapp.origin, [evmChainId]],
    'session-notified'
  ])
  assert.deepEqual(state.dapp.caip25Session.scopes[0].accounts, [previous, current])
  assert.deepEqual(state.dapp.caip25Session.scopes[0].methods, ['eth_accounts'])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('wallet Connect updates matching EVM and Zcash scopes of a mixed CAIP-25 session', async () => {
  const state = fixture({ caip25: true, zcash: true, chains: [evmChainId, zcashChainId] })
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, [
    ['session', [evmChainId, zcashChainId], current],
    'zcash',
    ['chains-notified', state.dapp.origin, [evmChainId, zcashChainId]],
    'session-notified'
  ])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
})

test('wallet Connect notifies native chains only when their existing CAIP-25 scopes are updated', async () => {
  const nativeChainIds = [bitcoinChainId, solanaChainId, nearChainId]
  const state = fixture({
    caip25: true,
    chains: [evmChainId, ...nativeChainIds, zcashChainId]
  })
  state.dapp.caip25Session.scopes.push(
    ...nativeChainIds.map(chainId => ({ chainId, methods: ['getAccounts'], notifications: [] }))
  )
  state.dapp.chainAuthorizations = nativeChainIds.map(chainId => ({
    chainId,
    accounts: [previous],
    binding: previous
  }))
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, [
    ['session', [evmChainId, ...nativeChainIds], current],
    ['chains-notified', state.dapp.origin, [evmChainId, ...nativeChainIds]],
    'session-notified'
  ])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
  assert.equal(
    state.dapp.caip25Session.scopes.some(scope => scope.chainId === zcashChainId),
    false
  )
  for (const grant of state.dapp.chainAuthorizations) {
    assert.deepEqual(grant.accounts, [previous, current])
  }
})

test('wallet Connect does not offer an unsupported CAIP-25 chain', async () => {
  const state = fixture({ caip25: true, chains: [zcashChainId] })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).canConnectCurrentAccount, false)
  await assert.rejects(
    state.coordinator.connectCurrentAccount(state.dapp.origin),
    /network permission/
  )
  assert.deepEqual(state.calls, [])
})

test('unknown origins, absent accounts and unsupported grants fail without authorization changes', async () => {
  const state = fixture()
  await assert.rejects(
    state.coordinator.connectCurrentAccount('https://unknown.example'),
    /No connection found/
  )
  state.select(null)
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  await assert.rejects(
    state.coordinator.connectCurrentAccount(state.dapp.origin),
    /No active account/
  )
  state.select({ reference: current, chainIds: [zcashChainId] })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).canConnectCurrentAccount, false)
  await assert.rejects(
    state.coordinator.connectCurrentAccount(state.dapp.origin),
    /Reconnect from the site/
  )
  assert.deepEqual(state.calls, [])
})

test('Connect waits for an account transition and resolves the new account inside its lock', async () => {
  const state = fixture()
  const selected = { walletId: 'wallet:next', accountId: 'account:next' }
  let release
  const paused = new Promise(resolve => {
    release = resolve
  })
  const switching = state.transition.runActiveOperation(async () => {
    await paused
    state.select({ reference: selected, chainIds: [evmChainId] })
  })
  const connecting = state.coordinator.connectCurrentAccount(state.dapp.origin)
  release()
  await Promise.all([switching, connecting])
  assert.deepEqual(state.dapp.chainAuthorizations[0].binding, selected)
})
