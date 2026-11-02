import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isZcashOperationAnalyticsContext,
  projectZcashOperationEvent
} from '../../../src/lib/analytics/operations.ts'
import { ANALYTICS_EVENTS } from '../../../src/lib/analytics/constants.ts'

test('the execution outcome selects Send, Shield and Swap events independently of UI metadata', () => {
  const operations = [
    ['send', ANALYTICS_EVENTS.SEND_SUCCEEDED, ANALYTICS_EVENTS.SEND_FAILED],
    ['unshield', ANALYTICS_EVENTS.SEND_SUCCEEDED, ANALYTICS_EVENTS.SEND_FAILED],
    ['shield', ANALYTICS_EVENTS.SHIELD_SUCCEEDED, ANALYTICS_EVENTS.SHIELD_FAILED],
    ['swap', ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT, ANALYTICS_EVENTS.SWAP_FAILED]
  ]
  for (const [operation, success, failure] of operations) {
    const event = projectZcashOperationEvent(operation, 'broadcast', {
      name: 'unreviewed_event',
      inputAmount: '987654321',
      walletAddress: 'private-address'
    })
    assert.equal(event.name, success)
    assert.equal(event.options.chain, 'zcash')
    assert.equal(event.options.hasTransaction, 1)
    const failed = projectZcashOperationEvent(operation, 'failed')
    assert.equal(failed.name, failure)
    assert.equal(failed.options.hasTransaction, 0)
    assert.ok(!JSON.stringify(event).includes('987654321'))
    assert.ok(!JSON.stringify(event).includes('private-address'))
  }
})

test('Zcash outcomes preserve controlled hardware, funding and Swap asset context', () => {
  const sent = projectZcashOperationEvent(
    'unshield',
    'broadcast',
    { hardware: true, fundingSource: 'shielded', pageId: 'noir_hardware_sign' },
    'local-receipt'
  )
  assert.deepEqual(sent.options.params, { hardware: true })
  assert.deepEqual(sent.options.extra, { funding_source: 'shielded', kind: 'send' })
  assert.equal(sent.options.idempotencyKey, 'local-receipt')
  const swapped = projectZcashOperationEvent('swap', 'broadcast', {
    direction: 'zec_to_other',
    outputSymbol: 'USDC'
  })
  assert.deepEqual(swapped.options.params, { from_token: 'ZEC', to_token: 'USDC' })
  assert.deepEqual(swapped.options.extra, { direction: 'zec_to_other', sourceFamily: 'zcash' })
})

test('the runtime context contract rejects event overrides and private transaction fields', () => {
  assert.equal(
    isZcashOperationAnalyticsContext({ fundingSource: 'transparent', hardware: true }),
    true
  )
  for (const context of [
    { onSuccess: { name: 'transaction_sent' } },
    { inputAmount: '1' },
    { recipient: 'private-address' },
    { fundingSource: 'unknown' },
    { direction: 'unknown' },
    { hardware: 'ledger' },
    null,
    []
  ])
    assert.equal(isZcashOperationAnalyticsContext(context), false)
})
