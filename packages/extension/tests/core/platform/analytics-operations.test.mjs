import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isZcashOperationAnalyticsContext,
  projectConfidentialPlanResult,
  projectExternalDepositResult,
  projectZcashOperationEvent,
  resolveZcashAnalyticsOperation,
  zcashOperationCollector
} from '../../../src/lib/analytics/operations.ts'
import { ANALYTICS_EVENTS } from '../../../src/lib/analytics/constants.ts'
import { ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'

test('the execution outcome selects Send, Shield and Swap events independently of UI metadata', () => {
  const operations = [
    ['send', ANALYTICS_EVENTS.SEND_SUCCEEDED, ANALYTICS_EVENTS.SEND_FAILED],
    ['unshield', ANALYTICS_EVENTS.SEND_SUCCEEDED, ANALYTICS_EVENTS.SEND_FAILED],
    ['transfer', ANALYTICS_EVENTS.SEND_SUCCEEDED, ANALYTICS_EVENTS.SEND_FAILED],
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

test('Shield results follow persisted, settled confidential transitions', () => {
  const plan = {
    planId: 'private-plan-id',
    phase: 'processing',
    operation: 'swap',
    source: { chainId: 'eip155:1' },
    requiresDeposit: false
  }
  const ready = { ...plan, phase: 'ready' }
  const result = projectConfidentialPlanResult(plan, ready)
  assert.equal(result?.name, ANALYTICS_EVENTS.SHIELD_OPERATION_RESULT)
  assert.deepEqual(result?.options.extra, { operation: 'swap', status: 'success' })
  assert.equal(result?.options.hasTransaction, 1)
  assert.equal(result?.options.chain, 'evm')
  assert.equal(
    projectConfidentialPlanResult(plan, {
      ...ready,
      source: { chainId: ZCASH_CHAIN_IDS.mainnet }
    })?.options.chain,
    'zcash'
  )
  assert.equal(projectConfidentialPlanResult(ready, ready), null)
  assert.equal(projectConfidentialPlanResult(plan, { ...plan, phase: 'partial' }), null)
  for (const phase of ['refunded', 'failed', 'expired', 'cancelled']) {
    const terminal = projectConfidentialPlanResult(plan, { ...plan, phase })
    assert.deepEqual(terminal?.options.extra, { operation: 'swap', status: phase })
    assert.equal(terminal?.options.hasTransaction, phase === 'refunded' ? 1 : 0)
  }
  assert.equal(
    projectConfidentialPlanResult(plan, {
      ...plan,
      phase: 'failed',
      errorStatus: 'LOCAL_PROCESSING_FAILED',
      requiresDeposit: true,
      preparedDeposit: { transactionHash: 'private-hash' }
    }),
    null
  )
  assert.deepEqual(
    projectConfidentialPlanResult(
      { ...plan, operation: undefined },
      { ...ready, operation: undefined }
    )?.options.extra,
    { operation: 'cluster', status: 'success' }
  )

  const deposit = {
    depositId: 'private-deposit-id',
    phase: 'awaiting-payment',
    source: { chainId: 'eip155:1' }
  }
  assert.equal(projectExternalDepositResult(deposit, { ...deposit, phase: 'failed' }), null)
  assert.equal(projectExternalDepositResult(deposit, { ...deposit, phase: 'ready' }), null)
  assert.equal(
    projectExternalDepositResult(deposit, { ...deposit, phase: 'ready', settledOutputRaw: '0' }),
    null
  )
  const settled = { ...deposit, phase: 'ready', settledOutputRaw: '1200' }
  assert.deepEqual(projectExternalDepositResult(deposit, settled)?.options.extra, {
    operation: 'deposit',
    status: 'success'
  })
  assert.equal(projectExternalDepositResult(deposit, settled)?.options.hasTransaction, 1)
  assert.equal(projectExternalDepositResult(settled, settled), null)
  assert.deepEqual(
    projectExternalDepositResult({ ...deposit, phase: 'failed' }, { ...deposit, phase: 'refunded' })
      ?.options.extra,
    { operation: 'deposit', status: 'refunded' }
  )
})

test('a persisted transfer binding classifies a Zcash quote as Send', () => {
  const operation = resolveZcashAnalyticsOperation('swap', 'transfer')
  const broadcast = projectZcashOperationEvent(operation, 'broadcast')
  const failed = projectZcashOperationEvent(operation, 'failed')
  assert.equal(broadcast.name, ANALYTICS_EVENTS.SEND_SUCCEEDED)
  assert.deepEqual(broadcast.options.extra, { funding_source: undefined, kind: 'transfer' })
  assert.equal(failed.name, ANALYTICS_EVENTS.SEND_FAILED)
  assert.equal(resolveZcashAnalyticsOperation('swap'), 'swap')
  assert.equal(resolveZcashAnalyticsOperation('unshield'), 'unshield')
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

test('settled Shield and Cluster events use observed output instead of quoted output', () => {
  const assets = {
    get(assetId) {
      return {
        metadata:
          assetId === 'source' ? { symbol: 'USDC', decimals: 6 } : { symbol: 'ETH', decimals: 18 }
      }
    }
  }
  const base = {
    planId: 'private-plan-id',
    phase: 'processing',
    operation: 'deposit',
    sourceDomain: 'private',
    destinationDomain: 'shield',
    source: { chainId: 'eip155:1', assetId: 'source', amountRaw: '2500000' },
    destination: { assetId: 'destination' },
    expectedOutputRaw: '999000000000000000',
    withdraws: [],
    requiresDeposit: true
  }
  const deposit = projectConfidentialPlanResult(
    base,
    { ...base, phase: 'ready', settledOutputRaw: '800000000000000000' },
    assets,
    25
  )
  assert.equal(deposit.options.collector.inputAmount, '2.5')
  assert.equal(deposit.options.collector.outputAmount, '0.8')
  assert.equal(deposit.options.collector.quotedPrivacyFeeBps, 25)
  assert.equal(deposit.options.collector.sourceDomain, 'private')
  assert.equal(deposit.options.collector.destinationDomain, 'shield')
  assert.equal(deposit.options.collector.privacyFeeAmount, undefined)

  const cluster = {
    ...base,
    operation: 'cluster',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    requiresDeposit: false,
    withdraws: [
      { status: 'SUCCESS', settledOutputRaw: '200000000000000000' },
      { status: 'COMPLETED', settledOutputRaw: '300000000000000000' }
    ]
  }
  const result = projectConfidentialPlanResult(cluster, { ...cluster, phase: 'ready' }, assets)
  assert.equal(result.options.collector.inputAmount, '2.5')
  assert.equal(result.options.collector.outputAmount, '0.5')
  assert.equal(result.options.idempotencyKey, 'shield-plan:private-plan-id')
  assert.equal(result.options.collector.sourceDomain, 'shield')
  assert.equal(result.options.collector.destinationDomain, 'public')
  assert.equal(
    projectConfidentialPlanResult(
      cluster,
      { ...cluster, phase: 'ready', withdraws: [cluster.withdraws[0], { status: 'SUCCESS' }] },
      assets
    ).options.collector.outputAmount,
    undefined
  )
  assert.equal(
    projectConfidentialPlanResult(cluster, { ...cluster, phase: 'partial' }, assets),
    null
  )

  const external = {
    depositId: 'private-external-id',
    phase: 'processing',
    source: { chainId: 'eip155:1' },
    sourceSymbol: 'USDC',
    sourceDecimals: 6,
    destinationAssetId: 'destination',
    depositedAmountRaw: '1750000',
    expectedOutputRaw: '999000000000000000'
  }
  const settled = projectExternalDepositResult(
    external,
    { ...external, phase: 'ready', settledOutputRaw: '700000000000000000' },
    assets
  )
  assert.equal(settled.options.collector.inputAmount, '1.75')
  assert.equal(settled.options.collector.outputAmount, '0.7')
  assert.equal(settled.options.collector.activityType, 'receive')
})

test('Zcash collector context follows the on-chain funding and recipient domains', () => {
  const transparent = `t1${'A'.repeat(33)}`
  const shielded = `zs${'A'.repeat(76)}`
  assert.deepEqual(zcashOperationCollector('shield', undefined, '1.25'), {
    inputAmount: '1.25',
    sourceDomain: 'public',
    destinationDomain: 'shield',
    privacyRoute: 'zcash_shielded',
    transferType: 'self',
    activityType: 'transfer',
    provider: 'zcash',
    settlement: 'broadcast'
  })
  assert.equal(
    zcashOperationCollector('send', 'transparent', '2', transparent).privacyRoute,
    'direct'
  )
  assert.equal(
    zcashOperationCollector('send', 'shielded', '2', shielded).destinationDomain,
    'shield'
  )
  assert.equal(
    zcashOperationCollector('swap', 'shielded', '2', transparent).destinationDomain,
    undefined
  )
})
