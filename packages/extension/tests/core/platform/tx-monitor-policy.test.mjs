import test from 'node:test'
import assert from 'node:assert/strict'

import { decideMonitorSignal, isExpiredAtTip } from '../../../src/background/tx-monitor-policy.ts'

function decide(overrides) {
  return decideMonitorSignal({
    lookup: { status: 'mempool' },
    minConfirmations: 2,
    expired: false,
    elapsedMs: 0,
    timeoutMs: 1000,
    hasNode: true,
    confirmedInDb: false,
    ...overrides
  })
}

test('isExpiredAtTip requires tip and expiry past the buffer', () => {
  assert.equal(isExpiredAtTip(null, 100, 5), false)
  assert.equal(isExpiredAtTip(200, undefined, 5), false)
  assert.equal(isExpiredAtTip(104, 100, 5), false)
  assert.equal(isExpiredAtTip(105, 100, 5), true)
  assert.equal(isExpiredAtTip(110, 100, 5), true)
})

test('confirms once confirmations reach the minimum', () => {
  assert.equal(decide({ lookup: { status: 'confirmed', confirmations: 3 } }), 'confirm')
  assert.equal(decide({ lookup: { status: 'confirmed', confirmations: 2 } }), 'confirm')
})

test('a mined-but-immature tx keeps waiting even past the timeout', () => {
  assert.equal(
    decide({ lookup: { status: 'confirmed', confirmations: 1 }, elapsedMs: 999999 }),
    'wait'
  )
})

test('an authoritative notfound past expiry expires fast', () => {
  assert.equal(decide({ lookup: { status: 'notfound' }, expired: true }), 'expire')
})

test('a notfound within its expiry window and timeout keeps waiting', () => {
  assert.equal(decide({ lookup: { status: 'notfound' }, elapsedMs: 500 }), 'wait')
})

test('a notfound past the timeout fails as timeout', () => {
  assert.equal(decide({ lookup: { status: 'notfound' }, elapsedMs: 2000 }), 'timeout')
})

test('a transient node error never fails a live tx, even past the timeout', () => {
  assert.equal(decide({ lookup: { status: 'error' }, elapsedMs: 2000 }), 'wait')
})

test('a mempool tx keeps waiting past the timeout while the node is reachable', () => {
  assert.equal(decide({ lookup: { status: 'mempool' }, elapsedMs: 2000 }), 'wait')
})

test('clears a tx already confirmed in the local DB past the timeout', () => {
  assert.equal(decide({ elapsedMs: 2000, confirmedInDb: true }), 'clear')
})

test('with no node configured the wall-clock timeout is the only failure signal', () => {
  assert.equal(decide({ hasNode: false, lookup: { status: 'error' }, elapsedMs: 2000 }), 'timeout')
  assert.equal(decide({ hasNode: false, lookup: { status: 'error' }, elapsedMs: 500 }), 'wait')
})
