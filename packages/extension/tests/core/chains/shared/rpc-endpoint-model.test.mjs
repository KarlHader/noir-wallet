import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  findChainEndpointOverride,
  setActiveChainEndpointSettings,
  withoutSavedChainRpcEndpoint
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import {
  buildRpcSelectionSettings,
  getRpcAutoFirstEndpoint,
  getSavedRpcEndpoints
} from '../../../../src/popup/services/rpc-endpoint-model.ts'
import { NETWORKS } from '../../../../src/config/networks.ts'
import { getNetworkConfig } from '../../../../src/lib/runtime-network.ts'
import { getZcashChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  recordRpcFailure,
  recordRpcSuccess
} from '../../../../src/infrastructure/chains/rpc-failover.ts'

const arbitrum = {
  chainId: 'eip155:42161',
  label: 'Arbitrum',
  protocol: 'evm-json-rpc',
  defaultUrl: 'https://arbitrum.drpc.org',
  presets: [{ id: 'drpc', label: 'dRPC', url: 'https://arbitrum.drpc.org' }]
}

test('keeps saved custom endpoints when switching to a preset or default', () => {
  expect(getRpcAutoFirstEndpoint(arbitrum)).toEqual({
    label: 'dRPC',
    url: 'https://arbitrum.drpc.org'
  })
  const custom = buildRpcSelectionSettings(
    DEFAULT_CHAIN_ENDPOINT_SETTINGS,
    arbitrum,
    ' https://my-rpc.example ',
    ' My node '
  )
  expect(getSavedRpcEndpoints(custom, arbitrum)).toMatchObject([
    { label: 'My node', url: 'https://my-rpc.example/' }
  ])
  const preset = buildRpcSelectionSettings(custom, arbitrum, arbitrum.defaultUrl)
  expect(preset.savedRpcEndpoints).toEqual(custom.savedRpcEndpoints)
  expect(findChainEndpointOverride(preset, arbitrum.chainId).rpc.label).toBe('dRPC')
  const restored = buildRpcSelectionSettings(preset, arbitrum)
  expect(restored.overrides).toEqual([])
  expect(restored.savedRpcEndpoints).toEqual(custom.savedRpcEndpoints)
  expect(() => buildRpcSelectionSettings(custom, arbitrum, 'not a URL')).toThrow()
})

test('resolves custom Zcash endpoints by network and keeps them fixed', async () => {
  const option = {
    chainId: getZcashChainId('mainnet'),
    protocol: 'zcash-lightwalletd',
    label: 'Zcash'
  }
  const custom = buildRpcSelectionSettings(
    DEFAULT_CHAIN_ENDPOINT_SETTINGS,
    option,
    'https://custom-zcash.example',
    'My Zcash'
  )
  try {
    setActiveChainEndpointSettings(custom)
    expect(getNetworkConfig('mainnet').rpcUrl).toBe('https://custom-zcash.example')
    expect(getNetworkConfig('mainnet').compactBlockCdn).toBeNull()
    expect(getNetworkConfig('testnet').rpcUrl).toBe(NETWORKS.testnet.rpcUrl)
    expect(getNetworkConfig('testnet').compactBlockCdn).toBeNull()
    await expect(recordRpcFailure()).resolves.toBeNull()
    await expect(recordRpcSuccess()).resolves.toBeNull()
    expect(
      withoutSavedChainRpcEndpoint(custom, option.chainId, 'https://custom-zcash.example/')
    ).toMatchObject({ savedRpcEndpoints: [], overrides: [] })
    setActiveChainEndpointSettings(buildRpcSelectionSettings(custom, option))
    expect(getNetworkConfig('mainnet').rpcUrl).toBe(NETWORKS.mainnet.rpcUrl)
    expect(getNetworkConfig('mainnet').compactBlockCdn).toEqual(NETWORKS.mainnet.compactBlockCdn)
  } finally {
    setActiveChainEndpointSettings()
  }
})
