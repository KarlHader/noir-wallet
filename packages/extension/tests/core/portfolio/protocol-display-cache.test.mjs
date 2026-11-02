import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  deleteLendingMarketCache,
  parseLendingMarketCacheState,
  readLendingMarketCache,
  writeLendingMarketCache
} from '../../../src/infrastructure/lending/chrome-lending-market-cache.ts'
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

function lendingMarket(tokenId = 'eth.bridge.near') {
  return {
    id: tokenId,
    tokenId,
    destinationAssetId: `nep141:${tokenId}`,
    symbol: 'ETH',
    displayName: 'Ether',
    decimals: 18,
    priceUsd: 2500,
    supplyApy: '3.5',
    totalSupplied: '42',
    totalSuppliedUsd: '105000.00',
    supplied: '1.5',
    suppliedUsd: '3750.00'
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

test('materializes bounded dynamic Lending market snapshots', () => {
  const parsed = parseLendingMarketCacheState(
    {
      version: 3,
      entries: {
        'wallet:account': { cachedAt: NOW, markets: [lendingMarket()] }
      }
    },
    NOW
  )

  expect(parsed.entries['wallet:account'].markets[0]).toMatchObject({
    id: 'eth.bridge.near',
    tokenId: 'eth.bridge.near',
    symbol: 'ETH',
    supplied: '1.5'
  })
  expect(() =>
    parseLendingMarketCacheState(
      {
        version: 3,
        entries: {
          'wallet:account': {
            cachedAt: NOW,
            markets: [{ ...lendingMarket(), destinationAssetId: 'nep141:wrong.near' }]
          }
        }
      },
      NOW
    )
  ).toThrow('Invalid cached Lending destination asset ID')
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

test('persists and removes account-scoped Lending market snapshots', async () => {
  const storage = installChromeStorage()
  try {
    await writeLendingMarketCache('wallet-1:account-1', [lendingMarket()])
    await writeLendingMarketCache('wallet-1:account-1:mainnet', [lendingMarket()])
    await writeLendingMarketCache('wallet-1:account-1:testnet', [lendingMarket()])
    await writeLendingMarketCache('wallet-1:account-2:mainnet', [lendingMarket()])
    await expect(readLendingMarketCache('wallet-1:account-1:mainnet')).resolves.toMatchObject([
      { id: 'eth.bridge.near', symbol: 'ETH', supplied: '1.5' }
    ])

    await deleteLendingMarketCache('wallet-1', 'account-1')
    await expect(readLendingMarketCache('wallet-1:account-1')).resolves.toEqual([])
    await expect(readLendingMarketCache('wallet-1:account-1:mainnet')).resolves.toEqual([])
    await expect(readLendingMarketCache('wallet-1:account-1:testnet')).resolves.toEqual([])
    await expect(readLendingMarketCache('wallet-1:account-2:mainnet')).resolves.toHaveLength(1)
  } finally {
    storage.restore()
  }
})
