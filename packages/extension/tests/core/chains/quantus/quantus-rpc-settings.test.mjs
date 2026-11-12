import { test } from 'node:test'
import { expect } from '@playwright/test'

import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  parseChainEndpointSettings,
  withChainRpcEndpoint
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { resolveQuantusRuntimeNetworkConfig } from '../../../../src/core/chains/quantus/runtime-config.ts'
import {
  parseRpcRegistryDocument,
  setActiveRpcRegistryDocument
} from '../../../../src/infrastructure/chains/rpc-registry-client.ts'
import { resolveQuantusRpcEndpointOptions } from '../../../../src/infrastructure/chains/managed-rpc-endpoints.ts'

const QUANTUS_RPC = Object.freeze({
  protocol: 'quantus-json-rpc',
  label: 'Self-hosted',
  url: 'https://quantus.self-hosted.example'
})

function quantusRegistryDocument(probe = 'quantus-json-rpc') {
  return {
    version: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
    chains: [
      {
        id: QUANTUS_NETWORKS.mainnet.chainId,
        chain: 'quantus',
        network: 'mainnet',
        label: 'Quantus',
        iconChain: 'quantus',
        probe,
        endpoints: [{ id: 'managed', label: 'Managed', url: 'https://managed.quantus.example' }]
      }
    ]
  }
}

test.describe('Quantus custom RPC settings', () => {
  test('accepts a quantus-json-rpc override and applies it at runtime', () => {
    const settings = withChainRpcEndpoint(
      DEFAULT_CHAIN_ENDPOINT_SETTINGS,
      QUANTUS_NETWORKS.mainnet.chainId,
      QUANTUS_RPC
    )
    expect(settings.overrides).toEqual([
      {
        chainId: QUANTUS_NETWORKS.mainnet.chainId,
        rpc: { ...QUANTUS_RPC, url: `${QUANTUS_RPC.url}/` }
      }
    ])
    const network = resolveQuantusRuntimeNetworkConfig('mainnet', settings)
    expect(network.rpcUrl).toBe(`${QUANTUS_RPC.url}/`)
    expect(network.explorerUrl).toBe(QUANTUS_NETWORKS.mainnet.explorerUrl)
    expect(network.genesisHash).toBe(QUANTUS_NETWORKS.mainnet.genesisHash)
  })

  test('applies a custom explorer override to the runtime network config', () => {
    const settings = parseChainEndpointSettings({
      ...DEFAULT_CHAIN_ENDPOINT_SETTINGS,
      overrides: [
        {
          chainId: QUANTUS_NETWORKS.testnet.chainId,
          explorer: { label: 'Planck', baseUrl: 'https://planck.explorer.example' }
        }
      ]
    })
    const network = resolveQuantusRuntimeNetworkConfig('testnet', settings)
    expect(network.explorerUrl).toBe('https://planck.explorer.example')
    expect(network.rpcUrl).toBe(QUANTUS_NETWORKS.testnet.rpcUrl)
  })

  test('falls back to bundled endpoints without an override', () => {
    const network = resolveQuantusRuntimeNetworkConfig('testnet', undefined)
    expect(network.rpcUrl).toBe(QUANTUS_NETWORKS.testnet.rpcUrl)
    expect(network.explorerUrl).toBe(QUANTUS_NETWORKS.testnet.explorerUrl)
  })

  test('rejects a non-Quantus protocol on a Quantus chain', () => {
    expect(() =>
      withChainRpcEndpoint(DEFAULT_CHAIN_ENDPOINT_SETTINGS, QUANTUS_NETWORKS.mainnet.chainId, {
        protocol: 'evm-json-rpc',
        label: 'Wrong',
        url: 'https://rpc.example'
      })
    ).toThrow(/protocol/)
  })
})

test.describe('Quantus managed RPC endpoints', () => {
  test('keeps a registry document that contains a Quantus chain', () => {
    const registry = parseRpcRegistryDocument(quantusRegistryDocument())
    expect(registry?.chains.map(chain => chain.id)).toEqual([QUANTUS_NETWORKS.mainnet.chainId])
    expect(registry?.chains[0].probe).toBe('quantus-json-rpc')
  })

  test('still rejects an unknown probe kind', () => {
    expect(parseRpcRegistryDocument(quantusRegistryDocument('polkadot-json-rpc'))).toBeNull()
  })

  test('resolves managed endpoints for the matching network only', () => {
    setActiveRpcRegistryDocument(parseRpcRegistryDocument(quantusRegistryDocument()))
    try {
      expect(resolveQuantusRpcEndpointOptions('mainnet')).toEqual([
        { id: 'managed', label: 'Managed', url: 'https://managed.quantus.example/' }
      ])
      expect(resolveQuantusRpcEndpointOptions('testnet')).toEqual([
        {
          id: 'quantus-planck',
          label: 'Quantus Planck',
          url: QUANTUS_NETWORKS.testnet.rpcUrl
        }
      ])
    } finally {
      setActiveRpcRegistryDocument(null)
    }
  })
})
