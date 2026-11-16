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
import { isAccountNetworkEnabled } from '../../../src/core/wallet/account-network-selection.ts'
import { fetchLatestBlockHeight } from '../../../src/infrastructure/chains/rpc-registry-client.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

function createRuntime(overrides = {}) {
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
      async prepareWalletStoreForUse() {},
      async flushWalletStore() {}
    },
    '@/core/wallet/secure-storage': {
      SecureStorage: {
        async getLoginAttempts() {
          return { isLocked: false }
        },
        async resetLoginAttempts() {},
        async saveLastActivityTime() {}
      }
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
    '@/infrastructure/chains/rpc-registry-client': {
      fetchLatestBlockHeight: overrides.fetchLatestBlockHeight ?? (async () => 100)
    },
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
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled },
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

function createAccountCore(client) {
  const source = readFileSync(
    new URL('../../../src/core/zcash/wallet-core.ts', import.meta.url),
    'utf8'
  )
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  })
  const module = { exports: {} }
  const dependencies = {
    '../worker/client': { getWorkerClient: () => client },
    '@/lib/logger': { logger: { log() {}, warn() {} } },
    '@/lib/big': { safeBig }
  }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  return new module.exports.ZcashWalletCore({ walletId: 'wallet', network: 'mainnet' })
}

test('registering all Zcash accounts preserves the selected account for transfer estimates', async () => {
  for (const credentialKind of ['seed', 'hardware', 'session']) {
    const fixture = createRuntime()
    fixture.walletState.wallets[0].accounts.push({ id: 'second', derivationIndex: 1 })
    const requests = []
    const core = createAccountCore({
      getAccountIds: async () => [7, 12],
      getAccountHdIndex: async id => (id === 7 ? 0 : 1),
      markAccountReady() {},
      async estimateMaxTransfer(request) {
        requests.push(request)
        return { maxAmountZats: '275000', feeZats: '15000' }
      },
      async estimateTransferFee(request) {
        requests.push(request)
        return { feeZats: '15000', marginalFeeZats: '5000' }
      }
    })
    core.ensureInitialized = async () => {}
    fixture.runtime.getOrCreateWalletCore = () => core
    fixture.runtime.isLocked = () => false
    fixture.runtime.password = credentialKind === 'session' ? null : 'test password'
    fixture.runtime.hasSessionCredentialFor = () => credentialKind === 'session'
    fixture.runtime.loadWalletCredential = async () =>
      credentialKind === 'hardware'
        ? { kind: 'hardware' }
        : { kind: 'seed', seedPhrase: 'synthetic test phrase' }
    fixture.runtime.waitForAccountReady = async () => {}

    await fixture.runtime.ensureAllAccountsRegistered('wallet')
    const selectedCore = await fixture.runtime.getWalletCore('wallet', 'account')
    await selectedCore.estimateMaxTransfer('synthetic recipient', undefined, 5000, 'transparent')
    await selectedCore.estimateTransferFee(
      'synthetic recipient',
      '0.00275',
      undefined,
      5000,
      'transparent'
    )

    assert.equal(selectedCore.accountIndex, 0, credentialKind)
    assert.deepEqual(
      requests.map(request => request.accountId),
      [7, 7],
      credentialKind
    )
  }
})

test('cancelled chain-height reads abort transport, drain the summary and preserve cached state', async () => {
  const started = deferred()
  const summary = deferred()
  let abortedTransport = false
  const fixture = createRuntime({
    fetchLatestBlockHeight: (url, _fetch, _timeout, signal) =>
      fetchLatestBlockHeight(
        url,
        async (_input, init) => {
          started.resolve()
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                abortedTransport = true
                reject(new DOMException('Aborted', 'AbortError'))
              },
              { once: true }
            )
          })
        },
        5000,
        signal
      )
  })
  const cached = { latestHeight: 90, summary: { fully_scanned_height: 89 }, fetchedAt: 1 }
  fixture.runtime.walletSummaryCache.set('wallet', cached)
  const controller = new AbortController()
  const read = fixture.runtime.getCachedWalletSummary(
    'wallet',
    {
      getLatestHeight() {
        throw new Error('Network reads must not block the WASM queue')
      },
      getWalletSummary: () => summary.promise
    },
    { force: true, signal: controller.signal }
  )
  const rejected = assert.rejects(read, { name: 'AbortError' })
  await started.promise
  controller.abort()
  assert.equal(abortedTransport, true)
  assert.equal(
    await Promise.race([
      read.then(
        () => 'done',
        () => 'done'
      ),
      new Promise(resolve => setImmediate(() => resolve('draining')))
    ]),
    'draining'
  )
  summary.resolve({ fully_scanned_height: 100 })
  await rejected
  assert.strictEqual(fixture.runtime.walletSummaryCache.get('wallet'), cached)

  fixture.runtime.walletSummaryCache.delete('wallet')
  const fresh = createRuntime()
  const localSummary = { fully_scanned_height: 99 }
  const result = await fresh.runtime.getCachedWalletSummary(
    'wallet',
    {
      getLatestHeight() {
        throw new Error('Network reads must not block the WASM queue')
      },
      getWalletSummary: async () => localSummary
    },
    { force: true }
  )
  assert.equal(result.latestHeight, 100)
  assert.strictEqual(result.summary, localSummary)
})

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

test('unlock reloads a retained wallet core using its persisted snapshot key', async () => {
  const fixture = createRuntime()
  let initializedKey
  const core = {
    accountIndex: 0,
    hasAccount: () => false,
    async ensureInitialized(dbKey) {
      initializedKey = dbKey
    },
    async restoreFromDB() {
      assert.equal(initializedKey, 'mainnet_wallet')
      return true
    },
    async getAddresses() {
      return {}
    }
  }
  fixture.runtime.walletCores.set('wallet', core)
  fixture.runtime.inspectWalletCredential = async () => ({
    status: 'valid',
    credential: { kind: 'seed', seedPhrase: 'synthetic test phrase' }
  })
  fixture.runtime.cancelActiveRestore = () => {}
  fixture.runtime.bindCredentialToCore = () => {}
  fixture.runtime.refreshCachedBalancesAfterReady = async () => {}
  fixture.runtime.requestSync = () => {}

  assert.equal((await fixture.runtime.unlock('test password')).success, true)
  await fixture.runtime.activeRestorePromise
  assert.equal(initializedKey, 'mainnet_wallet')
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
    'account-switch',
    'network-disabled'
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
    } else if (transition === 'network-disabled') {
      fixture.walletState.wallets[0].accounts[0].networkSelections = { mainnet: ['evm'] }
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
