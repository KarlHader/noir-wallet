import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createAssetPriceClient } from '../../../src/popup/services/asset-price-client.ts'

function createStorageChanges() {
  const listeners = new Set()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(changes, areaName) {
      for (const listener of listeners) listener(changes, areaName)
    },
    listenerCount() {
      return listeners.size
    }
  }
}

test('notifies Popup listeners when a persisted asset price cache changes', () => {
  const storageChanges = createStorageChanges()
  const client = createAssetPriceClient(async () => ({ result: null }), storageChanges)
  let notifications = 0
  const unsubscribe = client.onCacheChanged(() => {
    notifications += 1
  })

  storageChanges.emit({ unrelated_key: { newValue: true } }, 'local')
  storageChanges.emit({ asset_price_cache_v1: { newValue: {} } }, 'session')
  expect(notifications).toBe(0)

  storageChanges.emit({ asset_price_cache_v1: { newValue: {} } }, 'local')
  storageChanges.emit({ asset_market_change_cache_v1: { newValue: {} } }, 'local')
  storageChanges.emit({ defi_llama_market_change_cache_v1: { newValue: {} } }, 'local')
  storageChanges.emit({ user_asset_market_cache_v1: { newValue: {} } }, 'local')
  storageChanges.emit({ user_asset_one_click_price_cache_v1: { newValue: {} } }, 'local')
  expect(notifications).toBe(5)

  unsubscribe()
  expect(storageChanges.listenerCount()).toBe(0)
})

test('scopes a detail price refresh to the selected asset', async () => {
  const messages = []
  const client = createAssetPriceClient(async message => {
    messages.push(message)
    return { result: null }
  })
  await client.getPrices('refresh', 'eip155:1/slip44:60')
  expect(messages).toEqual([
    { type: 'GET_ASSET_PRICES', action: 'refresh', assetId: 'eip155:1/slip44:60' }
  ])
})
