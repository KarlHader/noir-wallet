import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  resolveActiveEvmNetworkConfig,
  resolveConfiguredEvmNetworkCatalog,
  resolveEvmNetworkCatalog,
  resolvePersistedEvmNetworkChainIds,
  resolveReleasedChainEndpointSettings
} from '../../../../src/core/chains/evm-runtime-config.ts'

test.describe('EVM runtime configuration', () => {
  test('applies per-chain endpoints without mixing build networks', () => {
    const settings = {
      schemaVersion: 1,
      activeEvmChainId: 'eip155:56',
      customEvmNetworks: [],
      overrides: [
        {
          chainId: 'eip155:56',
          rpc: {
            protocol: 'evm-json-rpc',
            label: 'Custom BSC RPC',
            url: 'https://bsc-rpc.example'
          },
          explorer: { label: 'BSC explorer', baseUrl: 'https://bsc-explorer.example' }
        }
      ]
    }
    expect(resolveActiveEvmNetworkConfig('mainnet', settings)).toMatchObject({
      chainId: 'eip155:56',
      rpcUrl: 'https://bsc-rpc.example/',
      explorerUrl: 'https://bsc-explorer.example'
    })
    expect(
      resolveEvmNetworkCatalog('testnet', settings).some(item => item.chainId === 'eip155:56')
    ).toBe(false)
    expect(resolveActiveEvmNetworkConfig('testnet', settings).chainId).toBe('eip155:11155111')
  })

  test('includes custom EVM networks in the released runtime', () => {
    const custom = {
      schemaVersion: 1,
      activeEvmChainId: 'eip155:31337',
      customEvmNetworks: [
        {
          chainId: 'eip155:31337',
          numericChainId: 31337,
          displayName: 'Local EVM',
          nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
          rpc: {
            protocol: 'evm-json-rpc',
            label: 'Local RPC',
            url: 'http://localhost:8545'
          }
        }
      ],
      overrides: []
    }
    expect(resolveConfiguredEvmNetworkCatalog('testnet', custom).at(-1)).toMatchObject({
      source: 'custom',
      chainId: 'eip155:31337',
      nativeCurrency: { symbol: 'LETH', slip44Reference: '60' }
    })
    expect(resolveActiveEvmNetworkConfig('testnet', custom)).toMatchObject({
      source: 'custom',
      chainId: 'eip155:31337'
    })
    expect(resolveEvmNetworkCatalog('testnet', custom)).toContainEqual(
      expect.objectContaining({ chainId: 'eip155:31337' })
    )
    expect(resolveReleasedChainEndpointSettings('testnet', custom).customEvmNetworks).toHaveLength(
      1
    )
    expect(() =>
      resolveConfiguredEvmNetworkCatalog('mainnet', {
        ...custom,
        activeEvmChainId: 'eip155:1',
        customEvmNetworks: [
          { ...custom.customEvmNetworks[0], chainId: 'eip155:1', numericChainId: 1 }
        ]
      })
    ).toThrow(/cannot replace/)
  })

  test('restores both released EVM network families for one-package switching', () => {
    const raw = JSON.stringify({
      state: {
        chainEndpointSettings: {
          schemaVersion: 1,
          activeEvmChainId: 'eip155:31337',
          customEvmNetworks: [
            {
              chainId: 'eip155:31337',
              numericChainId: 31337,
              displayName: 'Local EVM',
              nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
              rpc: {
                protocol: 'evm-json-rpc',
                label: 'Local RPC',
                url: 'http://localhost:8545'
              }
            }
          ],
          overrides: []
        }
      },
      version: 0
    })
    expect(resolvePersistedEvmNetworkChainIds(raw)).toEqual([
      'eip155:1',
      'eip155:10',
      'eip155:100',
      'eip155:11155111',
      'eip155:11155420',
      'eip155:137',
      'eip155:143',
      'eip155:196',
      'eip155:31337',
      'eip155:42161',
      'eip155:421614',
      'eip155:43113',
      'eip155:43114',
      'eip155:56',
      'eip155:80002',
      'eip155:80094',
      'eip155:8453',
      'eip155:84532',
      'eip155:97',
      'eip155:9745'
    ])
  })
})
