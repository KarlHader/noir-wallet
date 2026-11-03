import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const typescript = require('typescript')
const ORIGIN = 'https://wallet-app.example'

function loadModule(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  return module.exports
}

function createHarness(t, connection, extraDependencies = {}) {
  const previousChrome = globalThis.chrome
  t.after(() => {
    globalThis.chrome = previousChrome
  })

  const stored = new Map([['connectedDApps', [connection]]])
  const runtimeMessages = []
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, stored.get(k)]))
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored.set(key, value)
        }
      }
    },
    tabs: {
      async query() {
        return []
      }
    },
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message)
      }
    }
  }

  const accountA = {
    id: 'account-a',
    name: 'Account A',
    derivationIndex: 0,
    addresses: { transparent: 'transparent-a', shielded: 'shielded-a' }
  }
  const accountB = {
    id: 'account-b',
    name: 'Account B',
    derivationIndex: 1,
    addresses: { transparent: 'transparent-b', shielded: 'shielded-b' }
  }
  const accountC = {
    id: 'account-c',
    name: 'Account C',
    derivationIndex: 2,
    addresses: { transparent: 'transparent-c', shielded: 'shielded-c' }
  }
  const wallet = { id: 'wallet-a', name: 'Wallet A', accounts: [accountA, accountB, accountC] }
  const walletState = {
    currentWalletId: wallet.id,
    currentAccountId: accountA.id,
    currentNetwork: 'mainnet',
    wallets: [wallet],
    accountDisplayNames: {},
    getCurrentWallet() {
      return walletState.wallets.find(candidate => candidate.id === walletState.currentWalletId)
    },
    getAccount(walletId, accountId) {
      return walletState.wallets
        .find(candidate => candidate.id === walletId)
        ?.accounts.find(account => account.id === accountId)
    }
  }
  const accountManager = {
    isLocked: () => false,
    getCurrentAccount: () =>
      walletState.getCurrentWallet()?.accounts.find(a => a.id === walletState.currentAccountId),
    async waitForAccountReady() {}
  }
  const balance = {
    transparent: '1',
    shielded: '2',
    total: '3',
    spendable: '2',
    available: '2',
    confirmed: { transparent: '1', shielded: '2' },
    pending: { transparent: '0', shielded: '0', total: '0' }
  }
  const managerModule = loadModule('../src/core/dapp/dapp-manager.ts')
  const dappManager = managerModule.DAppManager.getInstance()
  const walletRpcErrors = loadModule('../src/core/zcash/wallet-rpc-errors.ts', {
    './shielding': { MIN_SHIELDING_BALANCE_MESSAGE: 'Insufficient balance' },
    '@/lib/errors': { isRpcEndpointError: () => false }
  })
  const { DAppHandler } = loadModule('../src/background/dapp-handler.ts', {
    '../core/wallet/account-manager': { accountManager },
    '../core/dapp/dapp-manager': { ...managerModule, dappManager },
    './sync-scheduler': { syncScheduler: { requestPassiveSync() {} } },
    '@/store/wallet-store': {
      useWalletStore: { getState: () => walletState },
      rehydrateWalletStore: async () => {}
    },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getBalance: (_network, _walletId, accountId) =>
            accountId === 'account-b' ? { ...balance, total: '99' } : balance
        })
      }
    },
    '@/lib/hardware-capabilities': {
      getHardwareDAppMethodUnavailableReason: () => null
    },
    '@/lib/analytics': {
      ANALYTICS_EVENTS: { DAPP_MESSAGE_SIGNED: 'dapp_message_signed' },
      PAGE_IDS: { DAPP: 'dapp' },
      trackEvent() {}
    },
    '@/config/dapp-matches': loadModule('../src/config/dapp-matches.ts'),
    '@/config/wallet': { WALLET_CONFIG: { SYNC: { DAPP_BALANCE_SYNC_STALE_MS: 30_000 } } },
    '@/core/zcash/wallet-rpc-errors': walletRpcErrors,
    './pending-requests': { pendingRequestsManager: { cancelMatching() {} } },
    ...extraDependencies
  })

  return {
    accountManager,
    dappManager,
    handler: new DAppHandler(),
    walletState,
    balance,
    runtimeMessages,
    reloadManager: () => loadModule('../src/core/dapp/dapp-manager.ts').DAppManager.getInstance()
  }
}

function connection(overrides = {}) {
  return {
    id: 'site-connection',
    name: 'Example',
    host: 'wallet-app.example',
    origin: ORIGIN,
    favicon: '',
    connectedAt: 1,
    lastActiveAt: 1,
    ...overrides
  }
}

test('transaction history is unavailable even to authorized third-party and first-party sites', async t => {
  for (const origin of [ORIGIN, 'https://app.zknoir.com']) {
    await t.test(origin, async t => {
      let historyReads = 0
      const { handler } = createHarness(
        t,
        connection({ origin, boundWalletId: 'wallet-a', boundAccountId: 'account-a' }),
        {
          '@/lib/indexed-db': {
            async loadTransactions() {
              historyReads++
              return []
            }
          }
        }
      )
      await handler.initialize()
      await handler.restorePermissionsFromStorage()

      await assert.rejects(
        handler.handleRequest({ method: 'zcash_getTransactionHistory', origin }),
        /Unknown method: zcash_getTransactionHistory/
      )
      assert.equal(historyReads, 0)
    })
  }
})

test('an accountless legacy connection cannot silently read or restore the current account', async t => {
  const { handler, dappManager, walletState } = createHarness(t, connection())
  await handler.initialize()
  await handler.restorePermissionsFromStorage()

  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
  for (const method of ['zcash_getBalance', 'zcash_getAddresses']) {
    await assert.rejects(handler.handleRequest({ method, origin: ORIGIN }), /zcash_requestAccounts/)
  }

  walletState.currentAccountId = 'account-b'
  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)

  // Explicit Connect approval persists the selected account through this manager API.
  await dappManager.setAuthorizedAccounts(ORIGIN, {}, [
    { walletId: 'wallet-a', accountId: 'account-b' }
  ])
  const reconnected = await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN })
  assert.equal(reconnected.transparent, 'transparent-b')
  assert.deepEqual(
    reconnected.accounts.map(a => a.accountId),
    ['account-b']
  )
})

test('a bound single-account connection survives restore but denies another active account', async t => {
  const { handler, walletState, balance } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  await handler.restorePermissionsFromStorage()

  const connected = await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN })
  assert.equal(connected.transparent, 'transparent-a')
  assert.deepEqual(
    connected.accounts.map(a => a.accountId),
    ['account-a']
  )
  assert.equal(
    (await handler.handleRequest({ method: 'zcash_getBalance', origin: ORIGIN })).total,
    balance.total
  )
  assert.equal(
    (
      await handler.handleRequest({
        method: 'zcash_getBalance',
        origin: ORIGIN,
        params: [{ accountId: 'wallet-a:missing' }]
      })
    ).total,
    '0'
  )

  walletState.currentAccountId = 'account-b'
  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
  await assert.rejects(
    handler.handleRequest({ method: 'zcash_getBalance', origin: ORIGIN }),
    /zcash_requestAccounts/
  )
})

test('balance reads stay bound to the authorized account across an async state change', async t => {
  for (const transition of ['switch', 'revoke', 'lock']) {
    await t.test(transition, async t => {
      const { handler, accountManager, dappManager, walletState, balance } = createHarness(
        t,
        connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
      )
      await handler.initialize()
      const resolveBalances = handler.resolveAccountBalances.bind(handler)
      handler.resolveAccountBalances = async origin => {
        const accounts = await resolveBalances(origin)
        if (transition === 'switch') walletState.currentAccountId = 'account-b'
        if (transition === 'revoke') await dappManager.removeConnection(ORIGIN)
        if (transition === 'lock') accountManager.isLocked = () => true
        return accounts
      }

      const reading = handler.handleRequest({ method: 'zcash_getBalance', origin: ORIGIN })
      if (transition === 'switch') {
        const result = await reading
        assert.equal(result.total, balance.total)
        assert.deepEqual(
          result.accounts.map(account => account.accountId),
          ['account-a']
        )
      } else {
        await assert.rejects(reading, /Reconnect and try again/)
      }
    })
  }
})

test('multi-account authorization accepts only selected accounts', async t => {
  const { handler, walletState } = createHarness(
    t,
    connection({
      boundWalletId: 'wallet-a',
      boundAccountId: 'account-a',
      authorizedAccounts: [
        { walletId: 'wallet-a', accountId: 'account-a' },
        { walletId: 'wallet-a', accountId: 'account-b' }
      ]
    })
  )
  await handler.initialize()
  walletState.currentAccountId = 'account-b'

  const connected = await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN })
  assert.equal(connected.transparent, 'transparent-b')
  assert.deepEqual(
    connected.accounts.map(a => a.accountId),
    ['account-a', 'account-b']
  )

  walletState.currentAccountId = 'account-c'
  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
})

test('an account binding cannot authorize the same account ID in another wallet', async t => {
  const { handler, walletState } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  walletState.wallets.push({
    id: 'wallet-b',
    name: 'Wallet B',
    accounts: [
      {
        ...walletState.wallets[0].accounts[0],
        addresses: { transparent: 'transparent-other-wallet', shielded: 'shielded-other-wallet' }
      }
    ]
  })
  await handler.initialize()
  await handler.restorePermissionsFromStorage()
  walletState.currentWalletId = 'wallet-b'
  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
  await assert.rejects(
    handler.handleRequest({ method: 'zcash_getBalance', origin: ORIGIN }),
    /zcash_requestAccounts/
  )
})

test('the exact trusted origin still auto-connects all wallet accounts', async t => {
  const trustedOrigin = 'https://app.zknoir.com'
  const { handler, dappManager } = createHarness(
    t,
    connection({ origin: trustedOrigin, host: 'app.zknoir.com' })
  )
  await handler.initialize()

  const connected = await handler.handleRequest({
    method: 'zcash_getAccounts',
    origin: trustedOrigin
  })
  assert.deepEqual(
    connected.accounts.map(a => a.accountId),
    ['account-a', 'account-b', 'account-c']
  )
  assert.deepEqual(await dappManager.getAuthorizedAccounts(trustedOrigin), [
    { walletId: 'wallet-a', accountId: 'account-a' },
    { walletId: 'wallet-a', accountId: 'account-b' },
    { walletId: 'wallet-a', accountId: 'account-c' }
  ])
})

test('explicit first-party revocation persists across managers and requires a new approval', async t => {
  const origin = 'https://app.zknoir.com'
  const { handler, dappManager, reloadManager } = createHarness(t, connection({ origin }))
  await handler.initialize()
  await handler.handleRequest({ method: 'zcash_getAccounts', origin })
  handler.broadcastEvent = async () => {}
  await handler.revokePermission(origin)
  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin }), null)
  await assert.rejects(
    handler.handleRequest({ method: 'zcash_getBalance', origin }),
    /Not authorized/
  )
  const restarted = reloadManager()
  assert.equal(await restarted.canAutoConnect(origin), false)
  assert.equal(await restarted.isRevoked(origin), true)
  let approvals = 0
  handler.runConnectApproval = async () => {
    approvals++
    throw new Error('approval required')
  }
  await assert.rejects(
    handler.handleRequest({ method: 'zcash_requestAccounts', origin }),
    /approval required/
  )
  assert.equal(approvals, 1)
  await restarted.setAuthorizedAccounts(origin, {}, [
    { walletId: 'wallet-a', accountId: 'account-a' }
  ])
  assert.equal(await restarted.canAutoConnect(origin), false)
  const connected = await handler.handleRequest({ method: 'zcash_getAccounts', origin })
  assert.deepEqual(
    connected.accounts.map(a => a.accountId),
    ['account-a']
  )
})

test('a grant started before revocation cannot restore a connection', async t => {
  const { dappManager } = createHarness(t, connection())
  const revision = await dappManager.getAuthorizationRevision(ORIGIN)
  await dappManager.removeConnection(ORIGIN)
  await assert.rejects(
    dappManager.setAuthorizedAccounts(
      ORIGIN,
      {},
      [{ walletId: 'wallet-a', accountId: 'account-a' }],
      { expectedRevision: revision }
    ),
    /authorization changed/
  )
  assert.equal(await dappManager.isConnected(ORIGIN), false)
})

test('authorization reads wait for an in-flight revocation write', async t => {
  const { dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  const originalSet = chrome.storage.local.set
  let signalWrite
  let releaseWrite
  const writing = new Promise(resolve => {
    signalWrite = resolve
  })
  const writeGate = new Promise(resolve => {
    releaseWrite = resolve
  })
  chrome.storage.local.set = async values => {
    signalWrite()
    await writeGate
    return originalSet(values)
  }

  const revoking = dappManager.removeConnection(ORIGIN)
  await writing
  const reading = dappManager.getAuthorizedAccounts(ORIGIN)
  releaseWrite()
  await revoking
  assert.deepEqual(await reading, [])
})

test('account change does not notify a site revoked after the connection snapshot', async t => {
  const { handler, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  const events = []
  handler.broadcastEvent = async (origin, event, payload) => {
    events.push({ origin, event, payload })
  }
  const getAllConnections = dappManager.getAllConnections.bind(dappManager)
  dappManager.getAllConnections = async () => {
    const connections = await getAllConnections()
    await dappManager.removeConnection(ORIGIN)
    return connections
  }

  await handler.notifyAccountsChanged({ transparent: 'transparent-a', shielded: 'shielded-a' })
  assert.deepEqual(events, [{ origin: ORIGIN, event: 'accountsChanged', payload: null }])
  assert.equal(
    handler.getPermissions().some(permission => permission.origin === ORIGIN),
    false
  )
})

test('getAccounts does not return addresses after revocation during account resolution', async t => {
  const { handler, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  await handler.restorePermissionsFromStorage()
  handler.resolveAccounts = async () => {
    await dappManager.removeConnection(ORIGIN)
    return []
  }

  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
})

test('connect approval does not return addresses after a concurrent revocation', async t => {
  const { handler, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  handler.runConnectApproval = async () => [
    {
      id: 'wallet-a:account-a',
      label: 'Account A',
      walletId: 'wallet-a',
      accountId: 'account-a',
      addresses: { transparent: 'transparent-a', shielded: 'shielded-a' }
    }
  ]
  const updateConnectionBinding = dappManager.updateConnectionBinding.bind(dappManager)
  dappManager.updateConnectionBinding = async (origin, binding) => {
    await dappManager.removeConnection(origin)
    return updateConnectionBinding(origin, binding)
  }

  await assert.rejects(
    handler.handleRequest({ method: 'zcash_requestAccounts', origin: ORIGIN }),
    /Reconnect and try again/
  )
  assert.equal(
    handler.getPermissions().some(permission => permission.origin === ORIGIN),
    false
  )
})

test(
  'cancellation settles approval while its window is still being created',
  { timeout: 2000 },
  async t => {
    const { pendingRequestsManager: pending } = loadModule('../src/background/pending-requests.ts')
    t.after(() => pending.cancelMatching(() => true))
    const listeners = new Set()
    const removedWindows = []
    let signalCreate
    let releaseCreate
    const creating = new Promise(resolve => {
      signalCreate = resolve
    })
    const createGate = new Promise(resolve => {
      releaseCreate = resolve
    })
    const { handler } = createHarness(
      t,
      connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' }),
      {
        './pending-requests': { pendingRequestsManager: pending },
        './approval-context': {
          getApprovalContext: async id => {
            const request = pending.get(id)
            if (!request) throw new Error('Request expired')
            return request
          }
        },
        '@/config/ui': { UI_CONFIG: { DAPP_WINDOW: { WIDTH: 400, HEIGHT: 600 } } },
        './window-manager': { closeAllPopupWindows: async () => {} }
      }
    )
    chrome.runtime.onMessage = {
      addListener(listener) {
        listeners.add(listener)
      },
      removeListener(listener) {
        listeners.delete(listener)
      }
    }
    chrome.windows = {
      getLastFocused: async () => ({ left: 0, width: 1000, top: 0 }),
      create: async () => {
        signalCreate()
        await createGate
        return { id: 42 }
      },
      remove: async id => {
        removedWindows.push(id)
      }
    }

    const approval = handler.requestUserApprovalWithId(ORIGIN, 'sendTransaction', {})
    const first = await Promise.race([
      creating.then(() => 'creating'),
      approval.then(
        result => `settled: ${result.approved}`,
        error => `failed: ${error}`
      )
    ])
    assert.equal(first, 'creating')
    pending.cancelMatching(request => request.origin === ORIGIN)
    assert.equal((await approval).approved, false)
    assert.equal(listeners.size, 0)
    assert.equal(pending.timers.size, 0)
    releaseCreate()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(removedWindows, [42])
  }
)

test(
  'approval listener leaves unrelated runtime messages for their own handler',
  { timeout: 2000 },
  async t => {
    const { pendingRequestsManager: pending } = loadModule('../src/background/pending-requests.ts')
    t.after(() => pending.cancelMatching(() => true))
    const listeners = new Set()
    let contextChecks = 0
    let resolveWindow
    const windowOpened = new Promise(resolve => {
      resolveWindow = resolve
    })
    const { handler } = createHarness(
      t,
      connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' }),
      {
        './pending-requests': { pendingRequestsManager: pending },
        './approval-context': {
          getApprovalContext: async id => {
            contextChecks++
            const request = pending.get(id)
            if (!request) throw new Error('Request expired')
            return request
          }
        },
        '@/config/ui': { UI_CONFIG: { DAPP_WINDOW: { WIDTH: 400, HEIGHT: 600 } } },
        './window-manager': { closeAllPopupWindows: async () => {} }
      }
    )
    chrome.runtime.onMessage = {
      addListener(listener) {
        listeners.add(listener)
      },
      removeListener(listener) {
        listeners.delete(listener)
      }
    }
    chrome.windows = {
      getLastFocused: async () => ({ left: 0, width: 1000, top: 0 }),
      create: async options => {
        resolveWindow(new URLSearchParams(options.url.split('?')[1]).get('requestId'))
        return { id: 42 }
      },
      get: (_id, callback) => callback({ id: 42 }),
      remove: async () => {}
    }

    const approval = handler.requestUserApprovalWithId(ORIGIN, 'sendTransaction', {})
    const requestId = await windowOpened
    assert.equal(listeners.size, 1)
    const [listener] = listeners
    assert.equal(listener({ type: 'GET_PENDING_REQUEST', requestId }), undefined)
    assert.equal(pending.get(requestId)?.id, requestId)
    assert.equal(listener({ type: 'DAPP_APPROVAL_RESULT', requestId, success: true }), undefined)

    assert.equal((await approval).approved, true)
    assert.equal(contextChecks, 2)
    assert.equal(listeners.size, 0)
    assert.equal(pending.get(requestId), null)
    assert.equal(pending.timers.size, 0)
  }
)

test('invalid persisted account references do not authorize a site', async t => {
  const { handler } = createHarness(
    t,
    connection({
      boundWalletId: 'wallet-a',
      boundAccountId: '',
      authorizedAccounts: [null, { walletId: 'wallet-a', accountId: '' }, 'account-a']
    })
  )
  await handler.initialize()

  assert.equal(await handler.handleRequest({ method: 'zcash_getAccounts', origin: ORIGIN }), null)
  await assert.rejects(
    handler.handleRequest({ method: 'zcash_getBalance', origin: ORIGIN }),
    /zcash_requestAccounts/
  )
})

test('approval cannot sign after the site connection is revoked', async t => {
  const { handler, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  handler.requestUserApproval = async () => {
    await dappManager.removeConnection(ORIGIN)
    return { approved: true, walletId: 'wallet-a', accountId: 'account-a' }
  }

  await assert.rejects(handler.signMessage(ORIGIN, 'synthetic-message'), /Reconnect and try again/)
})

test('lock during authorization lookup prevents an approved signature', async t => {
  const { handler, accountManager, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  handler.requestUserApproval = async () => ({
    approved: true,
    walletId: 'wallet-a',
    accountId: 'account-a'
  })
  let signalLookup
  let releaseLookup
  const lookupStarted = new Promise(resolve => {
    signalLookup = resolve
  })
  const lookupGate = new Promise(resolve => {
    releaseLookup = resolve
  })
  const getAuthorization = dappManager.getAuthorization.bind(dappManager)
  dappManager.getAuthorization = async origin => {
    signalLookup()
    await lookupGate
    return getAuthorization(origin)
  }

  const signing = handler.signMessage(ORIGIN, 'synthetic-message')
  await lookupStarted
  accountManager.isLocked = () => true
  releaseLookup()
  await assert.rejects(signing, /Reconnect and try again/)
})

test('an approved signature stays bound to its captured account after an account switch', async t => {
  const { handler, accountManager, walletState } = createHarness(
    t,
    connection({
      boundWalletId: 'wallet-a',
      boundAccountId: 'account-a',
      authorizedAccounts: [
        { walletId: 'wallet-a', accountId: 'account-a' },
        { walletId: 'wallet-a', accountId: 'account-b' }
      ]
    })
  )
  await handler.initialize()
  handler.requestUserApproval = async () => {
    walletState.currentAccountId = 'account-b'
    return { approved: true, walletId: 'wallet-a', accountId: 'account-a' }
  }
  const coreRequests = []
  const signingIndexes = []
  accountManager.getWalletCore = async (walletId, accountId) => {
    coreRequests.push({ walletId, accountId })
    return {
      async signMessage(_message, accountIndex) {
        signingIndexes.push(accountIndex)
        return {
          signature: 'synthetic-signature',
          pubkey: 'synthetic-pubkey',
          address: 'synthetic'
        }
      }
    }
  }

  const result = await handler.signMessage(ORIGIN, 'synthetic-message')
  assert.equal(result.signature, 'synthetic-signature')
  assert.deepEqual(coreRequests, [{ walletId: 'wallet-a', accountId: 'account-a' }])
  assert.deepEqual(signingIndexes, [0])
})

test('a revoked and reapproved account cannot reuse an earlier signature approval', async t => {
  const { handler, accountManager, dappManager } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  const authorizationRevision = await dappManager.getAuthorizationRevision(ORIGIN)
  handler.requestUserApproval = async () => ({
    approved: true,
    walletId: 'wallet-a',
    accountId: 'account-a',
    authorizationRevision
  })
  let signed = false
  accountManager.getWalletCore = async () => {
    await dappManager.removeConnection(ORIGIN)
    await dappManager.setAuthorizedAccounts(ORIGIN, {}, [
      { walletId: 'wallet-a', accountId: 'account-a' }
    ])
    return {
      signMessage: async () => {
        signed = true
      }
    }
  }

  await assert.rejects(handler.signMessage(ORIGIN, 'synthetic-message'), /Reconnect and try again/)
  assert.equal(signed, false)
})

test('revoked transaction approval fails without leaving the approval window pending', async t => {
  const { handler, dappManager, runtimeMessages } = createHarness(
    t,
    connection({ boundWalletId: 'wallet-a', boundAccountId: 'account-a' })
  )
  await handler.initialize()
  handler.requestUserApprovalWithId = async () => {
    await dappManager.removeConnection(ORIGIN)
    return {
      approved: true,
      requestId: 'synthetic-request',
      walletId: 'wallet-a',
      accountId: 'account-a'
    }
  }

  await assert.rejects(
    handler.sendTransaction(ORIGIN, { to: `t1${'A'.repeat(33)}`, amount: '1' }),
    /Reconnect and try again/
  )
  assert.deepEqual(runtimeMessages, [
    {
      type: 'DAPP_TX_RESULT',
      requestId: 'synthetic-request',
      success: false,
      error: 'Wallet account or site connection changed. Reconnect and try again.'
    }
  ])
})
