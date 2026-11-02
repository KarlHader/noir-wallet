import { test } from 'node:test'
import { expect } from '@playwright/test'

import { EvmRpcError } from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'
import {
  createCachedEvmActivityHistorySource,
  createCachedOnlyEvmActivityHistorySource
} from '../../../../src/infrastructure/chains/evm/evm-cached-history-source.ts'

const chainId = 'eip155:1'
const address = `0x${'1'.repeat(40)}`
const scope = Object.freeze({
  keyDomainId: 'keydomain_evm-history-cache',
  accountId: 'account_evm-history-cache'
})

function memoryCache(initial = null) {
  let record = initial
  let writes = 0
  return {
    repository: {
      read: async () => record,
      write: async value => {
        writes += 1
        record = value
      }
    },
    record: () => record,
    writes: () => writes
  }
}

function source(readAddressActivity) {
  return {
    readAddressActivity,
    findConfirmedReplacement: async () => null
  }
}

function activityItem(overrides = {}) {
  const transactionHash = `0x${'a'.repeat(64)}`
  return Object.freeze({
    id: `rpc:evm:${transactionHash}:native`,
    source: 'rpc',
    scope,
    kind: 'transfer',
    status: 'final',
    snapshot: Object.freeze({
      schemaVersion: 1,
      direction: 'incoming',
      primaryAmount: Object.freeze({ assetId: 'eip155:1/slip44:60', amountRaw: '1' }),
      sender: Object.freeze({ chainId, address: `0x${'2'.repeat(40)}` }),
      recipient: Object.freeze({ chainId, address })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `rpc:evm:${transactionHash}:native:origin`,
        role: 'origin',
        target: Object.freeze({ kind: 'onchain', chainId }),
        status: 'final',
        evidence: Object.freeze({
          transactionHash,
          blockHash: `0x${'b'.repeat(64)}`,
          blockHeight: 1
        })
      })
    ]),
    completeness: 'complete',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  })
}

test.describe('cached EVM history source', () => {
  test('degrades inferred legacy protocol amounts and refreshes their evidence from full history', async () => {
    const hash = `0x${'a'.repeat(64)}`
    const tokenAssetId = `eip155:1/erc20:0x${'3'.repeat(40)}`
    const old = activityItem({
      id: `rpc:evm:${chainId}:${hash}:token`,
      kind: 'supply',
      snapshot: {
        ...activityItem().snapshot,
        direction: 'outgoing',
        primaryAmount: { assetId: tokenAssetId, amountRaw: '500' }
      }
    })
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 100_000,
      items: [old]
    })
    const cachedOnly = createCachedOnlyEvmActivityHistorySource({
      chainId,
      cache: cache.repository
    })
    const [degraded] = await cachedOnly.readAddressActivity({ scope, address })
    expect(degraded.kind).toBe('contract-call')
    expect(degraded.completeness).toBe('partial')
    expect(degraded.snapshot.primaryAmount).toBeUndefined()
    expect(cache.record().items[0].kind).toBe('supply')

    const fresh = activityItem({
      id: `rpc:evm:${chainId}:${hash}:native`,
      segments: [
        {
          ...old.segments[0],
          evidence: {
            ...old.segments[0].evidence,
            assetEffects: {
              source: 'indexer',
              completeness: 'partial',
              changes: [{ assetId: tokenAssetId, amountRaw: '500', direction: 'outgoing' }]
            }
          }
        }
      ]
    })
    let fromBlock = -1
    const reader = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 2_000,
      source: source(async input => {
        fromBlock = input.fromBlock
        return [fresh]
      })
    })
    expect((await reader.readAddressActivity({ scope, address })).map(item => item.id)).toEqual([
      fresh.id
    ])
    expect(fromBlock).toBeUndefined()
  })

  test('replaces a legacy token row when a fresh grouped row has the same chain and hash', async () => {
    const hash = `0x${'a'.repeat(64)}`
    const old = activityItem({ id: `rpc:evm:${chainId}:${hash}:token` })
    const fresh = activityItem({
      id: `rpc:evm:${chainId}:${hash}:native`,
      segments: [
        {
          ...old.segments[0],
          evidence: {
            ...old.segments[0].evidence,
            assetEffects: {
              source: 'indexer',
              completeness: 'partial',
              changes: [{ assetId: 'eip155:1/slip44:60', amountRaw: '1', direction: 'incoming' }]
            }
          }
        }
      ]
    })
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: [old]
    })
    const reader = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 3_000,
      source: source(async () => [fresh])
    })
    expect((await reader.readAddressActivity({ scope, address })).map(item => item.id)).toEqual([
      fresh.id
    ])
    expect(cache.record().items.map(item => item.id)).toEqual([fresh.id])
  })

  test('keeps an existing chain cache visible when its remote source is unavailable', async () => {
    const cachedItem = activityItem()
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: [cachedItem]
    })
    const cachedOnly = createCachedOnlyEvmActivityHistorySource({
      chainId,
      cache: cache.repository
    })

    await expect(cachedOnly.readAddressActivity({ scope, address })).resolves.toEqual([cachedItem])
    expect(cache.writes()).toBe(0)
  })

  test('retains more than 50 cached chain items when its remote source is unavailable', async () => {
    const cachedItems = Array.from({ length: 75 }, (_, index) =>
      activityItem({
        id: `rpc:evm:legacy-${index}`,
        createdAt: index,
        updatedAt: index
      })
    )
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: cachedItems
    })
    const cachedOnly = createCachedOnlyEvmActivityHistorySource({
      chainId,
      cache: cache.repository
    })

    const result = await cachedOnly.readAddressActivity({ scope, address })
    expect(result).toHaveLength(75)
    expect(result[0].updatedAt).toBe(74)
    expect(result.at(-1).updatedAt).toBe(0)
    expect(cache.record().items).toHaveLength(75)
    expect(cache.writes()).toBe(0)
  })

  test('persists a successful empty result across a Service Worker source rebuild', async () => {
    const cache = memoryCache()
    let currentTime = 10_000
    let firstCalls = 0
    const first = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => currentTime,
      successTtlMs: 120_000,
      source: source(async () => {
        firstCalls += 1
        return Object.freeze([])
      })
    })

    await expect(first.readAddressActivity({ scope, address })).resolves.toEqual([])
    expect(firstCalls).toBe(1)
    expect(cache.record()).toMatchObject({
      successfulSyncAt: 10_000,
      retryAfter: 130_000,
      items: []
    })

    currentTime = 20_000
    let rebuiltCalls = 0
    const rebuilt = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => currentTime,
      successTtlMs: 120_000,
      source: source(async () => {
        rebuiltCalls += 1
        return Object.freeze([])
      })
    })
    await expect(rebuilt.readAddressActivity({ scope, address })).resolves.toEqual([])
    expect(rebuiltCalls).toBe(0)
    expect(cache.writes()).toBe(1)
  })

  test('preserves bounded history when an incremental refresh has no new items', async () => {
    const cachedItem = activityItem()
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: [cachedItem]
    })
    const cachedSource = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 100_000,
      source: source(async () => Object.freeze([]))
    })

    await expect(cachedSource.readAddressActivity({ scope, address })).resolves.toEqual([
      cachedItem
    ])
    expect(cache.record()).toMatchObject({
      successfulSyncAt: 100_000,
      items: [cachedItem]
    })
  })

  test('refreshes from a reorg overlap without discarding older items', async () => {
    const previous = Array.from({ length: 50 }, (_, index) =>
      activityItem({
        id: `rpc:evm:cached-${index}`,
        createdAt: 1_000 + index,
        updatedAt: 1_000 + index,
        segments: [
          {
            ...activityItem().segments[0],
            id: `rpc:evm:cached-${index}:origin`,
            evidence: {
              ...activityItem().segments[0].evidence,
              blockHeight: 100 + index
            }
          }
        ]
      })
    )
    const fresh = activityItem({
      id: 'rpc:evm:fresh',
      createdAt: 2_000,
      updatedAt: 2_000,
      segments: [
        {
          ...activityItem().segments[0],
          id: 'rpc:evm:fresh:origin',
          evidence: { ...activityItem().segments[0].evidence, blockHeight: 150 }
        }
      ]
    })
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: previous
    })
    let refreshInput
    const cachedSource = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 100_000,
      source: source(async input => {
        refreshInput = input
        return [fresh]
      })
    })

    const result = await cachedSource.readAddressActivity({ scope, address })
    expect(refreshInput.fromBlock).toBe(137)
    expect(result).toHaveLength(51)
    expect(result[0].id).toBe('rpc:evm:fresh')
    expect(result.some(item => item.id === 'rpc:evm:cached-0')).toBe(true)
  })

  test('persists failure backoff without representing a failed request as a successful empty history', async () => {
    const cache = memoryCache()
    let currentTime = 50_000
    const failing = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => currentTime,
      failureBackoffMs: 60_000,
      source: source(async () => {
        throw new EvmRpcError('rate-limited', 'rate limited')
      })
    })

    await expect(failing.readAddressActivity({ scope, address })).rejects.toMatchObject({
      code: 'rate-limited'
    })
    expect(cache.record()).toMatchObject({
      successfulSyncAt: null,
      lastAttemptAt: 50_000,
      retryAfter: 110_000,
      items: []
    })

    currentTime = 90_000
    let calls = 0
    const rebuilt = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => currentTime,
      failureBackoffMs: 60_000,
      source: source(async () => {
        calls += 1
        return Object.freeze([])
      })
    })
    await expect(rebuilt.readAddressActivity({ scope, address })).resolves.toEqual([])
    expect(calls).toBe(0)
  })

  test('preserves stale history when its awaited refresh fails', async () => {
    const cachedItem = activityItem()
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 1_000,
      successfulSyncAt: 1_000,
      retryAfter: 2_000,
      items: [cachedItem]
    })
    let calls = 0
    const cachedSource = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 100_000,
      failureBackoffMs: 60_000,
      source: source(async () => {
        calls += 1
        throw new EvmRpcError('network-unavailable', 'offline')
      })
    })

    await expect(cachedSource.readAddressActivity({ scope, address })).resolves.toEqual([
      cachedItem
    ])
    expect(calls).toBe(1)
    expect(cache.record()?.retryAfter).toBe(160_000)
    expect(cache.record()).toMatchObject({ successfulSyncAt: 1_000, items: [cachedItem] })
  })

  test('does not share an in-flight address refresh across Account scopes', async () => {
    const otherScope = { ...scope, accountId: 'account_evm-history-cache-other' }
    let readCount = 0
    let sourceStarted
    const started = new Promise(resolve => {
      sourceStarted = resolve
    })
    let bothReadsStarted
    const bothReads = new Promise(resolve => {
      bothReadsStarted = resolve
    })
    let releaseSource
    const sourceGate = new Promise(resolve => {
      releaseSource = resolve
    })
    const records = new Map()
    const cachedSource = createCachedEvmActivityHistorySource({
      chainId,
      cache: {
        read: async (_chainId, _address, requestedScope) => {
          readCount += 1
          if (readCount === 2) bothReadsStarted()
          return records.get(requestedScope.accountId) ?? null
        },
        write: async record => {
          records.set(record.scope.accountId, record)
        }
      },
      now: () => 10_000,
      source: source(async input => {
        sourceStarted()
        await sourceGate
        return [activityItem({ scope: input.scope })]
      })
    })

    const first = cachedSource.readAddressActivity({ scope, address })
    await started
    const second = cachedSource.readAddressActivity({ scope: otherScope, address })
    await bothReads
    releaseSource()

    expect((await first)[0].scope).toEqual(scope)
    expect((await second)[0].scope).toEqual(otherScope)
    expect(records.size).toBe(2)
  })

  test('keeps failure backoff even when stale cache items are pending', async () => {
    const pendingItem = activityItem({ status: 'pending' })
    const cache = memoryCache({
      schemaVersion: 1,
      chainId,
      address,
      scope,
      lastAttemptAt: 100_000,
      successfulSyncAt: 1_000,
      retryAfter: 160_000,
      items: [pendingItem]
    })
    let calls = 0
    const cachedSource = createCachedEvmActivityHistorySource({
      chainId,
      cache: cache.repository,
      now: () => 135_000,
      source: source(async () => {
        calls += 1
        return []
      })
    })

    await expect(cachedSource.readAddressActivity({ scope, address })).resolves.toEqual([
      pendingItem
    ])
    expect(calls).toBe(0)
  })
})
