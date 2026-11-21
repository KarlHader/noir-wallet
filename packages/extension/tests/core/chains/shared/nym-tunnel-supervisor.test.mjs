import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NymTunnelSupervisor } from '../../../../src/core/nym/tunnel-supervisor.ts'

const NODE = 'https://node.example'
const OTHER = 'https://other.example'
const TIMEOUTS = { setup: 90, check: 60, recheck: 20, fetch: 150 }
const FRESH_MS = 1_000

const ok = () => ({ status: 200, statusText: 'OK', headers: [], body: new Uint8Array([1]) })
const send = origin => ({
  url: `${origin}/svc/SendTransaction`,
  method: 'POST',
  headers: [],
  body: new Uint8Array([9])
})

/**
 * A supervisor over scripted tunnels. `respond(request, link)` decides every tunnel answer;
 * each link records its calls as `METHOD url@timeout`.
 */
function createHarness(respond = () => ok()) {
  const harness = { time: 0, links: [], respond, opening: null }
  const openLink = async () => {
    if (harness.opening) await harness.opening
    const pending = new Set()
    const link = {
      index: harness.links.length,
      calls: [],
      alive: true,
      closed: false,
      async setup(timeoutMs) {
        link.calls.push(`setup@${timeoutMs}`)
      },
      fetch(request, timeoutMs) {
        link.calls.push(`${request.method} ${request.url}@${timeoutMs}`)
        return new Promise((resolve, reject) => {
          pending.add(reject)
          Promise.resolve()
            .then(() => harness.respond(request, link))
            .then(resolve, reject)
        })
      },
      isAlive: () => link.alive && !link.closed,
      close() {
        link.closed = true
        for (const reject of pending) reject(new Error('Private broadcast network was reset'))
      }
    }
    harness.links.push(link)
    return link
  }
  harness.supervisor = new NymTunnelSupervisor({
    openLink,
    now: () => harness.time,
    setupTimeoutMs: TIMEOUTS.setup,
    healthCheckTimeoutMs: TIMEOUTS.check,
    recheckTimeoutMs: TIMEOUTS.recheck,
    healthFreshMs: FRESH_MS,
    fetchTimeoutMs: TIMEOUTS.fetch,
    maxBuildAttempts: 3
  })
  return harness
}

const isProbe = request => request.method === 'GET'
const challenged = () => ({
  status: 403,
  statusText: 'Forbidden',
  headers: [
    ['Server', 'cloudflare'],
    ['CF-Mitigated', 'challenge']
  ],
  body: new Uint8Array([1])
})

test('the first request builds a tunnel, proves the destination, then sends', async () => {
  const harness = createHarness()
  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  assert.equal(harness.links.length, 1)
  assert.deepEqual(harness.links[0].calls, [
    `setup@${TIMEOUTS.setup}`,
    `GET ${NODE}/@${TIMEOUTS.check}`,
    `POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`
  ])
})

test('a tunnel that cannot reach the destination is replaced', async () => {
  const harness = createHarness((request, link) => {
    if (link.index === 0) throw new Error('exit unreachable')
    return ok()
  })
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 2)
  assert.equal(harness.links[0].closed, true)
  // The request itself never entered the unusable tunnel.
  assert.deepEqual(harness.links[0].calls, [
    `setup@${TIMEOUTS.setup}`,
    `GET ${NODE}/@${TIMEOUTS.check}`
  ])
  assert.equal(harness.links[1].closed, false)
})

test('an exit the destination challenges is replaced before the request is sent', async () => {
  const harness = createHarness((request, link) => (link.index === 0 ? challenged() : ok()))
  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  assert.equal(harness.links.length, 2)
  assert.equal(harness.links[0].closed, true)
  assert.ok(!harness.links[0].calls.some(call => call.startsWith('POST')))
  assert.ok(harness.links[1].calls.includes(`POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`))
})

test("a destination's own refusal still proves the tunnel reaches it", async () => {
  const forbidden = () => ({ ...ok(), status: 403, statusText: 'Forbidden' })
  const harness = createHarness(request => (isProbe(request) ? forbidden() : ok()))
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 1)
  assert.ok(harness.links[0].calls.some(call => call.startsWith('POST')))
})

test('an exit challenged after it was proven is replaced before the next request', async () => {
  let challenging = false
  const harness = createHarness((request, link) =>
    challenging && link.index === 0 ? challenged() : ok()
  )
  await harness.supervisor.fetch(send(NODE))
  challenging = true

  // The challenged answer goes back to the caller; the request is not repeated.
  const refused = await harness.supervisor.fetch(send(NODE))
  assert.equal(refused.status, 403)
  assert.equal(harness.links.length, 1)

  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  assert.equal(harness.links.length, 2)
  assert.equal(harness.links[0].closed, true)
  assert.deepEqual(harness.links[0].calls.slice(3), [
    `POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`,
    `GET ${NODE}/@${TIMEOUTS.check}`
  ])
})

test('the request is refused once every allowed tunnel failed its destination check', async () => {
  const harness = createHarness(() => {
    throw new Error('exit unreachable')
  })
  await assert.rejects(
    harness.supervisor.fetch(send(NODE)),
    /Private broadcast network unavailable: exit unreachable/
  )
  assert.equal(harness.links.length, 3)
  assert.ok(harness.links.every(link => link.closed))
  assert.ok(harness.links.every(link => !link.calls.some(call => call.startsWith('POST'))))
})

test('a recently proven destination is used without another check', async () => {
  const harness = createHarness()
  await harness.supervisor.fetch(send(NODE))
  harness.time += FRESH_MS
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].calls.filter(call => call.startsWith('GET')).length, 1)
  // A completed request proves the destination again.
  harness.time += FRESH_MS
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links[0].calls.filter(call => call.startsWith('GET')).length, 1)
})

test('an idle tunnel is checked again briefly before it carries a request', async () => {
  const harness = createHarness()
  await harness.supervisor.fetch(send(NODE))
  harness.time += FRESH_MS + 1
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 1)
  assert.deepEqual(harness.links[0].calls.slice(3), [
    `GET ${NODE}/@${TIMEOUTS.recheck}`,
    `POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`
  ])
})

test('an idle tunnel that stopped forwarding is rebuilt before the request is sent', async () => {
  let dead = false
  const harness = createHarness((request, link) => {
    if (dead && link.index === 0) throw new Error('Nym tunnel fetch timed out')
    return ok()
  })
  await harness.supervisor.fetch(send(NODE))
  dead = true
  harness.time += FRESH_MS + 1

  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  assert.equal(harness.links.length, 2)
  assert.equal(harness.links[0].closed, true)
  // The dead tunnel saw only the brief check, not the request.
  assert.deepEqual(harness.links[0].calls.slice(3), [`GET ${NODE}/@${TIMEOUTS.recheck}`])
  assert.deepEqual(harness.links[1].calls, [
    `setup@${TIMEOUTS.setup}`,
    `GET ${NODE}/@${TIMEOUTS.check}`,
    `POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`
  ])
})

test('a dead idle tunnel does not use up an attempt to build its replacement', async () => {
  let dead = false
  const harness = createHarness((request, link) => {
    // The idle tunnel stopped forwarding, and the next two exits fail their check too.
    if (dead && link.index <= 2) throw new Error('Nym tunnel fetch timed out')
    return ok()
  })
  await harness.supervisor.fetch(send(NODE))
  dead = true
  harness.time += FRESH_MS + 1

  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  assert.equal(harness.links.length, 4)
  assert.ok(harness.links.slice(0, 3).every(link => link.closed))
  assert.ok(harness.links[3].calls.includes(`POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`))
})

test('a failed request discards the tunnel and the next request rebuilds it', async () => {
  let failRequests = true
  const harness = createHarness(request => {
    if (!isProbe(request) && failRequests) throw new Error('Nym tunnel fetch timed out')
    return ok()
  })
  await assert.rejects(harness.supervisor.fetch(send(NODE)), /Nym tunnel fetch timed out/)
  assert.equal(harness.links[0].closed, true)
  // The request may have reached the node, so it is not repeated on a new tunnel.
  assert.equal(harness.links.length, 1)

  failRequests = false
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 2)
})

test('an unreachable destination does not reset a tunnel that just served another one', async () => {
  const harness = createHarness(request => {
    if (request.url.startsWith(OTHER)) throw new Error('TLS handshake rejected')
    return ok()
  })
  await harness.supervisor.fetch(send(NODE))
  await assert.rejects(
    harness.supervisor.fetch(send(OTHER)),
    /Private broadcast network unavailable: TLS handshake rejected/
  )
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].closed, false)
  assert.equal(harness.links[0].calls.filter(call => call.startsWith(`GET ${OTHER}`)).length, 1)

  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 1)
})

test('a request is not failed by another destination that cannot be reached', async () => {
  const harness = createHarness(request => {
    if (request.url.startsWith(OTHER)) throw new Error('TLS handshake rejected')
    return ok()
  })
  const unreachable = assert.rejects(
    harness.supervisor.fetch(send(OTHER)),
    /Private broadcast network unavailable/
  )
  const response = await harness.supervisor.fetch(send(NODE))
  await unreachable
  assert.equal(response.status, 200)
  // Only tunnels that failed the other destination's check were discarded.
  assert.equal(harness.links.at(-1).closed, false)
  assert.ok(
    harness.links.at(-1).calls.includes(`POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`)
  )
})

test('a failing destination check does not interrupt a request already in the tunnel', async () => {
  let releaseRequest
  const requestGate = new Promise(resolve => {
    releaseRequest = resolve
  })
  const harness = createHarness(async request => {
    if (request.url.startsWith(OTHER)) {
      // The check fails only after the first destination is no longer recently proven.
      harness.time += FRESH_MS + 1
      throw new Error('Nym tunnel fetch timed out')
    }
    if (!isProbe(request)) await requestGate
    return ok()
  })
  const inFlight = harness.supervisor.fetch(send(NODE))
  while (!harness.links[0]?.calls.some(call => call.startsWith('POST'))) {
    await new Promise(resolve => setImmediate(resolve))
  }
  await assert.rejects(
    harness.supervisor.fetch(send(OTHER)),
    /Private broadcast network unavailable/
  )
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].closed, false)

  releaseRequest()
  assert.equal((await inFlight).status, 200)
})

test('a request withdrawn while the tunnel was being built is never sent', async () => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const harness = createHarness(async request => {
    if (isProbe(request)) await gate
    return ok()
  })
  const withdrawn = new AbortController()
  const request = harness.supervisor.fetch(send(NODE), withdrawn.signal)
  const rejected = assert.rejects(request, /^Error: Private broadcast network unavailable/)
  while (harness.links.length === 0 || harness.links[0].calls.length < 2) {
    await new Promise(resolve => setImmediate(resolve))
  }
  // The Worker gave up (its own deadline passed) before the tunnel was ready.
  withdrawn.abort()
  release()
  await rejected
  assert.ok(!harness.links[0].calls.some(call => call.startsWith('POST')))
  // The tunnel that finished building serves the retry at once.
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 1)
})

test('a failed request does not interrupt another request in the same tunnel', async () => {
  let releaseRequest
  const requestGate = new Promise(resolve => {
    releaseRequest = resolve
  })
  const harness = createHarness(async request => {
    if (isProbe(request)) return ok()
    if (request.url.startsWith(OTHER)) throw new Error('Nym tunnel fetch timed out')
    await requestGate
    return ok()
  })
  const inFlight = harness.supervisor.fetch(send(NODE))
  while (!harness.links[0]?.calls.some(call => call.startsWith(`POST ${NODE}`))) {
    await new Promise(resolve => setImmediate(resolve))
  }
  await assert.rejects(harness.supervisor.fetch(send(OTHER)), /Nym tunnel fetch timed out/)
  assert.equal(harness.links[0].closed, false)

  releaseRequest()
  assert.equal((await inFlight).status, 200)
  assert.equal(harness.links.length, 1)
  // The destination that failed must prove itself again before its next request.
  await assert.rejects(harness.supervisor.fetch(send(OTHER)), /Nym tunnel fetch timed out/)
  assert.equal(
    harness.links[0].calls.filter(call => call === `GET ${OTHER}/@${TIMEOUTS.check}`).length,
    2
  )
})

test('a request after a close starts its own tunnel instead of joining the stopped build', async () => {
  const harness = createHarness()
  let release
  harness.opening = new Promise(resolve => {
    release = resolve
  })
  const stopped = harness.supervisor.prewarm([NODE])
  await new Promise(resolve => setImmediate(resolve))
  harness.supervisor.close()
  harness.opening = null

  const response = await harness.supervisor.fetch(send(NODE))
  assert.equal(response.status, 200)
  release()
  await stopped
  assert.equal(harness.links.filter(link => !link.closed).length, 1)
})

test('a tunnel whose page disappeared is rebuilt', async () => {
  const harness = createHarness()
  await harness.supervisor.fetch(send(NODE))
  harness.links[0].alive = false
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 2)
  assert.equal(harness.links[0].closed, true)
})

test('concurrent requests share one tunnel build', async () => {
  const harness = createHarness()
  await Promise.all([
    harness.supervisor.fetch(send(NODE)),
    harness.supervisor.fetch(send(NODE)),
    harness.supervisor.fetch(send(OTHER))
  ])
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].calls.filter(call => call.startsWith('setup')).length, 1)
  assert.equal(harness.links[0].calls.filter(call => call.startsWith(`GET ${NODE}`)).length, 1)
  assert.equal(harness.links[0].calls.filter(call => call.startsWith(`GET ${OTHER}`)).length, 1)
})

test('prewarming proves destinations ahead of the first request and never rejects', async () => {
  const harness = createHarness(request => {
    if (request.url.startsWith(OTHER)) throw new Error('TLS handshake rejected')
    return ok()
  })
  await harness.supervisor.prewarm([NODE, OTHER, 'not a url'])
  assert.equal(harness.links.length, 1)
  assert.deepEqual(harness.links[0].calls, [
    `setup@${TIMEOUTS.setup}`,
    `GET ${NODE}/@${TIMEOUTS.check}`,
    `GET ${OTHER}/@${TIMEOUTS.check}`
  ])

  await harness.supervisor.fetch(send(NODE))
  assert.deepEqual(harness.links[0].calls.slice(3), [
    `POST ${NODE}/svc/SendTransaction@${TIMEOUTS.fetch}`
  ])
})

test('closing drops the tunnel and stops an unfinished build instead of rebuilding', async () => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const harness = createHarness(async () => {
    await gate
    return ok()
  })
  const request = harness.supervisor.fetch(send(NODE))
  const rejected = assert.rejects(request, /Private broadcast network was reset/)
  // Let the build reach its destination check, then close as the user turns routing off.
  while (harness.links.length === 0 || harness.links[0].calls.length < 2) {
    await new Promise(resolve => setImmediate(resolve))
  }
  harness.supervisor.close()
  await rejected
  release()
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].closed, true)

  // A later request starts from a fresh tunnel.
  await harness.supervisor.fetch(send(NODE))
  assert.equal(harness.links.length, 2)
})

test('a tunnel that finishes opening after a close is discarded', async () => {
  const harness = createHarness()
  let release
  harness.opening = new Promise(resolve => {
    release = resolve
  })
  const prewarm = harness.supervisor.prewarm([NODE])
  await new Promise(resolve => setImmediate(resolve))
  harness.supervisor.close()
  harness.opening = null
  release()
  await prewarm
  assert.equal(harness.links.length, 1)
  assert.equal(harness.links[0].closed, true)
  assert.deepEqual(harness.links[0].calls, [])
})
