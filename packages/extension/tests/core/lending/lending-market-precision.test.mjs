import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getLendingBalanceDecimals,
  getLendingMarketViews
} from '../../../src/core/services/lending-market-catalog.ts'
import { parseLendingMarketCacheState } from '../../../src/infrastructure/lending/chrome-lending-market-cache.ts'
import Big from '../../../src/lib/big.ts'
import { formatFiatAmount, formatTokenQuantity } from '../../../src/lib/number-format.ts'

function asset(symbol, decimals, extraDecimals, balance, price = '1') {
  return {
    metadata: { name: symbol, symbol, decimals },
    config: { extra_decimals: extraDecimals },
    supplied: { balance },
    price: { usd: price },
    supply_apr: '0',
    farms: { supplied: {}, borrowed: {}, tokennetbalance: {} }
  }
}

test('Lending balances follow each market precision for USDC, rNEAR, ZEC and ETH', () => {
  const assets = {
    'usdc.near': asset('USDC', 6, 12, '6218200000000'),
    'lst.rhealab.near': asset('rNEAR', 24, 0, '2020600000000000000000', '5.3802'),
    'zec.omft.near': asset('ZEC', 8, 10, '10000000000000000', '40'),
    'eth.bridge.near': asset('ETH', 18, 0, '1500000000000000000', '2500')
  }
  const portfolio = {
    supplied: Object.fromEntries(
      Object.entries(assets).map(([id, value]) => [id, { balance: value.supplied.balance }])
    ),
    collateral: {}
  }
  const markets = getLendingMarketViews(assets, portfolio)
  assert.deepEqual(
    markets.map(({ symbol, supplied, totalSupplied, suppliedUsd }) => ({
      symbol,
      supplied,
      totalSupplied,
      suppliedUsd
    })),
    [
      {
        symbol: 'USDC',
        supplied: '0.0000062182',
        totalSupplied: '0.0000062182',
        suppliedUsd: '0.0000062182'
      },
      {
        symbol: 'rNEAR',
        supplied: '0.0020206',
        totalSupplied: '0.0020206',
        suppliedUsd: '0.01087123212'
      },
      { symbol: 'ZEC', supplied: '0.01', totalSupplied: '0.01', suppliedUsd: '0.4' },
      { symbol: 'ETH', supplied: '1.5', totalSupplied: '1.5', suppliedUsd: '3750' }
    ]
  )
  assert.equal(formatTokenQuantity(markets[0].supplied), '0.00000621')
  assert.equal(formatFiatAmount(markets[0].suppliedUsd, { showSign: true }), '<$0.01')
  assert.equal(formatFiatAmount(markets[1].suppliedUsd, { showSign: true }), '$0.01')
})

test('supplied and collateral raw balances are added before precision conversion', () => {
  const [market] = getLendingMarketViews(
    { 'zec.omft.near': asset('ZEC', 8, 10, '2000000000000000000') },
    {
      supplied: { 'zec.omft.near': { balance: '10000000000000001' } },
      collateral: { 'zec.omft.near': { balance: '20000000000000002' } }
    }
  )
  assert.equal(market.supplied, '0.030000000000000003')
  assert.equal(market.totalSupplied, '2')
})

test('sub-cent Lending values are retained until portfolio totals are formatted', () => {
  const assets = {
    'first.near': asset('FIRST', 6, 12, '4900000000000000'),
    'second.near': asset('SECOND', 24, 0, '4900000000000000000000'),
    'third.near': asset('THIRD', 8, 10, '4900000000000000')
  }
  const markets = getLendingMarketViews(assets, {
    supplied: Object.fromEntries(Object.entries(assets).map(([id, value]) => [id, value.supplied]))
  })
  const total = markets.reduce((sum, market) => sum.plus(market.suppliedUsd), new Big(0))
  assert.deepEqual(
    markets.map(market => market.suppliedUsd),
    ['0.0049', '0.0049', '0.0049']
  )
  assert.equal(total.toFixed(), '0.0147')
  assert.equal(formatFiatAmount(total.toFixed(), { showSign: true }), '$0.01')
})

test('invalid or missing Lending precision is not replaced with a ZEC-specific default', () => {
  for (const extra of [undefined, -1, 0.5, 256, '10']) {
    const invalid = asset('INVALID', 6, extra, '1000000000000000000')
    assert.equal(getLendingBalanceDecimals(invalid), null)
    assert.deepEqual(getLendingMarketViews({ invalid }, undefined), [])
  }
  assert.equal(getLendingBalanceDecimals(null), null)
  assert.equal(getLendingBalanceDecimals(asset('rNEAR', 24, 0, '1')), 24)
})

test('Lending snapshots reject old converted balances and preserve sub-cent precision', () => {
  const [market] = getLendingMarketViews(
    { 'tiny.near': asset('TINY', 24, 0, '1', '0.0000000000001') },
    { supplied: { 'tiny.near': { balance: '1' } } }
  )
  const now = Date.now()
  const entries = { 'wallet:account': { cachedAt: now, markets: [market] } }
  assert.throws(
    () => parseLendingMarketCacheState({ version: 2, entries }, now),
    /Invalid Lending market cache/
  )
  const version = parseLendingMarketCacheState(null).version
  const parsed = parseLendingMarketCacheState({ version, entries }, now)
  assert.equal(
    parsed.entries['wallet:account'].markets[0].suppliedUsd,
    '0.0000000000000000000000000000000000001'
  )
})
