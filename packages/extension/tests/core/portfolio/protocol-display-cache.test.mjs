import { test } from 'node:test'
import { expect } from '@playwright/test'

import { swapTokenCatalogClient } from '../../../src/popup/services/swap-token-catalog-client.ts'
import { parseSwapTokenCatalogSnapshot } from '../../../src/infrastructure/persistence/chrome-swap-token-catalog-cache.ts'

const NOW = Date.parse('2026-08-23T00:00:00.000Z')

function swapToken(assetId = 'nep141:eth.bridge.near') {
  return {
    assetId,
    blockchain: 'eth',
    contractAddress: null,
    coingeckoId: null,
    decimals: 18,
    price: 2500,
    priceUpdatedAt: '2026-08-22T23:59:00.000Z',
    symbol: 'ETH',
    icon: 'https://img.rhea.finance/images/eth.svg'
  }
}

function installChromeStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const originalChrome = globalThis.chrome
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys]
          return Object.fromEntries(
            requested.filter(key => values.has(key)).map(key => [key, values.get(key)])
          )
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) values.set(key, value)
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
        }
      }
    }
  }
  return {
    values,
    restore() {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  }
}

test('validates and freezes the persisted Swap token catalog', () => {
  const parsed = parseSwapTokenCatalogSnapshot(
    { version: 1, fetchedAt: NOW, tokens: [swapToken()] },
    NOW
  )

  expect(parsed?.tokens[0]).toMatchObject({ symbol: 'ETH', price: 2500 })
  expect(parsed?.tokens[0]).toMatchObject({ contractAddress: null, coingeckoId: null })
  expect(Object.isFrozen(parsed?.tokens)).toBe(true)
  expect(() =>
    parseSwapTokenCatalogSnapshot(
      { version: 1, fetchedAt: NOW, tokens: [swapToken(), swapToken()] },
      NOW
    )
  ).toThrow('Duplicate Swap token asset ID')
  expect(() =>
    parseSwapTokenCatalogSnapshot(
      {
        version: 1,
        fetchedAt: NOW,
        tokens: [{ ...swapToken(), icon: 'http://untrusted.example/token.svg' }]
      },
      NOW
    )
  ).toThrow('Invalid Swap token icon URL')

  const withoutIcon = parseSwapTokenCatalogSnapshot(
    {
      version: 1,
      fetchedAt: NOW,
      tokens: [{ ...swapToken(), icon: '' }]
    },
    NOW
  )
  expect(withoutIcon?.tokens[0]).toMatchObject({ icon: null })
})

test('hydrates the persisted Swap catalog before a network refresh', async () => {
  const now = Date.now()
  const storage = installChromeStorage({
    swap_token_catalog_cache_v1: {
      version: 1,
      fetchedAt: now,
      tokens: [{ ...swapToken(), priceUpdatedAt: new Date(now).toISOString() }]
    }
  })
  try {
    await expect(swapTokenCatalogClient.readCached()).resolves.toMatchObject([
      { assetId: 'nep141:eth.bridge.near', symbol: 'ETH', price: 2500 }
    ])
  } finally {
    storage.restore()
  }
})
