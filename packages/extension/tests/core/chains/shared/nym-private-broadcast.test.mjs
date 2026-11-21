import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NYM_PRIVATE_BROADCAST_PORT_MESSAGE,
  planNymTunnelClient,
  nymPrewarmOrigins,
  requiresNymRoute,
  requiresZcashNodeRpcNymRoute
} from '../../../../src/core/nym/private-broadcast-protocol.ts'
import { installNymPrivateBroadcastFetch } from '../../../../src/core/nym/worker-private-broadcast-fetch.ts'
import { serveNymWorkerPort } from '../../../../src/core/nym/worker-port-host.ts'
import {
  getRetryableWalletRpcUserMessage,
  NYM_BROADCAST_INCOMPLETE_MESSAGE,
  NYM_BROADCAST_UNAVAILABLE_MESSAGE,
  RPC_ENDPOINT_UNAVAILABLE_MESSAGE
} from '../../../../src/core/zcash/wallet-rpc-errors.ts'

const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer'
const LIGHTWALLETD = 'https://lightwalletd.example'
const ZERO_INDEXER = 'https://zero-indexer.example'

const ALL_ROUTES = {
  broadcast: true,
  feeQuote: true,
  transactionLookup: true,
  transparentHistory: true,
  transparentUtxos: true
}
const ROUTED_METHODS = [
  ['SendTransaction', 'broadcast'],
  ['GetStandardFee', 'feeQuote'],
  ['GetTransaction', 'transactionLookup'],
  ['GetTaddressTxids', 'transparentHistory'],
  ['GetTaddressTransactions', 'transparentHistory'],
  ['GetAddressUtxos', 'transparentUtxos'],
  ['GetAddressUtxosStream', 'transparentUtxos'],
  ['GetTaddressBalance', 'transparentUtxos'],
  ['GetTaddressBalanceStream', 'transparentUtxos']
]

function createScope(overrides = {}, { routeWalletSync = false } = {}) {
  const routes = { ...ALL_ROUTES, ...overrides }
  const listeners = []
  const directCalls = []
  const directBodies = []
  const scope = {
    fetch: async (input, init) => {
      directCalls.push(String(input instanceof Request ? input.url : input))
      if (input instanceof Request && input.method === 'POST') {
        directBodies.push([...new Uint8Array(await input.arrayBuffer())])
      }
      return new Response(new Uint8Array([1]), { status: 200 })
    },
    addEventListener: (_type, listener) => listeners.push(listener)
  }
  const controller = installNymPrivateBroadcastFetch(scope, {
    requestTimeoutMs: 200,
    modeTimeoutMs: 100,
    base: 'chrome-extension://test/worker.js',
    routes,
    routeWalletSync
  })
  const connect = handler => {
    const channel = new MessageChannel()
    channel.port1.onmessage = event => handler(event.data, channel.port1)
    let propagationStopped = false
    for (const listener of listeners) {
      listener({
        data: { type: NYM_PRIVATE_BROADCAST_PORT_MESSAGE },
        ports: [channel.port2],
        stopImmediatePropagation: () => {
          propagationStopped = true
        }
      })
    }
    assert.equal(propagationStopped, true)
    return channel
  }
  /** Connects a host that reports Nym routing as on and hands private requests to `onFetch`. */
  const connectEnabled = onFetch =>
    connect((message, port) => {
      if (message.kind === 'mode') {
        port.postMessage({ id: message.id, ok: true, kind: 'mode', enabled: true })
      } else {
        onFetch(message, port)
      }
    })
  return { scope, controller, directCalls, directBodies, connect, connectEnabled }
}

const send = (scope, origin = LIGHTWALLETD, init = {}) =>
  scope.fetch(
    new Request(`${origin}/${SERVICE}/SendTransaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto' },
      body: new Uint8Array([0, 0, 0, 0, 2, 9, 9]),
      ...init
    })
  )

test('Zcash request categories route independently at every lightwalletd endpoint', () => {
  for (const [method, category] of ROUTED_METHODS) {
    for (const origin of [LIGHTWALLETD, ZERO_INDEXER]) {
      const url = new URL(`${origin}/prefix/${SERVICE}/${method}`)
      assert.equal(requiresNymRoute(url, ALL_ROUTES), true, method)
      for (const disabled of Object.keys(ALL_ROUTES)) {
        assert.equal(
          requiresNymRoute(url, { ...ALL_ROUTES, [disabled]: false }),
          disabled !== category,
          `${method} with ${disabled} disabled`
        )
      }
    }
  }
  for (const path of [
    `${SERVICE}/GetBlockRange`,
    `${SERVICE}/GetLatestBlock`,
    `${SERVICE}/GetTreeState`,
    `${SERVICE}/GetSubtreeRoots`,
    `${SERVICE}/GetLightdInfo`,
    'SendTransaction',
    'shielded-vote/v1/cast-vote',
    'eth_getBalance'
  ]) {
    assert.equal(requiresNymRoute(new URL(`${LIGHTWALLETD}/${path}`), ALL_ROUTES), false, path)
  }
})

test('Zcash node JSON-RPC methods use the same categories without capturing unrelated reads', () => {
  for (const [method, category] of [
    ['getrawtransaction', 'transactionLookup'],
    ['getblockcount', 'transactionLookup'],
    ['getaddresstxids', 'transparentHistory']
  ]) {
    assert.equal(requiresZcashNodeRpcNymRoute(method, ALL_ROUTES), true)
    for (const disabled of Object.keys(ALL_ROUTES)) {
      assert.equal(
        requiresZcashNodeRpcNymRoute(method, { ...ALL_ROUTES, [disabled]: false }),
        disabled !== category
      )
    }
  }
  assert.equal(requiresZcashNodeRpcNymRoute('getblockchaininfo', ALL_ROUTES), false)
  assert.equal(requiresZcashNodeRpcNymRoute('eth_sendRawTransaction', ALL_ROUTES), false)
})

test('a broadcast without a tunnel port fails closed and never uses the direct fetch', async () => {
  const { scope, controller, directCalls } = createScope()
  await assert.rejects(send(scope), /Private broadcast network unavailable/)
  assert.deepEqual(directCalls, [])
  assert.equal(controller.stats.blocked, 1)

  await scope.fetch(`${LIGHTWALLETD}/${SERVICE}/GetBlockRange`, { method: 'POST' })
  assert.deepEqual(directCalls, [`${LIGHTWALLETD}/${SERVICE}/GetBlockRange`])
})

test('a broadcast travels through the tunnel port and returns the tunnel response', async () => {
  const { scope, controller, directCalls, connectEnabled } = createScope()
  const seen = []
  const channel = connectEnabled((message, port) => {
    seen.push(message.request)
    const body = new Uint8Array([0, 0, 0, 0, 1, 7])
    port.postMessage(
      {
        id: message.id,
        ok: true,
        kind: 'fetch',
        response: {
          status: 200,
          statusText: 'OK',
          headers: [['content-type', 'application/grpc-web+proto']],
          body
        }
      },
      [body.buffer]
    )
  })
  try {
    const response = await send(scope)
    assert.equal(response.status, 200)
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 0, 0, 0, 1, 7])
    assert.equal(seen[0].method, 'POST')
    assert.deepEqual([...seen[0].body], [0, 0, 0, 0, 2, 9, 9])
    assert.ok(seen[0].headers.some(([name]) => name === 'content-type'))
    assert.deepEqual(directCalls, [])
    assert.equal(controller.stats.routed, 1)
  } finally {
    channel.port1.close()
  }
})

test('tunnel errors, timeouts and aborts reject without a direct fallback', async () => {
  const { scope, controller, directCalls, connectEnabled } = createScope()
  const received = []
  const withdrawn = []
  const channel = connectEnabled((message, port) => {
    if (message.kind === 'cancel') {
      withdrawn.push(message.id)
      return
    }
    received.push(message.id)
    if (message.request.url.startsWith(ZERO_INDEXER)) {
      port.postMessage({ id: message.id, ok: false, error: 'exit 3ts3snXy stopped forwarding' })
    }
    // Other requests get no reply, so they time out or are aborted.
  })
  try {
    // The request entered the tunnel, so its outcome is unknown; tunnel details stay out.
    await assert.rejects(send(scope, ZERO_INDEXER), {
      name: 'TypeError',
      message: 'Private broadcast did not complete'
    })
    await assert.rejects(send(scope), { message: 'Private broadcast did not complete' })
    // The host is told to withdraw the request it never answered.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(withdrawn.length, 1)
    const controllerSignal = new AbortController()
    const aborted = send(scope, LIGHTWALLETD, { signal: controllerSignal.signal })
    controllerSignal.abort()
    await assert.rejects(aborted, error => error.name === 'AbortError')

    // Aborted by the WASM's own deadline while the request is with the tunnel host.
    const inTunnel = new AbortController()
    const abandoned = send(scope, LIGHTWALLETD, { signal: inTunnel.signal })
    while (received.length < 3) await new Promise(resolve => setImmediate(resolve))
    inTunnel.abort()
    await assert.rejects(abandoned, error => error.name === 'AbortError')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(withdrawn, [received[1], received[2]])
    assert.deepEqual(directCalls, [])
    assert.equal(controller.stats.blocked, 4)
  } finally {
    channel.port1.close()
  }
})

test('with Nym routing turned off a broadcast uses the direct fetch with its body intact', async () => {
  const { scope, controller, directCalls, directBodies, connect } = createScope()
  const kinds = []
  const channel = connect((message, port) => {
    kinds.push(message.kind)
    if (message.kind === 'mode') {
      port.postMessage({ id: message.id, ok: true, kind: 'mode', enabled: false })
    }
  })
  try {
    const response = await send(scope)
    assert.equal(response.status, 200)
    assert.deepEqual(directCalls, [`${LIGHTWALLETD}/${SERVICE}/SendTransaction`])
    assert.deepEqual(directBodies, [[0, 0, 0, 0, 2, 9, 9]])
    assert.deepEqual(kinds, ['mode'])
    assert.deepEqual({ ...controller.stats }, { routed: 0, blocked: 0, direct: 1 })
  } finally {
    channel.port1.close()
  }
})

test('the routing choice is asked again for every broadcast', async () => {
  const { scope, controller, directCalls, connect } = createScope()
  let enabled = false
  const channel = connect((message, port) => {
    if (message.kind === 'mode') {
      port.postMessage({ id: message.id, ok: true, kind: 'mode', enabled })
    } else {
      port.postMessage({ id: message.id, ok: false, error: 'exit unreachable' })
    }
  })
  try {
    await send(scope)
    assert.equal(directCalls.length, 1)
    enabled = true
    await assert.rejects(send(scope), /Private broadcast did not complete/)
    assert.equal(directCalls.length, 1)
    assert.deepEqual({ ...controller.stats }, { routed: 0, blocked: 1, direct: 1 })
  } finally {
    channel.port1.close()
  }
})

test('an unanswered, failed or malformed routing answer blocks the broadcast', async () => {
  const { scope, controller, directCalls, connect } = createScope()
  const answers = [
    null,
    { ok: false, error: 'Could not load privacy preference' },
    { ok: true, kind: 'mode', enabled: 'false' },
    { ok: true, kind: 'mode' },
    { ok: true, kind: 'fetch', enabled: false }
  ]
  const channel = connect((message, port) => {
    const answer = answers.shift()
    if (answer) port.postMessage({ id: message.id, ...answer })
  })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(send(scope), {
        name: 'TypeError',
        message: 'Private broadcast network unavailable'
      })
    }
    assert.deepEqual(directCalls, [])
    assert.deepEqual({ ...controller.stats }, { routed: 0, blocked: 5, direct: 0 })
  } finally {
    channel.port1.close()
  }
})

test('a tunnel that could not be built reports the broadcast as never sent', async () => {
  const { scope, directCalls, connectEnabled } = createScope()
  const channel = connectEnabled((message, port) => {
    port.postMessage({
      id: message.id,
      ok: false,
      error: 'Private broadcast network unavailable: gateway client error (3ts3snXy)'
    })
  })
  try {
    await assert.rejects(send(scope), {
      name: 'TypeError',
      message: 'Private broadcast network unavailable'
    })
    assert.deepEqual(directCalls, [])
  } finally {
    channel.port1.close()
  }
})

test('a broadcast stopped by Nym is explained instead of blaming the RPC endpoint', () => {
  const wrapped = cause =>
    `All zero-indexer endpoints failed: zero-indexer endpoint ${ZERO_INDEXER}: error sending request: TypeError: ${cause}`
  assert.equal(
    getRetryableWalletRpcUserMessage(wrapped('Private broadcast network unavailable')),
    NYM_BROADCAST_UNAVAILABLE_MESSAGE
  )
  assert.equal(
    getRetryableWalletRpcUserMessage(wrapped('Private broadcast did not complete')),
    NYM_BROADCAST_INCOMPLETE_MESSAGE
  )
  // One uncertain attempt outweighs attempts that were never sent.
  assert.equal(
    getRetryableWalletRpcUserMessage(
      `${wrapped('Private broadcast did not complete')}; ${wrapped('Private broadcast network unavailable')}`
    ),
    NYM_BROADCAST_INCOMPLETE_MESSAGE
  )
  assert.equal(
    getRetryableWalletRpcUserMessage(wrapped('Failed to fetch: net::ERR_CONNECTION_RESET')),
    RPC_ENDPOINT_UNAVAILABLE_MESSAGE
  )
})

test('the tunnel host answers the routing question and forwards private requests', async t => {
  const channel = new MessageChannel()
  t.after(() => {
    channel.port1.close()
    channel.port2.close()
  })
  let enabled = true
  const fetched = []
  let releaseSlow
  let slowSignal
  const slow = new Promise(resolve => {
    releaseSlow = resolve
  })
  serveNymWorkerPort(channel.port1, {
    isEnabled: async () => {
      if (enabled === null) throw new Error('Could not load privacy preference')
      return enabled
    },
    fetch: async (request, signal) => {
      fetched.push(request.url)
      if (request.url.startsWith(ZERO_INDEXER)) throw new Error('exit unreachable')
      if (request.url.endsWith('/slow')) {
        slowSignal = signal
        await slow
        if (signal.aborted) throw new Error('withdrawn before sending')
      }
      return { status: 200, statusText: 'OK', headers: [], body: new Uint8Array([7]) }
    }
  })
  const ask = message =>
    new Promise(resolve => {
      channel.port2.onmessage = event => resolve(event.data)
      channel.port2.postMessage(message)
    })
  const request = url => ({ url, method: 'POST', headers: [], body: new Uint8Array([1]) })

  assert.deepEqual(await ask({ id: 1, kind: 'mode' }), {
    id: 1,
    ok: true,
    kind: 'mode',
    enabled: true
  })
  enabled = false
  assert.deepEqual(await ask({ id: 2, kind: 'mode' }), {
    id: 2,
    ok: true,
    kind: 'mode',
    enabled: false
  })
  enabled = null
  assert.deepEqual(await ask({ id: 3, kind: 'mode' }), {
    id: 3,
    ok: false,
    error: 'Could not load privacy preference'
  })

  const routed = await ask({ id: 4, kind: 'fetch', request: request(LIGHTWALLETD) })
  assert.equal(routed.ok, true)
  assert.equal(routed.kind, 'fetch')
  assert.deepEqual([...routed.response.body], [7])
  assert.deepEqual(await ask({ id: 5, kind: 'fetch', request: request(ZERO_INDEXER) }), {
    id: 5,
    ok: false,
    error: 'exit unreachable'
  })
  assert.deepEqual(fetched, [LIGHTWALLETD, ZERO_INDEXER])

  // A request the Worker withdrew is not sent once the tunnel becomes ready.
  const pendingReply = new Promise(resolve => {
    channel.port2.onmessage = event => resolve(event.data)
  })
  channel.port2.postMessage({ id: 6, kind: 'fetch', request: request(`${LIGHTWALLETD}/slow`) })
  channel.port2.postMessage({ id: 6, kind: 'cancel' })
  for (let tick = 0; tick < 100 && !slowSignal?.aborted; tick++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  releaseSlow()
  assert.deepEqual(await pendingReply, { id: 6, ok: false, error: 'withdrawn before sending' })
})

test('each enabled category uses the tunnel and fails closed; disabled categories remain direct', async () => {
  for (const [method, category] of ROUTED_METHODS) {
    const url = `${LIGHTWALLETD}/${SERVICE}/${method}`
    const request = scope =>
      scope.fetch(new Request(url, { method: 'POST', body: new Uint8Array([1, 2]) }))
    {
      const { scope, directCalls, connectEnabled } = createScope()
      const seen = []
      const channel = connectEnabled((message, port) => {
        seen.push(message.request)
        port.postMessage({
          id: message.id,
          ok: true,
          kind: 'fetch',
          // Multiple gRPC-Web data/trailer frames must survive byte-for-byte, including streams.
          response: {
            status: 200,
            statusText: 'OK',
            headers: [],
            body: new Uint8Array([0, 0, 0, 0, 1, 7, 0, 0, 0, 0, 1, 8, 128, 0, 0, 0, 0])
          }
        })
      })
      try {
        const response = await request(scope)
        assert.deepEqual(
          [...new Uint8Array(await response.arrayBuffer())],
          [0, 0, 0, 0, 1, 7, 0, 0, 0, 0, 1, 8, 128, 0, 0, 0, 0]
        )
        assert.equal(seen[0].url, url)
        assert.deepEqual([...seen[0].body], [1, 2])
        assert.deepEqual(directCalls, [])
      } finally {
        channel.port1.close()
      }
    }
    {
      const { scope, directCalls } = createScope()
      await assert.rejects(request(scope), /Private broadcast network unavailable/)
      assert.deepEqual(directCalls, [], method)
    }
    {
      const { scope, directCalls, directBodies } = createScope({ [category]: false })
      await request(scope)
      assert.deepEqual(directCalls, [url])
      assert.deepEqual(directBodies, [[1, 2]])
    }
    {
      const { scope, directCalls, connect } = createScope()
      const channel = connect((message, port) => {
        assert.equal(message.kind, 'mode')
        port.postMessage({ id: message.id, ok: true, kind: 'mode', enabled: false })
      })
      try {
        await request(scope)
        assert.deepEqual(directCalls, [url])
      } finally {
        channel.port1.close()
      }
    }
    {
      const { scope, directCalls, connectEnabled } = createScope()
      const channel = connectEnabled((message, port) => {
        port.postMessage({ id: message.id, ok: false, error: 'tunnel failed' })
      })
      try {
        await assert.rejects(request(scope), /Private broadcast did not complete/)
        assert.deepEqual(directCalls, [], method)
      } finally {
        channel.port1.close()
      }
    }
  }
})

test('wallet sync reads go direct only while a sync step runs and no send is under way', async () => {
  const syncMethods = ROUTED_METHODS.filter(
    ([, category]) => category !== 'broadcast' && category !== 'feeQuote'
  ).map(([method]) => method)
  for (const [method] of ROUTED_METHODS) {
    const url = new URL(`${LIGHTWALLETD}/${SERVICE}/${method}`)
    assert.equal(requiresNymRoute(url, ALL_ROUTES, true), !syncMethods.includes(method), method)
  }

  const read = (scope, method) =>
    scope.fetch(new Request(`${LIGHTWALLETD}/${SERVICE}/${method}`, { method: 'POST', body: '' }))
  const unavailable = /Private broadcast network unavailable/
  // No tunnel port is connected, so a routed request rejects and never reaches the direct fetch.
  const { scope, controller, directCalls } = createScope()

  await controller.duringWalletSync(async () => {
    for (const method of syncMethods) await read(scope, method)
    assert.equal(directCalls.length, syncMethods.length)
    await assert.rejects(send(scope), unavailable)
    await assert.rejects(read(scope, 'GetStandardFee'), unavailable)

    const endSend = controller.beginSend()
    await assert.rejects(read(scope, 'GetTransaction'), unavailable)
    endSend()
    endSend()
    await read(scope, 'GetTransaction')
  })
  assert.equal(directCalls.length, syncMethods.length + 1)

  await assert.rejects(read(scope, 'GetAddressUtxosStream'), unavailable)
  await assert.rejects(
    controller.duringWalletSync(async () => {
      throw new Error('sync failed')
    }),
    /sync failed/
  )
  await assert.rejects(read(scope, 'GetAddressUtxosStream'), unavailable)

  const endSend = controller.beginSend()
  await controller.duringWalletSync(async () => {
    await assert.rejects(read(scope, 'GetTaddressTxids'), unavailable)
  })
  endSend()
  assert.equal(directCalls.length, syncMethods.length + 1)

  const routedSync = createScope({}, { routeWalletSync: true })
  await routedSync.controller.duringWalletSync(async () => {
    await assert.rejects(read(routedSync.scope, 'GetAddressUtxosStream'), unavailable)
  })
  assert.deepEqual(routedSync.directCalls, [])
})

test('the routing choice is reported as on, off, or unknown when it cannot be learned', async () => {
  const { controller, connect, connectEnabled } = createScope()
  const channels = []
  assert.equal(await controller.readRoutingChoice(), null)

  channels.push(connectEnabled(() => {}))
  assert.equal(await controller.readRoutingChoice(), true)

  channels.push(
    connect((message, port) =>
      port.postMessage({ id: message.id, ok: true, kind: 'mode', enabled: false })
    )
  )
  assert.equal(await controller.readRoutingChoice(), false)

  channels.push(
    connect((message, port) => port.postMessage({ id: message.id, ok: false, error: 'no host' }))
  )
  assert.equal(await controller.readRoutingChoice(), null)

  // A host that never answers counts as unknown once the mode timeout passes.
  channels.push(connect(() => {}))
  assert.equal(await controller.readRoutingChoice(), null)
  for (const channel of channels) channel.port1.close()
})

test('prewarm destinations are reduced to a bounded list of distinct HTTPS origins', () => {
  assert.deepEqual(
    nymPrewarmOrigins([
      `${ZERO_INDEXER}/v1?key=secret`,
      LIGHTWALLETD,
      `${ZERO_INDEXER}/other`,
      'http://plain.example',
      'not a url',
      '',
      undefined,
      7
    ]),
    [ZERO_INDEXER, LIGHTWALLETD]
  )
  assert.equal(
    nymPrewarmOrigins(Array.from({ length: 20 }, (_, index) => `https://node-${index}.example`))
      .length,
    8
  )
})

test('tunnels keep their client until it is replaced, and only stale tunnel clients are deleted', () => {
  const walletDatabases = [
    'zcash-wallet-db',
    'noir-diagnostic-logs',
    'backup-wasm-client-storage-a'
  ]
  const create = () => 'new'

  // The current client is kept; a replaced one is stale.
  assert.deepEqual(
    planNymTunnelClient(
      'b',
      [...walletDatabases, 'wasm-client-storage-a', 'wasm-client-storage-b', undefined],
      create
    ),
    { clientId: 'b', staleDatabases: ['wasm-client-storage-a'] }
  )
  // A new offscreen document adopts the client an earlier one stored, with its gateway.
  assert.deepEqual(
    planNymTunnelClient(null, [...walletDatabases, 'wasm-client-storage-smolmix-x'], create),
    { clientId: 'smolmix-x', staleDatabases: [] }
  )
  // Without a stored client, a new one is registered.
  assert.deepEqual(planNymTunnelClient(null, walletDatabases, create), {
    clientId: 'new',
    staleDatabases: []
  })
})
