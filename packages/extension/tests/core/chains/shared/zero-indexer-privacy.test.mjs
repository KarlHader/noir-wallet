import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ZERO_INDEXER_REGISTRY } from '../../../../src/config/zero-indexer.ts'
import {
  createCustomZeroIndexerEndpoint,
  parseZeroIndexerNodePreferences,
  parseZeroIndexerNodeStatus,
  parseZeroIndexerRegistryDocument,
  parseZeroIndexerRuntimeOptions
} from '../../../../src/core/zcash/zero-indexer.ts'
import {
  isTransactionSubmissionUnknown,
  parseTransferResult,
  requireSuccessfulTransfer,
  TransactionSubmissionUnknownError
} from '../../../../src/core/zcash/transfer-result.ts'
import {
  decodeWorkerRpcError,
  encodeWorkerRpcError
} from '../../../../src/core/worker/rpc-errors.ts'
import {
  addCustomZeroIndexerNode,
  getZeroIndexerBroadcastOptions,
  removeCustomZeroIndexerNode,
  selectZeroIndexerNode
} from '../../../../src/background/zero-indexer-node-settings.ts'
import { SerialTaskQueue, TimeoutError } from '../../../../src/lib/async-utils.ts'
import { createChromeStorageAdapter } from '../../../../src/lib/chrome-storage-adapter.ts'
import {
  isTrustedRuntimeMessageSender,
  parseTrustedExtensionRuntimeMessage
} from '../../../../src/lib/runtime-message-security.ts'

test('privacy broadcast messages enforce their runtime contract and sender boundary', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
  const page = { id: extensionId, url: `chrome-extension://${extensionId}/index.html` }
  const offscreen = {
    id: extensionId,
    url: `chrome-extension://${extensionId}/src/offscreen/index.html`
  }
  const pageMessages = [
    { type: 'GET_ZERO_INDEXER_ENABLED' },
    { type: 'SET_ZERO_INDEXER_ENABLED', enabled: false },
    { type: 'GET_ZERO_INDEXER_NODE_STATUS', refresh: true },
    { type: 'SELECT_ZERO_INDEXER_NODE', endpointId: null },
    { type: 'SELECT_ZERO_INDEXER_NODE', endpointId: 'zero-indexer-mainnet' },
    { type: 'ADD_CUSTOM_ZERO_INDEXER_NODE', label: 'Private node', url: 'https://zi.example' },
    { type: 'REMOVE_CUSTOM_ZERO_INDEXER_NODE', endpointId: 'custom:node' }
  ]
  for (const message of pageMessages) {
    assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
    assert.equal(isTrustedRuntimeMessageSender(message.type, page, extensionId), true)
    assert.equal(isTrustedRuntimeMessageSender(message.type, offscreen, extensionId), false)
    assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...message, unexpected: true }))
  }
  for (const network of ['mainnet', 'testnet']) {
    const message = { type: 'GET_ZERO_INDEXER_OPTIONS', network }
    assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
    assert.equal(isTrustedRuntimeMessageSender(message.type, offscreen, extensionId), true)
    assert.equal(isTrustedRuntimeMessageSender(message.type, page, extensionId), false)
  }
  for (const message of [
    { type: 'GET_ZERO_INDEXER_OPTIONS', network: 'regtest' },
    { type: 'SET_ZERO_INDEXER_ENABLED', enabled: 'false' },
    { type: 'GET_ZERO_INDEXER_NODE_STATUS', refresh: 'yes' },
    { type: 'SELECT_ZERO_INDEXER_NODE', endpointId: '' },
    { type: 'REMOVE_CUSTOM_ZERO_INDEXER_NODE', endpointId: null },
    { type: 'ADD_CUSTOM_ZERO_INDEXER_NODE', label: '', url: 'x'.repeat(4_097) }
  ]) {
    assert.throws(() => parseTrustedExtensionRuntimeMessage(message))
  }
})

test('a stale popup settings write cannot re-enable a disabled broadcast preference', async () => {
  const originalChrome = globalThis.chrome
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const stored = new Map([
    [
      'wallet_settings',
      JSON.stringify({ state: { networkMode: 'testnet', zeroIndexerEnabled: false }, version: 0 })
    ]
  ])
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: stored.get(key) }
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored.set(key, value)
        }
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, operation) => operation() } }
  })
  try {
    const adapter = createChromeStorageAdapter('local')
    await adapter.setItem(
      'wallet_settings',
      JSON.stringify({ state: { networkMode: 'testnet', zeroIndexerEnabled: true }, version: 0 })
    )
    const result = JSON.parse(stored.get('wallet_settings'))
    assert.equal(result.state.zeroIndexerEnabled, false)
    assert.equal(result.state.networkMode, 'testnet')
  } finally {
    globalThis.chrome = originalChrome
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }
})

test('serialized setting updates cannot apply an older node choice last', async () => {
  const queue = new SerialTaskQueue()
  let releaseFirst
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve
  })
  let persisted = 'auto'
  let activeWorker = 'auto'
  const update = value =>
    queue.run(async () => {
      if (value === 'first') await firstGate
      persisted = value
      activeWorker = persisted
    })
  const first = update('first')
  const second = update('second')
  await Promise.resolve()
  assert.equal(activeWorker, 'auto')
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(persisted, 'second')
  assert.equal(activeWorker, 'second')

  await assert.rejects(
    queue.run(async () => {
      throw new Error('probe failed')
    })
  )
  await queue.run(async () => {
    activeWorker = 'third'
  })
  assert.equal(activeWorker, 'third')
})

function lightwalletdResponse(chain) {
  const name = new TextEncoder().encode(chain)
  const message = Uint8Array.from([0x22, name.length, ...name])
  const trailer = new TextEncoder().encode('grpc-status: 0\r\n')
  const bytes = new Uint8Array(5 + message.length + 5 + trailer.length)
  new DataView(bytes.buffer).setUint32(1, message.length)
  bytes.set(message, 5)
  bytes[5 + message.length] = 0x80
  new DataView(bytes.buffer).setUint32(6 + message.length, trailer.length)
  bytes.set(trailer, 10 + message.length)
  return new Response(bytes, { headers: { 'content-type': 'application/grpc-web+proto' } })
}

test('automatic broadcast uses managed nodes and fixed custom node stays on its network', async () => {
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  const stored = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(stored.get(key)) }
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored.set(key, structuredClone(value))
        }
      }
    }
  }
  globalThis.fetch = async input =>
    String(input).includes('/v1/zero-indexer-endpoints')
      ? Response.json(DEFAULT_ZERO_INDEXER_REGISTRY)
      : lightwalletdResponse('main')
  try {
    const custom = await addCustomZeroIndexerNode('Private', 'https://private.example.com')
    assert.deepEqual((await getZeroIndexerBroadcastOptions('mainnet', true)).urls, [
      DEFAULT_ZERO_INDEXER_REGISTRY.networks.mainnet[0].url
    ])
    const selected = await selectZeroIndexerNode(custom.customEndpoints[0].id)
    assert.equal(selected.mode, 'fixed')
    assert.deepEqual((await getZeroIndexerBroadcastOptions('mainnet', true)).urls, [
      'https://private.example.com'
    ])
    assert.deepEqual((await getZeroIndexerBroadcastOptions('testnet', true)).urls, [
      DEFAULT_ZERO_INDEXER_REGISTRY.networks.testnet[0].url
    ])
    assert.equal(await getZeroIndexerBroadcastOptions('mainnet', false), null)
    await removeCustomZeroIndexerNode(custom.customEndpoints[0].id)
    assert.deepEqual((await getZeroIndexerBroadcastOptions('mainnet', true)).urls, [
      DEFAULT_ZERO_INDEXER_REGISTRY.networks.mainnet[0].url
    ])
  } finally {
    globalThis.chrome = originalChrome
    globalThis.fetch = originalFetch
  }
})

test('broadcast node preferences remain partitioned by network', () => {
  const custom = createCustomZeroIndexerEndpoint(
    'Private',
    'https://private.example.com',
    'custom:private'
  )
  const preferences = parseZeroIndexerNodePreferences({
    version: 1,
    networks: {
      mainnet: { mode: 'fixed', selectedEndpointId: custom.id, customEndpoints: [custom] },
      testnet: { mode: 'auto', selectedEndpointId: null, customEndpoints: [] }
    }
  })
  assert.deepEqual(preferences.networks.mainnet.customEndpoints, [custom])
  assert.equal(preferences.networks.mainnet.selectedEndpointId, custom.id)
  assert.deepEqual(preferences.networks.testnet.customEndpoints, [])
  assert.equal(preferences.networks.testnet.selectedEndpointId, null)

  const mixed = {
    ...DEFAULT_ZERO_INDEXER_REGISTRY,
    networks: { mainnet: DEFAULT_ZERO_INDEXER_REGISTRY.networks.mainnet, testnet: [] }
  }
  assert.equal(parseZeroIndexerRegistryDocument(mixed), null)
  assert.throws(() =>
    parseZeroIndexerNodeStatus({
      network: 'testnet',
      enabled: true,
      mode: 'fixed',
      selectedEndpointId: custom.id,
      managedEndpoints: DEFAULT_ZERO_INDEXER_REGISTRY.networks.testnet,
      customEndpoints: [],
      orderedEndpointIds: ['zero-indexer-testnet'],
      probes: {}
    })
  )
})

test('runtime broadcast options reject unsafe URLs and preserve failover order', () => {
  assert.deepEqual(
    parseZeroIndexerRuntimeOptions({
      urls: ['https://first.example/', 'https://second.example', 'https://first.example']
    }),
    { urls: ['https://first.example', 'https://second.example'] }
  )
  for (const url of [
    'http://node.example',
    'https://user:secret@node.example',
    'https://node.example?token=secret'
  ]) {
    assert.throws(() => parseZeroIndexerRuntimeOptions({ urls: [url] }))
  }
  assert.equal(parseZeroIndexerRuntimeOptions(null), null)
})

test('unknown submission keeps the known transaction ID for recovery', () => {
  const result = parseTransferResult({
    status: 'unknown',
    txIds: ['shield-step', 'payment-step'],
    finalTxId: 'payment-step',
    transactions: [
      { txId: 'shield-step', status: 'submitted' },
      { txId: 'payment-step', status: 'unknown' }
    ]
  })
  assert.throws(
    () => requireSuccessfulTransfer(result),
    error =>
      isTransactionSubmissionUnknown(error) &&
      error.txId === 'payment-step' &&
      error.txIds.join(',') === 'shield-step,payment-step'
  )
  assert.throws(() =>
    parseTransferResult({
      ...result,
      status: 'failed'
    })
  )
})

test('worker RPC preserves uncertain hardware broadcast identity', () => {
  const original = new TransactionSubmissionUnknownError('payment-step', 'Submission pending', [
    'shield-step',
    'payment-step'
  ])
  const encoded = encodeWorkerRpcError(original)
  const decoded = decodeWorkerRpcError(encoded)
  assert.equal(isTransactionSubmissionUnknown(decoded), true)
  assert.equal(decoded.txId, 'payment-step')
  assert.deepEqual(encoded.txIds, ['shield-step', 'payment-step'])
  assert.deepEqual(decoded.txIds, ['shield-step', 'payment-step'])
  assert.equal(decoded.message, 'Submission pending')
  assert.deepEqual(decodeWorkerRpcError({ ...encoded, txIds: ['x'.repeat(257)] }).txIds, [
    'payment-step'
  ])
  assert.equal(
    decodeWorkerRpcError(encodeWorkerRpcError(new TimeoutError('Timed out'))).name,
    'TimeoutError'
  )
  assert.equal(
    decodeWorkerRpcError(encodeWorkerRpcError(new Error('Rejected'))).message,
    'Rejected'
  )
})
