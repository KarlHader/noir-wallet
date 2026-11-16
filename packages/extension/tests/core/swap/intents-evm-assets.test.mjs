import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import { resolveManagedIntentsAssets } from '../../../src/core/services/intents-managed-assets.ts'
import {
  getDefaultIntentsEvmAssets,
  resolveIntentsEvmAssets,
  resolveIntentsEvmChainId
} from '../../../src/core/services/intents-evm-assets.ts'

const updatedAt = '2026-08-25T00:00:00.000Z'

test('resolves an EVM chain alias without requiring Token contract metadata', () => {
  const networks = getEvmNetworkConfigs('mainnet')
  expect(resolveIntentsEvmChainId(' BSC ', networks)).toBe('eip155:56')
  expect(resolveIntentsEvmChainId('near', networks)).toBeNull()
})

test('maps only canonical supported Intents ERC-20 assets to wallet AssetIds', () => {
  const assets = resolveIntentsEvmAssets(
    [
      {
        assetId: 'eth-usdt',
        blockchain: 'ethereum',
        contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals: 6,
        icon: 'https://assets.example/usdt.png',
        price: 1,
        priceUpdatedAt: updatedAt,
        symbol: 'USDT'
      },
      {
        assetId: 'arb-usdc',
        blockchain: 'arb',
        contractAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
        price: 1,
        priceUpdatedAt: updatedAt,
        symbol: 'USDC'
      },
      {
        assetId: 'near-usdt',
        blockchain: 'near',
        contractAddress: 'usdt.tether-token.near',
        decimals: 6,
        price: 1,
        priceUpdatedAt: updatedAt,
        symbol: 'USDT'
      }
    ],
    getEvmNetworkConfigs('mainnet')
  )

  expect(assets).toEqual([
    expect.objectContaining({
      assetId: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      chainId: 'eip155:1',
      symbol: 'USDT'
    }),
    expect.objectContaining({
      assetId: 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      chainId: 'eip155:42161',
      symbol: 'USDC'
    })
  ])
  expect(getDefaultIntentsEvmAssets(assets)).toEqual(assets)
})

test('prefers the current BSC representation when a deprecated row shares its contract', () => {
  const contractAddress = '0x55d398326f99059ff775485246999027b3197955'
  const legacy = {
    assetId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
    blockchain: 'bsc',
    contractAddress,
    decimals: 18,
    price: 1,
    priceUpdatedAt: updatedAt,
    symbol: 'USDT(DEPRECATED)'
  }
  const current = {
    ...legacy,
    assetId: `nep141:bnb-${contractAddress}.omdep.near`,
    symbol: 'USDT'
  }
  expect(
    resolveIntentsEvmAssets([{ ...legacy, symbol: 'USDT' }], getEvmNetworkConfigs('mainnet'))
  ).toEqual([])
  expect(
    resolveIntentsEvmAssets(
      [
        {
          ...legacy,
          assetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
          blockchain: 'op',
          symbol: 'USDC'
        }
      ],
      getEvmNetworkConfigs('mainnet')
    )
  ).toHaveLength(1)
  const assets = resolveIntentsEvmAssets([legacy, current], getEvmNetworkConfigs('mainnet'))
  expect(assets).toHaveLength(1)
  expect(assets[0]).toMatchObject({
    assetId: `eip155:56/erc20:${contractAddress}`,
    protocolAssetId: current.assetId,
    symbol: 'USDT'
  })
  expect(
    resolveManagedIntentsAssets([legacy, current], 'mainnet', getEvmNetworkConfigs('mainnet')).find(
      asset => asset.assetId === `eip155:56/erc20:${contractAddress}`
    )
  ).toMatchObject({ protocolAssetId: current.assetId, symbol: 'USDT' })
})
