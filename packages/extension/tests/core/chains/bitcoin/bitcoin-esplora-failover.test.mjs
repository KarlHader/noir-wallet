import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BITCOIN_NETWORKS } from '../../../../src/config/networks.ts'
import { RPC_DEFAULT_ENDPOINTS } from '../../../../src/config/rpc-endpoints.ts'
import { BitcoinRpcError } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-esplora-client.ts'
import { createBitcoinEsploraFailoverClient } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-esplora-failover-client.ts'
import {
  createConfiguredBitcoinEsploraClient,
  resolveConfiguredBitcoinEsploraEndpoints
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const TXID = 'a'.repeat(64)
const ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'

function historyTransaction() {
  const output = {
    scriptpubkey: `0014${'1'.repeat(40)}`,
    scriptpubkey_asm: `OP_0 OP_PUSHBYTES_20 ${'1'.repeat(40)}`,
    scriptpubkey_type: 'v0_p2wpkh',
    scriptpubkey_address: ADDRESS,
    value: 1_000
  }
  return {
    txid: TXID,
    version: 2,
    locktime: 0,
    size: 100,
    weight: 400,
    fee: 100,
    vin: [
      {
        txid: 'b'.repeat(64),
        vout: 0,
        prevout: { ...output, value: 1_100 },
        scriptsig: '',
        scriptsig_asm: '',
        is_coinbase: false,
        sequence: 0xffffffff
      }
    ],
    vout: [output],
    status: { confirmed: false }
  }
}

function createTransport(handler) {
  const requests = []
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init })
      return handler(url, init, requests.length)
    }
  }
}

function createClient(transport, options = {}) {
  return createBitcoinEsploraFailoverClient(
    {
      chainId: MAINNET,
      endpoints: [
        { id: 'primary', baseUrl: 'https://primary.example/api/' },
        { id: 'fallback', baseUrl: 'https://fallback.example/api/' }
      ],
      defaultRateLimitCooldownMs: 5_000,
      maximumRateLimitCooldownMs: 60_000,
      minimumRequestIntervalMs: 0,
      ...options.config
    },
    {
      fetchImplementation: transport.fetch,
      ...options.dependencies
    }
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

test.describe('Bitcoin Esplora configured endpoints', () => {
  test('pins one local credential-free endpoint per Bitcoin network', () => {
    expect(RPC_DEFAULT_ENDPOINTS.bitcoin.mainnet.url).toBe('https://mempool.space/api/')
    expect(RPC_DEFAULT_ENDPOINTS.bitcoin.testnet.url).toBe('https://mempool.space/testnet/api/')
    expect(BITCOIN_NETWORKS.testnet.networkName).toBe('testnet3')
  })

  test('shares the built-in client so discovery, Activity, and monitors use one limiter', () => {
    expect(createConfiguredBitcoinEsploraClient('mainnet')).toBe(
      createConfiguredBitcoinEsploraClient('mainnet')
    )
    expect(createConfiguredBitcoinEsploraClient('testnet')).not.toBe(
      createConfiguredBitcoinEsploraClient('mainnet')
    )
  })

  test('keeps a manually selected custom endpoint fixed', () => {
    expect(
      resolveConfiguredBitcoinEsploraEndpoints('mainnet', 'https://custom.example/esplora')
    ).toEqual([{ id: 'custom', baseUrl: 'https://custom.example/esplora/' }])
  })

  test('keeps a manually selected bundled endpoint fixed', () => {
    expect(
      resolveConfiguredBitcoinEsploraEndpoints('mainnet', 'https://mempool.space/api')
    ).toEqual([{ id: 'mempool-space', baseUrl: 'https://mempool.space/api/' }])
  })

  test('shares the fixed custom client across Bitcoin background consumers', () => {
    expect(createConfiguredBitcoinEsploraClient('mainnet', 'https://custom.example/esplora')).toBe(
      createConfiguredBitcoinEsploraClient('mainnet', 'https://custom.example/esplora/')
    )
  })

  test('does not leave a rate-limited manually selected endpoint', async () => {
    const originalFetch = globalThis.fetch
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url === 'https://rate-limited-custom.example/api/blocks/tip/height') {
        return new Response('', { status: 429 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = transport.fetch
    try {
      const client = createConfiguredBitcoinEsploraClient(
        'mainnet',
        'https://rate-limited-custom.example/api/'
      )
      await expect(client.getTipHeight()).rejects.toThrow('rate limit')
      expect(transport.requests.map(request => request.url)).toEqual([
        'https://rate-limited-custom.example/api/blocks/tip/height'
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test.describe('Bitcoin Esplora failover', () => {
  test('attests and paces concurrent reads with one bundled endpoint', async () => {
    let currentTime = 1_000
    const requestTimes = []
    const transport = createTransport(url => {
      requestTimes.push(currentTime)
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) return new Response('900000')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, {
      config: {
        endpoints: [{ id: 'only', baseUrl: 'https://only.example/api/' }],
        minimumRequestIntervalMs: 250
      },
      dependencies: {
        now: () => currentTime,
        delay: async milliseconds => {
          currentTime += milliseconds
        }
      }
    })

    await expect(Promise.all([client.getTipHeight(), client.getTipHeight()])).resolves.toEqual([
      900000, 900000
    ])
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://only.example/api/block-height/0',
      'https://only.example/api/blocks/tip/height',
      'https://only.example/api/blocks/tip/height'
    ])
    expect(requestTimes).toEqual([1_000, 1_250, 1_500])
  })

  test('rejects a single endpoint on the wrong Bitcoin chain before reading', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response('b'.repeat(64))
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, {
      config: { endpoints: [{ id: 'only', baseUrl: 'https://only.example/api/' }] }
    })

    const error = await captureError(client.getTipHeight())
    expect(error).toBeInstanceOf(BitcoinRpcError)
    expect(error.code).toBe('chain-mismatch')
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://only.example/api/block-height/0'
    ])
  })

  test('attests the primary once and keeps successful reads on it', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) return new Response('900000')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getTipHeight()).resolves.toBe(900000)
    await expect(client.getTipHeight()).resolves.toBe(900000)

    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://primary.example/api/blocks/tip/height'
    ])
  })

  test('does not repeat an explicit chain attestation after a successful read', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) return new Response('900000')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getTipHeight()).resolves.toBe(900000)
    await expect(client.assertExpectedChain()).resolves.toBeUndefined()

    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height'
    ])
  })

  test('paces concurrent requests and shares one in-flight chain attestation', async () => {
    let currentTime = 1_000
    const requestTimes = []
    const waits = []
    const transport = createTransport(url => {
      requestTimes.push(currentTime)
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) return new Response('900000')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, {
      config: { minimumRequestIntervalMs: 250 },
      dependencies: {
        now: () => currentTime,
        delay: async milliseconds => {
          waits.push(milliseconds)
          currentTime += milliseconds
        }
      }
    })

    await expect(Promise.all([client.getTipHeight(), client.getTipHeight()])).resolves.toEqual([
      900000, 900000
    ])

    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://primary.example/api/blocks/tip/height'
    ])
    expect(requestTimes).toEqual([1_000, 1_250, 1_500])
    expect(waits).toEqual([0, 250, 250])
  })

  test('paces request starts without serializing slow response bodies', async () => {
    let currentTime = 1_000
    const pendingTips = []
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) {
        return new Promise(resolve => pendingTips.push(resolve))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, {
      config: { minimumRequestIntervalMs: 250 },
      dependencies: {
        now: () => currentTime,
        delay: async milliseconds => {
          currentTime += milliseconds
        }
      }
    })

    await client.assertExpectedChain()
    const first = client.getTipHeight()
    const second = client.getTipHeight()
    for (let turn = 0; turn < 10 && pendingTips.length < 2; turn += 1) {
      await Promise.resolve()
    }

    expect(pendingTips).toHaveLength(2)
    pendingTips[0](new Response('900000'))
    pendingTips[1](new Response('900001'))
    await expect(Promise.all([first, second])).resolves.toEqual([900000, 900001])
  })

  test('does not spend the endpoint timeout while a request waits for the pacing gate', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/blocks/tip/height')) return new Response('900000')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, {
      config: { minimumRequestIntervalMs: 40, timeoutMs: 10 }
    })

    await expect(client.getTipHeight()).resolves.toBe(900000)
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height'
    ])
  })

  test('moves to the fallback on 429 and keeps the healthy fallback active', async () => {
    let currentTime = 1_000
    let primaryTipCalls = 0
    const transport = createTransport(url => {
      if (url === 'https://primary.example/api/block-height/0') {
        return new Response(MAINNET_GENESIS)
      }
      if (url === 'https://primary.example/api/blocks/tip/height') {
        primaryTipCalls += 1
        return primaryTipCalls === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '30' } })
          : new Response('900002')
      }
      if (url === 'https://fallback.example/api/block-height/0') {
        return new Response(MAINNET_GENESIS)
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') {
        return new Response('900001')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, { dependencies: { now: () => currentTime } })

    await expect(client.getTipHeight()).resolves.toBe(900001)
    currentTime += 29_000
    await expect(client.getTipHeight()).resolves.toBe(900001)
    currentTime += 1_001
    await expect(client.getTipHeight()).resolves.toBe(900001)

    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://fallback.example/api/block-height/0',
      'https://fallback.example/api/blocks/tip/height',
      'https://fallback.example/api/blocks/tip/height',
      'https://fallback.example/api/blocks/tip/height'
    ])
  })

  test('fails over when chain attestation itself is rate limited', async () => {
    const transport = createTransport(url => {
      if (url === 'https://primary.example/api/block-height/0') {
        return new Response('', { status: 429 })
      }
      if (url === 'https://fallback.example/api/block-height/0') {
        return new Response(MAINNET_GENESIS)
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') {
        return new Response('900000')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getTipHeight()).resolves.toBe(900000)
  })

  test('moves to the fallback on network failure without probing during later user reads', async () => {
    let currentTime = 1_000
    let primaryTipCalls = 0
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url === 'https://primary.example/api/blocks/tip/height') {
        primaryTipCalls += 1
        return primaryTipCalls === 1 ? new Response('', { status: 503 }) : new Response('900002')
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') return new Response('900001')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, { dependencies: { now: () => currentTime } })

    await expect(client.getTipHeight()).resolves.toBe(900001)
    currentTime += 29_000
    await expect(client.getTipHeight()).resolves.toBe(900001)
    currentTime += 1_001
    await expect(client.getTipHeight()).resolves.toBe(900001)

    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://fallback.example/api/block-height/0',
      'https://fallback.example/api/blocks/tip/height',
      'https://fallback.example/api/blocks/tip/height',
      'https://fallback.example/api/blocks/tip/height'
    ])
  })

  test('moves to the fallback when the primary request times out', async () => {
    const transport = createTransport((url, init) => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url === 'https://primary.example/api/blocks/tip/height') {
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          )
        })
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') return new Response('900001')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, { config: { timeoutMs: 10 } })

    await expect(client.getTipHeight()).resolves.toBe(900001)
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://fallback.example/api/block-height/0',
      'https://fallback.example/api/blocks/tip/height'
    ])
  })

  test('fails over credential-free authorization blocks to the fallback', async () => {
    // The bundled endpoints carry no credentials, so a 401/403 is a CDN/anti-bot
    // soft block (e.g. Cloudflare on blockstream.info), not a real auth failure.
    // It must cool the endpoint down and fail over instead of failing closed.
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url === 'https://primary.example/api/blocks/tip/height') {
        return new Response('', { status: 403 })
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') return new Response('900002')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getTipHeight()).resolves.toBe(900002)
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      'https://primary.example/api/blocks/tip/height',
      'https://fallback.example/api/block-height/0',
      'https://fallback.example/api/blocks/tip/height'
    ])
  })

  test('keeps using a healthy fallback after a credential-free 403', async () => {
    let currentTime = 1_000
    let primaryTipCalls = 0
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url === 'https://primary.example/api/blocks/tip/height') {
        primaryTipCalls += 1
        // Blocked on the first attempt, healthy again after the cooldown lapses.
        return primaryTipCalls === 1 ? new Response('', { status: 403 }) : new Response('900003')
      }
      if (url === 'https://fallback.example/api/blocks/tip/height') return new Response('900002')
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport, { dependencies: { now: () => currentTime } })

    await expect(client.getTipHeight()).resolves.toBe(900002)
    currentTime += 31_000
    await expect(client.getTipHeight()).resolves.toBe(900002)
    expect(primaryTipCalls).toBe(1)
  })

  test('does not make or fail over an already-cancelled request', async () => {
    const transport = createTransport(() => {
      throw new Error('Unexpected request')
    })
    const client = createClient(transport)
    const controller = new AbortController()
    controller.abort()

    const error = await captureError(client.getTipHeight(controller.signal))
    expect(error).toBeInstanceOf(BitcoinRpcError)
    expect(error.code).toBe('cancelled')
    expect(transport.requests).toHaveLength(0)
  })

  test('fails closed when the fallback resolves to the wrong chain', async () => {
    const transport = createTransport(url => {
      if (url === 'https://primary.example/api/block-height/0') {
        return new Response(MAINNET_GENESIS)
      }
      if (url === 'https://primary.example/api/blocks/tip/height') {
        return new Response('', { status: 429 })
      }
      if (url === 'https://fallback.example/api/block-height/0') {
        return new Response('b'.repeat(64))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    const error = await captureError(client.getTipHeight())
    expect(error).toBeInstanceOf(BitcoinRpcError)
    expect(error.code).toBe('chain-mismatch')
    expect(transport.requests).toHaveLength(3)
  })

  test('rebroadcasts the exact same raw transaction only after an explicit 429', async () => {
    const bodies = []
    const transport = createTransport((url, init) => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.endsWith('/tx') && init.method === 'POST') {
        bodies.push(init.body)
        return url.includes('primary.example')
          ? new Response('', { status: 429 })
          : new Response(TXID)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.broadcastRawTransaction('02000000')).resolves.toBe(TXID)
    expect(bodies).toEqual(['02000000', '02000000'])
  })

  test('reads address history from the fallback only after an explicit 429', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.includes('primary.example') && url.endsWith(`/address/${ADDRESS}/txs`)) {
        return new Response('', { status: 429 })
      }
      if (url.includes('fallback.example') && url.endsWith(`/address/${ADDRESS}/txs`)) {
        return new Response(JSON.stringify([historyTransaction()]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getAddressTransactions(ADDRESS)).resolves.toMatchObject([
      { transactionId: TXID, feeRaw: '100', status: { confirmed: false } }
    ])
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      `https://primary.example/api/address/${ADDRESS}/txs`,
      'https://fallback.example/api/block-height/0',
      `https://fallback.example/api/address/${ADDRESS}/txs`
    ])
  })

  test('reads output-spend evidence from the fallback only after an explicit 429', async () => {
    const transport = createTransport(url => {
      if (url.endsWith('/block-height/0')) return new Response(MAINNET_GENESIS)
      if (url.includes('primary.example') && url.endsWith(`/tx/${TXID}/outspend/0`)) {
        return new Response('', { status: 429 })
      }
      if (url.includes('fallback.example') && url.endsWith(`/tx/${TXID}/outspend/0`)) {
        return new Response(JSON.stringify({ spent: false }))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createClient(transport)

    await expect(client.getOutputSpendStatus(TXID, 0)).resolves.toEqual({ spent: false })
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://primary.example/api/block-height/0',
      `https://primary.example/api/tx/${TXID}/outspend/0`,
      'https://fallback.example/api/block-height/0',
      `https://fallback.example/api/tx/${TXID}/outspend/0`
    ])
  })

  test('tries each endpoint at most once and stops while all are cooling down', async () => {
    const transport = createTransport(() => new Response('', { status: 429 }))
    const client = createClient(transport)

    const firstError = await captureError(client.getTipHeight())
    expect(firstError).toBeInstanceOf(BitcoinRpcError)
    expect(firstError.code).toBe('rate-limited')
    expect(transport.requests).toHaveLength(2)

    const secondError = await captureError(client.getTipHeight())
    expect(secondError).toBeInstanceOf(BitcoinRpcError)
    expect(secondError.code).toBe('rate-limited')
    expect(transport.requests).toHaveLength(2)
  })

  test('rejects invalid endpoint pools before making a request', () => {
    expect(() =>
      createBitcoinEsploraFailoverClient({
        chainId: MAINNET,
        endpoints: []
      })
    ).toThrow(/one to five endpoints/)
    expect(() =>
      createBitcoinEsploraFailoverClient({
        chainId: MAINNET,
        endpoints: [null, { id: 'fallback', baseUrl: 'https://fallback.example/api/' }]
      })
    ).toThrow(/endpoint ID/)
    expect(() =>
      createBitcoinEsploraFailoverClient({
        chainId: MAINNET,
        endpoints: [
          { id: 'same', baseUrl: 'https://primary.example/api/' },
          { id: 'same', baseUrl: 'https://fallback.example/api/' }
        ]
      })
    ).toThrow(/endpoint ID/)
    expect(() =>
      createBitcoinEsploraFailoverClient({
        chainId: MAINNET,
        endpoints: [
          { id: 'primary', baseUrl: 'https://primary.example/api' },
          { id: 'fallback', baseUrl: 'https://primary.example/api/' }
        ]
      })
    ).toThrow(/Duplicate/)
  })
})
