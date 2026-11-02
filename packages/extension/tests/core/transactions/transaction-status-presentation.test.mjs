import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getLifecycleStatusPresentation } from '../../../src/lib/transaction-status-presentation.ts'
import { getActivityStatusPresentation } from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'
import { getOnchainTransactionStatusPresentation } from '../../../src/popup/services/onchain-transaction-result.ts'
import {
  getIntentsStatusCopy,
  getSubmittedTransactionResultCopy,
  getTransactionStatusCopy
} from '../../../src/lib/transaction-status-copy.ts'

const chains = [
  'bip122:000000000019d6689c085ae165831e93',
  'eip155:1',
  'solana:mainnet',
  'near:mainnet',
  'bip122:000000000000000000651ef99cb9fcbe'
]

test('every chain uses the same Activity and result labels for normal finality', () => {
  for (const chainId of chains) {
    for (const [status, label, tone] of [
      ['broadcast', 'Submitted', 'neutral'],
      ['confirming', 'Confirming', 'neutral'],
      ['final', 'Confirmed', 'success']
    ]) {
      const item = {
        kind: 'transfer',
        status,
        segments: [
          {
            role: 'origin',
            target: { kind: 'onchain', chainId },
            status,
            evidence: { transactionHash: 'tx-hash' }
          }
        ]
      }
      expect(getActivityStatusPresentation(item), chainId).toEqual({ label, tone })
      const result = getOnchainTransactionStatusPresentation(status, false)
      expect({ label: result.label, tone: result.tone }, chainId).toEqual({ label, tone })
      expect(result.resultStatus, chainId).toBe(
        status === 'final' ? 'success' : status === 'broadcast' ? 'submitted' : 'loading'
      )
    }
  }
})

test('Intents Activity identifies the observed cross-chain stage', () => {
  const origin = {
    id: 'origin',
    role: 'origin',
    target: { kind: 'onchain', chainId: 'eip155:1' },
    status: 'broadcast'
  }
  const relay = {
    id: 'relay',
    role: 'relay',
    target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
    status: 'created'
  }
  const destination = {
    id: 'destination',
    role: 'destination',
    target: { kind: 'onchain', chainId: 'eip155:42161' },
    status: 'created'
  }
  const item = {
    source: 'wallet-v2',
    kind: 'swap',
    status: 'broadcast',
    segments: [origin, relay, destination]
  }
  const cases = [
    [{}, 'Source submitted'],
    [{ origin: 'confirming', status: 'confirming' }, 'Deposit confirming'],
    [{ origin: 'final', status: 'confirming' }, 'Waiting for Intents'],
    [{ relay: 'confirming', status: 'confirming' }, 'Intents processing'],
    [{ relay: 'final', status: 'confirming' }, 'Finalizing'],
    [{ destination: 'broadcast', status: 'confirming' }, 'Destination sent'],
    [{ destination: 'confirming', status: 'confirming' }, 'Destination confirming'],
    [{ destination: 'final', status: 'final' }, 'Confirmed']
  ]
  for (const [changes, label] of cases) {
    const next = {
      ...item,
      status: changes.status ?? item.status,
      segments: [
        { ...origin, status: changes.origin ?? origin.status },
        { ...relay, status: changes.relay ?? relay.status },
        { ...destination, status: changes.destination ?? destination.status }
      ]
    }
    expect(getActivityStatusPresentation(next), label).toMatchObject({ label })
  }
  const signedOrder = {
    ...item,
    segments: [
      { ...origin, target: { kind: 'relay', provider: 'RHEA Signed Order' } },
      relay,
      destination
    ]
  }
  expect(getActivityStatusPresentation(signedOrder)).toMatchObject({ label: 'Order submitted' })
  expect(
    getActivityStatusPresentation({
      ...item,
      source: 'zcash-v1',
      status: 'confirming',
      segments: [origin, { ...relay, status: 'confirming' }, destination]
    })
  ).toMatchObject({ label: 'Waiting for Intents' })
})

test('only exceptional states use warning or error, while cancellation stays neutral', () => {
  expect(getLifecycleStatusPresentation({ status: 'signed' })).toEqual({
    label: 'Pending',
    tone: 'neutral'
  })
  expect(getOnchainTransactionStatusPresentation('signed', false)).toMatchObject({
    label: 'Needs broadcast',
    tone: 'warning',
    resultStatus: 'warning'
  })
  expect(
    getLifecycleStatusPresentation({
      status: 'confirming',
      evidence: { confirmations: 2, requiredConfirmations: 6 }
    })
  ).toEqual({ label: 'Confirming · 2/6', tone: 'neutral' })
  expect(getLifecycleStatusPresentation({ status: 'broadcast', reconfirming: true })).toEqual({
    label: 'Reconfirming',
    tone: 'warning'
  })
  expect(
    getOnchainTransactionStatusPresentation('broadcast', true, {
      evidence: { confirmations: 0, requiredConfirmations: 6 }
    })
  ).toMatchObject({ label: 'Reconfirming · 0/6', tone: 'warning' })
  expect(
    getLifecycleStatusPresentation({ status: 'failed', failureCode: 'user-rejected' })
  ).toEqual({ label: 'Cancelled', tone: 'neutral' })
  expect(
    getOnchainTransactionStatusPresentation('failed', false, { code: 'user-rejected' })
  ).toMatchObject({
    title: 'Transaction Cancelled',
    label: 'Cancelled',
    tone: 'neutral',
    resultStatus: 'neutral'
  })
  expect(
    getOnchainTransactionStatusPresentation('failed', false, {
      code: 'dropped',
      evidence: { replacementTransactionHash: 'replacement' }
    })
  ).toMatchObject({
    title: 'Transaction Replaced',
    label: 'Replaced',
    tone: 'neutral',
    resultStatus: 'neutral'
  })
  expect(getLifecycleStatusPresentation({ status: 'failed', failureCode: 'refunded' })).toEqual({
    label: 'Refunded',
    tone: 'success'
  })
  expect(
    getOnchainTransactionStatusPresentation('failed', false, { code: 'refunded' })
  ).toMatchObject({
    title: 'Transaction Refunded',
    tone: 'success',
    resultStatus: 'success'
  })
  expect(getLifecycleStatusPresentation({ status: 'failed', failureCode: 'reverted' })).toEqual({
    label: 'Failed',
    tone: 'error'
  })
  expect(
    getOnchainTransactionStatusPresentation('failed', false, { code: 'reverted' })
  ).toMatchObject({
    title: 'Transaction Failed',
    tone: 'error',
    resultStatus: 'failed'
  })
})

test('legacy Zcash and Intents progress follow the same submitted and confirming language', () => {
  const transaction = {
    id: 'zcash-transaction',
    type: 'send',
    status: 'pending',
    txHash: 'tx-hash',
    timestamp: 1_000
  }
  expect(getTransactionStatusCopy(transaction, 1_000)).toMatchObject({
    label: 'Submitted',
    tone: 'neutral'
  })
  expect(getIntentsStatusCopy('KNOWN_DEPOSIT_TX')).toMatchObject({
    compactLabel: 'Deposit confirming',
    tone: 'neutral'
  })
  expect(getIntentsStatusCopy('PROCESSING')).toMatchObject({
    compactLabel: 'Intents processing',
    tone: 'neutral'
  })
  expect(getIntentsStatusCopy('INCOMPLETE_DEPOSIT')).toMatchObject({
    tone: 'warning',
    resultStatus: 'warning'
  })
  expect(getIntentsStatusCopy('REFUNDED')).toMatchObject({
    tone: 'neutral',
    resultStatus: 'submitted'
  })
  expect(getSubmittedTransactionResultCopy()).toMatchObject({
    title: 'Transaction Submitted',
    resultStatus: 'submitted'
  })
})
