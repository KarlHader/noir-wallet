import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  filterTrackedEvmTokenActivity,
  isUntrackedEvmTokenActivity,
  isZeroValueEvmTokenActivity,
  mapEvmIndexedActivity
} from '../../../../src/infrastructure/chains/evm/evm-indexed-activity.ts'
import {
  createCachedEvmActivityHistorySource,
  createCachedEvmAnkrHistoryBatchSource,
  createCachedOnlyEvmActivityHistorySource
} from '../../../../src/infrastructure/chains/evm/evm-cached-history-source.ts'

const chainId = 'eip155:42161'
const address = `0x${'1'.repeat(40)}`
const recipient = `0x${'2'.repeat(40)}`
const tokenContract = `0x${'3'.repeat(40)}`
const nativeAssetId = `${chainId}/slip44:60`
const tokenAssetId = `${chainId}/erc20:${tokenContract}`
const scope = {
  keyDomainId: 'keydomain_zero-token-activity',
  accountId: 'account_zero-token-activity'
}
const hash = digit => `0x${digit.repeat(64)}`

function transaction(digit, overrides = {}) {
  return {
    transactionHash: hash(digit),
    blockHash: hash('a'),
    blockHeight: 100,
    confirmations: 2,
    from: address,
    to: tokenContract,
    valueRaw: '0',
    gasPriceRaw: '1',
    gasUsed: '21000',
    nonce: '1',
    timestamp: 1_000,
    failed: false,
    input: '0x12345678',
    ...overrides
  }
}

function tokenTransfer(digit, amountRaw, overrides = {}) {
  return {
    transactionHash: hash(digit),
    blockHash: hash('a'),
    blockHeight: 100,
    confirmations: 2,
    from: address,
    to: recipient,
    amountRaw,
    nonce: '1',
    timestamp: 1_000,
    assetId: tokenAssetId,
    ...overrides
  }
}

function map(normalTransactions, tokenTransfers) {
  return mapEvmIndexedActivity({
    request: { scope, address },
    chainId,
    nativeAssetId,
    normalTransactions,
    tokenTransfers,
    sourcePartial: false
  })
}

function memoryCache(initial) {
  let record = initial
  const writes = []
  return {
    repository: {
      read: async () => record,
      write: async value => {
        writes.push(value)
        record = value
      }
    },
    writes,
    record: () => record
  }
}

function cacheRecord(items) {
  return {
    schemaVersion: 1,
    chainId,
    address,
    scope,
    lastAttemptAt: 1_000,
    successfulSyncAt: 1_000,
    retryAfter: 100_000,
    items
  }
}

test('untracked token-only history cannot impersonate wallet sends in cached activity', () => {
  const tracked = new Set([tokenAssetId])
  const unknownAssetId = `${chainId}/erc20:0x${'4'.repeat(40)}`
  const [unknown] = map([], [tokenTransfer('1', '99', { assetId: unknownAssetId })])
  assert.equal(isUntrackedEvmTokenActivity(unknown, tracked), true)
  const [known] = map([], [tokenTransfer('2', '10')])
  assert.equal(isUntrackedEvmTokenActivity(known, tracked), false)
  const [groupedUnknown] = map(
    [],
    [
      tokenTransfer('3', '99', { assetId: unknownAssetId }),
      tokenTransfer('3', '1', { assetId: unknownAssetId, from: recipient, to: address })
    ]
  )
  assert.equal(isUntrackedEvmTokenActivity(groupedUnknown, tracked), true)
  const [groupedKnown] = map(
    [],
    [tokenTransfer('4', '99', { assetId: unknownAssetId }), tokenTransfer('4', '10')]
  )
  assert.equal(isUntrackedEvmTokenActivity(groupedKnown, tracked), false)
  assert.deepEqual(
    filterTrackedEvmTokenActivity(groupedKnown, tracked).segments[0].evidence.assetEffects.changes,
    [{ assetId: tokenAssetId, amountRaw: '10', direction: 'outgoing' }]
  )
  assert.equal(groupedKnown.segments[0].evidence.assetEffects.changes.length, 2)
  const [contractCall] = map(
    [transaction('5')],
    [tokenTransfer('5', '99', { assetId: unknownAssetId })]
  )
  assert.equal(isUntrackedEvmTokenActivity(contractCall, tracked), false)
  assert.equal(isUntrackedEvmTokenActivity({ ...unknown, source: 'wallet-v2' }, tracked), false)
})

test('zero ERC-20 events do not become asset transfers or mask the outer transaction', () => {
  assert.deepEqual(map([], [tokenTransfer('1', '0')]), [])

  const approveInput = `0x095ea7b3${recipient.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`
  const approve = map([transaction('2', { input: approveInput })], [tokenTransfer('2', '0')])
  assert.equal(approve.length, 1)
  assert.equal(approve[0].kind, 'approve')
  assert.equal(approve[0].snapshot.primaryAmount, undefined)

  const call = map([transaction('3')], [tokenTransfer('3', '0')])
  assert.equal(call.length, 1)
  assert.equal(call[0].kind, 'contract-call')
  assert.equal(call[0].snapshot.primaryAmount, undefined)

  const native = map(
    [transaction('4', { to: recipient, valueRaw: '10', input: '0x' })],
    [tokenTransfer('4', '0')]
  )
  assert.equal(native.length, 1)
  assert.equal(native[0].kind, 'transfer')
  assert.deepEqual(native[0].snapshot.primaryAmount, { assetId: nativeAssetId, amountRaw: '10' })
})

test('a zero token event does not mask a nonzero event in the same transaction', () => {
  const items = map([transaction('5')], [tokenTransfer('5', '0'), tokenTransfer('5', '4404100000')])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'contract-call')
  assert.equal(items[0].snapshot.primaryAmount, undefined)
  assert.deepEqual(items[0].segments[0].evidence.assetEffects.changes, [
    { assetId: tokenAssetId, amountRaw: '4404100000', direction: 'outgoing' }
  ])
})

test('groups multiple token transfers into net asset changes alongside native value', () => {
  const incomingContract = `0x${'4'.repeat(40)}`
  const incomingAssetId = `${chainId}/erc20:${incomingContract}`
  const items = map(
    [transaction('9', { valueRaw: '7' })],
    [
      tokenTransfer('9', '10'),
      tokenTransfer('9', '3', { from: recipient, to: address }),
      tokenTransfer('9', '5', { assetId: incomingAssetId, from: recipient, to: address })
    ]
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'contract-call')
  assert.equal(items[0].snapshot.recipient.address, tokenContract)
  assert.deepEqual(items[0].snapshot.primaryAmount, { assetId: nativeAssetId, amountRaw: '7' })
  assert.deepEqual(items[0].segments[0].evidence.assetEffects.changes, [
    { assetId: tokenAssetId, amountRaw: '7', direction: 'outgoing' },
    { assetId: incomingAssetId, amountRaw: '5', direction: 'incoming' },
    { assetId: nativeAssetId, amountRaw: '7', direction: 'outgoing' }
  ])
  assert.equal(
    map([transaction('a', { failed: true })], [tokenTransfer('a', '9')])[0].segments[0].evidence
      .assetEffects,
    undefined
  )
  const inconsistent = map(
    [transaction('c')],
    [tokenTransfer('c', '9', { blockHash: hash('d'), blockHeight: 101 })]
  )[0]
  assert.equal(inconsistent.completeness, 'partial')
  assert.equal(inconsistent.segments[0].evidence.assetEffects, undefined)
})

test('token-only grouped effects do not invent a contract recipient', () => {
  const items = map(
    [],
    [tokenTransfer('b', '10'), tokenTransfer('b', '5', { from: recipient, to: address })]
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].snapshot.sender, undefined)
  assert.equal(items[0].snapshot.recipient, undefined)
  assert.deepEqual(items[0].segments[0].evidence.assetEffects.changes, [
    { assetId: tokenAssetId, amountRaw: '5', direction: 'outgoing' }
  ])
  const conflicting = map(
    [],
    [
      tokenTransfer('e', '1', { blockHash: undefined }),
      tokenTransfer('e', '2', { blockHash: hash('1') }),
      tokenTransfer('e', '3', { blockHash: hash('2') })
    ]
  )[0]
  assert.equal(conflicting.completeness, 'partial')
  assert.equal(conflicting.segments[0].evidence.assetEffects, undefined)
})

test('cached zero RPC token transfers are removed without affecting other activity', async () => {
  const zero = map([], [tokenTransfer('6', '1')])[0]
  const oldZero = {
    ...zero,
    snapshot: { ...zero.snapshot, primaryAmount: { assetId: tokenAssetId, amountRaw: '0' } }
  }
  const nonzero = map([], [tokenTransfer('7', '1000000')])[0]
  const approveInput = `0x095ea7b3${recipient.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`
  const approve = map([transaction('8', { input: approveInput })], [tokenTransfer('8', '0')])[0]
  const localPending = { ...oldZero, id: 'local:pending', source: 'wallet-v2', status: 'broadcast' }
  assert.equal(isZeroValueEvmTokenActivity(oldZero), true)
  assert.equal(isZeroValueEvmTokenActivity(localPending), false)
  assert.equal(isZeroValueEvmTokenActivity(nonzero), false)

  const cache = memoryCache(cacheRecord([oldZero, nonzero, approve]))
  const cachedOnly = createCachedOnlyEvmActivityHistorySource({ chainId, cache: cache.repository })
  const cached = await cachedOnly.readAddressActivity({ scope, address })
  assert.deepEqual(
    cached.map(item => item.id),
    [nonzero.id, approve.id]
  )
  assert.deepEqual(
    cache.record().items.map(item => item.id),
    [nonzero.id, approve.id]
  )

  const fallbackCache = memoryCache({
    ...cacheRecord([oldZero, nonzero, approve]),
    retryAfter: 1_500
  })
  const cachedSource = createCachedEvmActivityHistorySource({
    chainId,
    cache: fallbackCache.repository,
    now: () => 2_000,
    source: {
      readAddressActivity: async () => {
        throw new Error('offline')
      },
      findConfirmedReplacement: async () => null
    }
  })
  assert.deepEqual(
    (await cachedSource.readAddressActivity({ scope, address })).map(item => item.id),
    [nonzero.id, approve.id]
  )

  const batchCache = memoryCache({
    ...cacheRecord([oldZero, nonzero, approve]),
    retryAfter: 1_500
  })
  const batch = createCachedEvmAnkrHistoryBatchSource({
    cache: batchCache.repository,
    now: () => 2_000,
    source: {
      readAddressActivities: async () => {
        throw new Error('offline')
      }
    }
  })
  const result = await batch.readAddressActivities([{ chainId, address, scope }])
  assert.deepEqual(
    result.get(chainId).map(item => item.id),
    [nonzero.id, approve.id]
  )
})
