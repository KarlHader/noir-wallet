import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getUserAssetDexPoolDiscoveryPolicy } from '../../../src/config/user-asset-market-policy.ts'
import { mergeAssetPriceModels } from '../../../src/background/asset-prices.ts'
import {
  DEX_SCREENER_PAIR_URL,
  OneClickAssetPriceService,
  preferUserAssetDexPrices,
  UserAssetDexPriceService
} from '../../../src/infrastructure/prices/index.ts'

const NOW = Date.parse('2026-08-15T04:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ASSET_ID = `eip155:1/erc20:${TOKEN}`
const PAIR = '0x2222222222222222222222222222222222222222'

function mapping() {
  const policy = getUserAssetDexPoolDiscoveryPolicy('eip155:1')
  return Object.freeze({
    assetId: ASSET_ID,
    dexScreenerChainId: policy.dexScreenerChainId,
    dexId: policy.allowedDexIds[0],
    pairAddress: PAIR,
    baseTokenAddress: TOKEN,
    quoteTokenAddress: policy.allowedQuoteTokenAddresses[0],
    discoveredAt: NOW,
    expiresAt: NOW + policy.mappingTtlMs
  })
}

function createCaches(poolMapping = null) {
  let marketSnapshot = null
  return {
    pool: {
      get: async assetId => (poolMapping?.assetId === assetId ? poolMapping : null),
      put: async value => {
        poolMapping = value
      },
      delete: async assetId => {
        if (poolMapping?.assetId === assetId) poolMapping = null
      }
    },
    market: {
      get: async () => marketSnapshot,
      put: async value => {
        marketSnapshot = value
      }
    }
  }
}

test('discovers an exact custom Token Pool and serves its validated price and 24h change', async () => {
  const pool = mapping()
  const caches = createCaches()
  const requests = []
  const service = new UserAssetDexPriceService({
    assetIds: [ASSET_ID],
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    discovery: {
      discover: async assetId => {
        expect(assetId).toBe(ASSET_ID)
        await caches.pool.put(pool)
        return { status: 'available', source: 'network', pool, observedPriceUsd: '1.25' }
      }
    },
    poolCache: caches.pool,
    marketCache: caches.market,
    now: () => NOW,
    fetch: async url => {
      requests.push(String(url))
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: pool.dexScreenerChainId,
              dexId: pool.dexId,
              pairAddress: pool.pairAddress,
              baseToken: { address: pool.baseTokenAddress },
              quoteToken: { address: pool.quoteTokenAddress },
              priceUsd: '1.24',
              priceChange: { h24: 2.5 },
              liquidity: { usd: 500_000 },
              volume: { h24: 50_000 }
            }
          ]
        })
      )
    }
  })

  expect(service.hasAsset(ASSET_ID.replace(TOKEN, TOKEN.toUpperCase().replace('0X', '0x')))).toBe(
    true
  )

  await expect(service.refresh()).resolves.toEqual({
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: NOW,
    quotes: [
      {
        assetId: ASSET_ID,
        source: 'dex-screener',
        priceUsd: '1.24',
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
        freshness: 'fresh',
        marketChange: {
          source: 'dex-screener',
          percent24h: '2.5',
          fetchedAt: NOW,
          freshness: 'fresh'
        }
      }
    ],
    missingAssetIds: []
  })
  expect(requests).toEqual([`${DEX_SCREENER_PAIR_URL}/ethereum/${PAIR}`])

  await expect(service.readCached()).resolves.toMatchObject({
    status: 'ready',
    quotes: [{ assetId: ASSET_ID, priceUsd: '1.24' }]
  })
  expect(requests).toHaveLength(1)
})

test('refreshes a newly added Token without requesting older Tokens or losing their cached prices', async () => {
  const oldToken = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const oldAssetId = `eip155:1/erc20:${oldToken}`
  const pool = mapping()
  let discoveredPool = null
  let marketSnapshot = {
    version: 1,
    fetchedAt: NOW,
    quotes: [
      {
        marketAssetId: `ua-1-${oldToken.slice(2)}`,
        percent24h: '0',
        observedPriceUsd: '1.1',
        fetchedAt: NOW
      }
    ]
  }
  let fallbackSnapshot = {
    version: 1,
    fetchedAt: NOW - 61_000,
    quotes: [{ assetId: oldAssetId, priceUsd: '1.1', sourceUpdatedAt: NOW }]
  }
  const discovered = []
  const pairRequests = []
  const fallbackRequests = []
  const fallback = new OneClickAssetPriceService({
    mappings: [oldToken, TOKEN].map(contract => ({
      assetId: `eip155:1/erc20:${contract}`,
      marketAssetId: `ua-1-${contract.slice(2)}`,
      sourceBlockchain: 'eth',
      sourceContractAddress: contract,
      sourceDecimals: 18
    })),
    cache: {
      get: async () => fallbackSnapshot,
      put: async value => { fallbackSnapshot = value }
    },
    now: () => NOW,
    fetch: async () => {
      fallbackRequests.push('tokens')
      return new Response(JSON.stringify([
        {
          assetId: 'old', blockchain: 'eth', contractAddress: oldToken,
          decimals: 18, price: fallbackRequests.length === 1 ? -1 : 1.1,
          priceUpdatedAt: new Date(NOW).toISOString()
        },
        {
          assetId: 'new', blockchain: 'eth', contractAddress: TOKEN,
          decimals: 18, price: 1.25, priceUpdatedAt: new Date(NOW).toISOString()
        }
      ]))
    }
  })
  const service = new UserAssetDexPriceService({
    assetIds: [oldAssetId, ASSET_ID],
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    discovery: {
      discover: async assetId => {
        discovered.push(assetId)
        discoveredPool = pool
        return { status: 'available', source: 'network', pool, observedPriceUsd: '1.25' }
      }
    },
    poolCache: {
      get: async assetId => assetId === ASSET_ID ? discoveredPool : null,
      put: async () => {},
      delete: async () => {}
    },
    marketCache: {
      get: async () => marketSnapshot,
      put: async value => { marketSnapshot = value }
    },
    fallback,
    now: () => NOW,
    fetch: async url => {
      pairRequests.push(String(url))
      return new Response(JSON.stringify({ pairs: [{
        chainId: pool.dexScreenerChainId,
        dexId: pool.dexId,
        pairAddress: pool.pairAddress,
        baseToken: { address: pool.baseTokenAddress },
        quoteToken: { address: pool.quoteTokenAddress },
        priceUsd: '1.24',
        priceChange: { h24: 2.5 },
        liquidity: { usd: 500_000 },
        volume: { h24: 50_000 }
      }] }))
    }
  })

  await expect(service.refresh(ASSET_ID)).resolves.toMatchObject({
    status: 'ready',
    quotes: [
      { assetId: oldAssetId, priceUsd: '1.1' },
      { assetId: ASSET_ID, priceUsd: '1.24' }
    ]
  })
  expect(discovered).toEqual([ASSET_ID])
  expect(pairRequests).toEqual([`${DEX_SCREENER_PAIR_URL}/ethereum/${PAIR}`])
  expect(fallbackRequests).toEqual(['tokens'])
  expect(fallbackSnapshot.fetchedAt).toBe(NOW - 61_000)
  expect(fallbackSnapshot.quotes).toEqual(expect.arrayContaining([
    expect.objectContaining({ assetId: oldAssetId, priceUsd: '1.1' })
  ]))
  expect(marketSnapshot.quotes).toHaveLength(2)
  await fallback.refresh()
  expect(fallbackRequests).toEqual(['tokens', 'tokens'])
  expect(fallbackSnapshot.fetchedAt).toBe(NOW)
})

test('does not invent prices for testnet or for assets without a qualified Pool', async () => {
  const testnetAsset = 'eip155:11155111/erc20:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  let discoveryCount = 0
  const caches = createCaches()
  const service = new UserAssetDexPriceService({
    assetIds: [testnetAsset],
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    discovery: {
      discover: async () => {
        discoveryCount += 1
        return { status: 'unavailable' }
      }
    },
    poolCache: caches.pool,
    marketCache: caches.market,
    now: () => NOW,
    fetch: async () => {
      throw new Error('Testnet market data must not be queried')
    }
  })

  await expect(service.refresh()).resolves.toEqual({
    source: 'wallet-market-data',
    status: 'error',
    fetchedAt: NOW,
    quotes: [],
    missingAssetIds: [testnetAsset]
  })
  expect(discoveryCount).toBe(0)
})

test('falls back to 1Click only through an exact blockchain, contract, and decimals match', async () => {
  const caches = createCaches()
  let fallbackSnapshot = null
  const fallback = new OneClickAssetPriceService({
    mappings: [
      {
        assetId: ASSET_ID,
        marketAssetId: `ua-1-${TOKEN.slice(2)}`,
        sourceBlockchain: 'eth',
        sourceContractAddress: TOKEN,
        sourceDecimals: 18
      }
    ],
    cache: {
      get: async () => fallbackSnapshot,
      put: async value => {
        fallbackSnapshot = value
      }
    },
    now: () => NOW,
    fetch: async () =>
      new Response(
        JSON.stringify([
          {
            assetId: 'nep141:eth-impostor.omft.near',
            blockchain: 'eth',
            contractAddress: '0x9999999999999999999999999999999999999999',
            decimals: 18,
            symbol: 'TEST',
            price: 99,
            priceUpdatedAt: new Date(NOW).toISOString()
          },
          {
            assetId: 'nep141:eth-test.omft.near',
            blockchain: 'eth',
            contractAddress: TOKEN.toUpperCase().replace('0X', '0x'),
            decimals: 18,
            symbol: 'TEST',
            price: 1.2,
            priceUpdatedAt: new Date(NOW).toISOString()
          }
        ])
      )
  })
  const service = new UserAssetDexPriceService({
    assetIds: [ASSET_ID],
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    discovery: { discover: async () => ({ status: 'unavailable' }) },
    poolCache: caches.pool,
    marketCache: caches.market,
    fallback,
    now: () => NOW,
    fetch: async () => {
      throw new Error('No DEX Pool should be queried')
    }
  })

  await expect(service.refresh()).resolves.toMatchObject({
    status: 'ready',
    quotes: [
      {
        assetId: ASSET_ID,
        source: 'near-intents-1click',
        priceUsd: '1.2'
      }
    ]
  })
})

test('prefers fresh DEX data and uses a fresh 1Click quote instead of stale DEX data', () => {
  const quote = (source, freshness, priceUsd) => ({
    assetId: ASSET_ID,
    source,
    priceUsd,
    sourceUpdatedAt: NOW,
    fetchedAt: NOW,
    freshness
  })
  const model = quoteValue => ({
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: NOW,
    quotes: [quoteValue],
    missingAssetIds: []
  })
  const dexFresh = model(quote('dex-screener', 'fresh', '1'))
  const dexStale = model(quote('dex-screener', 'stale', '0.9'))
  const oneClick = model(quote('near-intents-1click', 'fresh', '1.04'))

  expect(preferUserAssetDexPrices([ASSET_ID], dexFresh, oneClick).quotes[0]).toMatchObject({
    source: 'dex-screener',
    priceUsd: '1'
  })
  expect(preferUserAssetDexPrices([ASSET_ID], dexStale, oneClick).quotes[0]).toMatchObject({
    source: 'near-intents-1click',
    priceUsd: '1.04'
  })
  expect(
    preferUserAssetDexPrices(
      [ASSET_ID],
      dexFresh,
      model(quote('near-intents-1click', 'fresh', '1.2'))
    ).quotes[0]
  ).toMatchObject({
    source: 'near-intents-1click',
    priceUsd: '1.2'
  })
})

test('rejects expired or policy-mismatched cached Pool mappings', async () => {
  const invalidMappings = [
    { ...mapping(), expiresAt: NOW - 1 },
    { ...mapping(), dexId: 'untrusted-dex' },
    { ...mapping(), quoteTokenAddress: '0x9999999999999999999999999999999999999999' }
  ]
  for (const poolMapping of invalidMappings) {
    const caches = createCaches(poolMapping)
    const service = new UserAssetDexPriceService({
      assetIds: [ASSET_ID],
      resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
      discovery: { discover: async () => ({ status: 'unavailable' }) },
      poolCache: caches.pool,
      marketCache: caches.market,
      now: () => NOW,
      fetch: async () => {
        throw new Error('Invalid cached mappings must not be queried')
      }
    })
    await expect(service.readCached()).resolves.toMatchObject({
      status: 'error',
      missingAssetIds: [ASSET_ID]
    })
  }
})

test('merges built-in and custom price models without allowing duplicate AssetIds', () => {
  const primary = {
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: NOW,
    quotes: [
      {
        assetId: 'eip155:1/slip44:60',
        source: 'near-intents-1click',
        priceUsd: '4000',
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }
  const custom = {
    source: 'wallet-market-data',
    status: 'error',
    fetchedAt: NOW,
    quotes: [],
    missingAssetIds: [ASSET_ID]
  }
  expect(mergeAssetPriceModels(primary, custom)).toMatchObject({
    status: 'partial',
    quotes: primary.quotes,
    missingAssetIds: [ASSET_ID]
  })
  expect(() =>
    mergeAssetPriceModels(primary, { ...custom, quotes: primary.quotes, missingAssetIds: [] })
  ).toThrow(/duplicate AssetIds/)
})
