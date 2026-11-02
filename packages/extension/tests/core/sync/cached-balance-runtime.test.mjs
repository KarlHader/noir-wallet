import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'
import {
  runSpendabilitySnapshotRefresh,
  runWithSpendabilityRecovery
} from '../../../src/core/wallet/spendability-recovery.ts'
import { safeBig } from '../../../src/lib/big.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

function createRuntime() {
  const wallet = { id: 'wallet', accounts: [{ id: 'account', derivationIndex: 0 }] }
  const walletState = {
    wallets: [wallet],
    currentWalletId: wallet.id,
    currentAccountId: 'account',
    currentNetwork: 'mainnet',
    setCurrentNetwork() {},
    getWallet: id => (id === wallet.id ? wallet : null),
    getAccount: (id, accountId) =>
      id === wallet.id ? (wallet.accounts.find(account => account.id === accountId) ?? null) : null
  }
  const oldBalance = { total: '0.002', available: '0' }
  const accountData = {
    balances: new Map([['mainnet_wallet_account', oldBalance]]),
    getBalance: (network, walletId, accountId) =>
      accountData.balances.get(`${network}_${walletId}_${accountId}`) ?? null,
    getWalletSyncState: () => ({ isSyncing: false, syncProgress: 0, currentHeight: 99 })
  }
  const events = []
  const source = readFileSync(
    new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
    'utf8'
  )
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  })
  const dependencies = {
    '@/store/wallet-store': {
      useWalletStore: { getState: () => walletState },
      async prepareWalletStoreForUse() {}
    },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => accountData,
        persist: {
          hasHydrated: () => false,
          async rehydrate() {
            events.push('rehydrate')
          }
        }
      },
      buildAccountKey: (network, walletId, accountId) => `${network}_${walletId}_${accountId}`
    },
    '@/lib/runtime-network': {
      DEFAULT_NETWORK: 'mainnet',
      getNetworkConfig: () => ({ rpcUrl: 'https://example.invalid' })
    },
    '@/infrastructure/chains/rpc-endpoints': { async ensureRpcEndpointPreferencesLoaded() {} },
    '@/infrastructure/chains/rpc-failover': { async ensureRpcFailoverStateLoaded() {} },
    '@/lib/logger': {
      logger: {
        log() {},
        warn() {},
        error() {},
        refreshCache() {}
      }
    },
    '@/core/wallet/balance-summary': { mapWasmAccountBalanceToZcashBalance },
    '@/core/wallet/spendability-recovery': {
      runSpendabilitySnapshotRefresh,
      runWithSpendabilityRecovery
    },
    '@/lib/big': { safeBig },
    '@/config/wallet': { ZEC_DECIMALS: 8 },
    './sync-status-policy': {
      isSyncOccupyingWallet: (operationActive, persistedSyncing, preflight) =>
        operationActive || persistedSyncing || preflight
    },
    './transaction-recipient-recovery': {
      TransactionRecipientRecovery: class {}
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  const runtime = new module.exports.BackgroundZcashWalletRuntime()
  runtime.currentWalletId = wallet.id
  runtime.assertWasmAccountInvariant = async () => {}
  runtime.updateSyncProgressForWallet = () => {}
  runtime.setBalanceFor = (_walletId, _accountId, balance) => {
    events.push('balance')
    accountData.balances.set('mainnet_wallet_account', balance)
  }
  runtime.broadcastSyncProgress = () => {}
  return { runtime, walletState, accountData, oldBalance, events }
}

function withSummary(fixture) {
  const started = deferred()
  const release = deferred()
  let restored = false
  const core = {
    hasAccount: () => restored,
    async restoreFromDB(index) {
      assert.equal(index, 0)
      fixture.events.push('restore')
      restored = true
      return true
    },
    async getWalletSummary() {
      fixture.events.push('summary')
      started.resolve()
      return release.promise
    },
    async getAccountHdIndex() {
      return 0
    }
  }
  fixture.runtime.walletCores.set('wallet', core)
  const snapshot = {
    fully_scanned_height: 99,
    chain_tip_height: 100,
    account_balances: [
      [
        7,
        {
          sapling_balance: 0n,
          orchard_balance: 0n,
          ironwood_balance: 0n,
          unshielded_balance: 200_000n,
          unshielded_total_balance: 200_000n,
          unshielded_pending_balance: 0n,
          unshielded_shieldable_balance: 200_000n,
          spendable_balance: 0n,
          pending_balance: 0n,
          total_balance: 200_000n
        }
      ]
    ]
  }
  return {
    core,
    snapshot,
    started: started.promise,
    release: () => release.resolve(snapshot)
  }
}

test('startup returns before WASM init and refreshes after account cache hydration', async () => {
  const fixture = createRuntime()
  const initialized = deferred()
  const core = { initialize: () => initialized.promise }
  fixture.runtime.getOrCreateWalletCore = () => core
  fixture.runtime.refreshCachedBalancesAfterReady = async () => {
    fixture.events.push('refresh')
  }

  await fixture.runtime.initialize()
  assert.deepEqual(fixture.events, [])

  initialized.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.events, ['rehydrate', 'refresh'])
})

test('startup init completion after a lock does not start a cached refresh', async () => {
  const fixture = createRuntime()
  const initialized = deferred()
  fixture.runtime.getOrCreateWalletCore = () => ({ initialize: () => initialized.promise })
  fixture.runtime.refreshCachedBalancesAfterReady = async () => {
    fixture.events.push('refresh')
  }

  await fixture.runtime.initialize()
  fixture.runtime.setSessionPassword(null)
  initialized.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(fixture.events, ['rehydrate'])
})

test('local persisted summary refreshes a cached balance without a network summary read', async () => {
  const fixture = createRuntime()
  const summary = withSummary(fixture)
  fixture.runtime.getCachedWalletSummary = async () => {
    throw new Error('network summary path should not run')
  }

  const refresh = fixture.runtime.refreshCachedBalancesAfterReady('wallet', 'account', summary.core)
  await summary.started
  summary.release()
  await refresh

  assert.deepEqual(fixture.events, ['restore', 'summary', 'balance'])
  assert.notStrictEqual(
    fixture.accountData.balances.get('mainnet_wallet_account'),
    fixture.oldBalance
  )
  assert.equal(fixture.accountData.balances.get('mainnet_wallet_account').transparent, '0.002')
  assert.equal(fixture.accountData.balances.get('mainnet_wallet_account').available, '0.00000000')
})

test('a stale summary cannot overwrite a balance after a runtime or selection change', async () => {
  for (const transition of [
    'sync',
    'preflight',
    'reload',
    'lock',
    'wallet-switch',
    'account-switch'
  ]) {
    const fixture = createRuntime()
    const summary = withSummary(fixture)
    const refresh = fixture.runtime.refreshCachedBalancesAfterReady(
      'wallet',
      'account',
      summary.core
    )
    await summary.started

    const newerBalance = { total: '0.003', available: '0.003' }
    fixture.accountData.balances.set('mainnet_wallet_account', newerBalance)
    if (transition === 'lock') {
      fixture.runtime.setSessionPassword(null)
    } else if (transition === 'wallet-switch') {
      fixture.walletState.currentWalletId = 'other-wallet'
    } else if (transition === 'account-switch') {
      fixture.walletState.currentAccountId = 'other-account'
    } else if (transition === 'preflight') {
      fixture.runtime.notifySyncStarting('wallet')
    } else {
      fixture.runtime.advanceWalletRuntimeGeneration('wallet')
    }
    summary.release()
    await refresh

    assert.strictEqual(fixture.accountData.balances.get('mainnet_wallet_account'), newerBalance)
  }
})

test('an unavailable local summary keeps the persisted balance', async () => {
  const fixture = createRuntime()
  const core = {
    hasAccount: () => true,
    async getWalletSummary() {
      throw new Error('Summary unavailable')
    }
  }
  fixture.runtime.walletCores.set('wallet', core)

  await fixture.runtime.refreshCachedBalancesAfterReady('wallet', 'account', core)

  assert.strictEqual(fixture.accountData.balances.get('mainnet_wallet_account'), fixture.oldBalance)
  assert.deepEqual(fixture.events, [])
})

test('another wallet preflight does not cancel this wallet readiness refresh', async () => {
  const fixture = createRuntime()
  const summary = withSummary(fixture)
  fixture.runtime.notifySyncStarting('wallet')
  const refresh = fixture.runtime.refreshCachedBalancesAfterReady(
    'wallet',
    'account',
    summary.core,
    true
  )
  await summary.started
  fixture.runtime.notifySyncStarting('other-wallet')
  summary.release()
  await refresh

  assert.equal(fixture.accountData.balances.get('mainnet_wallet_account').transparent, '0.002')
})

test('Max above cached confirmed funds refreshes the local balance before returning', async () => {
  const fixture = createRuntime()
  const summary = withSummary(fixture)
  fixture.runtime.getWalletCore = async () => summary.core
  summary.core.estimateMaxTransfer = async () => ({
    maxAmountZats: '190000',
    feeZats: '10000'
  })
  fixture.runtime.getCachedWalletSummary = async () => {
    throw new Error('Max refresh must not read a network summary')
  }

  const estimate = fixture.runtime.estimateMaxTransferFor(
    'wallet',
    'account',
    'u1recipient',
    undefined,
    10_000,
    'transparent'
  )
  await summary.started
  summary.release()
  assert.deepEqual(await estimate, { maxAmountZats: '190000', feeZats: '10000' })
  assert.equal(
    fixture.accountData.balances.get('mainnet_wallet_account').confirmed.transparent,
    '0.002'
  )
})

test('Max cannot start a balance refresh after its runtime scope changed during estimation', async () => {
  for (const change of ['runtime', 'session', 'network', 'account']) {
    const fixture = createRuntime()
    const summary = withSummary(fixture)
    const estimated = deferred()
    summary.core.estimateMaxTransfer = () => estimated.promise
    fixture.runtime.getWalletCore = async () => summary.core

    const max = fixture.runtime.estimateMaxTransferFor(
      'wallet',
      'account',
      'u1recipient',
      undefined,
      10_000,
      'transparent'
    )
    await new Promise(resolve => setImmediate(resolve))
    if (change === 'runtime') fixture.runtime.advanceWalletRuntimeGeneration('wallet')
    if (change === 'session') fixture.runtime.setSessionPassword(null)
    if (change === 'network') fixture.runtime.network = 'testnet'
    if (change === 'account') fixture.walletState.currentAccountId = 'other-account'
    estimated.resolve({ maxAmountZats: '190000', feeZats: '10000' })

    assert.deepEqual(await max, { maxAmountZats: '190000', feeZats: '10000' })
    assert.strictEqual(
      fixture.accountData.balances.get('mainnet_wallet_account'),
      fixture.oldBalance
    )
    assert.equal(fixture.events.includes('summary'), false)
  }
})
