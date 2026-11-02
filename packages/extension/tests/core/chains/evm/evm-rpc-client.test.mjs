import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  EvmRpcError,
  createEvmRpcClient
} from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

function rpcResponse(request, body, init = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }), {
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
      const request = JSON.parse(init.body)
      requests.push({ url, init, request })
      const handler = handlers[index]
      index += 1
      if (!handler) throw new Error('Unexpected request')
      return handler(request, init)
    }
  }
}

function expectRpcError(error, code) {
  expect(error).toBeInstanceOf(EvmRpcError)
  expect(error.code).toBe(code)
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

test.describe('EVM RPC client', () => {
  test('keeps arbitrary endpoint construction out of the product adapter surface', async () => {
    const productAdapter = await import('../../../../src/infrastructure/chains/evm/index.ts')

    expect(typeof productAdapter.createConfiguredEvmRpcClient).toBe('function')
    expect(productAdapter).not.toHaveProperty('createEvmRpcClient')
  })

  test('probes chain ID and reads native and ERC-20 balances with fixed methods', async () => {
    const transport = scriptedFetch([
      request => rpcResponse(request, { result: '0x1' }),
      request => rpcResponse(request, { result: '0xde0b6b3a7640000' }),
      request => rpcResponse(request, { result: `0x${'0'.repeat(61)}3e8` })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    await client.assertExpectedChain()
    await expect(client.getNativeBalance(ADDRESS)).resolves.toBe('1000000000000000000')
    await expect(client.getErc20Balance(USDC, ADDRESS)).resolves.toBe('1000')

    expect(transport.requests.map(item => item.request.method)).toEqual([
      'eth_chainId',
      'eth_getBalance',
      'eth_call'
    ])
    expect(transport.requests[1].request.params).toEqual([ADDRESS, 'latest'])
    expect(transport.requests[2].request.params).toEqual([
      {
        to: USDC,
        data: `0x70a08231${ADDRESS.slice(2).padStart(64, '0')}`
      },
      'latest'
    ])
    expect(transport.requests[0].init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
  })

  test('forwards allowlisted dApp reads with positional or named params', async () => {
    const transport = scriptedFetch([
      request => rpcResponse(request, { result: '0x2a' }),
      request => rpcResponse(request, { result: '0x1234' })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    await expect(client.requestDAppRead('eth_blockNumber', [])).resolves.toBe('0x2a')
    await expect(client.requestDAppRead('eth_call', { to: ADDRESS, data: '0x' })).resolves.toBe(
      '0x1234'
    )
    expect(transport.requests.map(item => item.request)).toMatchObject([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_call', params: { to: ADDRESS, data: '0x' } }
    ])
  })

  test('retains validated JSON-RPC errors for the EIP-1193 boundary', async () => {
    const transport = scriptedFetch([
      request =>
        rpcResponse(request, {
          error: { code: -32602, message: 'invalid block parameter' }
        })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    const error = await captureError(client.requestDAppRead('eth_getBalance', []))
    expect(error).toMatchObject({
      code: 'rpc-error',
      rpcCode: -32602,
      rpcMessage: 'invalid block parameter',
      rpcMethod: 'eth_getBalance'
    })
  })

  test('reads contract code and fixed-call data without exposing arbitrary RPC methods', async () => {
    const transport = scriptedFetch([
      request => rpcResponse(request, { result: '0x6001600055' }),
      request => rpcResponse(request, { result: `0x${'0'.repeat(63)}6` })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    await expect(client.getCode(USDC)).resolves.toBe('0x6001600055')
    await expect(client.callContract(USDC, '0x313ce567')).resolves.toBe(`0x${'0'.repeat(63)}6`)
    expect(transport.requests.map(item => [item.request.method, item.request.params])).toEqual([
      ['eth_getCode', [USDC, 'latest']],
      ['eth_call', [{ to: USDC, data: '0x313ce567' }, 'latest']]
    ])
  })

  test('forwards only bounded dApp read calls and block tags', async () => {
    const transport = scriptedFetch([
      request => rpcResponse(request, { result: '0xabcdef' }),
      request => rpcResponse(request, { result: '0x9' })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    await expect(
      client.call(
        {
          from: ADDRESS,
          to: USDC,
          valueRaw: '1',
          data: '0x12345678'
        },
        'latest'
      )
    ).resolves.toBe('0xabcdef')
    await expect(client.getTransactionCount(ADDRESS, 'latest')).resolves.toBe('9')

    expect(transport.requests.map(item => [item.request.method, item.request.params])).toEqual([
      [
        'eth_call',
        [
          {
            from: ADDRESS,
            to: USDC,
            value: '0x1',
            data: '0x12345678'
          },
          'latest'
        ]
      ],
      ['eth_getTransactionCount', [ADDRESS, 'latest']]
    ])
  })

  test('uses pending state and canonical quantities for transaction preflight', async () => {
    const transport = scriptedFetch([
      request => rpcResponse(request, { result: '0x2a' }),
      request => rpcResponse(request, { result: '0x' }),
      request => rpcResponse(request, { result: '0x5208' }),
      request => rpcResponse(request, { result: '0x3b9aca00' }),
      request =>
        rpcResponse(request, {
          result: { number: '0x10', baseFeePerGas: '0x77359400', ignored: 'bounded' }
        })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )
    const call = { from: ADDRESS, to: USDC, valueRaw: '0', data: '0xa9059cbb' }

    await expect(client.getPendingNonce(ADDRESS)).resolves.toBe('42')
    await expect(client.simulateCall(call)).resolves.toBe('0x')
    await expect(client.estimateGas(call)).resolves.toBe('21000')
    await expect(client.getMaximumPriorityFeePerGas()).resolves.toBe('1000000000')
    await expect(client.getLatestBlockFee()).resolves.toEqual({
      blockNumber: '16',
      baseFeePerGas: '2000000000'
    })

    expect(transport.requests.map(item => [item.request.method, item.request.params])).toEqual([
      ['eth_getTransactionCount', [ADDRESS, 'pending']],
      ['eth_call', [{ from: ADDRESS, to: USDC, value: '0x0', data: '0xa9059cbb' }, 'pending']],
      ['eth_estimateGas', [{ from: ADDRESS, to: USDC, value: '0x0', data: '0xa9059cbb' }]],
      ['eth_maxPriorityFeePerGas', []],
      ['eth_getBlockByNumber', ['latest', false]]
    ])
  })

  test('validates broadcast hashes, receipts, and finalized block evidence', async () => {
    const transactionHash = `0x${'a'.repeat(64)}`
    const blockHash = `0x${'b'.repeat(64)}`
    const transferLog = {
      address: USDC.toUpperCase().replace('0X', '0x'),
      topics: [`0x${'d'.repeat(64)}`],
      data: '0x0001',
      transactionHash
    }
    const transport = scriptedFetch([
      request =>
        rpcResponse(request, { result: transactionHash.toUpperCase().replace('0X', '0x') }),
      request =>
        rpcResponse(request, {
          result: {
            transactionHash,
            blockHash,
            blockNumber: '0x64',
            status: '0x1',
            logs: [transferLog]
          }
        }),
      request => rpcResponse(request, { result: null }),
      request =>
        rpcResponse(request, {
          result: {
            hash: transactionHash,
            nonce: '0x0',
            blockHash: null,
            blockNumber: null
          }
        }),
      request => rpcResponse(request, { result: null }),
      request =>
        rpcResponse(request, {
          result: {
            hash: transactionHash,
            blockHash,
            blockNumber: '0x64'
          }
        }),
      request => rpcResponse(request, { result: { number: '0x63' } })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    await expect(client.broadcastRawTransaction('0x02')).resolves.toBe(transactionHash)
    await expect(client.getTransactionReceipt(transactionHash)).resolves.toEqual({
      transactionHash,
      blockHash,
      blockNumber: '100',
      status: 'success',
      logs: [{ address: USDC, topics: transferLog.topics, data: transferLog.data }]
    })
    await expect(client.getTransactionReceipt(transactionHash)).resolves.toBeNull()
    await expect(client.hasTransaction(transactionHash)).resolves.toBe(true)
    await expect(client.hasTransaction(transactionHash)).resolves.toBe(false)
    await expect(client.getTransactionLocation(transactionHash)).resolves.toEqual({
      status: 'included',
      blockHash,
      blockNumber: '100'
    })
    await expect(client.getFinalizedBlockNumber()).resolves.toBe('99')
    expect(transport.requests.map(item => [item.request.method, item.request.params])).toEqual([
      ['eth_sendRawTransaction', ['0x02']],
      ['eth_getTransactionReceipt', [transactionHash]],
      ['eth_getTransactionReceipt', [transactionHash]],
      ['eth_getTransactionByHash', [transactionHash]],
      ['eth_getTransactionByHash', [transactionHash]],
      ['eth_getTransactionByHash', [transactionHash]],
      ['eth_getBlockByNumber', ['finalized', false]]
    ])
  })

  test('rejects a partially populated transaction inclusion', async () => {
    const transactionHash = `0x${'a'.repeat(64)}`
    const transport = scriptedFetch([
      request =>
        rpcResponse(request, {
          result: {
            hash: transactionHash,
            blockHash: `0x${'b'.repeat(64)}`,
            blockNumber: null
          }
        })
    ])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )

    expectRpcError(
      await captureError(client.getTransactionLocation(transactionHash)),
      'invalid-response'
    )
  })

  test('rejects the wrong chain and non-canonical quantities', async () => {
    const wrongChain = scriptedFetch([request => rpcResponse(request, { result: '0xaa36a7' })])
    const wrongChainClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      wrongChain.fetch
    )
    expectRpcError(await captureError(wrongChainClient.assertExpectedChain()), 'chain-mismatch')

    const malformed = scriptedFetch([request => rpcResponse(request, { result: '0x00' })])
    const malformedClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      malformed.fetch
    )
    expectRpcError(
      await captureError(malformedClient.getNativeBalance(ADDRESS)),
      'invalid-response'
    )
  })

  test('rejects malformed envelopes, oversized responses, and rate limits', async () => {
    const invalidEnvelope = scriptedFetch([
      request =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1', extra: 1 }))
    ])
    const invalidClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      invalidEnvelope.fetch
    )
    expectRpcError(await captureError(invalidClient.assertExpectedChain()), 'invalid-response')

    const oversized = scriptedFetch([
      request => rpcResponse(request, { result: `0x${'1'.repeat(2_000)}` })
    ])
    const oversizedClient = createEvmRpcClient(
      {
        chainId: 'eip155:1',
        rpcUrl: 'https://ethereum.example',
        maximumResponseBytes: 1_024
      },
      oversized.fetch
    )
    expectRpcError(await captureError(oversizedClient.assertExpectedChain()), 'invalid-response')

    const limited = scriptedFetch([() => new Response('', { status: 429 })])
    const limitedClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      limited.fetch
    )
    expectRpcError(await captureError(limitedClient.assertExpectedChain()), 'rate-limited')
  })

  test('distinguishes caller cancellation from timeout', async () => {
    const waitForAbort = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        )
      })
    const controller = new AbortController()
    const cancelledClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      waitForAbort
    )
    const pending = cancelledClient.assertExpectedChain(controller.signal)
    controller.abort()
    expectRpcError(await captureError(pending), 'cancelled')

    const timeoutClient = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example', timeoutMs: 1 },
      waitForAbort
    )
    expectRpcError(await captureError(timeoutClient.assertExpectedChain()), 'timeout')
  })

  test('rejects untrusted endpoint shapes and invalid public inputs', async () => {
    expect(() =>
      createEvmRpcClient({ chainId: 'eip155:1', rpcUrl: 'http://ethereum.example' })
    ).toThrow(/credential-free HTTPS/)
    expect(() =>
      createEvmRpcClient({ chainId: 'eip155:1', rpcUrl: 'https://ethereum.example?token=secret' })
    ).toThrow(/credential-free HTTPS/)
    expect(() =>
      createEvmRpcClient({ chainId: 'bip122:abc', rpcUrl: 'https://ethereum.example' })
    ).toThrow(/Invalid EVM chain ID/)

    const transport = scriptedFetch([])
    const client = createEvmRpcClient(
      { chainId: 'eip155:1', rpcUrl: 'https://ethereum.example' },
      transport.fetch
    )
    await expect(client.getNativeBalance('0x1234')).rejects.toThrow(/Invalid EVM address/)
    expect(transport.requests).toEqual([])
  })
})
