import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  findManagedIntentsAssetByReference,
  resolveManagedIntentsAsset,
  resolveManagedIntentsAssets
} from '../../../src/core/services/intents-managed-assets.ts'
import { intentsAssetManagerClient } from '../../../src/popup/services/intents-asset-manager-client.ts'
import { resolveEvmNetworkCatalog } from '../../../src/core/chains/evm-runtime-config.ts'
import { DEFAULT_CHAIN_ENDPOINT_SETTINGS } from '../../../src/core/chains/chain-endpoint-settings.ts'

const GNOSIS_USDC = Object.freeze({
  assetId: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near',
  blockchain: 'gnosis',
  contractAddress: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0',
  decimals: 6,
  icon: 'https://assets.example/usdc.png',
  price: 1,
  priceUpdatedAt: '2026-08-28T00:00:00.000Z',
  symbol: 'USDC'
})

const POLYGON_USDT = Object.freeze({
  assetId: 'nep141:polygon-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omft.near',
  blockchain: 'polygon',
  contractAddress: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  decimals: 6,
  price: 1,
  priceUpdatedAt: '2026-08-28T00:00:00.000Z',
  symbol: 'USDT'
})

const SOLANA_USDC = Object.freeze({
  assetId: 'nep141:sol-usdc.omft.near',
  blockchain: 'sol',
  contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  icon: 'https://assets.example/solana-usdc.png',
  price: 1,
  priceUpdatedAt: '2026-08-28T00:00:00.000Z',
  symbol: 'USDC'
})

const NEAR_USDT = Object.freeze({
  assetId: 'nep141:usdt.tether-token.near',
  blockchain: 'near',
  contractAddress: 'usdt.tether-token.near',
  decimals: 6,
  icon: 'https://assets.example/near-usdt.png',
  price: 1,
  priceUpdatedAt: '2026-08-28T00:00:00.000Z',
  symbol: 'USDT'
})

const networks = resolveEvmNetworkCatalog('mainnet', DEFAULT_CHAIN_ENDPOINT_SETTINGS)
const RNEAR_MANAGED_ASSET = Object.freeze({
  protocolAssetId: 'nep141:lst.rhealab.near',
  assetId: 'near:mainnet/nep141:lst.rhealab.near',
  chainId: 'near:mainnet',
  management: 'protocol'
})

test('maps every supported Intents EVM Token into the Manage Tokens catalog', () => {
  expect(
    resolveManagedIntentsAssets([GNOSIS_USDC, POLYGON_USDT], 'mainnet', networks)
  ).toMatchObject([
    {
      protocolAssetId: GNOSIS_USDC.assetId,
      assetId: `eip155:100/erc20:${GNOSIS_USDC.contractAddress}`,
      chainId: 'eip155:100',
      symbol: 'USDC'
    },
    {
      protocolAssetId: POLYGON_USDT.assetId,
      assetId: `eip155:137/erc20:${POLYGON_USDT.contractAddress}`,
      chainId: 'eip155:137',
      symbol: 'USDT'
    },
    RNEAR_MANAGED_ASSET
  ])
})

test('uses the wallet asset adapters to include SPL and NEP-141 Tokens automatically', () => {
  expect(resolveManagedIntentsAssets([SOLANA_USDC, NEAR_USDT], 'mainnet', networks)).toMatchObject([
    {
      protocolAssetId: SOLANA_USDC.assetId,
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      management: 'protocol'
    },
    {
      protocolAssetId: NEAR_USDT.assetId,
      assetId: 'near:mainnet/nep141:usdt.tether-token.near',
      chainId: 'near:mainnet',
      management: 'protocol'
    },
    RNEAR_MANAGED_ASSET
  ])
})

test('resolves the exact Swap destination without symbol or chain ambiguity', () => {
  const catalog = [GNOSIS_USDC, POLYGON_USDT, SOLANA_USDC]

  expect(
    resolveManagedIntentsAsset(catalog, GNOSIS_USDC.assetId, 'mainnet', networks)
  ).toMatchObject({
    protocolAssetId: GNOSIS_USDC.assetId,
    chainId: 'eip155:100',
    reference: GNOSIS_USDC.contractAddress,
    management: 'evm'
  })
  expect(
    resolveManagedIntentsAsset(catalog, SOLANA_USDC.assetId, 'mainnet', networks)
  ).toMatchObject({
    protocolAssetId: SOLANA_USDC.assetId,
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    management: 'protocol'
  })
  expect(
    resolveManagedIntentsAsset(catalog, 'nep141:unknown.omft.near', 'mainnet', networks)
  ).toBeNull()
})

test('finds NEP-141 and SPL Tokens by their exact chain-native address', () => {
  const assets = resolveManagedIntentsAssets([SOLANA_USDC, NEAR_USDT], 'mainnet', networks)

  expect(
    findManagedIntentsAssetByReference(
      assets,
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      SOLANA_USDC.contractAddress
    )
  ).toMatchObject({ protocolAssetId: SOLANA_USDC.assetId })
  expect(
    findManagedIntentsAssetByReference(assets, 'near:mainnet', NEAR_USDT.contractAddress)
  ).toMatchObject({ protocolAssetId: NEAR_USDT.assetId })
  expect(
    findManagedIntentsAssetByReference(assets, 'near:mainnet', SOLANA_USDC.contractAddress)
  ).toBeNull()
})

test('adapts a newly configured EVM chain through its icon-chain identifier', () => {
  const customNetwork = Object.freeze({
    networkMode: 'mainnet',
    chainId: 'eip155:999999',
    numericChainId: 999999,
    networkName: 'example-mainnet',
    displayName: 'Example Chain',
    iconChain: 'example',
    nativeCurrency: {
      name: 'Example',
      symbol: 'EXP',
      decimals: 18,
      slip44Reference: '60'
    },
    rpcUrl: 'https://rpc.example.test',
    explorerUrl: 'https://explorer.example.test'
  })
  const token = Object.freeze({
    ...GNOSIS_USDC,
    assetId: 'nep141:example-usdc.omft.near',
    blockchain: 'example',
    contractAddress: '0x1111111111111111111111111111111111111111'
  })

  expect(resolveManagedIntentsAssets([token], 'mainnet', [customNetwork])).toMatchObject([
    {
      assetId: `eip155:999999/erc20:${token.contractAddress}`,
      chainId: 'eip155:999999',
      management: 'evm'
    },
    RNEAR_MANAGED_ASSET
  ])
})

test('refreshes protocol assets even when default EVM Token activation fails', async () => {
  const originalChrome = globalThis.chrome
  const messages = []
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message)
        if (message.type === 'GET_MANAGED_TOKEN_ASSETS') {
          return {
            result: {
              userAssets: [],
              detectedAssets: [],
              hiddenAssetIds: [],
              protocolAssetIds: []
            }
          }
        }
        if (message.type === 'ENABLE_INTENTS_EVM_ASSETS') {
          throw new Error('EVM discovery is unavailable')
        }
        if (message.type === 'REFRESH_INTENTS_PROTOCOL_ASSETS') {
          return { result: { refreshed: true } }
        }
        throw new Error(`Unexpected message: ${message.type}`)
      }
    }
  }

  try {
    await expect(
      intentsAssetManagerClient.ensureDefaults([GNOSIS_USDC, SOLANA_USDC])
    ).rejects.toThrow('EVM discovery is unavailable')
    expect(messages.map(message => message.type)).toContain('REFRESH_INTENTS_PROTOCOL_ASSETS')
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
  }
})

test('does not re-enable persisted default Tokens when a Popup is reopened', async () => {
  const originalChrome = globalThis.chrome
  const messages = []
  const [evmAsset, protocolAsset, rnearAsset] = resolveManagedIntentsAssets(
    [GNOSIS_USDC, SOLANA_USDC],
    'mainnet',
    networks
  )
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message)
        if (message.type !== 'GET_MANAGED_TOKEN_ASSETS') {
          throw new Error(`Unexpected message: ${message.type}`)
        }
        return {
          result: {
            userAssets: [
              {
                assetId: evmAsset.assetId,
                chainId: evmAsset.chainId,
                contractAddress: evmAsset.reference,
                metadata: {
                  name: 'USD Coin',
                  symbol: evmAsset.symbol,
                  decimals: evmAsset.decimals,
                  iconUrl: evmAsset.iconUrl
                },
                source: 'intents-catalog',
                addedAt: Date.parse('2026-08-28T00:00:00.000Z')
              }
            ],
            detectedAssets: [],
            hiddenAssetIds: [],
            protocolAssetIds: [protocolAsset.assetId, rnearAsset.assetId]
          }
        }
      }
    }
  }

  try {
    await expect(
      intentsAssetManagerClient.ensureDefaults([GNOSIS_USDC, SOLANA_USDC])
    ).resolves.toEqual([])
    expect(messages.map(message => message.type)).toEqual(['GET_MANAGED_TOKEN_ASSETS'])
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
  }
})
