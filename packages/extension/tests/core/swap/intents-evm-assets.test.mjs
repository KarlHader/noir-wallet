import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
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
