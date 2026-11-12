import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertStarknetExecutionTransaction,
  dedupStarknetActivityEvents,
  inflateStarknetFeeEstimate,
  mapStarknetReceiptStatus,
  mergeStarknetU256,
  resolveStarknetMaxAmount,
  splitStarknetU256,
  starknetBoundsMaxFee,
  STARKNET_EXECUTION_VERSION,
  STARKNET_QUERY_VERSION
} from '../../../../src/infrastructure/chains/starknet/starknet-primitives.ts'
import { parseAccountId } from '../../../../src/core/accounts/domain/account.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/key-domain.ts'
import {
  broadcastConfirmedStarknetInvoke,
  normalizeStarknetSessionPreparePayload
} from '../../../../src/infrastructure/chains/starknet/starknet-session-broadcast.ts'
import {
  createStarknetActivityHistorySource,
  parseTransferEvent
} from '../../../../src/infrastructure/chains/starknet/starknet-activity-history-source.ts'

test('merges a Starknet u256 from low and high felts', () => {
  const merged = mergeStarknetU256(1n, 2n)
  assert.equal(merged, 1n + (2n << 128n))
  assert.deepEqual(splitStarknetU256(merged), { low: 1n, high: 2n })
  assert.throws(() => mergeStarknetU256(1n << 128n, 0n))
})

test('inflates resource bounds and prices the max fee', () => {
  const bounds = inflateStarknetFeeEstimate({
    l1GasConsumed: 2n,
    l1GasPrice: 10n,
    l2GasConsumed: 3n,
    l2GasPrice: 4n,
    l1DataGasConsumed: 0n,
    l1DataGasPrice: 7n,
    overallFee: 1n
  })
  assert.equal(bounds.l1Gas.maxAmount, '3')
  assert.equal(bounds.l1Gas.maxPricePerUnit, '20')
  assert.equal(bounds.l2Gas.maxAmount, '5')
  assert.equal(bounds.l2Gas.maxPricePerUnit, '8')
  assert.equal(bounds.l1DataGas.maxAmount, '0')
  assert.equal(starknetBoundsMaxFee(bounds), 3n * 20n + 5n * 8n)
})

test('reserves deploy and invoke max fees from STRK and leaves other tokens intact', () => {
  assert.equal(
    resolveStarknetMaxAmount({
      tokenBalance: 100n,
      strkBalance: 100n,
      invokeMaxFee: 15n,
      deployMaxFee: 10n,
      feeToken: true
    }),
    75n
  )
  assert.equal(
    resolveStarknetMaxAmount({
      tokenBalance: 40n,
      strkBalance: 20n,
      invokeMaxFee: 25n,
      feeToken: true
    }),
    0n
  )
  assert.equal(
    resolveStarknetMaxAmount({
      tokenBalance: 80n,
      strkBalance: 30n,
      invokeMaxFee: 12n,
      deployMaxFee: 8n,
      feeToken: false
    }),
    80n
  )
  assert.equal(
    resolveStarknetMaxAmount({
      tokenBalance: 80n,
      strkBalance: 19n,
      invokeMaxFee: 12n,
      deployMaxFee: 8n,
      feeToken: false
    }),
    null
  )
})

test('maps Starknet receipt status without treating a reverted fee as success', () => {
  assert.equal(
    mapStarknetReceiptStatus({ found: true, finality: 'ACCEPTED_ON_L2', execution: 'SUCCEEDED' }),
    'success'
  )
  assert.equal(
    mapStarknetReceiptStatus({ found: true, finality: 'ACCEPTED_ON_L2', execution: 'REVERTED' }),
    'failed'
  )
  assert.equal(mapStarknetReceiptStatus({ found: false, timedOut: true }), 'dropped')
  assert.equal(mapStarknetReceiptStatus({ found: false, timedOut: false }), 'pending')
  assert.equal(
    mapStarknetReceiptStatus({ found: true, finality: 'PRE_CONFIRMED', execution: 'SUCCEEDED' }),
    'pending'
  )
})

test('deduplicates activity by chain, account, transaction, and event index', () => {
  const first = { chainId: 'starknet:SN_SEPOLIA', account: '0x1', txHash: '0x2', eventIndex: '3', amount: 1n }
  const duplicate = { ...first, amount: 9n }
  const other = { ...first, eventIndex: '4' }
  const unique = dedupStarknetActivityEvents([first, duplicate, other])
  assert.equal(unique.length, 2)
  assert.equal(unique[0]?.amount, 1n)
  assert.equal(unique[1]?.eventIndex, '4')
})

test('refuses to broadcast a query transaction', () => {
  assert.throws(() => assertStarknetExecutionTransaction({ version: STARKNET_QUERY_VERSION }))
  assert.doesNotThrow(() => assertStarknetExecutionTransaction({ version: STARKNET_EXECUTION_VERSION }))
})

test('parses indexed and legacy Transfer events once per direction', () => {
  const account = '0x11'
  const other = '0x22'
  const indexed = parseTransferEvent(
    {
      fromAddress: '0x33',
      keys: [
        '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9',
        account,
        other
      ],
      data: ['0x5', '0x0'],
      blockNumber: 8,
      transactionHash: '0x44',
      eventIndex: '1'
    },
    account,
    'starknet:SN_SEPOLIA/snip2:0x33',
    'starknet:SN_SEPOLIA'
  )
  const legacy = parseTransferEvent(
    {
      fromAddress: '0x33',
      keys: ['0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9'],
      data: [other, account, '0x7', '0x0'],
      blockNumber: 9,
      transactionHash: '0x45',
      eventIndex: '2'
    },
    account,
    'starknet:SN_SEPOLIA/snip2:0x33',
    'starknet:SN_SEPOLIA'
  )
  assert.equal(indexed?.amount, 5n)
  assert.equal(indexed?.from, account)
  assert.equal(legacy?.to, account)
  assert.equal(legacy?.amount, 7n)
  assert.equal(
    dedupStarknetActivityEvents([indexed, indexed].filter(event => event !== null)).length,
    1
  )
})

test('stringifies object typed data before the session signer prepares it', () => {
  const typedData = {
    types: { Message: [{ name: 'contents', type: 'shortstring' }] },
    primaryType: 'Message',
    domain: { name: 'Noir', version: '1', chainId: 'SN_SEPOLIA', revision: '1' },
    message: { contents: 'Hello' }
  }
  const normalized = normalizeStarknetSessionPreparePayload({
    kind: 'starknet-typed-data',
    chainId: 'starknet:SN_SEPOLIA',
    typedData
  })
  assert.equal(normalized.typedData, JSON.stringify(typedData))
  const encoded = '{"types":{}}'
  assert.equal(
    normalizeStarknetSessionPreparePayload({ kind: 'starknet-typed-data', typedData: encoded }).typedData,
    encoded
  )
  const invoke = { kind: 'starknet-invoke', calls: [] }
  assert.equal(normalizeStarknetSessionPreparePayload(invoke), invoke)
  assert.throws(() =>
    normalizeStarknetSessionPreparePayload({ kind: 'starknet-typed-data', typedData: 1 })
  )
})

test('broadcasts a software invoke and returns only the node hash', async () => {
  const calls = []
  const rpc = {
    async addInvokeTransaction(transaction) {
      calls.push(transaction)
      return '0xabc'
    }
  }
  const signed = {
    kind: 'signed-payload',
    transactionId: '0xabc',
    payload: { encoding: 'utf8', value: JSON.stringify({ version: '0x3', type: 'invoke' }) }
  }
  const result = await broadcastConfirmedStarknetInvoke(signed, rpc)
  assert.equal(result.transactionHash, '0xabc')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].version, '0x3')
  await assert.rejects(() =>
    broadcastConfirmedStarknetInvoke(signed, {
      async addInvokeTransaction() {
        return '0xdef'
      }
    })
  )
  await assert.rejects(() =>
    broadcastConfirmedStarknetInvoke(signed, {
      async addInvokeTransaction() {
        throw new Error('Starknet RPC request failed')
      }
    })
  )
})

test('refuses a software invoke that is not execution version 3', async () => {
  let called = false
  await assert.rejects(() =>
    broadcastConfirmedStarknetInvoke(
      {
        kind: 'signed-payload',
        transactionId: '0xabc',
        payload: { encoding: 'utf8', value: JSON.stringify({ version: '0x1' }) }
      },
      {
        async addInvokeTransaction() {
          called = true
          return '0xabc'
        }
      }
    )
  )
  assert.equal(called, false)
})

test('uses the block timestamp instead of the block number', async () => {
  const account = '0x11'
  const assetId = 'starknet:SN_SEPOLIA/snip2:0x1'
  const source = createStarknetActivityHistorySource({
    chainId: 'starknet:SN_SEPOLIA',
    tokens: [{ reference: '0x1', assetId }],
    rpc: {
      async getEvents() {
        return {
          events: [
            {
              fromAddress: '0x1',
              keys: [
                '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9',
                account,
                '0x22'
              ],
              data: ['0x5', '0x0'],
              blockNumber: 12,
              transactionHash: '0xabc',
              eventIndex: '1'
            }
          ]
        }
      },
      async getBlockTimestamp(blockNumber) {
        assert.equal(blockNumber, 12)
        return 1_700_000_000
      }
    },
    cursors: memoryCursors()
  })
  const pendingCreatedAt = 1_711_000_000_000
  const items = await source.readAddressActivity({
    scope: { keyDomainId: parseKeyDomainId('domain-1'), accountId: parseAccountId('account-1') },
    address: account,
    localPending: [
      {
        transactionId: 'transaction:starknet:pending-1',
        status: 'pending',
        sender: account,
        recipient: '0x22',
        assetId,
        feeAssetId: assetId,
        amountRaw: '1',
        maxFeeRaw: '1',
        invokeHash: '0x999',
        deployHash: null,
        createdAt: pendingCreatedAt
      }
    ]
  })
  const chainItem = items.find(item => item.source === 'rpc')
  const pendingItem = items.find(item => item.source === 'wallet-v2')
  assert.equal(chainItem?.createdAt, 1_700_000_000_000)
  assert.notEqual(chainItem?.createdAt, 12)
  assert.equal(chainItem?.updatedAt, 1_700_000_000_000)
  assert.equal(pendingItem?.createdAt, pendingCreatedAt)
})

test('matches a padded pending sender to the normalized account', async () => {
  const source = createStarknetActivityHistorySource({
    chainId: 'starknet:SN_SEPOLIA',
    tokens: [{ reference: '0x1', assetId: 'starknet:SN_SEPOLIA/snip2:0x1' }],
    rpc: {
      async getEvents() {
        return { events: [] }
      },
      async getBlockTimestamp() {
        return 1_700_000_000
      }
    },
    cursors: memoryCursors()
  })
  const items = await source.readAddressActivity({
    scope: { keyDomainId: parseKeyDomainId('domain-1'), accountId: parseAccountId('account-1') },
    address: '0x11',
    localPending: [
      {
        transactionId: 'transaction:starknet:pending-padded',
        status: 'pending',
        sender: '0x011',
        recipient: '0x022',
        assetId: 'starknet:SN_SEPOLIA/snip2:0x1',
        feeAssetId: 'starknet:SN_SEPOLIA/snip2:0x1',
        amountRaw: '1',
        maxFeeRaw: '1',
        invokeHash: '0x999',
        deployHash: null,
        createdAt: 1_711_000_000_000
      }
    ]
  })
  assert.equal(items.length, 1)
  assert.equal(items[0]?.snapshot?.direction, 'outgoing')
  assert.equal(items[0]?.snapshot?.sender?.address, '0x11')
  assert.equal(items[0]?.snapshot?.recipient?.address, '0x22')
})

test('keeps earlier token transfers when the cursor is already at a later block', async () => {
  const account = '0x11'
  const strk = 'starknet:SN_SEPOLIA/snip2:0x1'
  const usdc = 'starknet:SN_SEPOLIA/snip2:0x2'
  const selector = '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9'
  let scanned = false
  const source = createStarknetActivityHistorySource({
    chainId: 'starknet:SN_SEPOLIA',
    tokens: [
      { reference: '0x1', assetId: strk },
      { reference: '0x2', assetId: usdc }
    ],
    rpc: {
      async getEvents(filter) {
        if (scanned) return { events: [] }
        if (filter.address === '0x1') {
          return {
            events: [
              {
                fromAddress: '0x1',
                keys: [selector, account, '0x22'],
                data: ['0x5', '0x0'],
                blockNumber: 20,
                transactionHash: '0xaaa',
                eventIndex: '1'
              }
            ]
          }
        }
        return {
          events: [
            {
              fromAddress: '0x2',
              keys: [selector],
              data: [account, '0x22', '0x7', '0x0'],
              blockNumber: 4,
              transactionHash: '0xbbb',
              eventIndex: '1'
            }
          ]
        }
      },
      async getBlockTimestamp(blockNumber) {
        return blockNumber === 4 ? 1_700_000_000 : 1_700_000_100
      }
    },
    cursors: memoryCursors()
  })
  const scope = { keyDomainId: parseKeyDomainId('domain-1'), accountId: parseAccountId('account-1') }
  const first = await source.readAddressActivity({ scope, address: account })
  scanned = true
  const second = await source.readAddressActivity({ scope, address: account })
  for (const items of [first, second]) {
    const assetIds = items.map(item => item.snapshot.primaryAmount.assetId).sort()
    assert.deepEqual(assetIds, [strk, usdc])
  }
  assert.equal(second.find(item => item.snapshot.primaryAmount.assetId === usdc)?.createdAt, 1_700_000_000_000)
  assert.equal(second.find(item => item.snapshot.primaryAmount.assetId === strk)?.createdAt, 1_700_000_100_000)
  assert.notEqual(second.find(item => item.snapshot.primaryAmount.assetId === usdc)?.createdAt, 4)
})

function memoryCursors() {
  const values = new Map()
  return {
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, cursor) {
      values.set(key, cursor)
    }
  }
}
