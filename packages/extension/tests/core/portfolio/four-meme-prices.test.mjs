import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ASSET_PRICE_SOURCE_ASSETS } from '../../../src/config/asset-market-assets.ts'
import { parseAssetPriceReadModel } from '../../../src/core/prices/index.ts'
import {
  FourMemeMarketClient,
  FourMemeAssetPriceService,
  ONE_CLICK_ASSET_PRICE_URL
} from '../../../src/infrastructure/prices/index.ts'

const NOW = Date.parse('2026-11-10T08:00:00Z')
const CONTRACT = `0x${'a'.repeat(40)}`
const SECOND = `0x${'b'.repeat(40)}`
const ASSET_ID = `eip155:56/erc20:${CONTRACT}`
const SECOND_ID = `eip155:56/erc20:${SECOND}`
const USDT = '0x55d398326f99059ff775485246999027b3197955'
const USDT_ID = `eip155:56/erc20:${USDT}`
const BNB_ID = 'eip155:56/slip44:714'
const CONFIG = [
  {
    symbol: 'BNB',
    symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    networkCode: 'BSC',
    decimals: 18
  },
  { symbol: 'USDT', symbolAddress: USDT, networkCode: 'BSC', decimals: 18 }
]

function cache() {
  let snapshot = null
  return {
    get: async () => snapshot,
    put: async value => {
      snapshot = value
    }
  }
}

function detail(address, overrides = {}) {
  return {
    address,
    networkCode: 'BSC',
    shortName: 'MEME',
    symbol: 'BNB',
    status: 'PUBLISH',
    image: 'https://static.four.meme/market/example.png',
    tokenPrice: { price: '0.00002', modifyDate: String(NOW) },
    ...overrides
  }
}

function response(data) {
  return new Response(JSON.stringify({ code: 0, data }))
}

test('converts Four.Meme curve prices with the exact quote asset and preserves source age across reloads', async () => {
  let now = NOW
  const requests = []
  const fetch = async (input, init) => {
    const url = new URL(input)
    requests.push(url.href)
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    if (url.pathname.endsWith('/public/config')) return response(CONFIG)
    if (url.pathname.endsWith('/private/token/get/v2')) {
      const address = url.searchParams.get('address')
      return response(
        address === CONTRACT
          ? detail(CONTRACT)
          : detail(SECOND, {
              symbol: 'USDT',
              tokenPrice: { price: '0.02', modifyDate: String(NOW) }
            })
      )
    }
    expect(url.href).toBe(ONE_CLICK_ASSET_PRICE_URL)
    return new Response(
      JSON.stringify([
        {
          assetId: ASSET_PRICE_SOURCE_ASSETS.bnb,
          decimals: 18,
          blockchain: 'bsc',
          symbol: 'BNB',
          price: 600,
          priceUpdatedAt: new Date(NOW - 1_000).toISOString()
        },
        {
          assetId: 'usdt-source',
          contractAddress: USDT,
          decimals: 18,
          blockchain: 'bsc',
          symbol: 'USDT',
          price: 0.98,
          priceUpdatedAt: new Date(NOW).toISOString()
        }
      ])
    )
  }
  const options = {
    assetIds: [ASSET_ID, SECOND_ID],
    client: new FourMemeMarketClient({ fetch, now: () => now }),
    cache: cache(),
    quotePriceCache: cache(),
    fetch,
    now: () => now
  }
  const service = new FourMemeAssetPriceService(options)
  const [first, concurrent] = await Promise.all([service.refresh(), service.refresh()])
  expect(concurrent).toEqual(first)
  expect(parseAssetPriceReadModel(first)).toMatchObject({
    status: 'ready',
    missingAssetIds: [],
    quotes: [
      {
        assetId: ASSET_ID,
        source: 'four-meme',
        priceUsd: '0.012',
        sourceUpdatedAt: NOW - 1_000,
        freshness: 'fresh'
      },
      {
        assetId: SECOND_ID,
        source: 'four-meme',
        priceUsd: '0.0196',
        sourceUpdatedAt: NOW,
        freshness: 'fresh'
      }
    ]
  })
  const count = requests.length
  await service.refresh()
  expect(requests).toHaveLength(count)
  now += 6 * 60_000
  const restored = new FourMemeAssetPriceService(options)
  expect(await restored.readCached()).toMatchObject({
    status: 'partial',
    quotes: [
      { freshness: 'stale', sourceUpdatedAt: NOW - 1_000 },
      { freshness: 'stale', sourceUpdatedAt: NOW }
    ]
  })
  expect(requests).toHaveLength(count)
  now += 30 * 60_000
  expect(await restored.readCached()).toMatchObject({
    status: 'error',
    quotes: [],
    missingAssetIds: [ASSET_ID, SECOND_ID]
  })
})

test('does not value an unknown quote at one dollar and drops cached curve prices on graduation', async () => {
  let now = NOW
  let phase = 'curve'
  let quoteAssetId = BNB_ID
  const tokenCache = cache()
  const service = new FourMemeAssetPriceService({
    assetIds: [ASSET_ID],
    cache: tokenCache,
    quotePriceCache: cache(),
    now: () => now,
    client: {
      getToken: async () => ({
        assetId: ASSET_ID,
        phase,
        market:
          phase === 'curve'
            ? {
                price: '0.00002',
                quoteAssetId,
                quoteDecimals: 18,
                sourceUpdatedAt: now
              }
            : undefined
      })
    },
    fetch: async () =>
      new Response(
        JSON.stringify([
          {
            assetId: ASSET_PRICE_SOURCE_ASSETS.bnb,
            decimals: 18,
            blockchain: 'bsc',
            price: 600,
            priceUpdatedAt: new Date(now).toISOString()
          }
        ])
      )
  })
  expect((await service.refresh()).quotes[0].priceUsd).toBe('0.012')
  now += 61_000
  phase = 'dex'
  expect(await service.refresh()).toMatchObject({
    status: 'error',
    quotes: [],
    missingAssetIds: [ASSET_ID]
  })
  expect((await tokenCache.get()).quotes).toEqual([])
  now += 61_000
  phase = 'curve'
  quoteAssetId = USDT_ID
  expect(await service.refresh()).toMatchObject({
    status: 'error',
    quotes: [],
    missingAssetIds: [ASSET_ID]
  })
})
