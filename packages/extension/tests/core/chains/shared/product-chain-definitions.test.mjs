import { test } from 'node:test'
import { expect } from '@playwright/test'

import { getEvmNetworkConfig, getEvmNetworkConfigs } from '../../../../src/config/networks.ts'
import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '../../../../src/config/multichain-feature-flags.ts'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  createInitialProductChainRegistry,
  selectAdditionalEvmNetworks,
  filterAssetDefinitionsForChains,
  getBundledBitcoinAssetDefinitions,
  getBundledInitialProductAssetDefinitions,
  getBundledEvmAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'

test.describe('initial multichain product definitions', () => {
  test('registers the approved mainnet EVM networks and Bitcoin mainnet', () => {
    const registry = createEvmBitcoinChainRegistry('mainnet')

    expect(registry.list().map(chain => chain.id)).toEqual([
      'eip155:1',
      'eip155:42161',
      'eip155:56',
      'eip155:8453',
      'eip155:137',
      'bip122:000000000019d6689c085ae165831e93'
    ])
    expect(registry.list().map(chain => chain.featureFlag)).toEqual([
      ...Array(5).fill(EVM_CHAIN_FEATURE_FLAG),
      BITCOIN_CHAIN_FEATURE_FLAG
    ])
    expect(registry.resolve('eip155:1').capabilities).toMatchObject({
      address: { status: 'available', derivationSchemes: ['bip44', 'imported'] },
      signing: { status: 'available' },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer']
      }
    })
    expect(
      registry.resolve('bip122:000000000019d6689c085ae165831e93').capabilities.transaction
    ).toEqual({
      status: 'available',
      model: 'utxo',
      actions: ['native-transfer']
    })
    expect(
      registry.resolve('bip122:000000000019d6689c085ae165831e93').capabilities.address
        .derivationSchemes
    ).toEqual(['bip84', 'bip44', 'bip49', 'bip86', 'imported'])
    expect(registry.resolve('eip155:8453').displayName).toBe('Base')
    expect(() => registry.resolve('eip155:11155111')).toThrow(/Unsupported chain/)
  })

  test('registers the approved EVM testnets and Bitcoin testnet', () => {
    const registry = createEvmBitcoinChainRegistry('testnet')

    expect(registry.list().map(chain => chain.id)).toEqual([
      'eip155:11155111',
      'eip155:421614',
      'eip155:97',
      'eip155:84532',
      'eip155:80002',
      'bip122:000000000933ea01ad0ee984209779ba'
    ])
    expect(getEvmNetworkConfig('testnet')).toMatchObject({
      numericChainId: 11_155_111,
      networkName: 'sepolia'
    })
  })

  test('registers trusted native assets and Circle-issued USDC on built-in networks', () => {
    for (const network of ['mainnet', 'testnet']) {
      const chains = createEvmBitcoinChainRegistry(network)
      const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions(network))
      expect(assets.list().filter(entry => entry.asset.kind === 'native')).toHaveLength(
        getEvmNetworkConfigs(network).length
      )
      for (const evm of getEvmNetworkConfigs(network)) {
        expect(
          assets.resolve(`${evm.chainId}/slip44:${evm.nativeCurrency.slip44Reference}`)
        ).toMatchObject({
          metadata: {
            symbol: evm.nativeCurrency.symbol,
            decimals: 18
          },
          verification: 'trusted'
        })
      }
      const usdcNetworks = getEvmNetworkConfigs(network).filter(evm => evm.usdcContract)
      expect(usdcNetworks).toHaveLength(4)
      for (const evm of usdcNetworks) {
        expect(
          assets.resolve(`${evm.chainId}/erc20:${evm.usdcContract.toLowerCase()}`)
        ).toMatchObject({
          metadata: { symbol: 'USDC', decimals: 6 },
          verification: 'trusted'
        })
      }
      expect(assets.list().every(entry => entry.verification === 'trusted')).toBe(true)
    }
  })

  test('registers trusted native BTC against the build-network genesis', () => {
    for (const network of ['mainnet', 'testnet']) {
      const chains = createEvmBitcoinChainRegistry(network)
      const assets = createAssetRegistry(chains, getBundledBitcoinAssetDefinitions(network))
      const bitcoin = chains.list().find(chain => chain.family === 'bitcoin')

      expect(assets.list()).toEqual([
        expect.objectContaining({
          asset: expect.objectContaining({
            id: `${bitcoin.id}/slip44:0`,
            kind: 'native'
          }),
          metadata: {
            name: 'Bitcoin',
            symbol: 'BTC',
            decimals: 8
          },
          verification: 'trusted'
        })
      ])
    }
  })

  test('filters bundled assets against release-visible chains without hiding invalid IDs', () => {
    const chains = createInitialProductChainRegistry('mainnet')
    const visible = {
      list: () => [chains.resolve('bip122:00040fe8ec8471911baa1db1266ea15d')],
      get: chainId =>
        chainId === 'bip122:00040fe8ec8471911baa1db1266ea15d' ? chains.get(chainId) : undefined,
      resolve: chainId => chains.resolve(chainId)
    }
    expect(
      filterAssetDefinitionsForChains(
        getBundledInitialProductAssetDefinitions('mainnet'),
        visible
      ).map(asset => asset.reference)
    ).toEqual(['133'])
    expect(() =>
      filterAssetDefinitionsForChains([{ chainId: 'invalid', reference: '0' }], visible)
    ).toThrow(/Invalid CAIP-2/)
  })

  test('does not register a bundled EVM chain twice when the full catalog is supplied', () => {
    const bundled = getEvmNetworkConfigs('mainnet')
    const ethereum = bundled[0]
    const custom = {
      ...ethereum,
      chainId: 'eip155:999999',
      numericChainId: 999999,
      networkName: 'custom',
      displayName: 'Custom'
    }
    expect(() => createInitialProductChainRegistry('mainnet', bundled)).toThrow(
      /Duplicate chain definition: eip155:1/
    )
    const registry = createInitialProductChainRegistry(
      'mainnet',
      selectAdditionalEvmNetworks('mainnet', [...bundled, custom])
    )
    expect(registry.resolve('eip155:1').displayName).toBe('Ethereum')
    expect(registry.resolve('eip155:999999').displayName).toBe('Custom')
  })

  test('binds Zcash and its native asset to the build network genesis', () => {
    const mainnet = createInitialProductChainRegistry('mainnet')
    const testnet = createInitialProductChainRegistry('testnet')

    expect(mainnet.list().map(chain => chain.id)).toEqual([
      'bip122:00040fe8ec8471911baa1db1266ea15d',
      'eip155:1',
      'eip155:42161',
      'eip155:56',
      'eip155:8453',
      'eip155:137',
      'bip122:000000000019d6689c085ae165831e93',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      'near:mainnet'
    ])
    expect(testnet.list().map(chain => chain.id)).toEqual([
      'bip122:05a60a92d99d85997cce3b87616c089f',
      'eip155:11155111',
      'eip155:421614',
      'eip155:97',
      'eip155:84532',
      'eip155:80002',
      'bip122:000000000933ea01ad0ee984209779ba',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'near:testnet'
    ])
    expect(mainnet.list().map(chain => chain.featureFlag)).toEqual([
      ZCASH_CHAIN_FEATURE_FLAG,
      ...Array(5).fill(EVM_CHAIN_FEATURE_FLAG),
      BITCOIN_CHAIN_FEATURE_FLAG,
      SOLANA_CHAIN_FEATURE_FLAG,
      NEAR_CHAIN_FEATURE_FLAG
    ])
    expect(mainnet.resolve('bip122:00040fe8ec8471911baa1db1266ea15d').capabilities).toMatchObject({
      address: { status: 'available', derivationSchemes: ['zip32-unified'] },
      transaction: { status: 'available', model: 'hybrid-utxo' }
    })
    expect(mainnet.resolve('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').capabilities).toEqual({
      address: {
        status: 'available',
        addressSchemes: ['solana'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['legacy'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer']
      }
    })
    expect(testnet.resolve('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1').capabilities).toEqual({
      address: {
        status: 'available',
        addressSchemes: ['solana'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['legacy'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer']
      }
    })
    expect(mainnet.resolve('near:mainnet').capabilities).toEqual({
      address: {
        status: 'available',
        addressSchemes: ['near'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['borsh-v0'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer', 'contract-call']
      }
    })
    expect(testnet.resolve('near:testnet').capabilities).toEqual({
      address: {
        status: 'available',
        addressSchemes: ['near'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['borsh-v0'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer', 'contract-call']
      }
    })

    const assets = createAssetRegistry(mainnet, getBundledInitialProductAssetDefinitions('mainnet'))
    expect(assets.list().map(entry => entry.asset.id)).toEqual([
      'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      'eip155:1/slip44:60',
      'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      'eip155:42161/slip44:60',
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      'eip155:56/slip44:714',
      'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      'eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955',
      'eip155:8453/slip44:60',
      'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      'eip155:137/slip44:966',
      'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      'eip155:137/erc20:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
      'bip122:000000000019d6689c085ae165831e93/slip44:0',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
      'near:mainnet/slip44:397',
      'near:mainnet/nep141:wrap.near'
    ])
  })
})
