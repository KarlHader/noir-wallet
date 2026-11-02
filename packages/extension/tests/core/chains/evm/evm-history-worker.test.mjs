import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { evmHistoryWorker } from '../../../../../evm-history-worker/src/index.ts'

const ADDRESS = `0x${'1'.repeat(40)}`
const CONTRACT = `0x${'2'.repeat(40)}`
const TRANSACTION_HASH = `0x${'a'.repeat(64)}`
const TOKEN_ICON_SOURCE =
  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2222222222222222222222222222222222222222/logo.png'

function rpcResponse(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

let environmentId = 0

function workerEnv(rateLimitSuccess = true, keys = [`test-key-${++environmentId}`]) {
  return {
    ANKR_API_KEYS: keys.join(','),
    ALLOWED_ORIGIN: '*',
    HISTORY_RATE_LIMITER: {
      limit: async () => ({ success: rateLimitSuccess })
    }
  }
}

const HISTORY_URL = 'https://history.example/'
const BALANCES_URL = `https://history.example/balances?address=${ADDRESS}&chainIds=1`

function rpcInit(method = 'ankr_getTransactionsByAddress', params = {}, id = 7) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        blockchain: ['eth'],
        address: method === 'ankr_getTokenTransfers' ? [ADDRESS] : ADDRESS,
        pageSize: method === 'ankr_getTokenTransfers' ? 2_000 : 200,
        descOrder: true,
        ...params
      }
    })
  }
}

function historyRequest(params = {}, options = {}) {
  return new Request(HISTORY_URL, {
    ...rpcInit('ankr_getTransactionsByAddress', params),
    ...options
  })
}

function tokenHistoryRequest(params = {}, options = {}) {
  return new Request(HISTORY_URL, { ...rpcInit('ankr_getTokenTransfers', params), ...options })
}

function upstreamKey(input) {
  return new URL(String(input)).pathname.split('/').at(-1)
}

function emptyRpcResponse(method) {
  if (method === 'ankr_getAccountBalance') return rpcResponse({ assets: [] })
  if (method === 'ankr_getTokenTransfers') return rpcResponse({ transfers: [] })
  return rpcResponse({ transactions: [] })
}

function rpcError(code, message = 'upstream private detail') {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

test.describe('EVM history Worker', () => {
  test('proxies all routes in the Workers runtime without following upstream redirects', async () => {
    // Use Wrangler's own runtime and bundler so Node fetch mocks cannot hide edge incompatibilities.
    const workerRequire = createRequire(
      new URL('../../../../../evm-history-worker/package.json', import.meta.url)
    )
    const wranglerRequire = createRequire(workerRequire.resolve('wrangler'))
    const {
      Miniflare,
      convertV4MiniflareOptions,
      Response: RuntimeResponse
    } = wranglerRequire('miniflare')
    const { build } = wranglerRequire('esbuild')
    const { outputFiles } = await build({
      entryPoints: [
        fileURLToPath(new URL('../../../../../evm-history-worker/src/index.ts', import.meta.url))
      ],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022'
    })
    const calls = []
    let redirect = false
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: outputFiles[0].text,
        compatibilityDate: '2026-08-01',
        bindings: { ANKR_API_KEYS: 'runtime-test-key', ALLOWED_ORIGIN: '*' },
        ratelimits: {
          HISTORY_RATE_LIMITER: { namespace_id: '1', simple: { limit: 120, period: 60 } }
        },
        outboundService: async request => {
          calls.push(new URL(request.url).hostname)
          if (redirect) {
            return new RuntimeResponse(null, {
              status: 307,
              headers: { Location: 'https://other.example/' }
            })
          }
          if (new URL(request.url).hostname === 'raw.githubusercontent.com') {
            return new RuntimeResponse(new Uint8Array([137, 80, 78, 71]), {
              headers: { 'Content-Type': 'image/png' }
            })
          }
          const { method, params } = await request.json()
          if (params.blockchain.some(chain => !['eth', 'optimism_sepolia'].includes(chain))) {
            return new RuntimeResponse(
              JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602 } })
            )
          }
          if (method === 'ankr_getTransactionsByAddress' && typeof params.address !== 'string') {
            return new RuntimeResponse(
              JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602 } })
            )
          }
          const result =
            method === 'ankr_getAccountBalance'
              ? { assets: [] }
              : method === 'ankr_getTokenTransfers'
                ? { transfers: [] }
                : { transactions: [] }
          return new RuntimeResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
        }
      })
    )
    try {
      for (const [url, init] of [
        [HISTORY_URL, rpcInit()],
        [HISTORY_URL, rpcInit('ankr_getTokenTransfers')],
        [BALANCES_URL],
        [
          HISTORY_URL,
          rpcInit('ankr_getTransactionsByAddress', { blockchain: ['optimism_sepolia'] })
        ],
        [HISTORY_URL, rpcInit('ankr_getTokenTransfers', { blockchain: ['optimism_sepolia'] })],
        [BALANCES_URL.replace('chainIds=1', 'chainIds=1,11155420')]
      ]) {
        const response = await runtime.dispatchFetch(url, init)
        expect(response.status).toBe(200)
        await response.json()
      }
      const iconUrl = `https://history.example/token-icon?source=${encodeURIComponent(TOKEN_ICON_SOURCE)}`
      const icon = await runtime.dispatchFetch(iconUrl)
      expect(icon.status).toBe(200)
      expect(new Uint8Array(await icon.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
      redirect = true
      const response = await runtime.dispatchFetch(HISTORY_URL, rpcInit())
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32000, message: 'Upstream unavailable' }
      })
      expect((await runtime.dispatchFetch(iconUrl)).status).toBe(502)
      expect(calls).toEqual([
        ...Array(6).fill('rpc.ankr.com'),
        'raw.githubusercontent.com',
        'rpc.ankr.com',
        'raw.githubusercontent.com'
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test('forwards one bounded multi-chain history request and preserves the native result', async () => {
    const originalFetch = globalThis.fetch
    let upstreamBody
    const transactions = [
      { hash: TRANSACTION_HASH, blockchain: 'eth', blockNumber: '0x64' },
      { hash: `0x${'b'.repeat(64)}`, blockchain: 'base', blockNumber: '0x65' }
    ]
    globalThis.fetch = async (_input, init) => {
      upstreamBody = JSON.parse(init.body)
      return rpcResponse({ transactions, nextPageToken: 'next-page' })
    }
    try {
      const response = await evmHistoryWorker.fetch(
        historyRequest({
          blockchain: ['eth', 'base'],
          pageSize: 25,
          descOrder: false,
          fromBlock: 42,
          pageToken: 'first-page'
        }),
        workerEnv()
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: { transactions, nextPageToken: 'next-page' }
      })
      expect(upstreamBody).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'ankr_getTransactionsByAddress',
        params: {
          blockchain: ['eth', 'base'],
          address: ADDRESS,
          pageSize: 25,
          descOrder: false,
          fromBlock: 42,
          pageToken: 'first-page'
        }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects unsupported methods, invalid params, and oversized bodies before upstream access', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      throw new Error('Unexpected upstream call')
    }
    try {
      for (const [request, status, code, id] of [
        [new Request(HISTORY_URL, { ...rpcInit('eth_getBalance') }), 400, -32601, 7],
        [historyRequest({ blockchain: ['eth', 'eth'] }), 400, -32602, 7],
        [historyRequest({ blockchain: ['unknown'] }), 400, -32602, 7],
        [historyRequest({ pageSize: 201 }), 400, -32602, 7],
        [historyRequest({ pageToken: 'x'.repeat(513) }), 400, -32602, 7],
        [historyRequest({ fromBlock: -1 }), 400, -32602, 7],
        [tokenHistoryRequest({ address: [ADDRESS, CONTRACT, ADDRESS] }), 400, -32602, 7],
        [tokenHistoryRequest({ pageSize: 2_001 }), 400, -32602, 7],
        [new Request(HISTORY_URL, { ...rpcInit(undefined, {}, {}) }), 400, -32600, null],
        [
          new Request(HISTORY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad'
          }),
          400,
          -32700,
          null
        ],
        [
          new Request(HISTORY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'x'.repeat(16 * 1024 + 1)
          }),
          413,
          -32600,
          null
        ]
      ]) {
        const response = await evmHistoryWorker.fetch(request, workerEnv())
        expect(response.status).toBe(status)
        await expect(response.json()).resolves.toEqual({
          jsonrpc: '2.0',
          id,
          error: { code, message: expect.any(String) }
        })
      }
      const legacy = await evmHistoryWorker.fetch(
        new Request(
          `https://history.example/1/api?module=account&action=txlist&address=${ADDRESS}`
        ),
        workerEnv()
      )
      expect(legacy.status).toBe(404)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('returns an upstream error for malformed history results instead of empty history', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const result of [
        null,
        {},
        { transactions: null },
        { transactions: [{}] },
        {
          transactions: [{ blockchain: 'base' }]
        },
        { transactions: [], nextPageToken: 42 }
      ]) {
        globalThis.fetch = async () => rpcResponse(result)
        const response = await evmHistoryWorker.fetch(historyRequest(), workerEnv())
        expect(response.status).toBe(502)
        await expect(response.json()).resolves.toEqual({
          jsonrpc: '2.0',
          id: 7,
          error: { code: -32000, message: 'Upstream unavailable' }
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects malformed balance results instead of reporting an empty discovery', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const result of [
        null,
        {},
        { assets: null },
        { assets: [{}] },
        { assets: [], nextPageToken: 42 }
      ]) {
        globalThis.fetch = async () => rpcResponse(result)
        const response = await evmHistoryWorker.fetch(new Request(BALANCES_URL), workerEnv())
        expect(response.status).toBe(502)
        await expect(response.json()).resolves.toEqual({ error: 'Upstream unavailable' })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('cancels oversized upstream bodies without buffering the rest of the stream', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const [request, maximumBytes, contentType] of [
        [historyRequest(), 8 * 1024 * 1024, 'application/json'],
        [
          new Request(
            `https://history.example/token-icon?source=${encodeURIComponent(TOKEN_ICON_SOURCE)}`
          ),
          256 * 1024,
          'image/png'
        ]
      ]) {
        let reads = 0
        let cancelled = false
        const chunkBytes = 64 * 1024
        const totalChunks = maximumBytes / chunkBytes + 32
        globalThis.fetch = async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                reads += 1
                controller.enqueue(new Uint8Array(chunkBytes))
                if (reads === totalChunks) controller.close()
              },
              cancel() {
                cancelled = true
              }
            }),
            { headers: { 'Content-Type': contentType } }
          )
        const response = await evmHistoryWorker.fetch(request, workerEnv())
        expect(response.status).toBe(502)
        expect(cancelled).toBe(true)
        expect(reads).toBeLessThan(totalChunks)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('discovers held ERC-20 contracts across supported chains without exposing the Ankr key', async () => {
    const originalFetch = globalThis.fetch
    let upstreamUrl = ''
    let requestBody
    globalThis.fetch = async (input, init) => {
      upstreamUrl = String(input)
      requestBody = JSON.parse(init.body)
      return rpcResponse({
        assets: [
          {
            balanceRawInteger: '2500000',
            blockchain: 'eth',
            contractAddress: CONTRACT.toUpperCase().replace('0X', '0x'),
            tokenDecimals: 6,
            tokenName: 'USD Tether',
            tokenSymbol: 'USDT',
            tokenType: 'ERC20',
            thumbnail: TOKEN_ICON_SOURCE
          },
          {
            balanceRawInteger: '0',
            blockchain: 'base',
            contractAddress: `0x${'3'.repeat(40)}`,
            tokenDecimals: 18,
            tokenName: 'Zero',
            tokenSymbol: 'ZERO',
            tokenType: 'ERC20'
          }
        ]
      })
    }
    try {
      const response = await evmHistoryWorker.fetch(
        new Request(
          `https://history.example/balances?address=${ADDRESS}&chainIds=1,8453,97,100,196`
        ),
        workerEnv()
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        version: 1,
        partial: false,
        assets: [
          {
            chainId: 'eip155:1',
            contractAddress: CONTRACT,
            balanceRawInteger: '2500000',
            metadata: {
              name: 'USD Tether',
              symbol: 'USDT',
              decimals: 6,
              iconUrl: `https://history.example/token-icon?source=${encodeURIComponent(TOKEN_ICON_SOURCE)}`
            }
          }
        ]
      })
      expect(upstreamUrl).toContain('/multichain/test-key')
      expect(requestBody).toEqual({
        jsonrpc: '2.0',
        method: 'ankr_getAccountBalance',
        params: {
          blockchain: ['eth', 'base', 'gnosis', 'xlayer'],
          walletAddress: ADDRESS,
          onlyWhitelisted: false,
          pageSize: 512
        },
        id: 1
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('bounds the combined discovery inventory after filtering and marks overflow partial', async () => {
    const originalFetch = globalThis.fetch
    const assets = Array.from({ length: 513 }, (_, index) => ({
      balanceRawInteger: '1',
      blockchain: index % 2 === 0 ? 'eth' : 'base',
      contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      tokenDecimals: 18,
      tokenName: 'Token',
      tokenSymbol: 'TOK',
      tokenType: 'ERC20'
    }))
    let count = 512
    globalThis.fetch = async () =>
      rpcResponse({
        assets: [{ ...assets[0], balanceRawInteger: '0' }, ...assets.slice(0, count)]
      })
    try {
      for (count of [512, 513]) {
        const response = await evmHistoryWorker.fetch(
          new Request(`${BALANCES_URL},8453`),
          workerEnv()
        )
        expect(response.status).toBe(200)
        const result = await response.json()
        expect(result.assets).toHaveLength(512)
        expect(result.partial).toBe(count > 512)
        expect(new Set(result.assets.map(asset => asset.chainId))).toEqual(
          new Set(['eip155:1', 'eip155:8453'])
        )
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('proxies only trusted token images with bounded cacheable responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async input => {
      expect(String(input)).toBe(TOKEN_ICON_SOURCE)
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '4' }
      })
    }
    try {
      const response = await evmHistoryWorker.fetch(
        new Request(
          `https://history.example/token-icon?source=${encodeURIComponent(TOKEN_ICON_SOURCE)}`
        ),
        workerEnv()
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
      expect(response.headers.get('cache-control')).toContain('max-age=86400')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([137, 80, 78, 71])
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const rejected = await evmHistoryWorker.fetch(
      new Request(
        `https://history.example/token-icon?source=${encodeURIComponent('https://example.com/token.png')}`
      ),
      workerEnv()
    )
    expect(rejected.status).toBe(400)
  })

  test('forwards native token transfers and page tokens without conversion', async () => {
    const originalFetch = globalThis.fetch
    const bodies = []
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      if (body.method === 'ankr_getTokenTransfers') {
        return rpcResponse({
          nextPageToken: 'more',
          transfers: [
            {
              blockHeight: 100,
              blockchain: 'base',
              contractAddress: CONTRACT,
              fromAddress: `0x${'3'.repeat(40)}`,
              timestamp: 1_700_000_000,
              toAddress: ADDRESS,
              tokenDecimals: 6,
              tokenName: 'USD Coin',
              tokenSymbol: 'USDC',
              transactionHash: TRANSACTION_HASH,
              value: '5',
              valueRawInteger: '5000000'
            },
            {
              blockHeight: 99,
              blockchain: 'base',
              contractAddress: `0x${'4'.repeat(40)}`,
              fromAddress: ADDRESS,
              timestamp: 1_699_999_000,
              toAddress: `0x${'5'.repeat(40)}`,
              tokenDecimals: 18,
              tokenName: 'Other',
              tokenSymbol: 'OTHER',
              transactionHash: `0x${'b'.repeat(64)}`,
              value: '1',
              valueRawInteger: '1000000000000000000'
            }
          ]
        })
      }
      throw new Error(`Unexpected Ankr method: ${body.method}`)
    }

    try {
      const response = await evmHistoryWorker.fetch(
        tokenHistoryRequest({ blockchain: ['base'], fromBlock: 90, pageToken: 'previous' }),
        workerEnv()
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: {
          nextPageToken: 'more',
          transfers: [
            expect.objectContaining({
              transactionHash: TRANSACTION_HASH,
              valueRawInteger: '5000000'
            }),
            expect.objectContaining({ transactionHash: `0x${'b'.repeat(64)}` })
          ]
        }
      })
      const tokenRequest = bodies.find(body => body.method === 'ankr_getTokenTransfers')
      expect(tokenRequest.params).toMatchObject({
        address: [ADDRESS],
        blockchain: ['base'],
        pageSize: 2_000,
        descOrder: true,
        fromBlock: 90,
        pageToken: 'previous'
      })
      expect(bodies).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects chains not supported by the current Ankr Advanced API catalog', async () => {
    const response = await evmHistoryWorker.fetch(
      historyRequest({ blockchain: ['bsc_testnet'] }),
      workerEnv()
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32602, message: 'Invalid params' }
    })
  })

  test('maps Ankr connection limits to a retryable HTTP rate limit without leaking details', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32068, message: 'secret' } }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    try {
      const response = await evmHistoryWorker.fetch(historyRequest(), workerEnv())
      expect(response.status).toBe(429)
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32000, message: 'Upstream unavailable' }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects an upstream response that crosses the requested blockchain boundary', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      rpcResponse({
        transfers: [
          {
            blockHeight: 100,
            blockchain: 'eth',
            contractAddress: CONTRACT,
            fromAddress: `0x${'3'.repeat(40)}`,
            timestamp: 1_700_000_000,
            toAddress: ADDRESS,
            tokenDecimals: 6,
            tokenName: 'USD Coin',
            tokenSymbol: 'USDC',
            transactionHash: TRANSACTION_HASH,
            value: '5',
            valueRawInteger: '5000000'
          }
        ]
      })
    try {
      const response = await evmHistoryWorker.fetch(
        tokenHistoryRequest({ blockchain: ['base'] }),
        workerEnv()
      )
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32000, message: 'Upstream unavailable' }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('preserves native transaction hex fields and pagination token', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_input, init) => {
      const { params } = JSON.parse(init.body)
      if (typeof params.address !== 'string') return rpcError(-32602)
      return rpcResponse({
        nextPageToken: 'older-transactions',
        transactions: [
          {
            hash: TRANSACTION_HASH,
            blockHash: `0x${'b'.repeat(64)}`,
            blockNumber: '0x64',
            from: ADDRESS,
            to: `0x${'3'.repeat(40)}`,
            value: '0x1',
            gas: '0x5208',
            gasPrice: '0x1',
            gasUsed: '0x5208',
            cumulativeGasUsed: '0x5208',
            nonce: '0x1',
            input: '0x',
            timestamp: '0x6553f100',
            status: '0x1',
            type: '0x2',
            transactionIndex: '0x0',
            blockchain: 'base'
          }
        ]
      })
    }
    try {
      const firstPage = await evmHistoryWorker.fetch(
        historyRequest({ blockchain: ['base'] }),
        workerEnv()
      )
      expect(firstPage.status).toBe(200)
      await expect(firstPage.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 7,
        result: {
          nextPageToken: 'older-transactions',
          transactions: [expect.objectContaining({ hash: TRANSACTION_HASH, blockNumber: '0x64' })]
        }
      })

      const secondPage = await evmHistoryWorker.fetch(
        historyRequest({ blockchain: ['base'], pageToken: 'older-transactions' }),
        workerEnv()
      )
      expect(secondPage.status).toBe(200)
      await expect(secondPage.json()).resolves.toMatchObject({
        result: { transactions: [expect.objectContaining({ hash: TRANSACTION_HASH })] }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rate limits history before consuming upstream quota', async () => {
    const originalFetch = globalThis.fetch
    let upstreamCalls = 0
    globalThis.fetch = async () => {
      upstreamCalls += 1
      throw new Error('Upstream must not be called')
    }
    try {
      const response = await evmHistoryWorker.fetch(historyRequest(), workerEnv(false))
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32001, message: 'Rate limit exceeded' }
      })
      expect(upstreamCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test.describe('EVM history Worker Ankr key pool', () => {
  test('rejects invalid key configuration before any upstream request, including a legacy-only secret', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      throw new Error('Unexpected upstream request')
    }
    try {
      const invalidValues = [
        undefined,
        '',
        '  ',
        ',test-key',
        'test-key,',
        'test-key,,other-key',
        '[]',
        JSON.stringify(['test-key', 'other-key']),
        Array.from({ length: 9 }, (_, index) => `key-${index}`).join(','),
        'bad/key',
        'a'.repeat(513)
      ]
      for (const ANKR_API_KEYS of invalidValues) {
        const env = { ...workerEnv(), ANKR_API_KEYS, ANKR_API_KEY: 'legacy-key' }
        const response = await evmHistoryWorker.fetch(historyRequest(), env)
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toEqual({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Service unavailable' }
        })
      }
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('trims and deduplicates comma-separated keys before rotating', async () => {
    const originalFetch = globalThis.fetch
    const keys = []
    globalThis.fetch = async (input, init) => {
      const key = upstreamKey(input)
      keys.push(key)
      return key === 'pool-trim-a'
        ? new Response(null, { status: 401 })
        : emptyRpcResponse(JSON.parse(init.body).method)
    }
    try {
      const response = await evmHistoryWorker.fetch(
        historyRequest(),
        workerEnv(true, [' pool-trim-a ', 'pool-trim-a', 'pool-trim-b'])
      )
      expect(response.status).toBe(200)
      expect(keys).toEqual(['pool-trim-a', 'pool-trim-b'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  for (const [route, url, firstFailure] of [
    ['txlist', historyRequest, new Response(null, { status: 401 })],
    ['tokentx', tokenHistoryRequest, new Response(null, { status: 403 })],
    ['balances', () => new Request(BALANCES_URL), rpcError(-32049)]
  ]) {
    test(`${route} retries with the next key after an access failure`, async () => {
      const originalFetch = globalThis.fetch
      const keys = [`${route}-access-a`, `${route}-access-b`]
      const attempted = []
      globalThis.fetch = async (input, init) => {
        const key = upstreamKey(input)
        attempted.push(key)
        return key === keys[0]
          ? firstFailure.clone()
          : emptyRpcResponse(JSON.parse(init.body).method)
      }
      try {
        const response = await evmHistoryWorker.fetch(url(), workerEnv(true, keys))
        expect(response.status).toBe(200)
        expect(attempted).toEqual(keys)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }

  test('rotates for every Ankr access and rate JSON-RPC error code', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const code of [
        -32049, -32050, -32051, -32060, -32052, -32053, -32054, -32079, -32080, -32090, -32077,
        -32070, -32069, -32068, -32067
      ]) {
        const keys = [`rpc-${Math.abs(code)}-a`, `rpc-${Math.abs(code)}-b`]
        const attempted = []
        globalThis.fetch = async (input, init) => {
          const key = upstreamKey(input)
          attempted.push(key)
          return key === keys[0] ? rpcError(code) : emptyRpcResponse(JSON.parse(init.body).method)
        }
        const response = await evmHistoryWorker.fetch(historyRequest(), workerEnv(true, keys))
        expect(response.status, `RPC code ${code}`).toBe(200)
        expect(attempted, `RPC code ${code}`).toEqual(keys)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('shares the last successful key across routes and resets the pool when configuration changes', async () => {
    const originalFetch = globalThis.fetch
    const keys = ['shared-a', 'shared-b', 'shared-c']
    const attempted = []
    let failA = true
    globalThis.fetch = async (input, init) => {
      const key = upstreamKey(input)
      attempted.push(key)
      if (key === keys[0] && failA) return new Response(null, { status: 401 })
      return emptyRpcResponse(JSON.parse(init.body).method)
    }
    try {
      const env = workerEnv(true, keys)
      expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(200)
      expect(attempted).toEqual(['shared-a', 'shared-b'])
      attempted.length = 0
      expect((await evmHistoryWorker.fetch(tokenHistoryRequest(), env)).status).toBe(200)
      expect((await evmHistoryWorker.fetch(new Request(BALANCES_URL), env)).status).toBe(200)
      expect(attempted).toEqual(['shared-b', 'shared-b'])

      failA = false
      attempted.length = 0
      const changedEnv = workerEnv(true, ['shared-c', 'shared-a'])
      expect((await evmHistoryWorker.fetch(historyRequest(), changedEnv)).status).toBe(200)
      expect(attempted).toEqual(['shared-c'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a late concurrent success cannot clear a newer cooldown for the same key', async () => {
    const originalFetch = globalThis.fetch
    const attempted = []
    let releaseFirst
    let notifyFirstStarted
    const firstStarted = new Promise(resolve => {
      notifyFirstStarted = resolve
    })
    let firstKeyCalls = 0
    globalThis.fetch = async (input, init) => {
      const key = upstreamKey(input)
      attempted.push(key)
      if (key === 'concurrent-a') {
        firstKeyCalls += 1
        if (firstKeyCalls === 1) {
          const pending = new Promise(resolve => {
            releaseFirst = () => resolve(emptyRpcResponse(JSON.parse(init.body).method))
          })
          notifyFirstStarted()
          return pending
        }
        return new Response(null, { status: 401 })
      }
      return emptyRpcResponse(JSON.parse(init.body).method)
    }
    try {
      const env = workerEnv(true, ['concurrent-a', 'concurrent-b'])
      const first = evmHistoryWorker.fetch(historyRequest(), env)
      await firstStarted
      expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(200)
      releaseFirst()
      expect((await first).status).toBe(200)
      expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(200)
      expect(attempted).toEqual(['concurrent-a', 'concurrent-a', 'concurrent-b', 'concurrent-b'])
    } finally {
      releaseFirst?.()
      globalThis.fetch = originalFetch
    }
  })

  for (const [kind, failure, expectedStatus, cooldownSeconds] of [
    ['access', new Response(null, { status: 401 }), 503, 300],
    ['rate', new Response(null, { status: 429 }), 429, 60]
  ]) {
    test(`keeps a fully cooled ${kind} pool off upstream until its earliest retry`, async () => {
      const originalFetch = globalThis.fetch
      const originalNow = Date.now
      let now = 1_800_000_000_000
      let recover = false
      const attempted = []
      Date.now = () => now
      globalThis.fetch = async (input, init) => {
        const key = upstreamKey(input)
        attempted.push(key)
        if (recover) return emptyRpcResponse(JSON.parse(init.body).method)
        if (kind === 'rate' && key === 'cool-rate-a') {
          return new Response(null, { status: 401 })
        }
        return failure.clone()
      }
      try {
        const env = workerEnv(true, [`cool-${kind}-a`, `cool-${kind}-b`])
        const first = await evmHistoryWorker.fetch(historyRequest(), env)
        expect(first.status).toBe(expectedStatus)
        expect(Number(first.headers.get('Retry-After'))).toBe(cooldownSeconds)
        expect(attempted).toEqual([`cool-${kind}-a`, `cool-${kind}-b`])

        now += (cooldownSeconds - 1) * 1_000
        const stillCooling = await evmHistoryWorker.fetch(historyRequest(), env)
        expect(stillCooling.status).toBe(expectedStatus)
        expect(Number(stillCooling.headers.get('Retry-After'))).toBeGreaterThan(0)
        expect(attempted).toHaveLength(2)

        now += 1_000
        recover = true
        expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(200)
        expect(attempted).toHaveLength(3)
      } finally {
        globalThis.fetch = originalFetch
        Date.now = originalNow
      }
    })
  }

  test('honors an HTTP-date Retry-After longer than the default rate cooldown', async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    let now = 1_800_000_000_000
    const attempted = []
    Date.now = () => now
    globalThis.fetch = async (input, init) => {
      const key = upstreamKey(input)
      attempted.push(key)
      if (key === 'date-a' && attempted.length === 1) {
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': new Date(now + 180_000).toUTCString() }
        })
      }
      if (key === 'date-b') {
        return new Response(null, { status: 429, headers: { 'Retry-After': '300' } })
      }
      return emptyRpcResponse(JSON.parse(init.body).method)
    }
    try {
      const env = workerEnv(true, ['date-a', 'date-b'])
      const first = await evmHistoryWorker.fetch(historyRequest(), env)
      expect(first.status).toBe(429)
      expect(Number(first.headers.get('Retry-After'))).toBe(180)
      now += 179_000
      expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(429)
      expect(attempted).toEqual(['date-a', 'date-b'])
      now += 1_000
      expect((await evmHistoryWorker.fetch(historyRequest(), env)).status).toBe(200)
      expect(attempted).toEqual(['date-a', 'date-b', 'date-a'])
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  test('does not rotate on ordinary upstream failures or expose their private details', async () => {
    const originalFetch = globalThis.fetch
    const originalConsoleError = console.error
    const logs = []
    console.error = (...parts) => logs.push(parts.join(' '))
    try {
      for (const [name, failure] of [
        ['http', () => new Response('private-http-detail', { status: 500 })],
        ['json', () => new Response('private-json-detail')],
        ['rpc', () => rpcError(-32602, 'private-parameter-detail')],
        [
          'network',
          () => {
            throw new Error(
              'network failure at https://rpc.ankr.com/multichain/private-network-key'
            )
          }
        ]
      ]) {
        const attempted = []
        globalThis.fetch = async input => {
          attempted.push(upstreamKey(input))
          return failure()
        }
        const response = await evmHistoryWorker.fetch(
          historyRequest(),
          workerEnv(true, [`private-${name}-key`, `backup-${name}-key`])
        )
        expect(response.status, name).toBe(502)
        expect(attempted, name).toEqual([`private-${name}-key`])
        const body = JSON.stringify(await response.json())
        expect(body).not.toContain('private-')
        expect(body).not.toContain('network failure')
      }
      expect(logs.join('\n')).not.toContain('private-')
      expect(logs.join('\n')).not.toContain('network failure')
      expect(logs.join('\n')).toContain('Ankr HTTP request failed (status=500)')
      expect(logs.join('\n')).toContain('Ankr RPC request failed (code=-32602)')
      expect(logs.join('\n')).toContain('Ankr returned invalid JSON')
      expect(logs.join('\n')).toContain('Ankr upstream unavailable')
    } finally {
      globalThis.fetch = originalFetch
      console.error = originalConsoleError
    }
  })

  test('does not rotate after request cancellation', async () => {
    const originalFetch = globalThis.fetch
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const controller = new AbortController()
    const attempted = []
    let deadlineTimer
    let deadlineCleared = false
    globalThis.setTimeout = (callback, delay, ...args) => {
      const timer = originalSetTimeout(callback, delay, ...args)
      if (delay === 15_000) deadlineTimer = timer
      return timer
    }
    globalThis.clearTimeout = timer => {
      if (timer === deadlineTimer) deadlineCleared = true
      return originalClearTimeout(timer)
    }
    globalThis.fetch = async input => {
      attempted.push(upstreamKey(input))
      controller.abort()
      throw new DOMException('Request aborted', 'AbortError')
    }
    try {
      const response = await evmHistoryWorker.fetch(
        historyRequest({}, { signal: controller.signal }),
        workerEnv(true, ['cancel-a', 'cancel-b'])
      )
      expect(response.status).toBe(499)
      expect(attempted).toEqual(['cancel-a'])
      expect(deadlineTimer).toBeDefined()
      expect(deadlineCleared).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test('applies one 15-second deadline across key attempts', async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    let now = 1_800_000_000_000
    const attempted = []
    Date.now = () => now
    globalThis.fetch = async input => {
      attempted.push(upstreamKey(input))
      now += attempted.length === 1 ? 6_000 : 10_000
      return new Response(null, { status: 401 })
    }
    try {
      const response = await evmHistoryWorker.fetch(
        historyRequest(),
        workerEnv(true, ['deadline-a', 'deadline-b', 'deadline-c'])
      )
      expect(response.status).toBe(504)
      expect(attempted).toEqual(['deadline-a', 'deadline-b'])
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })
})
