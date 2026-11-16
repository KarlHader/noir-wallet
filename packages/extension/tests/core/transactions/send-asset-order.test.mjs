import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildSendAssetSelectionModel,
  sortSendAssetsByBalanceValue
} from '../../../src/popup/pages/transactions/send-asset-order.ts'
import { estimateShieldSendRouteFee } from '../../../src/popup/services/shield-transfer.ts'

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

test('does not mutate the source list and rejects malformed values as zero-value rows', () => {
  const assets = [candidate('invalid', 'not-a-number', '2'), candidate('valid', '1', '2')]
  const sorted = sortSendAssetsByBalanceValue(assets)

  expect(sorted.map(asset => asset.key)).toEqual(['valid', 'invalid'])
  expect(assets.map(asset => asset.key)).toEqual(['invalid', 'valid'])
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
    zcashTotal: '0',
    zcashEnabled: false,
    zcashNetwork: 'mainnet',
    zecPrice: 0,
    prices: null,
    selectedNetwork: 'all',
    searchQuery: ''
  }

  expect(buildSendAssetSelectionModel(input).orderedRows[0]).toMatchObject({ amount: '2.701725' })
  expect(
    buildSendAssetSelectionModel({
      ...input,
      assets: [
        {
          ...evmAsset,
          asset: { ...evmAsset.asset, balance: { totalRaw: '3701725' } }
        }
      ]
    }).orderedRows[0]
  ).toMatchObject({ amount: null })
})
