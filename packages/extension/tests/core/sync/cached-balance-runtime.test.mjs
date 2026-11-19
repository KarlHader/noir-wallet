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
import {
  isFrostAccount,
  isDerivedAccount,
  accountSourceEquals,
  parseAccountSource
} from '../../../src/core/accounts/domain/account-source.ts'
import { isValidZcashBirthdayHeight } from '../../../src/core/wallet/birthday-height.ts'
import { isZcashHardwareKeySource } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { mapWasmAccountAddresses } from '../../../src/core/zcash/account-addresses.ts'

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
    '@/core/worker/client': { getWorkerClient: () => overrides.workerClient },
    '@/core/wallet/hardware-wallet-data': { isZcashHardwareKeySource },
    '@/core/zcash/account-addresses': { mapWasmAccountAddresses },
    '@/lib/multisig-vault-storage': {
      readVaultRecord: async () => overrides.vaultRecord ?? { version: 2 }
    },
    '@/core/accounts/domain/account-source': {
      isFrostAccount,
      isDerivedAccount,
      accountSourceEquals,
      parseAccountSource
    },
    '@/core/wallet/birthday-height': { isValidZcashBirthdayHeight },
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

test('startup defers FROST cached refresh until its credential is bound', async () => {
  const fixture = createRuntime()
  const initialized = deferred()
  fixture.walletState.wallets[0].accounts.push({
    id: 'vault',
    source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  })
  fixture.walletState.currentAccountId = 'vault'
  fixture.runtime.getOrCreateWalletCore = () => ({ initialize: () => initialized.promise })
  fixture.runtime.refreshCachedBalancesAfterReady = async () => {
    fixture.events.push('refresh')
  }

  await fixture.runtime.initialize()
  initialized.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(fixture.events, ['rehydrate'])
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

test('summary refresh maps external balances by stable source instead of treating null HD index as zero', async () => {
  const { runtime, walletState, accountData } = createRuntime()
  const source = { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  const wallet = walletState.wallets[0]
  wallet.accounts.push({ id: 'vault', source, addresses: { shielded: 'vault-address' } })
  runtime.setBalanceFor = (walletId, accountId, balance) =>
    accountData.balances.set(`mainnet_${walletId}_${accountId}`, balance)
  runtime.walletCores.set('wallet', {
    hasAccount: () => true,
    async getWalletSummary() {
      return {
        account_balances: [
          [
            72,
            {
              orchard_balance: 0,
              ironwood_balance: 200000000,
              sapling_balance: 0,
              unshielded_balance: 0
            }
          ]
        ]
      }
    },
    async getAccountHdIndex() {
      return null
    },
    async resolveFrostAccount(request) {
      assert.equal(request.accountId, 'vault')
      return 72
    }
  })
  await runtime.refreshBalances('wallet', true, { localOnly: true, canApply: () => true })
  assert.equal(accountData.balances.get('mainnet_wallet_vault')?.total, '2')
  assert.equal(accountData.balances.get('mainnet_wallet_account').total, '0.002')
})

test('rescan authenticates every external sealed record before deleting the wallet database', async () => {
  const { runtime, walletState, events } = createRuntime()
  walletState.wallets[0].accounts.push({
    id: 'vault',
    source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  })
  runtime.password = 'synthetic-password'
  runtime.loadWalletCredential = async () => ({ kind: 'seed', seedPhrase: 'synthetic phrase' })
  runtime.preflightFrostAccounts = async () => {
    events.push('preflight')
    throw new Error('Vault record cannot be opened')
  }
  runtime.cancelActiveRestore = () => events.push('cancel')
  await assert.rejects(runtime.resyncZcashWallet('wallet', 'account', 100), /Vault record/)
  assert.deepEqual(events, ['preflight'])
})

test('rotating a receive address preserves authenticated external resolution, preflight and rebuild identity', async () => {
  const sealedRecord = { version: 2, accountId: 'vault', ownerWalletId: 'wallet' }
  const { runtime, walletState } = createRuntime({ vaultRecord: sealedRecord })
  const account = {
    id: 'vault',
    source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' },
    addresses: { transparent: '', shielded: 'rotated-receive-address' },
    birthdayHeight: 100
  }
  walletState.wallets[0].accounts.push(account)
  function bound(request) {
    assert.equal(request.sealedRecord, sealedRecord)
    assert.equal(request.expectedAddress, undefined)
    assert.equal(request.source, account.source)
    assert.equal(request.accountId, 'vault')
  }
  const core = {
    walletId: 'wallet',
    async ensureInitialized() {},
    async resolveFrostAccount(request) {
      bound(request)
      return 72
    },
    async preflightFrostAccount(request) {
      bound(request)
      return true
    },
    async registerFrostAccount(request) {
      bound(request)
      return 72
    },
    async getUnifiedAddresses() {
      return { transparent: '', shielded: 'original-vault-address' }
    }
  }
  runtime.walletCores.set('wallet', core)
  runtime.persistWalletDb = async () => {}
  assert.equal(await runtime.resolveWasmAccountId('wallet', 'vault', core), 72)
  await runtime.preflightFrostAccounts('wallet', [account])
  assert.equal(
    (await runtime.registerFrostAccount('wallet', account)).shielded,
    'original-vault-address'
  )
  assert.equal(account.addresses.shielded, 'rotated-receive-address')
})

test('cross-network HD projection uses isolated address computation while FROST is selected', async () => {
  const calls = []
  const workerClient = {
    async mnemonicToAddresses(phrase, index, network) {
      calls.push({ phrase, index, network })
      return { transparent: 'testnet-hd-public', unified: 'testnet-hd-private' }
    }
  }
  const { runtime, walletState } = createRuntime({ workerClient })
  const selectedSource = { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  walletState.wallets[0].accounts.push({
    id: 'vault',
    source: selectedSource,
    addresses: { shielded: 'vault-address' }
  })
  walletState.currentAccountId = 'vault'
  const activeCore = {
    accountId: 72,
    accountIndex: undefined,
    accountSource: selectedSource,
    getAddresses() {
      throw new Error('Cannot derive from external account')
    }
  }
  runtime.walletCores.set('wallet', activeCore)
  runtime.password = 'synthetic-password'
  runtime.loadWalletCredential = async () => ({ kind: 'seed', seedPhrase: 'synthetic phrase' })
  const result = await runtime.deriveSoftwareWalletAddresses('wallet', 'testnet')
  assert.deepEqual(Object.keys(result), ['account'])
  assert.equal(result.account.shielded, 'testnet-hd-private')
  assert.deepEqual(calls, [{ phrase: 'synthetic phrase', index: 0, network: 'testnet' }])
  assert.equal(activeCore.accountId, 72)
  assert.equal(activeCore.accountSource, selectedSource)
  assert.equal(activeCore.accountIndex, undefined)
})

function selectedFrostFeeRuntime() {
  const fixture = createRuntime()
  const source = { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  fixture.walletState.wallets[0].accounts.push({ id: 'vault', source })
  fixture.walletState.currentAccountId = 'vault'
  const quote = { id: 'quote', standardMarginalFeeZats: 5000, expiresAt: 10_000 }
  const core = {
    walletId: 'wallet',
    accountId: 72,
    accountIndex: undefined,
    accountSource: { ...source },
    hasAccount: () => true,
    isReady: () => true,
    hasWasmInitialized: () => true,
    async restoreFrostAccount(request) {
      fixture.events.push('resolve')
      assert.equal(request.accountId, 'vault')
      assert.deepEqual(request.source, source)
      throw new Error('Native validation required')
    },
    async getFeeQuote() {
      fixture.events.push('quote')
      return quote
    }
  }
  fixture.runtime.walletCores.set('wallet', core)
  fixture.runtime.setAccountMapping('wallet', 'vault', 72, { ...source })
  return { ...fixture, core, source, quote }
}

test('selected authenticated FROST fee quotes reuse the initialized mapped core without reentering the native wallet queue', async () => {
  const { runtime, quote, events } = selectedFrostFeeRuntime()
  assert.deepEqual(await runtime.getFeeQuote(), quote)
  assert.deepEqual(await runtime.getFeeQuote(), quote)
  assert.deepEqual(events, ['quote', 'quote'])
})

test('a cold FROST quote publishes its authenticated restored identity for the next quote', async () => {
  const { runtime, core, quote, source, events } = selectedFrostFeeRuntime()
  runtime.accountMappingCache.clear()
  let restores = 0
  core.restoreFrostAccount = async request => {
    restores++
    if (restores > 1) throw new Error('Already selected account reentered the native queue')
    events.push('resolve')
    assert.equal(request.accountId, 'vault')
    assert.deepEqual(request.source, source)
    core.accountId = 72
    core.accountSource = { ...request.source }
    return true
  }
  assert.deepEqual(await runtime.getFeeQuote(), quote)
  assert.deepEqual(runtime.getAccountMapping('wallet', 'vault'), {
    wasmAccountId: 72,
    source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  })
  assert.deepEqual(await runtime.getFeeQuote(), quote)
  assert.deepEqual(events, ['resolve', 'quote', 'quote'])
})

test('external restore cannot publish a mismatched selected identity or invalid native id', async () => {
  for (const corrupt of [
    core => (core.accountSource = { ...core.accountSource, groupId: 'other' }),
    core => (core.accountSource = { ...core.accountSource, network: 'testnet' }),
    core => (core.accountSource = undefined),
    core => (core.accountId = -1),
    core => (core.accountId = 1.5),
    core => (core.accountId = Number.MAX_SAFE_INTEGER + 1),
    core => (core.accountId = NaN),
    core => (core.accountId = null),
    (_core, account) => (account.id = 'other'),
    (_core, account) => (account.source = { ...account.source, groupId: 'other' })
  ]) {
    const { runtime, core, events, walletState } = selectedFrostFeeRuntime()
    runtime.accountMappingCache.clear()
    core.restoreFrostAccount = async () => {
      events.push('resolve')
      corrupt(
        core,
        walletState.wallets[0].accounts.find(account => account.id === 'vault')
      )
      return true
    }
    await assert.rejects(runtime.getFeeQuote(), /identity/i)
    assert.equal(runtime.getAccountMapping('wallet', 'vault'), undefined)
    assert.equal(runtime.getAccountMapping('wallet', 'other'), undefined)
    assert.deepEqual(events, ['resolve'])
  }
})

test('FROST core reuse requires exact application identity, native id, source and live initialization', async () => {
  const changes = [
    fixture => fixture.runtime.accountMappingCache.clear(),
    fixture => fixture.runtime.setAccountMapping('wallet', 'vault', 0, { ...fixture.source }),
    fixture => {
      fixture.runtime.accountMappingCache.clear()
      fixture.runtime.setAccountMapping('wallet', 'other', 72, { ...fixture.source })
    },
    fixture => {
      fixture.runtime.accountMappingCache.clear()
      fixture.runtime.network = 'testnet'
      fixture.runtime.setAccountMapping('wallet', 'vault', 72, { ...fixture.source })
      fixture.runtime.network = 'mainnet'
    },
    fixture => fixture.runtime.setAccountMapping('wallet', 'vault', 72, 0),
    fixture =>
      fixture.runtime.setAccountMapping('wallet', 'vault', 72, {
        ...fixture.source,
        groupId: 'other'
      }),
    fixture =>
      fixture.runtime.setAccountMapping('wallet', 'vault', 72, {
        ...fixture.source,
        network: 'testnet'
      }),
    fixture => (fixture.core.accountId = 0),
    fixture => (fixture.core.accountSource = { ...fixture.source, groupId: 'other' }),
    fixture => (fixture.core.accountSource = { ...fixture.source, network: 'testnet' }),
    fixture => (fixture.core.accountSource = { ...fixture.source, version: 2 }),
    fixture => (fixture.core.accountSource = { ...fixture.source, kind: 'other' }),
    fixture => (fixture.core.accountSource = undefined),
    fixture => (fixture.core.isReady = () => false),
    fixture => (fixture.core.hasWasmInitialized = () => false)
  ]
  for (const change of changes) {
    const fixture = selectedFrostFeeRuntime()
    change(fixture)
    await assert.rejects(fixture.runtime.getFeeQuote(), /Native validation required/)
    assert.deepEqual(fixture.events, ['resolve'])
  }
})

test('authenticated native account mapping snapshots its source rather than aliasing retained metadata', () => {
  const { runtime, source } = selectedFrostFeeRuntime()
  runtime.setAccountMapping('wallet', 'vault', 72, source)
  source.groupId = 'changed'
  source.network = 'testnet'
  assert.deepEqual(runtime.getAccountMapping('wallet', 'vault').source, {
    kind: 'frost-vault',
    version: 1,
    groupId: 'group',
    network: 'mainnet'
  })
})

test('native account mappings distinguish legal colon-containing wallet and account identities', () => {
  const { runtime, source } = selectedFrostFeeRuntime()
  runtime.setAccountMapping('wallet:part', 'account', 72, source)
  runtime.setAccountMapping('wallet', 'part:account', 73, source)
  assert.equal(runtime.getAccountMapping('wallet:part', 'account').wasmAccountId, 72)
  assert.equal(runtime.getAccountMapping('wallet', 'part:account').wasmAccountId, 73)
})

test('targeted mapping cleanup handles colon identities exactly across networks and preserves unrelated accounts', () => {
  const { runtime, source } = selectedFrostFeeRuntime()
  for (const network of ['mainnet', 'testnet']) {
    runtime.network = network
    runtime.setAccountMapping('key:wallet', 'account:1', 72, source)
    runtime.setAccountMapping('key:wallet', 'account:2', 73, source)
    runtime.setAccountMapping('other:wallet', 'account:1', 74, source)
  }
  runtime.clearAccountMappingCache('key:wallet', 'account:1')
  for (const network of ['mainnet', 'testnet']) {
    runtime.network = network
    assert.equal(runtime.getAccountMapping('key:wallet', 'account:1'), undefined)
    assert.equal(runtime.getAccountMapping('key:wallet', 'account:2').wasmAccountId, 73)
    assert.equal(runtime.getAccountMapping('other:wallet', 'account:1').wasmAccountId, 74)
  }
  runtime.clearAccountMappingCache('key:wallet')
  for (const network of ['mainnet', 'testnet']) {
    runtime.network = network
    assert.equal(runtime.getAccountMapping('key:wallet', 'account:2'), undefined)
    assert.equal(runtime.getAccountMapping('other:wallet', 'account:1').wasmAccountId, 74)
  }
  runtime.clearAccountMappingCache()
  assert.equal(runtime.accountMappingCache.size, 0)
})
