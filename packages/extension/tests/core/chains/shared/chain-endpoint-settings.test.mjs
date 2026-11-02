import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  getChainEndpointRuntimeKey,
  parseChainEndpointSettings,
  parseCustomServiceUrl,
  withChainEndpointOverride,
  withCustomEvmNetwork,
  withSavedChainRpcEndpoint,
  withoutSavedChainRpcEndpoint,
  withoutCustomEvmNetwork
} from '../../../../src/core/chains/chain-endpoint-settings.ts'

test.describe('chain endpoint settings', () => {
  test('keeps missing V1 settings compatible', () => {
    expect(parseChainEndpointSettings(undefined)).toBe(DEFAULT_CHAIN_ENDPOINT_SETTINGS)
  })

  test('saves multiple endpoints per chain and restores the default when removing the selected one', () => {
    const rpc = { protocol: 'evm-json-rpc', label: 'Node 1', url: 'https://rpc.example/1' }
    const first = withSavedChainRpcEndpoint(DEFAULT_CHAIN_ENDPOINT_SETTINGS, 'eip155:42161', rpc)
    const second = withSavedChainRpcEndpoint(first, 'eip155:42161', {
      ...rpc,
      label: 'Node 2',
      url: 'https://rpc.example/2'
    })
    const renamed = withSavedChainRpcEndpoint(second, 'eip155:42161', { ...rpc, label: 'Renamed' })
    expect(renamed.savedRpcEndpoints).toHaveLength(2)
    expect(renamed.overrides[0].rpc.label).toBe('Renamed')
    const removedInactive = withoutSavedChainRpcEndpoint(
      renamed,
      'eip155:42161',
      'https://rpc.example/2'
    )
    expect(removedInactive.overrides).toEqual(renamed.overrides)
    const removedActive = withoutSavedChainRpcEndpoint(removedInactive, 'eip155:42161', rpc.url)
    expect(removedActive.overrides).toEqual([])
    expect(removedActive.savedRpcEndpoints).toEqual([])
  })

  test('rejects malformed and duplicate saved endpoints', () => {
    const endpoint = {
      chainId: 'eip155:42161',
      rpc: { protocol: 'evm-json-rpc', label: 'Node', url: 'https://rpc.example' }
    }
    expect(() =>
      parseChainEndpointSettings({
        ...DEFAULT_CHAIN_ENDPOINT_SETTINGS,
        savedRpcEndpoints: [
          endpoint,
          { ...endpoint, rpc: { ...endpoint.rpc, url: 'https://rpc.example/' } }
        ]
      })
    ).toThrow(/Duplicate/)
    expect(() =>
      parseChainEndpointSettings({
        ...DEFAULT_CHAIN_ENDPOINT_SETTINGS,
        savedRpcEndpoints: [
          { ...endpoint, rpc: { ...endpoint.rpc, protocol: 'zcash-lightwalletd' } }
        ]
      })
    ).toThrow(/protocol/)
  })

  test('parses a custom EVM network and chain-scoped overrides', () => {
    expect(
      parseChainEndpointSettings({
        schemaVersion: 1,
        activeEvmChainId: 'eip155:31337',
        customEvmNetworks: [
          {
            chainId: 'eip155:31337',
            numericChainId: 31337,
            displayName: 'Local EVM',
            nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 6 },
            rpc: {
              protocol: 'evm-json-rpc',
              label: 'Local node',
              url: 'http://localhost:8545'
            },
            explorer: { label: 'Local explorer', baseUrl: 'https://explorer.example/' }
          }
        ],
        overrides: [
          {
            chainId: 'eip155:1',
            rpc: {
              protocol: 'evm-json-rpc',
              label: 'Private endpoint',
              url: 'https://rpc.example/key-path'
            }
          }
        ]
      })
    ).toMatchObject({
      activeEvmChainId: 'eip155:31337',
      customEvmNetworks: [
        {
          chainId: 'eip155:31337',
          numericChainId: 31337,
          nativeCurrency: { decimals: 6 },
          rpc: { url: 'http://localhost:8545/' },
          explorer: { baseUrl: 'https://explorer.example' }
        }
      ],
      overrides: [{ chainId: 'eip155:1' }]
    })
  })

  test('rejects credential-bearing, query-bearing, and non-local HTTP URLs', () => {
    for (const url of [
      'https://user:password@rpc.example',
      'https://rpc.example?apiKey=secret',
      'https://rpc.example#fragment',
      'http://rpc.example',
      'javascript:alert(1)'
    ]) {
      expect(() => parseCustomServiceUrl(url, 'RPC URL')).toThrow()
    }
    expect(parseCustomServiceUrl('http://127.0.0.1:8545', 'RPC URL')).toBe('http://127.0.0.1:8545/')
  })

  test('rejects protocol and chain identity mismatches', () => {
    expect(() =>
      parseChainEndpointSettings({
        schemaVersion: 1,
        customEvmNetworks: [],
        overrides: [
          {
            chainId: 'eip155:1',
            rpc: { protocol: 'bitcoin-esplora', label: 'Wrong', url: 'https://rpc.example' }
          }
        ]
      })
    ).toThrow(/protocol/)
    expect(() =>
      parseChainEndpointSettings({
        schemaVersion: 1,
        customEvmNetworks: [
          {
            chainId: 'eip155:10',
            numericChainId: 1,
            displayName: 'Wrong',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpc: { protocol: 'evm-json-rpc', label: 'RPC', url: 'https://rpc.example' }
          }
        ],
        overrides: []
      })
    ).toThrow(/does not match/)
    for (const decimals of [-1, 1.5, 256]) {
      expect(() =>
        parseChainEndpointSettings({
          schemaVersion: 1,
          customEvmNetworks: [
            {
              chainId: 'eip155:31337',
              numericChainId: 31337,
              displayName: 'Invalid decimals',
              nativeCurrency: { name: 'Coin', symbol: 'COIN', decimals },
              rpc: { protocol: 'evm-json-rpc', label: 'RPC', url: 'https://rpc.example' }
            }
          ],
          overrides: []
        })
      ).toThrow(/decimals/)
    }
  })

  test('replaces settings by chain identity without producing duplicate records', () => {
    const custom = {
      chainId: 'eip155:31337',
      numericChainId: 31337,
      displayName: 'Local EVM',
      nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
      rpc: { protocol: 'evm-json-rpc', label: 'RPC 1', url: 'http://localhost:8545' }
    }
    const first = withCustomEvmNetwork(DEFAULT_CHAIN_ENDPOINT_SETTINGS, custom)
    const updated = withCustomEvmNetwork(first, {
      ...custom,
      rpc: { ...custom.rpc, label: 'RPC 2', url: 'http://localhost:9545' }
    })
    const withExplorer = withChainEndpointOverride(updated, {
      chainId: 'eip155:31337',
      explorer: { label: 'Explorer', baseUrl: 'https://explorer.example' }
    })
    expect(withExplorer.customEvmNetworks).toHaveLength(1)
    expect(withExplorer.customEvmNetworks[0].rpc.label).toBe('RPC 2')
    expect(withExplorer.overrides).toHaveLength(1)
    expect(withoutCustomEvmNetwork(withExplorer, 'eip155:31337')).toEqual({
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: []
    })
  })

  test('changes the runtime identity only for active network and RPC changes', () => {
    const withExplorer = withChainEndpointOverride(DEFAULT_CHAIN_ENDPOINT_SETTINGS, {
      chainId: 'eip155:1',
      explorer: { label: 'Explorer', baseUrl: 'https://explorer.example' }
    })
    expect(getChainEndpointRuntimeKey(withExplorer)).toBe(
      getChainEndpointRuntimeKey(DEFAULT_CHAIN_ENDPOINT_SETTINGS)
    )

    const withRpc = withChainEndpointOverride(withExplorer, {
      chainId: 'eip155:1',
      rpc: { protocol: 'evm-json-rpc', label: 'RPC', url: 'https://rpc.example' }
    })
    expect(getChainEndpointRuntimeKey(withRpc)).not.toBe(
      getChainEndpointRuntimeKey(DEFAULT_CHAIN_ENDPOINT_SETTINGS)
    )
  })
})
