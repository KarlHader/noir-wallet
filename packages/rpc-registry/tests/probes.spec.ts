import { expect, test } from '@playwright/test'
import { probeAllTargets, probeTarget, type FetchFunction } from '../src/probes'
import type { RpcTarget } from '../src/types'

const TARGET: RpcTarget = {
  chainId: 'zcash-mainnet',
  chain: 'zcash',
  network: 'mainnet',
  probe: 'zcash-lightwalletd-grpc-web',
  id: 'test',
  label: 'Test RPC',
  url: 'https://rpc.example.com'
}

test('runs the three business probes and accepts an empty subtree stream', async () => {
  const requests: Array<{ url: string; body: Uint8Array }> = []
  const fetchFunction: FetchFunction = async (input, init) => {
    const url = String(input)
    requests.push({ url, body: Uint8Array.from(init?.body as Uint8Array) })

    if (url.endsWith('/GetLatestBlock')) {
      return grpcResponse(dataAndTrailers([0x08, 0xac, 0x02]))
    }
    if (url.endsWith('/GetBlockRange')) {
      return grpcResponse(dataAndTrailers([0x01]))
    }
    return grpcResponse(trailersOnly())
  }

  const results = await probeTarget(TARGET, fetchFunction)

  expect(results.map(result => [result.check, result.outcome])).toEqual([
    ['GetLatestBlock', 'success'],
    ['GetBlockRange', 'success'],
    ['GetSubtreeRoots', 'success']
  ])
  expect(results.every(result => result.observedHeight === 300)).toBe(true)
  expect(requests).toHaveLength(3)
  expect([...requests.find(request => request.url.endsWith('/GetSubtreeRoots'))!.body]).toEqual([
    0, 0, 0, 0, 2, 0x10, 0x02
  ])
  expect([...requests.find(request => request.url.endsWith('/GetBlockRange'))!.body]).toEqual([
    0, 0, 0, 0, 10, 0x0a, 0x03, 0x08, 0xa2, 0x02, 0x12, 0x03, 0x08, 0xa2, 0x02
  ])
})

test('classifies aborts as timeout and skips the dependent range probe', async () => {
  const fetchFunction: FetchFunction = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true }
      )
    })

  const results = await probeTarget(TARGET, fetchFunction, {
    GetLatestBlock: 5,
    GetBlockRange: 5,
    GetSubtreeRoots: 5
  })

  expect(results[0]).toMatchObject({
    check: 'GetLatestBlock',
    outcome: 'failure',
    error: 'Timed out after 5ms'
  })
  expect(results[1]).toMatchObject({
    check: 'GetBlockRange',
    outcome: 'skipped'
  })
  expect(results[2]).toMatchObject({
    check: 'GetSubtreeRoots',
    outcome: 'failure',
    error: 'Timed out after 5ms'
  })
})

test('rejects an HTTP success that carries a non-zero gRPC status', async () => {
  const fetchFunction: FetchFunction = async input => {
    if (String(input).endsWith('/GetLatestBlock')) {
      return grpcResponse(trailer('grpc-status: 14\r\ngrpc-message: unavailable\r\n'))
    }
    return grpcResponse(trailersOnly())
  }

  const results = await probeTarget(TARGET, fetchFunction)
  expect(results[0]).toMatchObject({
    check: 'GetLatestBlock',
    outcome: 'failure',
    error: 'gRPC status 14: unavailable'
  })
  expect(results[1].outcome).toBe('skipped')
})

test('retries a failed check twice and suppresses a transient failure', async () => {
  let subtreeCalls = 0
  const fetchFunction: FetchFunction = async input => {
    const url = String(input)
    if (url.endsWith('/GetLatestBlock')) {
      return grpcResponse(dataAndTrailers([0x08, 0xac, 0x02]))
    }
    if (url.endsWith('/GetBlockRange')) {
      return grpcResponse(dataAndTrailers([0x01]))
    }
    subtreeCalls += 1
    return subtreeCalls < 3
      ? new Response('unavailable', { status: 503 })
      : grpcResponse(trailersOnly())
  }

  const results = await probeAllTargets([TARGET], fetchFunction)
  const subtree = results.find(result => result.check === 'GetSubtreeRoots')

  expect(subtree).toMatchObject({ outcome: 'success', attempts: 3 })
  expect(subtreeCalls).toBe(3)
})

test('reports a failure only after all three attempts fail', async () => {
  let subtreeCalls = 0
  const fetchFunction: FetchFunction = async input => {
    const url = String(input)
    if (url.endsWith('/GetLatestBlock')) {
      return grpcResponse(dataAndTrailers([0x08, 0xac, 0x02]))
    }
    if (url.endsWith('/GetBlockRange')) {
      return grpcResponse(dataAndTrailers([0x01]))
    }
    subtreeCalls += 1
    return new Response('unavailable', { status: 503 })
  }

  const results = await probeAllTargets([TARGET], fetchFunction)
  const subtree = results.find(result => result.check === 'GetSubtreeRoots')

  expect(subtree).toMatchObject({ outcome: 'failure', attempts: 3, error: 'HTTP 503' })
  expect(subtreeCalls).toBe(3)
})

test('serializes subtree checks across providers sharing the same backend', async () => {
  let subtreeInFlight = 0
  let maxSubtreeInFlight = 0
  const fetchFunction: FetchFunction = async input => {
    const url = String(input)
    if (url.endsWith('/GetLatestBlock')) {
      return grpcResponse(dataAndTrailers([0x08, 0xac, 0x02]))
    }
    if (url.endsWith('/GetBlockRange')) {
      return grpcResponse(dataAndTrailers([0x01]))
    }

    subtreeInFlight += 1
    maxSubtreeInFlight = Math.max(maxSubtreeInFlight, subtreeInFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    subtreeInFlight -= 1
    return grpcResponse(trailersOnly())
  }

  await probeAllTargets(
    [TARGET, { ...TARGET, id: 'test-2', label: 'Test RPC 2', url: 'https://rpc-2.example.com' }],
    fetchFunction
  )

  expect(maxSubtreeInFlight).toBe(1)
})

test('keeps retries scoped when chains reuse the same endpoint id', async () => {
  const secondChainTarget = {
    ...TARGET,
    chainId: 'zcash-testnet',
    network: 'testnet',
    url: 'https://testnet.example.com'
  }
  const subtreeCalls = new Map<string, number>()
  const fetchFunction: FetchFunction = async input => {
    const url = String(input)
    if (url.endsWith('/GetLatestBlock')) {
      return grpcResponse(dataAndTrailers([0x08, 0xac, 0x02]))
    }
    if (url.endsWith('/GetBlockRange')) {
      return grpcResponse(dataAndTrailers([0x01]))
    }

    const origin = new URL(url).origin
    subtreeCalls.set(origin, (subtreeCalls.get(origin) ?? 0) + 1)
    return origin === TARGET.url
      ? new Response('unavailable', { status: 503 })
      : grpcResponse(trailersOnly())
  }

  const results = await probeAllTargets([TARGET, secondChainTarget], fetchFunction)

  expect(
    results.find(result => result.chainId === TARGET.chainId && result.check === 'GetSubtreeRoots')
  ).toMatchObject({ outcome: 'failure', attempts: 3 })
  expect(
    results.find(
      result => result.chainId === secondChainTarget.chainId && result.check === 'GetSubtreeRoots'
    )
  ).toMatchObject({ outcome: 'success', attempts: 1 })
  expect(subtreeCalls.get(TARGET.url)).toBe(3)
  expect(subtreeCalls.get(secondChainTarget.url)).toBe(1)
})

function grpcResponse(body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/grpc-web+proto' }
  })
}

function dataAndTrailers(payload: number[]): Uint8Array {
  return concat(frame(0x00, Uint8Array.from(payload)), trailersOnly())
}

function trailersOnly(): Uint8Array {
  return trailer('grpc-status: 0\r\n')
}

function trailer(value: string): Uint8Array {
  return frame(0x80, new TextEncoder().encode(value))
}

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(5 + payload.length)
  result[0] = flags
  new DataView(result.buffer).setUint32(1, payload.length)
  result.set(payload, 5)
  return result
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}
