import { after, test } from 'node:test'
import assert from 'node:assert/strict'

test('EVM lending lookup uses the account address and preserves lookup failures', async () => {
  const { checkEvmLendingMcaAccount } =
    await import('../../../src/core/services/lending-service.ts')
  const address = `0x${'Ab'.repeat(20)}`
  const calls = []
  const lookup = async input => {
    calls.push(input)
    return 'linked-mca.near'
  }

  assert.equal(await checkEvmLendingMcaAccount(address, lookup), 'linked-mca.near')
  assert.deepEqual(calls, [{ chain: 'evm', identityKey: address.toLowerCase() }])
  assert.equal(await checkEvmLendingMcaAccount(address, async () => null), null)
  await assert.rejects(
    checkEvmLendingMcaAccount(address, async () => {
      throw new Error('RPC unavailable')
    }),
    /RPC unavailable/
  )
  await assert.rejects(
    checkEvmLendingMcaAccount(address, async () => undefined),
    /Invalid EVM lending account response/
  )
})

const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
Object.defineProperty(globalThis.navigator, 'locks', {
  configurable: true,
  value: { request: async (_name, operation) => operation() }
})
after(() => {
  if (originalLocks === undefined) delete globalThis.navigator.locks
  else Object.defineProperty(globalThis.navigator, 'locks', originalLocks)
})

test('failed lending identity lookup remains retryable with cached markets and clears on reset', async () => {
  const originalChrome = globalThis.chrome
  const originalSetTimeout = globalThis.setTimeout
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  }
  globalThis.chrome = {
    storage: {
      local: storageArea,
      session: storageArea,
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      sendMessage: async () => {
        throw new Error('Request timed out')
      }
    }
  }
  globalThis.setTimeout = callback => {
    queueMicrotask(callback)
    return 0
  }

  try {
    const { useWalletStore } = await import('../../../src/store/wallet-store.ts')
    const { getLendingAccountScope, useLendingStore } =
      await import('../../../src/store/lending-store.ts')
    const context = {
      walletId: 'wallet',
      accountId: 'account',
      network: 'mainnet',
      identity: { kind: 'zcash' }
    }
    useWalletStore.setState({ currentWalletId: 'wallet', currentAccountId: 'account' })
    useLendingStore.setState({
      accountScope: getLendingAccountScope(context),
      dataLoaded: true,
      lastRefreshedAt: Date.now()
    })

    await useLendingStore.getState().checkMcaStatus(context)
    assert.equal(useLendingStore.getState().mcaChecked, false)
    assert.equal(useLendingStore.getState().mcaError, 'Request timed out')
    assert.equal(useLendingStore.getState().dataLoaded, true)

    useLendingStore.getState().reset()
    assert.equal(useLendingStore.getState().mcaError, null)
    assert.equal(useLendingStore.getState().mcaChecked, false)
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    globalThis.setTimeout = originalSetTimeout
    globalThis.chrome = originalChrome
  }
})

test('an older lending identity failure cannot replace a switched account', async () => {
  const originalChrome = globalThis.chrome
  const originalSetTimeout = globalThis.setTimeout
  let rejectLookup
  const pendingLookup = new Promise((_resolve, reject) => {
    rejectLookup = reject
  })
  globalThis.chrome = {
    runtime: { sendMessage: () => pendingLookup }
  }
  globalThis.setTimeout = callback => {
    queueMicrotask(callback)
    return 0
  }

  try {
    const { getLendingAccountScope, useLendingStore } =
      await import('../../../src/store/lending-store.ts')
    const first = {
      walletId: 'old-wallet',
      accountId: 'old-account',
      network: 'mainnet',
      identity: { kind: 'zcash' }
    }
    const next = {
      walletId: 'new-wallet',
      accountId: 'new-account',
      network: 'mainnet',
      identity: { kind: 'zcash' }
    }
    useLendingStore.setState({ accountScope: getLendingAccountScope(first) })
    const previousCheck = useLendingStore.getState().checkMcaStatus(first)
    useLendingStore.getState().reset()
    useLendingStore.setState({ accountScope: getLendingAccountScope(next) })
    rejectLookup(new Error('Old account lookup failed'))
    await previousCheck

    assert.equal(useLendingStore.getState().accountScope, getLendingAccountScope(next))
    assert.equal(useLendingStore.getState().mcaError, null)
    assert.equal(useLendingStore.getState().mcaChecked, false)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.chrome = originalChrome
  }
})

test('A-B-A account switches start a new lending refresh while the first A refresh is pending', async () => {
  const originalChrome = globalThis.chrome
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  }
  globalThis.chrome = { storage: { local: storageArea } }
  let releaseFirst
  const firstCheck = new Promise(resolve => {
    releaseFirst = resolve
  })
  const context = accountId => ({
    walletId: 'wallet',
    accountId,
    network: 'mainnet',
    identity: { kind: 'evm', address: '0x0000000000000000000000000000000000000001' }
  })

  try {
    const { useLendingStore } = await import('../../../src/store/lending-store.ts')
    useLendingStore.getState().reset()
    const checks = []
    useLendingStore.setState({
      checkMcaStatus: async input => {
        checks.push(input.accountId)
        if (input.accountId === 'A' && checks.filter(id => id === 'A').length === 1) {
          await firstCheck
        }
      },
      fetchLendingData: async () => {
        useLendingStore.setState({ dataLoaded: true, isLoadingData: false })
      }
    })

    const oldRefresh = useLendingStore.getState().refreshAll(context('A'))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(checks, ['A'])
    await useLendingStore.getState().refreshAll(context('B'))
    const newRefresh = useLendingStore.getState().refreshAll(context('A'))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(checks, ['A', 'B', 'A'])
    releaseFirst()
    await Promise.all([oldRefresh, newRefresh])
    assert.equal(useLendingStore.getState().accountScope, 'wallet:A:mainnet')
  } finally {
    releaseFirst()
    globalThis.chrome = originalChrome
  }
})
