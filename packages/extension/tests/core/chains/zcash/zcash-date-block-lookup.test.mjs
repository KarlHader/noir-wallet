import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { lookupBlockHeightByTime } from '../../../../src/core/zcash/date-block-lookup.ts'
import { setActiveChainEndpointSettings } from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { getZcashChainId } from '../../../../src/core/chains/registry'

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

test.describe('worker-free birthday lookup', () => {
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

test('keeps date lookup on the selected custom RPC for either global network', async () => {
  for (const [network, activationHeight] of [
    ['mainnet', 419200],
    ['testnet', 280000]
  ]) {
    const url = 'https://selected-rpc.example'
    setActiveChainEndpointSettings({
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: getZcashChainId(network),
          rpc: { protocol: 'zcash-lightwalletd', label: 'Selected', url }
        }
      ]
    })
    try {
      const rpc = blockRpc(activationHeight + 10)
      const urls = []
      await lookupBlockHeightByTime(activationHeight * 10 + 55, network, {
        fetchFunction: async (requestUrl, options) => {
          urls.push(String(requestUrl))
          return rpc.fetchFunction(requestUrl, options)
        }
      })
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every(requestUrl => requestUrl.startsWith(url + '/'))).toBe(true)
    } finally {
      setActiveChainEndpointSettings()
    }
  }
})
