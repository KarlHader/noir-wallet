import { test } from 'node:test'
import { expect } from '@playwright/test'

test('includes enabled Solana and NEAR networks in block explorer settings', async () => {
  globalThis.__NETWORK_MODE__ = 'mainnet'
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = [
    'chain.zcash',
    'chain.evm',
    'chain.bitcoin',
    'chain.solana',
    'chain.near'
  ]

  try {
    const [{ DEFAULT_CHAIN_ENDPOINT_SETTINGS }, { buildExplorerChainOptions }] = await Promise.all([
      import('../../../../src/core/chains/chain-endpoint-settings.ts'),
      import('../../../../src/popup/services/chain-settings-options.ts')
    ])

    expect(buildExplorerChainOptions(DEFAULT_CHAIN_ENDPOINT_SETTINGS).slice(-2)).toMatchObject([
      {
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        label: 'Solana',
        defaultUrl: 'https://solscan.io',
        defaultTransactionPath: 'tx'
      },
      {
        chainId: 'near:mainnet',
        label: 'NEAR',
        defaultUrl: 'https://nearblocks.io',
        defaultTransactionPath: 'txns'
      }
    ])
  } finally {
    delete globalThis.__NETWORK_MODE__
    delete globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  }
})

test('exposes Quantus RPC settings only when chain.quantus is enabled', async () => {
  globalThis.__NETWORK_MODE__ = 'mainnet'
  const [{ DEFAULT_CHAIN_ENDPOINT_SETTINGS }, { buildRpcChainOptions }, { QUANTUS_NETWORKS }] =
    await Promise.all([
      import('../../../../src/core/chains/chain-endpoint-settings.ts'),
      import('../../../../src/popup/services/chain-settings-options.ts'),
      import('../../../../src/config/networks.ts')
    ])

  try {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash']
    expect(
      buildRpcChainOptions(DEFAULT_CHAIN_ENDPOINT_SETTINGS).some(
        option => option.chainId === QUANTUS_NETWORKS.mainnet.chainId
      )
    ).toBe(false)

    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash', 'chain.quantus']
    expect(
      buildRpcChainOptions(DEFAULT_CHAIN_ENDPOINT_SETTINGS).find(
        option => option.chainId === QUANTUS_NETWORKS.mainnet.chainId
      )
    ).toMatchObject({
      label: 'Quantus',
      iconChain: 'quantus',
      protocol: 'quantus-json-rpc',
      defaultUrl: QUANTUS_NETWORKS.mainnet.rpcUrl
    })
  } finally {
    delete globalThis.__NETWORK_MODE__
    delete globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  }
})
