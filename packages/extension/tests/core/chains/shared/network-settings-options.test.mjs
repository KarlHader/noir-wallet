import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.__NETWORK_MODE__ = 'mainnet'
globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = []

const { buildNetworkSettingsOptions, buildRpcChainOptions } =
  await import('../../../../src/popup/services/chain-settings-options.ts')
const { DEFAULT_CHAIN_ENDPOINT_SETTINGS, withCustomEvmNetwork, withSavedChainRpcEndpoint } =
  await import('../../../../src/core/chains/chain-endpoint-settings.ts')
const { buildRpcSelectionSettings, getRpcAutoFirstEndpoint, getSavedRpcEndpoints } =
  await import('../../../../src/popup/services/rpc-endpoint-model.ts')

const custom = {
  chainId: 'eip155:57073',
  numericChainId: 57073,
  displayName: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: { protocol: 'evm-json-rpc', label: 'Ink', url: 'https://rpc-gel.inkonchain.com' }
}

test('network settings remain available for Zcash when optional chains are disabled', () => {
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = []
  const settings = withCustomEvmNetwork(DEFAULT_CHAIN_ENDPOINT_SETTINGS, custom)
  const options = buildNetworkSettingsOptions(settings)
  assert.equal(options.length, 1)
  assert.equal(options[0].label, 'Zcash')
  assert.equal(options[0].currencySymbol, 'ZEC')
  assert.equal(options[0].numericChainId, undefined)
  assert.equal(options[0].source, 'builtin')
})

test('network management includes each enabled chain once and keeps custom identity separate', () => {
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = [
    'chain.evm',
    'chain.bitcoin',
    'chain.solana',
    'chain.near'
  ]
  const settings = withCustomEvmNetwork(DEFAULT_CHAIN_ENDPOINT_SETTINGS, custom)
  const options = buildNetworkSettingsOptions(settings)
  assert.equal(new Set(options.map(option => option.chainId)).size, options.length)
  assert.deepEqual(
    options
      .filter(option => !option.chainId.startsWith('eip155:'))
      .map(option => option.currencySymbol),
    ['ZEC', 'BTC', 'SOL', 'NEAR']
  )
  assert.deepEqual(
    options.find(option => option.chainId === custom.chainId),
    {
      chainId: custom.chainId,
      label: 'Ink',
      iconChain: 'eip155:57073',
      source: 'custom',
      numericChainId: 57073,
      currencySymbol: 'ETH'
    }
  )
  assert.equal(options.find(option => option.chainId === 'eip155:1').source, 'builtin')
})

test('custom network default RPC appears once as a selectable preset', () => {
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.evm']
  const settings = withCustomEvmNetwork(DEFAULT_CHAIN_ENDPOINT_SETTINGS, custom)
  const option = buildRpcChainOptions(settings).find(item => item.chainId === custom.chainId)
  assert.ok(option)
  assert.deepEqual(option.presets, [
    { id: 'default', label: 'Ink', url: 'https://rpc-gel.inkonchain.com/' }
  ])
  assert.deepEqual(getRpcAutoFirstEndpoint(option), {
    label: 'Ink',
    url: 'https://rpc-gel.inkonchain.com/'
  })
  assert.deepEqual(getSavedRpcEndpoints(settings, option), [])

  const selectedDefault = buildRpcSelectionSettings(settings, option, option.defaultUrl)
  assert.equal(selectedDefault.overrides[0].rpc.url, option.defaultUrl)
  assert.equal(selectedDefault.savedRpcEndpoints, undefined)
  assert.deepEqual(getSavedRpcEndpoints(selectedDefault, option), [])
  assert.deepEqual(buildRpcSelectionSettings(selectedDefault, option).overrides, [])

  const duplicateDefault = withSavedChainRpcEndpoint(settings, custom.chainId, {
    protocol: 'evm-json-rpc',
    label: 'Old copy',
    url: option.defaultUrl
  })
  assert.deepEqual(getSavedRpcEndpoints(duplicateDefault, option), [])

  const alternateUrl = 'https://alternate.ink.example/'
  const selectedAlternate = buildRpcSelectionSettings(
    settings,
    option,
    alternateUrl,
    'Alternate',
    true
  )
  assert.deepEqual(
    getSavedRpcEndpoints(selectedAlternate, option).map(rpc => rpc.url),
    [alternateUrl]
  )
  assert.equal(selectedAlternate.overrides[0].rpc.url, alternateUrl)
  assert.deepEqual(buildRpcSelectionSettings(selectedAlternate, option).overrides, [])

  const builtin = buildRpcChainOptions(settings).find(item => item.chainId === 'eip155:1')
  assert.ok(builtin)
  assert.ok(builtin.presets.length > 0)
  assert.equal(builtin.presets[0].url, builtin.defaultUrl)
})
