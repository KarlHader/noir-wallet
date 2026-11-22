import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createEvmAnkrHistoryClient } from '../../../../src/infrastructure/chains/evm/evm-ankr-history-client.ts'
import { buildTrackedErc20Assets } from '../../../../src/infrastructure/chains/evm/index.ts'
import { filterTrackedEvmTokenActivity } from '../../../../src/infrastructure/chains/evm/evm-indexed-activity.ts'
import { createCachedEvmAnkrHistoryBatchSource } from '../../../../src/infrastructure/chains/evm/evm-cached-history-source.ts'
import { mergeEvmHistoryCacheRecords } from '../../../../src/infrastructure/chains/evm/evm-activity-history-cache.ts'
import { getEvmNetworkConfigs } from '../../../../src/config/networks.ts'
import {
  buildActivityReadModel,
  parseActivityReadModel
} from '../../../../src/core/activity/index.ts'

const ADDRESS = `0x${'1'.repeat(40)}`
const OTHER = `0x${'2'.repeat(40)}`
const HASH = `0x${'a'.repeat(64)}`
const BLOCK_HASH = `0x${'b'.repeat(64)}`
const CONTRACT = `0x${'3'.repeat(40)}`
const BASE = 'eip155:8453'
const NATIVE_INTERNAL_METHOD = 'noir_getNativeInternalTransfers'
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

function internalTransfer(overrides = {}) {
  return {
    hash: HASH,
    blockNumber: '0x64',
    timestamp: '2023-11-14T22:13:20.000Z',
    from: CONTRACT,
    to: ADDRESS,
    value: '0x28',
    transferId: `${HASH}:internal:0`,
    ...overrides
  }
}

function baseTokenTransfer(overrides = {}) {
  return {
    blockchain: 'base',
    transactionHash: HASH,
    blockHeight: 100,
    fromAddress: CONTRACT,
    toAddress: ADDRESS,
    contractAddress: CONTRACT,
    tokenDecimals: 6,
    timestamp: 1_700_000_000,
    valueRawInteger: '5000000',
    ...overrides
  }
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
      if (request.method === NATIVE_INTERNAL_METHOD) return rpc({ transfers: [] })
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
  expect(requests).toHaveLength(3)
  expect(requests.find(value => value.method === NATIVE_INTERNAL_METHOD).params).toEqual({
    blockchain: ['base'],
    address: ADDRESS,
    pageSize: 200,
    descOrder: true,
    fromBlock: 50
  })
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

test('Base discovers internal ETH receipts by address and nets all movements by transaction', async () => {
  const incomingHash = `0x${'c'.repeat(64)}`
  const revertedHash = `0x${'d'.repeat(64)}`
  const zeroNetHash = `0x${'e'.repeat(64)}`
  const indexedRequests = []
  const overlap = internalTransfer()
  const pageToken = 'p'.repeat(700)
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      indexedRequests.push(request)
      if (request.method === NATIVE_INTERNAL_METHOD) {
        return request.params.pageToken
          ? rpc({ transfers: [overlap, internalTransfer({ transferId: `${HASH}:internal:1` })] })
          : rpc({
              transfers: [
                overlap,
                internalTransfer({ hash: incomingHash, transferId: `${incomingHash}:internal:0` }),
                internalTransfer({ hash: revertedHash, transferId: `${revertedHash}:internal:0` }),
                internalTransfer({ hash: zeroNetHash, transferId: `${zeroNetHash}:internal:0` }),
                internalTransfer({
                  hash: zeroNetHash,
                  transferId: `${zeroNetHash}:internal:1`,
                  from: ADDRESS,
                  to: CONTRACT
                })
              ],
              nextPageToken: pageToken
            })
      }
      if (request.method === 'ankr_getTransactionsByAddress') {
        return rpc({
          transactions: [
            tx('base', { from: ADDRESS, to: CONTRACT, value: '0x64', input: '0x1234' }),
            tx('base', { hash: revertedHash, status: '0x0', value: '0x0' })
          ]
        })
      }
      return rpc({ transfers: [baseTokenTransfer()] })
    }
  )

  const { items } = (
    await client.readAddressActivities([
      { chainId: BASE, address: ADDRESS, scope, historyPageCount: 2 }
    ])
  ).get(BASE)
  expect(
    indexedRequests
      .filter(request => request.method === NATIVE_INTERNAL_METHOD)
      .map(request => request.params.pageToken)
  ).toEqual([undefined, pageToken])
  expect(
    parseActivityReadModel(
      buildActivityReadModel({ scope, localGraphs: [], supplementalItems: items })
    ).items
  ).toHaveLength(4)
  const byHash = new Map(items.map(item => [item.segments[0].evidence.transactionHash, item]))
  expect(byHash.get(HASH).segments[0].evidence).toMatchObject({
    blockHash: BLOCK_HASH,
    externalReference: 'evm-nonce:1',
    assetEffects: {
      changes: [
        { assetId: `eip155:8453/erc20:${CONTRACT}`, amountRaw: '5000000', direction: 'incoming' },
        { assetId: 'eip155:8453/slip44:60', amountRaw: '20', direction: 'outgoing' }
      ]
    }
  })
  const incoming = byHash.get(incomingHash)
  expect(incoming).toMatchObject({
    kind: 'transfer',
    status: 'final',
    completeness: 'partial',
    snapshot: { direction: 'incoming', primaryAmount: { amountRaw: '40' } }
  })
  expect(incoming.segments[0].evidence).not.toHaveProperty('blockHash')
  expect(incoming.segments[0].evidence).not.toHaveProperty('externalReference')
  expect(byHash.get(revertedHash).status).toBe('failed')
  expect(byHash.get(revertedHash).segments[0].evidence).not.toHaveProperty('assetEffects')
  expect(byHash.get(zeroNetHash).segments[0].evidence.assetEffects.changes).toEqual([])
})

test('Base backfills legacy history and retries incomplete sources without advancing coverage', async () => {
  const incomingHash = `0x${'c'.repeat(64)}`
  const recentHash = `0x${'d'.repeat(64)}`
  const legacy = {
    schemaVersion: 1,
    chainId: BASE,
    scope,
    address: ADDRESS,
    lastAttemptAt: 1,
    successfulSyncAt: 1,
    retryAfter: 900_000,
    historyPageCount: 2,
    items: []
  }
  const ethereum = { ...legacy, chainId: 'eip155:1' }
  const cache = memoryCache([legacy, ethereum])
  let now = 10_000
  let internalAvailable = false
  let newNormalTransaction = false
  const starts = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      expect(request.params.blockchain).toEqual(['base'])
      if (request.method === NATIVE_INTERNAL_METHOD) {
        starts.push(request.params.fromBlock)
        return internalAvailable
          ? rpc({ transfers: [internalTransfer({ hash: incomingHash })] })
          : rpc({ error: { code: -32601 } })
      }
      if (request.method === 'ankr_getTransactionsByAddress') {
        return rpc({
          transactions: [
            tx('base'),
            ...(newNormalTransaction
              ? [tx('base', { hash: recentHash, blockNumber: '0x12c' })]
              : [])
          ]
        })
      }
      return rpc({ transfers: [] })
    }
  )
  const reader = createCachedEvmAnkrHistoryBatchSource({
    source: client,
    cache: cache.repository,
    now: () => now
  })
  const targets = chains.map(chain => ({ chainId: chain.chainId, address: ADDRESS, scope }))
  const refresh = () => reader.readAddressActivities(targets)
  expect(
    (await refresh()).get(BASE).map(item => item.segments[0].evidence.transactionHash)
  ).toEqual([HASH])
  expect(cache.records.get(BASE)).toMatchObject({
    successfulSyncAt: 1,
    retryAfter: 70_000,
    historyPageCount: 2
  })
  expect(cache.records.get(BASE).internalHistory).toBeUndefined()
  now = 69_999
  await refresh()
  expect(starts).toEqual([undefined])

  internalAvailable = true
  now = 70_000
  const recovered = (await refresh()).get(BASE)
  expect(recovered).toHaveLength(2)
  const recoveredRecord = cache.records.get(BASE)
  expect(recoveredRecord.internalHistory.indexedThroughBlock).toBe(100)
  expect(recoveredRecord.historyPageCount).toBe(2)
  expect(cache.records.get('eip155:1')).toBe(ethereum)

  const receipt = recovered.find(item => item.id.endsWith(':internal'))
  const obsoleteTokenId = receipt.id.replace(/:internal$/, ':token')
  const obsoleteRecord = {
    ...legacy,
    items: [
      {
        ...receipt,
        id: obsoleteTokenId,
        segments: [{ ...receipt.segments[0], id: `${obsoleteTokenId}:origin` }]
      }
    ]
  }
  expect(mergeEvmHistoryCacheRecords(obsoleteRecord, recoveredRecord).items).toEqual(recovered)

  internalAvailable = false
  newNormalTransaction = true
  now = recoveredRecord.retryAfter
  expect((await refresh()).get(BASE)).toHaveLength(3)
  const degraded = cache.records.get(BASE)
  expect(degraded.successfulSyncAt).toBe(70_000)
  expect(degraded.internalHistory.indexedThroughBlock).toBe(100)
  expect(degraded.items.find(item => item.id === receipt.id)).toEqual(receipt)
  internalAvailable = true
  now = degraded.retryAfter
  await refresh()
  expect(starts).toEqual([undefined, undefined, 88, 88])
  expect(cache.records.get(BASE).internalHistory.indexedThroughBlock).toBe(300)
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

test('backfills BNB Chain USDT receipts when the tracked asset list changes', async () => {
  const bnbChain = getEvmNetworkConfigs('mainnet').find(chain => chain.chainId === 'eip155:56')
  const tracked = buildTrackedErc20Assets(bnbChain)
  const usdc = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
  const usdt = '0x55d398326f99059ff775485246999027b3197955'
  const transfers = [
    [usdc, 200, HASH],
    [usdt, 100, `0x${'d'.repeat(64)}`]
  ].map(([contractAddress, blockHeight, transactionHash]) => ({
    blockchain: 'bsc',
    transactionHash,
    blockHeight,
    fromAddress: OTHER,
    toAddress: ADDRESS,
    contractAddress,
    tokenDecimals: 18,
    timestamp: 1_700_000_000,
    valueRawInteger: '2000000000000000000'
  }))
  const cache = memoryCache()
  const target = { chainId: bnbChain.chainId, scope, address: ADDRESS }
  let now = 1_700_000_001_000
  const reader = (assets, key) =>
    createCachedEvmAnkrHistoryBatchSource({
      source: createEvmAnkrHistoryClient(
        'https://history.example/',
        [
          {
            chainId: bnbChain.chainId,
            nativeAssetId: 'eip155:56/slip44:714',
            trackedErc20Assets: assets
          }
        ],
        async (_url, init) => {
          const { method, params } = JSON.parse(init.body)
          return method === 'ankr_getTransactionsByAddress'
            ? rpc({ transactions: [] })
            : rpc({
                transfers: transfers.filter(
                  transfer => transfer.blockHeight >= (params.fromBlock ?? 0)
                )
              })
        }
      ),
      cache: cache.repository,
      now: () => now,
      trackedAssetKeys: key === undefined ? undefined : new Map([[target.chainId, key]])
    })

  const initial = await reader(
    tracked.filter(asset => asset.contract !== usdt)
  ).readAddressActivities([target])
  expect(initial.get(target.chainId)).toHaveLength(1)
  now += 1_000
  const updated = await reader(tracked, 'USDC,USDT').readAddressActivities([target])
  const items = buildActivityReadModel({
    scope,
    localGraphs: [],
    supplementalItems: updated.get(target.chainId)
  }).items
  expect(items).toHaveLength(2)
  const trackedIds = new Set(tracked.map(asset => asset.assetId))
  for (const transfer of transfers) {
    const item = items.find(
      item => item.segments[0].evidence.transactionHash === transfer.transactionHash
    )
    expect(item?.snapshot).toMatchObject({
      direction: 'incoming',
      primaryAmount: {
        assetId: `${target.chainId}/erc20:${transfer.contractAddress}`,
        amountRaw: transfer.valueRawInteger
      },
      recipient: { chainId: target.chainId, address: ADDRESS }
    })
    expect(filterTrackedEvmTokenActivity(item, trackedIds)).toBe(item)
  }
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
  expect(requests).toHaveLength(6)
  expect(requests[3].params.blockchain).toEqual(['base'])
  expect(requests[0].params).not.toHaveProperty('fromBlock')

  currentTime = 40_000
  const second = await reader.readAddressActivities(targets)
  expect(requests).toHaveLength(8)
  expect(requests[6].params.blockchain).toEqual(['eth'])
  expect(second.get('eip155:8453')).toHaveLength(1)
})

test('a failed shared native branch retries each chain to recover recent transactions', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      if (request.method === 'ankr_getTransactionsByAddress') {
        return request.params.blockchain.length > 1
          ? new Response('', { status: 503 })
          : rpc({ transactions: [tx(request.params.blockchain[0])] })
      }
      return rpc({ transfers: [] })
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
  expect(requests).toHaveLength(8)
  expect(requests.slice(3).map(request => request.params.blockchain)).toEqual([
    ['eth'],
    ['eth'],
    ['base'],
    ['base'],
    ['base']
  ])
  for (const chain of chains) {
    expect(result.get(chain.chainId)).toHaveLength(1)
    expect(cache.records.get(chain.chainId).successfulSyncAt).toBe(10_000)
  }
})

test('a failed shared history request retries chains independently', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      if (request.params.blockchain.length > 1) return new Response('', { status: 503 })
      return request.method === 'ankr_getTransactionsByAddress'
        ? rpc({ transactions: [tx(request.params.blockchain[0])] })
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
  expect(requests).toHaveLength(8)
  for (const chain of chains) {
    expect(result.get(chain.chainId)).toHaveLength(1)
    expect(cache.records.get(chain.chainId).successfulSyncAt).toBe(10_000)
  }
})

test('a partial single-chain retry does not erase successful shared token history', async () => {
  const tokenHash = `0x${'c'.repeat(64)}`
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      if (request.method === NATIVE_INTERNAL_METHOD) return rpc({ transfers: [] })
      if (request.method === 'ankr_getTransactionsByAddress') {
        return request.params.blockchain.length > 1
          ? new Response('', { status: 503 })
          : rpc({ transactions: [tx(request.params.blockchain[0])] })
      }
      if (request.params.blockchain.length === 1) return new Response('', { status: 503 })
      return rpc({
        transfers: [
          {
            blockchain: 'base',
            transactionHash: tokenHash,
            blockHeight: 101,
            fromAddress: OTHER,
            toAddress: ADDRESS,
            contractAddress: CONTRACT,
            tokenDecimals: 6,
            timestamp: 1_700_000_000,
            valueRawInteger: '5000000'
          }
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
    chains.map(chain => ({ chainId: chain.chainId, scope, address: ADDRESS }))
  )
  expect(result.get('eip155:8453').map(item => item.segments[0].evidence.transactionHash)).toEqual([
    tokenHash
  ])
  expect(cache.records.get('eip155:8453')).toMatchObject({
    successfulSyncAt: null,
    retryAfter: 70_000
  })
})

test('a failed history branch retains failure backoff when single-chain retries also fail', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    chains,
    async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      if (request.method === NATIVE_INTERNAL_METHOD) return rpc({ transfers: [] })
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
  expect(requests).toHaveLength(8)
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
  expect(requests).toHaveLength(6)
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
      if (request.method !== 'ankr_getTransactionsByAddress') return rpc({ transfers: [] })
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
