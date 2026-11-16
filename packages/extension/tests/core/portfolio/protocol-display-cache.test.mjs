import { test } from 'node:test'
import { expect } from '@playwright/test'

import { swapTokenCatalogClient } from '../../../src/popup/services/swap-token-catalog-client.ts'
import { parseSwapTokenCatalogSnapshot } from '../../../src/infrastructure/persistence/chrome-swap-token-catalog-cache.ts'
import { PersistentRheaSwapCatalogCache } from '../../../src/infrastructure/persistence/rhea-swap-catalog-cache.ts'
import { RHEA_SWAP_TOKEN_CATALOG_TTL_MS } from '../../../src/core/services/rhea-swap/index.ts'

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

function publicCatalog(chainId = 1) {
  return {
    tokens: [
      {
        assetId: 'nep141:eth.omft.near',
        blockchain: chainId === 1 ? 'eth' : 'base',
        contractAddress: null,
        decimals: 18,
        icon: null,
        price: 2500,
        priceUpdatedAt: new Date(NOW).toISOString(),
        symbol: 'ETH',
        rheaChainId: String(chainId),
        tokenListChainId: chainId,
        rheaAddress: '0x0000000000000000000000000000000000000000',
        isNative: true,
        sources: ['nearIntents']
      }
    ],
    failedChainIds: []
  }
}

function publicCatalogStorage() {
  const responses = new Map()
  return {
    responses,
    async open() {
      return {
        async match(key) {
          return responses.get(key)?.clone()
        },
        async put(key, response) {
          responses.set(key, response.clone())
        }
      }
    }
  }
}

test('shares public RHEA catalogs across callers and Background lifetimes, keeping chain and direction separate', async () => {
  const storage = publicCatalogStorage()
  let now = NOW
  const calls = []
  const load = async input => {
    calls.push(input)
    return publicCatalog(input.tokenListChainIds[0])
  }
  const request = { direction: 'from', tokenListChainIds: [1] }
  const first = new PersistentRheaSwapCatalogCache(load, storage, () => now)
  const [a, b] = await Promise.all([first.read(request), first.read(request)])
  expect(a.tokens).toEqual(b.tokens)
  expect(calls).toHaveLength(1)

  const restarted = new PersistentRheaSwapCatalogCache(load, storage, () => now)
  expect((await restarted.read(request)).tokens).toEqual(a.tokens)
  expect(calls).toHaveLength(1)
  await restarted.read({ ...request, direction: 'cross-chain-to' })
  await restarted.read({ ...request, tokenListChainIds: [8453] })
  expect(calls).toHaveLength(3)
  now += RHEA_SWAP_TOKEN_CATALOG_TTL_MS
  await restarted.read(request)
  expect(calls).toHaveLength(4)
})

test('does not retain failed, empty or capability-incomplete public catalogs', async () => {
  const storage = publicCatalogStorage()
  const complete = publicCatalog()
  const responses = [
    { tokens: [], failedChainIds: [1] },
    { tokens: [], failedChainIds: [] },
    { ...complete, tokens: complete.tokens.map(token => ({ ...token, sources: [] })) },
    complete
  ]
  let calls = 0
  const cache = new PersistentRheaSwapCatalogCache(
    async () => {
      calls++
      return responses.shift()
    },
    storage,
    () => NOW
  )
  const request = { direction: 'from', tokenListChainIds: [1] }
  for (let i = 0; i < 3; i++) {
    await cache.read(request)
    expect(storage.responses.size).toBe(0)
  }
  await cache.read(request)
  await cache.read(request)
  expect(calls).toBe(4)
  expect(storage.responses.size).toBe(1)
})

test('rejects a cached catalog from another chain and keeps usable chains when one live read fails', async () => {
  const storage = publicCatalogStorage()
  await new PersistentRheaSwapCatalogCache(
    async () => publicCatalog(),
    storage,
    () => NOW
  ).read({ direction: 'from', tokenListChainIds: [1] })
  const key = [...storage.responses.keys()][0]
  const snapshot = await storage.responses.get(key).json()
  storage.responses.set(
    key,
    new Response(JSON.stringify({ ...snapshot, result: publicCatalog(8453) }))
  )
  let calls = 0
  const cache = new PersistentRheaSwapCatalogCache(
    async input => {
      calls++
      if (input.tokenListChainIds[0] === 8453) throw new Error('Unavailable')
      return publicCatalog()
    },
    storage,
    () => NOW
  )
  const result = await cache.read({ direction: 'from', tokenListChainIds: [1, 8453] })
  expect(result.tokens).toEqual(publicCatalog().tokens)
  expect(result.failedChainIds).toEqual([8453])
  expect(calls).toBe(2)
})
