import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emitDAppEvent, observeDAppRequest } from '../../../src/background/dapp-analytics.ts'
import { ANALYTICS_EVENTS } from '../../../src/lib/analytics/constants.ts'

test('dApp signing reports only verified success, without forwarding the request or result', async () => {
  const events = []
  const sink = (name, options) => events.push({ name, options })
  const signature = 'private-signature'
  assert.equal(
    await observeDAppRequest(sink, 'evm', 'personal_sign', async () => signature),
    signature
  )
  assert.deepEqual(events, [
    { name: ANALYTICS_EVENTS.DAPP_MESSAGE_SIGNED, options: { chain: 'evm', pageId: 'noir_dapp' } }
  ])
  assert.ok(!JSON.stringify(events).includes(signature))
})

test('dApp cancellation is a rejection, while preparation errors and signed transactions are not broadcasts', async () => {
  const events = []
  const sink = (name, options) => events.push({ name, options })
  const rejected = Object.assign(new Error('private raw message'), { code: 4001 })
  await assert.rejects(
    observeDAppRequest(sink, 'bitcoin', 'sendBitcoin', async () => {
      throw rejected
    }),
    error => error === rejected
  )
  assert.deepEqual(events, [
    {
      name: ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED,
      options: { chain: 'bitcoin', pageId: 'noir_dapp', extra: { method: 'sendTransaction' } }
    }
  ])
  await assert.rejects(
    observeDAppRequest(sink, 'solana', 'signAndSendTransaction', async () => {
      throw new Error('RPC unavailable')
    })
  )
  await observeDAppRequest(sink, 'solana', 'signTransaction', async () => 'signed bytes')
  assert.equal(events.length, 1)
  assert.ok(!JSON.stringify(events).includes('private raw message'))
})

test('analytics failures cannot change the approved dApp result', async () => {
  const sink = () => {
    throw new Error('reporting unavailable')
  }
  assert.equal(
    await observeDAppRequest(sink, 'near', 'signMessage', async () => 'signature'),
    'signature'
  )
  assert.equal(emitDAppEvent(sink, 'evm', ANALYTICS_EVENTS.DAPP_CONNECTED), undefined)
  const asyncSink = async () => {
    throw new Error('storage unavailable')
  }
  assert.equal(
    await observeDAppRequest(asyncSink, 'evm', 'personal_sign', async () => 'signed'),
    'signed'
  )
})

test('dApp response does not wait for a sink that never settles', async () => {
  const result = observeDAppRequest(
    () => new Promise(() => {}),
    'evm',
    'personal_sign',
    async () => 'signed'
  )
  assert.equal(await result, 'signed')
})
