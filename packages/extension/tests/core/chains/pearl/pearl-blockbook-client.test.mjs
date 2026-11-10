import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  PearlRpcError,
  createPearlBlockbookClient
} from '../../../../src/infrastructure/chains/pearl/index.ts'

const MAINNET = parseChainId('bip122:a18d3093b7ff618f0cdd073fa3d10374').id
const TESTNET = parseChainId('bip122:b0c86d0cd8825f4d72260d2de46f4704').id
const ADDRESS = 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const TXID = 'a'.repeat(64)

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

function scriptedFetch(handlers, requests = []) {
  let index = 0
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init })
      const handler = handlers[index]
      index += 1
      if (!handler) throw new Error('Unexpected request')
      return handler(url, init)
    }
  }
}

test('asserts Pearl mainnet Blockbook coin and chain identity', async () => {
  const scripted = scriptedFetch([
    () =>
      jsonResponse({
        blockbook: { coin: 'Pearl' },
        backend: { chain: 'mainnet', blocks: 12, bestBlockHash: 'b'.repeat(64) }
      })
  ])
  const client = createPearlBlockbookClient(
    {
      chainId: MAINNET,
      baseUrl: 'https://blockbook.pearlresearch.ai/api/v2'
    },
    scripted.fetch
  )
  await client.assertExpectedChain()
  expect(scripted.requests).toHaveLength(1)
})

test('asserts Pearl testnet genesis CAIP reference and rejects mismatched coin', async () => {
  const ok = scriptedFetch([
    () =>
      jsonResponse({
        blockbook: { coin: 'Pearl Testnet2' },
        backend: {
          chain: 'testnet2',
          blocks: 3,
          bestBlockHash: 'b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96'
        }
      })
  ])
  await createPearlBlockbookClient(
    {
      chainId: TESTNET,
      baseUrl: 'https://blockbook.testnet.pearlresearch.ai/api/v2'
    },
    ok.fetch
  ).assertExpectedChain()

  const mismatch = scriptedFetch([
    () =>
      jsonResponse({
        blockbook: { coin: 'Bitcoin' },
        backend: { chain: 'testnet', blocks: 3, bestBlockHash: 'c'.repeat(64) }
      })
  ])
  await expect(
    createPearlBlockbookClient(
      {
        chainId: TESTNET,
        baseUrl: 'https://blockbook.testnet.pearlresearch.ai/api/v2'
      },
      mismatch.fetch
    ).assertExpectedChain()
  ).rejects.toMatchObject({ code: 'chain-mismatch' })
})

test('reads Pearl tip height, address activity, and fee estimates from Blockbook', async () => {
  const scripted = scriptedFetch([
    () =>
      jsonResponse({
        blockbook: { coin: 'Pearl' },
        backend: { chain: 'mainnet', blocks: 42, bestBlockHash: 'd'.repeat(64) }
      }),
    () =>
      jsonResponse({
        txs: 2,
        unconfirmedTxs: 1,
        balance: '1500'
      }),
    () => jsonResponse({ result: '0.00002' }),
    () => jsonResponse({ result: '0.000015' }),
    () => jsonResponse({ result: '0.00001' })
  ])
  const client = createPearlBlockbookClient(
    {
      chainId: MAINNET,
      baseUrl: 'https://blockbook.pearlresearch.ai/api/v2'
    },
    scripted.fetch
  )
  expect(await client.getTipHeight()).toBe(42)
  expect(await client.getAddressActivity(ADDRESS)).toEqual({
    confirmedTransactionCount: 2,
    mempoolTransactionCount: 1,
    used: true,
    balanceSats: '1500'
  })
  const fees = await client.getFeeEstimates()
  expect(fees['1']).toBeGreaterThanOrEqual(1)
  expect(fees['6']).toBeGreaterThanOrEqual(1)
})

test('rejects invalid Pearl Blockbook fee payloads', async () => {
  const scripted = scriptedFetch([() => jsonResponse({ result: -1 })])
  const client = createPearlBlockbookClient(
    {
      chainId: MAINNET,
      baseUrl: 'https://blockbook.pearlresearch.ai/api/v2'
    },
    scripted.fetch
  )
  await expect(client.getFeeEstimates()).rejects.toBeInstanceOf(PearlRpcError)
  expect(TXID).toHaveLength(64)
})

test('reads confirmed spends for reserved outpoints from address history', async () => {
  const scripted = scriptedFetch([
    () =>
      jsonResponse({
        transactions: [
          {
            txid: 'c'.repeat(64),
            confirmations: 4,
            blockHash: 'b'.repeat(64),
            blockHeight: 120,
            vin: [
              { txid: TXID, vout: 1, n: 0 },
              { n: 1, coinbase: true }
            ],
            vout: [{ value: '10', n: 0 }]
          },
          {
            txid: 'd'.repeat(64),
            confirmations: 0,
            vin: [{ txid: TXID, vout: 2, n: 0 }],
            vout: [{ value: '10', n: 0 }]
          }
        ]
      })
  ])
  const client = createPearlBlockbookClient(
    { chainId: MAINNET, baseUrl: 'https://blockbook.pearlresearch.ai/api/v2' },
    scripted.fetch
  )
  const spends = await client.getAddressSpends(ADDRESS)
  expect(spends).toEqual([
    {
      transactionId: 'c'.repeat(64),
      spentOutpoints: [`${TXID}:1`],
      confirmations: 4,
      blockHash: 'b'.repeat(64),
      blockHeight: 120
    }
  ])
})

test('broadcasts Pearl transactions by POST and accepts Blockbook txid shapes', async () => {
  const raw = '02' + 'ab'.repeat(50)
  const scripted = scriptedFetch([
    () => new Response(`"${'A'.repeat(64)}"`, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => jsonResponse({ result: 'b'.repeat(64) }),
    () => jsonResponse({ error: 'txn-mempool-conflict' })
  ])
  const client = createPearlBlockbookClient(
    { chainId: TESTNET, baseUrl: 'https://blockbook.testnet.pearlresearch.ai/api/v2' },
    scripted.fetch
  )

  await expect(client.broadcastRawTransaction(raw)).resolves.toBe('a'.repeat(64))
  expect(scripted.requests[0]).toMatchObject({
    url: 'https://blockbook.testnet.pearlresearch.ai/api/v2/sendtx/',
    init: expect.objectContaining({
      method: 'POST',
      body: raw.toLowerCase()
    })
  })
  await expect(client.broadcastRawTransaction(raw)).resolves.toBe('b'.repeat(64))
  await expect(client.broadcastRawTransaction(raw)).rejects.toMatchObject({
    code: 'invalid-response',
    message: expect.stringContaining('txn-mempool-conflict')
  })
})
