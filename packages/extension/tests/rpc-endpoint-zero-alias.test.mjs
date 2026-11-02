import { test } from 'node:test'
import assert from 'node:assert/strict'

test('offline upgrade removes a selected custom Zero alias and keeps the privacy opt-out', async () => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let lockTail = Promise.resolve()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request(_name, callback) {
          const operation = lockTail.then(callback)
          lockTail = operation.catch(() => {})
          return operation
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
          zeroIndexerEnabled: false,
          rpcEndpointPreferences: { zcash: 'custom:old-zero' },
          rpcEndpointModes: { zcash: 'fixed' },
          customRpcEndpoints: {
            zcash: [
              { id: 'custom:old-zero', label: 'Private RPC', url: 'https://tee.unsafe.zec.rocks' }
            ]
          }
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
  globalThis.fetch = async () => {
    throw new Error('offline')
  }

  try {
    const rpc = await import('../src/config/rpc-endpoints.ts')
    await rpc.ensureRpcEndpointPreferencesLoaded()
    const state = values.get('wallet_settings').state
    assert.deepEqual(state.rpcEndpointPreferences, { zcash: rpc.AUTOMATIC_RPC_ENDPOINT_ID })
    assert.deepEqual(state.rpcEndpointModes, { zcash: 'auto' })
    assert.deepEqual(state.customRpcEndpoints, { zcash: [] })
    assert.equal(state.zeroIndexerEnabled, false)
    assert.equal(state.autoLockMs, 60000)
  } finally {
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
  }
})
