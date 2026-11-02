import {
  createPriceMappings as createMappings,
  createMarketMappings
} from '../../helpers/asset-market-fixtures.mjs'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import { parseAssetPriceReadModel } from '../../../src/core/prices/index.ts'
import { getAssetPriceSourceMappings } from '../../../src/core/prices/asset-market-mappings.ts'
import {
  DexScreenerMarketChangeService,
  OneClickAssetPriceService
} from '../../../src/infrastructure/prices/index.ts'
import {
  BackgroundAssetPriceService,
  mergeAssetMarketChanges
} from '../../../src/background/asset-prices.ts'
import { createIntentsWalletAssetCatalog } from '../../../src/core/services/intents-wallet-assets.ts'
import {
  hasRetryablePortfolioPriceGap,
  resolveLowValueUsdThreshold,
  summarizePortfolioFiat
} from '../../../src/popup/components/portfolio/portfolio-prices.ts'

function token(mapping, now, price, extra = {}) {
  return {
    assetId: mapping.sourceAssetId,
    decimals: 18,
    blockchain: 'test',
    symbol: 'TEST',
    price,
    priceUpdatedAt: new Date(now - 60_000).toISOString(),
    coingeckoId: 'test',
    ...extra
  }
}

function uniqueSourceMappings(mappings) {
  return [...new Map(mappings.map(mapping => [mapping.sourceAssetId, mapping])).values()]
}

function dexPair(pool, options = {}) {
  return {
    chainId: pool.chainId,
    dexId: pool.dexId,
    pairAddress: pool.pairAddress,
    baseToken: { address: pool.baseTokenAddress, name: 'Base', symbol: 'BASE' },
    quoteToken: { address: pool.quoteTokenAddress, name: 'Quote', symbol: 'QUOTE' },
    priceUsd: options.priceUsd ?? '100',
    priceChange: { h24: options.percent24h ?? 2.5 },
    liquidity: { usd: options.liquidityUsd ?? pool.minimumLiquidityUsd + 1 },
    volume: { h24: options.volume24hUsd ?? pool.minimumVolume24hUsd + 1 }
  }
}

test('refreshes only cached custom prices while viewing a bundled asset', async () => {
  const customAssetId = 'eip155:1/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const userModel = {
    source: 'wallet-market-data',
    status: 'error',
    fetchedAt: 1,
    quotes: [],
    missingAssetIds: [customAssetId]
  }
  const calls = []
  const service = new BackgroundAssetPriceService(
    {
      readCached: async () => {
        calls.push('bundled-price-read')
        return {
          source: 'wallet-market-data',
          status: 'error',
          fetchedAt: 1,
          quotes: [],
          missingAssetIds: []
        }
      },
      refresh: async () => ({
        source: 'wallet-market-data',
        status: 'error',
        fetchedAt: 1,
        quotes: [],
        missingAssetIds: []
      })
    },
    {
      readCached: async () => {
        calls.push('bundled-market-read')
        return { fetchedAt: 1, quotes: [], missingAssetIds: [] }
      },
      refresh: async () => ({ fetchedAt: 1, quotes: [], missingAssetIds: [] })
    },
    undefined,
    {
      hasAsset: assetId => assetId.toLowerCase() === customAssetId,
      readCached: async () => {
        calls.push('read')
        return userModel
      },
      refresh: async assetId => {
        calls.push(assetId ?? 'refresh')
        return userModel
      }
    }
  )

  await service.refresh('eip155:1/slip44:60')
  expect(calls).toEqual(['read'])
  await service.refresh(customAssetId)
  expect(calls).toHaveLength(4)
  expect(calls).toEqual(expect.arrayContaining([
    'read', 'bundled-price-read', 'bundled-market-read', customAssetId
  ]))
  await service.refresh(customAssetId.toUpperCase())
  expect(calls).toHaveLength(7)
  expect(calls).toContain(customAssetId.toUpperCase())
  expect(calls.filter(call => call === 'bundled-price-read')).toHaveLength(2)
  expect(calls.filter(call => call === 'bundled-market-read')).toHaveLength(2)
  await service.refresh()
  expect(calls.at(-1)).toBe('refresh')
})

test('maps only canonical product assets to explicit 1Click sources on both builds', () => {
  for (const network of ['mainnet', 'testnet']) {
    const { assets, mappings } = createMappings(network)
    const expectedSymbols = [
      'ZEC',
      'ETH',
      'USDC',
      network === 'mainnet' ? 'BNB' : 'tBNB',
      'ETH',
      'USDC',
      'ETH',
      'USDC',
      'ETH',
      'USDC',
      'POL',
      'USDC',
      'AVAX',
      'USDC',
      ...(network === 'mainnet' ? ['MON', 'xDAI', 'XPL', 'OKB', 'BERA'] : []),
      'BTC',
      'SOL',
      'NEAR'
    ]
    expect(mappings.map(item => assets.resolve(item.assetId).metadata.symbol)).toEqual(
      expectedSymbols
    )
    expect(new Set(mappings.map(item => item.assetId)).size).toBe(expectedSymbols.length)
    expect(new Set(mappings.map(item => item.marketAssetId)).size).toBe(
      network === 'mainnet' ? 14 : 9
    )
    expect(new Set(mappings.map(item => item.sourceAssetId)).size).toBe(
      network === 'mainnet' ? 14 : 9
    )
    expect(mappings.find(item => item.marketAssetId === 'solana')?.sourceAssetId).toBe(
      'nep141:sol.omft.near'
    )
    expect(mappings.find(item => item.marketAssetId === 'near')?.sourceAssetId).toBe(
      'nep141:wrap.near'
    )
  }
})

test('keeps dynamic price catalogs bounded without the legacy 100-asset ceiling', () => {
  const mappings = Array.from({ length: 101 }, (_, index) => {
    const address = `0x${index.toString(16).padStart(40, '0')}`
    return {
      assetId: `eip155:1/erc20:${address}`,
      marketAssetId: `asset-${index}`,
      sourceAssetId: `nep141:asset-${index}.omft.near`
    }
  })
  expect(
    () =>
      new OneClickAssetPriceService({
        mappings,
        cache: { get: async () => null, put: async () => {} }
      })
  ).not.toThrow()
  expect(
    parseAssetPriceReadModel({
      source: 'wallet-market-data',
      status: 'error',
      fetchedAt: 0,
      quotes: [],
      missingAssetIds: mappings.map(mapping => mapping.assetId)
    }).missingAssetIds
  ).toHaveLength(101)
})

test('derives price sources for every discovered Solana and NEAR Intents asset', () => {
  const now = new Date().toISOString()
  const catalog = createIntentsWalletAssetCatalog(
    [
      {
        assetId: 'nep141:sol-usdc.omft.near',
        blockchain: 'sol',
        contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        price: 1,
        priceUpdatedAt: now,
        symbol: 'USDC'
      },
      {
        assetId: 'nep141:jup.omft.near',
        blockchain: 'sol',
        contractAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        decimals: 6,
        price: 0.42,
        priceUpdatedAt: now,
        symbol: 'JUP',
        coingeckoId: 'jupiter-exchange-solana'
      },
      {
        assetId: 'nep141:near-usdc',
        blockchain: 'near',
        contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
        decimals: 6,
        price: 1,
        priceUpdatedAt: now,
        symbol: 'USDC'
      },
      {
        assetId: 'nep141:usdt.tether-token.near',
        blockchain: 'near',
        contractAddress: 'usdt.tether-token.near',
        decimals: 6,
        price: 1,
        priceUpdatedAt: now,
        symbol: 'USDT'
      }
    ],
    'mainnet'
  )
  expect(catalog.priceMappings).toEqual([
    {
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:sol-usdc.omft.near'
    },
    {
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      marketAssetId: 'jupiter-exchange-solana',
      sourceAssetId: 'nep141:jup.omft.near'
    },
    {
      assetId:
        'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:near-usdc'
    },
    {
      assetId: 'near:mainnet/nep141:usdt.tether-token.near',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:usdt.tether-token.near'
    }
  ])
})

test('does not map a native reference unless it matches the exact built-in chain identity', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    {
      chainId: 'eip155:1',
      namespace: 'slip44',
      reference: '133',
      kind: 'native',
      metadata: { name: 'Impostor Zcash', symbol: 'ZEC', decimals: 8 },
      source: 'bundled',
      verification: 'trusted'
    }
  ])

  expect(
    getAssetPriceSourceMappings('mainnet', assets).map(mapping => mapping.assetId)
  ).not.toContain('eip155:1/slip44:133')
})

test('maps release assets to fixed DEX Screener pools without symbol discovery', () => {
  for (const network of ['mainnet', 'testnet']) {
    const { assets, mappings } = createMarketMappings(network)
    expect(mappings).toHaveLength(9)
    expect(new Set(mappings.map(mapping => mapping.assetId)).size).toBe(9)
    expect(new Set(mappings.map(mapping => mapping.marketAssetId)).size).toBe(6)
    expect(
      new Set(mappings.map(mapping => `${mapping.pool.chainId}:${mapping.pool.pairAddress}`)).size
    ).toBe(6)
    expect(mappings.map(mapping => assets.resolve(mapping.assetId).metadata.symbol)).toEqual([
      'ZEC',
      'ETH',
      network === 'mainnet' ? 'BNB' : 'tBNB',
      'ETH',
      'ETH',
      'ETH',
      'POL',
      'AVAX',
      'BTC'
    ])
    expect(
      mappings.some(mapping => assets.resolve(mapping.assetId).metadata.symbol === 'USDC')
    ).toBe(false)
  }
})

test('serves fresh prices, keeps bounded stale cache, and expires old quotes instead of using zero', async () => {
  const { mappings } = createMappings()
  let now = Date.parse('2026-08-09T10:00:00.000Z')
  let stored = null
  let fetchCount = 0
  let offline = false
  const service = new OneClickAssetPriceService({
    mappings,
    now: () => now,
    cache: {
      get: async () => stored,
      put: async value => {
        stored = value
      }
    },
    fetch: async () => {
      fetchCount += 1
      if (offline) throw new Error('offline')
      return new Response(
        JSON.stringify(
          uniqueSourceMappings(mappings).map((mapping, index) => token(mapping, now, 10 + index))
        )
      )
    }
  })

  await expect(service.readCached()).resolves.toMatchObject({
    status: 'error',
    quotes: [],
    missingAssetIds: mappings.map(item => item.assetId)
  })
  const fresh = await service.refresh()
  expect(parseAssetPriceReadModel(fresh)).toMatchObject({ status: 'ready' })
  expect(fresh.quotes).toHaveLength(mappings.length)
  const ethereumNativeAssetIds = new Set([
    'eip155:1/slip44:60',
    'eip155:10/slip44:60',
    'eip155:8453/slip44:60',
    'eip155:42161/slip44:60'
  ])
  const ethPrices = fresh.quotes
    .filter(quote => ethereumNativeAssetIds.has(quote.assetId))
    .map(quote => quote.priceUsd)
  expect(ethPrices).toEqual(['11', '11', '11', '11'])
  const usdcPrices = fresh.quotes
    .filter(quote => quote.assetId.includes('/erc20:'))
    .map(quote => quote.priceUsd)
  expect(usdcPrices).toEqual(Array(6).fill('12'))
  expect(fetchCount).toBe(1)

  await service.refresh()
  expect(fetchCount).toBe(1)

  offline = true
  now += 10 * 60 * 1000
  const stale = await service.refresh()
  expect(stale.status).toBe('partial')
  expect(stale.quotes.every(quote => quote.freshness === 'stale')).toBe(true)

  now += 22 * 60 * 1000
  const expired = await service.refresh()
  expect(expired).toMatchObject({ status: 'error', quotes: [] })
  expect(expired.missingAssetIds).toEqual(mappings.map(item => item.assetId))
})

test('treats a discovered token with no provider price as missing without dropping other prices', async () => {
  const { mappings } = createMappings()
  const now = Date.parse('2026-08-09T10:00:00.000Z')
  const unique = uniqueSourceMappings(mappings)
  const missingSourceAssetId = unique[0].sourceAssetId
  const service = new OneClickAssetPriceService({
    mappings,
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: async () =>
      Response.json(
        unique.map((mapping, index) =>
          token(mapping, now, mapping.sourceAssetId === missingSourceAssetId ? 0 : 10 + index)
        )
      )
  })

  const result = await service.refresh()
  expect(result.status).toBe('partial')
  expect(result.quotes.length).toBeGreaterThan(0)
  expect(result.missingAssetIds).toEqual(
    mappings
      .filter(mapping => mapping.sourceAssetId === missingSourceAssetId)
      .map(mapping => mapping.assetId)
  )
})

test('normalizes provider float precision without dropping the price batch', async () => {
  const { mappings } = createMappings()
  const now = Date.parse('2026-08-09T10:00:00.000Z')
  const unique = uniqueSourceMappings(mappings)
  const highPrecisionSourceAssetId = unique[0].sourceAssetId
  const service = new OneClickAssetPriceService({
    mappings,
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: async () =>
      Response.json(
        unique.map((mapping, index) =>
          token(
            mapping,
            now,
            mapping.sourceAssetId === highPrecisionSourceAssetId
              ? 0.00022792420856958625
              : 10 + index
          )
        )
      )
  })

  const result = await service.refresh()
  expect(result.status).toBe('ready')
  expect(result.missingAssetIds).toEqual([])
  expect(
    result.quotes
      .filter(quote =>
        mappings
          .filter(mapping => mapping.sourceAssetId === highPrecisionSourceAssetId)
          .some(mapping => mapping.assetId === quote.assetId)
      )
      .map(quote => quote.priceUsd)
  ).toEqual(
    mappings
      .filter(mapping => mapping.sourceAssetId === highPrecisionSourceAssetId)
      .map(() => '0.000227924208569586')
  )
})

test('does not rebind fetch implementations to service option objects', async () => {
  const now = Date.parse('2026-08-09T10:00:00.000Z')
  const priceMapping = createMappings().mappings[0]
  const marketMapping = createMarketMappings().mappings[0]
  function priceFetch() {
    expect(this).toBeUndefined()
    return Promise.resolve(new Response(JSON.stringify([token(priceMapping, now, 50)])))
  }
  function marketFetch() {
    expect(this).toBeUndefined()
    return Promise.resolve(new Response(JSON.stringify({ pairs: [dexPair(marketMapping.pool)] })))
  }

  const prices = await new OneClickAssetPriceService({
    mappings: [priceMapping],
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: priceFetch
  }).refresh()
  const market = await new DexScreenerMarketChangeService({
    mappings: [marketMapping],
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: marketFetch
  }).refresh()

  expect(prices.quotes).toHaveLength(1)
  expect(market.quotes).toHaveLength(1)
})

test('rejects unexpected fields on a mapped quote and falls back without exposing untrusted data', async () => {
  const { mappings } = createMappings()
  const now = Date.parse('2026-08-09T10:00:00.000Z')
  const service = new OneClickAssetPriceService({
    mappings,
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: async () =>
      new Response(
        JSON.stringify([
          token(mappings[0], now, 10, { unexpectedRemoteField: 'must not cross boundary' })
        ])
      )
  })
  await expect(service.refresh()).resolves.toMatchObject({ status: 'error', quotes: [] })
})

test('caches validated DEX changes, deduplicates shared pools, and expires failed refreshes', async () => {
  const { mappings } = createMarketMappings()
  let now = Date.parse('2026-08-15T01:00:00.000Z')
  let stored = null
  let offline = false
  let fetchCount = 0
  const poolByAddress = new Map(
    mappings.map(mapping => [mapping.pool.pairAddress.toLowerCase(), mapping.pool])
  )
  const service = new DexScreenerMarketChangeService({
    mappings,
    now: () => now,
    cache: {
      get: async () => stored,
      put: async value => {
        stored = value
      }
    },
    fetch: async url => {
      fetchCount += 1
      if (offline) throw new Error('offline')
      const pairAddress = decodeURIComponent(new URL(url).pathname.split('/').at(-1)).toLowerCase()
      const pool = poolByAddress.get(pairAddress)
      if (!pool) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ pairs: [dexPair(pool)] }))
    }
  })

  await expect(service.readCached()).resolves.toMatchObject({ quotes: [] })
  const fresh = await service.refresh()
  expect(fresh.quotes).toHaveLength(9)
  expect(fresh.quotes.every(quote => quote.percent24h === '2.5')).toBe(true)
  expect(fetchCount).toBe(6)
  expect(stored.quotes).toHaveLength(6)

  await service.refresh()
  expect(fetchCount).toBe(6)

  offline = true
  now += 31 * 60 * 1000
  const stale = await service.refresh()
  expect(stale.quotes).toHaveLength(9)
  expect(stale.quotes.every(quote => quote.freshness === 'stale')).toBe(true)

  now += 90 * 60 * 1000
  const expired = await service.refresh()
  expect(expired.quotes).toEqual([])
  expect(expired.missingAssetIds).toEqual(mappings.map(mapping => mapping.assetId))
})

test('rejects a spoofed trusted-pair identity and removes changes below liquidity requirements', async () => {
  const { mappings } = createMarketMappings()
  const now = Date.parse('2026-08-15T01:00:00.000Z')
  const service = new DexScreenerMarketChangeService({
    mappings,
    now: () => now,
    cache: { get: async () => null, put: async () => {} },
    fetch: async url => {
      const pairAddress = decodeURIComponent(new URL(url).pathname.split('/').at(-1)).toLowerCase()
      const mapping = mappings.find(item => item.pool.pairAddress.toLowerCase() === pairAddress)
      if (!mapping) return new Response('', { status: 404 })
      if (mapping.pool.chainId === 'ethereum') {
        return new Response(
          JSON.stringify({
            pairs: [
              dexPair(mapping.pool, {
                liquidityUsd: mapping.pool.minimumLiquidityUsd - 1
              })
            ]
          })
        )
      }
      if (mapping.pool.chainId === 'base') {
        const spoofed = dexPair(mapping.pool)
        spoofed.baseToken.address = '0x0000000000000000000000000000000000000001'
        return new Response(JSON.stringify({ pairs: [spoofed] }))
      }
      return new Response(JSON.stringify({ pairs: [dexPair(mapping.pool)] }))
    }
  })

  const result = await service.refresh()
  const rejectedPools = new Set(['ethereum', 'base'])
  expect(
    result.quotes.some(quote =>
      rejectedPools.has(mappings.find(m => m.assetId === quote.assetId).pool.chainId)
    )
  ).toBe(false)
  expect(result.quotes).toHaveLength(4)
})

test('prefers a fresh trusted DEX price, falls back to 1Click on divergence, and keeps exact sources', () => {
  const { mappings } = createMappings()
  const prices = parseAssetPriceReadModel({
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: 1,
    quotes: [
      {
        assetId: mappings[0].assetId,
        source: 'near-intents-1click',
        priceUsd: '100',
        sourceUpdatedAt: 1,
        fetchedAt: 1,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  })
  const market = {
    fetchedAt: 2,
    quotes: [
      {
        assetId: mappings[0].assetId,
        marketAssetId: mappings[0].marketAssetId,
        percent24h: '-1.25',
        observedPriceUsd: '105',
        fetchedAt: 2,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }
  const accepted = mergeAssetMarketChanges(prices, market)
  expect(accepted.quotes[0]).toMatchObject({
    source: 'dex-screener',
    priceUsd: '105',
    marketChange: {
      source: 'dex-screener',
      percent24h: '-1.25',
      fetchedAt: 2,
      freshness: 'fresh'
    }
  })
  expect(parseAssetPriceReadModel(structuredClone(accepted))).toEqual(accepted)

  const rejected = mergeAssetMarketChanges(prices, {
    ...market,
    quotes: [{ ...market.quotes[0], observedPriceUsd: '105.01' }]
  })
  expect(rejected.quotes[0]).toMatchObject({
    source: 'near-intents-1click',
    priceUsd: '100'
  })
  expect(rejected.quotes[0].marketChange).toBeUndefined()
})

test('uses a fresh trusted DEX price when 1Click is missing and rejects stale DEX-only prices', () => {
  const { mappings } = createMappings()
  const assetId = mappings[0].assetId
  const missingPrices = parseAssetPriceReadModel({
    source: 'wallet-market-data',
    status: 'error',
    fetchedAt: 1,
    quotes: [],
    missingAssetIds: []
  })
  const market = {
    fetchedAt: 2,
    quotes: [
      {
        assetId,
        marketAssetId: mappings[0].marketAssetId,
        percent24h: '3.5',
        observedPriceUsd: '42',
        fetchedAt: 2,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }

  expect(mergeAssetMarketChanges(missingPrices, market)).toMatchObject({
    status: 'ready',
    quotes: [{ assetId, source: 'dex-screener', priceUsd: '42' }],
    missingAssetIds: []
  })
  expect(
    mergeAssetMarketChanges(missingPrices, {
      ...market,
      quotes: [{ ...market.quotes[0], freshness: 'stale' }]
    })
  ).toMatchObject({ status: 'error', quotes: [], missingAssetIds: [assetId] })
})

test('portfolio fiat summary excludes non-zero assets with missing prices', () => {
  const { assets, mappings } = createMappings()
  const [zec, eth] = assets.list()
  const portfolio = {
    assets: [
      {
        asset: zec.asset,
        metadata: zec.metadata,
        balance: {
          totalRaw: '200000000',
          spendableRaw: '200000000',
          availableRaw: '200000000',
          pendingRaw: '0'
        },
        chainAccountIds: [],
        freshness: 'fresh',
        updatedAt: 1
      },
      {
        asset: eth.asset,
        metadata: eth.metadata,
        balance: {
          totalRaw: '1000000000000000000',
          spendableRaw: '1000000000000000000',
          availableRaw: '1000000000000000000',
          pendingRaw: '0'
        },
        chainAccountIds: [],
        freshness: 'fresh',
        updatedAt: 1
      }
    ]
  }
  const prices = parseAssetPriceReadModel({
    source: 'wallet-market-data',
    status: 'partial',
    fetchedAt: 1,
    quotes: [
      {
        assetId: mappings[0].assetId,
        source: 'near-intents-1click',
        priceUsd: '50',
        sourceUpdatedAt: 1,
        fetchedAt: 1,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: mappings.slice(1).map(item => item.assetId)
  })
  expect(summarizePortfolioFiat(portfolio, prices)).toEqual({
    totalUsd: '100',
    mainUsd: '100',
    privateUsd: '0',
    pricedAssetCount: 1,
    missingAssetCount: 1,
    staleAssetCount: 0
  })
  expect(hasRetryablePortfolioPriceGap(portfolio, prices)).toBe(true)

  const customAsset = {
    ...portfolio.assets[1],
    asset: {
      ...portfolio.assets[1].asset,
      id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111',
      namespace: 'erc20',
      reference: '0x1111111111111111111111111111111111111111'
    },
    metadata: { name: 'Custom Token', symbol: 'CUSTOM', decimals: 18 }
  }
  expect(hasRetryablePortfolioPriceGap({ assets: [customAsset] }, prices)).toBe(false)
})

test('scales the Low value threshold to one percent of priced portfolio value', () => {
  const { assets, mappings } = createMappings()
  const zec = assets.list()[0]
  const asset = totalRaw => ({
    asset: zec.asset,
    metadata: zec.metadata,
    balance: {
      totalRaw,
      spendableRaw: totalRaw,
      availableRaw: totalRaw,
      pendingRaw: '0'
    },
    chainAccountIds: [],
    freshness: 'fresh',
    updatedAt: 1
  })
  const prices = parseAssetPriceReadModel({
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: 1,
    quotes: [
      {
        assetId: mappings[0].assetId,
        source: 'near-intents-1click',
        priceUsd: '50',
        sourceUpdatedAt: 1,
        fetchedAt: 1,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  })

  expect(resolveLowValueUsdThreshold({ assets: [] }, prices)).toBe('0.01')
  expect(resolveLowValueUsdThreshold({ assets: [asset('20000000')] }, prices)).toBe('0.1')
  expect(resolveLowValueUsdThreshold({ assets: [asset('200000000')] }, prices)).toBe('1')
  expect(resolveLowValueUsdThreshold({ assets: [asset('20000000000')] }, prices)).toBe('1')
})
