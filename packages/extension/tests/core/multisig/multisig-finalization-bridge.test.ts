import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  handleMultisigFinalizationBridge,
  MULTISIG_FINALIZATION_BRIDGE_TYPE
} from '../../../src/background/multisig-finalization-bridge'

const ref = {
  network: 'testnet' as const,
  walletId: 'wallet',
  accountId: 'account',
  reviewId: 'review',
  sessionId: 'AAAAAAAAAAAAAAAAAAAAAA=='
}
const txId = '12'.repeat(32)
const hash = '34'.repeat(32)
const request = (operation: string, payload: object) => ({
  type: MULTISIG_FINALIZATION_BRIDGE_TYPE,
  operation,
  payload
})

function ports() {
  const calls: string[] = []
  let phase = 'prepared'
  let marker: {
    version: 1
    network: 'testnet'
    walletId: string
    accountId: string
    reviewId: string
    sessionId: string
    token: string
  } | null = null
  const dependencies = {
    async listRecovery() {
      return [{ binding: ref, phase }]
    },
    async hasBarrier() {
      return marker !== null
    },
    async beginBarrier(scope: typeof ref, nextToken: string) {
      calls.push('begin')
      marker = { version: 1 as const, ...scope, token: nextToken }
      return marker
    },
    async assertBarrierOwned(candidate: { token: string; reviewId: string; sessionId: string }) {
      if (
        !marker ||
        candidate.token !== marker.token ||
        candidate.reviewId !== marker.reviewId ||
        candidate.sessionId !== marker.sessionId
      )
        throw new Error('Barrier owner mismatch')
    },
    async clearBarrier(candidate: { token: string }) {
      calls.push('clear')
      if (candidate.token !== marker?.token) throw new Error('Barrier owner mismatch')
      marker = null
    },
    async recordReceipt() {
      calls.push('receipt')
      phase = 'receipt'
    },
    async recordProtected() {
      calls.push('protected')
      phase = 'protected_snapshot_verified'
    },
    async recordDurable() {
      calls.push('durable')
      phase = 'durable_finalization'
    },
    randomToken: () => 'token-1',
    now: () => 1
  }
  return { dependencies, calls }
}

test('only the exact own Offscreen document can read or mutate finalization state', async () => {
  const { dependencies, calls } = ports()
  const message = request('barrier.begin', ref)
  for (const context of ['extension-page', 'service-worker', null]) {
    await assert.rejects(
      handleMultisigFinalizationBridge(message, context, dependencies),
      /Unauthorized/
    )
  }
  assert.deepEqual(calls, [])
  await assert.rejects(
    handleMultisigFinalizationBridge(
      { ...message, extra: true },
      'offscreen-document',
      dependencies
    ),
    /Invalid/
  )
  assert.deepEqual(calls, [])
})

test('bridge rejects malformed scopes, hashes and lengths before storage calls', async () => {
  const { dependencies, calls } = ports()
  for (const message of [
    request('barrier.has', { network: 'regtest', walletId: 'wallet' }),
    request('barrier.begin', { ...ref, accountId: '' }),
    request('receipt', { ...ref, token: 'token-1', txId, rawTxSha256: hash, rawTxLen: 0 }),
    request('protected', { ...ref, token: 'token-1', txId, snapshotSha256: 'X'.repeat(64) })
  ]) {
    await assert.rejects(
      handleMultisigFinalizationBridge(message, 'offscreen-document', dependencies),
      /Invalid/
    )
  }
  assert.deepEqual(calls, [])
})

test('begin requires prepared binding and each stage requires marker owner and prior phase', async () => {
  const { dependencies, calls } = ports()
  const marker = await handleMultisigFinalizationBridge(
    request('barrier.begin', ref),
    'offscreen-document',
    dependencies
  )
  assert.equal((marker as { token: string }).token, 'token-1')
  await assert.rejects(
    handleMultisigFinalizationBridge(
      request('receipt', { ...ref, token: 'wrong', txId, rawTxSha256: hash, rawTxLen: 123 }),
      'offscreen-document',
      dependencies
    ),
    /mismatch/
  )
  await assert.rejects(
    handleMultisigFinalizationBridge(
      request('barrier.clear', { ...ref, token: 'token-1' }),
      'offscreen-document',
      dependencies
    ),
    /phase/
  )
  await handleMultisigFinalizationBridge(
    request('receipt', { ...ref, token: 'token-1', txId, rawTxSha256: hash, rawTxLen: 123 }),
    'offscreen-document',
    dependencies
  )
  await handleMultisigFinalizationBridge(
    request('protected', { ...ref, token: 'token-1', txId, snapshotSha256: hash }),
    'offscreen-document',
    dependencies
  )
  await handleMultisigFinalizationBridge(
    request('durable', { ...ref, token: 'token-1', txId, snapshotSha256: hash }),
    'offscreen-document',
    dependencies
  )
  await handleMultisigFinalizationBridge(
    request('barrier.clear', { ...ref, token: 'token-1' }),
    'offscreen-document',
    dependencies
  )
  assert.deepEqual(calls, ['begin', 'receipt', 'protected', 'durable', 'clear'])
})

test('an old durable review cannot clear a newer barrier using its token', async () => {
  const { dependencies, calls } = ports()
  const current = await handleMultisigFinalizationBridge(
    request('barrier.begin', ref),
    'offscreen-document',
    dependencies
  )
  const old = { ...ref, reviewId: 'old-review', sessionId: 'AQAAAAAAAAAAAAAAAAAAAA==' }
  dependencies.listRecovery = async () => [{ binding: old, phase: 'durable_finalization' }]
  await assert.rejects(
    handleMultisigFinalizationBridge(
      request('barrier.clear', { ...old, token: (current as { token: string }).token }),
      'offscreen-document',
      dependencies
    ),
    /owner mismatch/
  )
  assert.deepEqual(calls, ['begin'])
})
