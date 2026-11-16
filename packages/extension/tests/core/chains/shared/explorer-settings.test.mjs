import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getBitcoinNetworkConfig,
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '../../../../src/config/networks.ts'
import { BLOCK_EXPLORER_GROUPS } from '../../../../src/config/block-explorers.ts'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  findChainEndpointOverride,
  parseChainEndpointSettings,
  setActiveChainEndpointSettings,
  withChainRpcEndpoint
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { getZcashChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  buildCustomExplorer,
  buildExplorerSelectionSettings,
  getExplorerPresets,
  getExplorerSelection
} from '../../../../src/popup/services/explorer-settings-model.ts'
import {
  formatChainAddressExplorerUrl,
  formatChainAssetExplorerUrl,
  formatChainTransactionExplorerUrl
} from '../../../../src/popup/services/chain-explorer.ts'

const option = network => ({
  chainId: network.chainId,
  label: network.displayName,
  iconChain: network.iconChain,
  defaultUrl: network.explorerUrl,
  defaultTransactionPath: 'tx'
})
const ethereum = option(
  getEvmNetworkConfigs('mainnet').find(network => network.chainId === 'eip155:1')
)

afterEach(() => setActiveChainEndpointSettings())

test('switching explorers and restoring default preserves RPCs and other chain settings', () => {
  const rpc = { protocol: 'evm-json-rpc', label: 'My node', url: 'https://node.example' }
  const current = withChainRpcEndpoint(DEFAULT_CHAIN_ENDPOINT_SETTINGS, ethereum.chainId, rpc)
  const other = {
    chainId: 'eip155:56',
    explorer: { label: 'Existing', baseUrl: 'https://bsc.example', transactionPath: 'transactions' }
  }
  const settings = parseChainEndpointSettings({
    ...current,
    overrides: [...current.overrides, other],
    savedRpcEndpoints: [{ chainId: ethereum.chainId, rpc }]
  })
  const preset = getExplorerPresets(ethereum).find(item => item.label === 'Blockscout')
  const selected = buildExplorerSelectionSettings(settings, ethereum, preset)
  assert.equal(
    findChainEndpointOverride(selected, ethereum.chainId).rpc.url,
    'https://node.example/'
  )
  assert.deepEqual(findChainEndpointOverride(selected, other.chainId), other)
  assert.equal(getExplorerSelection(selected, ethereum).custom, undefined)
  const restored = buildExplorerSelectionSettings(
    selected,
    ethereum,
    getExplorerPresets(ethereum)[0]
  )
  assert.deepEqual(
    [...restored.overrides].sort((a, b) => a.chainId.localeCompare(b.chainId)),
    [...settings.overrides].sort((a, b) => a.chainId.localeCompare(b.chainId))
  )
  assert.deepEqual(restored.savedRpcEndpoints, settings.savedRpcEndpoints)
  assert.deepEqual(restored.customEvmNetworks, settings.customEvmNetworks)
})

test('every bundled alternative survives persistence and opens transaction, address and token paths', () => {
  for (const mode of ['mainnet', 'testnet']) {
    for (const network of getEvmNetworkConfigs(mode)) {
      const chain = option(network)
      const presets = getExplorerPresets(chain)
      assert.equal(new Set(presets.map(item => item.baseUrl)).size, presets.length)
      for (const preset of presets.slice(1)) {
        const saved = parseChainEndpointSettings(
          JSON.parse(
            JSON.stringify(
              buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, chain, preset)
            )
          )
        )
        setActiveChainEndpointSettings(saved)
        assert.equal(
          formatChainTransactionExplorerUrl(chain.chainId, 'hash /1', mode),
          `${preset.baseUrl}/tx/hash%20%2F1`
        )
        assert.equal(
          formatChainAddressExplorerUrl(chain.chainId, '0x123', mode),
          `${preset.baseUrl}/address/0x123`
        )
        assert.equal(
          formatChainAssetExplorerUrl(
            chain.chainId,
            { kind: 'token', namespace: 'erc20', reference: '0x456' },
            mode
          ),
          `${preset.baseUrl}/token/0x456`
        )
        assert.equal(
          formatChainAssetExplorerUrl(
            chain.chainId,
            { kind: 'native', namespace: 'slip44', reference: '60' },
            mode
          ),
          preset.baseUrl
        )
      }
    }
  }
})

test('preset choices stay bound to their own mainnet or testnet chain ID', () => {
  const mainnet = getExplorerPresets(ethereum)
  const sepolia = getExplorerPresets(
    option(getEvmNetworkConfigs('testnet').find(network => network.chainId === 'eip155:11155111'))
  )
  assert(mainnet.some(item => item.baseUrl === 'https://eth.blockscout.com'))
  assert(sepolia.some(item => item.baseUrl === 'https://eth-sepolia.blockscout.com'))
  assert(!sepolia.some(item => mainnet.some(main => main.baseUrl === item.baseUrl)))
})

test('legacy Zcash defaults keep the named presets and transaction paths', () => {
  const presets = BLOCK_EXPLORER_GROUPS[0].options
  const zcash = {
    chainId: getZcashChainId('mainnet'),
    label: 'Zcash',
    defaultUrl: presets[1].baseUrl,
    defaultTransactionPath: presets[1].transactionPath,
    presets
  }
  const choices = getExplorerPresets(zcash)
  assert.equal(choices.length, 2)
  setActiveChainEndpointSettings(
    buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, zcash, choices[0])
  )
  assert.equal(
    formatChainTransactionExplorerUrl(zcash.chainId, 'hash', 'mainnet'),
    'https://blockchair.com/zcash/transaction/hash'
  )
  assert.deepEqual(
    buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, zcash, choices[1]),
    DEFAULT_CHAIN_ENDPOINT_SETTINGS
  )
})

test('custom explorers retain custom paths, normalize URLs and reject unsafe inputs', () => {
  const custom = buildCustomExplorer(
    ethereum,
    ' My explorer ',
    ' https://custom.example/ ',
    ' transactions '
  )
  const saved = buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, ethereum, custom)
  const selection = getExplorerSelection(saved, ethereum)
  assert.equal(selection.custom.baseUrl, 'https://custom.example')
  assert.equal(selection.custom.label, 'My explorer')
  setActiveChainEndpointSettings(saved)
  assert.equal(
    formatChainTransactionExplorerUrl(ethereum.chainId, 'hash', 'mainnet'),
    'https://custom.example/transactions/hash'
  )
  for (const invalid of [
    { ...custom, baseUrl: 'javascript:alert(1)' },
    { ...custom, baseUrl: 'https://user:password@custom.example' },
    { ...custom, transactionPath: '../tx' }
  ]) {
    assert.throws(() =>
      buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, ethereum, invalid)
    )
  }
  assert.deepEqual(
    getExplorerPresets({
      ...ethereum,
      chainId: 'eip155:12345',
      defaultUrl: '',
      defaultTransactionPath: 'tx'
    }),
    []
  )
})

test('Bitcoin explorer alternatives use the selected network for transaction and address links', () => {
  for (const mode of ['mainnet', 'testnet']) {
    const chain = option(getBitcoinNetworkConfig(mode))
    const presets = getExplorerPresets(chain)
    assert.deepEqual(
      presets.map(item => item.label),
      ['mempool.space', 'Blockstream']
    )
    setActiveChainEndpointSettings(
      buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, chain, presets[1])
    )
    const base =
      mode === 'mainnet' ? 'https://blockstream.info' : 'https://blockstream.info/testnet'
    assert.equal(formatChainTransactionExplorerUrl(chain.chainId, 'hash', mode), `${base}/tx/hash`)
    assert.equal(
      formatChainAddressExplorerUrl(chain.chainId, 'address', mode),
      `${base}/address/address`
    )
    assert.deepEqual(
      buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, chain, presets[0]),
      DEFAULT_CHAIN_ENDPOINT_SETTINGS
    )
  }
})

test('Solana Explorer preserves the cluster on transaction, account and native asset links', () => {
  for (const mode of ['mainnet', 'testnet']) {
    const chain = option(getSolanaNetworkConfig(mode === 'mainnet' ? 'mainnet' : 'devnet'))
    const presets = getExplorerPresets(chain)
    assert.deepEqual(
      presets.map(item => item.label),
      ['Solscan', 'Solana Explorer']
    )
    setActiveChainEndpointSettings(
      buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, chain, presets[1])
    )
    const query = mode === 'mainnet' ? '' : '?cluster=devnet'
    assert.equal(
      formatChainTransactionExplorerUrl(chain.chainId, 'hash /', mode),
      `https://explorer.solana.com/tx/hash%20%2F${query}`
    )
    assert.equal(
      formatChainAddressExplorerUrl(chain.chainId, 'account', mode),
      `https://explorer.solana.com/address/account${query}`
    )
    assert.equal(
      formatChainAssetExplorerUrl(
        chain.chainId,
        { kind: 'native', namespace: 'slip44', reference: '501' },
        mode
      ),
      `https://explorer.solana.com${query}`
    )
    setActiveChainEndpointSettings(
      buildExplorerSelectionSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, chain, presets[0])
    )
    assert.equal(
      formatChainTransactionExplorerUrl(chain.chainId, 'hash', mode),
      `https://solscan.io/tx/hash${query}`
    )
    assert.equal(
      formatChainAddressExplorerUrl(chain.chainId, 'account', mode),
      `https://solscan.io/account/account${query}`
    )
  }
})

test('NEAR Pikespeak uses its own transaction/account paths and remains outside Testnet presets', () => {
  const chain = { ...option(getNearNetworkConfig('mainnet')), defaultTransactionPath: 'txns' }
  const presets = getExplorerPresets(chain)
  assert.deepEqual(
    presets.map(item => item.label),
    ['NearBlocks', 'Pikespeak']
  )
  const selected = buildExplorerSelectionSettings(
    DEFAULT_CHAIN_ENDPOINT_SETTINGS,
    chain,
    presets[1]
  )
  setActiveChainEndpointSettings(parseChainEndpointSettings(JSON.parse(JSON.stringify(selected))))
  assert.equal(
    formatChainTransactionExplorerUrl(chain.chainId, 'hash /', 'mainnet'),
    'https://pikespeak.ai/transaction-viewer/hash%20%2F'
  )
  assert.equal(
    formatChainAddressExplorerUrl(chain.chainId, 'alice.near', 'mainnet'),
    'https://pikespeak.ai/account/alice.near'
  )
  assert.equal(
    formatChainTransactionExplorerUrl('near:testnet', 'hash', 'testnet'),
    'https://testnet.nearblocks.io/txns/hash'
  )
  assert.equal(
    getExplorerPresets({
      ...option(getNearNetworkConfig('testnet')),
      defaultTransactionPath: 'txns'
    }).length,
    1
  )
})
