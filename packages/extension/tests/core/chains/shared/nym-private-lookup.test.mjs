import assert from 'node:assert/strict'
import { test } from 'node:test'

// Evaluated by the config module at import time, as the isolated Nym build defines it.
globalThis.__NYM_PRIVATE_BROADCAST__ = true

const { lookupTransaction, getVerboseTransaction, getBlockCount } =
  await import('../../../../src/lib/zcash-node-rpc.ts')
const { parseNymTextReply, parseNymTextRequest, setNymPrivateFetchRelay } =
  await import('../../../../src/core/nym/private-fetch-relay.ts')

const NODE = 'https://node.example'
const TXID = 'ab'.repeat(32)

function stubDirectFetch(t, result = { txid: TXID, confirmations: 1 }) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    calls.push(String(input))
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

/** Stores the user's Nym routing choice; `null` makes the settings unreadable. */
function stubNymPreference(t, enabled) {
  const original = globalThis.chrome
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (enabled === null) throw new Error('storage unavailable')
          return {
            [key]: JSON.stringify({ state: { nymPrivateBroadcastEnabled: enabled }, version: 0 })
          }
        }
      }
    }
  }
  t.after(() => {
    globalThis.chrome = original
  })
}

const reply = (status, body) => ({
  status,
  statusText: '',
  headers: [],
  bodyText: JSON.stringify(body)
})

test('transaction status lookups use the Nym relay and never the direct fetch', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t)
  const relayed = []
  setNymPrivateFetchRelay(async request => {
    relayed.push(request)
    return reply(200, { result: { txid: TXID, confirmations: 3 } })
  })

  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'confirmed', confirmations: 3 })
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].url, NODE)
  assert.equal(relayed[0].method, 'POST')
  assert.deepEqual(JSON.parse(relayed[0].bodyText).params, [TXID, 1])
  assert.deepEqual(directCalls, [])
})

test('a Nym failure reports a transient lookup error without a direct fallback', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('Private broadcast network unavailable')
  })
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'error' })

  setNymPrivateFetchRelay(async () => reply(502, { error: 'bad gateway' }))
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'error' })
  assert.deepEqual(directCalls, [])
})

test('node answers keep their meaning through the relay', async t => {
  stubNymPreference(t, true)
  stubDirectFetch(t)
  setNymPrivateFetchRelay(async () =>
    reply(200, { error: { code: -5, message: 'No information available about transaction' } })
  )
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'notfound' })

  setNymPrivateFetchRelay(async () => reply(200, { result: { txid: TXID } }))
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'mempool' })
})

test('with Nym routing turned off status lookups use the direct path', async t => {
  stubNymPreference(t, false)
  const directCalls = stubDirectFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'confirmed', confirmations: 1 })
  assert.deepEqual(directCalls, [NODE])
})

test('an unreadable Nym preference reports a transient lookup error without any request', async t => {
  stubNymPreference(t, null)
  const directCalls = stubDirectFetch(t)
  let relayed = 0
  setNymPrivateFetchRelay(async () => {
    relayed += 1
    return reply(200, { result: { txid: TXID, confirmations: 3 } })
  })
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'error' })
  assert.deepEqual(directCalls, [])
  assert.equal(relayed, 0)
})

test('the chain tip read that follows a status lookup uses the Nym relay and never the direct fetch', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t, 2_400_000)
  const relayed = []
  setNymPrivateFetchRelay(async request => {
    relayed.push(request)
    return reply(200, { result: 2_500_000 })
  })

  assert.equal(await getBlockCount(NODE), 2_500_000)
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].url, NODE)
  assert.equal(JSON.parse(relayed[0].bodyText).method, 'getblockcount')
  assert.deepEqual(directCalls, [])
})

test('a Nym failure leaves the chain tip unknown without a direct fallback', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t, 2_400_000)
  setNymPrivateFetchRelay(async () => {
    throw new Error('Private broadcast network unavailable')
  })

  assert.equal(await getBlockCount(NODE), null)
  assert.deepEqual(directCalls, [])
})

test('an unreadable Nym preference leaves the chain tip unknown without any request', async t => {
  stubNymPreference(t, null)
  const directCalls = stubDirectFetch(t, 2_400_000)
  let relayed = 0
  setNymPrivateFetchRelay(async () => {
    relayed += 1
    return reply(200, { result: 2_500_000 })
  })

  assert.equal(await getBlockCount(NODE), null)
  assert.deepEqual(directCalls, [])
  assert.equal(relayed, 0)
})

test('with Nym routing turned off the chain tip read uses the direct path', async t => {
  stubNymPreference(t, false)
  const directCalls = stubDirectFetch(t, 2_400_000)
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  assert.equal(await getBlockCount(NODE), 2_400_000)
  assert.deepEqual(directCalls, [NODE])
})

test('history reads stay on the direct path', async t => {
  const directCalls = stubDirectFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })
  await getVerboseTransaction(NODE, TXID)
  assert.deepEqual(directCalls, [NODE])
})

test('relay messages accept only bounded HTTPS text requests and well-formed replies', () => {
  const valid = {
    url: NODE,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    bodyText: '{}'
  }
  assert.deepEqual(parseNymTextRequest(valid), valid)
  assert.throws(() => parseNymTextRequest({ ...valid, url: 'http://node.example' }))
  assert.throws(() => parseNymTextRequest({ ...valid, method: 'PUT' }))
  assert.throws(() => parseNymTextRequest({ ...valid, headers: [['a']] }))
  assert.throws(() => parseNymTextRequest({ ...valid, bodyText: 'x'.repeat(64 * 1024 + 1) }))

  assert.throws(
    () => parseNymTextReply({ ok: false, error: 'exit unreachable' }),
    /exit unreachable/
  )
  assert.throws(() => parseNymTextReply(undefined), /Private network unavailable/)
  assert.throws(() => parseNymTextReply({ ok: true, response: { status: 200 } }))
})
