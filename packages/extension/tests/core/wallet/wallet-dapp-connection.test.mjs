import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WalletDAppConnectionCoordinator } from '../../../src/background/wallet-dapp-connection.ts'
import { AccountContextTransitionCoordinator } from '../../../src/background/account-context-transition.ts'

const evmChainId = 'eip155:1'
const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const previous = { walletId: 'wallet:previous', accountId: 'account:previous' }
const current = { walletId: 'wallet:current', accountId: 'account:current' }

function fixture({ chains = [evmChainId], evm = true, zcash = false, caip25 = false } = {}) {
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
    ...(evm
      ? { chainAuthorizations: [{ chainId: evmChainId, accounts: [previous], binding: previous }] }
      : {}),
    ...(zcash
      ? {
          authorizedAccounts: [previous],
          boundWalletId: previous.walletId,
          boundAccountId: previous.accountId
        }
      : {}),
    ...(caip25 ? { caip25Session: {} } : {})
  }
  const coordinator = new WalletDAppConnectionCoordinator({
    getCurrentTabDApp: async () => dapp,
    getConnection: async origin => (origin === dapp.origin ? dapp : null),
    loadActiveAccount: async () => active,
    getEvmChainId: () => evmChainId,
    getZcashChainId: () => zcashChainId,
    connectEvm: async () => {
      calls.push('evm')
      dapp.chainAuthorizations[0].accounts = [previous, active.reference]
      dapp.chainAuthorizations[0].binding = active.reference
    },
    connectZcash: async () => {
      calls.push('zcash')
      if (failZcash) throw new Error('Zcash authorization failed')
      dapp.authorizedAccounts = [previous, active.reference]
      dapp.boundWalletId = active.reference.walletId
      dapp.boundAccountId = active.reference.accountId
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
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
  await state.coordinator.connectCurrentAccount(state.dapp.origin)
  assert.deepEqual(state.calls, ['evm'])
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, true)
  state.select({ reference: { ...current, accountId: 'account:another' }, chainIds: [evmChainId] })
  assert.equal((await state.coordinator.getCurrentTabDAppStatus()).currentAccountAuthorized, false)
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

test('CAIP-25 sessions still require reconnection from the site', async () => {
  const state = fixture({ caip25: true })
  await assert.rejects(
    state.coordinator.connectCurrentAccount(state.dapp.origin),
    /Reconnect from the site/
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
