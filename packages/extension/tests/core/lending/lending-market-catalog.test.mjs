import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getLendingMarket,
  getLendingMarketViews,
  normalizeLendingMarketSymbol,
  sortLendingMarketsBySupplyApy
} from '../../../src/core/services/lending-market-catalog.ts'
import { parseLendingMarketCacheState } from '../../../src/infrastructure/lending/chrome-lending-market-cache.ts'

function market(tokenId, symbol) {
  return {
    id: tokenId,
    tokenId,
    destinationAssetId:
      tokenId === 'zec.omft.near' ? '1cs_v1:near:nep141:zec.omft.near' : `nep141:${tokenId}`,
    symbol,
    displayName: symbol
  }
}

test('builds every SDK market and user position with lending balance precision', () => {
  const assets = {
    'eth.bridge.near': {
      metadata: { name: 'Ether', symbol: 'ETH', decimals: 18, icon: 'eth.svg' },
      config: { extra_decimals: 10 },
      price: { usd: '2500' },
      supplied: { balance: '420000000000000000000000000000' },
      supply_apr: '0',
      farms: { supplied: {}, borrowed: {}, tokennetbalance: {} }
    },
    '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near': {
      metadata: { name: 'Dai Stablecoin', symbol: 'DAI', decimals: 18, icon: null },
      config: { extra_decimals: 10 },
      price: { usd: '1' },
      supplied: { balance: '10000000000000000000000000000' },
      supply_apr: '0',
      farms: { supplied: {}, borrowed: {}, tokennetbalance: {} }
    }
  }
  const portfolio = {
    supplied: {
      'eth.bridge.near': { balance: '10000000000000000000000000000' }
    },
    collateral: {
      'eth.bridge.near': { balance: '5000000000000000000000000000' }
    }
  }

  const markets = getLendingMarketViews(assets, portfolio)

  expect(markets).toHaveLength(2)
  expect(getLendingMarket(markets, 'eth.bridge.near')).toMatchObject({
    id: 'eth.bridge.near',
    symbol: 'ETH',
    totalSupplied: '42',
    totalSuppliedUsd: '105000',
    supplied: '1.5',
    suppliedUsd: '3750'
  })
  expect(
    getLendingMarket(markets, '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near')
  ).toMatchObject({
    symbol: 'DAI',
    displayName: 'Dai Stablecoin',
    destinationAssetId: 'nep141:6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
    totalSupplied: '1'
  })
})

test('sorts lending markets by descending supply APY and preserves ties', () => {
  const markets = [
    { ...market('first.near', 'FIRST'), supplyApy: '4.5' },
    { ...market('highest.near', 'HIGH'), supplyApy: '12' },
    { ...market('second.near', 'SECOND'), supplyApy: '4.5' },
    { ...market('lowest.near', 'LOW'), supplyApy: '0' }
  ]

  expect(sortLendingMarketsBySupplyApy(markets).map(item => item.id)).toEqual([
    'highest.near',
    'first.near',
    'second.near',
    'lowest.near'
  ])
  expect(markets.map(item => item.id)).toEqual([
    'first.near',
    'highest.near',
    'second.near',
    'lowest.near'
  ])
})

test('preserves bridge suffixes while formatting native market aliases', () => {
  expect(normalizeLendingMarketSymbol('wNEAR')).toBe('NEAR')
  expect(normalizeLendingMarketSymbol('NBTC')).toBe('BTC')
  expect(normalizeLendingMarketSymbol('USDT.e')).toBe('USDT.e')
  expect(normalizeLendingMarketSymbol('USDC.e')).toBe('USDC.e')
})

test('oversized SDK icons fall back without making market snapshots invalid', () => {
  const assets = {
    'asset.near': {
      metadata: {
        name: 'Asset',
        symbol: 'AST',
        decimals: 24,
        icon: `data:image/svg+xml,${'a'.repeat(2049)}`
      },
      config: { extra_decimals: 0 },
      price: { usd: '1' },
      supplied: { balance: '0' },
      supply_apr: '0',
      farms: { supplied: {}, borrowed: {}, tokennetbalance: {} }
    }
  }
  const [market] = getLendingMarketViews(assets, undefined)
  expect(market).toMatchObject({ id: 'asset.near', symbol: 'AST' })
  expect(market).not.toHaveProperty('icon')
  const version = parseLendingMarketCacheState(null).version
  const parsed = parseLendingMarketCacheState({
    version,
    entries: { 'wallet:account:mainnet': { cachedAt: Date.now(), markets: [market] } }
  })
  expect(parsed.entries['wallet:account:mainnet'].markets[0]).not.toHaveProperty('icon')
})
