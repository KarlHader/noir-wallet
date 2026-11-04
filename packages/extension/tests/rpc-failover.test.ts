import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RPC_RECOVERY_COOLDOWN_MS,
  RPC_RECOVERY_PROBE_INTERVAL_MS,
  createRpcFailoverState,
  registerPreferredRpcProbe,
  registerRpcFailure,
  registerRpcSuccess
} from '../src/config/rpc-failover'
import { isRpcEndpointError } from '../src/lib/errors'
import {
  RPC_ENDPOINT_UNAVAILABLE_MESSAGE,
  getRetryableWalletRpcUserMessage
} from '../src/core/zcash/wallet-rpc-errors'
import {
  AUTOMATIC_RPC_ENDPOINT_ID,
  getNextRpcEndpointOption,
  getRpcEndpointOptions,
  isRpcEndpointUrlConfigured,
  migrateRpcEndpointDefaults,
  parseRpcEndpointModes,
  selectStartupRpcEndpoint,
  setActiveCustomRpcEndpoints,
  withoutZeroIndexerEndpoints
} from '../src/config/rpc-endpoints'
import {
  fetchBlockTime,
  fetchLatestBlockHeight,
  parseRpcRegistryDocument,
  probeRpcEndpoint,
  selectPreferredRpcEndpoint,
  verifyZcashRpcEndpoint
} from '../src/config/rpc-registry-client'
import {
  createCustomRpcEndpoint,
  normalizeCustomRpcUrl,
  parseCustomRpcEndpoints
} from '../src/config/custom-rpc'

function grpcWebResponse(message: Uint8Array, status = '0'): Uint8Array {
  const trailers = new TextEncoder().encode(`grpc-status: ${status}\r\n`)
  const result = new Uint8Array(5 + message.length + 5 + trailers.length)
  result[0] = 0
  new DataView(result.buffer).setUint32(1, message.length)
  result.set(message, 5)
  result[5 + message.length] = 0x80
  new DataView(result.buffer).setUint32(6 + message.length, trailers.length)
  result.set(trailers, 10 + message.length)
  return result
}

function lightdInfoMessage(chainName: string): Uint8Array {
  const chain = new TextEncoder().encode(chainName)
  return Uint8Array.from([0x22, chain.length, ...chain])
}

function encodeVarint(value: number): number[] {
  const result: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    result.push(byte)
  } while (remaining > 0)
  return result
}

test('uses the fastest RPC only when no valid persisted preference exists', async () => {
  const endpoints = [
    { id: 'primary', label: 'Primary', url: 'https://primary.example.com' },
    { id: 'backup', label: 'Backup', url: 'https://backup.example.com' },
    { id: 'alternative', label: 'Alternative', url: 'https://alternative.example.com' }
  ]
  const latencies = new Map([
    [endpoints[0].id, 300],
    [endpoints[1].id, 80],
    [endpoints[2].id, 140]
  ])
  const probe = async (endpoint: (typeof endpoints)[number]) =>
    latencies.get(endpoint.id) ?? Number.MAX_SAFE_INTEGER

  assert.equal(await selectPreferredRpcEndpoint(endpoints, undefined, probe), endpoints[1])
  assert.equal(await selectPreferredRpcEndpoint(endpoints, endpoints[2].id, probe), endpoints[2])
  assert.equal(await selectPreferredRpcEndpoint(endpoints, 'removed-endpoint', probe), endpoints[1])
})

test('validates the versioned multi-chain RPC registry at the extension boundary', () => {
  const registry = parseRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-09-07T00:00:00.000Z',
    chains: [
      {
        id: 'zcash-mainnet',
        chain: 'zcash',
        network: 'mainnet',
        label: 'Zcash',
        iconChain: 'zec',
        endpoints: [{ id: 'primary', label: 'Primary', url: 'https://rpc.example.com/' }]
      },
      {
        id: 'bitcoin-mainnet',
        chain: 'bitcoin',
        network: 'mainnet',
        label: 'Bitcoin',
        iconChain: 'btc',
        endpoints: [{ id: 'btc-primary', label: 'BTC Primary', url: 'https://btc.example.com' }]
      }
    ]
  })

  assert.equal(registry?.chains.length, 2)
  assert.equal(registry?.chains[0].endpoints[0].url, 'https://rpc.example.com')
  assert.equal(
    parseRpcRegistryDocument({
      version: 1,
      updatedAt: '2026-09-07T00:00:00.000Z',
      chains: [
        {
          id: 'zcash-mainnet',
          chain: 'zcash',
          network: 'mainnet',
          label: 'Zcash',
          iconChain: 'zec',
          endpoints: [{ id: 'unsafe', label: 'Unsafe', url: 'http://rpc.example.com' }]
        }
      ]
    }),
    null
  )
})

test('measures only a functional gRPC-Web endpoint', async () => {
  const endpoint = { id: 'primary', label: 'Primary', url: 'https://rpc.example.com' }
  const data = Uint8Array.from([0, 0, 0, 0, 1, 1])
  const trailers = new TextEncoder().encode('grpc-status: 0\r\n')
  const body = new Uint8Array(data.length + 5 + trailers.length)
  body.set(data)
  body[data.length] = 0x80
  new DataView(body.buffer).setUint32(data.length + 1, trailers.length)
  body.set(trailers, data.length + 5)

  assert.ok(
    (await probeRpcEndpoint(
      endpoint,
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/grpc-web+proto' }
        })
    )) >= 0
  )

  await assert.rejects(
    probeRpcEndpoint(
      endpoint,
      async () =>
        new Response('<html>proxy error</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    ),
    /RPC probe returned text\/html/
  )
})

test('reads the latest block height from the lightwalletd probe', async () => {
  const height = 4_321_234
  let requestedUrl = ''
  const fetchFunction = async (input: string | URL | Request) => {
    requestedUrl = String(input)
    return new Response(grpcWebResponse(Uint8Array.from([0x08, ...encodeVarint(height)])), {
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto' }
    })
  }

  assert.equal(
    await fetchLatestBlockHeight('https://rpc.example.com/', fetchFunction as typeof fetch),
    height
  )
  assert.equal(
    requestedUrl,
    'https://rpc.example.com/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock'
  )
})

test('reads and validates a compact block timestamp', async () => {
  const height = 419_200
  const timestamp = 1_540_000_000
  let requestBody: Uint8Array | undefined
  const fetchFunction = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(input),
      'https://rpc.example.com/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock'
    )
    requestBody = new Uint8Array(init?.body as Uint8Array)
    return new Response(
      grpcWebResponse(
        Uint8Array.from([0x10, ...encodeVarint(height), 0x28, ...encodeVarint(timestamp)])
      ),
      { headers: { 'content-type': 'application/grpc-web+proto' } }
    )
  }
  assert.equal(
    await fetchBlockTime('https://rpc.example.com', height, fetchFunction as typeof fetch),
    timestamp
  )
  assert.deepEqual(
    requestBody,
    Uint8Array.from([0, 0, 0, 0, 1 + encodeVarint(height).length, 0x08, ...encodeVarint(height)])
  )
})

test('rejects malformed compact block frames and time fields', async () => {
  const height = 419_200
  const validHeight = [0x10, ...encodeVarint(height)]
  const invalidBodies = [
    grpcWebResponse(Uint8Array.from(validHeight)),
    grpcWebResponse(Uint8Array.from([...validHeight, 0x28, 0])),
    grpcWebResponse(Uint8Array.from([0x10, ...encodeVarint(height + 1), 0x28, 1])),
    grpcWebResponse(Uint8Array.from([...validHeight, 0x2a, 1, 1])),
    grpcWebResponse(Uint8Array.from([...validHeight, 0x28, 1, 0x28, 2])),
    Uint8Array.from([0, 0, 0, 0, 8, 0x10]),
    Uint8Array.from([
      1,
      ...grpcWebResponse(Uint8Array.from([...validHeight, 0x28, 1])).subarray(1)
    ]),
    grpcWebResponse(Uint8Array.from([...validHeight, 0x28, 1]), '7')
  ]
  for (const body of invalidBodies) {
    const fetchFunction = async () =>
      new Response(body, {
        headers: { 'content-type': 'application/grpc-web+proto' }
      })
    await assert.rejects(
      fetchBlockTime('https://rpc.example.com', height, fetchFunction as typeof fetch)
    )
  }
})

test('normalizes safe custom endpoints and drops malformed persisted entries', () => {
  assert.equal(
    normalizeCustomRpcUrl('https://rpc.example.com/lightwalletd/'),
    'https://rpc.example.com/lightwalletd'
  )
  assert.equal(normalizeCustomRpcUrl('http://127.0.0.1:9067/'), 'http://127.0.0.1:9067')
  for (const url of [
    'http://rpc.example.com',
    'http://127.0.0.42:9067/rpc',
    'https://user:pass@rpc.example.com',
    'https://rpc.example.com?token=secret',
    'https://rpc.example.com#fragment'
  ]) {
    assert.throws(() => normalizeCustomRpcUrl(url))
  }

  const endpoint = createCustomRpcEndpoint('', 'https://rpc.example.com/', 'custom:valid')
  assert.equal(endpoint.label, 'rpc.example.com')
  assert.equal(
    createCustomRpcEndpoint('   ', 'https://rpc.example.com:9067/', 'custom:blank-label').label,
    'rpc.example.com:9067'
  )
  assert.deepEqual(
    parseCustomRpcEndpoints({
      zcash: [
        endpoint,
        { ...endpoint, id: 'custom:duplicate' },
        { id: 'managed', label: 'Invalid', url: 'https://invalid.example.com' }
      ]
    }).zcash,
    [endpoint]
  )
})

test('verifies the lightwalletd network identity before accepting a custom endpoint', async () => {
  const endpoint = createCustomRpcEndpoint(
    'Private node',
    'https://rpc.example.com',
    'custom:network-check'
  )
  const fetchMainnet = async () =>
    new Response(grpcWebResponse(lightdInfoMessage('main')), {
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto' }
    })
  await assert.ok((await verifyZcashRpcEndpoint(endpoint, 'mainnet', fetchMainnet)) >= 0)

  const fetchTestnet = async () =>
    new Response(grpcWebResponse(lightdInfoMessage('test')), {
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto' }
    })
  await assert.rejects(verifyZcashRpcEndpoint(endpoint, 'mainnet', fetchTestnet), /not mainnet/)
  await assert.rejects(
    verifyZcashRpcEndpoint(endpoint, 'mainnet', async () => {
      throw new Error('offline')
    }),
    /offline/
  )
})

test('excludes custom endpoints from automatic fallback', () => {
  const customA = createCustomRpcEndpoint('Custom A', 'https://a.example.com', 'custom:a')
  const customB = createCustomRpcEndpoint('Custom B', 'https://b.example.com', 'custom:b')
  setActiveCustomRpcEndpoints({ zcash: [customA, customB] })

  assert.equal(isRpcEndpointUrlConfigured('zcash', customA.url), true)
  assert.equal(getNextRpcEndpointOption('zcash', customA.id, customA.id), undefined)

  setActiveCustomRpcEndpoints()
})

test('migrates the old Zero RPC choice and preserves ordinary fixed choices', () => {
  const upgraded = migrateRpcEndpointDefaults({ zcash: 'zero-indexer' }, { zcash: 'fixed' })
  assert.deepEqual(upgraded.preferences, { zcash: AUTOMATIC_RPC_ENDPOINT_ID })
  assert.deepEqual(upgraded.modes, { zcash: 'auto' })

  const explicitFixed = migrateRpcEndpointDefaults({ zcash: 'custom:private' }, { zcash: 'fixed' })
  assert.deepEqual(explicitFixed.preferences, { zcash: 'custom:private' })
  assert.deepEqual(explicitFixed.modes, { zcash: 'fixed' })
})

test('filters Zero aliases from managed RPC choices', () => {
  const stale = [
    {
      chain: 'zcash' as const,
      label: 'Zcash',
      iconChain: 'zec',
      options: [
        { id: 'deltarpc', label: 'DeltaRPC', url: 'https://rpc.example.com' },
        { id: 'zero-indexer', label: 'Old Zero', url: 'https://old.example.com' },
        { id: 'zero-alias', label: 'Zero alias', url: 'https://tee.unsafe.zec.rocks/' }
      ]
    }
  ]
  const merged = withoutZeroIndexerEndpoints(stale)
  assert.deepEqual(merged[0].options, [stale[0].options[0]])
  assert.equal(stale[0].options[1].url, 'https://old.example.com')
})

test('defaults invalid or missing RPC modes to auto', () => {
  assert.deepEqual(parseRpcEndpointModes(undefined), { zcash: 'auto' })
  assert.deepEqual(parseRpcEndpointModes({ zcash: 'unknown' }), { zcash: 'auto' })
  assert.deepEqual(parseRpcEndpointModes({ zcash: 'fixed' }), { zcash: 'fixed' })
})

test('does not probe Zero or unselected custom endpoints during automatic startup fallback', async () => {
  const [managedEndpoint] = getRpcEndpointOptions('zcash')
  const customA = createCustomRpcEndpoint('Custom A', 'https://a.example.com', 'custom:a')
  const customB = createCustomRpcEndpoint('Custom B', 'https://b.example.com', 'custom:b')
  setActiveCustomRpcEndpoints({ zcash: [customA, customB] })
  const probedIds: string[] = []

  const selected = await selectStartupRpcEndpoint('zcash', 'custom:removed', async endpoint => {
    probedIds.push(endpoint.id)
    return endpoint.id === managedEndpoint.id ? 1 : 2
  })

  assert.equal(selected.id, managedEndpoint.id)
  assert.ok(!probedIds.includes(customA.id))
  assert.ok(!probedIds.includes(customB.id))
  assert.ok(!probedIds.includes('zero-indexer'))

  setActiveCustomRpcEndpoints()
})

test('counts endpoint connectivity errors but ignores local worker timeouts', () => {
  assert.equal(isRpcEndpointError('gRPC transport error: UNAVAILABLE'), true)
  assert.equal(isRpcEndpointError('NetworkError when attempting to fetch resource.'), true)
  assert.equal(
    isRpcEndpointError(
      'Failed to refresh UTXOs: Server(Status { code: Unknown, message: "malformed response", source: Some(MalformedResponse) })'
    ),
    true
  )
  assert.equal(
    isRpcEndpointError('invalid content type: text/html, source: InvalidContentType("text/html")'),
    true
  )
  assert.equal(
    isRpcEndpointError('Failed to resolve chain height from network and wallet summary'),
    true
  )
  assert.equal(isRpcEndpointError('HTTP 502: Bad Gateway'), true)
  assert.equal(isRpcEndpointError('HTTP 429: Too Many Requests'), true)
  assert.equal(isRpcEndpointError('HTTP 400: Bad Request'), false)
  assert.equal(isRpcEndpointError('Offscreen RPC timeout: wallet.getWalletSummary'), false)
  assert.equal(isRpcEndpointError('WALLET_DIRTY'), false)
  assert.equal(
    getRetryableWalletRpcUserMessage('HTTP 502: Bad Gateway'),
    RPC_ENDPOINT_UNAVAILABLE_MESSAGE
  )
})

test('fails over after the first RPC connectivity failure', () => {
  const now = 1_000_000
  const initial = createRpcFailoverState('deltarpc')
  const failedOver = registerRpcFailure(initial, 'deltarpc', 'deltarpc-web', now)

  assert.deepEqual(failedOver.transition, {
    reason: 'failover',
    fromEndpointId: 'deltarpc',
    toEndpointId: 'deltarpc-web'
  })
  assert.equal(failedOver.state.activeEndpointId, 'deltarpc-web')
  assert.equal(failedOver.state.recoverAfter, now + RPC_RECOVERY_COOLDOWN_MS)
})

test('advances from the first fallback to the next configured endpoint', () => {
  const now = 1_500_000
  const firstFallback = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'deltarpc-web',
    now
  ).state
  const secondFallback = registerRpcFailure(firstFallback, 'deltarpc', 'deltarpc-web-1', now + 1)

  assert.deepEqual(secondFallback.transition, {
    reason: 'failover',
    fromEndpointId: 'deltarpc-web',
    toEndpointId: 'deltarpc-web-1'
  })
  assert.equal(secondFallback.state.activeEndpointId, 'deltarpc-web-1')
  assert.equal(secondFallback.state.failedOverAt, now)
})

test('a successful preferred-endpoint sync keeps the preferred endpoint active', () => {
  const state = createRpcFailoverState('deltarpc')
  assert.equal(registerRpcSuccess(state, 'deltarpc'), state)
})

test('a successful fallback sync keeps the fallback active until recovery', () => {
  const state = {
    ...createRpcFailoverState('deltarpc'),
    activeEndpointId: 'chainsafe' as const,
    failedOverAt: 100,
    recoverAfter: 200
  }

  assert.equal(registerRpcSuccess(state, 'deltarpc'), state)
})

test('requires two successful recovery probes before restoring the preferred endpoint', () => {
  const now = 2_000_000
  const failedOver = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'chainsafe',
    now
  ).state

  const firstProbe = registerPreferredRpcProbe(failedOver, 'deltarpc', true, now)
  assert.equal(firstProbe.transition, undefined)
  assert.equal(firstProbe.state.activeEndpointId, 'chainsafe')
  assert.equal(firstProbe.state.preferredProbeSuccesses, 1)
  assert.equal(firstProbe.state.recoverAfter, now + RPC_RECOVERY_PROBE_INTERVAL_MS)

  const recovered = registerPreferredRpcProbe(
    firstProbe.state,
    'deltarpc',
    true,
    now + RPC_RECOVERY_PROBE_INTERVAL_MS
  )
  assert.deepEqual(recovered.transition, {
    reason: 'recovery',
    fromEndpointId: 'chainsafe',
    toEndpointId: 'deltarpc'
  })
  assert.deepEqual(recovered.state, createRpcFailoverState('deltarpc'))
})

test('a failed recovery probe keeps the fallback and restarts the cooldown', () => {
  const now = 3_000_000
  const failedOver = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'chainsafe',
    now
  ).state
  const probeFailed = registerPreferredRpcProbe(failedOver, 'deltarpc', false, now)

  assert.equal(probeFailed.transition, undefined)
  assert.equal(probeFailed.state.activeEndpointId, 'chainsafe')
  assert.equal(probeFailed.state.preferredProbeSuccesses, 0)
  assert.equal(probeFailed.state.recoverAfter, now + RPC_RECOVERY_COOLDOWN_MS)
})

test('changing the preferred endpoint discards stale failover state', () => {
  const stale = {
    ...createRpcFailoverState('deltarpc'),
    activeEndpointId: 'chainsafe' as const,
    failedOverAt: 100,
    recoverAfter: 200
  }

  assert.deepEqual(registerRpcSuccess(stale, 'chainsafe'), createRpcFailoverState('chainsafe'))
})
