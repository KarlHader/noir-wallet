import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildSendAssetSelectionModel,
  prepareManagedSendAsset,
  resolveSendAssetSelection,
  sortSendAssetsByBalanceValue
} from '../../../src/popup/services/send-asset-order.ts'
import { estimateShieldSendRouteFee } from '../../../src/popup/services/shield-transfer.ts'
import { createInitialProductChainRegistry } from '../../../src/core/chains/registry/index.ts'
import { resolveEvmSendAvailableRaw } from '../../../src/popup/services/evm-send-routing.ts'

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

function managedEntry() {
  const chainId = 'eip155:1'
  const reference = `0x${'ab'.repeat(20)}`
  const assetId = `${chainId}/erc20:${reference}`
  const metadata = { name: 'Directory Token', symbol: 'DIR', decimals: 6 }
  const token = {
    assetId,
    chainId,
    reference,
    metadata,
    source: 'intents',
    registered: false,
    catalogAsset: {
      protocolAssetId: 'nep141:directory.omft.near',
      assetId,
      chainId,
      namespace: 'erc20',
      reference,
      blockchain: 'eth',
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      management: 'evm'
    }
  }
  return {
    token,
    chain: {
      chain: createInitialProductChainRegistry('mainnet').resolve(chainId),
      status: 'ready',
      assets: [],
      errorCodes: []
    }
  }
}

test('includes searchable enabled-chain directory metadata without fabricating balances or hidden rows', () => {
  const entry = managedEntry()
  const hiddenReference = `0x${'cd'.repeat(20)}`
  const hidden = {
    ...entry.token,
    assetId: `eip155:1/erc20:${hiddenReference}`,
    reference: hiddenReference
  }
  const otherChain = {
    ...entry.token,
    assetId: `eip155:56/erc20:${entry.token.reference}`,
    chainId: 'eip155:56'
  }
  const input = {
    assets: [],
    chains: [entry.chain],
    catalog: [entry.token, hidden, otherChain],
    hiddenAssetIds: new Set([hidden.assetId]),
    zcashSources: [],
    zcashEnabled: false,
    zcashNetwork: 'mainnet',
    zecPrice: 0,
    prices: null,
    selectedNetwork: 'eip155:1',
    searchQuery: ''
  }
  expect(buildSendAssetSelectionModel(input).orderedRows).toEqual([
    expect.objectContaining({ kind: 'catalog', key: entry.token.assetId, amount: null })
  ])
  expect(
    buildSendAssetSelectionModel({
      ...input,
      hiddenAssetIds: new Set([entry.token.assetId, hidden.assetId])
    }).orderedRows
  ).toEqual([])
  expect(
    buildSendAssetSelectionModel({ ...input, searchQuery: entry.token.reference }).orderedRows
  ).toHaveLength(1)
})

test('prepares only the selected token using a verified definition and a real Public balance including zero', async () => {
  const entry = managedEntry()
  const record = {
    assetId: entry.token.assetId,
    chainId: entry.token.chainId,
    contractAddress: entry.token.reference,
    metadata: entry.token.metadata,
    source: 'intents-catalog',
    addedAt: 1
  }
  const calls = []
  const input = {
    entry,
    isCurrent: () => true,
    register: async token => {
      calls.push(['register', token.assetId])
      return record
    },
    readPublicBalance: async (chainId, contract) => {
      calls.push(['balance', chainId, contract])
      return '0'
    }
  }
  const selected = await prepareManagedSendAsset(input)
  expect(calls).toEqual([
    ['register', entry.token.assetId],
    ['balance', entry.token.chainId, entry.token.reference]
  ])
  expect(selected.asset.asset.id).toBe(entry.token.assetId)
  expect(resolveEvmSendAvailableRaw(selected.asset.balance, 'main')).toBe('0')
  expect(resolveEvmSendAvailableRaw(selected.asset.balance, 'private')).toBeNull()
  expect(resolveSendAssetSelection([], entry.token.assetId, selected)).toBe(selected)
  const loading = {
    ...selected,
    asset: { ...selected.asset, balance: { ...selected.asset.balance, mainRaw: undefined } }
  }
  expect(resolveSendAssetSelection([loading], entry.token.assetId, selected)).toBe(selected)
  const old = { ...selected, asset: { ...selected.asset, updatedAt: selected.asset.updatedAt - 1 } }
  expect(resolveSendAssetSelection([old], entry.token.assetId, selected)).toBe(selected)
  const refreshed = {
    ...selected,
    asset: {
      ...selected.asset,
      updatedAt: selected.asset.updatedAt + 1,
      balance: { ...selected.asset.balance, mainRaw: '100' }
    }
  }
  expect(resolveSendAssetSelection([refreshed], entry.token.assetId, selected)).toBe(refreshed)
  calls.length = 0
  await expect(
    prepareManagedSendAsset({
      ...input,
      register: async () => ({ ...record, metadata: { ...record.metadata, decimals: 18 } })
    })
  ).rejects.toThrow('does not match')
  expect(calls).toEqual([])
})

test('discards stale directory selections and propagates a failed balance read instead of selecting zero', async () => {
  const entry = managedEntry()
  const record = {
    assetId: entry.token.assetId,
    chainId: entry.token.chainId,
    contractAddress: entry.token.reference,
    metadata: entry.token.metadata,
    source: 'intents-catalog',
    addedAt: 1
  }
  let current = true
  let balanceCalls = 0
  const input = {
    entry,
    isCurrent: () => current,
    register: async () => {
      current = false
      return record
    },
    readPublicBalance: async () => {
      balanceCalls++
      return '100'
    }
  }
  expect(await prepareManagedSendAsset(input)).toBeNull()
  expect(balanceCalls).toBe(0)
  current = true
  expect(
    await prepareManagedSendAsset({
      ...input,
      register: async () => record,
      readPublicBalance: async () => {
        current = false
        return '100'
      }
    })
  ).toBeNull()
  current = true
  await expect(
    prepareManagedSendAsset({
      ...input,
      register: async () => record,
      readPublicBalance: async () => {
        throw new Error('RPC offline')
      }
    })
  ).rejects.toThrow('RPC offline')
})
