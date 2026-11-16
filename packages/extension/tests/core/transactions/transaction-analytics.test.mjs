import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  transactionAnalyticsInputAmount,
  transactionBroadcasted,
  transactionFailedBeforeBroadcast
} from '../../../src/core/transactions/transaction-analytics.ts'
import { hasSubmittedRheaOrigin } from '../../../src/popup/services/swap-event-model.ts'
import { reportBackgroundSendBroadcast } from '../../../src/background/analytics/send-broadcast.ts'

function transfer(rootStatus, originStatus, transactionHash, failure) {
  return {
    root: { status: rootStatus, ...(failure ? { failure } : {}) },
    segments: [
      {
        role: 'origin',
        status: originStatus,
        target: { kind: 'onchain' },
        evidence: transactionHash ? { transactionHash } : undefined
      }
    ]
  }
}

test('a signed hash does not count as broadcast and failure does not erase a broadcast', () => {
  assert.equal(transactionBroadcasted(transfer('signed', 'signed', '0x1234')), false)
  assert.equal(transactionBroadcasted(transfer('broadcast', 'broadcast')), false)
  assert.equal(transactionBroadcasted(transfer('broadcast', 'broadcast', '0x1234')), true)
  assert.equal(transactionBroadcasted(transfer('failed', 'broadcast', '0x1234')), true)
  assert.equal(transactionFailedBeforeBroadcast(transfer('failed', 'failed')), true)
  assert.equal(
    transactionFailedBeforeBroadcast(
      transfer('failed', 'failed', undefined, { code: 'user-rejected' })
    ),
    false
  )
  assert.equal(transactionFailedBeforeBroadcast(transfer('failed', 'broadcast', '0x1234')), false)
})

test('native transaction analytics use bundled asset precision when intent omits metadata', () => {
  assert.equal(
    transactionAnalyticsInputAmount({
      root: {
        intent: {
          primaryAmount: {
            assetId: 'near:mainnet/slip44:397',
            amountRaw: '1230000000000000000000000'
          }
        }
      }
    }),
    '1.23'
  )
})

test('RHEA initiation requires a broadcast origin with a hash or order reference', () => {
  const graph = {
    root: { intent: { protocol: { provider: 'rhea-cross-chain-dex' } } },
    segments: [
      {
        role: 'origin',
        status: 'signed',
        target: { kind: 'onchain' },
        evidence: { transactionHash: '0x1234' }
      }
    ]
  }
  assert.equal(hasSubmittedRheaOrigin(graph), false)
  assert.equal(
    hasSubmittedRheaOrigin({ ...graph, segments: [{ ...graph.segments[0], status: 'broadcast' }] }),
    true
  )
  assert.equal(
    hasSubmittedRheaOrigin({
      ...graph,
      segments: [{ role: 'origin', status: 'broadcast', target: { kind: 'relay' }, evidence: {} }]
    }),
    false
  )
  assert.equal(
    hasSubmittedRheaOrigin({
      ...graph,
      segments: [
        {
          role: 'origin',
          status: 'broadcast',
          target: { kind: 'relay' },
          evidence: { externalReference: 'order:123' }
        }
      ]
    }),
    true
  )
})

test('recovered Send broadcast reports once without waiting for the analytics sink', () => {
  const graph = {
    ...transfer('broadcast', 'broadcast', '0x1234'),
    root: {
      id: 'tx:recovered',
      status: 'broadcast',
      kind: 'transfer',
      intent: { sender: { chainId: 'eip155:1' } }
    }
  }
  const events = []
  const stalledSink = (name, options) => {
    events.push({ name, options })
    return new Promise(() => {})
  }
  assert.equal(reportBackgroundSendBroadcast(graph, stalledSink), undefined)
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'transaction_sent')
  assert.equal(events[0].options.idempotencyKey, 'send-broadcast:tx:recovered')
  reportBackgroundSendBroadcast(
    { ...graph, root: { ...graph.root, status: 'signed' } },
    stalledSink
  )
  reportBackgroundSendBroadcast(
    { ...graph, root: { ...graph.root, intent: { ...graph.root.intent, protocol: {} } } },
    stalledSink
  )
  assert.equal(events.length, 1)
})

test('a persisted RHEA transfer reports only an onchain origin broadcast', () => {
  const graph = {
    ...transfer('broadcast', 'broadcast', '0x1234'),
    root: {
      id: 'tx:rhea-transfer',
      status: 'broadcast',
      kind: 'swap',
      intent: {
        sender: { chainId: 'eip155:1' },
        protocol: {
          provider: 'rhea-cross-chain-dex',
          userAction: 'transfer',
          quoteHandle: 'local-quote'
        }
      }
    }
  }
  const events = []
  const sink = (name, options) => events.push({ name, options })
  reportBackgroundSendBroadcast(graph, sink)
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'transaction_sent')
  assert.equal(events[0].options.idempotencyKey, 'rhea-origin:local-quote')
  assert.deepEqual(events[0].options.extra, { kind: 'transfer' })
  for (const changed of [
    { ...graph, segments: transfer('signed', 'signed', '0x1234').segments },
    { ...graph, segments: transfer('broadcast', 'broadcast').segments },
    {
      ...graph,
      root: {
        ...graph.root,
        intent: {
          ...graph.root.intent,
          protocol: { ...graph.root.intent.protocol, userAction: undefined }
        }
      }
    },
    { ...graph, root: { ...graph.root, status: 'signed' } }
  ])
    reportBackgroundSendBroadcast(changed, sink)
  assert.equal(events.length, 1)
})
