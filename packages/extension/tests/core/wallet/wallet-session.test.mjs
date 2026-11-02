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

const [{ BackgroundZcashWalletRuntime }, { SecureStorage }, { useWalletStore }] = await Promise.all(
  [
    import('../../../src/background/zcash-wallet-runtime.ts'),
    import('../../../src/core/wallet/secure-storage.ts'),
    import('../../../src/store/wallet-store.ts')
  ]
)

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
