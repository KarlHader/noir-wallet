import assert from 'node:assert/strict'
import { test } from 'node:test'

// Evaluated by the config module at import time, as the isolated Nym build defines it.
globalThis.__NYM_PRIVATE_BROADCAST__ = true

const { lookupTransaction, getAddressTxids, getVerboseTransaction, getBlockCount, zcashNodeRpc } =
  await import('../../../../src/lib/zcash-node-rpc.ts')
const { parseNymTextReply, parseNymTextRequest, setNymPrivateFetchRelay } =
  await import('../../../../src/core/nym/private-fetch-relay.ts')
const { fetchQuote, fetchSwapStatus } = await import('../../../../src/core/services/intents-api.ts')
const { NYM_BROADCAST_UNAVAILABLE_MESSAGE } =
  await import('../../../../src/core/zcash/wallet-rpc-errors.ts')

const NODE = 'https://node.example'
const TXID = 'ab'.repeat(32)
const ZEC_DEPOSIT = `t1${'Z'.repeat(33)}`
const ZEC_QUOTE = {
  originAsset: 'nep141:zec.omft.near',
  destinationAsset: 'nep141:wrap.near',
  amount: '100000000',
  refundTo: `t1${'R'.repeat(33)}`,
  recipient: 'recipient.near'
}
const QUOTE_URL = 'https://api.rhea.finance/api/1click/quote'
const STATUS_URLS = [
  `https://api.rhea.finance/api/1click/status?depositAddress=${ZEC_DEPOSIT}`,
  `https://1click.chaindefuser.com/v0/status?depositAddress=${ZEC_DEPOSIT}`
]

/** Swap status reads log their final failure; keep that out of the test output. */
function silenceConsoleError(t) {
  const original = console.error
  console.error = () => {}
  t.after(() => {
    console.error = original
  })
}

function stubDirectSwapFetch(t) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    calls.push(String(input))
    return Response.json({ status: 'PENDING_DEPOSIT' })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

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

test('address history and generic transaction reads use Nym when enabled', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t)
  const requests = []
  setNymPrivateFetchRelay(async request => {
    const { method } = JSON.parse(request.bodyText)
    requests.push(JSON.parse(request.bodyText))
    return reply(200, {
      result: method === 'getaddresstxids' ? [TXID] : { txid: TXID, confirmations: 2 }
    })
  })

  assert.deepEqual(await getAddressTxids(NODE, 't-address', 123), [TXID])
  assert.equal((await getVerboseTransaction(NODE, TXID)).confirmations, 2)
  assert.deepEqual(
    requests.map(({ method, params }) => [method, params]),
    [
      ['getaddresstxids', [{ addresses: ['t-address'], start: 123 }]],
      ['getrawtransaction', [TXID, 1]]
    ]
  )
  assert.deepEqual(directCalls, [])
})

test('address history and generic transaction reads use direct fetch when Nym is off', async t => {
  stubNymPreference(t, false)
  const directCalls = stubDirectFetch(t, [TXID])
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  assert.deepEqual(await getAddressTxids(NODE, 't-address'), [TXID])
  await getVerboseTransaction(NODE, TXID)
  assert.deepEqual(directCalls, [NODE, NODE])
})

test('unreadable Nym choice blocks address history and generic transaction reads', async t => {
  stubNymPreference(t, null)
  const directCalls = stubDirectFetch(t)
  let relayCalls = 0
  setNymPrivateFetchRelay(async () => {
    relayCalls += 1
    return reply(200, { result: [] })
  })

  await assert.rejects(getAddressTxids(NODE, 't-address'))
  await assert.rejects(getVerboseTransaction(NODE, TXID))
  assert.deepEqual(directCalls, [])
  assert.equal(relayCalls, 0)
})

test('Nym failures never retry sensitive JSON-RPC requests directly', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('Private network unavailable')
  })

  await assert.rejects(getAddressTxids(NODE, 't-address'))
  await assert.rejects(getVerboseTransaction(NODE, TXID))
  assert.deepEqual(directCalls, [])
})

test('unclassified zcashd JSON-RPC requests still use direct fetch', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectFetch(t, 'blockhash')
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  assert.equal(await zcashNodeRpc(NODE, 'getblockhash', [123]), 'blockhash')
  assert.deepEqual(directCalls, [NODE])
})

test('an already aborted sensitive JSON-RPC request stops before reading settings', async t => {
  stubNymPreference(t, null)
  const directCalls = stubDirectFetch(t)
  let relayCalls = 0
  setNymPrivateFetchRelay(async () => {
    relayCalls += 1
    return reply(200, { result: { txid: TXID } })
  })
  const controller = new AbortController()
  const reason = new DOMException('Request cancelled', 'AbortError')
  controller.abort(reason)

  await assert.rejects(
    zcashNodeRpc(NODE, 'getrawtransaction', [TXID, 1], controller.signal),
    error => error === reason
  )
  assert.deepEqual(directCalls, [])
  assert.equal(relayCalls, 0)
})

test('swaps that spend ZEC quote and read status through the Nym relay only', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectSwapFetch(t)
  const relayed = []
  setNymPrivateFetchRelay(async request => {
    relayed.push(request)
    if (request.url === STATUS_URLS[0]) return reply(503, { message: 'Unavailable' })
    return reply(200, request.method === 'POST' ? { message: 'No route' } : { status: 'SUCCESS' })
  })

  assert.deepEqual(await fetchQuote(ZEC_QUOTE), { quoteStatus: 'error', message: 'No route' })
  assert.deepEqual(await fetchSwapStatus(ZEC_DEPOSIT), { status: 'SUCCESS' })
  assert.deepEqual(
    relayed.map(({ method, url }) => [method, url]),
    [['POST', QUOTE_URL], ...STATUS_URLS.map(url => ['GET', url])]
  )
  assert.equal(JSON.parse(relayed[0].bodyText).refundTo, ZEC_QUOTE.refundTo)
  assert.deepEqual(directCalls, [])
})

test('a Nym failure fails ZEC swap requests without a direct fallback', async t => {
  stubNymPreference(t, true)
  silenceConsoleError(t)
  const directCalls = stubDirectSwapFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('Private broadcast network unavailable: no gateway')
  })

  assert.deepEqual(await fetchQuote(ZEC_QUOTE), {
    quoteStatus: 'error',
    message: NYM_BROADCAST_UNAVAILABLE_MESSAGE
  })
  assert.equal(await fetchSwapStatus(ZEC_DEPOSIT), null)
  assert.deepEqual(directCalls, [])
})

test('an unreadable Nym preference blocks ZEC swap requests without any request', async t => {
  stubNymPreference(t, null)
  silenceConsoleError(t)
  const directCalls = stubDirectSwapFetch(t)
  let relayCalls = 0
  setNymPrivateFetchRelay(async () => {
    relayCalls += 1
    return reply(200, { status: 'SUCCESS' })
  })

  assert.equal((await fetchQuote(ZEC_QUOTE)).quoteStatus, 'error')
  assert.equal(await fetchSwapStatus(ZEC_DEPOSIT), null)
  assert.deepEqual(directCalls, [])
  assert.equal(relayCalls, 0)
})

test('swaps that do not spend ZEC stay on the direct path while Nym is on', async t => {
  stubNymPreference(t, true)
  const directCalls = stubDirectSwapFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  await fetchQuote({
    ...ZEC_QUOTE,
    originAsset: 'nep141:wrap.near',
    destinationAsset: 'nep141:zec.omft.near'
  })
  assert.deepEqual(await fetchSwapStatus('0x1111111111111111111111111111111111111111'), {
    status: 'PENDING_DEPOSIT'
  })
  assert.deepEqual(directCalls, [
    QUOTE_URL,
    'https://api.rhea.finance/api/1click/status?depositAddress=0x1111111111111111111111111111111111111111'
  ])
})

test('with Nym routing turned off ZEC swap requests use the direct path', async t => {
  stubNymPreference(t, false)
  const directCalls = stubDirectSwapFetch(t)
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  await fetchQuote(ZEC_QUOTE)
  assert.deepEqual(await fetchSwapStatus(ZEC_DEPOSIT), { status: 'PENDING_DEPOSIT' })
  assert.deepEqual(directCalls, [QUOTE_URL, STATUS_URLS[0]])
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
