import { test } from 'node:test'
import { expect } from '@playwright/test'

import { getEvmNetworkConfig, getEvmNetworkConfigs } from '../../../../src/config/networks.ts'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  BITCOIN_CHAIN_FEATURE_FLAG,
  DASH_CHAIN_FEATURE_FLAG,
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  PEARL_CHAIN_FEATURE_FLAG,
  QUANTUS_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  STARKNET_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG,
  parseEnabledChainFeatureFlags
} from '../../../../src/config/multichain-feature-flags.ts'
import { getDashNetworkConfig, getStarknetNetworkConfig } from '../../../../src/config/networks.ts'
import {
  normalizeStarknetFelt,
  starknetSpecVersionMeetsMinimum
} from '../../../../src/core/chains/starknet/identifiers.ts'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  createInitialProductChainRegistry,
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
      'eip155:56',
      'eip155:42161',
      'eip155:8453',
      'eip155:10',
      'eip155:137',
      'eip155:43114',
      'eip155:143',
      'eip155:100',
      'eip155:9745',
      'eip155:196',
      'eip155:80094',
      'bip122:000000000019d6689c085ae165831e93'
    ])
    expect(registry.list().map(chain => chain.featureFlag)).toEqual([
      ...Array(12).fill(EVM_CHAIN_FEATURE_FLAG),
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
      'eip155:97',
      'eip155:421614',
      'eip155:84532',
      'eip155:11155420',
      'eip155:80002',
      'eip155:43113',
      'bip122:000000000933ea01ad0ee984209779ba'
    ])
    expect(getEvmNetworkConfig('testnet')).toMatchObject({
      numericChainId: 11_155_111,
      networkName: 'sepolia'
    })
  })

  test('registers trusted native assets and every Circle-issued USDC network', () => {
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
      expect(usdcNetworks).toHaveLength(6)
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
            decimals: 8,
            iconUrl: 'https://assets-cdn.trustwallet.com/blockchains/bitcoin/info/logo.png'
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

  test('binds Zcash and its native asset to the build network genesis', () => {
    const mainnet = createInitialProductChainRegistry('mainnet')
    const testnet = createInitialProductChainRegistry('testnet')

    expect(mainnet.list().map(chain => chain.id)).toEqual([
      'bip122:00040fe8ec8471911baa1db1266ea15d',
      'eip155:1',
      'eip155:56',
      'eip155:42161',
      'eip155:8453',
      'eip155:10',
      'eip155:137',
      'eip155:43114',
      'eip155:143',
      'eip155:100',
      'eip155:9745',
      'eip155:196',
      'eip155:80094',
      'bip122:000000000019d6689c085ae165831e93',
      'bip122:00000ffd590b1485b3caadc19b22e637',
      'bip122:a18d3093b7ff618f0cdd073fa3d10374',
      'quantus:mainnet',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      'near:mainnet',
      'starknet:SN_MAIN'
    ])
    expect(testnet.list().map(chain => chain.id)).toEqual([
      'bip122:05a60a92d99d85997cce3b87616c089f',
      'eip155:11155111',
      'eip155:97',
      'eip155:421614',
      'eip155:84532',
      'eip155:11155420',
      'eip155:80002',
      'eip155:43113',
      'bip122:000000000933ea01ad0ee984209779ba',
      'bip122:00000bafbc94add76cb75e2ec9289483',
      'bip122:b0c86d0cd8825f4d72260d2de46f4704',
      'quantus:planck',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'near:testnet',
      'starknet:SN_SEPOLIA'
    ])
    expect(mainnet.list().map(chain => chain.featureFlag)).toEqual([
      ZCASH_CHAIN_FEATURE_FLAG,
      ...Array(12).fill(EVM_CHAIN_FEATURE_FLAG),
      BITCOIN_CHAIN_FEATURE_FLAG,
      DASH_CHAIN_FEATURE_FLAG,
      PEARL_CHAIN_FEATURE_FLAG,
      QUANTUS_CHAIN_FEATURE_FLAG,
      SOLANA_CHAIN_FEATURE_FLAG,
      NEAR_CHAIN_FEATURE_FLAG,
      STARKNET_CHAIN_FEATURE_FLAG
    ])
    expect(mainnet.resolve('bip122:a18d3093b7ff618f0cdd073fa3d10374')).toMatchObject({
      family: 'pearl',
      namespace: 'bip122',
      featureFlag: PEARL_CHAIN_FEATURE_FLAG,
      capabilities: {
        address: { status: 'available', addressSchemes: ['pearl_p2tr'] },
        transaction: { status: 'available', model: 'utxo', actions: ['native-transfer'] }
      }
    })
    expect(mainnet.resolve('quantus:mainnet')).toMatchObject({
      family: 'quantus',
      namespace: 'quantus',
      featureFlag: QUANTUS_CHAIN_FEATURE_FLAG,
      capabilities: {
        address: {
          status: 'available',
          addressSchemes: ['quantus_ss58'],
          derivationSchemes: ['ml-dsa-87', 'ml-dsa-65']
        },
        transaction: { status: 'available', model: 'account', actions: ['native-transfer'] }
      }
    })
    expect(testnet.resolve('quantus:planck')).toMatchObject({
      family: 'quantus',
      displayName: 'Quantus Planck',
      featureFlag: QUANTUS_CHAIN_FEATURE_FLAG
    })
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
      'eip155:56/slip44:714',
      'eip155:42161/slip44:60',
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      'eip155:8453/slip44:60',
      'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      'eip155:10/slip44:60',
      'eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      'eip155:137/slip44:966',
      'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      'eip155:43114/slip44:9000',
      'eip155:43114/erc20:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      'eip155:143/slip44:268435779',
      'eip155:100/slip44:700',
      'eip155:9745/slip44:60',
      'eip155:196/slip44:60',
      'eip155:80094/slip44:8008',
      'bip122:000000000019d6689c085ae165831e93/slip44:0',
      'bip122:00000ffd590b1485b3caadc19b22e637/slip44:5',
      'bip122:a18d3093b7ff618f0cdd073fa3d10374/slip44:808276',
      'quantus:mainnet/slip44:189189',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
      'near:mainnet/slip44:397',
      'starknet:SN_MAIN/snip2:0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      'starknet:SN_MAIN/snip2:0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
      'starknet:SN_MAIN/snip2:0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
      'starknet:SN_MAIN/snip2:0x53c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8',
      'starknet:SN_MAIN/snip2:0x68f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8'
    ])
  })

  test('registers public Dash without enabling it by default', () => {
    const enabled = parseEnabledChainFeatureFlags(undefined, ALL_CHAIN_FEATURE_FLAGS)
    expect(ALL_CHAIN_FEATURE_FLAGS).toContain(DASH_CHAIN_FEATURE_FLAG)
    expect(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).not.toContain(DASH_CHAIN_FEATURE_FLAG)
    expect(ALL_CHAIN_FEATURE_FLAGS).toContain(PEARL_CHAIN_FEATURE_FLAG)
    expect(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).toContain(PEARL_CHAIN_FEATURE_FLAG)
    expect(enabled).toEqual(['chain.zcash', 'chain.evm', 'chain.pearl', 'chain.quantus'])
    expect(enabled).toContain(PEARL_CHAIN_FEATURE_FLAG)
    expect(enabled).not.toContain(DASH_CHAIN_FEATURE_FLAG)

    for (const network of ['mainnet', 'testnet']) {
      const registry = createInitialProductChainRegistry(network)
      const config = getDashNetworkConfig(network)
      const dash = registry.resolve(config.chainId)
      expect(dash).toMatchObject({
        family: 'dash',
        featureFlag: DASH_CHAIN_FEATURE_FLAG,
        displayName: config.displayName,
        capabilities: {
          address: {
            status: 'available',
            addressSchemes: ['dash_p2pkh'],
            derivationSchemes: ['bip44', 'imported'],
            supportsRotation: false,
            supportsChange: true
          },
          signing: {
            status: 'available',
            transactionFormats: ['psbt-v0'],
            messageFormats: ['dash-core-compact']
          },
          transaction: {
            status: 'available',
            model: 'utxo',
            actions: ['native-transfer']
          }
        }
      })
      expect(config.coinType).toBe(network === 'mainnet' ? 5 : 1)
      expect(config.assetSlip44).toBe('5')
      expect(config.privacy).toBe('public')
      expect(config.requiredConfirmations).toBe(6)
      expect(config.transactionExplorerTemplate).toBe(
        `https://blockexplorer.one/dash/${network}/tx/{txid}`
      )
      expect(config.addressExplorerTemplate).toBe(
        `https://blockexplorer.one/dash/${network}/address/{address}`
      )
      const assets = createAssetRegistry(
        registry,
        getBundledInitialProductAssetDefinitions(network)
      )
      expect(assets.resolve(`${config.chainId}/slip44:5`)).toMatchObject({
        metadata: { name: 'Dash', symbol: 'DASH', decimals: 8 },
        verification: 'trusted'
      })
      expect(assets.resolve(`${config.chainId}/slip44:5`).asset.reference).toBe('5')
    }
  })

  test('registers Starknet on chain.starknet without enabling it by default', () => {
    const enabled = parseEnabledChainFeatureFlags(undefined, ALL_CHAIN_FEATURE_FLAGS)
    expect(ALL_CHAIN_FEATURE_FLAGS).toContain(STARKNET_CHAIN_FEATURE_FLAG)
    expect(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).not.toContain(STARKNET_CHAIN_FEATURE_FLAG)
    expect(enabled).not.toContain(STARKNET_CHAIN_FEATURE_FLAG)
    expect(starknetSpecVersionMeetsMinimum('0.10.3')).toBe(true)
    expect(starknetSpecVersionMeetsMinimum('0.10')).toBe(true)
    expect(starknetSpecVersionMeetsMinimum('1.0.0')).toBe(true)
    expect(starknetSpecVersionMeetsMinimum('0.9.9')).toBe(false)

    const mainnet = createInitialProductChainRegistry('mainnet')
    const testnet = createInitialProductChainRegistry('testnet')
    expect(mainnet.list().some(chain => chain.id === 'starknet:SN_SEPOLIA')).toBe(false)
    expect(testnet.list().some(chain => chain.id === 'starknet:SN_MAIN')).toBe(false)
    expect(() => mainnet.resolve('starknet:SN_DEVNET')).toThrow(/Unsupported chain/)

    for (const network of ['mainnet', 'testnet']) {
      const registry = createInitialProductChainRegistry(network)
      const config = getStarknetNetworkConfig(network)
      expect(registry.resolve(config.chainId)).toMatchObject({
        family: 'starknet',
        featureFlag: STARKNET_CHAIN_FEATURE_FLAG,
        displayName: config.displayName,
        capabilities: {
          address: {
            status: 'available',
            addressSchemes: ['starknet'],
            derivationSchemes: ['bip44', 'eip2645']
          },
          signing: {
            status: 'available',
            transactionFormats: ['invoke-v3', 'deploy-account-v3'],
            messageFormats: ['snip12']
          },
          transaction: { status: 'available', model: 'account', actions: ['token-transfer'] }
        }
      })
      expect(config.transactionExplorerTemplate).toBe(`${config.explorerUrl}/tx/{txid}`)
      expect(config.alternateExplorers[0]).toMatchObject({
        label: 'Starkscan',
        transactionPath: 'tx'
      })
      expect(config.alternateExplorers[0].baseUrl.endsWith('/tx')).toBe(false)
      const assets = createAssetRegistry(
        registry,
        getBundledInitialProductAssetDefinitions(network)
      )
      const fee = assets.resolve(`${config.chainId}/snip2:${config.feeTokenReference}`)
      expect(fee).toMatchObject({
        metadata: { name: 'Starknet Token', symbol: 'STRK', decimals: 18 },
        verification: 'trusted'
      })
      const bridged = config.tokens.find(token => token.name === 'USDC.e')
      expect(bridged?.symbol).toBe('USDC')
      expect(assets.resolve(`${config.chainId}/snip2:${bridged.reference}`)).toMatchObject({
        metadata: { name: 'USDC.e', symbol: 'USDC', decimals: 6 }
      })
      const padded = `0x${bridged.reference.slice(2).padStart(64, '0')}`
      expect(normalizeStarknetFelt(padded)).toBe(bridged.reference)
      expect(assets.resolve(`${config.chainId}/snip2:${padded}`).asset.reference).toBe(
        bridged.reference
      )
      expect(assets.resolve(`${config.chainId}/snip2:${padded}`).asset.id).not.toContain('/erc20:')
    }
  })
})
