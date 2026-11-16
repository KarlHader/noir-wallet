import assert from 'node:assert/strict'
import { it } from 'node:test'
import { getEvmNetworkConfig } from '../../../../src/config/networks.ts'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  parseCustomEvmNetwork
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { saveCustomEvmNetworkSettings } from '../../../../src/core/chains/custom-evm-network-settings.ts'
import { resolveEvmNetworkCatalog } from '../../../../src/core/chains/evm-runtime-config.ts'
import { createBackgroundEvmTransferAssetRegistry } from '../../../../src/background/evm-transfer-assets.ts'

function customNetwork(chainId, numericChainId) {
  return parseCustomEvmNetwork({
    chainId,
    numericChainId,
    displayName: `Local EVM ${numericChainId}`,
    nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
    rpc: { protocol: 'evm-json-rpc', label: 'Local RPC', url: 'http://localhost:8545' }
  })
}

function token(chainId, reference) {
  return {
    chainId,
    namespace: 'erc20',
    reference,
    kind: 'token',
    metadata: { name: 'Local Token', symbol: 'LCL', decimals: 18 },
    source: 'user-added',
    verification: 'user-approved'
  }
}

it('keeps custom tokens on their own EVM transfer controller registry', () => {
  let settings = DEFAULT_CHAIN_ENDPOINT_SETTINGS
  settings = saveCustomEvmNetworkSettings(settings, customNetwork('eip155:31338', 31338))
  settings = saveCustomEvmNetworkSettings(settings, customNetwork('eip155:31339', 31339))
  const custom = resolveEvmNetworkCatalog('mainnet', settings).filter(
    network => network.source === 'custom'
  )
  const first = custom.find(network => network.chainId === 'eip155:31338')
  const second = custom.find(network => network.chainId === 'eip155:31339')
  assert.ok(first)
  assert.ok(second)

  const firstAssetId = `${first.chainId}/erc20:0x1111111111111111111111111111111111111111`
  const secondAssetId = `${second.chainId}/erc20:0x2222222222222222222222222222222222222222`
  const userAssets = [
    token(first.chainId, '0x1111111111111111111111111111111111111111'),
    token(second.chainId, '0x2222222222222222222222222222222222222222')
  ]

  const builtinAssets = createBackgroundEvmTransferAssetRegistry(
    getEvmNetworkConfig('mainnet'),
    userAssets
  )
  assert.equal(
    builtinAssets.list().some(entry => entry.asset.id === firstAssetId),
    false
  )
  assert.equal(
    builtinAssets.list().some(entry => entry.asset.id === secondAssetId),
    false
  )

  const firstAssets = createBackgroundEvmTransferAssetRegistry(first, userAssets)
  assert.equal(firstAssets.inspect(firstAssetId)?.metadata.symbol, 'LCL')
  assert.equal(
    firstAssets.list().some(entry => entry.asset.id === secondAssetId),
    false
  )

  const secondAssets = createBackgroundEvmTransferAssetRegistry(second, userAssets)
  assert.equal(secondAssets.inspect(secondAssetId)?.metadata.symbol, 'LCL')
  assert.equal(
    secondAssets.list().some(entry => entry.asset.id === firstAssetId),
    false
  )
})
