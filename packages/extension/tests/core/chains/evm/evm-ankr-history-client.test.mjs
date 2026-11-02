import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createEvmAnkrHistoryClient } from '../../../../src/infrastructure/chains/evm/evm-ankr-history-client.ts'
import { createCachedEvmAnkrHistoryBatchSource } from '../../../../src/infrastructure/chains/evm/evm-cached-history-source.ts'
import {
  buildActivityReadModel,
  parseActivityReadModel
} from '../../../../src/core/activity/index.ts'

const ADDRESS = `0x${'1'.repeat(40)}`
const OTHER = `0x${'2'.repeat(40)}`
const HASH = `0x${'a'.repeat(64)}`
const BLOCK_HASH = `0x${'b'.repeat(64)}`
const CONTRACT = `0x${'3'.repeat(40)}`
const scope = { keyDomainId: 'keydomain_ankr-batch', accountId: 'account_ankr-batch' }
const chains = [
  { chainId: 'eip155:1', nativeAssetId: 'eip155:1/slip44:60', trackedErc20Assets: [] },
  {
    chainId: 'eip155:8453',
    nativeAssetId: 'eip155:8453/slip44:60',
    trackedErc20Assets: [
      {
        assetId: `eip155:8453/erc20:${CONTRACT}`,
        contract: CONTRACT,
        decimals: 6
      }
    ]
  }
]

function tx(blockchain = 'eth', overrides = {}) {
  return {
    blockchain,
    hash: HASH,
    blockHash: BLOCK_HASH,
    blockNumber: '0x64',
    from: OTHER,
    to: ADDRESS,
    value: '0x1',
    gasPrice: '0x2',
    gasUsed: '0x5208',
    nonce: '0x1',
    timestamp: '0x6553f100',
    status: '0x1',
    input: '0x',
    ...overrides
  }
}

function rpc(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function memoryCache(initial = []) {
  const records = new Map(initial.map(value => [value.chainId, value]))
  const writes = []
  return {
    repository: {
      read: async chainId => records.get(chainId) ?? null,
      write: async value => {
        writes.push(value)
        records.set(value.chainId, value)
      }
    },
    records,
    writes
  }
}

test('keeps identical transaction hashes on different EVM chains distinct after aggregation', async () => {
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) =>
      JSON.parse(init.body).method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx('eth'), tx('base')] })
        : rpc({ transfers: [] })
  )
  const result = await client.readAddressActivities(
    chains.map(chain => ({ chainId: chain.chainId, address: ADDRESS, scope }))
  )
  const model = buildActivityReadModel({
    scope,
    localGraphs: [],
    supplementalItems: chains.flatMap(chain => result.get(chain.chainId).items)
  })

  expect(parseActivityReadModel(model).items).toHaveLength(2)
  expect(new Set(model.items.map(item => item.id)).size).toBe(2)
  expect(model.items.map(item => item.segments[0].target.chainId).sort()).toEqual([
    'eip155:1',
    'eip155:8453'
  ])
})

test('Ankr history batches chains by address with the earliest incremental block', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx()] })
        : rpc({
            transfers: [
              {
                blockchain: 'base',
                transactionHash: `0x${'c'.repeat(64)}`,
                blockHeight: 101,
                fromAddress: OTHER,
                toAddress: ADDRESS,
                contractAddress: CONTRACT,
                tokenDecimals: 6,
                timestamp: 1_700_000_000,
                value: '5',
                valueRawInteger: '5000000'
              }
            ]
          })
    }
  )

  const result = await client.readAddressActivities([
    { chainId: 'eip155:1', address: ADDRESS, scope, fromBlock: 90 },
    { chainId: 'eip155:8453', address: ADDRESS, scope, fromBlock: 50 }
  ])
  expect(requests).toHaveLength(2)
  expect(requests.find(value => value.method === 'ankr_getTransactionsByAddress').params).toEqual({
    blockchain: ['eth', 'base'],
    address: ADDRESS,
    pageSize: 200,
    descOrder: true,
    fromBlock: 50
  })
  expect(requests.find(value => value.method === 'ankr_getTokenTransfers').params).toEqual({
    blockchain: ['eth', 'base'],
    address: [ADDRESS],
    pageSize: 2000,
    descOrder: true,
    fromBlock: 50
  })
  expect(result.get('eip155:1').items[0].snapshot.primaryAmount.amountRaw).toBe('1')
  expect(result.get('eip155:8453').items[0].snapshot.primaryAmount.amountRaw).toBe('5000000')
  expect(result.get('eip155:8453').items[0].completeness).toBe('partial')
})

test('Ankr excludes untracked ERC-20 movements from activity', async () => {
  const unknownContract = `0x${'4'.repeat(40)}`
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [] })
        : rpc({
            transfers: [
              {
                blockchain: 'eth',
                transactionHash: HASH,
                blockHeight: 100,
                fromAddress: OTHER,
                toAddress: ADDRESS,
                contractAddress: unknownContract,
                tokenDecimals: 18,
                timestamp: 1_700_000_000,
                valueRawInteger: '123'
              }
            ]
          })
    }
  )
  const result = await client.readAddressActivities([
    { chainId: 'eip155:1', scope, address: ADDRESS }
  ])
  expect(result.get('eip155:1')).toMatchObject({ items: [], partial: false })
})

test('discarding an aborted batch also discards responses from a fetch that ignores abort', async () => {
  let releaseResponses
  const responseGate = new Promise(resolve => {
    releaseResponses = resolve
  })
  const controller = new AbortController()
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      await responseGate
      return JSON.parse(init.body).method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx()] })
        : rpc({ transfers: [] })
    }
  )
  const request = client.readAddressActivities(
    chains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS })),
    controller.signal
  )
  controller.abort()
  releaseResponses()

  const result = await request
  expect([...result.values()]).toEqual([
    { error: expect.objectContaining({ code: 'cancelled' }) },
    { error: expect.objectContaining({ code: 'cancelled' }) }
  ])
})

test('a canceled batch caller does not cancel another caller for the same address', async () => {
  let releaseResponses
  const responseGate = new Promise(resolve => {
    releaseResponses = resolve
  })
  let requests = 0
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    [chains[0]],
    async (_url, init) => {
      requests += 1
      await responseGate
      return JSON.parse(init.body).method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx()] })
        : rpc({ transfers: [] })
    }
  )
  const cache = memoryCache()
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })
  const firstController = new AbortController()
  const secondController = new AbortController()
  const target = [{ chainId: 'eip155:1', scope, address: ADDRESS }]
  const first = reader.readAddressActivities(target, firstController.signal)
  const second = reader.readAddressActivities(target, secondController.signal)
  firstController.abort()
  releaseResponses()

  expect((await first).get('eip155:1')).toEqual([])
  expect((await second).get('eip155:1')).toHaveLength(1)
  expect(requests).toBe(4)
  expect(cache.records.get('eip155:1').successfulSyncAt).toBe(10_000)
})

test('an uncached chain omitted by a partial shared page is fetched automatically by chain', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return request.method === 'ankr_getTransactionsByAddress'
        ? request.params.blockchain.length > 1
          ? rpc({ transactions: [tx()], nextPageToken: 'older' })
          : rpc({ transactions: [tx('base', { hash: `0x${'c'.repeat(64)}` })] })
        : rpc({ transfers: [] })
    }
  )
  const cache = memoryCache()
  let currentTime = 10_000
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => currentTime
  })
  const targets = chains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS }))
  const first = await reader.readAddressActivities(targets)
  expect(first.get('eip155:1')).toHaveLength(1)
  expect(first.get('eip155:1')[0].completeness).toBe('partial')
  expect(first.get('eip155:8453')).toHaveLength(1)
  expect(cache.records.get('eip155:8453').successfulSyncAt).toBe(10_000)
  expect(cache.records.get('eip155:1').retryAfter).toBe(40_000)
  expect(requests).toHaveLength(4)
  expect(requests[2].params.blockchain).toEqual(['base'])
  expect(requests[0].params).not.toHaveProperty('fromBlock')

  currentTime = 40_000
  const second = await reader.readAddressActivities(targets)
  expect(requests).toHaveLength(6)
  expect(requests[4].params.blockchain).toEqual(['eth'])
  expect(second.get('eip155:8453')).toHaveLength(1)
})

test('a failed history branch does not fan out into single-chain retries', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      if (request.method === 'ankr_getTokenTransfers') throw new Error('upstream unavailable')
      return rpc({ transactions: [] })
    }
  )
  const cache = memoryCache()
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })

  const result = await reader.readAddressActivities(
    chains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS }))
  )
  expect(requests).toHaveLength(2)
  expect(result.get('eip155:1')).toEqual([])
  expect(result.get('eip155:8453')).toEqual([])
  expect(cache.records.get('eip155:1')).toMatchObject({
    successfulSyncAt: null,
    retryAfter: 70_000
  })
  expect(cache.records.get('eip155:8453')).toMatchObject({
    successfulSyncAt: null,
    retryAfter: 70_000
  })
})

test('a still-truncated single-chain page records failure backoff instead of an empty success', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({
            transactions: request.params.blockchain.length > 1 ? [tx()] : [],
            nextPageToken: 'older'
          })
        : rpc({ transfers: [] })
    }
  )
  const cache = memoryCache()
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })

  const result = await reader.readAddressActivities(
    chains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS }))
  )
  expect(requests).toHaveLength(4)
  expect(result.get('eip155:8453')).toEqual([])
  expect(cache.records.get('eip155:8453')).toMatchObject({
    successfulSyncAt: null,
    retryAfter: 70_000,
    items: []
  })
})

test('single-chain retries for omitted chains run at most two at a time', async () => {
  const extraChains = [
    ...chains,
    { chainId: 'eip155:10', nativeAssetId: 'eip155:10/slip44:60', trackedErc20Assets: [] },
    { chainId: 'eip155:137', nativeAssetId: 'eip155:137/slip44:60', trackedErc20Assets: [] }
  ]
  let active = 0
  let peak = 0
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    extraChains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      if (request.method === 'ankr_getTokenTransfers') return rpc({ transfers: [] })
      if (request.params.blockchain.length > 1) {
        return rpc({ transactions: [tx()], nextPageToken: 'older' })
      }
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      return rpc({
        transactions: [
          tx(request.params.blockchain[0], {
            hash: `0x${request.params.blockchain[0].charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`
          })
        ]
      })
    }
  )
  const cache = memoryCache()
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })
  const result = await reader.readAddressActivities(
    extraChains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS }))
  )

  expect(peak).toBe(2)
  for (const chain of extraChains) expect(result.get(chain.chainId)).toHaveLength(1)
})

test('batch cache refreshes pending records after 30 seconds even with a longer stored retry', async () => {
  const cache = memoryCache([
    {
      schemaVersion: 1,
      chainId: 'eip155:1',
      address: ADDRESS,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 301_000,
      items: [
        {
          id: 'pending',
          scope,
          source: 'rpc',
          status: 'pending',
          createdAt: 1_000,
          updatedAt: 1_000,
          segments: [{ evidence: { blockHeight: 100 } }]
        }
      ]
    }
  ])
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx()] })
        : rpc({ transfers: [] })
    }
  )
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 40_000
  })

  const result = await reader.readAddressActivities([
    { chainId: 'eip155:1', address: ADDRESS, scope }
  ])
  expect(requests).toHaveLength(2)
  expect(requests[0].params.fromBlock).toBe(88)
  expect(result.get('eip155:1')).toHaveLength(2)
})

test('partial cached history never advances a batch incremental cursor past unseen pages', async () => {
  const cache = memoryCache([
    {
      schemaVersion: 1,
      chainId: 'eip155:1',
      address: ADDRESS,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: [
        {
          id: 'partial',
          scope,
          source: 'rpc',
          status: 'final',
          completeness: 'partial',
          createdAt: 1_000,
          updatedAt: 1_000,
          segments: [{ evidence: { blockHeight: 100 } }]
        }
      ]
    }
  ])
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx()] })
        : rpc({ transfers: [] })
    }
  )
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })

  await reader.readAddressActivities([{ chainId: 'eip155:1', address: ADDRESS, scope }])
  expect(requests).toHaveLength(2)
  expect(requests[0].params).not.toHaveProperty('fromBlock')
})

test('a malformed record for one blockchain preserves that chain cache and allows another chain', async () => {
  const previous = {
    schemaVersion: 1,
    chainId: 'eip155:8453',
    address: ADDRESS,
    scope,
    lastAttemptAt: 1,
    successfulSyncAt: 1,
    retryAfter: 2,
    items: []
  }
  const cache = memoryCache([previous])
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx(), tx('base', { hash: 'bad' })] })
        : rpc({ transfers: [] })
    }
  )
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => 10_000
  })
  const result = await reader.readAddressActivities(
    chains.map(chain => ({ chainId: chain.chainId, address: ADDRESS, scope }))
  )
  expect(result.get('eip155:1')).toHaveLength(1)
  expect(result.get('eip155:8453')).toEqual([])
  expect(cache.records.get('eip155:8453').successfulSyncAt).toBe(1)
  expect(cache.records.get('eip155:8453').retryAfter).toBe(70_000)
})
