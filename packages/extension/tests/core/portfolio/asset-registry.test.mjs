import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createChainRegistry,
  parseAssetId
} from '../../../src/core/chains/registry/index.ts'

const capabilities = {
  address: {
    status: 'available',
    addressSchemes: ['eip55'],
    derivationSchemes: ['bip44'],
    supportsRotation: false,
    supportsChange: false
  },
  signing: {
    status: 'available',
    transactionFormats: ['eip1559'],
    messageFormats: ['eip191']
  },
  transaction: {
    status: 'available',
    model: 'account',
    actions: ['native-transfer', 'token-transfer', 'contract-call']
  }
}

const chains = createChainRegistry([
  {
    id: 'eip155:1',
    family: 'evm',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Ethereum',
    featureFlag: 'chain.evm',
    capabilities
  },
  {
    id: 'eip155:8453',
    family: 'evm',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Base',
    featureFlag: 'chain.evm',
    capabilities
  }
])

function asset(overrides = {}) {
  return {
    chainId: 'eip155:1',
    namespace: 'erc20',
    reference: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    kind: 'token',
    metadata: {
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6
    },
    source: 'bundled',
    verification: 'trusted',
    ...overrides
  }
}

test.describe('Asset registry', () => {
  test('uses canonical CAIP-19 IDs and allows the same symbol on different chains', () => {
    const registry = createAssetRegistry(chains, [
      asset(),
      asset({
        chainId: 'eip155:8453',
        reference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      }),
      asset({
        namespace: 'slip44',
        reference: '60',
        kind: 'native',
        metadata: { name: 'Ether', symbol: 'ETH', decimals: 18 }
      })
    ])

    expect(registry.list().map(entry => entry.metadata.symbol)).toEqual(['USDC', 'USDC', 'ETH'])
    expect(registry.list().map(entry => entry.asset.id)).toEqual([
      'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      'eip155:1/slip44:60'
    ])
    expect(
      registry.resolve('eip155:1/erc20:0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48').metadata.name
    ).toBe('USD Coin')
  })

  test('isolates discovered assets from listed portfolio assets', () => {
    const discoveredReference = '0x1111111111111111111111111111111111111111'
    const blockedReference = '0x2222222222222222222222222222222222222222'
    const discoveredId = `eip155:1/erc20:${discoveredReference}`
    const blockedId = `eip155:1/erc20:${blockedReference}`
    const registry = createAssetRegistry(chains, [
      asset(),
      asset({
        reference: discoveredReference,
        source: 'discovered',
        verification: 'unverified',
        metadata: {
          name: 'Claim Reward',
          symbol: 'USDC',
          decimals: 18
        }
      }),
      asset({
        reference: blockedReference,
        source: 'discovered',
        verification: 'blocked'
      })
    ])

    expect(registry.list()).toHaveLength(1)
    expect(registry.listQuarantined()).toHaveLength(1)
    expect(registry.get(discoveredId)).toBeUndefined()
    expect(registry.inspect(discoveredId)?.verification).toBe('unverified')
    expect(registry.inspect(blockedId)?.verification).toBe('blocked')
    expect(() => registry.resolve(discoveredId)).toThrow(/not listed/)
  })

  test('rejects invalid contracts, decimals, metadata, and trust promotion', () => {
    expect(() => createAssetRegistry(chains, [asset({ reference: '0x1234' })])).toThrow(
      /contract address/
    )
    expect(() =>
      createAssetRegistry(chains, [asset({ reference: `0x${'0'.repeat(40)}` })])
    ).toThrow(/contract address/)
    expect(() =>
      createAssetRegistry(chains, [
        asset({
          metadata: {
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6.5
          }
        })
      ])
    ).toThrow(/decimals/)
    expect(() =>
      createAssetRegistry(chains, [
        asset({
          metadata: {
            name: 'USD\u202eCoin',
            symbol: 'USDC',
            decimals: 6
          }
        })
      ])
    ).toThrow(/asset name/)
    expect(() =>
      createAssetRegistry(chains, [
        asset({
          source: 'discovered',
          verification: 'trusted'
        })
      ])
    ).toThrow(/cannot use verification/)
    expect(() =>
      createAssetRegistry(chains, [asset({ source: 'remote', verification: 'blocked' })])
    ).toThrow(/asset definition/)
    expect(() => createAssetRegistry(chains, [asset({ kind: 'collectible' })])).toThrow(
      /asset definition/
    )
    expect(() =>
      createAssetRegistry(chains, [
        asset({
          metadata: {
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
            icon: 'https://untrusted.example/token.svg'
          }
        })
      ])
    ).toThrow(/asset metadata/)
  })

  test('rejects unknown token namespaces and canonical duplicates', () => {
    expect(() => createAssetRegistry(chains, [asset({ namespace: 'unknown' })])).toThrow(
      /No asset reference validator/
    )

    expect(() =>
      createAssetRegistry(chains, [
        asset(),
        asset({
          reference: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
        })
      ])
    ).toThrow(/Duplicate asset definition/)
  })

  test('parses only bounded canonical CAIP-19 syntax', () => {
    expect(parseAssetId('eip155:1/slip44:60')).toMatchObject({
      chainId: 'eip155:1',
      namespace: 'slip44',
      reference: '60'
    })
    expect(() => parseAssetId('eip155:1/erc20:token/1')).toThrow(/asset ID/)
    expect(() => parseAssetId('eip155:1/nep141:token%2fnear')).toThrow(/asset reference/)
    expect(() => parseAssetId('eip155:1/nep141:token%2Fnear')).not.toThrow()
  })

  test('returns immutable entries and chain-scoped listed views', () => {
    const registry = createAssetRegistry(chains, [
      asset(),
      asset({
        chainId: 'eip155:8453',
        reference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      })
    ])
    const ethereumId = parseAssetId('eip155:1/slip44:60').chainId
    const ethereumAssets = registry.list(ethereumId)

    expect(ethereumAssets).toHaveLength(1)
    expect(Object.isFrozen(ethereumAssets)).toBe(true)
    expect(Object.isFrozen(ethereumAssets[0])).toBe(true)
    expect(Object.isFrozen(ethereumAssets[0].asset)).toBe(true)
    expect(Object.isFrozen(ethereumAssets[0].metadata)).toBe(true)
  })
})
