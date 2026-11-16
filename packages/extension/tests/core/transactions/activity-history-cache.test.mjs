import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ActivityHistoryCache } from '../../../src/background/activity-history-cache.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const testnetChainId = 'bip122:000000000933ea01ad0ee984209779ba'
const scope = Object.freeze({
  keyDomainId: 'wallet:activity-cache',
  accountId: 'account:activity-cache'
})

function memoryStorage() {
  const values = new Map()
  return {
    storage: {
      get: async keys => {
        if (keys === null) return Object.fromEntries(values)
        if (Array.isArray(keys)) {
          return Object.fromEntries(
            keys.filter(key => values.has(key)).map(key => [key, values.get(key)])
          )
        }
        return values.has(keys) ? { [keys]: values.get(keys) } : {}
      },
      set: async items => {
        for (const [key, value] of Object.entries(items)) values.set(key, value)
      },
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      }
    },
    values
  }
}

function memoryRepository() {
  const values = new Map()
  let failWrites = false
  return {
    values,
    setFailWrites(value) {
      failWrites = value
    },
    repository: {
      read: async key => values.get(key),
      write: async (key, value) => {
        if (failWrites) throw new Error('IndexedDB unavailable')
        values.set(key, value)
      },
      removeLegacyProjections: async () => {
        if (failWrites) throw new Error('IndexedDB unavailable')
        for (const [key, record] of values) {
          if (
            /-evm-(?:main|private|all)$/.test(key) ||
            record.schemaVersion !== 2 ||
            Object.keys(record.refreshedAtByChainId ?? {}).some(chainId =>
              chainId.startsWith('eip155:')
            ) ||
            record.items?.some(item =>
              item.segments.some(
                segment =>
                  segment.target.kind === 'onchain' && segment.target.chainId.startsWith('eip155:')
              )
            )
          ) {
            values.delete(key)
          }
        }
      },
      deleteByPrefixes: async prefixes => {
        for (const key of values.keys()) {
          if (prefixes.some(prefix => key.startsWith(prefix))) values.delete(key)
        }
      },
      clear: async () => values.clear()
    }
  }
}

function bitcoinActivityItem(itemChainId = chainId) {
  const transactionHash = 'a'.repeat(64)
  return Object.freeze({
    id: `rpc:bitcoin:${transactionHash}`,
    source: 'rpc',
    scope,
    kind: 'transfer',
    status: 'final',
    snapshot: Object.freeze({
      schemaVersion: 1,
      direction: 'incoming',
      primaryAmount: Object.freeze({ assetId: `${itemChainId}/slip44:0`, amountRaw: '1000' })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `rpc:bitcoin:${transactionHash}:origin`,
        role: 'origin',
        target: Object.freeze({ kind: 'onchain', chainId: itemChainId }),
        status: 'final',
        evidence: Object.freeze({
          transactionHash,
          blockHash: 'b'.repeat(64),
          blockHeight: 1,
          confirmations: 6,
          requiredConfirmations: 6
        })
      })
    ]),
    completeness: 'partial',
    createdAt: 1_000,
    updatedAt: 1_000
  })
}

function nativeActivityItem(itemChainId, slip44, id) {
  return Object.freeze({
    ...bitcoinActivityItem(itemChainId),
    id,
    snapshot: Object.freeze({
      schemaVersion: 1,
      direction: 'incoming',
      primaryAmount: Object.freeze({
        assetId: `${itemChainId}/slip44:${slip44}`,
        amountRaw: '1000'
      })
    }),
    segments: Object.freeze([
      Object.freeze({
        ...bitcoinActivityItem(itemChainId).segments[0],
        id: `${id}:origin`,
        target: Object.freeze({ kind: 'onchain', chainId: itemChainId })
      })
    ])
  })
}

test('persists bounded RPC Activity across Popup and Service Worker reconstruction', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const first = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const item = bitcoinActivityItem()
  const partition = 'active-address-p2wpkh-v2'

  await first.write(scope, { [chainId]: 2_000 }, [item], partition)

  const rebuilt = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  await expect(rebuilt.read(scope, partition)).resolves.toEqual({
    refreshedAtByChainId: { [chainId]: 2_000 },
    items: [item]
  })
})

test('partitions Activity by network and removes both projections with the Account', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const mainnet = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const testnet = new ActivityHistoryCache('testnet', memory.storage, database.repository)
  const item = bitcoinActivityItem()

  await mainnet.write(scope, { [chainId]: 2_000 }, [item], 'p2wpkh')
  await mainnet.write(scope, { [chainId]: 3_000 }, [item], 'p2tr')
  await testnet.write(scope, { [testnetChainId]: 2_000 }, [bitcoinActivityItem(testnetChainId)])
  expect(database.values.size).toBe(3)
  expect(memory.values.size).toBe(0)
  await expect(mainnet.read(scope, 'p2wpkh')).resolves.toMatchObject({
    refreshedAtByChainId: { [chainId]: 2_000 }
  })
  await expect(mainnet.read(scope, 'p2tr')).resolves.toMatchObject({
    refreshedAtByChainId: { [chainId]: 3_000 }
  })

  await mainnet.deleteByScope(scope)
  expect(database.values.size).toBe(0)
})

test('persists Solana and NEAR RPC Activity in the shared cache', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const cache = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const items = [
    nativeActivityItem(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      '501',
      'rpc:solana:activity-cache'
    ),
    nativeActivityItem('near:mainnet', '397', 'rpc:near:activity-cache')
  ]

  await cache.write(
    scope,
    {
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 3_000,
      'near:mainnet': 3_000
    },
    items
  )

  await expect(cache.read(scope)).resolves.toEqual({
    refreshedAtByChainId: {
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 3_000,
      'near:mainnet': 3_000
    },
    items: [items[1], items[0]]
  })
})

test('bounds durable Activity history to the newest 50 items', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const cache = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const items = Array.from({ length: 75 }, (_, index) => ({
    ...nativeActivityItem(chainId, '0', `rpc:bitcoin:bounded-${index}`),
    createdAt: index,
    updatedAt: index
  }))

  await cache.write(scope, { [chainId]: 5_000 }, items)

  const stored = await cache.read(scope)
  expect(stored?.items).toHaveLength(50)
  expect(stored?.items[0].updatedAt).toBe(74)
  expect(stored?.items.at(-1).updatedAt).toBe(25)
})

test('discards every Chrome v2 history partition while preserving current IndexedDB history', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const cache = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const current = bitcoinActivityItem()
  const currentKey = `activity_history_cache_v3:mainnet:${scope.keyDomainId}:${scope.accountId}:p2wpkh`
  const oldPrefix = 'activity_history_cache_v2:'
  await memory.storage.set({
    [`${oldPrefix}mainnet:${scope.keyDomainId}:${scope.accountId}:p2wpkh-evm-main`]: {
      schemaVersion: 2,
      refreshedAtByChainId: { [chainId]: 1_000 },
      items: [nativeActivityItem('near:mainnet', '397', 'rpc:old-near')]
    },
    [`${oldPrefix}testnet:another-wallet:another-account:p2tr-evm-private`]: {
      schemaVersion: 2,
      refreshedAtByChainId: {},
      items: []
    },
    wallet_state: { retained: true }
  })
  database.values.set(currentKey, {
    schemaVersion: 2,
    refreshedAtByChainId: { [chainId]: 3_000 },
    items: [current]
  })

  await expect(cache.read(scope, 'p2wpkh')).resolves.toEqual({
    refreshedAtByChainId: { [chainId]: 3_000 },
    items: [current]
  })
  expect([...memory.values.keys()]).toEqual(['wallet_state'])
  expect(database.values.get(currentKey).items).toEqual([current])
})

test('drops mixed and per-mode v3 projections from other partitions without removing current data', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const cache = new ActivityHistoryCache('mainnet', memory.storage, database.repository)
  const base = `activity_history_cache_v3:mainnet:${scope.keyDomainId}:${scope.accountId}:`
  const current = bitcoinActivityItem()
  database.values.set(`${base}p2wpkh`, {
    schemaVersion: 2,
    refreshedAtByChainId: { [chainId]: 3_000 },
    items: [current]
  })
  database.values.set(`${base}p2tr`, {
    schemaVersion: 2,
    refreshedAtByChainId: { 'eip155:1': 2_000 },
    items: [nativeActivityItem('eip155:1', '60', 'rpc:old-evm')]
  })
  database.values.set(`${base}p2tr-evm-private`, {
    schemaVersion: 2,
    refreshedAtByChainId: { [chainId]: 2_000 },
    items: [current]
  })
  database.values.set(`${base}old-schema`, {
    schemaVersion: 1,
    refreshedAtByChainId: { [chainId]: 2_000 },
    items: [current]
  })

  await expect(cache.read(scope, 'p2wpkh')).resolves.toMatchObject({ items: [current] })
  expect([...database.values.keys()]).toEqual([`${base}p2wpkh`])
})

test('does not serve old Chrome history when the current IndexedDB read fails', async () => {
  const memory = memoryStorage()
  const database = memoryRepository()
  const oldKey = `activity_history_cache_v2:mainnet:${scope.keyDomainId}:${scope.accountId}:default`
  await memory.storage.set({
    [oldKey]: {
      schemaVersion: 2,
      refreshedAtByChainId: { [chainId]: 2_000 },
      items: [bitcoinActivityItem()]
    }
  })
  const unavailable = {
    ...database.repository,
    read: async () => {
      throw new Error('IndexedDB unavailable')
    }
  }
  const cache = new ActivityHistoryCache('mainnet', memory.storage, unavailable)

  await expect(cache.read(scope)).rejects.toThrow('IndexedDB unavailable')
  expect(memory.values.has(oldKey)).toBe(false)
})
