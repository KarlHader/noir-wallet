import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNymPrewarmTrigger } from '../../../../src/core/nym/prewarm.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))

function createHarness(loadOrigins) {
  const harness = { time: 0, loads: 0, prewarmed: [] }
  harness.trigger = createNymPrewarmTrigger({
    now: () => harness.time,
    minIntervalMs: 30,
    loadOrigins: async () => {
      harness.loads += 1
      return loadOrigins(harness)
    },
    prewarm: async origins => {
      harness.prewarmed.push([...origins])
    }
  })
  return harness
}

test('repeated send preparation prewarms the tunnel once per interval', async () => {
  const harness = createHarness(() => ['https://node.example'])
  harness.trigger()
  harness.trigger()
  harness.time = 29
  harness.trigger()
  await settle()
  assert.equal(harness.loads, 1)
  assert.deepEqual(harness.prewarmed, [['https://node.example']])

  harness.time = 30
  harness.trigger()
  await settle()
  assert.equal(harness.loads, 2)
  assert.equal(harness.prewarmed.length, 2)
})

test('no tunnel is built while Nym routing is off', async () => {
  const harness = createHarness(() => [])
  harness.trigger()
  await settle()
  assert.equal(harness.loads, 1)
  assert.deepEqual(harness.prewarmed, [])
})

test('a failed destination lookup is retried by the next send preparation', async () => {
  let fail = true
  const harness = createHarness(() => {
    if (fail) throw new Error('background unavailable')
    return ['https://node.example']
  })
  harness.trigger()
  await settle()
  assert.deepEqual(harness.prewarmed, [])

  fail = false
  harness.trigger()
  await settle()
  assert.deepEqual(harness.prewarmed, [['https://node.example']])
})
