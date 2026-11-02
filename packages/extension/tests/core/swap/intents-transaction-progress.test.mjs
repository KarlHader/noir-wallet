import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getIntentsProgressPresentation,
  getLegacyIntentsProgressPresentation
} from '../../../src/popup/services/transaction-progress.ts'
import { getZcashIntentsOriginStatus } from '../../../src/lib/cross-chain-transaction.ts'
import { getActivityProgressSteps } from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'

test('an origin hash alone does not claim on-chain success', () => {
  const progress = getIntentsProgressPresentation({
    status: 'PENDING_DEPOSIT',
    originStatus: 'broadcast',
    originTxHash: '0xsource'
  })
  expect(progress.steps.map(step => step.state)).toEqual(['active', 'pending', 'pending'])
  expect(progress.steps[0].statusLabel).toBe('Submitted')
  expect(progress.steps[1].statusLabel).toBe('Pending')
  expect(progress.title).toBe('Source transaction submitted')
})

test('a confirmed origin stays complete while Intents waits for deposit recognition', () => {
  const progress = getIntentsProgressPresentation({
    status: 'PENDING_DEPOSIT',
    originStatus: 'final',
    originTxHash: '0xsource'
  })
  expect(progress.title).toBe('Source transaction confirmed')
  expect(progress.steps.map(step => step.state)).toEqual(['complete', 'active', 'pending'])
  expect(progress.steps[1].statusLabel).toBe('Waiting for deposit')
  expect(progress.description).toContain('do not send again')
})

test('a submitted signed order is not described as an unconfirmed deposit', () => {
  const progress = getIntentsProgressPresentation({
    status: 'PENDING_DEPOSIT',
    signedOrder: true
  })
  expect(progress.title).toBe('Order submitted')
  expect(progress.steps[0].state).toBe('complete')
  expect(progress.steps[0].statusLabel).toBe('Submitted')
  expect(progress.steps[1].state).toBe('active')
  expect(progress.steps[1].statusLabel).toBe('Waiting for deposit')
})

test('destination confirmations remain an active step after Intents success', () => {
  const progress = getIntentsProgressPresentation({
    status: 'SUCCESS',
    originTxHash: '0xsource',
    destinationTxHash: '0xdestination',
    waitsForDestinationConfirmations: true
  })
  expect(progress.steps.map(step => step.state)).toEqual(['complete', 'complete', 'active'])
})

test('relay failure does not imply the source transfer failed', () => {
  const progress = getIntentsProgressPresentation({
    status: 'FAILED',
    originStatus: 'final',
    originTxHash: '0xsource'
  })
  expect(progress.steps.map(step => step.state)).toEqual(['complete', 'failed', 'pending'])
  expect(progress.steps[1].detail).toBe(progress.description)
  expect(progress.steps[1].detail).toContain('Check the transaction details.')
})

test('an insufficient deposit warns while a refund remains pending', () => {
  const progress = getIntentsProgressPresentation({
    status: 'INCOMPLETE_DEPOSIT',
    originStatus: 'final',
    originTxHash: '0xsource'
  })
  expect(progress.steps.map(step => [step.label, step.state, step.statusLabel])).toEqual([
    ['Source transaction', 'complete', 'Confirmed'],
    ['Intents processing', 'warning', 'Amount too low'],
    ['Refund transfer', 'pending', 'Pending']
  ])
})

test('a submitted refund replaces the destination transfer step', () => {
  const progress = getIntentsProgressPresentation({
    status: 'REFUNDED',
    originStatus: 'final',
    originTxHash: '0xsource'
  })
  expect(progress.steps.map(step => [step.label, step.state, step.statusLabel])).toEqual([
    ['Source transaction', 'complete', 'Confirmed'],
    ['Intents processing', 'complete', 'Completed'],
    ['Refund transfer', 'active', 'Submitted']
  ])
})

test('Zcash pending settlement retains confirmed source status', () => {
  expect(
    getZcashIntentsOriginStatus({
      txHash: 'source-hash',
      status: 'pending',
      confirmations: 1
    })
  ).toBe('final')
  expect(
    getZcashIntentsOriginStatus({
      txHash: 'source-hash',
      status: 'pending',
      confirmations: 0
    })
  ).toBe('broadcast')
  expect(
    getZcashIntentsOriginStatus({
      txHash: 'source-hash',
      status: 'failed',
      confirmations: undefined
    })
  ).toBe('broadcast')
})

test('RHEA signed orders and relay use the same progress language in Activity', () => {
  const steps = getActivityProgressSteps(
    {
      status: 'confirming',
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'relay', provider: 'RHEA Signed Order' },
          status: 'broadcast'
        },
        {
          id: 'relay',
          role: 'relay',
          target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
          status: 'confirming'
        },
        {
          id: 'destination',
          role: 'destination',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          status: 'created'
        }
      ]
    },
    () => 'Ethereum'
  )
  expect(steps.map(step => [step.label, step.state, step.statusLabel])).toEqual([
    ['Order submitted', 'complete', 'Submitted'],
    ['Intents processing', 'active', 'Processing'],
    ['Destination transaction', 'pending', 'Pending']
  ])
})

test('Activity hides an unused refund branch but shows a refund that actually started', () => {
  const segments = [
    {
      id: 'origin',
      role: 'origin',
      target: { kind: 'onchain', chainId: 'eip155:1' },
      status: 'final'
    },
    {
      id: 'relay',
      role: 'relay',
      target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
      status: 'final'
    },
    {
      id: 'destination',
      role: 'destination',
      target: { kind: 'onchain', chainId: 'eip155:42161' },
      status: 'final'
    },
    {
      id: 'refund',
      role: 'refund',
      target: { kind: 'onchain', chainId: 'eip155:1' },
      status: 'created'
    }
  ]
  const item = { status: 'final', segments }
  const chainName = chainId => (chainId === 'eip155:1' ? 'Ethereum' : 'Arbitrum')

  expect(getActivityProgressSteps(item, chainName).map(step => step.label)).toEqual([
    'Origin transaction',
    'Intents processing',
    'Destination transaction'
  ])
  expect(
    getActivityProgressSteps(
      {
        ...item,
        status: 'failed',
        failureCode: 'refunded',
        segments: segments.map(segment =>
          segment.role === 'refund' ? { ...segment, status: 'final' } : segment
        )
      },
      chainName
    ).at(-1)
  ).toMatchObject({ label: 'Refund transaction', state: 'complete' })
})

test('legacy Withdraw keeps destination Zcash confirmations separate from source status', () => {
  const presentation = getLegacyIntentsProgressPresentation(
    {
      type: 'withdraw',
      status: 'relay_confirmed',
      txHash: 'near-origin',
      destinationTxHash: 'zcash-destination',
      confirmations: 2,
      requiredConfirmations: 10
    },
    { actionName: 'Withdraw', status: 'SUCCESS' }
  )
  expect(presentation.title).toBe('Withdraw Confirming (2/10)')
  expect(presentation.steps.map(step => step.state)).toEqual(['complete', 'complete', 'active'])
  expect(presentation.steps[0].detail).toBeUndefined()
})
