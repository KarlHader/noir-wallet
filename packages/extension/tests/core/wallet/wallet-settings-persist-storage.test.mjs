import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from 'zustand/vanilla'
import { persist } from 'zustand/middleware'
import { createWalletSettingsPersistStorage } from '../../../src/lib/wallet-settings-persist-storage.ts'

function withChromeStorage(initialValue, run) {
  const originalChrome = globalThis.chrome
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const stored = new Map()
  if (initialValue !== undefined) stored.set('wallet_settings', structuredClone(initialValue))

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(stored.get(key)) }
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored.set(key, structuredClone(value))
        }
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, operation) => operation() } }
  })

  return Promise.resolve()
    .then(() => run(stored))
    .finally(() => {
      globalThis.chrome = originalChrome
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
      else delete globalThis.navigator
    })
}

function createSettingsStore() {
  return createStore()(
    persist(
      set => ({
        networkMode: 'mainnet',
        zeroIndexerEnabled: true,
        portfolioChainSelectionByAccount: {},
        setPortfolioChainSelection(scopeKey, chainIds) {
          set(state => ({
            portfolioChainSelectionByAccount: {
              ...state.portfolioChainSelectionByAccount,
              [scopeKey]: chainIds
            }
          }))
        },
        setZeroIndexerEnabled(enabled) {
          set({ zeroIndexerEnabled: enabled })
        }
      }),
      {
        name: 'wallet_settings',
        storage: createWalletSettingsPersistStorage(),
        skipHydration: true,
        merge: (persisted, current) => {
          const value = persisted && typeof persisted === 'object' ? persisted : {}
          return {
            ...current,
            ...value,
            portfolioChainSelectionByAccount: value.portfolioChainSelectionByAccount ?? {}
          }
        },
        partialize: state => ({
          networkMode: state.networkMode,
          zeroIndexerEnabled: state.zeroIndexerEnabled,
          portfolioChainSelectionByAccount: state.portfolioChainSelectionByAccount
        })
      }
    )
  )
}

test('selected portfolio network survives a storage-triggered rehydrate', async () => {
  await withChromeStorage(
    JSON.stringify({ state: { networkMode: 'mainnet', zeroIndexerEnabled: false }, version: 0 }),
    async stored => {
      const store = createSettingsStore()
      await store.persist.rehydrate()
      assert.equal(store.getState().zeroIndexerEnabled, false)

      const scopeKey = JSON.stringify(['wallet', 'account'])
      store.getState().setPortfolioChainSelection(scopeKey, ['eip155:42161'])
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(
        JSON.parse(stored.get('wallet_settings')).state.portfolioChainSelectionByAccount,
        {
          [scopeKey]: ['eip155:42161']
        }
      )

      await store.persist.rehydrate()
      assert.deepEqual(store.getState().portfolioChainSelectionByAccount[scopeKey], [
        'eip155:42161'
      ])
      assert.equal(store.getState().networkMode, 'mainnet')
      assert.equal(store.getState().zeroIndexerEnabled, false)
    }
  )
})

test('object wallet settings envelopes remain readable', async () => {
  const scopeKey = JSON.stringify(['wallet', 'account'])
  await withChromeStorage(
    {
      state: {
        networkMode: 'testnet',
        zeroIndexerEnabled: false,
        portfolioChainSelectionByAccount: { [scopeKey]: ['eip155:42161'] }
      },
      version: 0
    },
    async () => {
      const store = createSettingsStore()
      await store.persist.rehydrate()
      assert.equal(store.getState().networkMode, 'testnet')
      assert.equal(store.getState().zeroIndexerEnabled, false)
      assert.deepEqual(store.getState().portfolioChainSelectionByAccount[scopeKey], [
        'eip155:42161'
      ])
    }
  )
})

test('persisted false zero indexer preference survives a stale store write', async () => {
  await withChromeStorage(
    JSON.stringify({ state: { zeroIndexerEnabled: false }, version: 0 }),
    async stored => {
      const store = createSettingsStore()
      await store.persist.rehydrate()
      store.getState().setZeroIndexerEnabled(true)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(JSON.parse(stored.get('wallet_settings')).state.zeroIndexerEnabled, false)
      await store.persist.rehydrate()
      assert.equal(store.getState().zeroIndexerEnabled, false)
    }
  )
})

test('stale pages cannot replace added or removed custom networks or the active mode', async () => {
  const before = { schemaVersion: 1, customEvmNetworks: [], overrides: [] }
  const added = { ...before, customEvmNetworks: [{ chainId: 'eip155:31337' }] }
  await withChromeStorage(undefined, async stored => {
    const storage = createWalletSettingsPersistStorage()
    for (const [latest, stale] of [
      [added, before],
      [before, added]
    ]) {
      stored.set('wallet_settings', {
        state: {
          networkMode: 'testnet',
          chainEndpointSettings: latest,
          chainEndpointSettingsByNetwork: { mainnet: before, testnet: latest }
        },
        version: 0
      })
      await storage.setItem('wallet_settings', {
        state: {
          networkMode: 'mainnet',
          balancesHidden: true,
          chainEndpointSettings: stale,
          chainEndpointSettingsByNetwork: { mainnet: stale }
        },
        version: 0
      })
      const saved = JSON.parse(stored.get('wallet_settings')).state
      assert.deepEqual(saved.chainEndpointSettings, latest)
      assert.deepEqual(saved.chainEndpointSettingsByNetwork, { mainnet: before, testnet: latest })
      assert.equal(saved.networkMode, 'testnet')
      assert.equal(saved.balancesHidden, true)
    }
  })
})

test('a stale page cannot mask legacy endpoint settings with an empty network partition', async () => {
  const legacy = { schemaVersion: 1, customEvmNetworks: [], overrides: [] }
  await withChromeStorage(
    { state: { chainEndpointSettings: legacy }, version: 0 },
    async stored => {
      await createWalletSettingsPersistStorage().setItem('wallet_settings', {
        state: { chainEndpointSettingsByNetwork: {} },
        version: 0
      })
      const saved = JSON.parse(stored.get('wallet_settings')).state
      assert.deepEqual(saved.chainEndpointSettings, legacy)
      assert.equal(Object.hasOwn(saved, 'chainEndpointSettingsByNetwork'), false)
    }
  )
})
