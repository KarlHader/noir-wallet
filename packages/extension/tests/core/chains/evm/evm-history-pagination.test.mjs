import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEvmAnkrHistoryClient } from '../../../../src/infrastructure/chains/evm/evm-ankr-history-client.ts'
import { createCachedEvmActivityHistorySource } from '../../../../src/infrastructure/chains/evm/evm-cached-history-source.ts'
import { mergeEvmHistoryCacheRecords } from '../../../../src/infrastructure/chains/evm/evm-activity-history-cache.ts'
import { mapEvmIndexedActivity } from '../../../../src/infrastructure/chains/evm/evm-indexed-activity.ts'
import { parseTrustedExtensionRuntimeMessage } from '../../../../src/lib/runtime-message-security.ts'

const chainId = 'eip155:1'
const address = `0x${'1'.repeat(40)}`
const recipient = `0x${'2'.repeat(40)}`
const contract = `0x${'3'.repeat(40)}`
const scope = { keyDomainId: 'keydomain_evm-pagination', accountId: 'account_evm-pagination' }
const chain = {
  chainId,
  nativeAssetId: `${chainId}/slip44:60`,
  trackedErc20Assets: [{ assetId: `${chainId}/erc20:${contract}`, contract, decimals: 6 }]
}
const hash = number => `0x${number.toString(16).padStart(64, '0')}`

function transaction(number) {
  return {
    blockchain: 'eth',
    hash: hash(number),
    blockHash: hash(500),
    blockNumber: '0x64',
    from: address,
    to: recipient,
    value: '0x1',
    gasPrice: '0x1',
    gasUsed: '0x5208',
    nonce: `0x${number.toString(16)}`,
    timestamp: '0x6553f100',
    status: '0x1',
    input: '0x'
  }
}

function transfer(number) {
  return {
    blockchain: 'eth',
    transactionHash: hash(number),
    blockHeight: 100,
    timestamp: 1_700_000_000,
    fromAddress: address,
    toAddress: recipient,
    contractAddress: contract,
    tokenDecimals: 6,
    valueRawInteger: '1000000'
  }
}

function response(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

test('deeper history advances independent native and token cursors within the requested bound', async () => {
  const requests = []
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    [chain],
    async (_, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      const cursor = request.params.pageToken
      if (request.method === 'ankr_getTransactionsByAddress') {
        return response(
          cursor === 'native-2'
            ? { transactions: [transaction(2)] }
            : { transactions: [transaction(1)], nextPageToken: 'native-2' }
        )
      }
      return response(
        cursor === 'token-3'
          ? { transfers: [transfer(13)] }
          : cursor === 'token-2'
            ? { transfers: [transfer(12)], nextPageToken: 'token-3' }
            : { transfers: [transfer(11)], nextPageToken: 'token-2' }
      )
    }
  )

  const pageTwo = (
    await client.readAddressActivities([{ chainId, scope, address, historyPageCount: 2 }])
  ).get(chainId)
  assert.equal(pageTwo.hasMore, true)
  assert.equal(pageTwo.items.length, 4)
  assert.equal(requests.length, 4)
  assert.deepEqual(
    requests
      .filter(request => request.method === 'ankr_getTransactionsByAddress')
      .map(request => request.params.pageToken),
    [undefined, 'native-2']
  )
  assert.deepEqual(
    requests
      .filter(request => request.method === 'ankr_getTokenTransfers')
      .map(request => request.params.pageToken),
    [undefined, 'token-2']
  )

  requests.length = 0
  const pageThree = (
    await client.readAddressActivities([{ chainId, scope, address, historyPageCount: 3 }])
  ).get(chainId)
  assert.equal(pageThree.hasMore, false)
  assert.equal(pageThree.items.length, 5)
  assert.equal(requests.length, 5)
  await assert.rejects(
    client.readAddressActivities([{ chainId, scope, address, historyPageCount: 11 }]),
    /page count/
  )
})

test('a failed older page does not count as a successful partial history load', async () => {
  const client = createEvmAnkrHistoryClient(
    'https://history.example/',
    [chain],
    async (_, init) => {
      const request = JSON.parse(init.body)
      if (request.method === 'ankr_getTokenTransfers') return response({ transfers: [] })
      if (request.params.pageToken) return new Response('', { status: 503 })
      return response({ transactions: [transaction(1)], nextPageToken: 'native-2' })
    }
  )
  const result = (
    await client.readAddressActivities([{ chainId, scope, address, historyPageCount: 2 }])
  ).get(chainId)
  assert.ok('error' in result)
})

test('loaded older EVM rows survive incremental refresh and a later source failure', async () => {
  let saved = null
  let now = 1_000
  let calls = 0
  const cache = {
    read: async () => saved,
    write: async record => {
      saved = record
    }
  }
  const items = Array.from(
    { length: 68 },
    (_, index) =>
      mapEvmIndexedActivity({
        request: { scope, address },
        chainId,
        nativeAssetId: chain.nativeAssetId,
        normalTransactions: [
          {
            transactionHash: hash(index + 1),
            blockHash: hash(500),
            blockHeight: 100 + index,
            confirmations: 1,
            from: address,
            to: recipient,
            valueRaw: '1',
            gasPriceRaw: '1',
            gasUsed: '21000',
            nonce: String(index + 1),
            timestamp: 1_700_000_000_000 + index,
            failed: false
          }
        ],
        tokenTransfers: [],
        sourcePartial: false
      })[0]
  )
  const source = createCachedEvmActivityHistorySource({
    chainId,
    cache,
    now: () => now,
    successTtlMs: 1_000,
    source: {
      readAddressActivity: async () => [],
      readAddressActivityWithMetadata: async input => {
        calls++
        if (calls === 3) throw new Error('offline')
        return calls === 1 ? { items, hasMore: false } : { items: [items[0]], hasMore: true }
      },
      findConfirmedReplacement: async () => null
    }
  })

  assert.equal(
    (await source.readAddressActivity({ scope, address, historyPageCount: 2 })).length,
    68
  )
  assert.equal(saved.historyPageCount, 2)
  assert.equal(saved.hasMore, false)
  now = 3_000
  assert.equal((await source.readAddressActivity({ scope, address })).length, 68)
  assert.equal(saved.hasMore, false)
  now = 5_000
  assert.equal((await source.readAddressActivity({ scope, address })).length, 68)
  assert.equal(saved.items.length, 68)
  assert.equal(saved.hasMore, false)
})

test('explicit older-page failure keeps the cached cursor and reports an error', async () => {
  const item = mapEvmIndexedActivity({
    request: { scope, address },
    chainId,
    nativeAssetId: chain.nativeAssetId,
    normalTransactions: [
      {
        transactionHash: hash(99),
        blockHash: hash(500),
        blockHeight: 100,
        confirmations: 1,
        from: address,
        to: recipient,
        valueRaw: '1',
        gasPriceRaw: '1',
        gasUsed: '21000',
        nonce: '1',
        timestamp: 1_700_000_000_000,
        failed: false
      }
    ],
    tokenTransfers: [],
    sourcePartial: true
  })[0]
  let saved = {
    schemaVersion: 1,
    chainId,
    address,
    scope,
    lastAttemptAt: 1_000,
    successfulSyncAt: 1_000,
    retryAfter: 2_000,
    hasMore: true,
    historyPageCount: 1,
    items: [item]
  }
  const source = createCachedEvmActivityHistorySource({
    chainId,
    now: () => 3_000,
    cache: {
      read: async () => saved,
      write: async record => {
        saved = record
      }
    },
    source: {
      readAddressActivity: async () => {
        throw new Error('offline')
      },
      findConfirmedReplacement: async () => null
    }
  })
  await assert.rejects(
    source.readAddressActivity({ scope, address, historyPageCount: 2 }),
    /offline/
  )
  assert.deepEqual(
    saved.items.map(value => value.id),
    [item.id]
  )
  assert.equal(saved.hasMore, true)
  assert.equal(saved.historyPageCount, 1)
})

test('a shallow refresh cannot overwrite a concurrent deeper history load', async () => {
  let releaseShallow
  const shallowGate = new Promise(resolve => {
    releaseShallow = resolve
  })
  let saved = {
    schemaVersion: 1,
    chainId,
    address,
    scope,
    lastAttemptAt: 1_000,
    successfulSyncAt: 1_000,
    retryAfter: 2_000,
    hasMore: true,
    historyPageCount: 1,
    items: []
  }
  const source = createCachedEvmActivityHistorySource({
    chainId,
    now: () => 3_000,
    cache: {
      read: async () => saved,
      write: async record => {
        saved = record
      }
    },
    source: {
      readAddressActivity: async () => [],
      readAddressActivityWithMetadata: async input => {
        if ((input.historyPageCount ?? 1) === 1) {
          await shallowGate
          return { items: [], hasMore: true }
        }
        return { items: [], hasMore: false }
      },
      findConfirmedReplacement: async () => null
    }
  })
  const shallow = source.readAddressActivity({ scope, address })
  const deep = source.readAddressActivity({ scope, address, historyPageCount: 2 })
  releaseShallow()
  await Promise.all([shallow, deep])
  assert.equal(saved.historyPageCount, 2)
  assert.equal(saved.hasMore, false)
})

test('cache write keeps deeper cursor state through shallow refresh and stale failed retry', () => {
  const record = (lastAttemptAt, successfulSyncAt, historySyncAt, historyPageCount, hasMore) => ({
    schemaVersion: 1,
    chainId,
    address,
    scope,
    lastAttemptAt,
    successfulSyncAt,
    historySyncAt,
    historyPageCount,
    hasMore,
    retryAfter: lastAttemptAt + 1_000,
    items: []
  })
  const deep = record(200, 200, 200, 2, false)
  const afterShallow = mergeEvmHistoryCacheRecords(deep, record(300, 300, 300, 1, true))
  assert.equal(afterShallow.historyPageCount, 2)
  assert.equal(afterShallow.hasMore, false)
  assert.equal(afterShallow.historySyncAt, 200)
  assert.equal(afterShallow.successfulSyncAt, 300)

  const afterFailedRetry = mergeEvmHistoryCacheRecords(afterShallow, record(350, 100, 100, 2, true))
  assert.equal(afterFailedRetry.lastAttemptAt, 350)
  assert.equal(afterFailedRetry.retryAfter, 1_350)
  assert.equal(afterFailedRetry.historyPageCount, 2)
  assert.equal(afterFailedRetry.hasMore, false)
  assert.equal(afterFailedRetry.historySyncAt, 200)

  const afterNewDeepScan = mergeEvmHistoryCacheRecords(
    afterFailedRetry,
    record(250, 250, 250, 2, true)
  )
  assert.equal(afterNewDeepScan.historyPageCount, 2)
  assert.equal(afterNewDeepScan.hasMore, true)
  assert.equal(afterNewDeepScan.historySyncAt, 250)
  assert.equal(afterNewDeepScan.lastAttemptAt, 350)
})

test('Activity history depth is bounded at the extension message boundary', () => {
  const message = {
    type: 'GET_ACTIVITY',
    action: 'refresh',
    executionMode: 'all',
    chainIds: [chainId],
    historyPageCount: 2
  }
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
  for (const invalid of [0, 11, 1.5, '2']) {
    assert.throws(() =>
      parseTrustedExtensionRuntimeMessage({ ...message, historyPageCount: invalid })
    )
  }
})
