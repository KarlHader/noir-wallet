import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handleEvmDAppNetworkSwitch } from '../../../src/background/evm-dapp-network-switch.ts'
import { parseEip1193ChainRequest } from '../../../src/core/dapp/eip1193.ts'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  withCustomEvmNetwork
} from '../../../src/core/chains/chain-endpoint-settings.ts'
import { parseEvmAddNetworkApproval } from '../../../src/popup/services/dapp-approval-summary.ts'
import { resolveEvmNetworkCatalog } from '../../../src/core/chains/evm-runtime-config.ts'
import {
  formatConfiguredChainIconUrl,
  formatNativeTokenIconUrl
} from '../../../src/config/icons.ts'

const origin = 'https://dapp.example'
const request = (chainId = '0x7a69') =>
  parseEip1193ChainRequest(
    [
      {
        chainId,
        chainName: 'Local EVM',
        nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
        rpcUrls: ['http://localhost:8545', 'https://backup-rpc.example'],
        blockExplorerUrls: ['https://explorer.example']
      }
    ],
    { allowAddChainMetadata: true }
  )

test('Chainlist account hints do not affect the reviewed network or authorize an account', () => {
  const metadata = {
    chainId: '0xdef1',
    chainName: 'Ink',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc-gel.inkonchain.com'],
    blockExplorerUrls: ['https://explorer.inkonchain.com']
  }
  const options = { allowAddChainMetadata: true }
  const standard = parseEip1193ChainRequest([metadata], options)
  for (const hint of ['0x1111111111111111111111111111111111111111', null, undefined]) {
    assert.deepEqual(parseEip1193ChainRequest([metadata, hint], options), standard)
  }
  for (const params of [
    [metadata, 'not-an-address'],
    [metadata, { eth_accounts: {} }],
    [metadata, null, null],
    [{ chainId: '0xdef1' }, '0x1111111111111111111111111111111111111111']
  ]) {
    assert.throws(
      () => parseEip1193ChainRequest(params, options),
      error => error.code === -32602
    )
  }
  assert.throws(
    () => parseEip1193ChainRequest([{ chainId: '0xdef1' }, null]),
    error => error.code === -32602
  )
})

test('Chainlist RPC lists keep HTTP endpoints in order and skip secure WebSockets', async () => {
  const metadata = {
    chainId: '0xdef1',
    chainName: 'Ink',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [
      'wss://rpc-gel.inkonchain.com',
      'https://rpc-gel.inkonchain.com',
      ...Array.from({ length: 10 }, (_, index) => `https://rpc-${index}.example`)
    ],
    blockExplorerUrls: ['https://explorer.inkonchain.com']
  }
  const options = { allowAddChainMetadata: true }
  const parsed = parseEip1193ChainRequest([metadata, null], options)
  assert.equal(parsed.metadata.rpcUrls.length, 11)
  assert.equal(parsed.metadata.rpcUrls[0], 'https://rpc-gel.inkonchain.com/')
  const state = harness()
  await handleEvmDAppNetworkSwitch(parsed, origin, 'add', state.options)
  assert.equal(state.approvals[0][2].rpcUrl, 'https://rpc-gel.inkonchain.com/')
  assert.equal(state.saved[0].network.rpc.url, state.approvals[0][2].rpcUrl)
  for (const invalid of [
    { ...metadata, rpcUrls: ['wss://rpc.example'] },
    { ...metadata, rpcUrls: ['ws://rpc.example', 'https://rpc.example'] },
    { ...metadata, rpcUrls: ['https://rpc.example?key=secret'] },
    { ...metadata, rpcUrls: Array(129).fill('https://rpc.example') },
    { ...metadata, blockExplorerUrls: ['wss://explorer.example'] }
  ]) {
    assert.throws(
      () => parseEip1193ChainRequest([invalid, null], options),
      error => error.code === -32602
    )
  }
})

function harness() {
  let settings = DEFAULT_CHAIN_ENDPOINT_SETTINGS
  const approvals = []
  const saved = []
  const switches = []
  let approved = true
  return {
    options: {
      readSettings: async () => settings,
      requestApproval: async (...args) => {
        approvals.push(args)
        return { approved }
      },
      commitCustomNetwork: async (network, approvalOrigin) => {
        saved.push({ network, origin: approvalOrigin })
        settings = withCustomEvmNetwork(settings, network)
      },
      commitActiveChain: async (...args) => {
        switches.push(args)
      }
    },
    approvals,
    saved,
    switches,
    getSettings: () => settings,
    reject: () => {
      approved = false
    }
  }
}

test('approved add reviews and saves only the selected endpoint without switching', async () => {
  const state = harness()
  await handleEvmDAppNetworkSwitch(request(), origin, 'add', state.options)
  assert.deepEqual(state.approvals, [
    [
      origin,
      'evmNetwork',
      {
        action: 'add',
        chainId: 'eip155:31337',
        chainName: 'Local EVM',
        iconChain: 'eip155:31337',
        nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
        rpcUrl: 'http://localhost:8545/',
        explorerUrl: 'https://explorer.example'
      }
    ]
  ])
  assert.equal(state.saved[0].network.rpc.url, 'http://localhost:8545/')
  assert.equal(state.saved[0].network.explorer.baseUrl, 'https://explorer.example')
  assert.equal(state.saved[0].origin, origin)
  assert.equal(state.getSettings().activeEvmChainId, undefined)
  assert.deepEqual(state.switches, [])

  await handleEvmDAppNetworkSwitch(request(), origin, 'add', state.options)
  assert.equal(state.approvals.length, 1)
  assert.equal(state.saved.length, 1)
  await handleEvmDAppNetworkSwitch(request(), origin, 'switch', state.options)
  assert.deepEqual(state.approvals[1][2], {
    action: 'switch',
    chainId: 'eip155:31337',
    chainName: 'Local EVM',
    iconChain: 'eip155:31337'
  })
  assert.deepEqual(state.switches, [['eip155:31337', origin]])
})

test('rejection and invalid metadata never save a custom network', async () => {
  const state = harness()
  state.reject()
  await assert.rejects(
    handleEvmDAppNetworkSwitch(request(), origin, 'add', state.options),
    error => error.code === 4001
  )
  await assert.rejects(
    handleEvmDAppNetworkSwitch(
      { chainId: '0x7a69', numericChainId: 31337 },
      origin,
      'add',
      state.options
    ),
    error => error.code === -32602 && /required/.test(error.message)
  )
  assert.deepEqual(state.saved, [])
})

test('a changed request context blocks commit after approval', async () => {
  const state = harness()
  state.options.validateRequest = async () => {
    throw new Error('The active account changed')
  }
  await assert.rejects(
    handleEvmDAppNetworkSwitch(request(), origin, 'add', state.options),
    /active account changed/
  )
  assert.equal(state.approvals.length, 1)
  assert.deepEqual(state.saved, [])
})

test('adding a built-in chain leaves its configuration unchanged', async () => {
  const state = harness()
  await handleEvmDAppNetworkSwitch(request('0x38'), origin, 'add', state.options)
  assert.deepEqual(state.approvals, [])
  assert.deepEqual(state.saved, [])
})

test('other-mode built-in chain cannot be added as custom', async () => {
  const state = harness()
  await assert.rejects(
    handleEvmDAppNetworkSwitch(request('0xaa36a7'), origin, 'add', state.options),
    error => error.code === 4901
  )
  assert.deepEqual(state.approvals, [])
})

test('approval commits the reviewed snapshot after caller metadata changes', async () => {
  const state = harness()
  const parsed = request()
  const requested = {
    ...parsed,
    metadata: {
      ...parsed.metadata,
      nativeCurrency: { ...parsed.metadata.nativeCurrency },
      rpcUrls: [...parsed.metadata.rpcUrls]
    }
  }
  state.options.requestApproval = async (...args) => {
    state.approvals.push(args)
    requested.metadata.chainName = 'Altered Chain'
    requested.metadata.nativeCurrency.symbol = 'FAKE'
    requested.metadata.rpcUrls[0] = 'https://altered.example'
    return { approved: true }
  }
  await handleEvmDAppNetworkSwitch(requested, origin, 'add', state.options)
  assert.equal(state.saved[0].network.displayName, state.approvals[0][2].chainName)
  assert.equal(state.saved[0].network.rpc.url, state.approvals[0][2].rpcUrl)
})

test('approval review rejects incomplete or unsafe network details', async () => {
  const state = harness()
  await handleEvmDAppNetworkSwitch(request(), origin, 'add', state.options)
  const review = state.approvals[0][2]
  assert.equal(parseEvmAddNetworkApproval(review).rpcUrl, review.rpcUrl)
  assert.equal(parseEvmAddNetworkApproval({ ...review, nativeCurrency: undefined }), null)
  assert.equal(
    parseEvmAddNetworkApproval({ ...review, rpcUrl: 'https://rpc.example?key=secret' }),
    null
  )
})

test('network icons follow chain identity through approval and saved settings, independently of the native token', async () => {
  const state = harness()
  await handleEvmDAppNetworkSwitch(request('0xdef1'), origin, 'add', state.options)
  const review = state.approvals[0][2]
  assert.equal(review.iconChain, 'eip155:57073')
  const summary = parseEvmAddNetworkApproval(review)
  assert.equal(summary.iconChain, 'eip155:57073')
  assert.equal(summary.numericChainId, 57073)
  const saved = resolveEvmNetworkCatalog('mainnet', state.getSettings()).at(-1)
  assert.equal(saved.iconChain, 'eip155:57073')
  assert.equal(saved.nativeCurrency.symbol, 'LETH')
  assert.equal(saved.displayName, 'Local EVM')
  assert.equal(formatConfiguredChainIconUrl(saved.iconChain), '/icons/chains/network.svg')
  assert.equal(
    formatNativeTokenIconUrl(saved.iconChain),
    'https://assets-cdn.trustwallet.com/blockchains/ethereum/info/logo.png'
  )

  const unknown = harness()
  await handleEvmDAppNetworkSwitch(request(), origin, 'add', unknown.options)
  assert.equal(unknown.approvals[0][2].iconChain, 'eip155:31337')
  assert.equal(
    resolveEvmNetworkCatalog('mainnet', unknown.getSettings()).at(-1).iconChain,
    'eip155:31337'
  )
})
