import { test } from 'node:test'
import { expect } from '@playwright/test'

import { getEvmNetworkConfigs } from '../../../../src/config/networks.ts'
import { createEvmBlockscoutHistoryClient } from '../../../../src/infrastructure/chains/evm/evm-blockscout-history-client.ts'
import { createConfiguredEvmActivityHistorySource } from '../../../../src/infrastructure/chains/evm/index.ts'
import { EvmRpcError } from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'

const ADDRESS = `0x${'1'.repeat(40)}`
const OTHER = `0x${'2'.repeat(40)}`
const USDC = `0x${'3'.repeat(40)}`
const NATIVE_ASSET = 'eip155:1/slip44:60'
const USDC_ASSET = `eip155:1/erc20:${USDC}`
const SCOPE = { keyDomainId: 'wallet:history', accountId: 'account:history' }

function hash(character) {
  return `0x${character.repeat(64)}`
}

function normalTransaction(overrides = {}) {
  return {
    blockHash: hash('b'),
    blockNumber: '100',
    confirmations: '5',
    from: ADDRESS,
    gasPrice: '1000000000',
    gasUsed: '21000',
    hash: hash('a'),
    isError: '0',
    nonce: '7',
    timeStamp: '1700000000',
    to: OTHER,
    txreceipt_status: '1',
    value: '100',
    ...overrides
  }
}

function tokenTransfer(overrides = {}) {
  return {
    blockHash: hash('c'),
    blockNumber: '101',
    confirmations: '4',
    contractAddress: USDC,
    from: OTHER,
    hash: hash('d'),
    nonce: '8',
    timeStamp: '1700000010',
    to: ADDRESS,
    tokenDecimal: '6',
    value: '5000000',
    ...overrides
  }
}

function jsonResponse(result, init = {}) {
  const { noirPartial, ...responseInit } = init
  return new Response(
    JSON.stringify({ status: '1', message: 'OK', result, ...(noirPartial ? { noirPartial } : {}) }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...responseInit
    }
  )
}

function createClient(fetchImplementation, overrides = {}) {
  return createEvmBlockscoutHistoryClient(
    {
      chainId: 'eip155:1',
      apiUrl: 'https://eth.blockscout.example/api/',
      nativeAssetId: NATIVE_ASSET,
      trackedErc20Assets: [{ assetId: USDC_ASSET, contract: USDC, decimals: 6 }],
      readFinalizedBlockNumber: async () => '101',
      ...overrides
    },
    fetchImplementation
  )
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

test.describe('EVM Blockscout history client', () => {
  test('does not route Ankr-supported chains through Blockscout when the Ankr origin is absent', () => {
    const sources = getEvmNetworkConfigs('mainnet').map(config => ({
      chainId: config.chainId,
      source: createConfiguredEvmActivityHistorySource('mainnet', config)
    }))

    expect(
      sources.filter(({ source }) => source !== undefined).map(({ chainId }) => chainId)
    ).toEqual([])
  })

  test('keeps arbitrary endpoint construction out of the product adapter surface', async () => {
    const productAdapter = await import('../../../../src/infrastructure/chains/evm/index.ts')

    expect(typeof productAdapter.createConfiguredEvmActivityHistorySource).toBe('function')
    expect(productAdapter).not.toHaveProperty('createEvmBlockscoutHistoryClient')
  })

  test('maps confirmed native and ERC-20 activity through credential-free bounded requests', async () => {
    const requests = []
    const fetchImplementation = async (input, init) => {
      const url = new URL(input)
      requests.push({ url, init })
      if (url.searchParams.get('action') === 'txlist') {
        return jsonResponse([
          normalTransaction(),
          normalTransaction({
            blockHash: hash('f'),
            blockNumber: '102',
            confirmations: '3',
            hash: hash('f'),
            input: `0x095ea7b3${'0'.repeat(24)}${OTHER.slice(2)}${'0'.repeat(63)}1`,
            nonce: '9',
            timeStamp: '1700000020',
            to: USDC,
            value: '0'
          })
        ])
      }
      return jsonResponse([tokenTransfer()])
    }
    const client = createClient(fetchImplementation)

    await expect(
      client.readAddressActivity({ scope: SCOPE, address: ADDRESS, fromBlock: 90 })
    ).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('f')}:native`,
        kind: 'approve',
        status: 'final',
        snapshot: expect.objectContaining({ direction: 'contract' })
      }),
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('d')}:token`,
        source: 'rpc',
        status: 'final',
        completeness: 'complete',
        snapshot: expect.objectContaining({
          direction: 'incoming',
          primaryAmount: { assetId: USDC_ASSET, amountRaw: '5000000' }
        }),
        segments: [
          expect.objectContaining({
            evidence: expect.objectContaining({
              transactionHash: hash('d'),
              externalReference: 'evm-nonce:8',
              blockHeight: 101,
              confirmations: 4
            })
          })
        ]
      }),
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('a')}:native`,
        source: 'rpc',
        status: 'final',
        completeness: 'complete',
        snapshot: expect.objectContaining({
          direction: 'outgoing',
          primaryAmount: { assetId: NATIVE_ASSET, amountRaw: '100' }
        })
      })
    ])
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url.origin).toBe('https://eth.blockscout.example')
      expect(request.url.pathname).toBe('/api/')
      expect(request.url.searchParams.get('module')).toBe('account')
      expect(request.url.searchParams.get('address')).toBe(ADDRESS)
      expect(request.url.searchParams.get('page')).toBe('1')
      expect(request.url.searchParams.get('offset')).toBe('200')
      expect(request.url.searchParams.get('sort')).toBe('desc')
      expect(request.url.searchParams.get('startblock')).toBe('90')
      expect(request.init).toMatchObject({
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      })
    }
    expect(requests[1].url.searchParams.get('contractaddress')).toBe(USDC)
  })

  test('rejects untracked ERC-20 transfers returned for a tracked contract request', async () => {
    const unknown = `0x${'4'.repeat(40)}`
    const requests = []
    const client = createClient(async input => {
      const url = new URL(input)
      requests.push(url)
      return url.searchParams.get('action') === 'txlist'
        ? jsonResponse([])
        : jsonResponse([tokenTransfer({ contractAddress: unknown })])
    })
    await expect(
      client.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    ).rejects.toMatchObject({ code: 'invalid-response' })
    const tokenRequests = requests.filter(url => url.searchParams.get('action') === 'tokentx')
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0].searchParams.get('contractaddress')).toBe(USDC)
  })

  test('maps reverted native activity and accepts an exact empty-history envelope', async () => {
    let requestCount = 0
    const client = createClient(async input => {
      requestCount += 1
      if (new URL(input).searchParams.get('action') === 'txlist') {
        return jsonResponse([
          normalTransaction({ hash: hash('e'), isError: '1', txreceipt_status: '0' })
        ])
      }
      return new Response(
        JSON.stringify({ status: '0', message: 'No transactions found', result: [] })
      )
    })

    const items = await client.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    expect(requestCount).toBe(2)
    expect(items).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureCode: 'reverted',
        segments: [expect.objectContaining({ status: 'failed', failureCode: 'reverted' })]
      })
    ])
  })

  test('accepts the exact Blockscout empty token-transfer envelope', async () => {
    const client = createClient(async request => {
      const action = new URL(request).searchParams.get('action')
      return action === 'tokentx'
        ? new Response(
            JSON.stringify({ status: '0', message: 'No token transfers found', result: [] })
          )
        : jsonResponse([])
    })

    expect(await client.readAddressActivity({ scope: SCOPE, address: ADDRESS })).toEqual([])
  })

  test('keeps proxy token transfers without fabricated block hashes or nonces', async () => {
    const client = createClient(async request => {
      const action = new URL(request).searchParams.get('action')
      return action === 'tokentx'
        ? jsonResponse([tokenTransfer({ blockHash: '', nonce: '' })])
        : jsonResponse([])
    })

    const [item] = await client.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    expect(item).toMatchObject({
      id: `rpc:evm:eip155:1:${hash('d')}:token`,
      completeness: 'partial',
      segments: [
        {
          evidence: {
            transactionHash: hash('d'),
            blockHeight: 101,
            confirmations: 4
          }
        }
      ]
    })
    expect(item.segments[0].evidence).not.toHaveProperty('blockHash')
    expect(item.segments[0].evidence).not.toHaveProperty('externalReference')
  })

  test('keeps validated native history as partial when the token branch is unavailable', async () => {
    const client = createClient(async request =>
      new URL(request).searchParams.get('action') === 'txlist'
        ? jsonResponse([normalTransaction()])
        : new Response('', { status: 429 })
    )

    await expect(client.readAddressActivity({ scope: SCOPE, address: ADDRESS })).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('a')}:native`,
        completeness: 'partial'
      })
    ])
  })

  test('keeps a paginated native history response partial', async () => {
    const client = createClient(async request =>
      new URL(request).searchParams.get('action') === 'txlist'
        ? jsonResponse([normalTransaction()], { noirPartial: true })
        : jsonResponse([])
    )

    await expect(client.readAddressActivity({ scope: SCOPE, address: ADDRESS })).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('a')}:native`,
        completeness: 'partial'
      })
    ])
  })

  test('fails instead of caching an empty success when an empty history has a failed branch', async () => {
    const client = createClient(async request =>
      new URL(request).searchParams.get('action') === 'txlist'
        ? jsonResponse([])
        : new Response('', { status: 429 })
    )

    await expect(
      client.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    ).rejects.toMatchObject({ code: 'rate-limited' })
  })

  test('marks bounded token scans as partial and rejects an incomplete empty result', async () => {
    const partialClient = createClient(async request =>
      new URL(request).searchParams.get('action') === 'txlist'
        ? jsonResponse([normalTransaction()])
        : jsonResponse([tokenTransfer()], { noirPartial: true })
    )
    await expect(
      partialClient.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    ).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('d')}:token`,
        completeness: 'partial'
      }),
      expect.objectContaining({
        id: `rpc:evm:eip155:1:${hash('a')}:native`,
        completeness: 'partial'
      })
    ])

    const emptyPartialClient = createClient(async request =>
      new URL(request).searchParams.get('action') === 'txlist'
        ? jsonResponse([])
        : jsonResponse([], { noirPartial: true })
    )
    await expect(
      emptyPartialClient.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('uses indexed receipt status without waiting for the RPC finalized boundary', async () => {
    const client = createClient(
      async input =>
        new URL(input).searchParams.get('action') === 'txlist'
          ? jsonResponse([
              normalTransaction({ blockNumber: '102', confirmations: '0' }),
              normalTransaction({
                blockNumber: '103',
                confirmations: '0',
                hash: hash('e'),
                isError: '1',
                txreceipt_status: '0'
              })
            ])
          : jsonResponse([]),
      { readFinalizedBlockNumber: async () => '101' }
    )

    const items = await client.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    expect(items).toEqual([
      expect.objectContaining({ status: 'final' }),
      expect.objectContaining({ status: 'failed', failureCode: 'reverted' })
    ])
  })

  test('finds a mined different hash with the same sender and nonce as a replacement', async () => {
    const excluded = hash('a')
    const replacement = hash('f')
    const client = createClient(async input => {
      expect(new URL(input).searchParams.get('action')).toBe('txlist')
      return jsonResponse([
        normalTransaction({ hash: excluded, nonce: '9' }),
        normalTransaction({
          blockHash: hash('9'),
          blockNumber: '105',
          hash: replacement,
          nonce: '9',
          timeStamp: '1700000020'
        })
      ])
    })

    await expect(
      client.findConfirmedReplacement({
        sender: ADDRESS,
        nonce: '9',
        excludedTransactionHash: excluded
      })
    ).resolves.toEqual({
      transactionHash: replacement,
      blockHash: hash('9'),
      blockHeight: 105,
      confirmedAt: 1_700_000_020_000
    })
  })

  test('rejects rate limits, malformed cross-address data, and caller cancellation', async () => {
    const rateLimited = createClient(async () => new Response('', { status: 429 }))
    const rateLimitError = await captureError(
      rateLimited.readAddressActivity({ scope: SCOPE, address: ADDRESS })
    )
    expect(rateLimitError).toBeInstanceOf(EvmRpcError)
    expect(rateLimitError.code).toBe('rate-limited')

    const malformed = createClient(async input =>
      new URL(input).searchParams.get('action') === 'txlist'
        ? jsonResponse([normalTransaction({ from: OTHER, to: USDC })])
        : jsonResponse([])
    )
    await expect(malformed.readAddressActivity({ scope: SCOPE, address: ADDRESS })).rejects.toThrow(
      /does not involve/
    )

    const controller = new AbortController()
    controller.abort()
    const cancelled = createClient(async () => jsonResponse([]))
    const cancelledError = await captureError(
      cancelled.readAddressActivity({ scope: SCOPE, address: ADDRESS, signal: controller.signal })
    )
    expect(cancelledError).toBeInstanceOf(EvmRpcError)
    expect(cancelledError.code).toBe('cancelled')
  })
})
