import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evmHistoryWorker } from '../../../../../evm-history-worker/src/index.ts'

const WALLET = `0x${'a'.repeat(40)}`
const OTHER = `0x${'b'.repeat(40)}`
const HASH = `0x${'c'.repeat(64)}`
const API_KEY = 'test-alchemy-key'
const env = {
  ALCHEMY_API_KEY: API_KEY,
  ALLOWED_ORIGIN: '*',
  HISTORY_RATE_LIMITER: { limit: async () => ({ success: true }) }
}

function history(params = {}, bindings = env) {
  const request = new Request('https://history.example/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'noir_getNativeInternalTransfers',
      params: {
        blockchain: ['base'],
        address: WALLET,
        pageSize: 2,
        descOrder: true,
        fromBlock: 8,
        ...params
      }
    })
  })
  return evmHistoryWorker.fetch(request, bindings)
}

function transfer(trace, blockNum, from, to) {
  return {
    category: 'internal',
    blockNum,
    hash: HASH,
    from,
    to,
    uniqueId: `${HASH}:internal:${trace}`,
    value: 0,
    rawContract: { value: '0x0200000000000001', address: null, decimal: '0x12' },
    metadata: { blockTimestamp: '2026-11-21T00:00:00Z' }
  }
}

function rpc(result) {
  return Response.json({ jsonrpc: '2.0', id: 1, result })
}

test('merges paired Base cursors without dropping same-transaction traces or emitting a self transfer twice', async ({
  mock
}) => {
  const self = transfer('0', '0x10', WALLET, WALLET)
  let tipReads = 0
  let outgoingReads = 0
  let incomingReads = 0
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `https://base-mainnet.g.alchemy.com/v2/${API_KEY}`)
    assert.equal(init.redirect, 'manual')
    const { method, params } = JSON.parse(init.body)
    if (method === 'eth_blockNumber') {
      tipReads += 1
      return rpc('0x000010')
    }
    assert.equal(method, 'alchemy_getAssetTransfers')
    const [query] = params
    assert.deepEqual(query.category, ['internal'])
    assert.equal(query.toBlock, '0x10')
    assert.equal(query.fromBlock, '0x8')
    assert.equal(query.order, 'desc')
    assert.equal(query.withMetadata, true)
    assert.equal(query.excludeZeroValue, true)
    assert.equal(query.maxCount, '0x2')
    if (query.fromAddress) {
      assert.equal(query.fromAddress, WALLET)
      assert.equal(query.toAddress, undefined)
      if (query.pageKey) {
        assert.equal(query.pageKey, 'outgoing-2')
        return rpc({ transfers: [transfer('4', '0x09', WALLET, OTHER)], pageKey: '' })
      }
      outgoingReads += 1
      return rpc({
        transfers: [self, transfer('1', '0x0b', WALLET, OTHER)],
        pageKey: `outgoing-${outgoingReads}`
      })
    }
    assert.equal(query.toAddress, WALLET)
    if (query.pageKey) {
      assert.equal(query.pageKey, 'incoming-1')
      return rpc({ transfers: [transfer('3', '0x0a', OTHER, WALLET)] })
    }
    incomingReads += 1
    return rpc({
      transfers: [self, transfer('2', '0x0f', OTHER, WALLET)],
      pageKey: `incoming-${incomingReads}`
    })
  })

  const first = await history()
  assert.equal(first.status, 200)
  const { result: firstPage } = await first.json()
  assert.deepEqual(firstPage.transfers, [
    {
      hash: HASH,
      blockNumber: '0x10',
      timestamp: '2026-11-21T00:00:00.000Z',
      from: WALLET,
      to: WALLET,
      value: '0x200000000000001',
      transferId: self.uniqueId
    },
    {
      hash: HASH,
      blockNumber: '0xf',
      timestamp: '2026-11-21T00:00:00.000Z',
      from: OTHER,
      to: WALLET,
      value: '0x200000000000001',
      transferId: `${HASH}:internal:2`
    }
  ])
  assert.match(firstPage.nextPageToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const beforeMismatch = fetchMock.mock.callCount()
  assert.equal((await history({ address: OTHER, pageToken: firstPage.nextPageToken })).status, 400)
  assert.equal(fetchMock.mock.callCount(), beforeMismatch)

  const second = await history({ pageToken: firstPage.nextPageToken })
  assert.equal(second.status, 200)
  const { result: secondPage } = await second.json()
  assert.deepEqual(
    secondPage.transfers.map(item => item.transferId),
    [`${HASH}:internal:1`]
  )
  assert.ok(secondPage.nextPageToken)

  const third = await history({ pageToken: secondPage.nextPageToken })
  assert.equal(third.status, 200)
  const { result: thirdPage } = await third.json()
  assert.deepEqual(
    thirdPage.transfers.map(item => item.transferId),
    [`${HASH}:internal:3`, `${HASH}:internal:4`]
  )
  assert.equal(thirdPage.nextPageToken, undefined)
  assert.equal(tipReads, 1)
})

test('rejects a failed direction or shifted replay page without returning a partial success', async ({
  mock
}) => {
  let mode = 'normal'
  mock.method(console, 'error', () => {})
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, params } = JSON.parse(init.body)
    if (method === 'eth_blockNumber') return rpc('0x10')
    if (params[0].fromAddress) {
      return rpc({
        transfers: [
          transfer('0', '0x10', WALLET, OTHER),
          transfer(mode === 'changed' ? '3' : '1', '0xb', WALLET, OTHER)
        ]
      })
    }
    if (mode === 'failed') return new Response(null, { status: 429 })
    if (mode === 'unresolved') return rpc({ transfers: [transfer('2', '0xf', OTHER, null)] })
    if (params[0].pageKey) return rpc({ transfers: [] })
    return rpc({ transfers: [transfer('2', '0xf', OTHER, WALLET)], pageKey: 'incoming-1' })
  })
  const { result } = await (await history()).json()
  assert.ok(result.nextPageToken)
  for (const [failure, expected] of [
    ['failed', 429],
    ['changed', 502],
    ['unresolved', 502]
  ]) {
    mode = failure
    const response = await history({ pageToken: result.nextPageToken })
    assert.equal(response.status, expected)
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000, message: 'Upstream unavailable' }
    })
  }
})

test('requires a Base-only request, the Worker limiter and a server-side secret before reaching Alchemy', async ({
  mock
}) => {
  mock.method(console, 'error', () => {})
  const fetchMock = mock.method(globalThis, 'fetch', () => rpc('0x10'))
  assert.equal((await history({ blockchain: ['base', 'eth'] })).status, 400)
  assert.equal((await history({ pageSize: 201 })).status, 400)
  assert.equal((await history({ descOrder: false })).status, 400)
  assert.equal((await history({}, { ...env, ALCHEMY_API_KEY: undefined })).status, 503)
  const limited = await history(
    {},
    { ...env, HISTORY_RATE_LIMITER: { limit: async () => ({ success: false }) } }
  )
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('Retry-After'), '60')
  assert.equal(fetchMock.mock.callCount(), 0)
})
