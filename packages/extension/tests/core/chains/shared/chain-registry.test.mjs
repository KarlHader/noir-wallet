import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAddressGatedChainRegistry,
  createBuildFeatureGatedChainRegistry,
  createFeatureGatedChainRegistry,
  createChainRegistry,
  defineChain,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import {
  getNearWaitingChainDefinitions,
  getSolanaWaitingChainDefinitions
} from '../../../../src/core/chains/registry/product-chain-definitions.ts'
import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  parseEnabledChainFeatureFlags,
  SOLANA_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '../../../../src/config/multichain-feature-flags.ts'

const evmCapabilities = {
  address: {
    status: 'available',
    addressSchemes: ['eip55'],
    derivationSchemes: ['bip44'],
    supportsRotation: false,
    supportsChange: false
  },
  signing: {
    status: 'available',
    transactionFormats: ['legacy', 'eip2930', 'eip1559'],
    messageFormats: ['eip191', 'eip712']
  },
  transaction: {
    status: 'available',
    model: 'account',
    actions: ['native-transfer', 'token-transfer', 'contract-call']
  }
}

const ethereumMainnet = {
  id: 'eip155:1',
  family: 'evm',
  network: { kind: 'mainnet', name: 'mainnet' },
  displayName: 'Ethereum',
  featureFlag: 'chain.evm',
  capabilities: evmCapabilities
}

const zcashMainnet = {
  id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  family: 'zcash',
  network: { kind: 'mainnet', name: 'mainnet' },
  displayName: 'Zcash',
  featureFlag: ZCASH_CHAIN_FEATURE_FLAG,
  capabilities: {
    address: {
      status: 'available',
      addressSchemes: ['unified'],
      derivationSchemes: ['zip32'],
      supportsRotation: true,
      supportsChange: false
    },
    signing: {
      status: 'available',
      transactionFormats: ['zcash-v5'],
      messageFormats: ['zip244']
    },
    transaction: {
      status: 'available',
      model: 'hybrid-utxo',
      actions: ['native-transfer', 'shield']
    }
  }
}

const waitingSolana = {
  id: 'solana:mainnet',
  family: 'solana',
  network: { kind: 'mainnet', name: 'mainnet' },
  displayName: 'Solana',
  featureFlag: 'chain.solana',
  capabilities: {
    address: {
      status: 'waiting',
      addressSchemes: [],
      derivationSchemes: [],
      supportsRotation: false,
      supportsChange: false
    },
    signing: {
      status: 'waiting',
      transactionFormats: [],
      messageFormats: []
    },
    transaction: {
      status: 'waiting',
      model: 'account',
      actions: []
    }
  }
}

const bitcoinReceiveOnly = {
  id: 'bip122:000000000019d6689c085ae165831e93',
  family: 'bitcoin',
  network: { kind: 'mainnet', name: 'mainnet' },
  displayName: 'Bitcoin',
  featureFlag: 'chain.bitcoin',
  capabilities: {
    address: {
      status: 'available',
      addressSchemes: ['bitcoin-p2wpkh', 'bitcoin-p2tr'],
      derivationSchemes: ['bip84', 'bip86'],
      supportsRotation: true,
      supportsChange: true
    },
    signing: {
      status: 'available',
      transactionFormats: ['psbt-v0'],
      messageFormats: ['bip322']
    },
    transaction: {
      status: 'waiting',
      model: 'utxo',
      actions: []
    }
  }
}

const waitingTron = {
  id: 'tron:0x2b6653dc',
  family: 'tron',
  network: { kind: 'mainnet', name: 'mainnet' },
  displayName: 'TRON',
  featureFlag: 'chain.tron',
  capabilities: {
    address: {
      status: 'waiting',
      addressSchemes: [],
      derivationSchemes: [],
      supportsRotation: false,
      supportsChange: false
    },
    signing: {
      status: 'waiting',
      transactionFormats: [],
      messageFormats: []
    },
    transaction: {
      status: 'waiting',
      model: 'account',
      actions: []
    }
  }
}

test.describe('CAIP-2 chain registry', () => {
  test('parses canonical CAIP-2 examples without changing case-sensitive references', () => {
    expect(parseChainId('eip155:1')).toEqual({
      id: 'eip155:1',
      namespace: 'eip155',
      reference: '1'
    })
    expect(parseChainId('bip122:000000000019d6689c085ae165831e93').namespace).toBe('bip122')
    expect(parseChainId('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').reference).toBe(
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    )
  })

  test('rejects malformed namespace and reference values', () => {
    expect(() => parseChainId('EIP155:1')).toThrow(/Invalid CAIP-2/)
    expect(() => parseChainId('ev:1')).toThrow(/Invalid CAIP-2/)
    expect(() => parseChainId('eip155:')).toThrow(/Invalid CAIP-2/)
    expect(() => parseChainId(`eip155:${'a'.repeat(33)}`)).toThrow(/Invalid CAIP-2/)
  })

  test('builds an immutable registry and resolves only configured chains', () => {
    const registry = createChainRegistry([ethereumMainnet])

    expect(registry.resolve('eip155:1').capabilities.signing.messageFormats).toEqual([
      'eip191',
      'eip712'
    ])
    expect(registry.list()).toHaveLength(1)
    expect(() => registry.resolve('eip155:10')).toThrow(/Unsupported chain/)
    expect(Object.isFrozen(registry.list())).toBe(true)
    expect(Object.isFrozen(registry.list()[0].capabilities.signing.messageFormats)).toBe(true)
  })

  test('accepts the project-defined TRON chain family without advertising capabilities', () => {
    const tron = defineChain(waitingTron)

    expect(tron.id).toBe('tron:0x2b6653dc')
    expect(tron.family).toBe('tron')
    expect(tron.capabilities.signing.status).toBe('waiting')
    expect(tron.capabilities.signing.transactionFormats).toEqual([])
  })

  test('keeps canonical Solana cluster identities registered but unreleased', () => {
    const definitions = getSolanaWaitingChainDefinitions()

    expect(definitions.map(definition => definition.id)).toEqual([
      SOLANA_NETWORKS.mainnet.chainId,
      SOLANA_NETWORKS.devnet.chainId,
      SOLANA_NETWORKS.testnet.chainId
    ])
    for (const definition of definitions) {
      expect(definition.family).toBe('solana')
      expect(definition.featureFlag).toBe('chain.solana')
      expect(definition.capabilities.address.status).toBe('waiting')
      expect(definition.capabilities.signing.status).toBe('waiting')
      expect(definition.capabilities.transaction.status).toBe('waiting')
    }
  })

  test('keeps canonical NEAR network identities registered but unreleased', () => {
    const definitions = getNearWaitingChainDefinitions()

    expect(definitions.map(definition => definition.id)).toEqual([
      NEAR_NETWORKS.mainnet.chainId,
      NEAR_NETWORKS.testnet.chainId
    ])
    for (const definition of definitions) {
      expect(definition.family).toBe('near')
      expect(definition.featureFlag).toBe('chain.near')
      expect(definition.capabilities.address.status).toBe('waiting')
      expect(definition.capabilities.signing.status).toBe('waiting')
      expect(definition.capabilities.transaction.status).toBe('waiting')
    }
  })

  test('rejects duplicate chains and duplicate capability declarations', () => {
    expect(() => createChainRegistry([ethereumMainnet, ethereumMainnet])).toThrow(
      /Duplicate chain definition/
    )
    expect(() =>
      defineChain({
        ...ethereumMainnet,
        capabilities: {
          ...evmCapabilities,
          signing: {
            ...evmCapabilities.signing,
            messageFormats: ['eip191', 'eip191']
          }
        }
      })
    ).toThrow(/duplicate value/)
  })

  test('does not advertise unavailable implementation capabilities', () => {
    expect(() =>
      defineChain({
        ...ethereumMainnet,
        capabilities: {
          ...evmCapabilities,
          signing: {
            status: 'waiting',
            transactionFormats: ['eip1559'],
            messageFormats: []
          }
        }
      })
    ).toThrow(/cannot advertise values while status is waiting/)
  })

  test('rejects invalid runtime enums and impossible availability combinations', () => {
    expect(() =>
      defineChain({
        ...ethereumMainnet,
        network: { kind: 'preview', name: 'preview' }
      })
    ).toThrow(/Invalid network kind/)

    expect(() =>
      defineChain({
        ...ethereumMainnet,
        capabilities: {
          ...evmCapabilities,
          signing: {
            status: 'waiting',
            transactionFormats: [],
            messageFormats: []
          }
        }
      })
    ).toThrow(/transaction capability requires an available signing capability/)
  })

  test('defaults to released chains and keeps an explicit Zcash-only kill switch', () => {
    expect(
      parseEnabledChainFeatureFlags(undefined, [
        ZCASH_CHAIN_FEATURE_FLAG,
        EVM_CHAIN_FEATURE_FLAG,
        BITCOIN_CHAIN_FEATURE_FLAG,
        SOLANA_CHAIN_FEATURE_FLAG,
        NEAR_CHAIN_FEATURE_FLAG
      ])
    ).toEqual([ZCASH_CHAIN_FEATURE_FLAG, EVM_CHAIN_FEATURE_FLAG])
    expect(
      parseEnabledChainFeatureFlags(undefined, [ZCASH_CHAIN_FEATURE_FLAG, 'chain.evm'])
    ).toEqual([ZCASH_CHAIN_FEATURE_FLAG, 'chain.evm'])
    expect(parseEnabledChainFeatureFlags('', [ZCASH_CHAIN_FEATURE_FLAG, 'chain.evm'])).toEqual([
      ZCASH_CHAIN_FEATURE_FLAG
    ])
    expect(() =>
      parseEnabledChainFeatureFlags('chain.near', [ZCASH_CHAIN_FEATURE_FLAG, 'chain.evm'])
    ).toThrow(/not releaseable/)
    expect(() =>
      parseEnabledChainFeatureFlags('chain.evm,chain.evm', [ZCASH_CHAIN_FEATURE_FLAG, 'chain.evm'])
    ).toThrow(/Duplicate enabled/)
  })

  test('hides disabled and incomplete chains without affecting Zcash V1', () => {
    const registry = createChainRegistry([zcashMainnet, ethereumMainnet, waitingSolana])
    const enabledFlags = parseEnabledChainFeatureFlags('chain.evm,chain.solana', [
      ZCASH_CHAIN_FEATURE_FLAG,
      'chain.evm',
      'chain.solana'
    ])
    const gated = createFeatureGatedChainRegistry(registry, enabledFlags)

    expect(gated.list().map(chain => chain.displayName)).toEqual(['Zcash', 'Ethereum'])
    expect(gated.resolve(zcashMainnet.id).family).toBe('zcash')
    expect(() => gated.resolve(waitingSolana.id)).toThrow(/capability is unavailable/)

    const zcashOnly = createFeatureGatedChainRegistry(registry, [ZCASH_CHAIN_FEATURE_FLAG])
    expect(zcashOnly.list().map(chain => chain.displayName)).toEqual(['Zcash'])
    expect(() => zcashOnly.resolve(ethereumMainnet.id)).toThrow(/disabled/)
  })

  test('build gating accepts multiple chains that share one family feature flag', () => {
    const bscMainnet = {
      ...ethereumMainnet,
      id: 'eip155:56',
      displayName: 'BNB Smart Chain'
    }
    const registry = createChainRegistry([zcashMainnet, ethereumMainnet, bscMainnet])

    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash']
    try {
      expect(() => createBuildFeatureGatedChainRegistry(registry)).not.toThrow()
    } finally {
      delete globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
    }
  })

  test('can release an address-only chain without advertising its waiting transaction capability', () => {
    const registry = createChainRegistry([zcashMainnet, bitcoinReceiveOnly])
    const flags = [ZCASH_CHAIN_FEATURE_FLAG, 'chain.bitcoin']
    const complete = createFeatureGatedChainRegistry(registry, flags)
    const addressOnly = createAddressGatedChainRegistry(registry, flags)

    expect(complete.list().map(chain => chain.family)).toEqual(['zcash'])
    expect(() => complete.resolve(bitcoinReceiveOnly.id)).toThrow(/capability is unavailable/)
    expect(addressOnly.list().map(chain => chain.family)).toEqual(['zcash', 'bitcoin'])
    expect(addressOnly.resolve(bitcoinReceiveOnly.id).capabilities.transaction.status).toBe(
      'waiting'
    )
  })
})
