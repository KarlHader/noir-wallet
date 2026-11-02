import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  resolveNearRuntimeNetworkConfig,
  resolveSolanaRuntimeNetworkConfig
} from '../../../../src/core/chains/solana-near-runtime-config.ts'
import { RPC_DEFAULT_ENDPOINTS } from '../../../../src/config/rpc-endpoints.ts'

test('uses browser-compatible Mainnet RPC defaults', () => {
  expect(resolveSolanaRuntimeNetworkConfig('mainnet').rpcUrl).toBe(
    RPC_DEFAULT_ENDPOINTS.solana.mainnet.url
  )
  expect(resolveSolanaRuntimeNetworkConfig('mainnet').rpcUrl).toBe('https://solana.deltarpc.com/')
  expect(resolveNearRuntimeNetworkConfig('mainnet').rpcUrl).toBe(
    RPC_DEFAULT_ENDPOINTS.near.mainnet.url
  )
  expect(resolveNearRuntimeNetworkConfig('mainnet').rpcUrl).toBe('https://free.rpc.fastnear.com')
})

test('applies only chain-scoped attested Solana and NEAR RPC overrides', () => {
  const settings = {
    schemaVersion: 1,
    customEvmNetworks: [],
    overrides: [
      {
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        rpc: {
          protocol: 'solana-json-rpc',
          label: 'Custom Solana',
          url: 'https://solana.example.test'
        }
      },
      {
        chainId: 'near:mainnet',
        rpc: {
          protocol: 'near-json-rpc',
          label: 'Delta',
          url: 'https://nearinner.deltarpc.com'
        }
      }
    ]
  }
  expect(resolveSolanaRuntimeNetworkConfig('mainnet', settings).rpcUrl).toBe(
    'https://solana.example.test/'
  )
  expect(resolveNearRuntimeNetworkConfig('mainnet', settings).rpcUrl).toBe(
    'https://nearinner.deltarpc.com/'
  )
  expect(resolveSolanaRuntimeNetworkConfig('testnet', settings).rpcUrl).toBe(
    'https://api.devnet.solana.com'
  )
  expect(resolveNearRuntimeNetworkConfig('testnet', settings).rpcUrl).toBe(
    'https://rpc.testnet.near.org'
  )
})

test('retires former Solana RPC defaults that are unavailable to the extension', () => {
  const settings = {
    schemaVersion: 1,
    customEvmNetworks: [],
    overrides: [
      {
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        rpc: {
          protocol: 'solana-json-rpc',
          label: 'OnFinality',
          url: 'https://solana.api.onfinality.io/public'
        }
      }
    ]
  }

  expect(resolveSolanaRuntimeNetworkConfig('mainnet', settings).rpcUrl).toBe(
    'https://solana.deltarpc.com/'
  )

  expect(
    resolveSolanaRuntimeNetworkConfig('mainnet', {
      ...settings,
      overrides: [
        {
          chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          rpc: {
            protocol: 'solana-json-rpc',
            label: 'Official',
            url: 'https://api.mainnet-beta.solana.com'
          }
        }
      ]
    }).rpcUrl
  ).toBe('https://solana.deltarpc.com/')
})
