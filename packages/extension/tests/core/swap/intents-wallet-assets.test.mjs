import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createIntentsWalletAssetCatalog,
  resolveIntentsWalletAsset
} from '../../../src/core/services/intents-wallet-assets.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'

function token(overrides) {
  return {
    assetId: 'nep141:sol-usdc.omft.near',
    blockchain: 'sol',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    icon: 'https://example.com/usdc.png',
    price: 1,
    priceUpdatedAt: '2026-08-27T00:00:00.000Z',
    symbol: 'USDC',
    ...overrides
  }
}

test('maps only mainnet SOL, SPL and NEP-141 protocol assets into the wallet registry', () => {
  const sol = token({
    assetId: 'nep141:sol.omft.near',
    contractAddress: null,
    decimals: 9,
    symbol: 'SOL'
  })
  const near = token({
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    contractAddress: 'wrap.near',
    decimals: 24,
    symbol: 'wNEAR'
  })
  const nativeNear = token({
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    contractAddress: null,
    decimals: 24,
    symbol: 'NEAR'
  })
  expect(resolveIntentsWalletAsset(sol, 'mainnet')).toMatchObject({
    assetId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
    kind: 'native'
  })
  expect(resolveIntentsWalletAsset(sol, 'testnet')).toBeNull()
  expect(resolveIntentsWalletAsset(nativeNear, 'mainnet')).toEqual({
    assetId: 'near:mainnet/slip44:397',
    chainId: 'near:mainnet',
    namespace: 'slip44',
    reference: '397',
    kind: 'native'
  })

  const catalog = createIntentsWalletAssetCatalog([sol, token({}), near], 'mainnet')
  const definitions = catalog.definitions
  expect(definitions).toHaveLength(3)
  const chains = createInitialProductChainRegistry('mainnet')
  const registry = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    ...definitions
  ])
  expect(
    registry.resolve(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    )
  ).toMatchObject({ source: 'protocol', verification: 'trusted' })
  expect(registry.resolve('near:mainnet/nep141:wrap.near')).toMatchObject({
    source: 'protocol',
    verification: 'trusted'
  })
  expect(registry.resolve('near:mainnet/nep141:lst.rhealab.near')).toMatchObject({
    metadata: { name: 'rNEAR', symbol: 'rNEAR', decimals: 24 },
    source: 'protocol',
    verification: 'trusted'
  })
  expect(catalog.preferences).toEqual([
    {
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      visibleByDefault: true
    },
    { assetId: 'near:mainnet/nep141:wrap.near', visibleByDefault: false },
    { assetId: 'near:mainnet/nep141:lst.rhealab.near', visibleByDefault: false }
  ])

  expect(catalog.entries).toHaveLength(4)
  expect(catalog.priceMappings).toEqual([
    {
      assetId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:sol.omft.near'
    },
    {
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:sol-usdc.omft.near'
    },
    {
      assetId: 'near:mainnet/nep141:wrap.near',
      marketAssetId: 'intents-asset',
      sourceAssetId: 'nep141:wrap.near'
    }
  ])
})

test('rejects conflicting protocol metadata for the same on-chain token', () => {
  expect(() =>
    createIntentsWalletAssetCatalog(
      [token({}), token({ assetId: 'alternate', decimals: 9 })],
      'mainnet'
    )
  ).toThrow(/Conflicting Intents token metadata/)
})

test('keeps a CoinGecko icon when a discovered protocol token has no provider icon', () => {
  const coingeckoIcon =
    'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694'
  expect(
    createIntentsWalletAssetCatalog(
      [token({ icon: null, coingeckoId: 'usd-coin', coingeckoIcon })],
      'mainnet'
    ).definitions[0]
  ).toMatchObject({ metadata: { iconUrl: coingeckoIcon } })
})

test('isolates malformed provider token identities instead of poisoning the catalog', () => {
  const catalog = createIntentsWalletAssetCatalog(
    [
      token({}),
      token({ assetId: 'invalid-sol', contractAddress: 'not-a-solana-mint', symbol: 'BAD' }),
      token({
        assetId: 'invalid-near',
        blockchain: 'near',
        contractAddress: 'INVALID.NEAR',
        symbol: 'BAD'
      })
    ],
    'mainnet'
  )
  expect(catalog.entries).toHaveLength(2)
  expect(catalog.entries[0].symbol).toBe('USDC')
  expect(catalog.entries[1].symbol).toBe('rNEAR')
})

test('registers trusted rNEAR even when the external Swap catalog omits it', () => {
  const catalog = createIntentsWalletAssetCatalog([], 'mainnet')

  expect(catalog.definitions).toEqual([
    expect.objectContaining({
      chainId: 'near:mainnet',
      namespace: 'nep141',
      reference: 'lst.rhealab.near',
      metadata: { name: 'rNEAR', symbol: 'rNEAR', decimals: 24 }
    })
  ])
  expect(catalog.preferences).toEqual([
    { assetId: 'near:mainnet/nep141:lst.rhealab.near', visibleByDefault: false }
  ])
})
