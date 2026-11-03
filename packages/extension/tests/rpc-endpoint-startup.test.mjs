import { test } from 'node:test'
import assert from 'node:assert/strict'

test('cold startup migrates beta Zero RPC while preserving privacy preference and unrelated settings', async () => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let lockTail = Promise.resolve()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request(_name, callback) {
          const result = lockTail.then(callback)
          lockTail = result.catch(() => {})
          return result
        }
      }
    }
  })
  const values = new Map([
    [
      'wallet_settings',
      {
        state: {
          autoLockMs: 60000,
          feeTier: 'normal',
          rpcEndpointPreferences: { zcash: 'zero-indexer' },
          rpcEndpointModes: { zcash: 'fixed' },
          zeroIndexerDefaultApplied: true,
          zeroIndexerEnabled: false
        },
        version: 0
      }
    ]
  ])
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: values.get(key) }
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) values.set(key, value)
        }
      },
      onChanged: { addListener() {} }
    }
  }
  let releaseFetch
  let fetchStarted
  const waitingForFetch = new Promise(resolve => {
    fetchStarted = resolve
  })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/GetLatestBlock')) throw new Error('synthetic probe unavailable')
    fetchStarted()
    await new Promise(resolve => {
      releaseFetch = resolve
    })
    return new Response(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-10-09T00:00:00.000Z',
        chains: [
          {
            id: 'zcash-mainnet',
            chain: 'zcash',
            network: 'mainnet',
            label: 'Zcash',
            iconChain: 'zec',
            endpoints: [
              { id: 'primary', label: 'Primary', url: 'https://rpc.example.com' },
              { id: 'backup', label: 'Backup', url: 'https://backup.example.com' },
              {
                id: 'zero-alias',
                label: 'Zero alias',
                url: 'https://tee.unsafe.zec.rocks/'
              }
            ]
          }
        ]
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  }

  try {
    const rpc = await import('../src/config/rpc-endpoints.ts')
    const loading = rpc.ensureRpcEndpointPreferencesLoaded()
    await waitingForFetch
    values.set('wallet_settings', {
      ...values.get('wallet_settings'),
      state: {
        ...values.get('wallet_settings').state,
        autoLockMs: 120000,
        feeTier: 'slow'
      }
    })
    releaseFetch()
    await loading

    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')
    assert.equal(rpc.getActiveRpcEndpointMode('zcash'), 'auto')
    assert.equal(rpc.getRpcEndpointOptions('zcash')[0].url, 'https://rpc.example.com')
    assert.deepEqual(values.get('wallet_settings').state.rpcEndpointPreferences, {
      zcash: 'primary'
    })
    assert.equal(values.get('wallet_settings').state.zeroIndexerEnabled, false)
    assert.equal('zeroIndexerDefaultApplied' in values.get('wallet_settings').state, false)
    assert.equal(values.get('wallet_settings').state.autoLockMs, 120000)
    assert.equal(values.get('wallet_settings').state.feeTier, 'slow')

    const probedIds = []
    const startupChoice = await rpc.selectStartupRpcEndpoint('zcash', undefined, async endpoint => {
      probedIds.push(endpoint.id)
      return endpoint.id === 'zero-alias' ? 1 : 2
    })
    assert.equal(startupChoice.id, 'primary')
    assert.deepEqual(probedIds, ['primary', 'backup'])
    assert.equal(rpc.getNextRpcEndpointOption('zcash', 'primary', 'primary').id, 'backup')
    assert.equal(rpc.getNextRpcEndpointOption('zcash', 'primary', 'backup'), undefined)

    await rpc.writePersistedRpcEndpointSettings({
      preferences: { zcash: 'backup' },
      modes: { zcash: 'fixed' },
      customRpcEndpoints: { zcash: [] }
    })
    assert.deepEqual(await rpc.ensureRpcEndpointPreferencesLoaded(), { zcash: 'backup' })
    assert.equal(rpc.getActiveRpcEndpointMode('zcash'), 'fixed')

    await rpc.writePersistedRpcEndpointSettings({
      preferences: { zcash: 'primary' },
      modes: { zcash: 'auto' },
      customRpcEndpoints: { zcash: [] }
    })
    await rpc.syncActiveRpcEndpointPreferencesFromStorage()
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')
    assert.equal(rpc.getActiveRpcEndpointMode('zcash'), 'auto')
    assert.equal(values.get('wallet_settings').state.zeroIndexerEnabled, false)

    rpc.setActiveRpcEndpointOverride('zcash', 'backup')
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'backup')
    rpc.setActiveRpcEndpointOverride('zcash')
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')

    rpc.setActiveRpcEndpointModes({ zcash: 'fixed' })
    rpc.setActiveRpcEndpointOverride('zcash', 'backup')
    const { recordRpcFailure } = await import('../src/config/rpc-failover.ts')
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')
    assert.equal(await recordRpcFailure(), null)
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')
    rpc.setActiveRpcEndpointModes({ zcash: 'auto' })

    rpc.setActiveRpcEndpointOverride('zcash', 'zero-alias')
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')

    rpc.setActiveRpcEndpointPreferences({ zcash: 'zero-alias' })
    rpc.setActiveRpcEndpointModes({ zcash: 'auto' })
    rpc.setActiveRpcEndpointOverride('zcash', 'primary')
    assert.equal(rpc.getActiveRpcEndpointMode('zcash'), 'auto')
    assert.equal(rpc.getActiveRpcEndpointOption('zcash').id, 'primary')
    assert.equal(rpc.getNextRpcEndpointOption('zcash', 'zero-alias', 'zero-alias'), undefined)
  } finally {
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
  }
})
