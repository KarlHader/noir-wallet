import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildSendAssetSelectionModel,
  hasSendPickerBalance,
  resolveSendAssetSelection,
  sortSendAssetsByBalanceValue
} from '../../../src/popup/services/send-asset-order.ts'
import { estimateShieldSendRouteFee } from '../../../src/popup/services/shield-transfer.ts'
import {
  isExtraTokenPickerAsset,
  sortTokenPickerRows
} from '../../../src/popup/services/token-selector-visibility.ts'

function candidate(key, amount, priceUsd) {
  return Object.freeze({ key, amount, priceUsd })
}

test('sorts send assets by spendable USD value across chains', () => {
  const assets = [
    candidate('eth-mainnet', '0', '3200'),
    candidate('bnb', '0.013082', '585'),
    candidate('eth-arbitrum', '0.005867', '3200'),
    candidate('eth-base', '0.000945', '3200'),
    candidate('btc', '0.000472', '63014'),
    candidate('zec', '0', '42.75')
  ]

  expect(sortSendAssetsByBalanceValue(assets).map(asset => asset.key)).toEqual([
    'btc',
    'eth-arbitrum',
    'bnb',
    'eth-base',
    'eth-mainnet',
    'zec'
  ])
})

test('estimates Shield Send route cost only for the same asset at normalized precision', () => {
  const source = {
    asset: {
      asset: { id: 'source-usdc', chainId: 'eip155:1', namespace: 'erc20', reference: '0x1' },
      metadata: { symbol: 'USDC', decimals: 6 }
    },
    marketAssetId: 'usdc'
  }
  const destination = {
    asset: {
      asset: {
        id: 'destination-usdc',
        chainId: 'eip155:42161',
        namespace: 'erc20',
        reference: '0x2'
      },
      metadata: { symbol: 'USDC', decimals: 18 }
    },
    marketAssetId: 'usdc'
  }
  expect(estimateShieldSendRouteFee(source, destination, '2000000', '1979000000000000000')).toEqual(
    { raw: '21000000000000000', decimals: 18 }
  )
  expect(
    estimateShieldSendRouteFee(
      source,
      { ...destination, marketAssetId: 'other' },
      '2000000',
      '1979000000000000000'
    )
  ).toBeNull()
  expect(
    estimateShieldSendRouteFee(source, destination, '2000000', '2010000000000000000')
  ).toBeNull()
})

test('keeps positive unpriced and zero-value assets in stable provider order', () => {
  const assets = [
    candidate('zero', '0', '1'),
    candidate('unpriced-small', '0.01', null),
    candidate('unpriced-large', '10000', null),
    candidate('priced', '2', '3')
  ]

  expect(sortSendAssetsByBalanceValue(assets).map(asset => asset.key)).toEqual([
    'priced',
    'unpriced-small',
    'unpriced-large',
    'zero'
  ])
})

test('keeps unfunded deposits discoverable without offering them for withdrawal', () => {
  const assets = [
    { symbol: 'OTHER', amount: '0' },
    { symbol: 'ZEC', amount: '0', pinned: true },
    { symbol: 'USDT', amount: '0' },
    { symbol: 'ETH', amount: '0', isNative: true },
    { symbol: 'MISSING', amount: '1000' },
    { symbol: 'USDC', availableRaw: '3000000', decimals: 6, priceUsd: '1' },
    { symbol: 'BNB', amount: '0.1', priceUsd: '50' }
  ]
  const balance = asset => ({ decimals: 0, ...asset })
  const grouped = sortTokenPickerRows(assets, balance, 'grouped')
  expect(
    grouped.filter(asset => !isExtraTokenPickerAsset(balance(asset))).map(asset => asset.symbol)
  ).toEqual(['ZEC', 'BNB', 'USDC', 'MISSING', 'ETH', 'USDT'])
  expect(sortTokenPickerRows(assets, balance, 'withdrawal').map(asset => asset.symbol)).toEqual([
    'BNB',
    'USDC',
    'MISSING'
  ])
})

test('does not mutate the source list and rejects malformed values as zero-value rows', () => {
  const assets = [candidate('invalid', 'not-a-number', '2'), candidate('valid', '1', '2')]
  const sorted = sortSendAssetsByBalanceValue(assets)

  expect(sorted.map(asset => asset.key)).toEqual(['valid', 'invalid'])
  expect(assets.map(asset => asset.key)).toEqual(['invalid', 'valid'])
})

test('keeps ZEC funding sources distinct and excludes unavailable signing sources', () => {
  const input = {
    assets: [],
    zcashSources: [
      { type: 'transparent', available: '0.00405' },
      { type: 'shielded', available: '1.2' }
    ],
    zcashEnabled: true,
    zcashNetwork: 'mainnet',
    zecPrice: 42,
    prices: null,
    selectedNetwork: 'all',
    searchQuery: ''
  }
  expect(buildSendAssetSelectionModel(input).orderedRows).toMatchObject([
    { key: 'zcash:shielded', source: 'shielded', amount: '1.2' },
    { key: 'zcash:transparent', source: 'transparent', amount: '0.00405' }
  ])
  expect(
    buildSendAssetSelectionModel({
      ...input,
      zcashSources: [
        { ...input.zcashSources[0], disabledReason: 'Transparent signing unavailable' },
        input.zcashSources[1]
      ]
    }).orderedRows
  ).toMatchObject([{ key: 'zcash:shielded', source: 'shielded' }])
  expect(
    buildSendAssetSelectionModel({
      ...input,
      zcashSources: input.zcashSources.map(source => ({ ...source, available: '0.00000000' }))
    }).orderedRows
  ).toEqual([])
})

test('shows only the Public EVM balance and leaves an unknown split unavailable', () => {
  const evmAsset = {
    asset: {
      asset: {
        id: 'eip155:100/erc20:0x0000000000000000000000000000000000000001',
        chainId: 'eip155:100'
      },
      metadata: { symbol: 'EURE', name: 'EURE', decimals: 6 },
      balance: {
        totalRaw: '3701725',
        availableRaw: '2701725',
        mainRaw: '2701725',
        privateRaw: '1000000'
      }
    },
    chain: {
      chain: { id: 'eip155:100', family: 'evm', displayName: 'Gnosis' }
    }
  }
  const input = {
    assets: [evmAsset],
    zcashSources: [],
    zcashEnabled: false,
    zcashNetwork: 'mainnet',
    zecPrice: 0,
    prices: null,
    selectedNetwork: 'all',
    searchQuery: ''
  }

  expect(buildSendAssetSelectionModel(input).orderedRows[0]).toMatchObject({ amount: '2.701725' })
  const missing = { totalRaw: '3701725', availableRaw: '3701725' }
  for (const balance of [missing, { ...missing, mainRaw: '0', privateRaw: '3701725' }]) {
    expect(
      buildSendAssetSelectionModel({
        ...input,
        assets: [{ ...evmAsset, asset: { ...evmAsset.asset, balance } }]
      }).orderedRows
    ).toEqual([])
  }
  expect(
    buildSendAssetSelectionModel({
      ...input,
      hiddenAssetIds: new Set([evmAsset.asset.asset.id])
    }).orderedRows
  ).toEqual([])
})

test('keeps positive Confidential raw balances eligible independently of fiat price', () => {
  expect([undefined, '0', '1', '1200000'].filter(hasSendPickerBalance)).toEqual(['1', '1200000'])
})

test('keeps a verified selection until the portfolio has a newer Public balance', () => {
  const selected = {
    chain: { chain: { family: 'evm' } },
    asset: { asset: { id: 'asset' }, balance: { mainRaw: '100' }, updatedAt: 10 }
  }
  const loading = { ...selected, asset: { ...selected.asset, balance: {} } }
  const stale = { ...selected, asset: { ...selected.asset, updatedAt: 5 } }
  const refreshed = { ...selected, asset: { ...selected.asset, updatedAt: 20 } }
  expect(resolveSendAssetSelection([], 'asset', selected)).toBe(selected)
  expect(resolveSendAssetSelection([loading], 'asset', selected)).toBe(selected)
  expect(resolveSendAssetSelection([stale], 'asset', selected)).toBe(selected)
  expect(resolveSendAssetSelection([refreshed], 'asset', selected)).toBe(refreshed)
})
