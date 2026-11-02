import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { findExactBlockHeightByTime } from '../src/core/zcash/block-time.ts'
import { lookupBlockHeightByTime } from '../src/core/zcash/date-block-lookup.ts'
import {
  setActiveCustomRpcEndpoints,
  setActiveRpcEndpointPreferences
} from '../src/config/rpc-endpoints.ts'
import { NETWORKS } from '../src/config/networks.ts'

const getBlockTime = async height => height * 10

function encodeVarint(value) {
  const bytes = []
  do {
    const byte = value % 128
    value = Math.floor(value / 128)
    bytes.push(value ? byte | 0x80 : byte)
  } while (value)
  return bytes
}

function grpcWebResponse(message) {
  const trailer = new TextEncoder().encode('grpc-status: 0\r\n')
  const body = new Uint8Array(message.length + trailer.length + 10)
  new DataView(body.buffer).setUint32(1, message.length)
  body.set(message, 5)
  body[message.length + 5] = 0x80
  new DataView(body.buffer).setUint32(message.length + 6, trailer.length)
  body.set(trailer, message.length + 10)
  return new Response(body, {
    headers: { 'content-type': 'application/grpc-web+proto' }
  })
}

function blockRpc(latestHeight, blockTime = height => height * 10) {
  const requestedHeights = []
  const fetchFunction = async (url, options) => {
    if (String(url).endsWith('/GetLatestBlock')) {
      return grpcWebResponse(Uint8Array.from([0x08, ...encodeVarint(latestHeight)]))
    }
    const request = new Uint8Array(options.body)
    let height = 0
    let multiplier = 1
    for (const byte of request.subarray(6)) {
      height += (byte & 0x7f) * multiplier
      if ((byte & 0x80) === 0) break
      multiplier *= 128
    }
    requestedHeights.push(height)
    return grpcWebResponse(
      Uint8Array.from([0x10, ...encodeVarint(height), 0x28, ...encodeVarint(blockTime(height))])
    )
  }
  return { fetchFunction, requestedHeights }
}

describe('exact birthday block lookup', () => {
  test('finds the first block at or after the selected UTC day', async () => {
    await assert.strictEqual(
      await findExactBlockHeightByTime({
        targetTimestamp: 1_055,
        approximateHeight: 80,
        latestHeight: 300,
        getBlockTime
      }),
      106
    )
  })

  test('searches backward when the approximate block is after the target', async () => {
    await assert.strictEqual(
      await findExactBlockHeightByTime({
        targetTimestamp: 1_055,
        approximateHeight: 140,
        latestHeight: 300,
        getBlockTime
      }),
      106
    )
  })

  test('expands beyond the expected WASM approximation window when necessary', async () => {
    await assert.strictEqual(
      await findExactBlockHeightByTime({
        targetTimestamp: 25_000,
        approximateHeight: 100,
        latestHeight: 5_000,
        getBlockTime
      }),
      2_500
    )
  })

  test('preserves WASM boundary results', async () => {
    await assert.strictEqual(
      await findExactBlockHeightByTime({
        targetTimestamp: 100,
        approximateHeight: 0,
        latestHeight: 300,
        getBlockTime
      }),
      0
    )

    await assert.strictEqual(
      await findExactBlockHeightByTime({
        targetTimestamp: 4_000,
        approximateHeight: 300,
        latestHeight: 300,
        getBlockTime
      }),
      300
    )
  })
})

describe('worker-free birthday lookup', () => {
  test('preserves Sapling and tip boundaries on both networks', async () => {
    for (const [network, activationHeight] of [
      ['mainnet', 419_200],
      ['testnet', 280_000]
    ]) {
      const latestHeight = activationHeight + 10
      const rpc = blockRpc(latestHeight)
      const options = { fetchFunction: rpc.fetchFunction }
      await assert.strictEqual(
        await lookupBlockHeightByTime(activationHeight * 10, network, options),
        0
      )
      await assert.strictEqual(
        await lookupBlockHeightByTime(latestHeight * 10, network, options),
        latestHeight
      )
      await assert.strictEqual(
        await lookupBlockHeightByTime(activationHeight * 10 + 55, network, options),
        activationHeight + 6
      )
      assert.ok(rpc.requestedHeights.includes(activationHeight))
      assert.ok(rpc.requestedHeights.includes(latestHeight))
    }
  })

  test('limits the whole lookup to one budget', async () => {
    let requests = 0
    const rpc = blockRpc(419_210)
    const fetchFunction = async (url, options) => {
      requests += 1
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 25)
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true }
        )
      })
      return rpc.fetchFunction(url, options)
    }
    await assert.rejects(
      lookupBlockHeightByTime(4_192_055, 'mainnet', {
        fetchFunction,
        timeoutMs: 65
      })
    )
    assert.ok(requests >= 2)
  })

  test('uses the selected mainnet RPC and the fixed testnet RPC', async () => {
    const endpoint = {
      id: 'custom:birthday-lookup',
      label: 'Birthday lookup',
      url: 'https://birthday.example.com'
    }
    setActiveCustomRpcEndpoints({ zcash: [endpoint] })
    setActiveRpcEndpointPreferences({ zcash: endpoint.id })
    try {
      for (const [network, activationHeight, expectedUrl] of [
        ['mainnet', 419_200, endpoint.url],
        ['testnet', 280_000, NETWORKS.testnet.rpcUrl]
      ]) {
        const rpc = blockRpc(activationHeight + 2)
        const urls = []
        const fetchFunction = async (url, options) => {
          urls.push(String(url))
          return rpc.fetchFunction(url, options)
        }
        await lookupBlockHeightByTime(activationHeight * 10, network, { fetchFunction })
        assert.ok(urls.length > 0)
        assert.strictEqual(
          urls.every(url => url.startsWith(`${expectedUrl}/`)),
          true
        )
      }
    } finally {
      setActiveCustomRpcEndpoints()
      setActiveRpcEndpointPreferences()
    }
  })

  test('aborts an in-flight block request', async () => {
    const controller = new AbortController()
    const rpc = blockRpc(419_210)
    let reachedBlockRequest = false
    const fetchFunction = async (url, options) => {
      if (String(url).endsWith('/GetLatestBlock')) return rpc.fetchFunction(url, options)
      reachedBlockRequest = true
      controller.abort()
      return new Promise((_, reject) => {
        if (options.signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
        else
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
      })
    }
    await assert.rejects(
      lookupBlockHeightByTime(4_192_055, 'mainnet', {
        fetchFunction,
        signal: controller.signal
      })
    )
    assert.strictEqual(reachedBlockRequest, true)
  })
})
