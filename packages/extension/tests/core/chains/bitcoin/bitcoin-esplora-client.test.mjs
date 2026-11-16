import { test } from 'node:test'
import { expect } from '@playwright/test'
import { Transaction } from 'bitcoinjs-lib'

import {
  BitcoinRpcError,
  createBitcoinEsploraClient
} from '../../../../src/infrastructure/chains/bitcoin/bitcoin-esplora-client.ts'

const MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const TXID = 'a'.repeat(64)
const BLOCK_HASH = 'b'.repeat(64)

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

function stats(txCount, fundedCount = 0, fundedSum = 0, spentCount = 0, spentSum = 0) {
  return {
    tx_count: txCount,
    funded_txo_count: fundedCount,
    funded_txo_sum: fundedSum,
    spent_txo_count: spentCount,
    spent_txo_sum: spentSum
  }
}

function historyOutput(value, address = ADDRESS) {
  return {
    scriptpubkey: `0014${'1'.repeat(40)}`,
    scriptpubkey_asm: `OP_0 OP_PUSHBYTES_20 ${'1'.repeat(40)}`,
    scriptpubkey_type: 'v0_p2wpkh',
    scriptpubkey_address: address,
    value
  }
}

function historyTransaction(overrides = {}) {
  return {
    txid: TXID,
    version: 2,
    locktime: 900_000,
    size: 140,
    weight: 560,
    fee: 250,
    vin: [
      {
        txid: 'c'.repeat(64),
        vout: 0,
        prevout: historyOutput(1_250),
        scriptsig: '',
        scriptsig_asm: '',
        witness: ['01'],
        is_coinbase: false,
        sequence: 0xfffffffd
      }
    ],
    vout: [historyOutput(1_000)],
    status: {
      confirmed: true,
      block_height: 899_999,
      block_hash: BLOCK_HASH,
      block_time: 1_700_000_000
    },
    ...overrides
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function expectRpcError(error, code) {
  expect(error).toBeInstanceOf(BitcoinRpcError)
  expect(error.code).toBe(code)
}

test.describe('Bitcoin Esplora client', () => {
  test('keeps arbitrary endpoint construction out of the product adapter surface', async () => {
    const productAdapter = await import('../../../../src/infrastructure/chains/bitcoin/index.ts')

    expect(typeof productAdapter.createConfiguredBitcoinEsploraClient).toBe('function')
    expect(productAdapter).not.toHaveProperty('createBitcoinEsploraClient')
    expect(productAdapter).not.toHaveProperty('createBitcoinEsploraFailoverClient')
    expect(typeof productAdapter.BitcoinGapLimitScanner).toBe('function')
  })

  test('attests the expected chain from the complete genesis hash', async () => {
    const transport = scriptedFetch([() => new Response(`\n${MAINNET_GENESIS}\n`)])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      transport.fetch
    )

    await client.assertExpectedChain()

    expect(transport.requests[0].url).toBe('https://bitcoin.example/api/block-height/0')
    expect(transport.requests[0].init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
  })

  test('reads address activity, tip height, and bounded UTXOs', async () => {
    const transport = scriptedFetch([
      () => new Response('900000'),
      () =>
        jsonResponse({
          address: ADDRESS,
          chain_stats: stats(2, 2, 1200, 1, 400),
          mempool_stats: stats(1, 1, 300, 0, 0)
        }),
      () =>
        jsonResponse([
          {
            txid: TXID,
            vout: 1,
            value: 800,
            status: {
              confirmed: true,
              block_height: 899999,
              block_hash: BLOCK_HASH,
              block_time: 1_700_000_000
            }
          },
          {
            txid: 'c'.repeat(64),
            vout: 0,
            value: 300,
            status: { confirmed: false }
          }
        ])
    ])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api/' },
      transport.fetch
    )

    await expect(client.getTipHeight()).resolves.toBe(900000)
    await expect(client.getAddressActivity(ADDRESS)).resolves.toEqual({
      confirmedTransactionCount: 2,
      mempoolTransactionCount: 1,
      used: true
    })
    await expect(client.getAddressUtxos(ADDRESS)).resolves.toEqual([
      {
        transactionId: TXID,
        outputIndex: 1,
        valueRaw: '800',
        status: {
          confirmed: true,
          blockHeight: 899999,
          blockHash: BLOCK_HASH,
          blockTime: 1_700_000_000
        }
      },
      {
        transactionId: 'c'.repeat(64),
        outputIndex: 0,
        valueRaw: '300',
        status: { confirmed: false }
      }
    ])
  })

  test('reads fee estimates, broadcasts raw transactions, and monitors status', async () => {
    const transport = scriptedFetch([
      () => jsonResponse({ 1: 12.5, 6: 3.25, 144: 1.01 }),
      (_url, init) => {
        expect(init.body).toBe('02000000')
        expect(init.headers).toEqual({ 'Content-Type': 'text/plain' })
        return new Response(TXID)
      },
      () =>
        jsonResponse({
          confirmed: true,
          block_height: 900000,
          block_hash: BLOCK_HASH,
          block_time: 1_700_000_001
        }),
      () =>
        jsonResponse({
          spent: true,
          txid: 'c'.repeat(64),
          vin: 1,
          status: {
            confirmed: true,
            block_height: 900000,
            block_hash: BLOCK_HASH,
            block_time: 1_700_000_001
          }
        })
    ])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      transport.fetch
    )

    await expect(client.getFeeEstimates()).resolves.toEqual({
      1: 12.5,
      6: 3.25,
      144: 1.01
    })
    await expect(client.broadcastRawTransaction('02000000')).resolves.toBe(TXID)
    await expect(client.getTransactionStatus(TXID)).resolves.toEqual({
      confirmed: true,
      blockHeight: 900000,
      blockHash: BLOCK_HASH,
      blockTime: 1_700_000_001
    })
    await expect(client.getOutputSpendStatus(TXID, 2)).resolves.toEqual({
      spent: true,
      spendingTransactionId: 'c'.repeat(64),
      inputIndex: 1,
      status: {
        confirmed: true,
        blockHeight: 900000,
        blockHash: BLOCK_HASH,
        blockTime: 1_700_000_001
      }
    })
    expect(transport.requests.map(request => [request.init.method, request.url])).toEqual([
      ['GET', 'https://bitcoin.example/api/fee-estimates'],
      ['POST', 'https://bitcoin.example/api/tx'],
      ['GET', `https://bitcoin.example/api/tx/${TXID}/status`],
      ['GET', `https://bitcoin.example/api/tx/${TXID}/outspend/2`]
    ])
  })

  test('fails closed for incomplete output-spend evidence', async () => {
    const incomplete = scriptedFetch([
      () => jsonResponse({ spent: true, txid: 'c'.repeat(64), vin: 0 })
    ])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      incomplete.fetch
    )

    expectRpcError(await captureError(client.getOutputSpendStatus(TXID, 0)), 'invalid-response')
  })

  test('loads a bounded raw transaction and verifies its transaction ID', async () => {
    const transaction = new Transaction()
    transaction.version = 2
    transaction.addInput(Buffer.alloc(32), 0xffffffff)
    transaction.addOutput(Buffer.from('0014' + '1'.repeat(40), 'hex'), 1_000)
    const rawTransactionHex = transaction.toHex()
    const transactionId = transaction.getId()
    const transport = scriptedFetch([() => new Response(rawTransactionHex)])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      transport.fetch
    )

    await expect(client.getRawTransaction(transactionId)).resolves.toBe(rawTransactionHex)
    expect(transport.requests[0].url).toBe(`https://bitcoin.example/api/tx/${transactionId}/hex`)

    const mismatched = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      async () => new Response(rawTransactionHex)
    )
    expectRpcError(await captureError(mismatched.getRawTransaction(TXID)), 'invalid-response')
  })

  test('reads and strictly validates the bounded Esplora address history page', async () => {
    const transport = scriptedFetch([() => jsonResponse([historyTransaction({ sigops: 1 })])])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      transport.fetch
    )

    await expect(client.getAddressTransactions(ADDRESS)).resolves.toEqual([
      {
        transactionId: TXID,
        feeRaw: '250',
        inputs: [
          {
            coinbase: false,
            previousOutput: { address: ADDRESS, valueRaw: '1250' }
          }
        ],
        outputs: [{ address: ADDRESS, valueRaw: '1000' }],
        status: {
          confirmed: true,
          blockHeight: 899_999,
          blockHash: BLOCK_HASH,
          blockTime: 1_700_000_000
        }
      }
    ])
    expect(transport.requests[0].url).toBe(`https://bitcoin.example/api/address/${ADDRESS}/txs`)

    const malformed = scriptedFetch([
      () => jsonResponse([{ ...historyTransaction(), unexpected: true }])
    ])
    const malformedClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      malformed.fetch
    )
    expectRpcError(
      await captureError(malformedClient.getAddressTransactions(ADDRESS)),
      'invalid-response'
    )

    const invalidAccounting = scriptedFetch([
      () => jsonResponse([historyTransaction({ fee: 249 })])
    ])
    const invalidAccountingClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      invalidAccounting.fetch
    )
    expectRpcError(
      await captureError(invalidAccountingClient.getAddressTransactions(ADDRESS)),
      'invalid-response'
    )
  })

  test('rejects a wrong chain, malformed responses, and HTTP failures', async () => {
    const wrongChain = scriptedFetch([() => new Response(MAINNET_GENESIS)])
    const wrongChainClient = createBitcoinEsploraClient(
      { chainId: TESTNET, baseUrl: 'https://bitcoin.example/testnet/api' },
      wrongChain.fetch
    )
    expectRpcError(await captureError(wrongChainClient.assertExpectedChain()), 'chain-mismatch')

    const malformed = scriptedFetch([
      () =>
        jsonResponse({
          address: ADDRESS,
          chain_stats: stats(0),
          mempool_stats: { ...stats(0), unexpected: true }
        })
    ])
    const malformedClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      malformed.fetch
    )
    expectRpcError(
      await captureError(malformedClient.getAddressActivity(ADDRESS)),
      'invalid-response'
    )

    for (const [status, code] of [
      [404, 'not-found'],
      [429, 'rate-limited'],
      [503, 'network-unavailable']
    ]) {
      const failed = scriptedFetch([() => new Response('', { status })])
      const failedClient = createBitcoinEsploraClient(
        { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
        failed.fetch
      )
      expectRpcError(await captureError(failedClient.getTipHeight()), code)
    }

    const limited = scriptedFetch([
      () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })
    ])
    const limitedClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      limited.fetch
    )
    const limitedError = await captureError(limitedClient.getTipHeight())
    expectRpcError(limitedError, 'rate-limited')
    expect(limitedError.retryAfterMs).toBe(120_000)
  })

  test('bounds responses and distinguishes cancellation from timeout', async () => {
    const oversized = scriptedFetch([() => new Response('1'.repeat(2_000))])
    const oversizedClient = createBitcoinEsploraClient(
      {
        chainId: MAINNET,
        baseUrl: 'https://bitcoin.example/api',
        maximumResponseBytes: 1_024
      },
      oversized.fetch
    )
    expectRpcError(await captureError(oversizedClient.getTipHeight()), 'invalid-response')

    const waitForAbort = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        )
      })
    const controller = new AbortController()
    const cancelledClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      waitForAbort
    )
    const cancelled = cancelledClient.getTipHeight(controller.signal)
    controller.abort()
    expectRpcError(await captureError(cancelled), 'cancelled')

    const timeoutClient = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api', timeoutMs: 1 },
      waitForAbort
    )
    expectRpcError(await captureError(timeoutClient.getTipHeight()), 'timeout')
  })

  test('rejects untrusted endpoints, unsupported chains, and invalid public inputs', async () => {
    expect(() =>
      createBitcoinEsploraClient({ chainId: MAINNET, baseUrl: 'http://bitcoin.example/api' })
    ).toThrow(/credential-free HTTPS/)
    expect(() =>
      createBitcoinEsploraClient({
        chainId: MAINNET,
        baseUrl: 'https://bitcoin.example/api?token=secret'
      })
    ).toThrow(/credential-free HTTPS/)
    expect(() =>
      createBitcoinEsploraClient({
        chainId: 'bip122:00000000da84f2bafbbc53dee25a72ae',
        baseUrl: 'https://bitcoin.example/api'
      })
    ).toThrow(/Invalid Bitcoin chain ID/)

    const transport = scriptedFetch([])
    const client = createBitcoinEsploraClient(
      { chainId: MAINNET, baseUrl: 'https://bitcoin.example/api' },
      transport.fetch
    )
    await expect(client.getAddressActivity('tb1qinvalid')).rejects.toThrow(
      /Invalid Bitcoin address/
    )
    await expect(client.getAddressActivity(`${ADDRESS.slice(0, -1)}x`)).rejects.toThrow(
      /Invalid Bitcoin address/
    )
    await expect(client.broadcastRawTransaction('0x0200')).rejects.toThrow(
      /Invalid signed Bitcoin transaction/
    )
    expect(transport.requests).toEqual([])
  })
})
