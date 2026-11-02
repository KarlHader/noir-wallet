import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getUserAssetDexPoolDiscoveryPolicy,
  listUserAssetDexPoolDiscoveryPolicies
} from '../../../src/config/user-asset-market-policy.ts'
import {
  DEX_SCREENER_TOKEN_PAIRS_URL,
  DexScreenerPoolDiscoveryService,
  parseDiscoveredDexPoolMapping,
  parseUserAssetDexPoolCacheSnapshot
} from '../../../src/infrastructure/prices/index.ts'

const NOW = Date.parse('2026-08-15T02:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ASSET_ID = `eip155:1/erc20:${TOKEN}`

function createCache(initial = null) {
  let stored = initial
  return {
    get stored() {
      return stored
    },
    repository: {
      get: async assetId => (stored?.assetId === assetId ? stored : null),
      put: async value => {
        stored = value
      },
      delete: async assetId => {
        if (stored?.assetId === assetId) stored = null
      }
    }
  }
}

function pair({
  pairAddress,
  priceUsd = '1',
  liquidityUsd = 500_000,
  volume24hUsd = 50_000,
  pairCreatedAt = NOW - 8 * DAY_MS,
  tokenAddress = TOKEN,
  quoteTokenAddress,
  dexId = 'uniswap',
  chainId = 'ethereum'
}) {
  const policy = getUserAssetDexPoolDiscoveryPolicy('eip155:1')
  return {
    chainId,
    dexId,
    pairAddress,
    baseToken: { address: tokenAddress, name: 'Test Token', symbol: 'TEST' },
    quoteToken: {
      address: quoteTokenAddress ?? policy.allowedQuoteTokenAddresses[0],
      name: 'USD Coin',
      symbol: 'USDC'
    },
    priceUsd,
    liquidity: { usd: liquidityUsd },
    volume: { h24: volume24hUsd },
    pairCreatedAt
  }
}

function serviceFor(responseFactory, options = {}) {
  const cache = options.cache ?? createCache()
  const requests = []
  const service = new DexScreenerPoolDiscoveryService({
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    cache: cache.repository,
    now: () => options.now ?? NOW,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      return responseFactory()
    }
  })
  return { cache, requests, service }
}

test('defines conservative discovery policies only for released mainnet EVM chains', () => {
  const policies = listUserAssetDexPoolDiscoveryPolicies()
  expect(policies.map(policy => policy.chainId)).toEqual([
    'eip155:1',
    'eip155:56',
    'eip155:42161',
    'eip155:8453',
    'eip155:10',
    'eip155:137',
    'eip155:43114'
  ])
  expect(new Set(policies.map(policy => policy.dexScreenerChainId)).size).toBe(policies.length)
  expect(
    policies.every(
      policy =>
        policy.allowedDexIds.length > 0 &&
        policy.allowedQuoteTokenAddresses.length > 0 &&
        policy.singlePoolMinimumLiquidityUsd >= policy.minimumLiquidityUsd &&
        policy.singlePoolMinimumVolume24hUsd >= policy.minimumVolume24hUsd
    )
  ).toBe(true)
  expect(getUserAssetDexPoolDiscoveryPolicy('eip155:11155111')).toBeNull()
})

test('does not rebind the discovery fetch implementation', async () => {
  const cache = createCache()
  function discoveryFetch() {
    expect(this).toBeUndefined()
    return Promise.resolve(
      new Response(
        JSON.stringify([
          pair({
            pairAddress: '0x2222222222222222222222222222222222222222',
            liquidityUsd: 1_500_000,
            volume24hUsd: 150_000
          })
        ])
      )
    )
  }
  const service = new DexScreenerPoolDiscoveryService({
    resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
    cache: cache.repository,
    now: () => NOW,
    fetch: discoveryFetch
  })

  await expect(service.discover(ASSET_ID)).resolves.toMatchObject({ status: 'available' })
})

test('discovers by exact chain and contract, rejects a price outlier, and caches the selected pool', async () => {
  const { cache, requests, service } = serviceFor(
    () =>
      new Response(
        JSON.stringify([
          pair({ pairAddress: '0x2222222222222222222222222222222222222222', priceUsd: '1' }),
          pair({
            pairAddress: '0x3333333333333333333333333333333333333333',
            priceUsd: '1.02',
            liquidityUsd: 600_000
          }),
          pair({
            pairAddress: '0x4444444444444444444444444444444444444444',
            priceUsd: '9',
            liquidityUsd: 5_000_000,
            volume24hUsd: 500_000
          })
        ])
      )
  )

  await expect(
    service.discover(ASSET_ID.replace(TOKEN, TOKEN.toUpperCase().replace('0X', '0x')))
  ).resolves.toMatchObject({
    status: 'available',
    source: 'network',
    observedPriceUsd: '1.02',
    pool: {
      assetId: ASSET_ID,
      pairAddress: '0x3333333333333333333333333333333333333333',
      baseTokenAddress: TOKEN
    }
  })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe(`${DEX_SCREENER_TOKEN_PAIRS_URL}/ethereum/${TOKEN}`)
  expect(requests[0].init).toMatchObject({
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer'
  })
  expect(cache.stored).toMatchObject({ assetId: ASSET_ID })

  await expect(service.discover(ASSET_ID)).resolves.toMatchObject({
    status: 'available',
    source: 'cache'
  })
  expect(requests).toHaveLength(1)
})

test('requires the exact token as base and a trusted DEX and quote asset', async () => {
  const policy = getUserAssetDexPoolDiscoveryPolicy('eip155:1')
  const { service } = serviceFor(
    () =>
      new Response(
        JSON.stringify([
          pair({
            pairAddress: '0x2222222222222222222222222222222222222222',
            tokenAddress: '0x9999999999999999999999999999999999999999'
          }),
          pair({
            pairAddress: '0x3333333333333333333333333333333333333333',
            dexId: 'untrusted-dex'
          }),
          pair({
            pairAddress: '0x4444444444444444444444444444444444444444',
            quoteTokenAddress: '0x8888888888888888888888888888888888888888'
          }),
          {
            ...pair({ pairAddress: '0x5555555555555555555555555555555555555555' }),
            baseToken: { address: policy.allowedQuoteTokenAddresses[0] },
            quoteToken: { address: TOKEN }
          }
        ])
      )
  )

  await expect(service.discover(ASSET_ID)).resolves.toEqual({ status: 'unavailable' })
})

test('accepts a single pool only at the stronger liquidity, volume, and age thresholds', async () => {
  const weak = serviceFor(
    () =>
      new Response(
        JSON.stringify([pair({ pairAddress: '0x2222222222222222222222222222222222222222' })])
      )
  )
  await expect(weak.service.discover(ASSET_ID)).resolves.toEqual({ status: 'unavailable' })

  const strong = serviceFor(
    () =>
      new Response(
        JSON.stringify([
          pair({
            pairAddress: '0x2222222222222222222222222222222222222222',
            liquidityUsd: 1_000_000,
            volume24hUsd: 100_000
          })
        ])
      )
  )
  await expect(strong.service.discover(ASSET_ID)).resolves.toMatchObject({
    status: 'available',
    source: 'network'
  })
})

test('does not query testnet and refreshes an expired mapping', async () => {
  let fetchCount = 0
  const { service } = serviceFor(() => {
    fetchCount += 1
    return new Response(
      JSON.stringify([
        pair({
          pairAddress: '0x2222222222222222222222222222222222222222',
          liquidityUsd: 1_000_000,
          volume24hUsd: 100_000
        })
      ])
    )
  })
  await expect(
    service.discover('eip155:11155111/erc20:0x1111111111111111111111111111111111111111')
  ).resolves.toEqual({ status: 'unavailable' })
  expect(fetchCount).toBe(0)

  await expect(service.discover(ASSET_ID)).resolves.toMatchObject({ status: 'available' })
  expect(fetchCount).toBe(1)
})

test('rejects malformed, duplicate, and oversized remote responses without persisting them', async () => {
  for (const responseFactory of [
    () => new Response('{'),
    () =>
      new Response(
        JSON.stringify([
          pair({ pairAddress: '0x2222222222222222222222222222222222222222' }),
          pair({ pairAddress: '0x2222222222222222222222222222222222222222' })
        ])
      ),
    () => new Response(JSON.stringify('x'.repeat(600_000)))
  ]) {
    const { cache, service } = serviceFor(responseFactory)
    await expect(service.discover(ASSET_ID)).resolves.toEqual({ status: 'failed' })
    expect(cache.stored).toBeNull()
  }
})

test('strictly validates cached mappings and cache snapshots', () => {
  const mapping = parseDiscoveredDexPoolMapping({
    assetId: ASSET_ID,
    dexScreenerChainId: 'ethereum',
    dexId: 'uniswap',
    pairAddress: '0x2222222222222222222222222222222222222222',
    baseTokenAddress: TOKEN,
    quoteTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    discoveredAt: NOW,
    expiresAt: NOW + DAY_MS
  })
  expect(parseUserAssetDexPoolCacheSnapshot({ version: 1, mappings: [mapping] })).toEqual({
    version: 1,
    mappings: [mapping]
  })
  expect(() =>
    parseDiscoveredDexPoolMapping({
      ...mapping,
      baseTokenAddress: '0x9999999999999999999999999999999999999999'
    })
  ).toThrow(/base token/)
  expect(() =>
    parseUserAssetDexPoolCacheSnapshot({ version: 1, mappings: [mapping, mapping] })
  ).toThrow(/Duplicate/)
})
