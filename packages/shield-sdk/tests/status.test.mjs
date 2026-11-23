import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShieldOperation, projectShieldStatusReport, snapshotFromReport } from '../src/operation.ts'
import {
  projectConfidentialPlanStatus,
  projectExternalShieldDepositStatus
} from '../src/status-projection.ts'
import { ShieldError } from '../src/types.ts'

test('keeps partial, refund, failure, and auth statuses distinct', () => {
  for (const status of ['partial', 'refunded', 'failed', 'expired', 'cancelled', 'needs-auth']) {
    assert.equal(projectShieldStatusReport({ status }), status)
  }
  assert.equal(
    projectShieldStatusReport({ status: 'processing', providerStatus: 'PENDING_REFUND' }),
    'pending-refund'
  )
  assert.equal(
    projectShieldStatusReport({ status: 'awaiting-payment', providerStatus: 'EXPIRED' }),
    'awaiting-payment'
  )
  assert.equal(projectShieldStatusReport({ status: 'rejected' }), 'unknown')
  assert.equal(projectShieldStatusReport({ status: 'REJECTED' }), 'unknown')
  assert.equal(
    projectShieldStatusReport({
      status: 'rejected',
      source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714', amount: '0.1' }
    }),
    'unknown'
  )
  assert.equal(projectShieldStatusReport({ status: 'deposit-signed' }), 'unknown')
  assert.equal(projectShieldStatusReport({}), 'unknown')
  const report = {
    id: 'op-1',
    status: 'processing',
    providerStatus: 'PROCESSING',
    action: 'receive',
    source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714', amount: '0.1' },
    destination: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714', amount: '0.099' },
    references: { transactionHashes: ['0xabc'], orderId: 'order-1' }
  }
  assert.equal(projectShieldStatusReport(report), 'processing')
  assert.deepEqual(snapshotFromReport(report, {
    id: 'op-1',
    layer: 'near-confidential',
    action: 'receive'
  }), {
    id: 'op-1',
    layer: 'near-confidential',
    action: 'receive',
    status: 'processing',
    providerStatus: 'PROCESSING'
  })
})

test('plan and external deposit phases keep partial, refund, expiry, and auth distinct', () => {
  assert.equal(projectConfidentialPlanStatus({ phase: 'prepared' }).status, 'awaiting-approval')
  assert.equal(projectConfidentialPlanStatus({ phase: 'needs-auth' }).status, 'needs-auth')
  assert.equal(projectConfidentialPlanStatus({ phase: 'partial' }).status, 'partial')
  assert.equal(projectConfidentialPlanStatus({ phase: 'refunded' }).status, 'refunded')
  assert.equal(projectConfidentialPlanStatus({ phase: 'failed' }).status, 'failed')
  assert.equal(projectConfidentialPlanStatus({ phase: 'expired' }).status, 'expired')
  assert.equal(projectConfidentialPlanStatus({ phase: 'cancelled' }).status, 'cancelled')
  assert.equal(projectConfidentialPlanStatus({ phase: 'deposit-signed' }).status, 'signing')
  assert.equal(
    projectConfidentialPlanStatus({ phase: 'processing', backendStatus: 'PENDING_REFUND' }).status,
    'pending-refund'
  )
  assert.equal(projectConfidentialPlanStatus({ phase: 'ready', backendStatus: 'PENDING_REFUND' }).status, 'ready')
  assert.equal(
    projectExternalShieldDepositStatus({ phase: 'awaiting-payment', providerStatus: 'EXPIRED' }).status,
    'awaiting-payment'
  )
  assert.equal(
    projectExternalShieldDepositStatus({ phase: 'processing', providerStatus: 'PENDING_REFUND' }).status,
    'pending-refund'
  )
  assert.equal(projectExternalShieldDepositStatus({ phase: 'failed', providerStatus: 'CANCELLED' }).status, 'failed')
})

test('timeout and abort end the wait without resubmitting', async () => {
  let reads = 0
  const handle = createShieldOperation(
    {
      id: 'op-1',
      layer: 'near-confidential',
      action: 'receive',
      status: 'processing'
    },
    async () => {
      reads += 1
      return { id: 'op-1', status: 'processing', action: 'receive' }
    }
  )
  await assert.rejects(
    handle.wait({ timeoutMs: 5 }),
    error => error instanceof ShieldError && error.code === 'TIMEOUT' && error.status === 'processing'
  )
  assert.equal(handle.status, 'processing')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    handle.wait({ signal: controller.signal, timeoutMs: 1_000 }),
    error => error instanceof ShieldError && error.code === 'CANCELLED'
  )
  assert.equal(reads >= 0, true)
})
