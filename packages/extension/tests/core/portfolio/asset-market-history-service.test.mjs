import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getAssetMarketMappings } from '../../../src/core/prices/asset-market-mappings.ts'
import { getAssetMarketHistorySourceMappings } from '../../../src/core/prices/asset-market-source-mappings.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import { parseAssetMarketHistoryReadModel } from '../../../src/core/prices/index.ts'
import {
  COIN_GECKO_MARKET_CHART_URL,
  COIN_GECKO_ASSET_PLATFORMS_URL,
  COINMARKETCAP_KEYLESS_KLINE_URL,
  GECKO_TERMINAL_POOL_OHLCV_URL,
  AssetMarketHistoryService,
  UnsupportedAssetMarketHistoryError
} from '../../../src/infrastructure/prices/index.ts'

function createMappings(network = 'mainnet') {
  const chains = createInitialProductChainRegistry(network)
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
  return getAssetMarketHistorySourceMappings(network, assets)
}

function historyResponse(offset = 0) {
  return {
    status: { error_code: '0' },
    data: [
      [100 + offset, 12, 1_000],
      [101 + offset, 14, 2_000],
      [102 + offset, 16, 3_000]
    ]
  }
}

function geckoHistoryResponse(offset = 0) {
  return {
    data: {
      attributes: {
        ohlcv_list: [
          [3, 100, 103, 99, 102 + offset, 12],
          [2, 99, 102, 98, 101 + offset, 14],
          [1, 98, 101, 97, 100 + offset, 16]
        ]
      }
    }
  }
}

test('maps every bundled priced asset to a bounded trusted history source', () => {
  for (const network of ['mainnet', 'testnet']) {
    const chains = createInitialProductChainRegistry(network)
    const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
    const expectedMappings = getAssetMarketMappings(network, assets)
    const mappings = createMappings(network)
    expect(mappings).toHaveLength(expectedMappings.length)
    expect(new Set(mappings.map(mapping => mapping.assetId)).size).toBe(mappings.length)
    expect(new Set(mappings.map(mapping => mapping.marketAssetId))).toEqual(
      new Set(expectedMappings.map(mapping => mapping.marketAssetId))
    )
    expect(
      mappings.every(
        mapping =>
          (mapping.primary === null ||
            (mapping.primary.network.length > 0 && mapping.primary.poolAddress.length > 0)) &&
          (mapping.fallback.source === 'coinmarketcap'
            ? mapping.fallback.platform.length > 0 && mapping.fallback.address.length > 0
            : mapping.fallback.coinId.length > 0)
      )
    ).toBe(true)
  }
})

test('uses the trusted pool token identity for CMC history fallback', () => {
  const byMarketAsset = new Map(createMappings().map(mapping => [mapping.marketAssetId, mapping]))
  expect(byMarketAsset.get('ethereum')).toMatchObject({
    primary: {
      network: 'eth',
      token: 'quote',
      poolAddress: '0xE0554a476A092703abdB3Ef35c80e0D76d32939F'
    },
    fallback: {
      source: 'coinmarketcap',
      platform: 'ethereum',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    }
  })
  expect(byMarketAsset.get('usd-coin')).toMatchObject({
    primary: {
      network: 'eth',
      token: 'base',
      poolAddress: '0xE0554a476A092703abdB3Ef35c80e0D76d32939F'
    },
    fallback: {
      source: 'coinmarketcap',
      platform: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    }
  })
})

test('does not enable a shared GeckoTerminal pool when its native asset is absent', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const usdc = getBundledInitialProductAssetDefinitions('mainnet').find(
    asset => asset.chainId === 'eip155:1' && asset.namespace === 'erc20'
  )
  expect(usdc).toBeDefined()
  const assets = createAssetRegistry(chains, [usdc])
  expect(getAssetMarketHistorySourceMappings('mainnet', assets)).toEqual([
    expect.objectContaining({
      marketAssetId: 'usd-coin',
      primary: null,
      fallback: {
        source: 'coinmarketcap',
        platform: 'ethereum',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      }
    })
  ])
})

test('keeps additional mappings on CoinGecko without a shared bundled asset', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const tokens = [
    { reference: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', marketAssetId: 'ethereum' },
    { reference: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', marketAssetId: 'usd-coin' }
  ]
  const assets = createAssetRegistry(
    chains,
    tokens.map(({ reference }) => ({
      chainId: 'eip155:1',
      namespace: 'erc20',
      reference,
      kind: 'token',
      metadata: { name: 'Custom Token', symbol: 'CUSTOM', decimals: 18 },
      source: 'user-added',
      verification: 'user-approved'
    }))
  )
  const mappings = getAssetMarketHistorySourceMappings(
    'mainnet',
    assets,
    tokens.map(({ reference, marketAssetId }) => ({
      assetId: `eip155:1/erc20:${reference}`,
      marketAssetId
    }))
  )
  expect(mappings).toEqual(
    tokens.map(({ reference, marketAssetId }) => ({
      assetId: `eip155:1/erc20:${reference}`,
      marketAssetId,
      primary: null,
      fallback: { source: 'coingecko', coinId: marketAssetId }
    }))
  )
})

test('derives contract history sources from registered chain and address regardless of Token symbol', () => {
  const definitions = [
    ['eip155:137', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['eip155:1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['eip155:137', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
  ].map(([chainId, reference]) => ({
    chainId,
    namespace: 'erc20',
    reference,
    kind: 'token',
    metadata: { name: 'Same name', symbol: 'SAME', decimals: 6 },
    source: 'user-added',
    verification: 'user-approved'
  }))
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, definitions)
  const mappings = getAssetMarketHistorySourceMappings('mainnet', assets)
  expect(mappings).toHaveLength(3)
  expect(new Set(mappings.map(mapping => mapping.marketAssetId)).size).toBe(3)
  expect(mappings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        assetId: 'eip155:137/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        primary: null,
        fallback: {
          source: 'coingecko-contract',
          chainId: 'eip155:137',
          contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
      }),
      expect.objectContaining({
        assetId: 'eip155:1/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        primary: null,
        fallback: {
          source: 'coingecko-contract',
          chainId: 'eip155:1',
          contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
      }),
      expect.objectContaining({
        assetId: 'eip155:137/erc20:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        primary: null,
        fallback: {
          source: 'coingecko-contract',
          chainId: 'eip155:137',
          contractAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        }
      })
    ])
  )
})

test('isolates discovered contract history by chain and address across persisted cache reloads', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const definitions = [
    ['eip155:137', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['eip155:1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['eip155:137', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
  ].map(([chainId, reference]) => ({
    chainId,
    namespace: 'erc20',
    reference,
    kind: 'token',
    metadata: { name: 'Same name', symbol: 'SAME', decimals: 6 },
    source: 'user-added',
    verification: 'user-approved'
  }))
  const mappings = getAssetMarketHistorySourceMappings(
    'mainnet',
    createAssetRegistry(chains, definitions)
  )
  let stored = null
  let platformRequests = 0
  const historyRequests = []
  const cache = {
    get: async () => stored,
    put: async value => {
      stored = value
    }
  }
  const service = new AssetMarketHistoryService({
    mappings,
    cache,
    now: () => 10_000,
    fetch: async input => {
      const url = new URL(String(input))
      if (url.href === COIN_GECKO_ASSET_PLATFORMS_URL) {
        platformRequests += 1
        return new Response(
          JSON.stringify([
            { id: 'polygon-pos', chain_identifier: 137 },
            { id: 'ethereum', chain_identifier: 1 },
            { id: 'shiden network', chain_identifier: 336 },
            { id: '', chain_identifier: null }
          ])
        )
      }
      historyRequests.push(url)
      const firstPrice = url.pathname.includes('/ethereum/')
        ? 200
        : url.pathname.includes('/0xbb')
          ? 300
          : 100
      return new Response(
        JSON.stringify({
          prices: [
            [1_000, firstPrice],
            [2_000, firstPrice + 1]
          ]
        })
      )
    }
  })
  const results = await Promise.all(
    mappings.map(mapping => service.refresh(mapping.assetId, 'all'))
  )
  expect(results.map(result => result.points[0].priceUsd)).toEqual(['100', '200', '300'])
  expect(platformRequests).toBe(1)
  expect(historyRequests.map(url => url.pathname)).toEqual(
    expect.arrayContaining([
      '/api/v3/coins/polygon-pos/contract/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/market_chart',
      '/api/v3/coins/ethereum/contract/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/market_chart',
      '/api/v3/coins/polygon-pos/contract/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/market_chart'
    ])
  )
  for (const url of historyRequests) {
    expect(url.searchParams.get('days')).toBe('365')
    expect(url.searchParams.has('interval')).toBe(false)
  }
  expect(stored.entries).toHaveLength(3)
  const reloaded = new AssetMarketHistoryService({
    mappings,
    cache,
    now: () => 10_000,
    fetch: async () => {
      throw new Error('Fresh persisted history must not request the provider')
    }
  })
  for (const [index, mapping] of mappings.entries()) {
    await expect(reloaded.refresh(mapping.assetId, 'all')).resolves.toEqual(results[index])
  }
  expect(
    () =>
      new AssetMarketHistoryService({
        mappings: [{ ...mappings[0], fallback: mappings[1].fallback }],
        cache
      })
  ).toThrow('Invalid market history source mapping')
})

test('keeps contract discovery retryable after rate limiting and distinguishes missing assets', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, [
    {
      chainId: 'eip155:137',
      namespace: 'erc20',
      reference: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'token',
      metadata: { name: 'Custom', symbol: 'CUSTOM', decimals: 18 },
      source: 'user-added',
      verification: 'user-approved'
    }
  ])
  const mappings = getAssetMarketHistorySourceMappings('mainnet', assets)
  const assetId = mappings[0].assetId
  let now = 10_000
  let catalogStatus = 429
  let includePlatform = false
  let historyStatus = 404
  let stored = null
  const service = new AssetMarketHistoryService({
    mappings,
    now: () => now,
    cache: {
      get: async () => stored,
      put: async value => {
        stored = value
      }
    },
    fetch: async input => {
      if (String(input) === COIN_GECKO_ASSET_PLATFORMS_URL) {
        return new Response(
          JSON.stringify([
            { id: 'ethereum', chain_identifier: 1 },
            ...(includePlatform ? [{ id: 'polygon-pos', chain_identifier: 137 }] : [])
          ]),
          { status: catalogStatus }
        )
      }
      return new Response(
        JSON.stringify({
          prices: [
            [1_000, 10],
            [2_000, 11]
          ]
        }),
        { status: historyStatus }
      )
    }
  })
  await expect(service.refresh(assetId, '1d')).resolves.toBeNull()
  catalogStatus = 200
  await expect(service.refresh(assetId, '1d')).rejects.toBeInstanceOf(
    UnsupportedAssetMarketHistoryError
  )
  includePlatform = true
  now += 5 * 60_000 + 1
  await expect(service.refresh(assetId, '1d')).rejects.toBeInstanceOf(
    UnsupportedAssetMarketHistoryError
  )
  historyStatus = 429
  await expect(service.refresh(assetId, '1d')).resolves.toBeNull()
  historyStatus = 200
  await expect(service.refresh(assetId, '1d')).resolves.toMatchObject({
    assetId,
    freshness: 'fresh',
    points: [
      { timestamp: 1_000, priceUsd: '10' },
      { timestamp: 2_000, priceUsd: '11' }
    ]
  })
  now += 20 * 60_000
  historyStatus = 404
  await expect(service.refresh(assetId, '1d')).resolves.toMatchObject({
    assetId,
    freshness: 'stale'
  })
})

test('loads bounded ordered history, caches it, and scopes the response to the requested asset', async () => {
  const mapping = createMappings().find(item => item.marketAssetId === 'ethereum')
  expect(mapping).toBeTruthy()
  let stored = null
  let fetchCount = 0
  const service = new AssetMarketHistoryService({
    mappings: [mapping],
    now: () => 10_000,
    cache: {
      get: async () => stored,
      put: async value => {
        stored = value
      }
    },
    fetch: async (input, init) => {
      fetchCount += 1
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toContain(
        `${GECKO_TERMINAL_POOL_OHLCV_URL}/eth/pools/`
      )
      expect(url.pathname).toContain('/ohlcv/hour')
      expect(url.searchParams.get('aggregate')).toBe('1')
      expect(url.searchParams.get('limit')).toBe('24')
      expect(url.searchParams.get('token')).toBe('quote')
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
      return new Response(JSON.stringify(geckoHistoryResponse()))
    }
  })

  const refreshed = await service.refresh(mapping.assetId, '1d')
  expect(service.supportsAsset(mapping.assetId)).toBe(true)
  expect(service.supportsAsset('eip155:137/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
    false
  )
  expect(parseAssetMarketHistoryReadModel(refreshed)).toMatchObject({
    assetId: mapping.assetId,
    source: 'geckoterminal-keyless',
    range: '1d',
    freshness: 'fresh',
    points: [
      { priceUsd: '100', timestamp: 1_000 },
      { priceUsd: '101', timestamp: 2_000 },
      { priceUsd: '102', timestamp: 3_000 }
    ]
  })
  await expect(service.readCached(mapping.assetId, '1d')).resolves.toEqual(refreshed)
  await service.refresh(mapping.assetId, '1d')
  expect(fetchCount).toBe(1)
})

test('loads history for a runtime-discovered Token using its trusted CoinGecko ID', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const assetId =
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
  const unresolvedAssetId =
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:So11111111111111111111111111111111111111112'
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    {
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      namespace: 'token',
      reference: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      kind: 'token',
      metadata: { name: 'Jupiter', symbol: 'JUP', decimals: 6 },
      source: 'protocol',
      verification: 'trusted'
    },
    {
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      namespace: 'token',
      reference: 'So11111111111111111111111111111111111111112',
      kind: 'token',
      metadata: { name: 'Unresolved', symbol: 'UNKNOWN', decimals: 9 },
      source: 'protocol',
      verification: 'trusted'
    }
  ])
  const mappings = getAssetMarketHistorySourceMappings('mainnet', assets, [
    {
      assetId,
      marketAssetId: 'jupiter-exchange-solana'
    },
    {
      assetId: unresolvedAssetId,
      marketAssetId: 'intents-asset'
    }
  ])
  const mapping = mappings.find(item => item.assetId === assetId)
  expect(mapping).toMatchObject({
    marketAssetId: 'jupiter-exchange-solana',
    primary: null,
    fallback: { source: 'coingecko', coinId: 'jupiter-exchange-solana' }
  })
  expect(mappings.find(item => item.assetId === unresolvedAssetId)).toBeUndefined()

  const requests = []
  const service = new AssetMarketHistoryService({
    mappings: [mapping],
    cache: { get: async () => null, put: async () => {} },
    fetch: async input => {
      const url = new URL(String(input))
      requests.push(url)
      return new Response(
        JSON.stringify({
          prices: [
            [1_000, 1],
            [2_000, 1.1],
            [3_000, 1.2]
          ],
          market_caps: [],
          total_volumes: []
        })
      )
    }
  })

  await expect(service.refresh(assetId, '1d')).resolves.toMatchObject({
    assetId,
    source: 'coingecko-keyless',
    range: '1d',
    freshness: 'fresh',
    points: [
      { timestamp: 1_000, priceUsd: '1' },
      { timestamp: 2_000, priceUsd: '1.1' },
      { timestamp: 3_000, priceUsd: '1.2' }
    ]
  })
  expect(`${requests[0].origin}${requests[0].pathname}`).toBe(
    `${COIN_GECKO_MARKET_CHART_URL}/jupiter-exchange-solana/market_chart`
  )
  expect(requests[0].searchParams.get('vs_currency')).toBe('usd')
  expect(requests[0].searchParams.get('days')).toBe('1')
})

test('returns stale cache on a provider failure and expires it at the safety boundary', async () => {
  const mapping = createMappings()[0]
  let now = 10_000
  let stored = null
  let offline = false
  const service = new AssetMarketHistoryService({
    mappings: [mapping],
    now: () => now,
    cache: {
      get: async () => stored,
      put: async value => {
        stored = value
      }
    },
    fetch: async () => {
      if (offline) throw new Error('offline')
      return new Response(JSON.stringify(geckoHistoryResponse()))
    }
  })

  await service.refresh(mapping.assetId, '1w')
  offline = true
  now += 20 * 60 * 1_000
  await expect(service.refresh(mapping.assetId, '1w')).resolves.toMatchObject({
    freshness: 'stale'
  })
  now += 6 * 60 * 60 * 1_000
  await expect(service.refresh(mapping.assetId, '1w')).resolves.toBeNull()
})

test('uses bounded GeckoTerminal ranges and keeps CMC for long-range fallback', async () => {
  const mapping = createMappings()[0]
  const requests = []
  const service = new AssetMarketHistoryService({
    mappings: [mapping],
    cache: { get: async () => null, put: async () => {} },
    fetch: async input => {
      const url = new URL(String(input))
      requests.push(url)
      return new Response(
        JSON.stringify(
          url.origin === new URL(GECKO_TERMINAL_POOL_OHLCV_URL).origin
            ? geckoHistoryResponse()
            : historyResponse()
        )
      )
    }
  })
  for (const range of ['1d', '1w', '1m', '3m', '1y', 'all']) {
    await service.refresh(mapping.assetId, range)
  }
  expect(
    requests.map(url => [
      url.hostname,
      url.pathname.split('/').at(-1),
      url.searchParams.get('aggregate'),
      url.searchParams.get('interval'),
      url.searchParams.get('limit')
    ])
  ).toEqual([
    ['api.geckoterminal.com', 'hour', '1', null, '24'],
    ['api.geckoterminal.com', 'hour', '4', null, '42'],
    ['api.geckoterminal.com', 'day', '1', null, '30'],
    ['api.geckoterminal.com', 'day', '1', null, '90'],
    ['pro-api.coinmarketcap.com', 'points', null, '1w', '52'],
    ['pro-api.coinmarketcap.com', 'points', null, '1m', '60']
  ])
})

test('falls back to CMC when GeckoTerminal is rate limited', async () => {
  const mapping = createMappings().find(item => item.marketAssetId === 'ethereum')
  expect(mapping).toBeTruthy()
  const requests = []
  const service = new AssetMarketHistoryService({
    mappings: [mapping],
    cache: { get: async () => null, put: async () => {} },
    fetch: async input => {
      const url = new URL(String(input))
      requests.push(url)
      if (url.hostname === 'api.geckoterminal.com') {
        return new Response('', { status: 429 })
      }
      return new Response(JSON.stringify(historyResponse()))
    }
  })

  await expect(service.refresh(mapping.assetId, '1d')).resolves.toMatchObject({
    source: 'coinmarketcap-keyless',
    freshness: 'fresh'
  })
  expect(requests.map(url => url.hostname)).toEqual([
    'api.geckoterminal.com',
    'pro-api.coinmarketcap.com'
  ])
})

test('rejects malformed, unordered, and oversized provider data', async () => {
  const mapping = Object.freeze({ ...createMappings()[0], primary: null })
  for (const data of [
    [[1, 1, 2_000]],
    [
      [1, 1, 2_000],
      [2, 1, 1_000]
    ],
    Array.from({ length: 101 }, (_, index) => [1, 1, index + 1])
  ]) {
    const service = new AssetMarketHistoryService({
      mappings: [mapping],
      cache: { get: async () => null, put: async () => {} },
      fetch: async () => new Response(JSON.stringify({ status: { error_code: 0 }, data }))
    })
    await expect(service.refresh(mapping.assetId, '1d')).resolves.toBeNull()
  }
})
