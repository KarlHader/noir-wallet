import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  parseCustomEvmNetwork,
  withActiveEvmChainId,
  withChainExplorer,
  withSavedChainRpcEndpoint
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import {
  assertChainEndpointSettingsUnchanged,
  assertCustomEvmNetworksHaveNoPendingTransactions,
  removeCustomEvmNetworkSettings,
  saveCustomEvmNetworkSettings
} from '../../../../src/core/chains/custom-evm-network-settings.ts'
import {
  resolveActiveEvmNetworkConfig,
  resolveEvmNetworkCatalog,
  resolvePersistedEvmNetworkChainIds,
  resolveReleasedChainEndpointSettings
} from '../../../../src/core/chains/evm-runtime-config.ts'
import {
  isTrustedRuntimeMessageSender,
  parseTrustedExtensionRuntimeMessage
} from '../../../../src/lib/runtime-message-security.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry
} from '../../../../src/core/chains/registry/index.ts'
import { getEvmAssetDefinitions } from '../../../../src/core/chains/registry/product-chain-definitions.ts'

const network = parseCustomEvmNetwork({
  chainId: 'eip155:31337',
  numericChainId: 31337,
  displayName: 'Local EVM',
  nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
  rpc: { protocol: 'evm-json-rpc', label: 'Local RPC', url: 'http://localhost:8545' }
})

describe('custom EVM network settings', () => {
  it('registers custom native assets without treating network artwork as asset metadata', () => {
    for (const [chainId, numericChainId, iconUrl] of [
      ['eip155:31337', 31337, undefined],
      [
        'eip155:57073',
        57073,
        'https://assets-cdn.trustwallet.com/blockchains/ethereum/info/logo.png'
      ]
    ]) {
      const custom = { ...network, chainId, numericChainId }
      const settings = saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, custom)
      const catalog = resolveEvmNetworkCatalog('mainnet', settings)
      const chains = createInitialProductChainRegistry(
        'mainnet',
        catalog.filter(config => config.source === 'custom')
      )
      const assets = createAssetRegistry(chains, catalog.flatMap(getEvmAssetDefinitions))
      const native = assets.list(chainId).find(entry => entry.asset.kind === 'native')
      assert.equal(native.metadata.symbol, custom.nativeCurrency.symbol)
      assert.equal(native.metadata.iconUrl, iconUrl)
    }
  })

  it('rejects an endpoint edit based on a snapshot from before a network was added', () => {
    const current = saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, network)
    assert.throws(
      () => assertChainEndpointSettingsUnchanged(current, DEFAULT_CHAIN_ENDPOINT_SETTINGS),
      /changed/
    )
    assert.doesNotThrow(() =>
      assertChainEndpointSettingsUnchanged(current, structuredClone(current))
    )
  })

  it('keeps networks needed by pending transactions in any account until completion', async () => {
    const scopes = [
      { keyDomainId: 'wallet:1', accountId: 'account:1' },
      { keyDomainId: 'wallet:2', accountId: 'account:2' }
    ]
    for (const status of ['signed', 'broadcast', 'confirming', 'final', 'failed']) {
      const graph = { root: { status, scope: scopes[1] } }
      const repository = {
        list: async query =>
          query.chainId === network.chainId &&
          query.scope.accountId === scopes[1].accountId &&
          query.statuses.includes(graph.root.status)
            ? [graph]
            : []
      }
      const check = () =>
        assertCustomEvmNetworksHaveNoPendingTransactions([network.chainId], scopes, repository)
      if (status === 'final' || status === 'failed') await check()
      else await assert.rejects(check, /pending transactions/)
      await assertCustomEvmNetworksHaveNoPendingTransactions(['eip155:31338'], scopes, repository)
    }
  })

  it('releases configured chains and restores their network-scoped selection', () => {
    const settings = withActiveEvmChainId(
      saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, network),
      network.chainId
    )
    assert.equal(resolveActiveEvmNetworkConfig('testnet', settings).source, 'custom')
    assert.equal(resolveActiveEvmNetworkConfig('testnet', settings).chainId, network.chainId)
    assert.deepEqual(resolveReleasedChainEndpointSettings('testnet', settings), settings)
    const raw = {
      state: {
        chainEndpointSettingsByNetwork: {
          mainnet: DEFAULT_CHAIN_ENDPOINT_SETTINGS,
          testnet: settings
        }
      }
    }
    assert.ok(resolvePersistedEvmNetworkChainIds(raw).includes(network.chainId))
    assert.ok(
      !resolveEvmNetworkCatalog('mainnet', raw.state.chainEndpointSettingsByNetwork.mainnet).some(
        item => item.chainId === network.chainId
      )
    )
  })

  it('prevents replacing built-in chains from either global network mode', () => {
    for (const mode of ['mainnet', 'testnet']) {
      for (const id of [1, 11155111]) {
        const settings = saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, {
          ...network,
          chainId: `eip155:${id}`,
          numericChainId: id
        })
        assert.throws(() => resolveEvmNetworkCatalog(mode, settings), /cannot replace/)
      }
    }
  })

  it('merges a new network without losing unrelated endpoints and rejects stale edits', () => {
    const base = withChainExplorer(DEFAULT_CHAIN_ENDPOINT_SETTINGS, 'eip155:1', {
      label: 'Explorer',
      baseUrl: 'https://explorer.example',
      transactionPath: 'tx'
    })
    const added = saveCustomEvmNetworkSettings(base, network)
    assert.deepEqual(added.overrides, base.overrides)
    assert.throws(() => saveCustomEvmNetworkSettings(added, network), /already exists/)
    const changed = saveCustomEvmNetworkSettings(
      added,
      { ...network, displayName: 'Updated' },
      network
    )
    assert.throws(() => saveCustomEvmNetworkSettings(changed, network, network), /changed/)
    assert.throws(() => removeCustomEvmNetworkSettings(changed, network), /changed/)
    assert.throws(
      () =>
        saveCustomEvmNetworkSettings(
          added,
          {
            ...network,
            chainId: 'eip155:31338',
            numericChainId: 31338
          },
          network
        ),
      /changed/
    )
  })

  it('removes only the target endpoints and restores the default active chain', () => {
    const added = saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, network)
    const selected = withActiveEvmChainId(
      withSavedChainRpcEndpoint(added, network.chainId, {
        protocol: 'evm-json-rpc',
        label: 'Other RPC',
        url: 'http://localhost:8546'
      }),
      network.chainId
    )
    const removed = removeCustomEvmNetworkSettings(selected, network)
    assert.deepEqual(removed.customEvmNetworks, [])
    assert.deepEqual(removed.overrides, [])
    assert.deepEqual(removed.savedRpcEndpoints, [])
    assert.equal(resolveActiveEvmNetworkConfig('testnet', removed).chainId, 'eip155:11155111')
  })

  it('accepts management commands only from trusted extension pages', () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    const pageSender = { id: extensionId, url: `chrome-extension://${extensionId}/index.html` }
    const dappSender = { id: extensionId, url: 'https://dapp.example', tab: { id: 1 } }
    for (const command of [
      { type: 'SAVE_CUSTOM_EVM_NETWORK', network },
      { type: 'REMOVE_CUSTOM_EVM_NETWORK', network },
      { type: 'SELECT_ACTIVE_EVM_CHAIN', chainId: network.chainId }
    ]) {
      assert.ok(parseTrustedExtensionRuntimeMessage(command))
      assert.equal(isTrustedRuntimeMessageSender(command.type, pageSender, extensionId), true)
      assert.equal(isTrustedRuntimeMessageSender(command.type, dappSender, extensionId), false)
      assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...command, unexpected: true }))
    }
  })
})
