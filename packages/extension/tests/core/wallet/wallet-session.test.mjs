import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import ts from 'typescript'

const storage = {
  async get() {
    return {}
  },
  async set() {},
  async remove() {}
}
globalThis.location = { href: 'chrome-extension://test/index.html', pathname: '/index.html' }
const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
Object.defineProperty(globalThis.navigator, 'locks', {
  configurable: true,
  value: { request: async (_name, operation) => operation() }
})
globalThis.chrome = {
  storage: { local: storage, session: storage, onChanged: { addListener() {} } },
  runtime: {
    id: 'test',
    getURL: path => `chrome-extension://test${path}`,
    async sendMessage() {}
  }
}

const [
  { BackgroundZcashWalletRuntime },
  { SecureStorage },
  { useWalletStore },
  { credentialSession }
] = await Promise.all([
  import('../../../src/background/zcash-wallet-runtime.ts'),
  import('../../../src/core/wallet/secure-storage.ts'),
  import('../../../src/store/wallet-store.ts'),
  import('../../../src/background/credential-session.ts')
])

after(() => {
  if (originalLocks === undefined) delete globalThis.navigator.locks
  else Object.defineProperty(globalThis.navigator, 'locks', originalLocks)
  delete globalThis.chrome
  delete globalThis.location
})

test('failed unlock activity persistence does not expose a session or start credential restore', async () => {
  const originalState = useWalletStore.getState()
  const originalGetLoginAttempts = SecureStorage.getLoginAttempts
  const originalResetLoginAttempts = SecureStorage.resetLoginAttempts
  const originalSaveLastActivityTime = SecureStorage.saveLastActivityTime
  const runtime = new BackgroundZcashWalletRuntime()
  let restoreStarted = false
  try {
    useWalletStore.setState({
      currentWalletId: 'wallet-1',
      currentAccountId: 'account-1',
      wallets: [
        {
          id: 'wallet-1',
          keySource: 'seed',
          accounts: [{ id: 'account-1', derivationIndex: 0 }]
        }
      ]
    })
    SecureStorage.getLoginAttempts = async () => ({ isLocked: false })
    SecureStorage.resetLoginAttempts = async () => {}
    SecureStorage.saveLastActivityTime = async () => {
      throw new Error('storage unavailable')
    }
    runtime.inspectWalletCredential = async () => ({
      status: 'valid',
      credential: { kind: 'software', seedPhrase: 'test-only' }
    })
    runtime.initialize = async () => {}
    runtime.withWalletCoreLock = async () => {
      restoreStarted = true
    }

    assert.deepEqual(await runtime.unlock('test-only'), {
      success: false,
      failure: 'operation_failed'
    })
    assert.equal(runtime.isLocked(), true)
    assert.equal(runtime.getSessionPassword(), null)
    assert.equal(restoreStarted, false)
  } finally {
    SecureStorage.getLoginAttempts = originalGetLoginAttempts
    SecureStorage.resetLoginAttempts = originalResetLoginAttempts
    SecureStorage.saveLastActivityTime = originalSaveLastActivityTime
    useWalletStore.setState(originalState, true)
  }
})

test('failed first-wallet persistence does not install the session password', async () => {
  const originalState = useWalletStore.getState()
  const originalSaveLastActivityTime = SecureStorage.saveLastActivityTime
  const runtime = new BackgroundZcashWalletRuntime()
  try {
    SecureStorage.saveLastActivityTime = async () => {
      throw new Error('storage unavailable')
    }
    await assert.rejects(
      runtime.setPrimaryWalletState(
        {
          id: 'wallet-1',
          accounts: [
            {
              id: 'account-1',
              addresses: { transparent: '', shielded: '' }
            }
          ]
        },
        'test-only'
      ),
      /storage unavailable/
    )
    assert.equal(runtime.isLocked(), true)
    assert.equal(runtime.getSessionPassword(), null)
  } finally {
    SecureStorage.saveLastActivityTime = originalSaveLastActivityTime
    useWalletStore.setState(originalState, true)
  }
})

test('additional software wallet provision succeeds after selecting a native account', async () => {
  const source = ts.transpileModule(
    readFileSync(
      new URL('../../../src/background/software-wallet-provisioning.ts', import.meta.url),
      'utf8'
    ),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const state = {
    wallets: [{ id: 'retained-wallet' }],
    currentWalletId: null,
    getWallet: () => null
  }
  let credentialLocked = false
  let syncRequests = 0
  let createdFamilies
  const runtime = {
    initialize: async () => {},
    getSessionPassword: () => null,
    unlock: async (_password, options) => {
      if (options?.allowMissingCredentialRecovery === true) {
        state.currentWalletId = 'retained-wallet'
      }
      return { success: state.currentWalletId !== null }
    },
    addNewWallet: async (_mnemonic, _walletName, _accountName, families) => {
      createdFamilies = families
      return { walletId: 'created-wallet' }
    },
    addImportedWallet: async () => 'imported-wallet',
    lock: async () => {}
  }
  const dependencies = {
    '@/core/wallet/hardware-wallet-data': { isZcashHardwareKeySource: () => false },
    '@scure/bip39': { validateMnemonic: () => true },
    '@scure/bip39/wordlists/english': { wordlist: [] },
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    '@/config/wallet': {},
    '@/store/wallet-store': {
      rehydrateWalletStore: async () => {},
      useWalletStore: { getState: () => state }
    },
    '@/infrastructure/keyring/multichain/canonical-mnemonic-generator': {},
    '@/infrastructure/keyring/multichain/background-transport': {},
    './credential-lifecycle': {
      credentialLifecycle: { synchronizeRetainedV1: async () => ({ status: 'synchronized' }) }
    },
    './credential-session': {
      credentialSession: {
        hasUnlockSession: async () => true,
        getProvisioningPassword: async () => 'synthetic-password',
        unlock: async () => ({ unlockedCredentials: [] }),
        bindZcashCredential: async () => true,
        lock: async () => {
          credentialLocked = true
        }
      }
    },
    './sync-scheduler': {
      syncScheduler: {
        pauseForTx() {},
        abortSync() {},
        resumeAfterTx() {},
        onRequestSync() {
          syncRequests++
        }
      }
    },
    '@/core/wallet/account-name': { normalizeAccountName: name => name },
    '@/core/wallet/account-network-selection': {
      parseSelectedNetworkFamilies: value => {
        if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid networks')
        return value
      }
    },
    '@/core/chains/feature-runtime-policy': { isNewWalletFamilyEnabled: () => true }
  }
  const module = { exports: {} }
  new Function('__ENABLED_CHAIN_FEATURE_FLAGS__', 'require', 'module', 'exports', source)(
    [],
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )

  const result = await module.exports.addSoftwareWallet({
    mode: 'import',
    mnemonic: [...Array(11).fill('abandon'), 'about'].join(' '),
    accountName: 'Imported'
  })

  assert.equal(result.walletId, 'imported-wallet')
  assert.equal(credentialLocked, false)

  const created = await module.exports.addSoftwareWallet({
    mode: 'create',
    mnemonic: [...Array(11).fill('abandon'), 'about'].join(' '),
    accountName: 'Created',
    selectedNetworkFamilies: ['evm', 'bitcoin']
  })
  assert.equal(created.walletId, 'created-wallet')
  assert.deepEqual(createdFamilies, ['evm', 'bitcoin'])
  assert.equal(syncRequests, 1)
})

test('same-wallet session restoration preserves an in-flight backup authorization', async () => {
  const originalState = useWalletStore.getState()
  const originalGetBinding = credentialSession.getCredentialBinding
  const originalGetPassword = credentialSession.getProvisioningPassword
  const runtime = new BackgroundZcashWalletRuntime()
  const binding = { globalUnlockEpoch: 1, credentialGenerationId: 'test-generation' }
  let releasePendingBinding = () => {}
  let failRestore = false
  const beginBlockedChallenge = () => {
    let bindingStarted
    const started = new Promise(resolve => {
      bindingStarted = resolve
    })
    const pendingBinding = new Promise(resolve => {
      releasePendingBinding = () => resolve(binding)
    })
    credentialSession.getCredentialBinding = async () => {
      credentialSession.getCredentialBinding = async () => binding
      bindingStarted()
      return pendingBinding
    }
    return {
      started,
      challenge: runtime.getWalletBackupWordIndices('wallet-1'),
      release: () => releasePendingBinding()
    }
  }
  try {
    useWalletStore.setState({
      currentWalletId: 'wallet-1',
      currentAccountId: 'account-1',
      wallets: [
        {
          id: 'wallet-1',
          name: 'Test wallet',
          keySource: 'software',
          createdAt: 1,
          seedPhraseKey: 'seed_wallet-1',
          accounts: [{ id: 'account-1', derivationIndex: 0 }]
        }
      ]
    })
    runtime.withWalletCoreLock = async () => {
      if (failRestore) throw new Error('core busy')
    }
    runtime.inspectWalletCredential = async () => ({
      status: 'valid',
      credential: { kind: 'seed', seedPhrase: 'alpha beta gamma' }
    })
    credentialSession.getProvisioningPassword = async () => 'test-only'

    assert.equal(await runtime.restoreFromCredentialSession('wallet-1', 'account-1'), true)
    const sameWallet = beginBlockedChallenge()
    await sameWallet.started
    assert.equal(await runtime.restoreFromCredentialSession('wallet-1', 'account-1'), true)
    sameWallet.release()
    const indices = await sameWallet.challenge
    assert.equal(indices.length, 2)
    assert.notEqual(indices[0], indices[1])

    const retry = beginBlockedChallenge()
    await retry.started
    failRestore = true
    await assert.rejects(runtime.restoreFromCredentialSession('wallet-1', 'account-1'), /core busy/)
    failRestore = false
    assert.equal(await runtime.restoreFromCredentialSession('wallet-1', 'account-1'), true)
    retry.release()
    assert.equal((await retry.challenge).length, 2)

    const locked = beginBlockedChallenge()
    await locked.started
    await runtime.lock()
    locked.release()
    await assert.rejects(locked.challenge, /Unable to verify this wallet backup/)
  } finally {
    releasePendingBinding()
    credentialSession.getCredentialBinding = originalGetBinding
    credentialSession.getProvisioningPassword = originalGetPassword
    useWalletStore.setState(originalState, true)
  }
})

for (const vendor of ['keystone', 'ledger']) {
  test(`${vendor} restores a cold runtime from an attested session without a software capsule`, async () => {
    const originalState = useWalletStore.getState()
    const originalEpoch = credentialSession.getUnlockEpoch
    const originalPassword = credentialSession.getProvisioningPassword
    const runtime = new BackgroundZcashWalletRuntime()
    let epoch = 'unlock-1'
    let completeInspection = async () => {}
    let restored = 0
    try {
      useWalletStore.setState({
        currentWalletId: 'hardware-wallet',
        currentAccountId: 'hardware-account',
        wallets: [
          {
            id: 'hardware-wallet',
            keySource: vendor,
            createdAt: 1,
            accounts: [{ id: 'hardware-account', derivationIndex: 0 }]
          }
        ]
      })
      credentialSession.getUnlockEpoch = async () => epoch
      credentialSession.getProvisioningPassword = async () => 'synthetic-password'
      runtime.inspectWalletCredential = async () => {
        await completeInspection()
        return { status: 'valid', credential: { kind: 'hardware', hw: {} } }
      }
      runtime.ensureWalletCoreAccount = async (walletId, accountId) => {
        assert.equal(walletId, 'hardware-wallet')
        assert.equal(accountId, 'hardware-account')
        assert.equal(runtime.getSessionPassword(), 'synthetic-password')
        restored++
      }

      assert.equal(runtime.isLocked(), true)
      assert.equal(
        await runtime.restoreFromCredentialSession('hardware-wallet', 'hardware-account'),
        true
      )
      assert.equal(runtime.isLocked(), false)
      assert.equal(restored, 1)

      runtime.beginLock()
      completeInspection = async () => {
        epoch = 'unlock-2'
      }
      assert.equal(
        await runtime.restoreFromCredentialSession('hardware-wallet', 'hardware-account'),
        false
      )
      assert.equal(runtime.isLocked(), true)

      completeInspection = async () => {
        runtime.beginLock()
      }
      assert.equal(
        await runtime.restoreFromCredentialSession('hardware-wallet', 'hardware-account'),
        false
      )
      assert.equal(runtime.getSessionPassword(), null)
      assert.equal(restored, 1)

      runtime.inspectWalletCredential = async () => ({ status: 'missing' })
      await assert.rejects(
        runtime.restoreFromCredentialSession('hardware-wallet', 'hardware-account'),
        /Hardware Wallet credential is unavailable/
      )
      assert.equal(runtime.isLocked(), true)
    } finally {
      credentialSession.getUnlockEpoch = originalEpoch
      credentialSession.getProvisioningPassword = originalPassword
      useWalletStore.setState(originalState, true)
    }
  })
}

const lockFunctionNames = [
  'performWalletLockState',
  'performKeyringRuntimesResetAfterCredentialChange'
]
const backgroundSource = ts.createSourceFile(
  'background/index.ts',
  readFileSync(new URL('../../../src/background/index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const lockDeclarations = backgroundSource.statements.filter(
  statement =>
    ts.isFunctionDeclaration(statement) && lockFunctionNames.includes(statement.name?.text)
)
assert.equal(lockDeclarations.length, lockFunctionNames.length)
const compiledLockFunctions = lockDeclarations
  .map(
    declaration =>
      ts.transpileModule(declaration.getText(backgroundSource), {
        compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
      }).outputText
  )
  .join('\n')

function lockHarness({
  zcashFails = false,
  workerFails = false,
  sessionFails = false,
  drain
} = {}) {
  const state = {
    syncPaused: false,
    syncDrained: false,
    ledgerSigningCancelled: false,
    zcashLocked: false,
    sessionLocked: false,
    workerRecreateAttempted: false,
    workerRecreated: false,
    confidentialSessionsCleared: false
  }
  const zcashError = new Error('Zcash cleanup failed')
  const dependencies = {
    async cancelAllLedgerSigning() {
      state.ledgerSigningCancelled = true
    },
    pendingRequestsManager: { cancelAll() {} },
    syncScheduler: {
      abortSync() {},
      pauseForTx() {
        state.syncPaused = true
      },
      resumeAfterTx() {
        state.syncPaused = false
      },
      async waitForActiveSyncIdle() {
        await drain
        state.syncDrained = true
        return true
      }
    },
    backgroundZcashWalletRuntime: {
      async lock() {
        if (zcashFails) throw zcashError
        state.zcashLocked = true
      }
    },
    credentialSession: {
      async lock() {
        if (sessionFails) throw new Error('Session cleanup failed')
        state.sessionLocked = true
      }
    },
    confidentialFundingStore: {
      async clearAllSessions() {
        state.confidentialSessionsCleared = true
      }
    },
    async forwardKeyringRpcToOffscreen() {
      state.workerRecreateAttempted = true
      if (workerFails) throw new Error('Worker recreation failed')
      state.workerRecreated = true
    },
    chrome: {
      offscreen: {
        async hasDocument() {
          return true
        }
      }
    },
    dappHandler: { async notifyAccountsChanged() {}, clearPermissions() {} },
    evmDAppHandler: { async notifyAccountsChanged() {} },
    bitcoinDAppHandler: { async notifyAccountsChanged() {} },
    solanaDAppHandler: null,
    nearDAppHandler: null,
    multichainSessionDAppHandler: null
  }
  const functions = new Function(
    ...Object.keys(dependencies),
    `${compiledLockFunctions}\nreturn { ${lockFunctionNames.join(', ')} }`
  )(...Object.values(dependencies))
  return { functions, state, zcashError }
}

test('wallet lock drains active sync before recreating workers when Zcash cleanup fails', async () => {
  let releaseDrain
  const drain = new Promise(resolve => {
    releaseDrain = resolve
  })
  const { functions, state, zcashError } = lockHarness({ zcashFails: true, drain })
  const result = functions.performWalletLockState()
  const rejected = assert.rejects(result, error => error === zcashError)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.syncPaused, true)
  assert.equal(state.workerRecreateAttempted, false)
  releaseDrain()
  await rejected
  assert.equal(state.syncDrained, true)
  assert.equal(state.sessionLocked, true)
  assert.equal(state.workerRecreated, true)
  assert.equal(state.syncPaused, false)
})

for (const functionName of lockFunctionNames) {
  test(`${functionName} still locks the multichain session when Zcash cleanup fails`, async () => {
    const { functions, state, zcashError } = lockHarness({ zcashFails: true })
    await assert.rejects(functions[functionName](), error => error === zcashError)
    assert.equal(state.sessionLocked, true)
    assert.equal(state.workerRecreated, true)
    if (functionName === 'performWalletLockState') {
      assert.equal(state.ledgerSigningCancelled, true)
      assert.equal(state.confidentialSessionsCleared, true)
    }
  })

  test(`${functionName} fails closed when the keyring Worker cannot be recreated`, async () => {
    const { functions, state } = lockHarness({ workerFails: true })
    await assert.rejects(functions[functionName](), /Unable to confirm/)
    assert.equal(state.zcashLocked, true)
    assert.equal(state.sessionLocked, true)
    assert.equal(state.workerRecreateAttempted, true)
    assert.equal(state.workerRecreated, false)
  })

  test(`${functionName} fails closed when session cleanup fails`, async () => {
    const { functions, state } = lockHarness({ sessionFails: true })
    await assert.rejects(functions[functionName](), /Unable to confirm/)
    assert.equal(state.zcashLocked, true)
    assert.equal(state.sessionLocked, false)
    assert.equal(state.workerRecreated, true)
  })
}
