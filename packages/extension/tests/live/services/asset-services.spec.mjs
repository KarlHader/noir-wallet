import { expect, test } from '@playwright/test'
import {
  DexScreenerMarketChangeService,
  OneClickAssetPriceService
} from '../../../src/infrastructure/prices/index.ts'
import { mergeAssetMarketChanges } from '../../../src/background/asset-prices.ts'
import {
  createPriceMappings,
  createMarketMappings,
  createProtocolMappings
} from '../../helpers/asset-market-fixtures.mjs'

test.describe('live trusted asset price sources', () => {
  test.skip(
    process.env.LIVE_ASSET_PRICE_INTEGRATION !== '1',
    'Set LIVE_ASSET_PRICE_INTEGRATION=1 to enable'
  )

  for (const network of ['mainnet', 'testnet']) {
    test(`resolves every ${network} release asset from the configured sources`, async () => {
      const { mappings } = createPriceMappings(network)
      const service = new OneClickAssetPriceService({
        mappings,
        cache: { get: async () => null, put: async () => {} }
      })

      const prices = await service.refresh()
      expect(prices.status).toBe('ready')
      expect(prices.missingAssetIds).toEqual([])
      expect(prices.quotes).toHaveLength(mappings.length)
      expect(prices.quotes.every(quote => Number(quote.priceUsd) > 0)).toBe(true)
    })
  }

  test('resolves every configured trusted-pool 24-hour change', async () => {
    const { mappings } = createMarketMappings('mainnet')
    const { mappings: priceMappings } = createPriceMappings('mainnet')
    const service = new DexScreenerMarketChangeService({
      mappings,
      cache: { get: async () => null, put: async () => {} }
    })
    const priceService = new OneClickAssetPriceService({
      mappings: priceMappings,
      cache: { get: async () => null, put: async () => {} }
    })

    const [market, prices] = await Promise.all([service.refresh(), priceService.refresh()])
    expect(market.missingAssetIds).toEqual([])
    expect(market.quotes).toHaveLength(mappings.length)
    const merged = mergeAssetMarketChanges(prices, market)
    expect(merged.quotes.filter(quote => quote.marketChange)).toHaveLength(mappings.length)
    expect(merged.quotes.filter(quote => quote.source === 'dex-screener')).toHaveLength(
      mappings.length
    )
  })
})

test.describe('live 1Click protocol asset catalog', () => {
  test.skip(
    process.env.LIVE_PROTOCOL_ASSET_INTEGRATION !== '1',
    'Set LIVE_PROTOCOL_ASSET_INTEGRATION=1 to enable'
  )

  test('contains every exact mainnet wallet quote identity with matching precision', async () => {
    const { assets, mappings } = createProtocolMappings('mainnet')
    const response = await fetch('https://1click.chaindefuser.com/v0/tokens', {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
    expect(response.ok).toBe(true)
    const tokens = await response.json()
    expect(Array.isArray(tokens)).toBe(true)
    const byId = new Map(tokens.map(token => [token.assetId, token]))

    for (const mapping of mappings) {
      const token = byId.get(mapping.protocolAssetId)
      expect(token, mapping.protocolAssetId).toBeDefined()
      expect(token.decimals, mapping.protocolAssetId).toBe(
        assets.resolve(mapping.assetId).metadata.decimals
      )
      expect(Number(token.price), mapping.protocolAssetId).toBeGreaterThan(0)
    }
  })
})
