import { readFileSync } from 'node:fs'

import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mergeDefiLlamaMarketChanges } from '../../../src/background/asset-prices.ts'
import {
  DefiLlamaMarketChangeService,
  DEFI_LLAMA_PERCENTAGE_URL,
  DEFI_LLAMA_CURRENT_PRICE_URL
} from '../../../src/infrastructure/prices/index.ts'

const NOW = Date.parse('2026-09-01T00:00:00.000Z')
const SOL_ASSET_ID = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501'
const USDC_ASSET_ID =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

test('loads and caches DefiLlama 24h changes with matching current prices', async () => {
  let stored = {
    version: 1,
    fetchedAt: NOW - 60_000,
    quotes: [
      {
        marketAssetId: 'solana',
        percent24h: '-1',
        observedPriceUsd: '100',
        fetchedAt: NOW - 60_000
      }
    ]
  }
  const requests = []
  const service = new DefiLlamaMarketChangeService({
    mappings: [
      { assetId: SOL_ASSET_ID, marketAssetId: 'solana' },
      { assetId: USDC_ASSET_ID, marketAssetId: 'usd-coin' }
    ],
    cache: {
      get: async () => stored,
      put: async snapshot => {
        stored = snapshot
      }
    },
    now: () => NOW,
    fetch: async input => {
      const url = new URL(String(input))
      requests.push(url)
      return new Response(
        JSON.stringify(
          url.pathname.startsWith('/percentage/')
            ? { coins: { 'coingecko:solana': -2.81981, 'coingecko:usd-coin': 0.00693 } }
            : {
                coins: {
                  'coingecko:solana': {
                    price: 102.95,
                    timestamp: Math.floor((NOW - 30_000) / 1_000)
                  },
                  'coingecko:usd-coin': {
                    price: 0.999872,
                    timestamp: Math.floor((NOW - 30_000) / 1_000)
                  }
                }
              }
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
  })

  const result = await service.refresh()

  expect(requests).toHaveLength(2)
  expect(requests.map(request => request.origin + request.pathname)).toEqual([
    `${DEFI_LLAMA_PERCENTAGE_URL}/coingecko:solana,coingecko:usd-coin`,
    `${DEFI_LLAMA_CURRENT_PRICE_URL}/coingecko:solana,coingecko:usd-coin`
  ])
  expect(requests[0].searchParams.get('period')).toBe('24h')
  expect(result.quotes).toEqual([
    {
      assetId: SOL_ASSET_ID,
      marketAssetId: 'solana',
      percent24h: '-2.81981',
      observedPriceUsd: '102.95',
      fetchedAt: NOW - 30_000,
      freshness: 'fresh'
    },
    {
      assetId: USDC_ASSET_ID,
      marketAssetId: 'usd-coin',
      percent24h: '0.00693',
      observedPriceUsd: '0.999872',
      fetchedAt: NOW - 30_000,
      freshness: 'fresh'
    }
  ])
  expect(stored.quotes).toHaveLength(2)
})

test('adds DefiLlama change without replacing the wallet price or a DEX change', () => {
  const prices = {
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: NOW,
    quotes: [
      {
        assetId: SOL_ASSET_ID,
        source: 'near-intents-1click',
        priceUsd: '103',
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
        freshness: 'fresh'
      },
      {
        assetId: USDC_ASSET_ID,
        source: 'dex-screener',
        priceUsd: '1',
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
        freshness: 'fresh',
        marketChange: {
          source: 'dex-screener',
          percent24h: '0.01',
          fetchedAt: NOW,
          freshness: 'fresh'
        }
      }
    ],
    missingAssetIds: []
  }
  const market = {
    fetchedAt: NOW,
    quotes: [
      {
        assetId: SOL_ASSET_ID,
        marketAssetId: 'solana',
        percent24h: '-2.8',
        observedPriceUsd: '102.95',
        fetchedAt: NOW,
        freshness: 'fresh'
      },
      {
        assetId: USDC_ASSET_ID,
        marketAssetId: 'usd-coin',
        percent24h: '0.02',
        observedPriceUsd: '1',
        fetchedAt: NOW,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }

  const merged = mergeDefiLlamaMarketChanges(prices, market)

  expect(merged.quotes[0]).toMatchObject({
    source: 'near-intents-1click',
    priceUsd: '103',
    marketChange: { source: 'defi-llama', percent24h: '-2.8' }
  })
  expect(merged.quotes[1].marketChange).toMatchObject({
    source: 'dex-screener',
    percent24h: '0.01'
  })
})

test('rejects a DefiLlama change when its observed price disagrees with the wallet price', () => {
  const prices = {
    source: 'wallet-market-data',
    status: 'ready',
    fetchedAt: NOW,
    quotes: [
      {
        assetId: SOL_ASSET_ID,
        source: 'near-intents-1click',
        priceUsd: '100',
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }
  const market = {
    fetchedAt: NOW,
    quotes: [
      {
        assetId: SOL_ASSET_ID,
        marketAssetId: 'solana',
        percent24h: '-2.8',
        observedPriceUsd: '80',
        fetchedAt: NOW,
        freshness: 'fresh'
      }
    ],
    missingAssetIds: []
  }

  const merged = mergeDefiLlamaMarketChanges(prices, market)

  expect(merged.quotes[0]).toEqual(prices.quotes[0])
})

test('keeps an unexpired cached change when DefiLlama is temporarily unavailable', async () => {
  const stored = {
    version: 1,
    fetchedAt: NOW - 20 * 60_000,
    quotes: [
      {
        marketAssetId: 'solana',
        percent24h: '-1.5',
        observedPriceUsd: '101',
        fetchedAt: NOW - 31 * 60_000
      }
    ]
  }
  const service = new DefiLlamaMarketChangeService({
    mappings: [{ assetId: SOL_ASSET_ID, marketAssetId: 'solana' }],
    cache: {
      get: async () => stored,
      put: async () => {}
    },
    now: () => NOW,
    fetch: async () => new Response(null, { status: 429 })
  })

  const result = await service.refresh()

  expect(result.quotes).toEqual([
    {
      assetId: SOL_ASSET_ID,
      marketAssetId: 'solana',
      percent24h: '-1.5',
      observedPriceUsd: '101',
      fetchedAt: NOW - 31 * 60_000,
      freshness: 'stale'
    }
  ])
  expect(result.missingAssetIds).toEqual([])
})

test('maps BNB and AVAX IDs and retains a cached quote on a partial response', async () => {
  const bnbAssetId = 'eip155:56/slip44:714'
  const avaxAssetId = 'eip155:43114/slip44:9000'
  const stored = {
    version: 1,
    fetchedAt: NOW - 20 * 60_000,
    quotes: [
      {
        marketAssetId: 'avalanche',
        percent24h: '-1',
        observedPriceUsd: '20',
        fetchedAt: NOW - 31 * 60_000
      }
    ]
  }
  const requests = []
  const service = new DefiLlamaMarketChangeService({
    mappings: [
      { assetId: bnbAssetId, marketAssetId: 'bnb' },
      { assetId: avaxAssetId, marketAssetId: 'avalanche' }
    ],
    cache: { get: async () => stored, put: async () => {} },
    now: () => NOW,
    fetch: async input => {
      const url = new URL(String(input))
      requests.push(url)
      return Response.json(
        url.pathname.startsWith('/percentage/')
          ? { coins: { 'coingecko:binancecoin': 2.5 } }
          : {
              coins: {
                'coingecko:binancecoin': {
                  price: 600,
                  timestamp: Math.floor((NOW - 10_000) / 1_000)
                }
              }
            }
      )
    }
  })

  const result = await service.refresh()

  expect(requests[0].pathname).toContain('coingecko:binancecoin,coingecko:avalanche-2')
  expect(result.quotes).toMatchObject([
    { assetId: bnbAssetId, percent24h: '2.5', freshness: 'fresh' },
    { assetId: avaxAssetId, percent24h: '-1', freshness: 'stale' }
  ])
})

test('does not render a repeated network name before direct-asset price change', () => {
  const source = readFileSync(
    new URL('../../../src/popup/components/portfolio/PortfolioAssetGroupCard.tsx', import.meta.url),
    'utf8'
  )

  expect(source).not.toContain('networkName={directAsset')
})
